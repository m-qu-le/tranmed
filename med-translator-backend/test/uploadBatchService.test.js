import assert from 'node:assert/strict';
import test from 'node:test';
import { UploadBatchService, validateUploadManifest } from '../src/services/uploadBatchService.js';

const config = {
    maxFiles: 500,
    maxFileSizeBytes: 350 * 1024 * 1024,
    maxBatchBytes: 2 * 1024 * 1024 * 1024,
    maxJobAttempts: 3,
    confirmConcurrency: 4,
};

function query(value) {
    return {
        sort() { return this; },
        limit() { return this; },
        lean: async () => value,
    };
}

test('manifest validation rejects duplicate IDs, non-PDF files and oversized batches', () => {
    const base = {
        clientBatchId: 'batch-client-1',
        files: [{ clientUploadId: 'file-1', name: 'valid.pdf', size: 10, type: 'application/pdf' }],
    };
    assert.equal(validateUploadManifest(base, config).totalBytes, 10);
    assert.throws(() => validateUploadManifest({
        ...base,
        files: [...base.files, { ...base.files[0] }],
    }, config), /bị trùng/);
    assert.throws(() => validateUploadManifest({
        ...base,
        files: [{ ...base.files[0], name: 'fake.txt' }],
    }, config), /\.pdf/);
    assert.throws(() => validateUploadManifest({
        ...base,
        files: [{ ...base.files[0], size: config.maxBatchBytes + 1 }],
    }, { ...config, maxFileSizeBytes: config.maxBatchBytes + 1 }), /vượt giới hạn/);
});

test('prepare creates 200 stable R2 jobs and repeated prepare reissues URLs without duplicates', async () => {
    let batch = null;
    let jobs = [];
    let insertCalls = 0;
    let presignCalls = 0;
    const UploadBatch = {
        findOne: () => query(batch),
        async create(row) {
            batch = { ...row, status: 'uploading', confirmedFiles: 0, confirmedBytes: 0, failedFiles: 0 };
            return { ...batch, toObject: () => ({ ...batch }) };
        },
        async deleteOne() {},
    };
    const Job = {
        find: filter => query(jobs.filter(job => job.uploadBatchId === filter.uploadBatchId)),
        async insertMany(rows) { insertCalls += 1; jobs = rows.map(row => ({ ...row })); },
        async deleteMany() { jobs = []; },
    };
    const service = new UploadBatchService({
        Job,
        UploadBatch,
        config,
        r2: {
            async createPresignedPut({ key, contentType }) {
                presignCalls += 1;
                assert.equal(contentType, 'application/pdf');
                return `https://signed.invalid/${encodeURIComponent(key)}`;
            },
        },
    });
    const manifest = {
        clientBatchId: 'client-batch-200',
        folderName: 'Nội tim mạch',
        files: Array.from({ length: 200 }, (_, index) => ({
            clientUploadId: `client-file-${index}`,
            name: `Tên trùng # %.pdf`,
            size: 1024 + index,
            type: 'application/pdf',
        })),
    };

    const first = await service.prepareBatch(manifest);
    const second = await service.prepareBatch(manifest);
    assert.equal(first.items.length, 200);
    assert.deepEqual(first.items.map(item => item.jobId), second.items.map(item => item.jobId));
    assert.equal(new Set(jobs.map(job => job.storageKey)).size, 200);
    assert.equal(jobs.every(job => /^incoming\/[A-Za-z0-9-]+\/[A-Za-z0-9-]+\.pdf$/.test(job.storageKey)), true);
    assert.equal(jobs.some(job => job.storageKey.includes('Tên trùng')), false);
    assert.equal(insertCalls, 1);
    assert.equal(presignCalls, 400);
});

test('confirm verifies size and ETag once, then remains idempotent', async () => {
    const batch = {
        batchId: 'batch-1', status: 'uploading', totalFiles: 2, totalBytes: 300,
        confirmedFiles: 0, confirmedBytes: 0, failedFiles: 0,
    };
    const jobs = [
        { jobId: 'job-1', uploadBatchId: 'batch-1', status: 'uploading', sourceState: 'prepared', storageKey: 'incoming/batch-1/job-1.pdf', sourceSize: 100 },
        { jobId: 'job-2', uploadBatchId: 'batch-1', status: 'uploading', sourceState: 'prepared', storageKey: 'incoming/batch-1/job-2.pdf', sourceSize: 200 },
    ];
    let headCalls = 0;
    const UploadBatch = {
        findOne: () => query(batch),
        async updateOne(filter, update) { Object.assign(batch, update.$set); },
    };
    const Job = {
        find(filter) {
            const selected = filter.jobId?.$in
                ? jobs.filter(job => filter.jobId.$in.includes(job.jobId))
                : jobs;
            return query(selected.map(job => ({ ...job })));
        },
        findOneAndUpdate(filter, update) {
            const job = jobs.find(row => row.jobId === filter.jobId && row.status === filter.status);
            if (job) Object.assign(job, update.$set);
            return query(job ? { ...job } : null);
        },
        async countDocuments(filter) {
            if (filter.uploadConfirmedAt) return jobs.filter(job => job.uploadConfirmedAt).length;
            if (filter.status === 'failed') return jobs.filter(job => job.status === 'failed').length;
            return jobs.length;
        },
        async aggregate(pipeline) {
            const group = pipeline[1].$group;
            if (group._id === null) {
                return [{ _id: null, total: jobs.filter(job => job.uploadConfirmedAt).reduce((sum, job) => sum + job.sourceSize, 0) }];
            }
            return [];
        },
    };
    const service = new UploadBatchService({
        Job,
        UploadBatch,
        config,
        r2: {
            async headObject(key) {
                headCalls += 1;
                const job = jobs.find(row => row.storageKey === key);
                return { contentLength: job.sourceSize, etag: `etag-${job.jobId}` };
            },
        },
    });

    const first = await service.confirmBatch('batch-1', ['job-1', 'job-2']);
    const second = await service.confirmBatch('batch-1', ['job-1', 'job-2']);
    assert.equal(first.canCloseClient, true);
    assert.equal(first.confirmedFiles, 2);
    assert.equal(first.confirmedBytes, 300);
    assert.equal(second.canCloseClient, true);
    assert.equal(headCalls, 2);
    assert.equal(jobs.every(job => job.status === 'pending' && job.sourceState === 'ready'), true);
});
