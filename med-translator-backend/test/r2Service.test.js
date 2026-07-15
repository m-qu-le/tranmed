import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'stream';
import { mkdtemp, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
    DeleteObjectCommand,
    GetObjectCommand,
    HeadBucketCommand,
    HeadObjectCommand,
    PutObjectCommand,
} from '@aws-sdk/client-s3';
import { createR2Service } from '../src/services/r2Service.js';

const config = {
    bucketName: 'fixture-bucket',
    presignedUrlTtlSeconds: 1800,
};

test('R2 service scopes commands to one bucket and streams downloads to disk', async () => {
    const commands = [];
    const client = {
        async send(command) {
            commands.push(command);
            if (command instanceof HeadObjectCommand) {
                return { ContentLength: 7, ETag: '"etag-value"', ContentType: 'text/plain' };
            }
            if (command instanceof GetObjectCommand) {
                return { Body: Readable.from(['fixture']) };
            }
            return {};
        },
    };
    const signCalls = [];
    const service = createR2Service(config, {
        client,
        getSignedUrl: async (...args) => {
            signCalls.push(args);
            return 'https://signed.invalid';
        },
    });
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tranmed-r2-'));
    const destinationPath = path.join(tempDir, 'download.txt');

    try {
        await service.putObject({ key: 'smoke/file.txt', body: 'fixture', contentType: 'text/plain' });
        const head = await service.headObject('smoke/file.txt');
        await service.downloadToFile({ key: 'smoke/file.txt', destinationPath });
        await service.deleteObject('smoke/file.txt');
        const url = await service.createPresignedPut({ key: 'incoming/job.pdf' });
        await service.checkReadiness();

        assert.equal(head.etag, 'etag-value');
        assert.equal((await readFile(destinationPath, 'utf8')), 'fixture');
        assert.equal(url, 'https://signed.invalid');
        assert.ok(commands[0] instanceof PutObjectCommand);
        assert.ok(commands[1] instanceof HeadObjectCommand);
        assert.ok(commands[2] instanceof GetObjectCommand);
        assert.ok(commands[3] instanceof DeleteObjectCommand);
        assert.ok(commands[4] instanceof HeadBucketCommand);
        assert.equal(commands.every(command => command.input.Bucket === 'fixture-bucket'), true);
        assert.equal(signCalls[0][2].expiresIn, 1800);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('R2 service rejects empty object keys before issuing a request', async () => {
    const service = createR2Service(config, {
        client: { send: () => assert.fail('client must not be called') },
    });
    await assert.rejects(service.headObject(''), /không được để trống/);
});
