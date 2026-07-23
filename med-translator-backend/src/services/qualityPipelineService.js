import { ErrorCodes, ProcessingError } from '../utils/processingError.js';
import {
    getNextQualityAction,
    isTerminalQualityStage,
    QUALITY_PIPELINE_VERSION,
    QUALITY_PROMPT_VERSION,
    qualityStageAttemptKey,
    shouldResetForVersion,
    transitionForAction,
    versionResetUpdate,
} from './qualityPipelineState.js';
import { operationalMetrics } from './operationalMetrics.js';

function plain(value) {
    return value?.toObject ? value.toObject() : value;
}

function assertNotCancelled(signal) {
    if (signal?.aborted) {
        throw new ProcessingError(ErrorCodes.CANCELLED, 'Tác vụ đã được hủy giữa quality stage.');
    }
}

async function observeMongo(operation) {
    const startedAt = performance.now();
    try {
        return await operation();
    } finally {
        operationalMetrics.observe('mongodb.operation.latency', performance.now() - startedAt);
    }
}

const INVALID_CONTENT_CODES = new Set([
    ErrorCodes.GEMINI_BLOCKED,
    ErrorCodes.GEMINI_OUTPUT_TRUNCATED,
    ErrorCodes.GEMINI_RESPONSE_INVALID,
    ErrorCodes.GEMINI_SCHEMA_INVALID,
]);
const MAX_INLINE_STAGE_RETRY_WAIT_MS = 65_000;

