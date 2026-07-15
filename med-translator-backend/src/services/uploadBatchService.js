import { randomUUID } from 'crypto';
import { createIncomingStorageKey } from './sourceKeyService.js';
import { runBoundedTasks } from '../utils/runBoundedTasks.js';
import { redactError } from '../utils/redactSecrets.js';
import { appEvents } from './appEvents.js';
import { operationalMetrics } from './operationalMetrics.js';

export class UploadBatchError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = 'UploadBatchError';
        this.code = code;
        this.status = status;
    }
}

function normalizeFolderName(value) {
    return (typeof value === 'string' ? value : 'Mặc định').trim().slice(0, 120) || 'Mặc định';
}

export function validateUploadManifest(payload, { maxFiles, maxFileSizeBytes, maxBatchBytes }) {
    if (!payload || typeof payload !== 'object') {
        throw new UploadBatchError('INVALID_MANIFEST', 'Manifest upload không hợp lệ.');
    }
    const clientBatchId = typeof payload.clientBatchId === 'string' ? payload.clientBatchId.trim() : '';
    if (!clientBatchId || clientBatchId.length > 128) {
        throw new UploadBatchError('INVALID_CLIENT_BATCH_ID', 'clientBatchId không hợp lệ.');
    }
    if (!Array.isArray(payload.files) || payload.files.length === 0 || payload.files.length > maxFiles) {
        throw new UploadBatchError('INVALID_FILE_COUNT', `Batch phải có từ 1 đến ${maxFiles} file.`);
    }

    const seenIds = new Set();
    let totalBytes = 0;
    const files = payload.files.map((file, index) => {
        const clientUploadId = typeof file?.clientUploadId === 'string' ? file.clientUploadId.trim() : '';
        const name = typeof file?.name === 'string' ? file.name.trim() : '';
        const size = file?.size;
        if (!clientUploadId || clientUploadId.length > 128 || seenIds.has(clientUploadId)) {
            throw new UploadBatchError('INVALID_CLIENT_UPLOAD_ID', `clientUploadId không hợp lệ hoặc bị trùng tại file ${index + 1}.`);
        }
        if (!name || name.length > 255 || !name.toLowerCase().endsWith('.pdf')) {
            throw new UploadBatchError('INVALID_FILE_NAME', `Tên file ${index + 1} phải có đuôi .pdf.`);
        }
        if (file.type !== 'application/pdf') {
            throw new UploadBatchError('INVALID_FILE_TYPE', `${name} phải có MIME application/pdf.`);
        }
        if (!Number.isSafeInteger(size) || size <= 0 || size > maxFileSizeBytes) {
            throw new UploadBatchError('INVALID_FILE_SIZE', `Dung lượng ${name} không hợp lệ hoặc vượt giới hạn.`);
        }
        seenIds.add(clientUploadId);
        totalBytes += size;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBatchBytes) {
            throw new UploadBatchError('BATCH_TOO_LARGE', 'Tổng dung lượng batch vượt giới hạn cho phép.', 413);
        }
        return { clientUploadId, name, size, type: 'application/pdf' };
    });

    return {
        clientBatchId,
        folderName: normalizeFolderName(payload.folderName),
        files,
        totalBytes,
    };
}

export class UploadBatchService {
    constructor({ Job, UploadBatch, r2, config }) {
        this.Job = Job;
        this.UploadBatch = UploadBatch;
        this.r2 = r2;
        this.config = config;
        this.reconcilerTimer = null;
        this.reconcilerRunning = false;
    }

    async getPreparedResponse(batch) {
        const jobs = await this.Job.find(
            { uploadBatchId: batch.batchId },
            'jobId clientUploadId originalName sourceSize storageKey status'
        ).sort({ createdAt: 1 }).lean();
        if (jobs.length !== batch.totalFiles) {
            throw new UploadBatchError('INCOMPLETE_PREPARE', 'Batch đang ở trạng thái chuẩn bị chưa hoàn chỉnh.', 409);
        }
        const items = await Promise.all(jobs.map(async job => ({
            jobId: job.jobId,
            clientUploadId: job.clientUploadId,
            name: job.originalName,
            size: job.sourceSize,
            status: job.status,
            ...(job.status === 'uploading' ? {
                uploadUrl: await this.r2.createPresignedPut({
                    key: job.storageKey,
                    contentType: 'application/pdf',
                }),
                requiredHeaders: { 'Content-Type': 'application/pdf' },
            } : {}),
        })));
        return { batchId: batch.batchId, status: batch.status, items };
    }

