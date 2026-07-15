import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import {
    DeleteObjectCommand,
    GetObjectCommand,
    GetBucketLifecycleConfigurationCommand,
    HeadBucketCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
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
    let readinessCache = null;

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

        async listObjects({ prefix = '', continuationToken, maxKeys = 1000 } = {}) {
            const output = await client.send(new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: prefix,
                ContinuationToken: continuationToken,
                MaxKeys: maxKeys,
            }));
            return {
                objects: (output.Contents || []).map(object => ({
                    key: object.Key,
                    size: object.Size || 0,
                    lastModified: object.LastModified || null,
                    etag: object.ETag?.replace(/^"|"$/g, '') || null,
                })),
                nextContinuationToken: output.NextContinuationToken || null,
                truncated: Boolean(output.IsTruncated),
            };
        },

        async getLifecycleRules() {
            const output = await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
            return output.Rules || [];
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
            return signUrl(client, command, {
                expiresIn,
                signableHeaders: new Set(['content-type']),
            });
        },

        async checkReadiness({ maxAgeMs = 60_000 } = {}) {
            if (readinessCache && Date.now() - readinessCache.checkedAt < maxAgeMs) {
                return readinessCache.value;
            }
            await client.send(new HeadBucketCommand({ Bucket: bucket }));
            const value = { configured: true, available: true };
            readinessCache = { checkedAt: Date.now(), value };
            return value;
        },
    });
}
