import assert from 'node:assert/strict';
import test from 'node:test';
import Job from '../src/models/jobModel.js';
import { QueueManager } from '../src/services/queueManager.js';
import { getJobStats } from '../src/controllers/translateController.js';

test('job stats aggregate the four dashboard states and fill missing states with zero', async (context) => {
    const originalAggregate = Job.aggregate;
    let pipeline;
    let aggregateCalls = 0;
    Job.aggregate = async value => {
        pipeline = value;
        aggregateCalls += 1;
        if (aggregateCalls === 2) return [];
        return [
            { _id: 'pending', count: 473 },
            { _id: 'completed', count: 32 },
        ];
    };
    context.after(() => { Job.aggregate = originalAggregate; });

    const stats = await new QueueManager().getJobStats();

    assert.deepEqual(stats, { pending: 473, processing: 0, completed: 32, failed: 0 });
    assert.deepEqual(pipeline, [
        { $match: { status: { $in: ['pending', 'processing', 'completed', 'failed'] } } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    assert.deepEqual(await new QueueManager().getJobStats(), {
        pending: 0, processing: 0, completed: 0, failed: 0,
    });
});

test('job stats controller returns a short public error when MongoDB fails', async (context) => {
    const queue = (await import('../src/services/queueManager.js')).translationQueue;
    const originalGetJobStats = queue.getJobStats;
    queue.getJobStats = async () => { throw new Error('mongodb://user:secret@example.invalid'); };
    context.after(() => { queue.getJobStats = originalGetJobStats; });
    const response = {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };

    await getJobStats({}, response);

    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.body, { error: 'Không thể đọc thống kê công việc.' });
});
