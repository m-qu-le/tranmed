import assert from 'node:assert/strict';
import test from 'node:test';
import Job from '../src/models/jobModel.js';
import System from '../src/models/systemModel.js';
import { QueueManager } from '../src/services/queueManager.js';
import { ErrorCodes, ProcessingError } from '../src/utils/processingError.js';

test('claimNextJob relies on one atomic pending-to-processing update', async (context) => {
    const originalFindOneAndUpdate = Job.findOneAndUpdate;
    let pendingJobAvailable = true;
    let claims = 0;

    Job.findOneAndUpdate = async (filter, update, options) => {
        assert.equal(filter.status, 'pending');
        const r2SourceGate = filter.$and[1].$or[1];
        assert.equal(r2SourceGate.storageProvider, 'r2');
        assert.equal(r2SourceGate.sourceState, 'ready');
        assert.deepEqual(r2SourceGate.storageKey, { $type: 'string' });
        assert.equal(update.$set.status, 'processing');
        assert.equal(options.returnDocument, 'after');
        assert.deepEqual(options.sort, { priority: -1, createdAt: 1, _id: 1 });
        if (!pendingJobAvailable) return null;
        pendingJobAvailable = false;
        claims += 1;
        return { jobId: 'job-1', processingToken: update.$set.processingToken };
    };

    context.after(() => {
        Job.findOneAndUpdate = originalFindOneAndUpdate;
    });

    const queue = new QueueManager();
    const results = await Promise.all(Array.from({ length: 20 }, () => queue.claimNextJob()));

    assert.equal(claims, 1);
    assert.equal(results.filter(Boolean).length, 1);
});

test('priority jobs sort before normal jobs in both peek and atomic claim', async (context) => {
    const originalFindOne = Job.findOne;
    const originalFindOneAndUpdate = Job.findOneAndUpdate;
    let peekSort;
    Job.findOne = () => ({
        sort(sort) { peekSort = sort; return this; },
        lean: async () => ({ _id: 'priority-candidate', sourceSize: 1 }),
    });
    Job.findOneAndUpdate = async (_filter, _update, options) => ({ jobId: 'priority-job', options });
    context.after(() => {
        Job.findOne = originalFindOne;
        Job.findOneAndUpdate = originalFindOneAndUpdate;
    });

    const queue = new QueueManager();
    await queue.peekNextJob();
    const claimed = await queue.claimNextJob();

    assert.deepEqual(peekSort, { priority: -1, createdAt: 1, _id: 1 });
    assert.deepEqual(claimed.options.sort, { priority: -1, createdAt: 1, _id: 1 });
});

test('priority work remains pending while hibernating and is claimed after wake-up', async (context) => {
    const originalFindOneAndUpdate = System.findOneAndUpdate;
    System.findOneAndUpdate = async () => null;
    context.after(() => { System.findOneAndUpdate = originalFindOneAndUpdate; });

    const queue = new QueueManager({ concurrency: 1 });
    const claimed = [];
    let priorityPending = true;
    queue.isHibernating = true;
    queue.recoverExpiredLeases = async () => 0;
    queue.scheduleNextRetry = async () => {};
    queue.createLeaseHeartbeat = () => null;
    queue.claimAdmissibleJob = async () => {
        if (!priorityPending) return null;
        priorityPending = false;
        claimed.push('priority-job');
        return { jobId: 'priority-job', sourceSize: 1, processingToken: 'priority-token', attemptCount: 1, maxAttempts: 3 };
    };
    queue.processClaimedJob = async () => {};

    await queue.startWorker();
    assert.deepEqual(claimed, []);

    await queue.wakeUp();
    assert.deepEqual(claimed, ['priority-job']);
});

