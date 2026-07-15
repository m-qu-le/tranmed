import assert from 'node:assert/strict';
import test from 'node:test';
import { createWriteStream } from 'fs';
import fs from 'fs/promises';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import os from 'os';
import path from 'path';
import { SourceService } from '../src/services/sourceService.js';
import { ErrorCodes } from '../src/utils/processingError.js';

test('R2 source streams a 30 MB PDF through .part then renames and cleans atomically', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tranmed-source-'));
    const sourceSize = 30 * 1024 * 1024;
    const firstChunk = Buffer.alloc(1024 * 1024, 0x20);
    firstChunk.write('%PDF-', 0, 'ascii');
    const r2 = {
        async downloadToFile({ destinationPath }) {
            async function* chunks() {
                yield firstChunk;
                for (let index = 1; index < 30; index += 1) yield Buffer.alloc(1024 * 1024, 0x20);
            }
            await pipeline(Readable.from(chunks()), createWriteStream(destinationPath, { flags: 'wx' }));
        },
    };
    const service = new SourceService({ r2, uploadDir: tempDir, assertCapacity: async () => {} });
    try {
        const resolved = await service.resolve({
            jobId: 'stream-job', storageProvider: 'r2', storageKey: 'incoming/batch/job.pdf',
            sourceState: 'ready', sourceSize,
        });
        assert.equal((await fs.stat(resolved.filePath)).size, sourceSize);
        await assert.rejects(fs.access(`${resolved.filePath}.part`), error => error.code === 'ENOENT');
        await service.cleanup(resolved);
        await assert.rejects(fs.access(resolved.filePath), error => error.code === 'ENOENT');
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test('R2 source maps missing objects and removes partial downloads', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tranmed-source-error-'));
    const service = new SourceService({
        uploadDir: tempDir,
        assertCapacity: async () => {},
        r2: {
            async downloadToFile({ destinationPath }) {
                await fs.writeFile(destinationPath, '%PDF-partial');
                const error = new Error('missing');
                error.name = 'NoSuchKey';
                error.$metadata = { httpStatusCode: 404 };
                throw error;
            },
        },
    });
    try {
        await assert.rejects(
            service.resolve({
                jobId: 'missing-job', storageProvider: 'r2', storageKey: 'incoming/missing.pdf',
                sourceState: 'ready', sourceSize: 100,
            }),
            error => error.code === ErrorCodes.R2_SOURCE_MISSING && error.retryable === false,
        );
        assert.deepEqual(await fs.readdir(tempDir), []);
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test('legacy source resolver keeps the original file path', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tranmed-legacy-'));
    const filePath = path.join(tempDir, 'legacy.pdf');
    await fs.writeFile(filePath, '%PDF-legacy');
    const service = new SourceService({ r2: null, uploadDir: tempDir });
    try {
        const resolved = await service.resolve({ storageProvider: 'local', filePath });
        assert.deepEqual(resolved, { filePath, temporary: false });
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test('R2 auth, rate-limit, timeout and unavailable errors keep the expected retry policy', async t => {
    const cases = [
        { name: 'AccessDenied', status: 403, code: ErrorCodes.R2_AUTH, retryable: false },
        { name: 'SlowDown', status: 429, code: ErrorCodes.R2_RATE_LIMIT, retryable: true },
        { name: 'TimeoutError', status: undefined, code: ErrorCodes.R2_TIMEOUT, retryable: true },
        { name: 'ServiceUnavailable', status: 503, code: ErrorCodes.R2_UNAVAILABLE, retryable: true },
    ];
    for (const fixture of cases) {
        await t.test(fixture.name, async () => {
            const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tranmed-source-policy-'));
            const service = new SourceService({
                uploadDir: tempDir,
                assertCapacity: async () => {},
                r2: {
                    async downloadToFile() {
                        const error = new Error(fixture.name);
                        error.name = fixture.name;
                        if (fixture.status) error.$metadata = { httpStatusCode: fixture.status };
                        throw error;
                    },
                },
            });
            try {
                await assert.rejects(
                    service.resolve({
                        jobId: `policy-${fixture.name}`,
                        storageProvider: 'r2',
                        storageKey: `incoming/policy/${fixture.name}.pdf`,
                        sourceState: 'ready',
                        sourceSize: 100,
                    }),
                    error => error.code === fixture.code
                        && error.retryable === fixture.retryable
                        && error.quotaRelated === false,
                );
            } finally {
                await fs.rm(tempDir, { recursive: true, force: true });
            }
        });
    }
});

test('worker disk admission fails before issuing an R2 download', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tranmed-source-disk-'));
    let downloads = 0;
    const service = new SourceService({
        uploadDir: tempDir,
        assertCapacity: async () => { throw new Error('disk full'); },
        r2: { async downloadToFile() { downloads += 1; } },
    });
    try {
        await assert.rejects(
            service.resolve({
                jobId: 'disk-full', storageProvider: 'r2', storageKey: 'incoming/disk/full.pdf',
                sourceState: 'ready', sourceSize: 1024,
            }),
            error => error.code === ErrorCodes.DISK_CAPACITY && error.retryable === true,
        );
        assert.equal(downloads, 0);
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});
