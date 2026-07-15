import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPublicJobUpdate, buildPublicQualitySummary } from '../src/services/qualityPublicView.js';

test('legacy jobs do not gain synthetic quality metadata', () => {
    assert.equal(buildPublicQualitySummary({
        translationMode: 'legacy',
        translationPipelineVersion: 'p003-v1',
    }), null);
    assert.deepEqual(buildPublicJobUpdate({ jobId: 'legacy', status: 'processing' }), {
        type: 'status',
        jobId: 'legacy',
        status: 'processing',
        error: undefined,
        errorCode: undefined,
        attemptCount: undefined,
        maxAttempts: undefined,
        nextRetryAt: undefined,
        completedChunks: undefined,
        chunkCount: undefined,
    });
});

test('quality public view exposes progress and page ranges but no internal artifacts', () => {
    const source = {
        jobId: 'quality',
        status: 'processing',
        translationMode: 'quality',
        translationPipelineVersion: 'p003-v1',
        currentQualityStage: 'verify',
        passedChunks: 3,
        needsReviewChunks: 1,
        qualityWarnings: [{ chunkIndex: 4, pageStart: 9, pageEnd: 10, audit: 'private' }],
        qualityStagePhase: 'completed',
        chunkIndex: 4,
        pageStart: 9,
        pageEnd: 10,
        draftContent: 'private',
    };
    const payload = buildPublicJobUpdate(source);
    assert.deepEqual(payload.quality, {
        mode: 'quality',
        pipelineVersion: 'p003-v1',
        currentStage: 'verify',
        passedChunks: 3,
        needsReviewChunks: 1,
        warnings: [{ chunkIndex: 4, pageStart: 9, pageEnd: 10 }],
    });
    assert.equal(payload.currentQualityStage, 'verify');
    assert.equal(payload.qualityStagePhase, 'completed');
    assert.equal(payload.pageStart, 9);
    assert.equal('draftContent' in payload, false);
    assert.equal('audit' in payload.quality.warnings[0], false);
});

test('unknown stages and malformed warnings are not published', () => {
    assert.deepEqual(buildPublicQualitySummary({
        translationMode: 'quality',
        currentQualityStage: 'internal_future_stage',
        qualityWarnings: [{ chunkIndex: 'x' }, null],
    }), {
        mode: 'quality',
        pipelineVersion: null,
        currentStage: null,
        passedChunks: 0,
        needsReviewChunks: 0,
        warnings: [],
    });
});
