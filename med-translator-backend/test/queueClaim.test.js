import assert from 'node:assert/strict';
import test from 'node:test';
import Job from '../src/models/jobModel.js';
import { QueueManager } from '../src/services/queueManager.js';

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

test('an idle worker stops after one empty claim instead of polling in a microtask loop', async () => {
    const queue = new QueueManager();
    let claims = 0;
    let schedules = 0;

    queue.recoverExpiredLeases = async () => 0;
    queue.claimNextJob = async () => {
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
