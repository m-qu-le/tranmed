import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRuntimeEnv } from '../src/config/env.js';

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