    async prepareBatch(payload) {
        operationalMetrics.increment('upload.prepare.requests');
        const manifest = validateUploadManifest(payload, this.config);
        const existing = await this.UploadBatch.findOne({ clientBatchId: manifest.clientBatchId }).lean();
        if (existing) return this.getPreparedResponse(existing);

        const batchId = randomUUID();
        const rows = manifest.files.map(file => {
            const jobId = randomUUID();
            return {
                jobId,
                clientUploadId: file.clientUploadId,
                originalName: file.name,
                folderName: manifest.folderName,
                filePath: null,
                status: 'uploading',
                storageProvider: 'r2',
                storageKey: createIncomingStorageKey(batchId, jobId),
                sourceSize: file.size,
                sourceState: 'prepared',
                uploadBatchId: batchId,
                maxAttempts: this.config.maxJobAttempts,
            };
        });

        let batch;
        try {
            batch = await this.UploadBatch.create({
                batchId,
                clientBatchId: manifest.clientBatchId,
                folderName: manifest.folderName,
                totalFiles: rows.length,
                totalBytes: manifest.totalBytes,
            });
            await this.Job.insertMany(rows, { ordered: true });
        } catch (error) {
            await Promise.allSettled([
                this.Job.deleteMany({ uploadBatchId: batchId }),
                this.UploadBatch.deleteOne({ batchId }),
            ]);
            if (error?.code === 11000) {
                const raced = await this.UploadBatch.findOne({ clientBatchId: manifest.clientBatchId }).lean();
                if (raced) return this.getPreparedResponse(raced);
                throw new UploadBatchError('DUPLICATE_UPLOAD_ID', 'clientUploadId đã được sử dụng.', 409);
            }
            throw error;
        }

        const response = await this.getPreparedResponse(batch.toObject ? batch.toObject() : batch);
        appEvents.emit('batchUpdated', { batchId, status: 'uploading', totalFiles: rows.length, confirmedFiles: 0, canCloseClient: false });
        return response;
    }

    async confirmOne(job) {
        if (job.status !== 'uploading') return { jobId: job.jobId, status: job.status, alreadyConfirmed: true };
        const startedAt = Date.now();
        let metadata;
        try {
            metadata = await this.r2.headObject(job.storageKey);
            operationalMetrics.observe('r2.head.latency', Date.now() - startedAt);
        } catch (error) {
            operationalMetrics.increment('r2.head.errors');
            throw error;
        }
        if (metadata.contentLength !== job.sourceSize) {
            throw new UploadBatchError('SOURCE_SIZE_MISMATCH', `Dung lượng object không khớp cho job ${job.jobId}.`, 409);
        }
        if (!metadata.etag) {
            throw new UploadBatchError('SOURCE_ETAG_MISSING', `R2 không trả ETag cho job ${job.jobId}.`, 409);
        }
        const confirmedAt = new Date();
        const updated = await this.Job.findOneAndUpdate(
            { jobId: job.jobId, status: 'uploading', sourceState: 'prepared' },
            {
                $set: {
                    status: 'pending',
                    sourceState: 'ready',
                    sourceEtag: metadata.etag,
                    uploadConfirmedAt: confirmedAt,
                    nextRetryAt: confirmedAt,
                },
            },
            { returnDocument: 'after' }
        ).lean();
        return { jobId: job.jobId, status: updated?.status || 'pending', alreadyConfirmed: !updated };
    }

