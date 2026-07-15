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
    assert.equal(queue.isProcessing, false);
});
