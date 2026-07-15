import assert from 'node:assert/strict';
import { validateRuntimeEnv } from '../src/config/env.js';
import { createR2Service } from '../src/services/r2Service.js';
import { redactError } from '../src/utils/redactSecrets.js';

const config = validateRuntimeEnv();
const r2 = createR2Service(config.r2);
const key = `smoke/${crypto.randomUUID()}.txt`;
const fixture = `tranmed-r2-smoke:${crypto.randomUUID()}`;
let created = false;

try {
    await r2.putObject({ key, body: fixture, contentType: 'text/plain' });
    created = true;

    const metadata = await r2.headObject(key);
    assert.equal(metadata.contentLength, Buffer.byteLength(fixture));

    const body = await r2.getObjectStream(key);
    const downloaded = await body.transformToString();
    assert.equal(downloaded, fixture);

    console.log('R2 smoke passed: PUT, HEAD and GET succeeded.');
} catch (error) {
    console.error(`R2 smoke failed: ${redactError(error)}`);
    process.exitCode = 1;
} finally {
    if (created) {
        try {
            await r2.deleteObject(key);
            console.log('R2 smoke cleanup passed: DELETE succeeded.');
        } catch (error) {
            console.error(`R2 smoke cleanup failed: ${redactError(error)}`);
            process.exitCode = 1;
        }
    }
}
