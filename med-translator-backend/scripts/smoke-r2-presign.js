import assert from 'node:assert/strict';
import { validateRuntimeEnv } from '../src/config/env.js';
import { createR2Service } from '../src/services/r2Service.js';
import { redactError } from '../src/utils/redactSecrets.js';

const r2 = createR2Service(validateRuntimeEnv().r2);
const key = `smoke/${crypto.randomUUID()}.pdf`;
const expiredKey = `smoke/${crypto.randomUUID()}.pdf`;
const fixture = '%PDF-1.7\nR2 presigned smoke';
const cleanupKeys = new Set([key, expiredKey]);

try {
    const uploadUrl = await r2.createPresignedPut({ key, contentType: 'application/pdf' });
    const parsed = new URL(uploadUrl);
    assert.equal(parsed.searchParams.get('X-Amz-Expires'), '1800');
    assert.match(parsed.searchParams.get('X-Amz-SignedHeaders') || '', /content-type/);

    const wrongType = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: fixture,
    });
    assert.equal(wrongType.ok, false, 'Presigned URL phải từ chối Content-Type sai.');

    const uploaded = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/pdf' },
        body: fixture,
    });
    assert.equal(uploaded.ok, true, `Presigned PUT thất bại với HTTP ${uploaded.status}.`);
    const metadata = await r2.headObject(key);
    assert.equal(metadata.contentLength, Buffer.byteLength(fixture));

    const expiredUrl = await r2.createPresignedPut({
        key: expiredKey,
        contentType: 'application/pdf',
        expiresIn: 1,
    });
    await new Promise(resolve => setTimeout(resolve, 2_100));
    const expired = await fetch(expiredUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/pdf' },
        body: fixture,
    });
    assert.equal(expired.ok, false, 'Presigned URL hết hạn phải bị từ chối.');

    console.log('R2 presigned smoke passed: scope, Content-Type and expiry are enforced.');
} catch (error) {
    console.error(`R2 presigned smoke failed: ${redactError(error)}`);
    process.exitCode = 1;
} finally {
    const cleanup = await Promise.allSettled([...cleanupKeys].map(cleanupKey => r2.deleteObject(cleanupKey)));
    if (cleanup.some(result => result.status === 'rejected')) {
        console.error('R2 presigned smoke cleanup failed.');
        process.exitCode = 1;
    } else {
        console.log('R2 presigned smoke cleanup passed.');
    }
}
