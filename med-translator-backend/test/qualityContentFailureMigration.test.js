import assert from 'node:assert/strict';
import test from 'node:test';
import {
    runQualityContentFailureMigration,
} from '../src/migrations/qualityContentFailureMigration.js';
import {
    QUALITY_STAGE_CONTENT_FAILURE_LIMIT,
} from '../src/services/qualityStageFailurePolicy.js';
import { CONTENT_MAX_ATTEMPTS } from '../src/services/jobFailurePolicy.js';

class FakeModel {
    constructor(countResolver = () => 1) {
        this.countResolver = countResolver;
        this.counts = [];
        this.updates = [];
    }

    async countDocuments(filter) {
        this.counts.push(filter);
        return this.countResolver(filter);
    }

    async updateMany(filter, update) {
        this.updates.push({ filter, update });
        return { modifiedCount: 1 };
    }

    async distinct() {
        return ['job-stuck'];
    }
}

test('quality content-failure migration is dry-run safe and seeds only the new policy fields', async () => {
    const Job = new FakeModel();
    const TranslationChunk = new FakeModel();
    const dry = await runQualityContentFailureMigration({
        Job,
        TranslationChunk,
        dryRun: true,
    });

    assert.equal(dry.dryRun, true);
    assert.equal(dry.contentFailureLimit, QUALITY_STAGE_CONTENT_FAILURE_LIMIT);
    assert.equal(dry.contentAttemptLimit, CONTENT_MAX_ATTEMPTS);
    assert.equal(Job.updates.length, 0);
    assert.equal(TranslationChunk.updates.length, 0);
});

test('quality content-failure migration initializes legacy stuck chunks and resumes jobs without attempt amplification', async () => {
    const Job = new FakeModel(filter => (filter.status === 'processing' ? 0 : 1));
    const TranslationChunk = new FakeModel();
    const result = await runQualityContentFailureMigration({
        Job,
        TranslationChunk,
        dryRun: false,
        now: new Date('2026-07-30T00:00:00.000Z'),
    });

    assert.equal(result.dryRun, false);
    assert.ok(
        TranslationChunk.updates.some(({ update }) => (
            update.$set?.stageContentFailures === undefined
            && Object.values(update.$set || {}).some(value => value === QUALITY_STAGE_CONTENT_FAILURE_LIMIT - 1)
        ))
    );
    assert.ok(
        Job.updates.some(({ update }) => (
            update.$set?.schedulerDeferred === true
            && update.$set?.maxAttempts === CONTENT_MAX_ATTEMPTS
        ))
    );
});

test('quality content-failure migration refuses live writes while a worker owns a job', async () => {
    const Job = new FakeModel();
    const TranslationChunk = new FakeModel();
    await assert.rejects(
        runQualityContentFailureMigration({
            Job,
            TranslationChunk,
            dryRun: false,
        }),
        /còn 1 job processing/
    );
    assert.equal(Job.updates.length, 0);
    assert.equal(TranslationChunk.updates.length, 0);
});
