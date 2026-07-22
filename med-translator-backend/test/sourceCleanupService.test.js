import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { SourceCleanupService } from '../src/services/sourceCleanupService.js';
import { appEvents } from '../src/services/appEvents.js';

function query(value) {
    return { sort() { return this; }, limit() { return this; }, lean: async () => value };
}

test('source cleanup deletes R2 first and only then marks the source deleted', async () => {
    const updates = [];
    const deleted = [];
    const Job = { async updateOne(filter, update) { updates.push({ filter, update }); } };
    const service = new SourceCleanupService({
        Job,
        r2: { async deleteObject(key) { deleted.push(key); } },
    });
    const cleanupEvent = once(appEvents, 'sourceCleanup');
    const result = await service.cleanupSource({
        jobId: 'job-clean', storageProvider: 'r2', storageKey: 'incoming/batch/job.pdf',
        sourceState: 'ready', sourceCleanupAttempts: 0,
    }, { reason: 'completed' });

    assert.deepEqual(deleted, ['incoming/batch/job.pdf']);
    assert.equal(result.cleaned, true);
    assert.equal(updates[0].update.$set.sourceState, 'delete_pending');
    assert.equal(updates[1].update.$set.sourceState, 'deleted');
    assert.equal(updates[1].update.$set.sourceCleanupState, 'succeeded');
    assert.ok(updates[1].update.$set.sourceDeletedAt instanceof Date);
    assert.deepEqual((await cleanupEvent)[0], {
        jobId: 'job-clean', status: 'deleted', reason: 'completed',
        deletedAt: updates[1].update.$set.sourceDeletedAt,
    });
});

test('failed R2 deletion persists a redacted retry instead of claiming deletion', async () => {
    const previousSecret = process.env.R2_SECRET_ACCESS_KEY;
    process.env.R2_SECRET_ACCESS_KEY = 'secret-value';
    const updates = [];
    const Job = { async updateOne(filter, update) { updates.push({ filter, update }); } };
    const service = new SourceCleanupService({
        Job,
        r2: { async deleteObject() { throw new Error('Access secret-value denied'); } },
    });
    const result = await service.cleanupSource({
        jobId: 'job-retry', storageProvider: 'r2', storageKey: 'incoming/batch/retry.pdf',
        sourceState: 'ready', sourceCleanupAttempts: 2,
    });
    if (previousSecret === undefined) delete process.env.R2_SECRET_ACCESS_KEY;
    else process.env.R2_SECRET_ACCESS_KEY = previousSecret;

    assert.equal(result.cleaned, false);
    assert.equal(result.retryScheduled, true);
    const retry = updates.at(-1).update;
    assert.equal(retry.$set.sourceState, 'delete_pending');
    assert.equal(retry.$set.sourceCleanupState, 'retry');
    assert.equal(retry.$set.sourceDeletedAt, undefined);
    assert.equal(retry.$inc.sourceCleanupAttempts, 1);
    assert.ok(retry.$set.sourceCleanupNextRetryAt instanceof Date);
    assert.doesNotMatch(retry.$set.sourceCleanupLastError, /secret-value/);
});

test('cleanup retry sweeper resumes persisted pending work after restart', async () => {
    const jobs = [{
        jobId: 'persisted-retry', storageProvider: 'r2', storageKey: 'incoming/retry.pdf',
        sourceState: 'delete_pending', sourceCleanupState: 'pending', sourceCleanupAttempts: 1,
    }];
    const Job = {
        find: () => query(jobs),
        async updateOne() {},
    };
    let deletes = 0;
    const service = new SourceCleanupService({ Job, r2: { async deleteObject() { deletes += 1; } } });
    const rows = await service.sweepRetries();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].result.cleaned, true);
    assert.equal(deletes, 1);
});

test('retention sweeper deletes only expired failed R2 sources', async () => {
    const jobs = [{
        jobId: 'expired-failure', status: 'failed', storageProvider: 'r2', storageKey: 'incoming/expired.pdf',
        sourceState: 'ready', sourceCleanupAttempts: 0, sourceRetentionUntil: new Date(Date.now() - 1),
    }];
    const Job = { find: () => query(jobs), async updateOne() {} };
    let deletes = 0;
    const service = new SourceCleanupService({ Job, r2: { async deleteObject() { deletes += 1; } } });
    const rows = await service.sweepExpiredFailedSources();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].result.cleaned, true);
    assert.equal(deletes, 1);
});
