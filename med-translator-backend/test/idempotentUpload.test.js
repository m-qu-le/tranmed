import assert from 'node:assert/strict';
import test from 'node:test';
import Job from '../src/models/jobModel.js';
import { QueueManager } from '../src/services/queueManager.js';
import { ErrorCodes } from '../src/utils/processingError.js';

test('re-uploading a FILE_MISSING job reuses its job ID and schedules resume', async (context) => {
    const originalFindOne = Job.findOne;
    let saved = false;
    const existing = {
        jobId: 'stable-job-id',
        status: 'failed',
        errorCode: ErrorCodes.FILE_MISSING,
        attemptCount: 2,
        save: async () => { saved = true; }
    };
    Job.findOne = async () => existing;
    context.after(() => {
        Job.findOne = originalFindOne;
    });

    const queue = new QueueManager();
    queue.startWorker = async () => {};
    const result = await queue.addJob(
        { path: 'replacement.pdf', originalname: 'Chương 01 # tim.pdf' },
        'Sách tim mạch',
        'client-upload-id'
    );

    assert.equal(result.jobId, 'stable-job-id');
    assert.equal(existing.filePath, 'replacement.pdf');
    assert.equal(existing.status, 'pending');
    assert.equal(existing.attemptCount, 0);
    assert.equal(existing.errorCode, null);
    assert.equal(saved, true);
});
