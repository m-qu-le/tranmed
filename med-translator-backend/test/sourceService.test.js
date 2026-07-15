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