    async refreshBatch(batch) {
        const [confirmedFiles, failedFiles, skippedFiles, bytes] = await Promise.all([
            this.Job.countDocuments({ uploadBatchId: batch.batchId, uploadConfirmedAt: { $ne: null } }),
            this.Job.countDocuments({ uploadBatchId: batch.batchId, status: 'failed' }),
            this.Job.countDocuments({ uploadBatchId: batch.batchId, status: 'cancelled' }),
            this.Job.aggregate([
                { $match: { uploadBatchId: batch.batchId, uploadConfirmedAt: { $ne: null } } },
                { $group: { _id: null, total: { $sum: '$sourceSize' } } },
            ]),
        ]);
        const ready = confirmedFiles + skippedFiles === batch.totalFiles && failedFiles === 0;
        const status = ready ? 'ready' : failedFiles > 0 ? 'partial' : 'uploading';
        const confirmedBytes = bytes[0]?.total || 0;
        await this.UploadBatch.updateOne(
            { batchId: batch.batchId },
            {
                $set: {
                    confirmedFiles,
                    confirmedBytes,
                    failedFiles,
                    skippedFiles,
                    status,
                    readyAt: ready ? (batch.readyAt || new Date()) : null,
                },
            }
        );
        const progress = { confirmedFiles, confirmedBytes, failedFiles, skippedFiles, status, canCloseClient: ready };
        appEvents.emit('batchUpdated', { batchId: batch.batchId, totalFiles: batch.totalFiles, ...progress });
        return progress;
    }

    async confirmBatch(batchId, requestedJobIds) {
        operationalMetrics.increment('upload.confirm.requests');
        if (!Array.isArray(requestedJobIds) || requestedJobIds.length === 0 || requestedJobIds.length > this.config.maxFiles) {
            throw new UploadBatchError('INVALID_CONFIRM_LIST', 'Danh sách confirm không hợp lệ.');
        }
        const jobIds = [...new Set(requestedJobIds)];
        if (jobIds.length !== requestedJobIds.length || jobIds.some(id => typeof id !== 'string')) {
            throw new UploadBatchError('INVALID_CONFIRM_LIST', 'Danh sách confirm chứa ID trùng hoặc không hợp lệ.');
        }
        const batch = await this.UploadBatch.findOne({ batchId }).lean();
        if (!batch) throw new UploadBatchError('BATCH_NOT_FOUND', 'Không tìm thấy upload batch.', 404);
        const jobs = await this.Job.find({ uploadBatchId: batchId, jobId: { $in: jobIds } }).lean();
        if (jobs.length !== jobIds.length) {
            throw new UploadBatchError('JOB_NOT_IN_BATCH', 'Có job không thuộc upload batch.', 400);
        }
        const byId = new Map(jobs.map(job => [job.jobId, job]));
        const results = await runBoundedTasks(
            jobIds,
            this.config.confirmConcurrency,
            jobId => this.confirmOne(byId.get(jobId))
        );
        const progress = await this.refreshBatch(batch);
        return { batchId, items: jobIds.map(jobId => results.get(jobId)), ...progress };
    }

    async getBatchStatus(batchId) {
        const batch = await this.UploadBatch.findOne({ batchId }).lean();
        if (!batch) throw new UploadBatchError('BATCH_NOT_FOUND', 'Không tìm thấy upload batch.', 404);
        const statuses = await this.Job.aggregate([
            { $match: { uploadBatchId: batchId } },
            { $group: { _id: '$status', count: { $sum: 1 } } },
        ]);
        return {
            batchId,
            folderName: batch.folderName,
            status: batch.status,
            totalFiles: batch.totalFiles,
            totalBytes: batch.totalBytes,
            uploadedFiles: batch.confirmedFiles,
            confirmedFiles: batch.confirmedFiles,
            confirmedBytes: batch.confirmedBytes,
            failedFiles: batch.failedFiles,
            skippedFiles: batch.skippedFiles || 0,
            canCloseClient: batch.status === 'ready'
                && batch.confirmedFiles + (batch.skippedFiles || 0) === batch.totalFiles,
            jobsByStatus: Object.fromEntries(statuses.map(row => [row._id, row.count])),
        };
    }

    async listRecentBatches(limit = 20) {
        const batches = await this.UploadBatch.find({}, 'batchId clientBatchId folderName status totalFiles totalBytes confirmedFiles confirmedBytes failedFiles skippedFiles readyAt createdAt')
            .sort({ createdAt: -1 })
            .limit(Math.min(100, Math.max(1, limit)))
            .lean();
        return batches.map(batch => ({
            ...batch,
            canCloseClient: batch.status === 'ready'
                && batch.confirmedFiles + (batch.skippedFiles || 0) === batch.totalFiles,
        }));
    }

