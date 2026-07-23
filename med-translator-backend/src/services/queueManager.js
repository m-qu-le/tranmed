import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import { processPdf } from './pdfService.js';
import { processTranslation } from './geminiService.js';
import {
    createQualityGeminiExecutors,
    qualityGeminiLimiter,
    qualityKeyScheduler,
} from './qualityGeminiExecutors.js';
import { QualityPipelineService } from './qualityPipelineService.js';
import { QualityDocumentContextService } from './qualityDocumentContextService.js';
import Job from '../models/jobModel.js';
import System from '../models/systemModel.js';
import TranslationChunk from '../models/translationChunkModel.js';
import UploadBatch from '../models/uploadBatchModel.js';
import {
    MAX_JOB_ATTEMPTS,
    PARALLEL_SOURCE_BUDGET_BYTES,
    TRANSLATION_PIPELINE_MODE,
    TRANSLATION_WORKER_CONCURRENCY
} from '../config/env.js';
import { isTerminalQualityStage, QUALITY_PIPELINE_VERSION } from './qualityPipelineState.js';
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
import {
    CONTENT_MAX_ATTEMPTS,
    CONTENT_RETRY_DELAYS_MS,
    INFRASTRUCTURE_RETRY_WINDOW_MS,
    SOURCE_RETENTION_MS,
    classifyFailure,
    failureAdvice,
    isTerminalRetryable,
} from './jobFailurePolicy.js';
import { operationalMetrics } from './operationalMetrics.js';

const CIRCUIT_BREAKER_KEY = 'circuit_breaker';
const PRIORITY_FOLDER_NAME = 'Ưu tiên';
const LEASE_DURATION_MS = 5 * 60 * 1000;
const LEASE_HEARTBEAT_MS = 60 * 1000;
const INFRASTRUCTURE_RETRY_BASE_DELAY_MS = 60 * 1000;
const INFRASTRUCTURE_RETRY_MAX_DELAY_MS = 10 * 60 * 1000;
export const POOL_EXHAUSTION_WAKEUP_POLICY = 'pool_retry_after';
// Khi toàn bộ key Gemini đang cooldown, không thay job vừa dừng bằng PDF mới.
// Retry của job cũ phải được ưu tiên sau khi pool hồi phục.
export const POOL_EXHAUSTION_HIBERNATION_THRESHOLD = 10;
export const SCHEDULER_EXECUTION_VERSION = 'project-pool-v1';
const PRIORITY_DEMAND_CACHE_MS = 250;

const JOB_SUMMARY_FIELDS = 'jobId originalName folderName priority status error errorCode attemptCount maxAttempts quotaRetryCount retryCount nextRetryAt failureCategory terminalAt sourceRetentionUntil failureAdvice chunkCount completedChunks uploadBatchId uploadConfirmedAt createdAt translationMode translationPipelineVersion currentQualityStage passedChunks needsReviewChunks qualityWarnings processingStartedAt completedAt schedulerSuspended schedulerExecutionVersion';

