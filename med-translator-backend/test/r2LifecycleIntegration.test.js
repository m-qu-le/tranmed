import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UploadBatchService } from '../src/services/uploadBatchService.js';
import { SourceService } from '../src/services/sourceService.js';
import { SourceCleanupService } from '../src/services/sourceCleanupService.js';

function query(value) {
    return { sort() { return this; }, limit() { return this; }, lean: async () => value };
}

function createFixture() {
    const jobs = [];
    const batches = [];
    const objects = new Map();
    const Job = {
        find(filter) {
            let rows = jobs.filter(job => !filter.uploadBatchId || job.uploadBatchId === filter.uploadBatchId);
            if (filter.jobId?.$in) rows = rows.filter(job => filter.jobId.$in.includes(job.jobId));
            return query(rows.map(job => ({ ...job })));
        },
        async insertMany(rows) { jobs.push(...rows.map(row => ({ ...row }))); },
        async deleteMany(filter) {
            for (let index = jobs.length - 1; index >= 0; index -= 1) {
                if (jobs[index].uploadBatchId === filter.uploadBatchId) jobs.splice(index, 1);
            }
        },
        findOneAndUpdate(filter, update) {
            const job = jobs.find(row => row.jobId === filter.jobId && row.status === filter.status);
            if (job) Object.assign(job, update.$set);
            return query(job ? { ...job } : null);
        },
        async updateOne(filter, update) {
            const job = jobs.find(row => row.jobId === filter.jobId);
            if (!job) return;
            if (update.$set) Object.assign(job, update.$set);
            if (update.$inc) {
                for (const [key, amount] of Object.entries(update.$inc)) job[key] = (job[key] || 0) + amount;
            }
        },
        async countDocuments(filter) {
            return jobs.filter(job => {
                if (filter.uploadBatchId && job.uploadBatchId !== filter.uploadBatchId) return false;
                if (filter.uploadConfirmedAt && !job.uploadConfirmedAt) return false;
                if (typeof filter.status === 'string' && job.status !== filter.status) return false;
                return true;
            }).length;
        },
        async aggregate(pipeline) {
            const batchId = pipeline[0].$match.uploadBatchId;
            const total = jobs
                .filter(job => job.uploadBatchId === batchId && job.uploadConfirmedAt)
                .reduce((sum, job) => sum + job.sourceSize, 0);
            return total ? [{ _id: null, total }] : [];
        },
    };
    const UploadBatch = {
        findOne(filter) {
            const batch = batches.find(row => Object.entries(filter).every(([key, value]) => row[key] === value));
            return query(batch ? { ...batch } : null);
        },
        async create(row) {
            const batch = {
                ...row, status: 'uploading', confirmedFiles: 0, confirmedBytes: 0,
                failedFiles: 0, skippedFiles: 0, readyAt: null,
            };
            batches.push(batch);
            return { ...batch, toObject: () => ({ ...batch }) };
        },
        async updateOne(filter, update) {
            Object.assign(batches.find(row => row.batchId === filter.batchId), update.$set);
        },
        async deleteOne(filter) {
            const index = batches.findIndex(row => row.batchId === filter.batchId);
            if (index >= 0) batches.splice(index, 1);
        },
    };
    const missing = key => {
        const error = new Error(`Missing ${key}`);
        error.name = 'NoSuchKey';
        error.$metadata = { httpStatusCode: 404 };
        return error;
    };
    const r2 = {
        async createPresignedPut({ key }) { return `memory://fixture/${encodeURIComponent(key)}`; },
        async headObject(key) {
            const body = objects.get(key);
            if (!body) throw missing(key);
            return { contentLength: body.length, etag: `etag-${body.length}` };
        },
        async downloadToFile({ key, destinationPath }) {
            const body = objects.get(key);
            if (!body) throw missing(key);
            await fs.writeFile(destinationPath, body, { flag: 'wx' });
        },
        async deleteObject(key) { objects.delete(key); },
        putFromUrl(url, body) {
            const key = decodeURIComponent(new URL(url).pathname.slice(1));
            objects.set(key, body);
        },
    };
    return { Job, UploadBatch, jobs, batches, objects, r2 };
}

test('mock R2 lifecycle survives duplicate prepare/confirm then downloads and deletes the source', async () => {
    const fixture = createFixture();
    const uploadConfig = {
        maxFiles: 500,
        maxFileSizeBytes: 350 * 1024 * 1024,
        maxBatchBytes: 2 * 1024 * 1024 * 1024,
        maxJobAttempts: 3,
        confirmConcurrency: 4,
    };
    let uploadService = new UploadBatchService({
        Job: fixture.Job,
        UploadBatch: fixture.UploadBatch,
        r2: fixture.r2,
        config: uploadConfig,
    });
    const payloads = [Buffer.from('%PDF-tim-mach'), Buffer.from('%PDF-than-kinh')];
    const manifest = {
        clientBatchId: 'integration-batch',
        folderName: 'Y khoa #100%',
        files: payloads.map((body, index) => ({
            clientUploadId: `integration-file-${index}`,
            name: 'Tên trùng % #.pdf',
            size: body.length,
            type: 'application/pdf',
        })),
    };

    const prepared = await uploadService.prepareBatch(manifest);
    const repeatedPrepare = await uploadService.prepareBatch(manifest);
    assert.deepEqual(repeatedPrepare.items.map(item => item.jobId), prepared.items.map(item => item.jobId));
    prepared.items.forEach((item, index) => fixture.r2.putFromUrl(item.uploadUrl, payloads[index]));

    const jobIds = prepared.items.map(item => item.jobId);
    uploadService = new UploadBatchService({
        Job: fixture.Job,
        UploadBatch: fixture.UploadBatch,
        r2: fixture.r2,
        config: uploadConfig,
    });
    uploadService.expireStaleUploads = async () => 0;
    const recovered = await uploadService.reconcileUploadingJobs();
    assert.deepEqual(recovered, { scanned: 2, confirmed: 2, expired: 0 });

    const confirmed = await uploadService.confirmBatch(prepared.batchId, jobIds);
    const repeatedConfirm = await uploadService.confirmBatch(prepared.batchId, jobIds);
    assert.equal(confirmed.canCloseClient, true);
    assert.equal(repeatedConfirm.canCloseClient, true);
    assert.equal(fixture.jobs.every(job => job.status === 'pending' && job.sourceState === 'ready'), true);

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tranmed-integration-'));
    try {
        const sourceService = new SourceService({
            r2: fixture.r2,
            uploadDir: tempDir,
            assertCapacity: async () => {},
        });
        const firstJob = fixture.jobs[0];
        await fs.writeFile(path.join(tempDir, `r2-${firstJob.jobId}.pdf.part`), '%PDF-stale-part');
        const resolved = await sourceService.resolve(firstJob);
        assert.deepEqual(await fs.readFile(resolved.filePath), payloads[0]);
        await sourceService.cleanup(resolved);

        firstJob.status = 'completed';
        const cleanupService = new SourceCleanupService({ Job: fixture.Job, r2: fixture.r2 });
        const cleanup = await cleanupService.cleanupSource(firstJob, { reason: 'completed' });
        assert.equal(cleanup.cleaned, true);
        assert.equal(firstJob.sourceState, 'deleted');
        assert.equal(fixture.objects.size, 1);
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});
