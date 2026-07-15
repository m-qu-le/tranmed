import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';

const configDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(configDir, '../..');

dotenv.config({ path: path.join(backendRoot, '.env'), quiet: true });

export const GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || 'gemini-3.1-flash-lite';
export const UPLOAD_DIR = path.join(backendRoot, 'uploads');

export function getGeminiApiKeys() {
    return (process.env.GEMINI_API_KEYS || '')
        .split(',')
        .map(key => key.trim())
        .filter(Boolean);
}

function readPositiveInteger(name, fallback) {
    const rawValue = process.env[name];
    if (!rawValue) return fallback;

    const value = Number.parseInt(rawValue, 10);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} phải là một số nguyên dương.`);
    }
    return value;
}

function readRequiredString(name, missing) {
    const value = process.env[name]?.trim();
    if (!value) missing.push(name);
    return value || null;
}

export const MAX_UPLOAD_STORAGE_MB = readPositiveInteger('MAX_UPLOAD_STORAGE_MB', 400);
export const MAX_FILE_SIZE_MB = readPositiveInteger('MAX_FILE_SIZE_MB', 350);
export const MAX_JOB_ATTEMPTS = readPositiveInteger('MAX_JOB_ATTEMPTS', 3);
export const GEMINI_TIMEOUT_MS = readPositiveInteger('GEMINI_TIMEOUT_MS', 180000);

export function validateRuntimeEnv() {
    const missing = [];
    const mongodbUri = readRequiredString('MONGODB_URI', missing);
    if (getGeminiApiKeys().length === 0) missing.push('GEMINI_API_KEYS');

    const r2AccountId = readRequiredString('R2_ACCOUNT_ID', missing);
    const r2AccessKeyId = readRequiredString('R2_ACCESS_KEY_ID', missing);
    const r2SecretAccessKey = readRequiredString('R2_SECRET_ACCESS_KEY', missing);
    const r2BucketName = readRequiredString('R2_BUCKET_NAME', missing);
    const r2Endpoint = readRequiredString('R2_ENDPOINT', missing);
    const r2Region = readRequiredString('R2_REGION', missing);
    readRequiredString('R2_PRESIGNED_URL_TTL_SECONDS', missing);
    readRequiredString('R2_UPLOAD_CONCURRENCY', missing);
    readRequiredString('R2_SOURCE_RETENTION_DAYS', missing);

    if (missing.length > 0) {
        throw new Error(`Thiếu biến môi trường bắt buộc: ${missing.join(', ')}`);
    }
    if (MAX_FILE_SIZE_MB >= MAX_UPLOAD_STORAGE_MB) {
        throw new Error('MAX_FILE_SIZE_MB phải nhỏ hơn MAX_UPLOAD_STORAGE_MB để chừa dung lượng vận hành.');
    }

    let parsedR2Endpoint;
    try {
        parsedR2Endpoint = new URL(r2Endpoint);
    } catch {
        throw new Error('R2_ENDPOINT phải là URL HTTPS hợp lệ.');
    }
    if (parsedR2Endpoint.protocol !== 'https:') {
        throw new Error('R2_ENDPOINT phải sử dụng HTTPS.');
    }

    return Object.freeze({
        port: readPositiveInteger('PORT', 8080),
        mongodbUri,
        frontendUrl: process.env.FRONTEND_URL?.trim() || null,
        maxUploadStorageMb: MAX_UPLOAD_STORAGE_MB,
        maxFileSizeMb: MAX_FILE_SIZE_MB,
        maxJobAttempts: MAX_JOB_ATTEMPTS,
        geminiTimeoutMs: GEMINI_TIMEOUT_MS,
        r2: Object.freeze({
            accountId: r2AccountId,
            accessKeyId: r2AccessKeyId,
            secretAccessKey: r2SecretAccessKey,
            bucketName: r2BucketName,
            endpoint: parsedR2Endpoint.toString().replace(/\/$/, ''),
            region: r2Region,
            presignedUrlTtlSeconds: readPositiveInteger('R2_PRESIGNED_URL_TTL_SECONDS'),
            uploadConcurrency: readPositiveInteger('R2_UPLOAD_CONCURRENCY'),
            sourceRetentionDays: readPositiveInteger('R2_SOURCE_RETENTION_DAYS'),
        }),
    });
}
