import assert from 'node:assert/strict';
import test from 'node:test';
import Job from '../src/models/jobModel.js';
import { getActiveJobs } from '../src/controllers/translateController.js';
import { QueueManager, translationQueue } from '../src/services/queueManager.js';

function response() {
    return {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
}

test('active jobs query is capped, ordered, and returns only dashboard-safe fields', async context => {
    const originalFind = Job.find;
    const calls = {};
    Job.find = (filter, fields) => {
        calls.filter = filter;
        calls.fields = fields;
        return {
            sort(value) { calls.sort = value; return this; },
            limit(value) { calls.limit = value; return this; },
            async lean() {
                return [{
                    jobId: 'active-1',
                    originalName: 'chapter-1.pdf',
                    folderName: 'Cardiology',
                    priority: 1,
                    processingStartedAt: new Date('2026-08-11T03:00:00.000Z'),
                    chunkCount: 8,
                    completedChunks: 3,
                    passedChunks: 2,
                    currentQualityStage: 'translate',
                    translationMode: 'quality',
                    processingToken: 'must-not-leak',
                    error: 'must-not-leak',
                }];
            },
        };
    };
    context.after(() => { Job.find = originalFind; });

    const items = await new QueueManager().getActiveJobs();

    assert.deepEqual(calls.filter, { status: 'processing' });
    assert.deepEqual(calls.sort, { processingStartedAt: 1, _id: 1 });
    assert.equal(calls.limit, 3);
    assert.match(calls.fields, /originalName/);
    assert.doesNotMatch(calls.fields, /processingToken|error/);
    assert.deepEqual(items, [{
        jobId: 'active-1',
        originalName: 'chapter-1.pdf',
        folderName: 'Cardiology',
        priority: true,
        processingStartedAt: new Date('2026-08-11T03:00:00.000Z'),
        chunkCount: 8,
        completedChunks: 3,
        passedChunks: 2,
        currentQualityStage: 'translate',
        translationMode: 'quality',
    }]);
});

test('active jobs controller wraps the safe list and hides internal errors', async context => {
    const originalGetActiveJobs = translationQueue.getActiveJobs;
    context.after(() => { translationQueue.getActiveJobs = originalGetActiveJobs; });

    translationQueue.getActiveJobs = async () => [{ jobId: 'active-1', originalName: 'chapter-1.pdf' }];
    const ok = response();
    await getActiveJobs({}, ok);
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.body, { items: [{ jobId: 'active-1', originalName: 'chapter-1.pdf' }] });

    translationQueue.getActiveJobs = async () => { throw new Error('mongodb://user:secret@example.invalid'); };
    const failure = response();
    await getActiveJobs({}, failure);
    assert.equal(failure.statusCode, 500);
    assert.deepEqual(failure.body, { error: 'Không thể đọc các file đang dịch.' });
});