test('candidate claim keeps the peeked ID in the atomic update filter', async (context) => {
    const originalFindOneAndUpdate = Job.findOneAndUpdate;
    Job.findOneAndUpdate = async (filter, update) => {
        assert.equal(String(filter._id), 'candidate-id');
        return { jobId: 'candidate-job', processingToken: update.$set.processingToken };
    };
    context.after(() => { Job.findOneAndUpdate = originalFindOneAndUpdate; });

    const claimed = await new QueueManager().claimNextJob('candidate-id');
    assert.equal(claimed.jobId, 'candidate-job');
});

test('scheduler suspension persists pending state without retry or attempt amplification', async context => {
    const originalUpdateOne = Job.updateOne;
    const originalFindOneAndUpdate = Job.findOneAndUpdate;
    let suspensionUpdate;
    Job.updateOne = async (_filter, update) => {
        suspensionUpdate = update;
        return { modifiedCount: 1 };
    };
    let claimUpdate;
    Job.findOneAndUpdate = async (_filter, update) => {
        claimUpdate = update;
        return { jobId: 'normal-job', attemptCount: 2 };
    };
    context.after(() => {
        Job.updateOne = originalUpdateOne;
        Job.findOneAndUpdate = originalFindOneAndUpdate;
    });

    const queue = new QueueManager();
    await queue.handleProcessingFailure(
        { jobId: 'normal-job', processingToken: 'token', attemptCount: 2 },
        new ProcessingError(ErrorCodes.SCHEDULER_SUSPENDED, 'yield to priority')
    );
    assert.equal(suspensionUpdate.$set.status, 'pending');
    assert.equal(suspensionUpdate.$set.schedulerSuspended, true);
    assert.equal(suspensionUpdate.$inc, undefined);

    await queue.claimNextJob('normal-id', {
        resumeSuspended: true,
        processingStartedAt: new Date(),
    });
    assert.equal(claimUpdate.$inc, undefined);
    assert.equal(claimUpdate.$set.schedulerSuspended, false);
});

test('quota-deferred resume does not increment job attempt or retry counters', async context => {
    const originalUpdateOne = Job.updateOne;
    const originalFindOneAndUpdate = Job.findOneAndUpdate;
    let deferUpdate;
    let claimFilter;
    let claimUpdate;
    Job.updateOne = async (_filter, update) => {
        deferUpdate = update;
        return { modifiedCount: 1 };
    };
    Job.findOneAndUpdate = async (filter, update) => {
        claimFilter = filter;
        claimUpdate = update;
        return { jobId: 'deferred-job', attemptCount: 4 };
    };
    context.after(() => {
        Job.updateOne = originalUpdateOne;
        Job.findOneAndUpdate = originalFindOneAndUpdate;
    });

    const queue = new QueueManager();
    const deferred = new ProcessingError(
        ErrorCodes.STAGE_DEFERRED,
        'release source cache',
        { retryable: true, poolExhausted: true }
    );
    deferred.nextAvailableAt = new Date(Date.now() + 60_000);
    await queue.handleProcessingFailure(
        { jobId: 'deferred-job', processingToken: 'token', attemptCount: 4 },
        deferred
    );
    assert.equal(deferUpdate.$set.schedulerDeferred, true);
    assert.equal(deferUpdate.$inc, undefined);

    await queue.claimNextJob('deferred-id', {
        resumeDeferred: true,
        processingStartedAt: new Date(),
    });
    assert.equal(claimFilter.schedulerDeferred, true);
    assert.equal(claimUpdate.$inc, undefined);
    assert.equal(claimUpdate.$set.schedulerDeferred, false);
});

test('an idle worker stops after one empty claim instead of polling in a microtask loop', async () => {
    const queue = new QueueManager();
    let claims = 0;
    let schedules = 0;

    queue.recoverExpiredLeases = async () => 0;
    queue.claimAdmissibleJob = async () => {
        claims += 1;
        return null;
    };
    queue.scheduleNextRetry = async () => {
        schedules += 1;
    };

    await queue.startWorker();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(claims, 1);
    assert.equal(schedules, 1);
    assert.equal(queue.pumpPromise, null);
    assert.equal(queue.activeJobs.size, 0);
});