    async abandonItems(batchId, requestedJobIds) {
        if (!Array.isArray(requestedJobIds) || requestedJobIds.length === 0) {
            throw new UploadBatchError('INVALID_ABANDON_LIST', 'Danh sách file cần bỏ không hợp lệ.');
        }
        const jobIds = [...new Set(requestedJobIds)];
        const batch = await this.UploadBatch.findOne({ batchId }).lean();
        if (!batch) throw new UploadBatchError('BATCH_NOT_FOUND', 'Không tìm thấy upload batch.', 404);
        const jobs = await this.Job.find({
            uploadBatchId: batchId,
            jobId: { $in: jobIds },
            status: 'uploading',
        }).lean();
        if (jobs.length !== jobIds.length) {
            throw new UploadBatchError('JOB_NOT_ABANDONABLE', 'Có file đã xác nhận hoặc không thuộc batch.', 409);
        }

        await runBoundedTasks(jobs, this.config.confirmConcurrency, async job => {
            await this.r2.deleteObject(job.storageKey);
            await this.Job.updateOne(
                { jobId: job.jobId, status: 'uploading' },
                {
                    $set: {
                        status: 'cancelled',
                        cancelRequested: true,
                        sourceState: 'deleted',
                        sourceDeletedAt: new Date(),
                    },
                }
            );
        });
        return { batchId, ...(await this.refreshBatch(batch)) };
    }

    async reconcileUploadingJobs(limit = 50) {
        const jobs = await this.Job.find({ status: 'uploading', sourceState: 'prepared' })
            .sort({ createdAt: 1 }).limit(limit).lean();
        const affectedBatches = new Set();
        let confirmed = 0;
        for (const job of jobs) {
            try {
                await this.confirmOne(job);
                affectedBatches.add(job.uploadBatchId);
                confirmed += 1;
            } catch (error) {
                if (![404, 'NotFound', 'NoSuchKey'].includes(error?.$metadata?.httpStatusCode)
                    && !['NotFound', 'NoSuchKey'].includes(error?.name)) {
                    console.error(`[R2 RECONCILE] Job ${job.jobId} chưa thể xác nhận:`, redactError(error));
                }
            }
        }
        for (const batchId of affectedBatches) {
            const batch = await this.UploadBatch.findOne({ batchId }).lean();
            if (batch) await this.refreshBatch(batch);
        }
        const expired = await this.expireStaleUploads(limit);
        operationalMetrics.increment('upload.reconcile.scanned', jobs.length);
        operationalMetrics.increment('upload.reconcile.confirmed', confirmed);
        return { scanned: jobs.length, confirmed, expired };
    }

    async expireStaleUploads(limit = 50, maxAgeMs = 60 * 60 * 1000) {
        const staleJobs = await this.Job.find({
            status: 'uploading',
            sourceState: 'prepared',
            createdAt: { $lte: new Date(Date.now() - maxAgeMs) },
        }).sort({ createdAt: 1 }).limit(limit).lean();
        const byBatch = new Map();
        for (const job of staleJobs) {
            if (!byBatch.has(job.uploadBatchId)) byBatch.set(job.uploadBatchId, []);
            byBatch.get(job.uploadBatchId).push(job.jobId);
        }
        let expired = 0;
        for (const [batchId, jobIds] of byBatch) {
            try {
                await this.abandonItems(batchId, jobIds);
                expired += jobIds.length;
            } catch (error) {
                console.error(`[UPLOAD EXPIRE] Batch ${batchId} chưa dọn được:`, redactError(error));
            }
        }
        return expired;
    }

    startReconciler(intervalMs = 60_000) {
        if (this.reconcilerTimer) return;
        this.reconcilerTimer = setInterval(async () => {
            if (this.reconcilerRunning) return;
            this.reconcilerRunning = true;
            try { await this.reconcileUploadingJobs(); }
            finally { this.reconcilerRunning = false; }
        }, intervalMs);
        this.reconcilerTimer.unref?.();
    }
}
