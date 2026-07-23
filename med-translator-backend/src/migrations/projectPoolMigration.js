export const PROJECT_POOL_EXECUTION_VERSION = 'project-pool-v1';

async function addMissingField(Model, field, value, dryRun) {
    const filter = { [field]: { $exists: false } };
    const matched = await Model.countDocuments(filter);
    if (!dryRun && matched > 0) {
        await Model.updateMany(filter, { $set: { [field]: value } });
    }
    return matched;
}

export async function runProjectPoolMigration({
    Job,
    TranslationChunk,
    GeminiQuotaState,
    projectIds = [],
    dryRun = true,
}) {
    const duplicateIds = projectIds.length - new Set(projectIds).size;
    if (duplicateIds > 0) throw new Error('Không thể migrate quota state với project ID trùng.');

    const jobs = {};
    for (const [field, value] of Object.entries({
        schedulerSuspended: false,
        schedulerExecutionVersion: PROJECT_POOL_EXECUTION_VERSION,
        processingStartedAt: null,
        completedAt: null,
    })) {
        jobs[field] = await addMissingField(Job, field, value, dryRun);
    }
    jobs.priorityFolder = await Job.countDocuments({
        folderName: 'Ưu tiên',
        priority: { $ne: 1 },
    });
    if (!dryRun && jobs.priorityFolder > 0) {
        await Job.updateMany(
            { folderName: 'Ưu tiên', priority: { $ne: 1 } },
            { $set: { priority: 1 } }
        );
    }

    const chunks = {};
    for (const [field, value] of Object.entries({
        stageAttempts: {},
        physicalAttemptCount: 0,
        nextStageRetryAt: null,
        lastStageErrorCode: null,
        lastProjectIndex: null,
    })) {
        chunks[field] = await addMissingField(TranslationChunk, field, value, dryRun);
    }

    const existingQuotaRows = projectIds.length
        ? await GeminiQuotaState.countDocuments({ projectId: { $in: projectIds } })
        : 0;
    if (!dryRun && projectIds.length > 0) {
        await GeminiQuotaState.bulkWrite(projectIds.map(projectId => ({
            updateOne: {
                filter: { projectId },
                update: {
                    $setOnInsert: {
                        projectId,
                        requestEvents: [],
                        quotaDay: null,
                        dailyNormalCount: 0,
                        dailyRetryCount: 0,
                        cooldownUntil: null,
                        disabled: false,
                        hasSucceeded: false,
                        lastSuccessAt: null,
                        lastReservedAt: null,
                    },
                },
                upsert: true,
            },
        })), { ordered: false });
        await Promise.all([
            Job.createIndexes(),
            TranslationChunk.createIndexes(),
            GeminiQuotaState.createIndexes(),
        ]);
    }

    return {
        dryRun,
        executionVersion: PROJECT_POOL_EXECUTION_VERSION,
        jobs,
        chunks,
        quotaRowsToCreate: Math.max(0, projectIds.length - existingQuotaRows),
        configuredProjects: projectIds.length,
    };
}
