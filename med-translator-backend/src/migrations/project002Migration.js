export const LEGACY_SOURCE_FILTER = {
    filePath: { $type: 'string' },
    $or: [
        { storageProvider: { $exists: false } },
        { storageProvider: null },
    ],
};

export async function runProject002Migration({ Job, UploadBatch, dryRun = true }) {
    const [totalJobs, legacyCandidates, r2Jobs, uploadBatches] = await Promise.all([
        Job.countDocuments({}),
        Job.countDocuments(LEGACY_SOURCE_FILTER),
        Job.countDocuments({ storageProvider: 'r2' }),
        UploadBatch.countDocuments({}),
    ]);

    const report = { totalJobs, legacyCandidates, r2Jobs, uploadBatches };
    if (dryRun) return { dryRun: true, report, modifiedCount: 0, indexesEnsured: false };

    const update = await Job.updateMany(
        LEGACY_SOURCE_FILTER,
        { $set: { storageProvider: 'local', sourceState: 'ready' } }
    );
    await Promise.all([Job.syncIndexes(), UploadBatch.syncIndexes()]);

    return {
        dryRun: false,
        report,
        modifiedCount: update.modifiedCount,
        indexesEnsured: true,
    };
}
