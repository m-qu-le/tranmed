import { ErrorCodes } from '../utils/processingError.js';
import { PROJECT_POOL_EXECUTION_VERSION } from '../services/geminiKeyScheduler.js';

export async function runQuotaDeadTimeMigration({
    Job,
    TranslationChunk,
    dryRun = true,
    now = new Date(),
}) {
    const migrationNow = new Date(now);
    const jobFilter = {
        status: 'pending',
        errorCode: ErrorCodes.GEMINI_RATE_LIMIT,
        nextRetryAt: { $gt: migrationNow },
        cancelRequested: { $ne: true },
    };
    const jobIds = await Job.distinct('jobId', jobFilter);
    const chunkFilter = {
        jobId: { $in: jobIds },
        lastStageErrorCode: ErrorCodes.GEMINI_RATE_LIMIT,
    };
    const chunkCount = jobIds.length > 0
        ? await TranslationChunk.countDocuments(chunkFilter)
        : 0;

    if (!dryRun && jobIds.length > 0) {
        await TranslationChunk.updateMany(
            chunkFilter,
            {
                $set: {
                    nextStageRetryAt: null,
                    deferredUntil: null,
                    deferredReason: null,
                    lastStageErrorCode: null,
                    schedulerExecutionVersion: PROJECT_POOL_EXECUTION_VERSION,
                },
            }
        );
        await Job.updateMany(
            { ...jobFilter, jobId: { $in: jobIds } },
            {
                $set: {
                    nextRetryAt: migrationNow,
                    error: null,
                    errorCode: null,
                    failureCategory: null,
                    schedulerSuspended: false,
                    schedulerDeferred: true,
                    schedulerExecutionVersion: PROJECT_POOL_EXECUTION_VERSION,
                    processingToken: null,
                    leaseExpiresAt: null,
                },
            }
        );
    }

    return {
        dryRun,
        executionVersion: PROJECT_POOL_EXECUTION_VERSION,
        jobsToRequeue: jobIds.length,
        chunksToClear: chunkCount,
        appliedAt: migrationNow,
    };
}
