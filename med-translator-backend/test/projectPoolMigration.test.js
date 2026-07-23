import assert from 'node:assert/strict';
import test from 'node:test';
import {
    PROJECT_POOL_EXECUTION_VERSION,
    runProjectPoolMigration,
} from '../src/migrations/projectPoolMigration.js';

function fakeModel(missing = {}) {
    const calls = [];
    return {
        calls,
        async countDocuments(filter) {
            const field = Object.keys(filter)[0];
            return missing[field] || 0;
        },
        async updateMany(filter, update) {
            calls.push({ type: 'updateMany', filter, update });
            return { modifiedCount: 1 };
        },
        async createIndexes() {
            calls.push({ type: 'createIndexes' });
        },
        async bulkWrite(operations) {
            calls.push({ type: 'bulkWrite', operations });
        },
    };
}

test('project-pool migration is additive, dry-run safe and never touches stage artifacts', async () => {
    const Job = fakeModel({ schedulerSuspended: 2 });
    const TranslationChunk = fakeModel({ stageAttempts: 3, physicalAttemptCount: 3 });
    const GeminiQuotaState = fakeModel();
    const dry = await runProjectPoolMigration({
        Job,
        TranslationChunk,
        GeminiQuotaState,
        projectIds: ['project-a', 'project-b'],
        dryRun: true,
    });
    assert.equal(dry.executionVersion, PROJECT_POOL_EXECUTION_VERSION);
    assert.equal(dry.jobs.schedulerSuspended, 2);
    assert.equal(dry.chunks.stageAttempts, 3);
    assert.equal(Job.calls.length, 0);
    assert.equal(TranslationChunk.calls.length, 0);
    assert.equal(GeminiQuotaState.calls.length, 0);

    await runProjectPoolMigration({
        Job,
        TranslationChunk,
        GeminiQuotaState,
        projectIds: ['project-a', 'project-b'],
        dryRun: false,
    });
    const serialized = JSON.stringify([...Job.calls, ...TranslationChunk.calls]);
    assert.doesNotMatch(
        serialized,
        /draftContent|auditReport|revisedContent|verificationReport|repairedContent|reverifyReport|stage"/
    );
    assert.equal(GeminiQuotaState.calls.some(call => call.type === 'bulkWrite'), true);
});

test('project-pool migration refuses duplicate stable project IDs', async () => {
    await assert.rejects(
        runProjectPoolMigration({
            Job: fakeModel(),
            TranslationChunk: fakeModel(),
            GeminiQuotaState: fakeModel(),
            projectIds: ['duplicate', 'duplicate'],
        }),
        /project ID trùng/
    );
});
