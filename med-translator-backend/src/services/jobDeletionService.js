import Job from '../models/jobModel.js';
import TranslationChunk from '../models/translationChunkModel.js';
import UploadBatch from '../models/uploadBatchModel.js';
import { appEvents } from './appEvents.js';

const DEFAULT_PURGE_LIMIT = 500;

function sourceSizeFor(job, manifestSizes) {
    if (Number.isSafeInteger(job.sourceSize) && job.sourceSize >= 0) return job.sourceSize;
    return manifestSizes.get(job.jobId) || 0;
}

export class JobDeletionService {
    constructor({
        JobModel = Job,
        TranslationChunkModel = TranslationChunk,
        UploadBatchModel = UploadBatch,
    } = {}) {
        this.Job = JobModel;
        this.TranslationChunk = TranslationChunkModel;
        this.UploadBatch = UploadBatchModel;
    }

    async reconcileUploadBatch(uploadBatchId) {
        if (!uploadBatchId) return { found: false, deleted: false };

        const batch = await this.UploadBatch.findOne({ batchId: uploadBatchId }).lean();
        if (!batch) return { found: false, deleted: false };

        const jobs = await this.Job.find(
            { uploadBatchId, status: { $ne: 'deleted' } },
            'jobId clientUploadId originalName sourceSize uploadConfirmedAt status'
        ).lean();

        if (jobs.length === 0) {
            await this.UploadBatch.deleteOne({ batchId: uploadBatchId });
            appEvents.emit('batchUpdated', {
                batchId: uploadBatchId,
                status: 'deleted',
                deleted: true,
            });
            return { found: true, deleted: true };
        }

        const items = Array.isArray(batch.items) ? batch.items : [];
        const itemByJobId = new Map(items.map(item => [item.jobId, item]));
        const liveItems = jobs.map(job => itemByJobId.get(job.jobId) || ({
            jobId: job.jobId,
            clientUploadId: job.clientUploadId || job.jobId,
            originalName: job.originalName || job.jobId,
            sourceSize: job.sourceSize || 0,
        }));
        const manifestSizes = new Map(items.map(item => [item.jobId, item.sourceSize || 0]));
        const confirmedJobs = jobs.filter(job => job.uploadConfirmedAt);
        const failedFiles = jobs.filter(job => job.status === 'failed' && !job.uploadConfirmedAt).length;
        const skippedFiles = jobs.filter(job => job.status === 'cancelled').length;
        const totalBytes = jobs.reduce(
            (total, job) => total + sourceSizeFor(job, manifestSizes),
            0
        );
        const confirmedBytes = confirmedJobs.reduce(
            (total, job) => total + sourceSizeFor(job, manifestSizes),
            0
        );
        const ready = confirmedJobs.length + skippedFiles === jobs.length && failedFiles === 0;
        const status = ready ? 'ready' : failedFiles > 0 ? 'partial' : 'uploading';
        const update = {
            totalFiles: jobs.length,
            totalBytes,
            confirmedFiles: confirmedJobs.length,
            confirmedBytes,
            failedFiles,
            skippedFiles,
            status,
            readyAt: ready ? (batch.readyAt || new Date()) : null,
            ...(items.length > 0 ? { items: liveItems } : {}),
        };

        await this.UploadBatch.updateOne({ batchId: uploadBatchId }, { $set: update });
        appEvents.emit('batchUpdated', {
            batchId: uploadBatchId,
            ...update,
            canCloseClient: ready,
        });
        return { found: true, deleted: false, ...update };
    }

    async purgeTombstone(job) {
        if (!job?.jobId) return { purged: false };

        await this.TranslationChunk.deleteMany({ jobId: job.jobId });
        await this.reconcileUploadBatch(job.uploadBatchId);
        const result = await this.Job.deleteOne({ jobId: job.jobId, status: 'deleted' });
        return { purged: result.deletedCount > 0 };
    }

    async finalizeDeletion(job, {
        deletionRequestedAt = job?.deletionRequestedAt || new Date(),
        sourceDeletedAt = job?.sourceDeletedAt || new Date(),
    } = {}) {
        if (!job?.jobId) return { purged: false };
        if (job.status === 'deleted') return this.purgeTombstone(job);

        const deletedAt = new Date();
        const statusBeforeDeletion = job.statusBeforeDeletion
            || (job.status === 'cancelled' ? 'cancelled' : job.status);
        const translatedBeforeDeletion = statusBeforeDeletion === 'completed'
            || Boolean(job.completedAt);

        await this.Job.updateOne(
            { jobId: job.jobId, status: { $ne: 'deleted' } },
            {
                $set: {
                    status: 'deleted',
                    cancelRequested: true,
                    deletionRequestedAt,
                    deletedAt,
                    statusBeforeDeletion,
                    translatedBeforeDeletion,
                    filePath: null,
                    sourceState: 'deleted',
                    sourceDeletedAt,
                    processingToken: null,
                    leaseExpiresAt: null,
                    nextRetryAt: null,
                },
            }
        );

        return this.purgeTombstone({ ...job, status: 'deleted' });
    }

    async purgeDeletedHistory({ limit = DEFAULT_PURGE_LIMIT } = {}) {
        const safeLimit = Math.min(DEFAULT_PURGE_LIMIT, Math.max(1, limit));
        let purged = 0;

        while (true) {
            const rows = await this.Job.find(
                { status: 'deleted' },
                'jobId uploadBatchId'
            ).limit(safeLimit).lean();
            if (rows.length === 0) break;

            const jobIds = rows.map(job => job.jobId);
            const batchIds = [...new Set(rows.map(job => job.uploadBatchId).filter(Boolean))];
            await this.TranslationChunk.deleteMany({ jobId: { $in: jobIds } });
            for (const batchId of batchIds) {
                await this.reconcileUploadBatch(batchId);
            }
            const result = await this.Job.deleteMany({
                jobId: { $in: jobIds },
                status: 'deleted',
            });
            purged += result.deletedCount || 0;

            if (rows.length < safeLimit || !result.deletedCount) break;
        }

        return purged;
    }
}

export const jobDeletionService = new JobDeletionService();
