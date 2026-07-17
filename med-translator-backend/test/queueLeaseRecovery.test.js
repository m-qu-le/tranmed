import assert from 'node:assert/strict';
import test from 'node:test';
import Job from '../src/models/jobModel.js';
import { QueueManager } from '../src/services/queueManager.js';

test('expired leases are atomically returned to pending with the old processing token removed', async context => {
    const originalFind = Job.find;
    const originalUpdateMany = Job.updateMany;
    let capturedFilter;
    let capturedUpdate;
    Job.find = () => ({ lean: async () => [] });
    Job.updateMany = async (filter, update) => {
        capturedFilter = filter;
        capturedUpdate = update;
        return { modifiedCount: 2 };
    };
    context.after(() => {
        Job.find = originalFind;
        Job.updateMany = originalUpdateMany;
    });

    const recovered = await new QueueManager().recoverExpiredLeases();
    assert.equal(recovered, 2);
    assert.equal(capturedFilter.status, 'processing');
    assert.deepEqual(capturedFilter.cancelRequested, { $ne: true });
    assert.equal(capturedFilter.leaseExpiresAt.$lte instanceof Date, true);
    assert.equal(capturedUpdate.$set.status, 'pending');
    assert.equal(capturedUpdate.$set.processingToken, null);
    assert.equal(capturedUpdate.$set.leaseExpiresAt, null);
    assert.equal(capturedUpdate.$set.nextRetryAt instanceof Date, true);
});

test('lease heartbeat extends only the active processing token by five minutes', async context => {
    const originalUpdateOne = Job.updateOne;
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    let heartbeatCallback;
    let heartbeatDelay;
    let capturedFilter;
    let capturedUpdate;

    global.setInterval = (callback, delay) => {
        heartbeatCallback = callback;
        heartbeatDelay = delay;
        return 123;
    };
    global.clearInterval = () => {};
    Job.updateOne = async (filter, update) => {
        capturedFilter = filter;
        capturedUpdate = update;
        return { matchedCount: 1 };
    };
    context.after(() => {
        Job.updateOne = originalUpdateOne;
        global.setInterval = originalSetInterval;
        global.clearInterval = originalClearInterval;
    });

    const before = Date.now();
    const timer = new QueueManager().createLeaseHeartbeat('job-heartbeat', 'token-current');
    assert.equal(timer, 123);
    assert.equal(heartbeatDelay, 60_000);
    heartbeatCallback();
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(capturedFilter, {
        jobId: 'job-heartbeat',
        status: 'processing',
        processingToken: 'token-current',
    });
    const extensionMs = capturedUpdate.$set.leaseExpiresAt.getTime() - before;
    assert.ok(extensionMs >= 300_000 && extensionMs < 301_000);
});

test('two active jobs keep independent lease heartbeat filters', async context => {
    const originalUpdateOne = Job.updateOne;
    const originalSetInterval = global.setInterval;
    const callbacks = [];
    const filters = [];
    global.setInterval = callback => {
        callbacks.push(callback);
        return callbacks.length;
    };
    Job.updateOne = async filter => {
        filters.push(filter);
        return { matchedCount: 1 };
    };
    context.after(() => {
        Job.updateOne = originalUpdateOne;
        global.setInterval = originalSetInterval;
    });

    const queue = new QueueManager({ concurrency: 2 });
    queue.createLeaseHeartbeat('job-a', 'token-a');
    queue.createLeaseHeartbeat('job-b', 'token-b');
    callbacks.forEach(callback => callback());
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(filters, [
        { jobId: 'job-a', status: 'processing', processingToken: 'token-a' },
        { jobId: 'job-b', status: 'processing', processingToken: 'token-b' },
    ]);
});