async function waitForPersistedStageRetry(nextAvailableAt, signal, assertCanStartStage) {
    const target = new Date(nextAvailableAt).getTime();
    while (Date.now() < target) {
        assertNotCancelled(signal);
        await assertCanStartStage();
        const delay = Math.min(500, Math.max(1, target - Date.now()));
        await new Promise((resolve, reject) => {
            const done = () => {
                signal?.removeEventListener('abort', onAbort);
                resolve();
            };
            const timer = setTimeout(done, delay);
            const onAbort = () => {
                clearTimeout(timer);
                reject(new ProcessingError(ErrorCodes.CANCELLED, 'Đã hủy khi chờ stage retry.'));
            };
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }
}

export class QualityPipelineService {
    constructor({ ChunkModel, executors, pipelineVersion = QUALITY_PIPELINE_VERSION }) {
        this.ChunkModel = ChunkModel;
        this.executors = executors;
        this.pipelineVersion = pipelineVersion;
    }

    async prepareChunk({ jobId, chunkIndex, pageStart, pageEnd, totalPages }) {
        let chunk = plain(await this.ChunkModel.findOne({ jobId, chunkIndex }));
        if (chunk?.content && (!chunk.stage || isTerminalQualityStage(chunk.stage))) return chunk;

        if (shouldResetForVersion(chunk, this.pipelineVersion)) {
            const reset = plain(await this.ChunkModel.findOneAndUpdate(
                { jobId, chunkIndex, pipelineVersion: chunk.pipelineVersion },
                versionResetUpdate(this.pipelineVersion),
                { returnDocument: 'after' }
            ));
            chunk = reset || plain(await this.ChunkModel.findOne({ jobId, chunkIndex }));
        }

        if (!chunk) {
            chunk = plain(await this.ChunkModel.findOneAndUpdate(
                { jobId, chunkIndex },
                {
                    $setOnInsert: {
                        jobId,
                        chunkIndex,
                        pipelineVersion: this.pipelineVersion,
                        pipelineMode: 'quality',
                        promptVersion: QUALITY_PROMPT_VERSION,
                        pageStart,
                        pageEnd,
                        totalPages,
                        stage: 'pending',
                        qualityStatus: 'pending',
                        repairCount: 0,
                        usageByStage: {},
                        stageAttempts: {},
                        physicalAttemptCount: 0,
                        stageUpdatedAt: new Date(),
                    },
                },
                { upsert: true, returnDocument: 'after' }
            ));
        } else if (!chunk.pipelineVersion) {
            const initialized = plain(await this.ChunkModel.findOneAndUpdate(
                { jobId, chunkIndex, pipelineVersion: null, content: null },
                {
                    $set: {
                        pipelineVersion: this.pipelineVersion,
                        pipelineMode: 'quality',
                        promptVersion: QUALITY_PROMPT_VERSION,
                        pageStart,
                        pageEnd,
                        totalPages,
                        stage: 'pending',
                        qualityStatus: 'pending',
                        repairCount: 0,
                        usageByStage: {},
                        stageAttempts: {},
                        physicalAttemptCount: 0,
                        stageUpdatedAt: new Date(),
                    },
                },
                { returnDocument: 'after' }
            ));
            chunk = initialized || plain(await this.ChunkModel.findOne({ jobId, chunkIndex }));
        }

        if (!chunk) {
            throw new ProcessingError(
                ErrorCodes.DATABASE_UNAVAILABLE,
                'Không thể khởi tạo quality chunk.',
                { retryable: true }
            );
        }
        return chunk;
    }

    async persistTransition(chunk, action, result) {
        const transition = transitionForAction(action, result, chunk);
        const update = { $set: { ...transition.set, stage: transition.nextStage } };
        const scheduler = result?.metadata?.scheduler;
        if (Number.isSafeInteger(scheduler?.projectIndex)) {
            update.$set.lastProjectIndex = scheduler.projectIndex;
        }
        update.$set.lastStageErrorCode = null;
        update.$set.nextStageRetryAt = null;
        if (Number.isSafeInteger(scheduler?.physicalAttempts) && scheduler.physicalAttempts > 0) {
            update.$inc = { physicalAttemptCount: scheduler.physicalAttempts };
        }
        if (transition.unset?.length) {
            update.$unset = Object.fromEntries(transition.unset.map(field => [field, 1]));
        }
        const updated = plain(await observeMongo(() => this.ChunkModel.findOneAndUpdate(
            {
                jobId: chunk.jobId,
                chunkIndex: chunk.chunkIndex,
                pipelineVersion: this.pipelineVersion,
                stage: chunk.stage,
            },
            update,
            { returnDocument: 'after' }
        )));
        if (updated) return updated;

        const current = plain(await this.ChunkModel.findOne({ jobId: chunk.jobId, chunkIndex: chunk.chunkIndex }));
        if (current && current.pipelineVersion === this.pipelineVersion && current.stage !== chunk.stage) {
            return current;
        }
        throw new ProcessingError(
            ErrorCodes.DATABASE_UNAVAILABLE,
            `Không thể persist transition ${chunk.stage} → ${transition.nextStage}.`,
            { retryable: true }
        );
    }

    async markStageAttempt(chunk, action) {
        const attemptKey = qualityStageAttemptKey(action, chunk);
        const updated = plain(await observeMongo(() => this.ChunkModel.findOneAndUpdate(
            {
                jobId: chunk.jobId,
                chunkIndex: chunk.chunkIndex,
                pipelineVersion: this.pipelineVersion,
                stage: chunk.stage,
            },
            {
                $inc: { [`stageAttempts.${attemptKey}`]: 1 },
                $set: {
                    lastStageErrorCode: null,
                    nextStageRetryAt: null,
                    stageUpdatedAt: new Date(),
                },
            },
            { returnDocument: 'after' }
        )));
        if (updated) return updated;
        throw new ProcessingError(
            ErrorCodes.DATABASE_UNAVAILABLE,
            `Không thể persist attempt cho stage ${action}.`,
            { retryable: true }
        );
    }

    async recordStageFailure(chunk, error) {
        const scheduler = error?.schedulerMetadata || {};
        const set = {
            lastStageErrorCode: error?.code || ErrorCodes.UNKNOWN_PROCESSING_ERROR,
            nextStageRetryAt: error?.nextAvailableAt || null,
            stageUpdatedAt: new Date(),
        };
        if (Number.isSafeInteger(scheduler.projectIndex)) {
            set.lastProjectIndex = scheduler.projectIndex;
        }
        const update = { $set: set };
        if (Number.isSafeInteger(scheduler.physicalAttempts) && scheduler.physicalAttempts > 0) {
            update.$inc = { physicalAttemptCount: scheduler.physicalAttempts };
        }
        await observeMongo(() => this.ChunkModel.updateOne(
            {
                jobId: chunk.jobId,
                chunkIndex: chunk.chunkIndex,
                pipelineVersion: this.pipelineVersion,
                stage: chunk.stage,
            },
            update
        ));
    }

    async rollbackUnissuedStageAttempt(chunk, action) {
        const attemptKey = qualityStageAttemptKey(action, chunk);
        await observeMongo(() => this.ChunkModel.updateOne(
            {
                jobId: chunk.jobId,
                chunkIndex: chunk.chunkIndex,
                pipelineVersion: this.pipelineVersion,
                stage: chunk.stage,
                [`stageAttempts.${attemptKey}`]: { $gt: 0 },
            },
            {
                $inc: { [`stageAttempts.${attemptKey}`]: -1 },
                $set: {
                    lastStageErrorCode: null,
                    nextStageRetryAt: null,
                    stageUpdatedAt: new Date(),
                },
            }
        ));
    }

    async runChunk(options) {
        const {
            jobId,
            chunkIndex,
            pageStart,
            pageEnd,
            totalPages,
            pdfBuffer,
            signal,
            assertActive = async () => {},
            assertCanStartStage = assertActive,
            onStage = async () => {},
        } = options;
        let chunk = await this.prepareChunk({ jobId, chunkIndex, pageStart, pageEnd, totalPages });
        if (chunk.content && (!chunk.stage || isTerminalQualityStage(chunk.stage))) return chunk;

        while (!isTerminalQualityStage(chunk.stage)) {
            assertNotCancelled(signal);
            await assertCanStartStage();
            const action = getNextQualityAction(chunk);
            const executor = this.executors[action];
            let result = {};
            if (action !== 'complete_needs_review') {
                if (!executor) throw new Error(`Thiếu executor cho quality action: ${action}`);
                chunk = await this.markStageAttempt(chunk, action);
                await onStage({ phase: 'started', action, chunk });
                try {
                    result = await executor({ pdfBuffer, chunk, documentContext: options.documentContext || null, signal });
                } catch (error) {
                    if (error?.code === ErrorCodes.SCHEDULER_SUSPENDED
                        && Number(error?.schedulerMetadata?.physicalAttempts || 0) === 0) {
                        await this.rollbackUnissuedStageAttempt(chunk, action);
                        throw error;
                    }
                    if (action !== 'repair' || !INVALID_CONTENT_CODES.has(error?.code)) {
                        await this.recordStageFailure(chunk, error);
                        const retryAt = error?.nextAvailableAt
                            ? new Date(error.nextAvailableAt).getTime()
                            : NaN;
                        if (error?.poolExhausted
                            && Number.isFinite(retryAt)
                            && retryAt > Date.now()
                            && retryAt - Date.now() <= MAX_INLINE_STAGE_RETRY_WAIT_MS) {
                            await waitForPersistedStageRetry(
                                error.nextAvailableAt,
                                signal,
                                assertCanStartStage
                            );
                            continue;
                        }
                        throw error;
                    }
                    result = {
                        invalid: true,
                        errorCode: error.code,
                        metadata: {
                            ...(error.geminiMetadata || {}),
                            scheduler: error.schedulerMetadata || {},
                        },
                    };
                }
                assertNotCancelled(signal);
                await assertActive();
            }
            chunk = await this.persistTransition(chunk, action, result);
            await onStage({ phase: 'completed', action, chunk });
        }
        return chunk;
    }
}
