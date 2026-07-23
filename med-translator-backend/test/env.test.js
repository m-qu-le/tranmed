import assert from 'node:assert/strict';
import test from 'node:test';
import {
    getGeminiProjects,
    readParallelSourceBudgetMb,
    readTranslationWorkerConcurrency,
    validateRuntimeEnv,
} from '../src/config/env.js';

const R2_VARIABLES = [
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET_NAME',
    'R2_ENDPOINT',
    'R2_REGION',
    'R2_PRESIGNED_URL_TTL_SECONDS',
    'R2_UPLOAD_CONCURRENCY',
    'R2_SOURCE_RETENTION_DAYS',
];

test('runtime validation names every missing R2 variable without printing values', () => {
    const previous = Object.fromEntries(R2_VARIABLES.map(name => [name, process.env[name]]));
    for (const name of R2_VARIABLES) process.env[name] = '';

    try {
        assert.throws(
            validateRuntimeEnv,
            error => R2_VARIABLES.every(name => error.message.includes(name))
        );
    } finally {
        for (const [name, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
});

test('translation worker concurrency defaults to three and never exceeds three source jobs', () => {
    assert.equal(readTranslationWorkerConcurrency({}), 3);
    assert.equal(readTranslationWorkerConcurrency({ TRANSLATION_WORKER_CONCURRENCY: '1' }), 1);
    assert.equal(readTranslationWorkerConcurrency({ TRANSLATION_WORKER_CONCURRENCY: ' 3 ' }), 3);
    for (const value of ['0', '4', '5', '1.5', 'two']) {
        assert.throws(
            () => readTranslationWorkerConcurrency({ TRANSLATION_WORKER_CONCURRENCY: value }),
            /chỉ nhận số nguyên từ 1 đến 3/
        );
    }
});

test('parallel source budget defaults to the fixed 15 MiB operating budget', () => {
    assert.equal(readParallelSourceBudgetMb({}), 15);
    assert.equal(readParallelSourceBudgetMb({ PARALLEL_SOURCE_BUDGET_MB: '10' }), 10);
    assert.equal(readParallelSourceBudgetMb({ PARALLEL_SOURCE_BUDGET_MB: ' 100 ' }), 100);
    for (const value of ['9', '101', '10.5', 'many']) {
        assert.throws(
            () => readParallelSourceBudgetMb({ PARALLEL_SOURCE_BUDGET_MB: value }),
            /chỉ nhận số nguyên từ 10 đến 100/
        );
    }
});

test('Gemini project IDs must be stable, unique and aligned with API keys', () => {
    assert.deepEqual(
        getGeminiProjects({
            GEMINI_API_KEYS: 'key-a,key-b',
            GEMINI_PROJECT_IDS: 'project-a,project-b',
        }).map(project => ({ id: project.id, index: project.index })),
        [{ id: 'project-a', index: 0 }, { id: 'project-b', index: 1 }]
    );
    assert.throws(
        () => getGeminiProjects({
            GEMINI_API_KEYS: 'key-a,key-b',
            GEMINI_PROJECT_IDS: 'project-a',
        }),
        /đúng một ID/
    );
    assert.throws(
        () => getGeminiProjects({
            GEMINI_API_KEYS: 'key-a,key-b',
            GEMINI_PROJECT_IDS: 'same,same',
        }),
        /không được chứa ID trùng/
    );
});
