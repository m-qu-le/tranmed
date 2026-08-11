import assert from 'node:assert/strict';
import test from 'node:test';
import {
    P014_R2_PREFIX,
    isP014PurgeConfirmed,
    purgeP014WorkData,
} from '../src/services/project014PurgeService.js';

function createModel(count) {
    const calls = [];
    return {
        calls,
        async countDocuments(filter) {
            calls.push({ operation: 'count', filter });
            return count;
        },
        async deleteMany(filter) {
            calls.push({ operation: 'delete', filter });
            return { deletedCount: count };
        },
    };
}

function createR2(pages) {
    const deleted = [];
    let listCall = 0;
    return {
        deleted,
        async listObjects() {
            return pages[Math.min(listCall++, pages.length - 1)];
        },
        async deleteObject(key) {
            deleted.push(key);
        },
    };
}

function dependencies(r2) {
    return {
        r2,
        TranslationChunk: createModel(7),
        Job: createModel(3),
        UploadBatch: createModel(2),
    };
}

test('P014 purge dry-run inventories only incoming/ objects and never deletes', async () => {
    const r2 = createR2([{
        objects: [{ key: `${P014_R2_PREFIX}batch/a.pdf`, size: 9 }],
        nextContinuationToken: null,
        truncated: false,
    }]);
    const input = dependencies(r2);

    const result = await purgeP014WorkData(input);

    assert.equal(result.mode, 'dry-run');
    assert.deepEqual(result.r2, { prefix: P014_R2_PREFIX, objects: 1, bytes: 9 });
    assert.deepEqual(r2.deleted, []);
    for (const model of [input.TranslationChunk, input.Job, input.UploadBatch]) {
        assert.deepEqual(model.calls.map(call => call.operation), ['count']);
    }
});

test('P014 purge deletes R2 first, verifies it, then clears exactly three work collections', async () => {
    const r2 = createR2([
        {
            objects: [
                { key: `${P014_R2_PREFIX}batch/a.pdf`, size: 9 },
                { key: `${P014_R2_PREFIX}batch/b.pdf`, size: 11 },
            ],
            nextContinuationToken: null,
            truncated: false,
        },
        { objects: [], nextContinuationToken: null, truncated: false },
    ]);
    const input = dependencies(r2);

    const result = await purgeP014WorkData(input, { execute: true });

    assert.deepEqual(r2.deleted, [`${P014_R2_PREFIX}batch/a.pdf`, `${P014_R2_PREFIX}batch/b.pdf`]);
    assert.deepEqual(result.deleted, {
        r2Objects: 2,
        translationChunks: 7,
        jobs: 3,
        uploadBatches: 2,
    });
    for (const model of [input.TranslationChunk, input.Job, input.UploadBatch]) {
        assert.deepEqual(model.calls.map(call => call.operation), ['count', 'delete']);
        assert.deepEqual(model.calls[1].filter, {});
    }
});

test('a failed R2 deletion prevents every MongoDB deletion', async () => {
    const r2 = createR2([{
        objects: [{ key: `${P014_R2_PREFIX}batch/a.pdf`, size: 9 }],
        nextContinuationToken: null,
        truncated: false,
    }]);
    r2.deleteObject = async () => { throw new Error('R2 unavailable'); };
    const input = dependencies(r2);

    await assert.rejects(() => purgeP014WorkData(input, { execute: true }), /R2 unavailable/);
    for (const model of [input.TranslationChunk, input.Job, input.UploadBatch]) {
        assert.deepEqual(model.calls.map(call => call.operation), ['count']);
    }
});

test('a key outside incoming/ aborts before any destructive operation', async () => {
    const r2 = createR2([{
        objects: [{ key: 'other/keep.pdf', size: 9 }],
        nextContinuationToken: null,
        truncated: false,
    }]);
    const input = dependencies(r2);

    await assert.rejects(() => purgeP014WorkData(input, { execute: true }), /incoming/);
    assert.deepEqual(r2.deleted, []);
    for (const model of [input.TranslationChunk, input.Job, input.UploadBatch]) {
        assert.deepEqual(model.calls, []);
    }
});

test('live P014 purge requires both a CLI flag and an explicit environment confirmation', () => {
    assert.equal(isP014PurgeConfirmed({ args: ['--execute'], environment: {} }), false);
    assert.equal(isP014PurgeConfirmed({ args: [], environment: { P014_PURGE_CONFIRM: 'DELETE_WORK_DATA' } }), false);
    assert.equal(isP014PurgeConfirmed({
        args: ['--execute'],
        environment: { P014_PURGE_CONFIRM: 'DELETE_WORK_DATA' },
    }), true);
});
