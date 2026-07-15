import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import { processPdf } from './pdfService.js';
import { processTranslation } from './geminiService.js';
import { createQualityGeminiExecutors } from './qualityGeminiExecutors.js';
import { QualityPipelineService } from './qualityPipelineService.js';
import Job from '../models/jobModel.js';
import System from '../models/systemModel.js';
import TranslationChunk from '../models/translationChunkModel.js';
import UploadBatch from '../models/uploadBatchModel.js';
import { MAX_JOB_ATTEMPTS, TRANSLATION_PIPELINE_MODE } from '../config/env.js';
import { QUALITY_PIPELINE_VERSION } from './qualityPipelineState.js';
import { cleanupOrphanUploads } from './storageService.js';
import { runBoundedTasks } from '../utils/runBoundedTasks.js';
import {
    sourceCleanupService as runtimeSourceCleanupService,
    sourceService as runtimeSourceService
} from './runtimeServices.js';
import {
    ErrorCodes,
    ProcessingError,
    normalizeProcessingError
} from '../utils/processingError.js';

const CIRCUIT_BREAKER_KEY = 'circuit_breaker';
const LEASE_DURATION_MS = 5 * 60 * 1000;
const LEASE_HEARTBEAT_MS = 60 * 1000;
const QUOTA_RETRY_BASE_MS = 30 * 60 * 1000;
const TRANSIENT_RETRY_BASE_MS = 60 * 1000;

export class QueueManager extends EventEmitter {
    constructor({
        sourceService = runtimeSourceService,
        sourceCleanupService = runtimeSourceCleanupService,
    } = {}) {
        super();
        this.isProcessing = false;
        this.currentJobId = null;
        this.currentAbortController = null;
        this.consecutiveFailures = 0;
        this.isHibernating = false;
        this.hibernationCount = 0;
        this.hibernationStats = null;
        this.hibernationTimer = null;
        this.retryTimer = null;
        this.sourceService = sourceService;
        this.sourceCleanupService = sourceCleanupService;
        this.cleanupTimer = null;
    }

    async initDB() {
        const now = new Date();
        const cancelledJobs = await Job.find(
            {
                status: 'processing',
                cancelRequested: true,
                $or: [
                    { leaseExpiresAt: { $lte: now } },
                    { leaseExpiresAt: null }
                ]
            },
            'jobId filePath storageProvider storageKey sourceState sourceCleanupState sourceCleanupAttempts'
        ).lean();
        for (const job of cancelledJobs) {
            await this.cleanupJob(job.jobId, job);
        }

        const recovery = await Job.updateMany(
            {
                status: 'processing',
                cancelRequested: { $ne: true },
                $or: [
                    { leaseExpiresAt: { $lte: now } },
                    { leaseExpiresAt: null }
                ]
            },
            {
                $set: {
                    status: 'pending',
                    processingToken: null,
                    leaseExpiresAt: null,
                    nextRetryAt: now,
                    error: 'Tiến trình cũ đã được phục hồi sau khi server khởi động lại.',
                    errorCode: null
                }
            }
        );

        if (recovery.modifiedCount > 0) {
            console.log(`♻️ [QUEUE] Đã phục hồi ${recovery.modifiedCount} job có lease hết hạn.`);
        }
        if (cancelledJobs.length > 0) {
            console.log(`🧹 [QUEUE] Đã dọn ${cancelledJobs.length} job hủy dở từ worker cũ.`);
        }

        const sysState = await System.findOne({ key: CIRCUIT_BREAKER_KEY });
        if (sysState?.isHibernating && sysState.stats?.wakeupTime) {
            const wakeupTime = new Date(sysState.stats.wakeupTime);
            if (wakeupTime > now) {
                this.isHibernating = true;
                this.hibernationStats = sysState.stats.toObject?.() || sysState.stats;
                this.hibernationCount = sysState.stats.hibernationCount || 0;
                this.scheduleWakeUp(wakeupTime.getTime() - now.getTime());
            } else {
                await System.findOneAndUpdate(
                    { key: CIRCUIT_BREAKER_KEY },
                    { $set: { isHibernating: false, stats: null } },
                    { upsert: true }
                );
            }
        }

        const orphanCount = await cleanupOrphanUploads();
        if (orphanCount > 0) {
            console.log(`🧹 [GC] Đã xóa ${orphanCount} PDF mồ côi khi khởi động.`);
        }

        await this.runSourceCleanupSweep();
        this.startSourceCleanupSweeper();

        await this.startWorker();
    }

