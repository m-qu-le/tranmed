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
    const activeController = new AbortController();
    const otherController = new AbortController();
    queue.activeJobs.set('active-job', { abortController: activeController, sourceSize: 100 });
    queue.activeJobs.set('other-job', { abortController: otherController, sourceSize: 100 });

    const result = await queue.cancelAndDeleteJob('active-job');

    assert.deepEqual(result, { found: true, pending: true });
    assert.equal(updates[0].update.$set.cancelRequested, true);
    assert.equal(activeController.signal.aborted, true);
    assert.equal(otherController.signal.aborted, false);
});

test('a cancellation request wins over a simultaneous retryable failure', async (context) => {
    const originalExists = Job.exists;

    Job.exists = async () => ({ _id: 'cancelled-job' });
    context.after(() => {
        Job.exists = originalExists;
    });

    const queue = new QueueManager();
    let cleanedJobId = null;
    queue.cleanupJob = async jobId => {
        cleanedJobId = jobId;
        return { deleted: true, cleanupPending: false };
    };
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

    assert.equal(cleanedJobId, 'cancelled-job', 'cancelled job must be cleaned instead of returned to pending');
});

test('a stale worker that lost its lease never deletes the current attempt', async (context) => {
    const originalExists = Job.exists;
    const originalUpdateOne = Job.updateOne;
    const updates = [];

    Job.exists = async filter => {
        if (filter.cancelRequested === true) return null;
        return null;
    };
    Job.updateOne = async (filter, update) => {
        updates.push({ filter, update });
        return { matchedCount: 1 };
    };
    context.after(() => {
        Job.exists = originalExists;
        Job.updateOne = originalUpdateOne;
    });

    const queue = new QueueManager();
    let cleanupCalled = false;
    queue.cleanupJob = async () => {
        cleanupCalled = true;
        return { deleted: true, cleanupPending: false };
    };

    await queue.handleProcessingFailure(
        {
            jobId: 'new-attempt-owned-elsewhere',
            filePath: 'active.pdf',
            processingToken: 'stale-token',
            attemptCount: 1,
            maxAttempts: 3,
        },
        new ProcessingError(ErrorCodes.OWNERSHIP_LOST, 'stale worker')
    );

    assert.equal(cleanupCalled, false);
    assert.deepEqual(updates, []);
});

test('inactive ownership is distinct from an explicit user cancellation', async (context) => {
    const originalExists = Job.exists;
    Job.exists = async filter => filter.cancelRequested === true ? null : null;
    context.after(() => { Job.exists = originalExists; });

    const queue = new QueueManager();
    await assert.rejects(
        queue.assertJobActive({ jobId: 'stale-job', processingToken: 'old-token' }),
        error => error?.code === ErrorCodes.OWNERSHIP_LOST
    );
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
        assert.equal(update.$set.statusBeforeDeletion, 'pending');
        assert.equal(update.$set.translatedBeforeDeletion, false);
        assert.ok(update.$set.deletionRequestedAt instanceof Date);
        return {
            jobId: 'pending-job',
            filePath: 'pending.pdf',
            status: 'cancelled',
            statusBeforeDeletion: 'pending',
            deletionRequestedAt: update.$set.deletionRequestedAt,
        };
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

test('cleanup preserves a durable tombstone proving whether translation completed before deletion', async (context) => {
    const originalUpdateOne = Job.updateOne;
    const originalCountDocuments = TranslationChunk.countDocuments;
    const originalDeleteMany = TranslationChunk.deleteMany;
    const updates = [];

    Job.updateOne = async (filter, update) => {
        updates.push({ filter, update });
        return { matchedCount: 1 };
    };
    TranslationChunk.countDocuments = async () => 4;
    TranslationChunk.deleteMany = async () => ({ deletedCount: 4 });
    context.after(() => {
        Job.updateOne = originalUpdateOne;
        TranslationChunk.countDocuments = originalCountDocuments;
        TranslationChunk.deleteMany = originalDeleteMany;
    });

    const completedAt = new Date('2026-07-25T06:00:00.000Z');
    const queue = new QueueManager({
        sourceCleanupService: {
            cleanupSource: async () => ({
                cleaned: true,
                alreadyDeleted: true,
                deletedAt: new Date('2026-07-25T06:01:00.000Z'),
            }),
        },
    });
    queue.safeUnlink = async () => {};

    const result = await queue.cleanupJob('completed-job', {
        jobId: 'completed-job',
        originalName: '18 Blood.pdf',
        status: 'completed',
        completedAt,
        completedChunks: 4,
        storageProvider: 'r2',
        storageKey: 'incoming/batch/completed-job.pdf',
        sourceState: 'deleted',
    });

    assert.deepEqual(result, { deleted: true, cleanupPending: false });
    const tombstone = updates.at(-1).update.$set;
    assert.equal(tombstone.status, 'deleted');
    assert.equal(tombstone.statusBeforeDeletion, 'completed');
    assert.equal(tombstone.translatedBeforeDeletion, true);
    assert.equal(tombstone.deletedChunkCount, 4);
    assert.ok(tombstone.deletionRequestedAt instanceof Date);
    assert.ok(tombstone.deletedAt instanceof Date);
});
