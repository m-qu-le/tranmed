import { ErrorCodes, ProcessingError } from '../utils/processingError.js';
import {
    getNextQualityAction,
    isTerminalQualityStage,
    QUALITY_PIPELINE_VERSION,
    QUALITY_PROMPT_VERSION,
    shouldResetForVersion,
    transitionForAction,
    versionResetUpdate,
} from './qualityPipelineState.js';

function plain(value) {
    return value?.toObject ? value.toObject() : value;
}

function assertNotCancelled(signal) {
    if (signal?.aborted) {
        throw new ProcessingError(ErrorCodes.CANCELLED, 'Tác vụ đã được hủy giữa quality stage.');
    }
}

const INVALID_CONTENT_CODES = new Set([
    ErrorCodes.GEMINI_BLOCKED,
    ErrorCodes.GEMINI_OUTPUT_TRUNCATED,
    ErrorCodes.GEMINI_RESPONSE_INVALID,
    ErrorCodes.GEMINI_SCHEMA_INVALID,
]);

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
        if (transition.unset?.length) {
            update.$unset = Object.fromEntries(transition.unset.map(field => [field, 1]));
        }
        const updated = plain(await this.ChunkModel.findOneAndUpdate(
            {
                jobId: chunk.jobId,
                chunkIndex: chunk.chunkIndex,
                pipelineVersion: this.pipelineVersion,
                stage: chunk.stage,
            },
            update,
            { returnDocument: 'after' }
        ));
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
            onStage = async () => {},
        } = options;
        let chunk = await this.prepareChunk({ jobId, chunkIndex, pageStart, pageEnd, totalPages });
        if (chunk.content && (!chunk.stage || isTerminalQualityStage(chunk.stage))) return chunk;

        while (!isTerminalQualityStage(chunk.stage)) {
            assertNotCancelled(signal);
            await assertActive();
            const action = getNextQualityAction(chunk);
            const executor = this.executors[action];
            let result = {};
            if (action !== 'complete_needs_review') {
                if (!executor) throw new Error(`Thiếu executor cho quality action: ${action}`);
                await onStage({ phase: 'started', action, chunk });
                try {
                    result = await executor({ pdfBuffer, chunk, documentContext: options.documentContext || null, signal });
                } catch (error) {
                    if (action !== 'repair' || !INVALID_CONTENT_CODES.has(error?.code)) throw error;
                    result = { invalid: true, metadata: error.geminiMetadata || null };
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
