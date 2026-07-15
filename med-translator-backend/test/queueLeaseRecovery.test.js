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
