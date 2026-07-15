import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import validatePdf from '../src/middlewares/validatePdf.js';

function createResponse() {
    return {
        statusCode: null,
        payload: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.payload = payload;
            return this;
        }
    };
}

test('validatePdf accepts a PDF signature and rejects spoofed MIME content', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'studymed-pdf-'));
    const validPath = path.join(tempDir, 'valid.pdf');
    const invalidPath = path.join(tempDir, 'invalid.pdf');
    await writeFile(validPath, '%PDF-1.7\nfixture');
    await writeFile(invalidPath, 'not a real pdf');

    let nextCalled = false;
    await validatePdf(
        { files: [{ path: validPath, originalname: 'valid.pdf' }] },
        createResponse(),
        () => { nextCalled = true; }
    );
    assert.equal(nextCalled, true);
    assert.match((await readFile(validPath)).toString(), /^%PDF-/);

    const invalidResponse = createResponse();
    await validatePdf(
        { files: [{ path: invalidPath, originalname: 'fake.pdf' }] },
        invalidResponse,
        () => assert.fail('Invalid PDF must not call next')
    );
    assert.equal(invalidResponse.statusCode, 400);
    await assert.rejects(readFile(invalidPath), error => error.code === 'ENOENT');

    await rm(tempDir, { recursive: true, force: true });
});
