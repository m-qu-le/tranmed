import assert from 'node:assert/strict';
import test from 'node:test';
import { runProject002Migration } from '../src/migrations/project002Migration.js';

test('P002 migration is dry-run safe and idempotent', async () => {
    let legacyCandidates = 2;
    let jobIndexSyncs = 0;
    let batchIndexSyncs = 0;
    const Job = {
        async countDocuments(filter) {
            if (filter.storageProvider === 'r2') return 0;
            if (filter.filePath) return legacyCandidates;
            return 2;
        },
        async updateMany() {
            const modifiedCount = legacyCandidates;
            legacyCandidates = 0;
            return { modifiedCount };
        },
        async syncIndexes() { jobIndexSyncs += 1; },
    };
    const UploadBatch = {
        async countDocuments() { return 0; },
        async syncIndexes() { batchIndexSyncs += 1; },
    };

    const dryRun = await runProject002Migration({ Job, UploadBatch, dryRun: true });
    assert.equal(dryRun.report.legacyCandidates, 2);
    assert.equal(dryRun.modifiedCount, 0);
    assert.equal(legacyCandidates, 2);

    const first = await runProject002Migration({ Job, UploadBatch, dryRun: false });
    const second = await runProject002Migration({ Job, UploadBatch, dryRun: false });
    assert.equal(first.modifiedCount, 2);
    assert.equal(second.modifiedCount, 0);
    assert.equal(jobIndexSyncs, 2);
    assert.equal(batchIndexSyncs, 2);
});
