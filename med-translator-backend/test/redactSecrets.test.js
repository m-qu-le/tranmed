import assert from 'node:assert/strict';
import test from 'node:test';
import { redactSensitiveText } from '../src/utils/redactSecrets.js';

test('redaction removes R2 keys, Mongo credentials and presigned queries', () => {
    const accessKey = 'access-key-fixture';
    const secretKey = 'secret-key-fixture';
    const mongoUri = 'mongodb+srv://username:password@cluster.example/database';
    const signedUrl = 'https://account.r2.cloudflarestorage.com/file.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=credential&X-Amz-Signature=signature';
    const output = redactSensitiveText(
        `${accessKey} ${secretKey} ${mongoUri} ${signedUrl}`,
        [accessKey, secretKey, mongoUri]
    );

    assert.doesNotMatch(output, /access-key-fixture|secret-key-fixture|username:password|X-Amz-Signature=signature/);
    assert.match(output, /\[REDACTED]/);
});
