const PUBLIC_QUALITY_STAGES = new Set([
    'document_context',
    'translate',
    'medical_audit',
    'revise',
    'verify',
    'repair',
    'reverify',
]);

function numberOrZero(value) {
    return Number.isFinite(value) && value >= 0 ? value : 0;
}

function publicWarning(warning) {
    if (!warning || !Number.isInteger(warning.chunkIndex)) return null;
    return {
        chunkIndex: warning.chunkIndex,
        pageStart: Number.isInteger(warning.pageStart) ? warning.pageStart : null,
        pageEnd: Number.isInteger(warning.pageEnd) ? warning.pageEnd : null,
    };
}

export function hasQualityPipeline(job) {
    if (job?.translationMode) return job.translationMode === 'quality';
    return Boolean(
        job?.currentQualityStage
        || job?.passedChunks > 0
        || job?.needsReviewChunks > 0
        || job?.qualityWarnings?.length
    );
}

export function buildPublicQualitySummary(job) {
    if (!hasQualityPipeline(job)) return null;
    const warnings = Array.isArray(job.qualityWarnings)
        ? job.qualityWarnings.map(publicWarning).filter(Boolean)
        : [];
    return {
        mode: job.translationMode || 'quality',
        pipelineVersion: job.translationPipelineVersion || null,
        currentStage: PUBLIC_QUALITY_STAGES.has(job.currentQualityStage)
            ? job.currentQualityStage
            : null,
        passedChunks: numberOrZero(job.passedChunks),
        needsReviewChunks: numberOrZero(job.needsReviewChunks),
        warnings,
        contextReady: Boolean(job?.qualityContextVersion && job?.qualityContextGeneratedAt),
    };
}

export function buildPublicJobUpdate(job) {
    const payload = {
        type: 'status',
        jobId: job.jobId,
        status: job.status,
        error: job.error,
        errorCode: job.errorCode,
        attemptCount: job.attemptCount,
        maxAttempts: job.maxAttempts,
        nextRetryAt: job.nextRetryAt,
        completedChunks: job.completedChunks,
        chunkCount: job.chunkCount,
    };
    const quality = buildPublicQualitySummary(job);
    if (!quality) return payload;
    return {
        ...payload,
        translationMode: quality.mode,
        translationPipelineVersion: quality.pipelineVersion,
        currentQualityStage: quality.currentStage,
        qualityStagePhase: ['started', 'completed'].includes(job.qualityStagePhase)
            ? job.qualityStagePhase
            : null,
        chunkIndex: Number.isInteger(job.chunkIndex) ? job.chunkIndex : null,
        pageStart: Number.isInteger(job.pageStart) ? job.pageStart : null,
        pageEnd: Number.isInteger(job.pageEnd) ? job.pageEnd : null,
        passedChunks: quality.passedChunks,
        needsReviewChunks: quality.needsReviewChunks,
        qualityWarnings: quality.warnings,
        quality,
    };
}