export class QueueManager extends EventEmitter {
    constructor({
        sourceService = runtimeSourceService,
        sourceCleanupService = runtimeSourceCleanupService,
        concurrency = TRANSLATION_WORKER_CONCURRENCY,
    } = {}) {
        super();
        this.concurrency = Math.min(3, concurrency);
        this.activeJobs = new Map();
        this.activeSourceBytes = 0;
        this.pumpPromise = null;
        this.pumpRequested = false;
        this.isHibernating = false;
        this.isMaintenancePaused = false;
        this.consecutivePoolExhaustions = 0;
        this.hibernationCount = 0;
        this.hibernationStats = null;
        this.hibernationTimer = null;
        this.retryTimer = null;
        this.sourceService = sourceService;
        this.sourceCleanupService = sourceCleanupService;
        this.cleanupTimer = null;
        this.priorityDemandCache = { checkedAt: 0, value: false };
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
            const stats = sysState.stats.toObject?.() || sysState.stats;
            const wakeupTime = new Date(stats.wakeupTime);
            if (stats.wakeupPolicy === POOL_EXHAUSTION_WAKEUP_POLICY && wakeupTime > now) {
                this.isHibernating = true;
                this.hibernationStats = stats;
                this.hibernationCount = stats.hibernationCount || 0;
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
        const limiter = qualityGeminiLimiter.snapshot();
        const broker = qualityKeyScheduler.metricsSnapshot();
        return {
            isHibernating: this.isHibernating,
            stats: this.hibernationStats,
            isMaintenancePaused: this.isMaintenancePaused,
            worker: {
                concurrency: this.concurrency,
                activeJobs: this.activeJobs.size,
                activeSourceBytes: this.activeSourceBytes,
                parallelSourceBudgetBytes: PARALLEL_SOURCE_BUDGET_BYTES,
            },
            dispatcher: {
                stageQueueDepth: Math.max(
                    limiter.waitingCount,
                    broker.activeLogicalRequests - limiter.activeCount
                ),
                waitingStages: limiter.waitingCount,
                activeStages: limiter.activeCount,
                logicalConcurrency: limiter.limit,
                activeProjectCount: broker.activeProjectLimit,
                resourceGuard: limiter.lastResourceSnapshot,
                quotaGate: qualityKeyScheduler.availabilitySnapshot(),
            },
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

    pauseForRedeploy() {
        this.isMaintenancePaused = true;
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        this.emit('systemStatusChanged', this.getSystemStatus());
        return this.getSystemStatus();
    }

    async cancelRedeployPause() {
        this.isMaintenancePaused = false;
        this.emit('systemStatusChanged', this.getSystemStatus());
        await this.startWorker();
        return this.getSystemStatus();
    }

    async triggerHibernation(retryAfterMs = null) {
        if (this.isHibernating) return;
        if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return;

        const startTime = new Date();
        const wakeupTime = new Date(startTime.getTime() + retryAfterMs);
        const stats = {
            startTime: startTime.toISOString(),
            wakeupTime: wakeupTime.toISOString(),
            wakeupPolicy: POOL_EXHAUSTION_WAKEUP_POLICY,
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
        this.scheduleWakeUp(wakeupTime.getTime() - startTime.getTime());
        console.log(`🛑 [CIRCUIT BREAKER] Tạm dừng đến ${wakeupTime.toISOString()} vì toàn bộ Gemini key chưa thể cấp phát.`);
    }

    async wakeUp() {
        await System.findOneAndUpdate(
            { key: CIRCUIT_BREAKER_KEY },
            { $set: { isHibernating: false, stats: null } },
            { upsert: true }
        );

        this.consecutivePoolExhaustions = 0;
        this.isHibernating = false;
        this.hibernationStats = null;
        this.hibernationTimer = null;
        this.emit('systemStatusChanged', this.getSystemStatus());
        await this.startWorker();
    }

    async addJob(file, folderName, clientUploadId = null, priority = false) {
        if (clientUploadId) {
            const existing = await Job.findOne({ clientUploadId });
            if (existing) {
                if (existing.status === 'failed' && existing.errorCode === ErrorCodes.FILE_MISSING) {
                    existing.filePath = file.path;
                    existing.sourceSize = Number.isSafeInteger(file.size) && file.size > 0 ? file.size : null;
                    existing.status = 'pending';
                    existing.error = null;
                    existing.errorCode = null;
                    existing.attemptCount = 0;
                    existing.quotaRetryCount = 0;
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
                folderName: priority ? 'Ưu tiên' : (folderName || 'Mặc định'),
                priority: priority ? 1 : 0,
                filePath: file.path,
                sourceSize: Number.isSafeInteger(file.size) && file.size > 0 ? file.size : null,
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
        const filter = cursor ? { _id: { $gt: cursor } } : {};
        const rows = await Job.find(filter, JOB_SUMMARY_FIELDS)
            .sort({ _id: 1 })
            .limit(limit + 1)
            .lean();

        const hasMore = rows.length > limit;
        const items = hasMore ? rows.slice(0, limit) : rows;
        return {
            items,
            nextCursor: hasMore ? String(items.at(-1)._id) : null
        };
    }

    async getFolderJobsSummary({ folderName, limit = 100, cursor = null } = {}) {
        const isPriorityFolder = folderName === PRIORITY_FOLDER_NAME;
        const filter = {
            ...(isPriorityFolder ? { priority: 1 } : { folderName, priority: { $ne: 1 } }),
            ...(cursor ? { _id: { $gt: cursor } } : {}),
        };
        const rows = await Job.find(filter, JOB_SUMMARY_FIELDS)
            .sort({ _id: 1 })
            .limit(limit + 1)
            .lean();
        const hasMore = rows.length > limit;
        const items = hasMore ? rows.slice(0, limit) : rows;
        return { items, nextCursor: hasMore ? String(items.at(-1)._id) : null };
    }

    async getJobStats() {
        const [jobRows, cloudRows] = await Promise.all([
            Job.aggregate([{
                $facet: {
                    statuses: [
                        { $match: { status: { $in: ['pending', 'processing', 'completed', 'failed'] } } },
                        { $group: { _id: '$status', count: { $sum: 1 } } },
                    ],
                    folders: [{
                        $group: {
                            _id: {
                                name: {
                                    $cond: [
                                        { $eq: ['$priority', 1] },
                                        PRIORITY_FOLDER_NAME,
                                        { $ifNull: ['$folderName', 'Mặc định'] },
                                    ],
                                },
                                priority: { $eq: ['$priority', 1] },
                            },
                            count: { $sum: 1 },
                        },
                    }],
                },
            }]),
            UploadBatch.aggregate([{
                $group: {
                    _id: null,
                    uploadingBatches: { $sum: { $cond: [{ $in: ['$status', ['uploading', 'partial']] }, 1, 0] } },
                    uploadedBytes: { $sum: { $cond: [{ $in: ['$status', ['uploading', 'partial']] }, '$confirmedBytes', 0] } },
                    uploadTotalBytes: { $sum: { $cond: [{ $in: ['$status', ['uploading', 'partial']] }, '$totalBytes', 0] } },
                    confirmedFiles: { $sum: '$confirmedFiles' },
                    totalFiles: { $sum: '$totalFiles' },
                    safeFiles: { $sum: { $cond: [{ $eq: ['$status', 'ready'] }, '$confirmedFiles', 0] } },
                },
            }]),
        ]);
        const snapshot = jobRows[0] || {};
        const stats = { pending: 0, processing: 0, completed: 0, failed: 0 };
        for (const row of snapshot.statuses || []) stats[row._id] = row.count;
        const cloud = cloudRows[0] || {};
        return {
            ...stats,
            folders: (snapshot.folders || []).map(row => ({
                name: typeof row._id?.name === 'string' && row._id.name.trim() ? row._id.name : 'Mặc định',
                priority: row._id?.priority === true,
                count: row.count,
            })),
            cloud: {
                uploadingBatches: cloud.uploadingBatches || 0,
                uploadedBytes: cloud.uploadedBytes || 0,
                totalBytes: cloud.uploadTotalBytes || 0,
                confirmedFiles: cloud.confirmedFiles || 0,
                totalFiles: cloud.totalFiles || 0,
                safeFiles: cloud.safeFiles || 0,
            },
        };
    }

    async getJobResult(jobId) {
        return Job.findOne({ jobId });
    }

    async getTerminalFailures({ limit = 100, cursor = null } = {}) {
        const filter = { status: 'failed', ...(cursor ? { _id: { $lt: cursor } } : {}) };
        const rows = await Job.find(filter,
            'jobId originalName folderName error errorCode failureCategory terminalAt sourceState storageProvider sourceRetentionUntil failureAdvice updatedAt'
        ).sort({ _id: -1 }).limit(limit + 1).lean();
        const hasMore = rows.length > limit;
        const items = (hasMore ? rows.slice(0, limit) : rows).map(job => ({
            ...job,
            terminalAt: job.terminalAt || job.updatedAt,
            failureCategory: job.failureCategory || classifyFailure(job.errorCode),
            failureAdvice: job.failureAdvice || failureAdvice(job),
            canRetry: isTerminalRetryable(job.errorCode)
                && job.storageProvider === 'r2'
                && job.sourceState === 'ready',
        }));
        return { items, nextCursor: hasMore ? String(items.at(-1)._id) : null };
    }

    async retryTerminalFailures() {
        const jobs = await Job.find({ status: 'failed' }, 'jobId errorCode storageProvider storageKey sourceState').lean();
        let retried = 0;
        let skipped = 0;
        const now = new Date();
        for (const job of jobs) {
            if (!isTerminalRetryable(job.errorCode)
                || job.storageProvider !== 'r2'
                || job.sourceState !== 'ready'
                || !job.storageKey) {
                skipped += 1;
                continue;
            }
            const result = await Job.updateOne(
                { jobId: job.jobId, status: 'failed', sourceState: 'ready' },
                { $set: {
                    status: 'pending', error: null, errorCode: null, nextRetryAt: now,
                    attemptCount: 0, quotaRetryCount: 0, retryCount: 0, retryStartedAt: null, failureCategory: null,
                    terminalAt: null, sourceRetentionUntil: null, failureAdvice: null,
                    processingToken: null, leaseExpiresAt: null,
                } }
            );
            if (result.modifiedCount > 0) {
                retried += 1;
                this.emitJobUpdate(job.jobId, 'pending', { nextRetryAt: now });
            }
        }
        if (retried > 0) void this.startWorker();
        return { retried, skipped };
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

    calculateRetryAt(error, job, category, now = Date.now()) {
        const retryCount = Number.isSafeInteger(job.retryCount) ? job.retryCount : 0;
        const configuredDelay = category === 'content'
            ? CONTENT_RETRY_DELAYS_MS[Math.min(job.attemptCount - 1, CONTENT_RETRY_DELAYS_MS.length - 1)]
            : Math.min(INFRASTRUCTURE_RETRY_MAX_DELAY_MS, INFRASTRUCTURE_RETRY_BASE_DELAY_MS * (2 ** retryCount));
        const retryAfterMs = Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0 ? error.retryAfterMs : 0;
        const delay = Math.max(configuredDelay, retryAfterMs);
        const jitter = retryAfterMs > configuredDelay
            ? Math.floor(Math.random() * delay * 0.2)
            : Math.floor(Math.random() * Math.min(delay * 0.2, INFRASTRUCTURE_RETRY_MAX_DELAY_MS - delay));
        return new Date(now + delay + jitter);
    }

    pendingJobFilter(now = new Date()) {
        return {
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
        };
    }

    async peekNextJob() {
        return Job.findOne(
            this.pendingJobFilter(),
            '_id sourceSize priority schedulerSuspended processingStartedAt'
        )
            .sort({ priority: -1, createdAt: 1, _id: 1 })
            .lean();
    }

    async claimNextJob(candidateId = null, { resumeSuspended = false, processingStartedAt = null } = {}) {
        const filter = this.pendingJobFilter();
        if (candidateId) filter._id = candidateId;
        if (resumeSuspended) filter.schedulerSuspended = true;
        const processingToken = randomUUID();
        const update = {
            $set: {
                status: 'processing',
                processingToken,
                leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS),
                nextRetryAt: null,
                error: null,
                errorCode: null,
                schedulerSuspended: false,
                schedulerExecutionVersion: SCHEDULER_EXECUTION_VERSION,
                ...(!processingStartedAt ? { processingStartedAt: new Date() } : {}),
            },
        };
        if (!resumeSuspended) update.$inc = { attemptCount: 1 };
        return Job.findOneAndUpdate(
            filter,
            update,
            { sort: { priority: -1, createdAt: 1, _id: 1 }, returnDocument: 'after' }
        );
    }

    async claimAdmissibleJob() {
        if (qualityKeyScheduler.availabilitySnapshot().gated) return null;
        if ([...this.activeJobs.values()].some(active => !active.sourceSize)) return null;

        for (let attempt = 0; attempt < 3; attempt += 1) {
            const candidate = await this.peekNextJob();
            if (!candidate) return null;
            if (candidate.priority !== 1
                && [...this.activeJobs.values()].some(active => active.priority === 1)) {
                return null;
            }
            if (this.activeJobs.size === 0) {
                const claimed = await this.claimNextJob(candidate._id, {
                    resumeSuspended: candidate.schedulerSuspended === true,
                    processingStartedAt: candidate.processingStartedAt,
                });
                if (claimed) return claimed;
                continue;
            }
            const sourceSize = candidate.sourceSize;
            // ponytail: source bytes là proxy bảo thủ; nâng cấp bằng admission theo RAM đo được nếu cần chạy song song PDF lớn.
            if (!Number.isSafeInteger(sourceSize)
                || sourceSize <= 0
                || this.activeSourceBytes + sourceSize > PARALLEL_SOURCE_BUDGET_BYTES) {
                return null;
            }
            const claimed = await this.claimNextJob(candidate._id, {
                resumeSuspended: candidate.schedulerSuspended === true,
                processingStartedAt: candidate.processingStartedAt,
            });
            if (claimed) return claimed;
        }
        return null;
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

        const quotaWakeup = qualityKeyScheduler.availabilitySnapshot().nextAvailableAt;
        const wakeTimes = [nextRetry?.nextRetryAt, nextLease?.leaseExpiresAt, quotaWakeup]
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

    async hasPriorityDemand(excludingJobId = null) {
        if ([...this.activeJobs.entries()].some(([jobId, active]) => (
            jobId !== excludingJobId && active.priority === 1
        ))) return true;

        const now = Date.now();
        if (now - this.priorityDemandCache.checkedAt < PRIORITY_DEMAND_CACHE_MS) {
            return this.priorityDemandCache.value;
        }
        const value = Boolean(await Job.exists({
            ...this.pendingJobFilter(new Date(now)),
            priority: 1,
        }));
        this.priorityDemandCache = { checkedAt: now, value };
        if (value) qualityGeminiLimiter.setPriorityGate(true);
        return value;
    }

    async refreshPriorityGate() {
        const activePriority = [...this.activeJobs.values()].some(active => active.priority === 1);
        if (!activePriority
            && !this.priorityDemandCache.value
            && !qualityGeminiLimiter.snapshot().priorityGate) {
            qualityGeminiLimiter.setPriorityGate(false);
            return;
        }
        const pendingPriority = activePriority ? true : Boolean(await Job.exists({
            ...this.pendingJobFilter(),
            priority: 1,
        }));
        qualityGeminiLimiter.setPriorityGate(activePriority || pendingPriority);
        this.priorityDemandCache = {
            checkedAt: Date.now(),
            value: activePriority || pendingPriority,
        };
    }

    async assertStageAdmission(job) {
        await this.assertJobActive(job);
        if (job.priority === 1 || !(await this.hasPriorityDemand(job.jobId))) return;
        qualityKeyScheduler.suspendJob(job.jobId);
        qualityGeminiLimiter.suspendJob(job.jobId);
        throw new ProcessingError(
            ErrorCodes.SCHEDULER_SUSPENDED,
            'Job thường được tạm nhường source lane cho thư mục Ưu tiên.',
            { publicMessage: 'Tạm nhường tài nguyên cho tài liệu ưu tiên.' }
        );
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

    async processQualityChunks(job, splitResult, sourcePath, emitLog, signal) {
        const { chunkBuffers, totalPages, pageRanges } = splitResult;
        qualityKeyScheduler.resumeJob(job.jobId);
        // Encode lazily when a stage is actually issued, retain it across that
        // chunk's stages, then release it at the terminal boundary.
        const chunkPayloads = new Map();
        const getChunkPayload = chunkIndex => {
            if (!chunkPayloads.has(chunkIndex)) {
                chunkPayloads.set(
                    chunkIndex,
                    Buffer.from(chunkBuffers[chunkIndex]).toString('base64')
                );
            }
            return chunkPayloads.get(chunkIndex);
        };
        const executors = createQualityGeminiExecutors({
            schedulingContext: { jobId: job.jobId, priority: job.priority || 0 },
            onSchedulerEvent: event => {
                const status = event.status ? ` status=${event.status}` : '';
                const retry = event.retryAfterMs ? ` retryAfterMs=${event.retryAfterMs}` : '';
                emitLog(`🔄 [${event.stage}] keyIndex=${event.keyIndex} event=${event.type}${status}${retry}`);
            },
        });
        const contextService = new QualityDocumentContextService({ JobModel: Job, executors });
        const documentContext = await contextService.prepare({
            job,
            sourcePath,
            totalPages,
            signal,
            assertActive: () => this.assertJobActive(job),
            assertCanStartStage: () => this.assertStageAdmission(job),
            onStage: async event => {
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
                    currentQualityStage: event.action,
                    qualityStagePhase: event.phase,
                });
                emitLog(`📚 Context tài liệu phase=${event.phase}.`);
            },
        });
        const pipeline = new QualityPipelineService({ ChunkModel: TranslationChunk, executors });
        const indexes = chunkBuffers.map((_, index) => index);

        const chunkDispatcherWidth = Math.min(
            indexes.length,
            qualityGeminiLimiter.snapshot().maxLimit
        );
        try {
            await runBoundedTasks(indexes, chunkDispatcherWidth, async chunkIndex => {
                const range = pageRanges[chunkIndex];
                return pipeline.runChunk({
                    jobId: job.jobId,
                    chunkIndex,
                    pageStart: range.pageStart,
                    pageEnd: range.pageEnd,
                    totalPages,
                    pdfBuffer: () => getChunkPayload(chunkIndex),
                    documentContext,
                    signal,
                    assertActive: () => this.assertJobActive(job),
                    assertCanStartStage: () => this.assertStageAdmission(job),
                    onStage: async event => {
                        if (event.phase === 'started') {
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
                                currentQualityStage: event.action,
                                qualityStagePhase: 'started',
                                chunkIndex,
                                pageStart: range.pageStart,
                                pageEnd: range.pageEnd,
                            });
                            emitLog(`🧪 [Chunk ${chunkIndex + 1}] Bắt đầu stage=${event.action}.`);
                            return;
                        }

                        const terminal = isTerminalQualityStage(event.chunk.stage);
                        const progress = terminal
                            ? await this.getQualityProgress(job.jobId)
                            : null;
                        if (terminal) {
                            chunkPayloads.delete(chunkIndex);
                            operationalMetrics.increment(
                                'translation.pages_completed',
                                range.pageEnd - range.pageStart + 1
                            );
                            operationalMetrics.increment('translation.chunks_terminal');
                        }
                        await Job.updateOne(
                            {
                                jobId: job.jobId,
                                status: 'processing',
                                processingToken: job.processingToken,
                                cancelRequested: { $ne: true },
                            },
                            {
                                $set: {
                                    currentQualityStage: event.action,
                                    ...(progress || {}),
                                },
                            }
                        );
                        this.emitJobUpdate(job.jobId, 'processing', {
                            translationMode: 'quality',
                            translationPipelineVersion: QUALITY_PIPELINE_VERSION,
                            ...(progress || {}),
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
        } finally {
            chunkPayloads.clear();
        }

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
            qualityProgress = await this.processQualityChunks(job, splitResult, sourcePath, emitLog, signal);
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
                    completedAt: new Date(),
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
        this.consecutivePoolExhaustions = 0;
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
        if (error.code === ErrorCodes.SCHEDULER_SUSPENDED) {
            await Job.updateOne(
                { jobId: job.jobId, processingToken: job.processingToken },
                {
                    $set: {
                        status: 'pending',
                        schedulerSuspended: true,
                        error: null,
                        errorCode: null,
                        nextRetryAt: new Date(),
                        processingToken: null,
                        leaseExpiresAt: null,
                    },
                }
            );
            this.priorityDemandCache = { checkedAt: 0, value: true };
            this.emitJobUpdate(job.jobId, 'pending', {
                schedulerSuspended: true,
                schedulerExecutionVersion: SCHEDULER_EXECUTION_VERSION,
            });
            return;
        }
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

        this.consecutivePoolExhaustions = error.poolExhausted
            ? this.consecutivePoolExhaustions + 1
            : 0;
        const shouldHibernate = this.consecutivePoolExhaustions >= POOL_EXHAUSTION_HIBERNATION_THRESHOLD;

        const category = classifyFailure(error.code);
        const now = new Date();
        const retryStartedAt = job.retryStartedAt ? new Date(job.retryStartedAt) : now;
        const infrastructureDeadline = new Date(retryStartedAt.getTime() + INFRASTRUCTURE_RETRY_WINDOW_MS);
        const shouldRetry = category === 'infrastructure'
            ? now < infrastructureDeadline
            : category === 'content' && job.attemptCount < CONTENT_MAX_ATTEMPTS;
        if (shouldRetry) {
            const calculatedRetryAt = this.calculateRetryAt(error, job, category, now.getTime());
            const nextRetryAt = category === 'infrastructure' && calculatedRetryAt > infrastructureDeadline
                ? infrastructureDeadline : calculatedRetryAt;
            await Job.updateOne(
                { jobId: job.jobId, processingToken: job.processingToken },
                {
                    $set: {
                        status: 'pending',
                        error: error.publicMessage,
                        errorCode: error.code,
                        nextRetryAt,
                        retryStartedAt,
                        failureCategory: category,
                        processingToken: null,
                        leaseExpiresAt: null
                    },
                    $inc: { retryCount: 1, ...(error.poolExhausted ? { quotaRetryCount: 1 } : {}) }
                }
            );
            this.emitJobUpdate(job.jobId, 'pending', {
                error: error.publicMessage,
                errorCode: error.code,
                attemptCount: job.attemptCount,
                maxAttempts: category === 'content' ? CONTENT_MAX_ATTEMPTS : null,
                nextRetryAt
            });
            if (shouldHibernate && !this.isHibernating) {
                await this.triggerHibernation(error.retryAfterMs);
            }
            return;
        }

        const terminalAt = now;
        const sourceRetentionUntil = job.storageProvider === 'r2' && job.sourceState === 'ready'
            ? new Date(now.getTime() + SOURCE_RETENTION_MS) : null;
        const terminalCategory = category;
        const terminalAdvice = failureAdvice({ ...job, errorCode: error.code });
        await Job.updateOne(
            { jobId: job.jobId, processingToken: job.processingToken },
            {
                $set: {
                    status: 'failed',
                    error: error.publicMessage,
                    errorCode: error.code,
                    nextRetryAt: null,
                    failureCategory: terminalCategory,
                    terminalAt,
                    sourceRetentionUntil,
                    failureAdvice: terminalAdvice,
                    processingToken: null,
                    leaseExpiresAt: null
                }
            }
        );
        this.emitJobUpdate(job.jobId, 'failed', {
            error: error.publicMessage,
            errorCode: error.code,
            attemptCount: job.attemptCount,
            maxAttempts: category === 'content' ? CONTENT_MAX_ATTEMPTS : job.maxAttempts,
            failureCategory: terminalCategory,
            terminalAt,
            sourceRetentionUntil,
            failureAdvice: terminalAdvice,
        });
        if (shouldHibernate && !this.isHibernating) {
            await this.triggerHibernation(error.retryAfterMs);
        }
    }

    async runActiveJob(job) {
        const active = this.activeJobs.get(job.jobId);
        let leaseHeartbeat = null;
        try {
            leaseHeartbeat = this.createLeaseHeartbeat(job.jobId, job.processingToken);
            this.emitJobUpdate(job.jobId, 'processing', {
                attemptCount: job.attemptCount,
                maxAttempts: job.maxAttempts
            });

            try {
                await this.processClaimedJob(job, active.abortController.signal);
            } catch (error) {
                await this.handleProcessingFailure(job, error);
            }

        } catch (error) {
            console.error(`❌ [QUEUE] Worker ${job.jobId} gặp lỗi database/hạ tầng:`, error.message);
            setTimeout(() => void this.startWorker(), 5000);
        } finally {
            if (leaseHeartbeat) clearInterval(leaseHeartbeat);
            const current = this.activeJobs.get(job.jobId);
            if (current === active) {
                this.activeJobs.delete(job.jobId);
                this.activeSourceBytes -= active.sourceSize || 0;
            }
            await this.refreshPriorityGate().catch(error => {
                console.error('❌ [PRIORITY GATE] Không thể làm mới trạng thái:', error.message);
            });
            if (!this.isHibernating && !this.isMaintenancePaused) void this.startWorker();
        }
    }

    async pumpWorker() {
        await this.recoverExpiredLeases();
        while (!this.isHibernating && !this.isMaintenancePaused && this.activeJobs.size < this.concurrency) {
            const job = await this.claimAdmissibleJob();
            if (!job) {
                await this.scheduleNextRetry();
                break;
            }

            const sourceSize = Number.isSafeInteger(job.sourceSize) && job.sourceSize > 0
                ? job.sourceSize
                : null;
            const active = {
                abortController: new AbortController(),
                sourceSize,
                priority: job.priority || 0,
            };
            this.activeJobs.set(job.jobId, active);
            if (active.priority === 1) {
                this.priorityDemandCache = { checkedAt: Date.now(), value: true };
                qualityGeminiLimiter.setPriorityGate(true);
            }
            this.activeSourceBytes += sourceSize || 0;
            void this.runActiveJob(job);
        }
    }

    async startWorker() {
        if (this.isHibernating || this.isMaintenancePaused) return;
        if (this.pumpPromise) {
            this.pumpRequested = true;
            return this.pumpPromise;
        }

        this.pumpPromise = (async () => {
            do {
                this.pumpRequested = false;
                try {
                    await this.pumpWorker();
                } catch (error) {
                    console.error('❌ [QUEUE] Worker pump gặp lỗi database/hạ tầng:', error.message);
                    setTimeout(() => void this.startWorker(), 5000);
                }
            } while (this.pumpRequested && !this.isHibernating);
        })();

        try {
            await this.pumpPromise;
        } finally {
            this.pumpPromise = null;
            if (this.pumpRequested && !this.isHibernating) {
                this.pumpRequested = false;
                queueMicrotask(() => void this.startWorker());
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
        const [rows, expiredRows] = await Promise.all([
            this.sourceCleanupService.sweepRetries(),
            this.sourceCleanupService.sweepExpiredFailedSources(),
        ]);
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
        return rows.length + expiredRows.length;
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
            this.activeJobs.get(jobId)?.abortController.abort();
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
