import assert from 'node:assert/strict';
import test from 'node:test';
import Job from '../src/models/jobModel.js';
import UploadBatch from '../src/models/uploadBatchModel.js';
import { QueueManager } from '../src/services/queueManager.js';
import { getJobStats } from '../src/controllers/translateController.js';

test('job stats aggregate global statuses, folders, and cloud uploads', async (context) => {
    const originalAggregate = Job.aggregate;
    const originalUploadAggregate = UploadBatch.aggregate;
    let pipeline;
    Job.aggregate = async value => {
        pipeline = value;
        return [{
            statuses: [{ _id: 'pending', count: 473 }, { _id: 'completed', count: 32 }],
            folders: [{ _id: 'Harrison', count: 500 }],
        }];
    };
    UploadBatch.aggregate = async () => [{
        uploadingBatches: 0,
        uploadedBytes: 0,
        uploadTotalBytes: 0,
        confirmedFiles: 100,
        totalFiles: 100,
        safeFiles: 100,
    }];
    context.after(() => {
        Job.aggregate = originalAggregate;
        UploadBatch.aggregate = originalUploadAggregate;
    });

    const stats = await new QueueManager().getJobStats();

    assert.deepEqual(stats, {
        pending: 473, processing: 0, completed: 32, failed: 0,
        folders: [{ name: 'Harrison', count: 500 }],
        cloud: {
            uploadingBatches: 0, uploadedBytes: 0, totalBytes: 0,
            confirmedFiles: 100, totalFiles: 100, safeFiles: 100,
        },
    });
    assert.ok(pipeline[0].$facet.statuses);
    assert.ok(pipeline[0].$facet.folders);
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
