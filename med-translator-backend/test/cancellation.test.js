import assert from 'node:assert/strict';
import test from 'node:test';
import Job from '../src/models/jobModel.js';
import TranslationChunk from '../src/models/translationChunkModel.js';
import { QueueManager } from '../src/services/queueManager.js';
import { ErrorCodes, ProcessingError } from '../src/utils/processingError.js';

test('cancelling a processing job marks it and aborts the active request', async (context) => {
    const originalFindOne = Job.findOne;
    const originalUpdateOne = Job.updateOne;
    const updates = [];

    Job.findOne = () => ({
        lean: async () => ({ jobId: 'active-job', status: 'processing', filePath: 'active.pdf' })
    });
    Job.updateOne = async (filter, update) => {
        updates.push({ filter, update });
        return { matchedCount: 1 };
    };
    context.after(() => {
        Job.findOne = originalFindOne;
        Job.updateOne = originalUpdateOne;
    });

    const queue = new QueueManager();
    queue.currentJobId = 'active-job';
    queue.currentAbortController = new AbortController();

    const result = await queue.cancelAndDeleteJob('active-job');

    assert.deepEqual(result, { found: true, pending: true });
    assert.equal(updates[0].update.$set.cancelRequested, true);
    assert.equal(queue.currentAbortController.signal.aborted, true);
});

test('a cancellation request wins over a simultaneous retryable failure', async (context) => {
    const originalExists = Job.exists;
    const originalUpdateOne = Job.updateOne;
    const originalDeleteOne = Job.deleteOne;
    const originalDeleteMany = TranslationChunk.deleteMany;
    const updates = [];

    Job.exists = async () => ({ _id: 'cancelled-job' });
    Job.updateOne = async (filter, update) => {
        updates.push({ filter, update });
        return { matchedCount: 1 };
    };
    Job.deleteOne = async () => ({ deletedCount: 1 });
    TranslationChunk.deleteMany = async () => ({ deletedCount: 2 });
    context.after(() => {
        Job.exists = originalExists;
        Job.updateOne = originalUpdateOne;
        Job.deleteOne = originalDeleteOne;
        TranslationChunk.deleteMany = originalDeleteMany;
    });

    const queue = new QueueManager();
    queue.safeUnlink = async () => {};
    await queue.handleProcessingFailure(
        {
            jobId: 'cancelled-job',
            filePath: 'active.pdf',
            processingToken: 'token',
            attemptCount: 1,
            maxAttempts: 3
        },
        new ProcessingError(ErrorCodes.GEMINI_UNAVAILABLE, 'temporary', { retryable: true })
    );

    assert.equal(updates.length, 0, 'cancelled job must not be returned to pending');
});

test('cancelling a pending job transitions it atomically before cleanup', async (context) => {
    const originalFindOne = Job.findOne;
    const originalFindOneAndUpdate = Job.findOneAndUpdate;
    let claimFilter;

    Job.findOne = () => ({
        lean: async () => ({ jobId: 'pending-job', status: 'pending', filePath: 'pending.pdf' })
    });
    Job.findOneAndUpdate = async (filter, update) => {
        claimFilter = filter;
        assert.equal(update.$set.status, 'cancelled');
        return { jobId: 'pending-job', filePath: 'pending.pdf' };
    };
    context.after(() => {
        Job.findOne = originalFindOne;
        Job.findOneAndUpdate = originalFindOneAndUpdate;
    });

    const queue = new QueueManager();
    let cleaned = null;
    queue.cleanupJob = async (jobId, filePath) => {
        cleaned = { jobId, filePath };
    };

    const result = await queue.cancelAndDeleteJob('pending-job');

    assert.deepEqual(claimFilter, { jobId: 'pending-job', status: 'pending' });
    assert.deepEqual(cleaned, { jobId: 'pending-job', filePath: 'pending.pdf' });
    assert.deepEqual(result, { found: true, pending: false });
});