    getSystemStatus() {
        return {
            isHibernating: this.isHibernating,
            stats: this.hibernationStats
        };
    }

    scheduleWakeUp(delayMs) {
        if (this.hibernationTimer) clearTimeout(this.hibernationTimer);
        this.hibernationTimer = setTimeout(() => {
            this.wakeUp().catch(error => {
                console.error('❌ [CIRCUIT BREAKER] Không thể tự thức dậy:', error.message);
                this.scheduleWakeUp(60 * 1000);
            });
        }, Math.max(0, delayMs));
    }

    async forceWakeUp() {
        if (!this.isHibernating) return false;
        if (this.hibernationTimer) clearTimeout(this.hibernationTimer);
        await this.wakeUp();
        return true;
    }

    async triggerHibernation() {
        if (this.isHibernating) return;

        const sleepHours = 4;
        const sleepMs = sleepHours * 60 * 60 * 1000;
        const stats = {
            startTime: new Date().toISOString(),
            wakeupTime: new Date(Date.now() + sleepMs).toISOString(),
            sleepHours,
            hibernationCount: this.hibernationCount + 1
        };

        await System.findOneAndUpdate(
            { key: CIRCUIT_BREAKER_KEY },
            { $set: { isHibernating: true, stats } },
            { upsert: true }
        );

        this.isHibernating = true;
        this.hibernationCount = stats.hibernationCount;
        this.hibernationStats = stats;
        this.emit('systemStatusChanged', this.getSystemStatus());
        this.scheduleWakeUp(sleepMs);
        console.log(`🛑 [CIRCUIT BREAKER] Ngủ đông ${sleepHours} giờ sau lỗi quota liên tiếp.`);
    }

    async wakeUp() {
        await System.findOneAndUpdate(
            { key: CIRCUIT_BREAKER_KEY },
            { $set: { isHibernating: false, stats: null } },
            { upsert: true }
        );

        this.consecutiveFailures = 0;
        this.isHibernating = false;
        this.hibernationStats = null;
        this.hibernationTimer = null;
        this.emit('systemStatusChanged', this.getSystemStatus());
        await this.startWorker();
    }

    async addJob(file, folderName, clientUploadId = null) {
        if (clientUploadId) {
            const existing = await Job.findOne({ clientUploadId });
            if (existing) {
                if (existing.status === 'failed' && existing.errorCode === ErrorCodes.FILE_MISSING) {
                    existing.filePath = file.path;
                    existing.status = 'pending';
                    existing.error = null;
                    existing.errorCode = null;
                    existing.attemptCount = 0;
                    existing.nextRetryAt = new Date();
                    existing.cancelRequested = false;
                    await existing.save();
                    void this.startWorker();
                    return existing;
                }

                await this.safeUnlink(file.path);
                return existing;
            }
        }

        let job;
        try {
            job = await Job.create({
                jobId: randomUUID(),
                ...(clientUploadId ? { clientUploadId } : {}),
                originalName: file.originalname,
                folderName: folderName || 'Mặc định',
                filePath: file.path,
                storageProvider: 'local',
                sourceState: 'ready',
                status: 'pending',
                maxAttempts: MAX_JOB_ATTEMPTS,
                nextRetryAt: new Date(),
                translationMode: TRANSLATION_PIPELINE_MODE,
                translationPipelineVersion: QUALITY_PIPELINE_VERSION
            });
        } catch (error) {
            if (error?.code === 11000 && clientUploadId) {
                const existing = await Job.findOne({ clientUploadId });
                await this.safeUnlink(file.path);
                if (existing) return existing;
            }
            throw error;
        }

        void this.startWorker();
        return job;
    }

