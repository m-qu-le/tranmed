import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import {
    DeleteObjectCommand,
    GetObjectCommand,
    HeadBucketCommand,
    HeadObjectCommand,
    PutObjectCommand,
    S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

function requireObjectKey(key) {
    if (typeof key !== 'string' || !key.trim()) {
        throw new TypeError('R2 object key không được để trống.');
    }
    return key;
}

export function createR2Client(config) {
    return new S3Client({
        region: config.region,
        endpoint: config.endpoint,
        credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
        },
    });
}

export function createR2Service(config, dependencies = {}) {
    const client = dependencies.client || createR2Client(config);
    const signUrl = dependencies.getSignedUrl || getSignedUrl;
    const bucket = config.bucketName;

    return Object.freeze({
        async putObject({ key, body, contentType = 'application/octet-stream' }) {
            return client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: requireObjectKey(key),
                Body: body,
                ContentType: contentType,
            }));
        },

        async headObject(key) {
            const output = await client.send(new HeadObjectCommand({
                Bucket: bucket,
                Key: requireObjectKey(key),
            }));
            return {
                contentLength: output.ContentLength ?? null,
                contentType: output.ContentType ?? null,
                etag: output.ETag?.replace(/^"|"$/g, '') || null,
                lastModified: output.LastModified ?? null,
                metadata: output.Metadata || {},
            };
        },

        async getObjectStream(key) {
            const output = await client.send(new GetObjectCommand({
                Bucket: bucket,
                Key: requireObjectKey(key),
            }));
            if (!output.Body) throw new Error('R2 trả về object không có nội dung.');
            return output.Body;
        },

        async downloadToFile({ key, destinationPath }) {
            const body = await this.getObjectStream(key);
            await pipeline(body, createWriteStream(destinationPath, { flags: 'wx' }));
            return destinationPath;
        },

        async deleteObject(key) {
            await client.send(new DeleteObjectCommand({
                Bucket: bucket,
                Key: requireObjectKey(key),
            }));
        },

        async createPresignedPut({
            key,
            contentType = 'application/pdf',
            expiresIn = config.presignedUrlTtlSeconds,
        }) {
            const command = new PutObjectCommand({
                Bucket: bucket,
                Key: requireObjectKey(key),
                ContentType: contentType,
            });
            return signUrl(client, command, { expiresIn });
        },

        async checkReadiness() {
            await client.send(new HeadBucketCommand({ Bucket: bucket }));
            return { configured: true, available: true };
        },
    });
}
