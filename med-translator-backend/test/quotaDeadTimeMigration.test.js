import assert from 'node:assert/strict';
import test from 'node:test';
import { runQuotaDeadTimeMigration } from '../src/migrations/quotaDeadTimeMigration.js';
import { ErrorCodes } from '../src/utils/processingError.js';

test('targeted quota requeue is additive, preserves artifacts and is idempotent', async () => {
    const now = new Date('2026-07-23T12:00:00.000Z');
    const jobs = [{
        jobId: 'quota-job',
        status: 'pending',
        error: 'quota',
        errorCode: ErrorCodes.GEMINI_RATE_LIMIT,
        nextRetryAt: new Date(now.getTime() + 3_600_000),
        processingToken: 'stale-token',
        leaseExpiresAt: new Date(now.getTime() + 60_000),
    }, {
        jobId: 'content-job',
        status: 'pending',
        errorCode: ErrorCodes.GEMINI_SCHEMA_INVALID,
        nextRetryAt: new Date(now.getTime() + 3_600_000),
    }];
    const chunks = [{
        jobId: 'quota-job',
        chunkIndex: 0,
        stage: 'repaired',
        repairedContent: 'artifact must survive',
        repairCount: 1,
        stageAttempts: { reverify: 7 },
        lastStageErrorCode: ErrorCodes.GEMINI_RATE_LIMIT,
        nextStageRetryAt: new Date(now.getTime() + 3_600_000),
    }];
    const Job = {
        async distinct() {
            return jobs
                .filter(row => (
                    row.status === 'pending'
                    && row.errorCode === ErrorCodes.GEMINI_RATE_LIMIT
                    && new Date(row.nextRetryAt).getTime() > now.getTime()
                ))
                .map(row => row.jobId);
        },
        async updateMany(filter, update) {
            for (const row of jobs.filter(candidate => filter.jobId.$in.includes(candidate.jobId))) {
                Object.assign(row, structuredClone(update.$set));
            }
        },
    };
    const TranslationChunk = {
        async countDocuments(filter) {
            return chunks.filter(row => (
                filter.jobId.$in.includes(row.jobId)
                && row.lastStageErrorCode === filter.lastStageErrorCode
            )).length;
        },
        async updateMany(filter, update) {
            for (const row of chunks.filter(candidate => (
                filter.jobId.$in.includes(candidate.jobId)
                && candidate.lastStageErrorCode === filter.lastStageErrorCode
            ))) {
                Object.assign(row, structuredClone(update.$set));
            }
        },
    };

    const dryRun = await runQuotaDeadTimeMigration({
        Job,
        TranslationChunk,
        dryRun: true,
        now,
    });
    assert.equal(dryRun.jobsToRequeue, 1);
    assert.equal(dryRun.chunksToClear, 1);
    assert.equal(jobs[0].processingToken, 'stale-token');

    const applied = await runQuotaDeadTimeMigration({
        Job,
        TranslationChunk,
        dryRun: false,
        now,
    });
    assert.equal(applied.jobsToRequeue, 1);
    assert.equal(jobs[0].schedulerDeferred, true);
    assert.equal(jobs[0].processingToken, null);
    assert.equal(chunks[0].stage, 'repaired');
    assert.equal(chunks[0].repairedContent, 'artifact must survive');
    assert.equal(chunks[0].repairCount, 1);
    assert.deepEqual(chunks[0].stageAttempts, { reverify: 7 });
    assert.equal(chunks[0].lastStageErrorCode, null);

    const repeated = await runQuotaDeadTimeMigration({
        Job,
        TranslationChunk,
        dryRun: false,
        now,
    });
    assert.equal(repeated.jobsToRequeue, 0);
    assert.equal(repeated.chunksToClear, 0);
    assert.equal(jobs[1].errorCode, ErrorCodes.GEMINI_SCHEMA_INVALID);
});
