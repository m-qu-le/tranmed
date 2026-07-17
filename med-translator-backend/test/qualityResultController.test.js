import assert from 'node:assert/strict';
import test from 'node:test';
import TranslationChunk from '../src/models/translationChunkModel.js';
import { getJobResult, downloadJobResult } from '../src/controllers/translateController.js';
import { translationQueue } from '../src/services/queueManager.js';

function response() {
    return {
        statusCode: 200,
        headers: {},
        body: '',
        jsonBody: null,
        status(code) { this.statusCode = code; return this; },
        json(value) { this.jsonBody = value; return this; },
        setHeader(name, value) { this.headers[name] = value; },
        write(value) { this.body += value; return true; },
        end(value = '') { this.body += value; this.ended = true; return this; },
    };
}

function query(rows) {
    return {
        sort() { return this; },
        async lean() { return structuredClone(rows); },
        cursor() {
            return {
                async *[Symbol.asyncIterator]() {
                    for (const row of rows) yield structuredClone(row);
                },
            };
        },
    };
}

const report = {
    status: 'FAIL',
    errors: [{
        category: 'terminology',
        severity: 'major',
        sourceExcerpt: 'source term',
        targetExcerpt: 'target term',
        requiredCorrection: 'correct term',
        explanation: 'wrong term',
    }],
    coverage: {
        status: 'COMPLETE',
        items: Array.from({ length: 4 }, (_, index) => ({
            focus: 'terminology',
            sourceExcerpt: `source ${index}`,
            targetExcerpt: `target ${index}`,
            result: 'match',
        })),
    },
};

test('result JSON and streamed download use the exact same generated quality header', async context => {
    const originalGetJobResult = translationQueue.getJobResult;
    const originalFind = TranslationChunk.find;
    context.after(() => {
        translationQueue.getJobResult = originalGetJobResult;
        TranslationChunk.find = originalFind;
    });

    const job = {
        jobId: 'quality-controller',
        originalName: 'quality.pdf',
        status: 'completed',
        translationMode: 'quality',
        translationPipelineVersion: 'p003-v3',
        chunkCount: 2,
        passedChunks: 1,
        needsReviewChunks: 1,
        qualityWarnings: [{ chunkIndex: 1, pageStart: 2, pageEnd: 2 }],
        result: null,
    };
    const contentRows = [
        { chunkIndex: 0, content: '# Phần một' },
        { chunkIndex: 1, content: '# Phần hai' },
    ];
    const reviewRows = [{
        ...contentRows[1],
        pageStart: 2,
        pageEnd: 2,
        repairCount: 1,
        qualityStatus: 'needs_review',
        verificationReport: report,
    }];
    translationQueue.getJobResult = async () => job;
    TranslationChunk.find = filter => query(filter.qualityStatus === 'needs_review' ? reviewRows : contentRows);

    const apiResponse = response();
    await getJobResult({ params: { jobId: job.jobId } }, apiResponse);
    const repeatedApiResponse = response();
    await getJobResult({ params: { jobId: job.jobId } }, repeatedApiResponse);
    const downloadResponse = response();
    await downloadJobResult({ params: { jobId: job.jobId } }, downloadResponse);

    assert.equal(apiResponse.statusCode, 200);
    assert.equal(apiResponse.jsonBody.result, downloadResponse.body);
    assert.equal(repeatedApiResponse.jsonBody.result, apiResponse.jsonBody.result);
    assert.equal(downloadResponse.headers['Content-Type'], 'text/markdown; charset=utf-8');
    assert.equal(downloadResponse.body.match(/# ⚠️ Lưu ý kiểm soát chất lượng/g).length, 1);
    assert.match(downloadResponse.body, /# Nội dung bản dịch\n\n# Phần một\n\n# Phần hai$/);
    assert.equal(job.result, null);
    assert.equal(reviewRows[0].content, '# Phần hai');
});

test('legacy stored results are returned byte-for-byte without querying review reports', async context => {
    const originalGetJobResult = translationQueue.getJobResult;
    const originalFind = TranslationChunk.find;
    context.after(() => {
        translationQueue.getJobResult = originalGetJobResult;
        TranslationChunk.find = originalFind;
    });

    const legacyResult = '# Legacy\n\nKhông đổi.';
    translationQueue.getJobResult = async () => ({
        jobId: 'legacy-controller',
        originalName: 'legacy.pdf',
        status: 'completed',
        translationMode: 'legacy',
        result: legacyResult,
    });
    TranslationChunk.find = () => { throw new Error('legacy must not query quality chunks'); };

    const apiResponse = response();
    await getJobResult({ params: { jobId: 'legacy-controller' } }, apiResponse);
    const downloadResponse = response();
    await downloadJobResult({ params: { jobId: 'legacy-controller' } }, downloadResponse);

    assert.equal(apiResponse.jsonBody.result, legacyResult);
    assert.equal(downloadResponse.body, legacyResult);
});
