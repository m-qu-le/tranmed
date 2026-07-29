import {
    QUALITY_STAGE_CONTENT_FAILURE_LIMIT,
    QUALITY_CONTENT_ERROR_CODES,
} from '../services/qualityStageFailurePolicy.js';
import { CONTENT_MAX_ATTEMPTS } from '../services/jobFailurePolicy.js';

const CONTENT_ERROR_CODES = [...QUALITY_CONTENT_ERROR_CODES];
const NON_TERMINAL_STAGES = { $nin: ['completed', 'needs_review'] };

const ACTION_PLANS = Object.freeze([
    { stage: 'pending', action: 'translate' },
    { stage: 'translated', action: 'medical_audit' },
    { stage: 'audited', action: 'revise' },
    { stage: 'revised', action: 'verify' },
    { stage: 'repaired', action: 'reverify' },
]);

function stuckChunkFilter(extra = {}) {
    return {
        pipelineMode: 'quality',
        stage: NON_TERMINAL_STAGES,
        lastStageErrorCode: { $in: CONTENT_ERROR_CODES },
        ...extra,
    };
}

async function addMissingStageFailureField(TranslationChunk, dryRun) {
    const filter = {
        pipelineMode: 'quality',
        stage: NON_TERMINAL_STAGES,
        stageContentFailures: { $exists: false },
    };
    const matched = await TranslationChunk.countDocuments(filter);
    if (!dryRun && matched > 0) {
        await TranslationChunk.updateMany(filter, { $set: { stageContentFailures: {} } });
    }
    return matched;
}

async function seedAction(TranslationChunk, action, filter, dryRun) {
    const completeFilter = {
        ...stuckChunkFilter(filter),
        [`stageContentFailures.${action}`]: { $exists: false },
    };
    const matched = await TranslationChunk.countDocuments(completeFilter);
    if (!dryRun && matched > 0) {
        await TranslationChunk.updateMany(
            completeFilter,
            { $set: { [`stageContentFailures.${action}`]: QUALITY_STAGE_CONTENT_FAILURE_LIMIT - 1 } }
        );
    }
    return matched;
}

export async function runQualityContentFailureMigration({
    Job,
    TranslationChunk,
    dryRun = true,
    now = new Date(),
}) {
    const processingJobs = await Job.countDocuments({ status: 'processing' });
    if (!dryRun && processingJobs > 0) {
        throw new Error(
            `Không thể migrate khi còn ${processingJobs} job processing; hãy tạm dừng queue và chờ worker về 0.`
        );
    }

    const chunks = {
        stageContentFailures: await addMissingStageFailureField(TranslationChunk, dryRun),
        seededByAction: {},
    };

    for (const plan of ACTION_PLANS) {
        chunks.seededByAction[plan.action] = await seedAction(
            TranslationChunk,
            plan.action,
            { stage: plan.stage },
            dryRun
        );
    }
    for (const repairCount of [0, 1]) {
        const action = `repair_${repairCount + 1}`;
        chunks.seededByAction[action] = await seedAction(
            TranslationChunk,
            action,
            { stage: 'verified', repairCount },
            dryRun
        );
    }

    const stuckJobIds = typeof TranslationChunk.distinct === 'function'
        ? await TranslationChunk.distinct('jobId', stuckChunkFilter())
        : [];
    const qualityJobFilter = {
        jobId: { $in: stuckJobIds },
        translationMode: 'quality',
        status: 'pending',
        errorCode: { $in: CONTENT_ERROR_CODES },
        schedulerDeferred: { $ne: true },
    };
    const deferredJobs = await Job.countDocuments(qualityJobFilter);
    if (!dryRun && deferredJobs > 0) {
        await Job.updateMany(
            qualityJobFilter,
            {
                $set: {
                    schedulerDeferred: true,
                    maxAttempts: CONTENT_MAX_ATTEMPTS,
                    nextRetryAt: now,
                },
            }
        );
    }

    const maxAttemptFilter = {
        translationMode: 'quality',
        status: { $nin: ['completed', 'deleted'] },
        maxAttempts: { $ne: CONTENT_MAX_ATTEMPTS },
    };
    const qualityJobsWithStaleLimit = await Job.countDocuments(maxAttemptFilter);
    if (!dryRun && qualityJobsWithStaleLimit > 0) {
        await Job.updateMany(maxAttemptFilter, { $set: { maxAttempts: CONTENT_MAX_ATTEMPTS } });
    }

    return {
        dryRun,
        contentFailureLimit: QUALITY_STAGE_CONTENT_FAILURE_LIMIT,
        contentAttemptLimit: CONTENT_MAX_ATTEMPTS,
        chunks,
        jobs: {
            processingJobs,
            stuckJobIds: stuckJobIds.length,
            deferredJobs,
            qualityJobsWithStaleLimit,
        },
    };
}