    async getJobsSummary({ limit = 100, cursor = null } = {}) {
        const filter = cursor ? { _id: { $lt: cursor } } : {};
        const rows = await Job.find(
            filter,
            'jobId originalName folderName status error errorCode attemptCount maxAttempts nextRetryAt chunkCount completedChunks uploadBatchId uploadConfirmedAt createdAt translationMode translationPipelineVersion currentQualityStage passedChunks needsReviewChunks qualityWarnings'
        )
            .sort({ _id: -1 })
            .limit(limit + 1)
            .lean();

        const hasMore = rows.length > limit;
        const items = hasMore ? rows.slice(0, limit) : rows;
        return {
            items,
            nextCursor: hasMore ? String(items.at(-1)._id) : null
        };
    }

    async getJobResult(jobId) {
        return Job.findOne({ jobId });
    }

    emitJobUpdate(jobId, status, fields = {}) {
        this.emit('jobUpdated', { jobId, status, ...fields });
    }

    createLeaseHeartbeat(jobId, processingToken) {
        return setInterval(() => {
            Job.updateOne(
                { jobId, status: 'processing', processingToken },
                { $set: { leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS) } }
            ).catch(error => {
                console.error(`❌ [LEASE] Không thể gia hạn ${jobId}:`, error.message);
            });
        }, LEASE_HEARTBEAT_MS);
    }

    calculateRetryAt(error, attemptCount) {
        if (Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0) {
            const jitter = Math.floor(Math.random() * Math.min(30_000, error.retryAfterMs / 4));
            return new Date(Date.now() + error.retryAfterMs + jitter);
        }
        const baseDelay = error.quotaRelated ? QUOTA_RETRY_BASE_MS : TRANSIENT_RETRY_BASE_MS;
        const exponentialDelay = baseDelay * (2 ** Math.max(0, attemptCount - 1));
        const jitter = Math.floor(Math.random() * Math.min(30000, baseDelay / 4));
        return new Date(Date.now() + exponentialDelay + jitter);
    }

    async claimNextJob() {
        const now = new Date();
        const processingToken = randomUUID();
        return Job.findOneAndUpdate(
            {
                status: 'pending',
                cancelRequested: { $ne: true },
                $and: [
                    {
                        $or: [
                            { nextRetryAt: null },
                            { nextRetryAt: { $lte: now } }
                        ]
                    },
                    {
                        $or: [
                            { storageProvider: { $ne: 'r2' } },
                            {
                                storageProvider: 'r2',
                                sourceState: 'ready',
                                storageKey: { $type: 'string' }
                            }
                        ]
                    }
                ]
            },
            {
                $set: {
                    status: 'processing',
                    processingToken,
                    leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS),
                    nextRetryAt: null,
                    error: null,
                    errorCode: null
                },
                $inc: { attemptCount: 1 }
            },
            { sort: { createdAt: 1 }, returnDocument: 'after' }
        );
    }

    async recoverExpiredLeases() {
        const now = new Date();
        const cancelledJobs = await Job.find(
            {
                status: 'processing',
                cancelRequested: true,
                leaseExpiresAt: { $lte: now }
            },
            'jobId filePath storageProvider storageKey sourceState sourceCleanupState sourceCleanupAttempts'
        ).lean();
        for (const job of cancelledJobs) {
            await this.cleanupJob(job.jobId, job);
        }

        const result = await Job.updateMany(
            {
                status: 'processing',
                cancelRequested: { $ne: true },
                leaseExpiresAt: { $lte: now }
            },
            {
                $set: {
                    status: 'pending',
                    processingToken: null,
                    leaseExpiresAt: null,
                    nextRetryAt: now,
                    error: 'Worker cũ mất lease; job đã được phục hồi.',
                    errorCode: null
                }
            }
        );
        return result.modifiedCount + cancelledJobs.length;
    }

    async scheduleNextRetry() {
        if (this.retryTimer) clearTimeout(this.retryTimer);
        const [nextRetry, nextLease] = await Promise.all([
            Job.findOne(
                { status: 'pending', nextRetryAt: { $gt: new Date() } },
                'nextRetryAt'
            ).sort({ nextRetryAt: 1 }).lean(),
            Job.findOne(
                { status: 'processing', leaseExpiresAt: { $gt: new Date() } },
                'leaseExpiresAt'
            ).sort({ leaseExpiresAt: 1 }).lean()
        ]);

        const wakeTimes = [nextRetry?.nextRetryAt, nextLease?.leaseExpiresAt]
            .filter(Boolean)
            .map(value => new Date(value).getTime());
        if (wakeTimes.length === 0) return;
        const delayMs = Math.max(1000, Math.min(...wakeTimes) - Date.now());
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            void this.startWorker();
        }, Math.min(delayMs, 2_147_000_000));
    }

    async saveTranslatedChunk(job, chunkIndex, content) {
        try {
            const isStillActive = await Job.exists({
                jobId: job.jobId,
                status: 'processing',
                processingToken: job.processingToken,
                cancelRequested: { $ne: true }
            });
            if (!isStillActive) {
                throw new ProcessingError(ErrorCodes.CANCELLED, 'Tác vụ đã được hủy.');
            }

            await TranslationChunk.updateOne(
                { jobId: job.jobId, chunkIndex },
                { $set: { content } },
                { upsert: true }
            );

            const completedChunks = await TranslationChunk.countDocuments({ jobId: job.jobId });
            const progressUpdate = await Job.updateOne(
                {
                    jobId: job.jobId,
                    status: 'processing',
                    processingToken: job.processingToken,
                    cancelRequested: { $ne: true }
                },
                { $set: { completedChunks } }
            );
            if (progressUpdate.matchedCount === 0) {
                throw new ProcessingError(ErrorCodes.CANCELLED, 'Tác vụ đã được hủy.');
            }
            this.emitJobUpdate(job.jobId, 'processing', {
                completedChunks,
                chunkCount: job.chunkCount
            });
        } catch (error) {
            if (error instanceof ProcessingError) throw error;
            throw new ProcessingError(
                ErrorCodes.DATABASE_UNAVAILABLE,
                error.message,
                { retryable: true, publicMessage: 'MongoDB tạm thời không ghi được kết quả.' }
            );
        }
    }

    async assertJobActive(job) {
        const active = await Job.exists({
            jobId: job.jobId,
            status: 'processing',
            processingToken: job.processingToken,
            cancelRequested: { $ne: true }
        });
        if (!active) throw new ProcessingError(ErrorCodes.CANCELLED, 'Tác vụ đã được hủy.');
    }

    async getQualityProgress(jobId) {
        const [completedChunks, passedChunks, needsReviewRows] = await Promise.all([
            TranslationChunk.countDocuments({
                jobId,
                $or: [
                    { stage: { $in: ['completed', 'needs_review'] } },
                    { content: { $type: 'string' }, pipelineVersion: null },
                ],
            }),
            TranslationChunk.countDocuments({ jobId, qualityStatus: 'passed' }),
            TranslationChunk.find(
                { jobId, qualityStatus: 'needs_review' },
                'chunkIndex pageStart pageEnd'
            ).sort({ chunkIndex: 1 }).lean(),
        ]);
        return {
            completedChunks,
            passedChunks,
            needsReviewChunks: needsReviewRows.length,
            qualityWarnings: needsReviewRows.map(row => ({
                chunkIndex: row.chunkIndex,
                pageStart: row.pageStart,
                pageEnd: row.pageEnd,
            })),
        };
    }

    async processQualityChunks(job, splitResult, emitLog, signal) {
        const { chunkBuffers, totalPages, pageRanges } = splitResult;
        const executors = createQualityGeminiExecutors({
            onSchedulerEvent: event => {
                const status = event.status ? ` status=${event.status}` : '';
                const retry = event.retryAfterMs ? ` retryAfterMs=${event.retryAfterMs}` : '';
                emitLog(`🔄 [${event.stage}] keyIndex=${event.keyIndex} event=${event.type}${status}${retry}`);
            },
        });
        const pipeline = new QualityPipelineService({ ChunkModel: TranslationChunk, executors });
        const indexes = chunkBuffers.map((_, index) => index);

        await runBoundedTasks(indexes, 2, async chunkIndex => {
            const range = pageRanges[chunkIndex];
            return pipeline.runChunk({
                jobId: job.jobId,
                chunkIndex,
                pageStart: range.pageStart,
                pageEnd: range.pageEnd,
                totalPages,
                pdfBuffer: chunkBuffers[chunkIndex],
                signal,
                assertActive: () => this.assertJobActive(job),
                onStage: async event => {
                    if (event.phase === 'started') {
                        const progress = await this.getQualityProgress(job.jobId);
                        await Job.updateOne(
                            {
                                jobId: job.jobId,
                                status: 'processing',
                                processingToken: job.processingToken,
                                cancelRequested: { $ne: true },
                            },
                            { $set: { currentQualityStage: event.action } }
                        );
                        this.emitJobUpdate(job.jobId, 'processing', {
                            translationMode: 'quality',
                            translationPipelineVersion: QUALITY_PIPELINE_VERSION,
                            ...progress,
                            currentQualityStage: event.action,
                            qualityStagePhase: 'started',
                            chunkIndex,
                            pageStart: range.pageStart,
                            pageEnd: range.pageEnd,
                        });
                        emitLog(`🧪 [Chunk ${chunkIndex + 1}] Bắt đầu stage=${event.action}.`);
                        return;
                    }

                    const progress = await this.getQualityProgress(job.jobId);
                    await Job.updateOne(
                        {
                            jobId: job.jobId,
                            status: 'processing',
                            processingToken: job.processingToken,
                            cancelRequested: { $ne: true },
                        },
                        { $set: progress }
                    );
                    this.emitJobUpdate(job.jobId, 'processing', {
                        translationMode: 'quality',
                        translationPipelineVersion: QUALITY_PIPELINE_VERSION,
                        ...progress,
                        currentQualityStage: event.action,
                        qualityStagePhase: 'completed',
                        chunkIndex,
                        pageStart: range.pageStart,
                        pageEnd: range.pageEnd,
                    });
                    emitLog(`✅ [Chunk ${chunkIndex + 1}] Hoàn thành stage=${event.action}.`);
                },
            });
        });

        return this.getQualityProgress(job.jobId);
    }

    async processClaimedJob(job, signal) {
        const jobStartedAt = Date.now();
        const emitLog = (msg) => {
            const safeStorageKey = job.storageProvider === 'r2' ? job.storageKey : 'legacy-local';
            console.log(`[batchId=${job.uploadBatchId || 'legacy'} jobId=${job.jobId} storageKey=${safeStorageKey} attempt=${job.attemptCount || 1} elapsedMs=${Date.now() - jobStartedAt}] ${msg}`);
            this.emit('jobLog', { jobId: job.jobId, msg });
        };

        let resolvedSource = null;
        try {
            resolvedSource = await this.sourceService.resolve(job);
            const sourcePath = resolvedSource.filePath;

            if (signal.aborted) {
                throw new ProcessingError(ErrorCodes.CANCELLED, 'Tác vụ đã được hủy.');
            }

        let splitResult;
        try {
            emitLog('Đang băm PDF...');
            splitResult = await processPdf(sourcePath, signal);
        } catch (error) {
            if (error instanceof ProcessingError) throw error;
            throw new ProcessingError(
                ErrorCodes.INVALID_PDF,
                error.message,
                { publicMessage: 'PDF bị hỏng hoặc không thể đọc.' }
            );
        }

        if (signal.aborted) {
            throw new ProcessingError(ErrorCodes.CANCELLED, 'Tác vụ đã được hủy.');
        }

        const { chunkBuffers } = splitResult;

        job.chunkCount = chunkBuffers.length;
        const translationMode = job.translationMode || 'legacy';
        const existingRows = await TranslationChunk.find({ jobId: job.jobId }, 'chunkIndex content stage qualityStatus').lean();
        const existingChunks = new Map(existingRows
            .filter(row => typeof row.content === 'string')
            .map(row => [row.chunkIndex, row.content]));
        await Job.updateOne(
            { jobId: job.jobId, processingToken: job.processingToken },
            {
                $set: {
                    chunkCount: chunkBuffers.length,
                    completedChunks: existingChunks.size,
                    translationMode,
                    translationPipelineVersion: translationMode === 'quality'
                        ? QUALITY_PIPELINE_VERSION
                        : (job.translationPipelineVersion || QUALITY_PIPELINE_VERSION),
                }
            }
        );

        let qualityProgress = null;
        if (translationMode === 'quality') {
            qualityProgress = await this.processQualityChunks(job, splitResult, emitLog, signal);
        } else {
            await processTranslation(chunkBuffers, emitLog, {
                signal,
                mode: 'legacy',
                existingChunks,
                onChunkTranslated: (chunkIndex, content) => this.saveTranslatedChunk(job, chunkIndex, content)
            });
        }

        if (signal.aborted) {
            throw new ProcessingError(ErrorCodes.CANCELLED, 'Tác vụ đã được hủy.');
        }

        const updateResult = await Job.updateOne(
            {
                jobId: job.jobId,
                status: 'processing',
                processingToken: job.processingToken,
                cancelRequested: { $ne: true }
            },
            {
                $set: {
                    status: 'completed',
                    error: null,
                    errorCode: null,
                    processingToken: null,
                    leaseExpiresAt: null,
                    nextRetryAt: null,
                    completedChunks: chunkBuffers.length,
                    currentQualityStage: null,
                    ...(qualityProgress || {})
                }
            }
        );

        if (updateResult.matchedCount === 0) {
            throw new ProcessingError(ErrorCodes.CANCELLED, 'Tác vụ đã bị hủy trước khi lưu kết quả.');
        }

        await this.safeUnlink(job.filePath);
        await this.cleanupSourceSafely(job, 'completed');
        this.consecutiveFailures = 0;
        this.emitJobUpdate(job.jobId, 'completed', {
            ...(translationMode === 'quality' ? {
                translationMode: 'quality',
                translationPipelineVersion: QUALITY_PIPELINE_VERSION,
            } : {}),
            completedChunks: chunkBuffers.length,
            chunkCount: chunkBuffers.length,
            ...(qualityProgress || {})
        });
        emitLog('🎉 Đã dịch xong toàn bộ!');
        } finally {
            await this.sourceService.cleanup(resolvedSource);
        }
    }

    async handleProcessingFailure(job, rawError) {
        const error = normalizeProcessingError(rawError);
        const cancellationRequested = error.code === ErrorCodes.CANCELLED || Boolean(await Job.exists({
            jobId: job.jobId,
            processingToken: job.processingToken,
            cancelRequested: true
        }));
        if (cancellationRequested) {
            await this.cleanupJob(job.jobId, job);
            this.emitJobUpdate(job.jobId, 'cancelled', { error: null, errorCode: ErrorCodes.CANCELLED });
            return;
        }

        if (error.quotaRelated) {
            this.consecutiveFailures += 1;
        } else {
            this.consecutiveFailures = 0;
        }

        const shouldRetry = error.retryable && job.attemptCount < job.maxAttempts;
        if (shouldRetry) {
            const nextRetryAt = this.calculateRetryAt(error, job.attemptCount);
            await Job.updateOne(
                { jobId: job.jobId, processingToken: job.processingToken },
                {
                    $set: {
                        status: 'pending',
                        error: error.publicMessage,
                        errorCode: error.code,
                        nextRetryAt,
                        processingToken: null,
                        leaseExpiresAt: null
                    }
                }
            );
            this.emitJobUpdate(job.jobId, 'pending', {
                error: error.publicMessage,
                errorCode: error.code,
                attemptCount: job.attemptCount,
                maxAttempts: job.maxAttempts,
                nextRetryAt
            });
            return;
        }

        await Job.updateOne(
            { jobId: job.jobId, processingToken: job.processingToken },
            {
                $set: {
                    status: 'failed',
                    error: error.publicMessage,
                    errorCode: error.code,
                    nextRetryAt: null,
                    processingToken: null,
                    leaseExpiresAt: null
                }
            }
        );
        await this.safeUnlink(job.filePath);
        // FILE_MISSING cần giữ các chunk đã dịch để Local Feeder tải lại PDF và resume.
        if (![ErrorCodes.FILE_MISSING, ErrorCodes.R2_SOURCE_MISSING].includes(error.code)) {
            await TranslationChunk.deleteMany({ jobId: job.jobId });
        }
        await this.cleanupSourceSafely(job, 'permanent_failure');
        this.emitJobUpdate(job.jobId, 'failed', {
            error: error.publicMessage,
            errorCode: error.code,
            attemptCount: job.attemptCount,
            maxAttempts: job.maxAttempts
        });
    }

    async startWorker() {
        if (this.isProcessing || this.isHibernating) return;
        this.isProcessing = true;

        let leaseHeartbeat = null;
        let infrastructureFailed = false;
        let processedJob = false;
        try {
            await this.recoverExpiredLeases();
            const job = await this.claimNextJob();
            if (!job) {
                await this.scheduleNextRetry();
                return;
            }
            processedJob = true;

            this.currentJobId = job.jobId;
            this.currentAbortController = new AbortController();
            leaseHeartbeat = this.createLeaseHeartbeat(job.jobId, job.processingToken);
            this.emitJobUpdate(job.jobId, 'processing', {
                attemptCount: job.attemptCount,
                maxAttempts: job.maxAttempts
            });

            try {
                await this.processClaimedJob(job, this.currentAbortController.signal);
            } catch (error) {
                await this.handleProcessingFailure(job, error);
            }

            if (this.consecutiveFailures >= 10) {
                await this.triggerHibernation();
            }
        } catch (error) {
            infrastructureFailed = true;
            console.error('❌ [QUEUE] Worker gặp lỗi database/hạ tầng:', error.message);
        } finally {
            if (leaseHeartbeat) clearInterval(leaseHeartbeat);
            this.currentJobId = null;
            this.currentAbortController = null;
            this.isProcessing = false;

            if (!this.isHibernating) {
                if (infrastructureFailed) {
                    setTimeout(() => void this.startWorker(), 5000);
                } else if (processedJob) {
                    queueMicrotask(() => void this.startWorker());
                }
            }
        }
    }

    async safeUnlink(filePath) {
        if (!filePath) return;
        try {
            await fs.unlink(filePath);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error(`[GC] Không thể xóa ${filePath}:`, error.message);
            }
        }
    }

    async cleanupSourceSafely(job, reason) {
        try {
            return await this.sourceCleanupService.cleanupSource(job, { reason });
        } catch (error) {
            console.error(`[R2 CLEANUP] Không thể ghi trạng thái cleanup cho ${job.jobId}:`, error.message);
            return { cleaned: false, retryScheduled: false };
        }
    }

    async cleanupJob(jobId, knownJob = null) {
        const job = typeof knownJob === 'string'
            ? { jobId, filePath: knownJob }
            : knownJob || await Job.findOne({ jobId }).lean();
        if (!job) return { deleted: false, cleanupPending: false };
        const sourceCleanup = await this.cleanupSourceSafely(job, 'cancel_or_delete');
        if (!sourceCleanup.cleaned) {
            await Job.updateOne({ jobId }, { $set: { status: 'cancelled', cancelRequested: true } });
            return { deleted: false, cleanupPending: true };
        }
        await this.safeUnlink(job.filePath);
        await TranslationChunk.deleteMany({ jobId });
        await Job.deleteOne({ jobId });
        if (job.uploadBatchId) {
            const batchStillHasJobs = await Job.exists({ uploadBatchId: job.uploadBatchId });
            if (!batchStillHasJobs) await UploadBatch.deleteOne({ batchId: job.uploadBatchId });
        }
        return { deleted: true, cleanupPending: false };
    }

    async runSourceCleanupSweep() {
        const rows = await this.sourceCleanupService.sweepRetries();
        for (const { job, result } of rows) {
            if (result.cleaned && job.status === 'cancelled') {
                await this.safeUnlink(job.filePath);
                await TranslationChunk.deleteMany({ jobId: job.jobId });
                await Job.deleteOne({ jobId: job.jobId, status: 'cancelled' });
                if (job.uploadBatchId) {
                    const batchStillHasJobs = await Job.exists({ uploadBatchId: job.uploadBatchId });
                    if (!batchStillHasJobs) await UploadBatch.deleteOne({ batchId: job.uploadBatchId });
                }
            }
        }
        return rows.length;
    }

    startSourceCleanupSweeper(intervalMs = 60_000) {
        if (this.cleanupTimer) return;
        this.cleanupTimer = setInterval(() => {
            this.runSourceCleanupSweep().catch(error => {
                console.error('[R2 CLEANUP] Sweeper thất bại:', error.message);
            });
        }, intervalMs);
        this.cleanupTimer.unref?.();
    }

    async cancelAndDeleteJob(jobId) {
        const job = await Job.findOne({ jobId }).lean();
        if (!job) return { found: false, pending: false };

        if (job.status === 'pending') {
            const cancelledJob = await Job.findOneAndUpdate(
                { jobId, status: 'pending' },
                {
                    $set: {
                        status: 'cancelled',
                        cancelRequested: true,
                        nextRetryAt: null
                    }
                },
                { returnDocument: 'after' }
            );
            // Worker có thể claim đúng giữa hai query; đánh giá lại theo trạng thái mới.
            if (!cancelledJob) return this.cancelAndDeleteJob(jobId);

            const cleanup = await this.cleanupJob(
                jobId,
                cancelledJob.storageProvider === 'r2' ? cancelledJob : cancelledJob.filePath
            );
            return { found: true, pending: cleanup?.cleanupPending || false };
        }

        if (job.status === 'processing') {
            await Job.updateOne(
                { jobId },
                { $set: { cancelRequested: true } }
            );
            if (this.currentJobId === jobId) {
                this.currentAbortController?.abort();
            }
            return { found: true, pending: true };
        }

        const cleanup = await this.cleanupJob(jobId, job.storageProvider === 'r2' ? job : job.filePath);
        return { found: true, pending: cleanup?.cleanupPending || false };
    }

    async cancelAndDeleteJobs(jobIds) {
        const results = await Promise.all(jobIds.map(jobId => this.cancelAndDeleteJob(jobId)));
        return {
            foundCount: results.filter(result => result.found).length,
            pendingCount: results.filter(result => result.pending).length
        };
    }

    async cancelAndDeleteFolder(folderName) {
        const jobs = await Job.find({ folderName }, 'jobId').lean();
        return this.cancelAndDeleteJobs(jobs.map(job => job.jobId));
    }
}

export const translationQueue = new QueueManager();
