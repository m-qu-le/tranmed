import assert from 'node:assert/strict';
import test from 'node:test';
import Job from '../src/models/jobModel.js';
import UploadBatch from '../src/models/uploadBatchModel.js';
import { createIncomingStorageKey } from '../src/services/sourceKeyService.js';

test('legacy local jobs and prepared R2 jobs coexist in the additive schema', async () => {
    const legacy = new Job({
        jobId: 'legacy-job',
        originalName: 'Tim mạch.pdf',
        filePath: 'uploads/legacy.pdf',
        status: 'pending',
    });
    await legacy.validate();

    const r2 = new Job({
        jobId: 'r2-job',
        clientUploadId: 'client-file-1',
        originalName: 'Unicode # %.pdf',
        status: 'uploading',
        storageProvider: 'r2',
        storageKey: 'incoming/batch-1/r2-job.pdf',
        sourceSize: 1024,
        sourceState: 'prepared',
        uploadBatchId: 'batch-1',
    });
    await r2.validate();
});

test('pending R2 jobs require a confirmed ready source', async () => {
    const job = new Job({
        jobId: 'unconfirmed-r2-job',
        originalName: 'source.pdf',
        status: 'pending',
        storageProvider: 'r2',
        storageKey: 'incoming/batch-1/unconfirmed-r2-job.pdf',
        sourceState: 'prepared',
        uploadBatchId: 'batch-1',
    });
    await assert.rejects(job.validate(), /sourceState=ready/);
});

test('source deletion timestamp cannot be recorded before deletion succeeds', async () => {
    const job = new Job({
        jobId: 'cleanup-job',
        originalName: 'source.pdf',
        status: 'completed',
        storageProvider: 'r2',
        storageKey: 'incoming/batch-1/cleanup-job.pdf',
        sourceState: 'delete_pending',
        sourceDeletedAt: new Date(),
        uploadBatchId: 'batch-1',
    });
    await assert.rejects(job.validate(), /sourceDeletedAt chỉ được đặt/);
});

test('storage keys are independent from original filenames', () => {
    const first = createIncomingStorageKey('batch-1', 'job-1');
    const second = createIncomingStorageKey('batch-1', 'job-2');
    assert.equal(first, 'incoming/batch-1/job-1.pdf');
    assert.notEqual(first, second);
    assert.doesNotMatch(first, /Unicode|#|%/);
    assert.throws(() => createIncomingStorageKey('../batch', 'job-1'), /không hợp lệ/);
});

test('upload batch becomes close-safe only when every file is confirmed', async () => {
    const batch = new UploadBatch({
        batchId: 'batch-1',
        folderName: 'Tim mạch',
        status: 'ready',
        totalFiles: 2,
        totalBytes: 2048,
        confirmedFiles: 2,
        confirmedBytes: 2048,
    });
    await batch.validate();
    assert.equal(batch.canCloseClient, true);

    batch.confirmedFiles = 1;
    await assert.rejects(batch.validate(), /xác nhận đủ/);
});

test('job schema declares unique idempotency and storage indexes', () => {
    const indexes = Job.schema.indexes();
    const findIndex = key => indexes.find(([fields]) => JSON.stringify(fields) === JSON.stringify(key));
    assert.equal(findIndex({ clientUploadId: 1 })[1].unique, true);
    assert.equal(findIndex({ storageKey: 1 })[1].unique, true);
    assert.ok(findIndex({ uploadBatchId: 1, createdAt: 1 }));
    assert.ok(findIndex({ status: 1, sourceState: 1, createdAt: 1 }));
});
