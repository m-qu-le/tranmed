export async function runProject003Migration({ Job, TranslationChunk, dryRun = true }) {
    const [
        totalJobs,
        versionedJobs,
        totalChunks,
        legacyFinalChunks,
        qualityChunks,
        incompleteQualityChunks,
    ] = await Promise.all([
        Job.countDocuments({}),
        Job.countDocuments({ translationPipelineVersion: { $type: 'string' } }),
        TranslationChunk.countDocuments({}),
        TranslationChunk.countDocuments({ content: { $type: 'string' }, pipelineVersion: null }),
        TranslationChunk.countDocuments({ pipelineMode: 'quality' }),
        TranslationChunk.countDocuments({
            pipelineMode: 'quality',
            stage: { $nin: ['completed', 'needs_review'] },
        }),
    ]);

    const report = {
        totalJobs,
        versionedJobs,
        totalChunks,
        legacyFinalChunks,
        qualityChunks,
        incompleteQualityChunks,
    };
    if (dryRun) return { dryRun: true, report, modifiedCount: 0, indexesEnsured: false };

    await Promise.all([Job.syncIndexes(), TranslationChunk.syncIndexes()]);
    return { dryRun: false, report, modifiedCount: 0, indexesEnsured: true };
}
