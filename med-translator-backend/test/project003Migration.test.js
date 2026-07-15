import assert from 'node:assert/strict';
import test from 'node:test';
import { runProject003Migration } from '../src/migrations/project003Migration.js';

function modelWithCounts(counts) {
    let index = 0;
    return {
        syncCalls: 0,
        async countDocuments() { return counts[index++]; },
        async syncIndexes() { this.syncCalls += 1; },
    };
}

test('P003 migration is additive, dry-run safe and idempotent', async () => {
    const dryJob = modelWithCounts([12, 4]);
    const dryChunk = modelWithCounts([30, 20, 10, 3]);
    const dry = await runProject003Migration({ Job: dryJob, TranslationChunk: dryChunk, dryRun: true });
    assert.deepEqual(dry, {
        dryRun: true,
        report: {
            totalJobs: 12,
            versionedJobs: 4,
            totalChunks: 30,
            legacyFinalChunks: 20,
            qualityChunks: 10,
            incompleteQualityChunks: 3,
        },
        modifiedCount: 0,
        indexesEnsured: false,
    });
    assert.equal(dryJob.syncCalls + dryChunk.syncCalls, 0);

    const liveJob = modelWithCounts([12, 4]);
    const liveChunk = modelWithCounts([30, 20, 10, 3]);
    const live = await runProject003Migration({ Job: liveJob, TranslationChunk: liveChunk, dryRun: false });
    assert.equal(live.modifiedCount, 0);
    assert.equal(live.indexesEnsured, true);
    assert.equal(liveJob.syncCalls, 1);
    assert.equal(liveChunk.syncCalls, 1);
});
