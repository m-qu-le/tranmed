import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { UploadBatchService, validateUploadManifest } from '../src/services/uploadBatchService.js';
import { appEvents } from '../src/services/appEvents.js';

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
    assert.throws(() => validateUploadManifest({ ...base, priority: 'true' }, config), /priority/);
    assert.throws(() => validateUploadManifest({ ...base, folderName: 'Ưu tiên' }, config), /chỉ dùng cho hàng đợi ưu tiên/);

    const priorityManifest = validateUploadManifest({ ...base, folderName: 'Bất kỳ', priority: true }, config);
    assert.equal(priorityManifest.priority, true);
    assert.equal(priorityManifest.folderName, 'Ưu tiên');
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

    const batchEvent = once(appEvents, 'batchUpdated');
    const first = await service.prepareBatch(manifest);
    const second = await service.prepareBatch(manifest);
    assert.equal(first.items.length, 200);
    assert.deepEqual(first.items.map(item => item.jobId), second.items.map(item => item.jobId));
    assert.equal(new Set(jobs.map(job => job.storageKey)).size, 200);
    assert.equal(jobs.every(job => /^incoming\/[A-Za-z0-9-]+\/[A-Za-z0-9-]+\.pdf$/.test(job.storageKey)), true);
    assert.equal(jobs.some(job => job.storageKey.includes('Tên trùng')), false);
    assert.equal(insertCalls, 1);
    assert.equal(presignCalls, 400);
    assert.equal((await batchEvent)[0].totalFiles, 200);
});

test('priority manifest persists its priority and reserved output group across prepare retries', async () => {
    let batch = null;
    let jobs = [];
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
        async insertMany(rows) { jobs = rows.map(row => ({ ...row })); },
        async deleteMany() { jobs = []; },
    };
    const service = new UploadBatchService({
        Job,
        UploadBatch,
        config,
        r2: { async createPresignedPut() { return 'https://signed.invalid/priority'; } },
    });
    const manifest = {
        clientBatchId: 'priority-client-batch',
        folderName: 'Tên người dùng không được dùng',
        priority: true,
        files: [{ clientUploadId: 'priority-file', name: 'priority.pdf', size: 42, type: 'application/pdf' }],
    };

    await service.prepareBatch(manifest);
    await service.prepareBatch(manifest);

    assert.equal(batch.priority, 1);
    assert.equal(batch.folderName, 'Ưu tiên');
    assert.deepEqual(jobs.map(job => ({ priority: job.priority, folderName: job.folderName })), [
        { priority: 1, folderName: 'Ưu tiên' },
    ]);
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
            if (filter.status === 'cancelled') return jobs.filter(job => job.status === 'cancelled').length;
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

test('abandon marks only unconfirmed items skipped after R2 deletion and makes the remainder close-safe', async () => {
    const batch = { batchId: 'batch-skip', totalFiles: 2, totalBytes: 300, status: 'uploading' };
    const jobs = [
        { jobId: 'confirmed', uploadBatchId: 'batch-skip', status: 'pending', sourceSize: 100, uploadConfirmedAt: new Date() },
        { jobId: 'skip', uploadBatchId: 'batch-skip', status: 'uploading', storageKey: 'incoming/batch-skip/skip.pdf', sourceSize: 200 },
    ];
    const deleted = [];
    const UploadBatch = {
        findOne: () => query(batch),
        async updateOne(filter, update) { Object.assign(batch, update.$set); },
    };
    const Job = {
        find: filter => query(jobs.filter(job => filter.jobId.$in.includes(job.jobId) && job.status === filter.status)),
        async updateOne(filter, update) {
            const job = jobs.find(row => row.jobId === filter.jobId);
            Object.assign(job, update.$set);
        },
        async countDocuments(filter) {
            if (filter.uploadConfirmedAt) return jobs.filter(job => job.uploadConfirmedAt).length;
            return jobs.filter(job => job.status === filter.status).length;
        },
        async aggregate() { return [{ _id: null, total: 100 }]; },
    };
    const service = new UploadBatchService({
        Job, UploadBatch, config,
        r2: { async deleteObject(key) { deleted.push(key); } },
    });

    const result = await service.abandonItems('batch-skip', ['skip']);
    assert.deepEqual(deleted, ['incoming/batch-skip/skip.pdf']);
    assert.equal(jobs[1].status, 'cancelled');
    assert.equal(jobs[1].sourceState, 'deleted');
    assert.ok(jobs[1].sourceDeletedAt instanceof Date);
    assert.equal(result.skippedFiles, 1);
    assert.equal(result.canCloseClient, true);
});

test('stale uploading jobs expire through the same abandon cleanup path', async () => {
    const staleJobs = [
        { jobId: 'stale-1', uploadBatchId: 'batch-stale' },
        { jobId: 'stale-2', uploadBatchId: 'batch-stale' },
    ];
    const service = new UploadBatchService({
        Job: { find: () => query(staleJobs) },
        UploadBatch: {},
        r2: {},
        config,
    });
    const calls = [];
    service.abandonItems = async (batchId, jobIds) => { calls.push({ batchId, jobIds }); };
    const expired = await service.expireStaleUploads();
    assert.equal(expired, 2);
    assert.deepEqual(calls, [{ batchId: 'batch-stale', jobIds: ['stale-1', 'stale-2'] }]);
});
