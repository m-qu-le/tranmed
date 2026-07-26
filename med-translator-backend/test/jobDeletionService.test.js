import assert from 'node:assert/strict';
import test from 'node:test';
import { JobDeletionService } from '../src/services/jobDeletionService.js';

function matches(row, filter) {
    return Object.entries(filter).every(([key, value]) => {
        if (key === 'status' && value?.$ne) return row.status !== value.$ne;
        if (key === 'jobId' && value?.$in) return value.$in.includes(row.jobId);
        return row[key] === value;
    });
}

function query(value) {
    return {
        selectedLimit: null,
        limit(limit) {
            this.selectedLimit = limit;
            return this;
        },
        lean: async function lean() {
            return Array.isArray(value) && this.selectedLimit
                ? value.slice(0, this.selectedLimit)
                : value;
        },
    };
}

function createFixture({ jobs, batches, chunks = [] }) {
    const JobModel = {
        findOne(filter) {
            return query(jobs.find(job => matches(job, filter)) || null);
        },
        find(filter) {
            return query(jobs.filter(job => matches(job, filter)));
        },
        async updateOne(filter, update) {
            const job = jobs.find(row => matches(row, filter));
            if (!job) return { matchedCount: 0, modifiedCount: 0 };
            Object.assign(job, update.$set);
            return { matchedCount: 1, modifiedCount: 1 };
        },
        async deleteOne(filter) {
            const index = jobs.findIndex(job => matches(job, filter));
            if (index < 0) return { deletedCount: 0 };
            jobs.splice(index, 1);
            return { deletedCount: 1 };
        },
        async deleteMany(filter) {
            const before = jobs.length;
            for (let index = jobs.length - 1; index >= 0; index -= 1) {
                if (matches(jobs[index], filter)) jobs.splice(index, 1);
            }
            return { deletedCount: before - jobs.length };
        },
    };
    const TranslationChunkModel = {
        async deleteMany(filter) {
            const ids = filter.jobId?.$in || [filter.jobId];
            for (let index = chunks.length - 1; index >= 0; index -= 1) {
                if (ids.includes(chunks[index].jobId)) chunks.splice(index, 1);
            }
        },
    };
    const UploadBatchModel = {
        findOne(filter) {
            return query(batches.find(batch => batch.batchId === filter.batchId) || null);
        },
        async updateOne(filter, update) {
            const batch = batches.find(row => row.batchId === filter.batchId);
            if (batch) Object.assign(batch, update.$set);
        },
        async deleteOne(filter) {
            const index = batches.findIndex(batch => batch.batchId === filter.batchId);
            if (index < 0) return { deletedCount: 0 };
            batches.splice(index, 1);
            return { deletedCount: 1 };
        },
    };
    return {
        JobModel,
        TranslationChunkModel,
        UploadBatchModel,
        service: new JobDeletionService({
            JobModel,
            TranslationChunkModel,
            UploadBatchModel,
        }),
    };
}

test('hard deletion reconciles a partially retained upload batch before removing the tombstone', async () => {
    const jobs = [
        {
            jobId: 'delete-me',
            uploadBatchId: 'batch-1',
            status: 'completed',
            sourceSize: 100,
            uploadConfirmedAt: new Date(),
            completedAt: new Date(),
        },
        {
            jobId: 'keep-me',
            uploadBatchId: 'batch-1',
            status: 'completed',
            sourceSize: 200,
            uploadConfirmedAt: new Date(),
        },
    ];
    const batches = [{
        batchId: 'batch-1',
        status: 'ready',
        totalFiles: 2,
        totalBytes: 300,
        confirmedFiles: 2,
        confirmedBytes: 300,
        failedFiles: 0,
        skippedFiles: 0,
        readyAt: new Date(),
        items: [
            { jobId: 'delete-me', sourceSize: 100 },
            { jobId: 'keep-me', sourceSize: 200 },
        ],
    }];
    const chunks = [
        { jobId: 'delete-me', chunkIndex: 0 },
        { jobId: 'keep-me', chunkIndex: 0 },
    ];
    const fixture = createFixture({ jobs, batches, chunks });

    const result = await fixture.service.finalizeDeletion(jobs[0], {
        sourceDeletedAt: new Date(),
    });

    assert.deepEqual(result, { purged: true });
    assert.deepEqual(jobs.map(job => job.jobId), ['keep-me']);
    assert.deepEqual(chunks.map(chunk => chunk.jobId), ['keep-me']);
    assert.equal(batches[0].totalFiles, 1);
    assert.equal(batches[0].totalBytes, 200);
    assert.equal(batches[0].confirmedFiles, 1);
    assert.equal(batches[0].confirmedBytes, 200);
    assert.deepEqual(batches[0].items.map(item => item.jobId), ['keep-me']);
    assert.equal(batches[0].status, 'ready');
});

test('hard deletion removes the upload batch before removing its final job tombstone', async () => {
    const jobs = [{
        jobId: 'last-job',
        uploadBatchId: 'batch-last',
        status: 'failed',
        sourceSize: 100,
        uploadConfirmedAt: new Date(),
    }];
    const batches = [{
        batchId: 'batch-last',
        status: 'ready',
        totalFiles: 1,
        totalBytes: 100,
        items: [{ jobId: 'last-job', sourceSize: 100 }],
    }];
    const fixture = createFixture({ jobs, batches });

    await fixture.service.finalizeDeletion(jobs[0], { sourceDeletedAt: new Date() });

    assert.equal(jobs.length, 0);
    assert.equal(batches.length, 0);
});

test('startup purge removes legacy tombstones in bounded batches and clears their upload history', async () => {
    const jobs = Array.from({ length: 387 }, (_, index) => ({
        jobId: `deleted-${index}`,
        uploadBatchId: 'legacy-batch',
        status: 'deleted',
    }));
    const batches = [{
        batchId: 'legacy-batch',
        status: 'ready',
        totalFiles: 387,
        totalBytes: 38700,
        confirmedFiles: 387,
        confirmedBytes: 38700,
        items: jobs.map(job => ({ jobId: job.jobId, sourceSize: 100 })),
    }];
    const chunks = [{ jobId: 'deleted-0', chunkIndex: 0 }];
    const fixture = createFixture({ jobs, batches, chunks });

    const purged = await fixture.service.purgeDeletedHistory({ limit: 100 });

    assert.equal(purged, 387);
    assert.equal(jobs.length, 0);
    assert.equal(batches.length, 0);
    assert.equal(chunks.length, 0);
});

test('a purge interrupted after batch reconciliation is idempotent on retry', async () => {
    const jobs = [{
        jobId: 'retry-purge',
        uploadBatchId: 'retry-batch',
        status: 'deleted',
    }];
    const batches = [{
        batchId: 'retry-batch',
        status: 'ready',
        totalFiles: 1,
        totalBytes: 100,
        items: [{ jobId: 'retry-purge', sourceSize: 100 }],
    }];
    const fixture = createFixture({ jobs, batches });
    const originalDeleteOne = fixture.JobModel.deleteOne;
    let firstAttempt = true;
    fixture.JobModel.deleteOne = async filter => {
        if (firstAttempt) {
            firstAttempt = false;
            throw new Error('temporary database failure');
        }
        return originalDeleteOne(filter);
    };

    await assert.rejects(
        fixture.service.purgeTombstone(jobs[0]),
        /temporary database failure/
    );
    assert.equal(jobs.length, 1);
    assert.equal(batches.length, 0);

    const result = await fixture.service.purgeTombstone(jobs[0]);
    assert.deepEqual(result, { purged: true });
    assert.equal(jobs.length, 0);
});
