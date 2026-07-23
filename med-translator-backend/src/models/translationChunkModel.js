import mongoose from 'mongoose';
import { QUALITY_STAGES, QUALITY_STATUSES } from '../services/qualityPipelineState.js';

const qualityReviewReasonSchema = new mongoose.Schema({
    kind: { type: String, enum: ['repair_output_invalid'], required: true },
    stage: { type: String, enum: ['repair'], required: true },
    errorCode: {
        type: String,
        enum: [
            'GEMINI_OUTPUT_TRUNCATED',
            'GEMINI_BLOCKED',
            'GEMINI_RESPONSE_INVALID',
            'GEMINI_SCHEMA_INVALID',
        ],
        required: true,
    },
    occurredAt: { type: Date, required: true },
}, { _id: false });

const translationChunkSchema = new mongoose.Schema({
    jobId: { type: String, required: true },
    chunkIndex: { type: Number, required: true, min: 0 },
    content: { type: String, default: null },
    pipelineVersion: { type: String, default: null },
    pipelineMode: { type: String, enum: ['legacy', 'quality'], default: null },
    promptVersion: { type: String, default: null },
    pageStart: { type: Number, min: 1, default: null },
    pageEnd: { type: Number, min: 1, default: null },
    totalPages: { type: Number, min: 1, default: null },
    stage: { type: String, enum: QUALITY_STAGES, default: null },
    draftContent: { type: String, default: null },
    auditReport: { type: mongoose.Schema.Types.Mixed, default: null },
    revisedContent: { type: String, default: null },
    verificationReport: { type: mongoose.Schema.Types.Mixed, default: null },
    repairedContent: { type: String, default: null },
    reverifyReport: { type: mongoose.Schema.Types.Mixed, default: null },
    repairCount: { type: Number, min: 0, max: 2, default: 0 },
    qualityStatus: { type: String, enum: QUALITY_STATUSES, default: null },
    qualityReviewReason: { type: qualityReviewReasonSchema, default: null },
    usageByStage: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    stageAttempts: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    physicalAttemptCount: { type: Number, min: 0, default: 0 },
    nextStageRetryAt: { type: Date, default: null },
    lastStageErrorCode: { type: String, default: null },
    lastProjectIndex: { type: Number, min: 0, default: null },
    stageUpdatedAt: { type: Date, default: null },
}, { timestamps: true });

translationChunkSchema.index({ jobId: 1, chunkIndex: 1 }, { unique: true });
translationChunkSchema.index({ jobId: 1, qualityStatus: 1, chunkIndex: 1 });
translationChunkSchema.index({ nextStageRetryAt: 1, jobId: 1, chunkIndex: 1 });

export default mongoose.model('TranslationChunk', translationChunkSchema);
