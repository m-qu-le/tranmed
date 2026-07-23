import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';

const configDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(configDir, '../..');

dotenv.config({ path: path.join(backendRoot, '.env'), quiet: true });

export const GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash-lite';
export const UPLOAD_DIR = path.join(backendRoot, 'uploads');

export function getGeminiApiKeys() {
    return (process.env.GEMINI_API_KEYS || '')
        .split(',')
        .map(key => key.trim())
        .filter(Boolean);
}

export function getGeminiProjectIds(source = process.env) {
    return (source.GEMINI_PROJECT_IDS || '')
        .split(',')
        .map(id => id.trim())
        .filter(Boolean);
}

export function getGeminiProjects(source = process.env) {
    const keys = (source.GEMINI_API_KEYS || '')
        .split(',')
        .map(key => key.trim())
        .filter(Boolean);
    const projectIds = getGeminiProjectIds(source);
    if (keys.length === 0) return [];
    if (projectIds.length !== keys.length) {
        throw new Error('GEMINI_PROJECT_IDS phải có đúng một ID ổn định cho mỗi GEMINI_API_KEYS.');
    }
    if (new Set(projectIds).size !== projectIds.length) {
        throw new Error('GEMINI_PROJECT_IDS không được chứa ID trùng nhau.');
    }
    return keys.map((apiKey, index) => Object.freeze({
        id: projectIds[index],
        apiKey,
        index,
    }));
}

function readPositiveInteger(name, fallback, source = process.env) {
    const rawValue = source[name];
    if (!rawValue) return fallback;

    const value = Number.parseInt(rawValue, 10);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} phải là một số nguyên dương.`);
    }
    return value;
}

function readStrictPositiveInteger(name, fallback, source = process.env) {
    const rawValue = source[name];
    if (rawValue === undefined || rawValue === '') return fallback;

    const normalized = String(rawValue).trim();
    const value = Number.parseInt(normalized, 10);
    if (!Number.isSafeInteger(value) || value <= 0 || String(value) !== normalized) {
        throw new Error(`${name} phải là một số nguyên dương.`);
    }
    return value;
}

function readNonNegativeInteger(name, fallback, source = process.env) {
    const rawValue = source[name];
    if (rawValue === undefined || rawValue === '') return fallback;

    const normalized = String(rawValue).trim();
    const value = Number.parseInt(normalized, 10);
    if (!Number.isSafeInteger(value) || value < 0 || String(value) !== normalized) {
        throw new Error(`${name} phải là một số nguyên không âm.`);
    }
    return value;
}

export function readP003Config(source = process.env) {
    const pipelineMode = source.TRANSLATION_PIPELINE_MODE?.trim().toLowerCase() || 'quality';
    if (!['legacy', 'quality'].includes(pipelineMode)) {
        throw new Error('TRANSLATION_PIPELINE_MODE chỉ nhận legacy hoặc quality.');
    }

    const thinkingLevel = source.GEMINI_THINKING_LEVEL?.trim().toUpperCase() || 'HIGH';
    if (thinkingLevel !== 'HIGH') {
        throw new Error('GEMINI_THINKING_LEVEL của P003 bắt buộc là HIGH.');
    }

    const maxRepairCycles = readNonNegativeInteger('QUALITY_MAX_REPAIR_CYCLES', 2, source);
    if (maxRepairCycles > 2) {
        throw new Error('QUALITY_MAX_REPAIR_CYCLES không được vượt quá 2.');
    }

    return Object.freeze({
        pipelineMode,
        pagesPerChunk: readStrictPositiveInteger('PDF_PAGES_PER_CHUNK', 2, source),
        thinkingLevel,
        maxRepairCycles,
    });
}

export function readTranslationWorkerConcurrency(source = process.env) {
    const rawValue = source.TRANSLATION_WORKER_CONCURRENCY;
    if (rawValue === undefined || rawValue === '') return 3;
    const normalized = String(rawValue).trim();
    if (!['1', '2', '3'].includes(normalized)) {
        throw new Error('TRANSLATION_WORKER_CONCURRENCY chỉ nhận số nguyên từ 1 đến 3.');
    }
    return Number(normalized);
}

function readRatio(name, fallback, source = process.env) {
    const rawValue = source[name];
    if (rawValue === undefined || rawValue === '') return fallback;
    const normalized = String(rawValue).trim();
    const value = Number(normalized);
    if (!Number.isFinite(value) || value <= 0 || value > 1) {
        throw new Error(`${name} phải lớn hơn 0 và không vượt quá 1.`);
    }
    return value;
}

function readEnum(name, accepted, fallback, source = process.env) {
    const normalized = source[name]?.trim().toLowerCase() || fallback;
    if (!accepted.includes(normalized)) {
        throw new Error(`${name} chỉ nhận một trong các giá trị: ${accepted.join(', ')}.`);
    }
    return normalized;
}

export function readParallelSourceBudgetMb(source = process.env) {
    const rawValue = source.PARALLEL_SOURCE_BUDGET_MB;
    if (rawValue === undefined || rawValue === '') return 15;
    const normalized = String(rawValue).trim();
    const value = Number(normalized);
    if (!Number.isSafeInteger(value) || value < 10 || value > 100 || String(value) !== normalized) {
        throw new Error('PARALLEL_SOURCE_BUDGET_MB chỉ nhận số nguyên từ 10 đến 100.');
    }
    return value;
}

const p003Config = readP003Config();
export const TRANSLATION_PIPELINE_MODE = p003Config.pipelineMode;
export const PDF_PAGES_PER_CHUNK = p003Config.pagesPerChunk;
export const GEMINI_THINKING_LEVEL = p003Config.thinkingLevel;
export const QUALITY_MAX_REPAIR_CYCLES = p003Config.maxRepairCycles;
export const TRANSLATION_WORKER_CONCURRENCY = readTranslationWorkerConcurrency();
export const PARALLEL_SOURCE_BUDGET_BYTES = readParallelSourceBudgetMb() * 1024 * 1024;
export const GEMINI_SCHEDULER_MODE = readEnum(
    'GEMINI_SCHEDULER_MODE',
    ['legacy', 'project_pool'],
    'project_pool'
);
export const GEMINI_PROJECT_RPM = readPositiveInteger('GEMINI_PROJECT_RPM', 15);
export const GEMINI_PROJECT_TPM = readPositiveInteger('GEMINI_PROJECT_TPM', 250_000);
export const GEMINI_PROJECT_RPD = readPositiveInteger('GEMINI_PROJECT_RPD', 500);
export const GEMINI_PROJECT_HEADROOM = readRatio('GEMINI_PROJECT_HEADROOM', 0.9);
export const GEMINI_ACTIVE_PROJECT_LIMIT = readPositiveInteger('GEMINI_ACTIVE_PROJECT_LIMIT', 5);
export const GEMINI_PROJECT_MAX_IN_FLIGHT = readPositiveInteger('GEMINI_PROJECT_MAX_IN_FLIGHT', 2);

export const GEMINI_PROJECT_LIMITS = Object.freeze({
    rpm: Math.max(1, Math.round(GEMINI_PROJECT_RPM * GEMINI_PROJECT_HEADROOM)),
    tpm: Math.max(1, Math.floor(GEMINI_PROJECT_TPM * GEMINI_PROJECT_HEADROOM)),
    normalRpd: Math.max(1, Math.floor(GEMINI_PROJECT_RPD * GEMINI_PROJECT_HEADROOM)),
    retryRpd: Math.max(
        0,
        GEMINI_PROJECT_RPD - Math.floor(GEMINI_PROJECT_RPD * GEMINI_PROJECT_HEADROOM)
    ),
    totalRpd: GEMINI_PROJECT_RPD,
    maxInFlight: GEMINI_PROJECT_MAX_IN_FLIGHT,
});

function readRequiredString(name, missing) {
    const value = process.env[name]?.trim();
    if (!value) missing.push(name);
    return value || null;
}

export const MAX_UPLOAD_STORAGE_MB = readPositiveInteger('MAX_UPLOAD_STORAGE_MB', 400);
export const MAX_FILE_SIZE_MB = readPositiveInteger('MAX_FILE_SIZE_MB', 350);
export const MAX_JOB_ATTEMPTS = readPositiveInteger('MAX_JOB_ATTEMPTS', 3);
export const GEMINI_TIMEOUT_MS = readPositiveInteger('GEMINI_TIMEOUT_MS', 180000);
export const R2_SOURCE_RETENTION_DAYS = readPositiveInteger('R2_SOURCE_RETENTION_DAYS', 7);

export function validateRuntimeEnv() {
    const missing = [];
    const mongodbUri = readRequiredString('MONGODB_URI', missing);
    if (getGeminiApiKeys().length === 0) missing.push('GEMINI_API_KEYS');
    if (GEMINI_SCHEDULER_MODE === 'project_pool') {
        const projectIds = getGeminiProjectIds();
        if (projectIds.length === 0) missing.push('GEMINI_PROJECT_IDS');
        if (getGeminiApiKeys().length > 0 && projectIds.length > 0) {
            const projects = getGeminiProjects();
            if (GEMINI_ACTIVE_PROJECT_LIMIT > projects.length) {
                throw new Error('GEMINI_ACTIVE_PROJECT_LIMIT không được vượt quá số Gemini project đã cấu hình.');
            }
            if (GEMINI_PROJECT_MAX_IN_FLIGHT > 2) {
                throw new Error('GEMINI_PROJECT_MAX_IN_FLIGHT không được vượt quá 2 trên Render miễn phí.');
            }
        }
    }

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
        maintenanceControlToken: process.env.MAINTENANCE_CONTROL_TOKEN?.trim() || null,
        maxUploadStorageMb: MAX_UPLOAD_STORAGE_MB,
        maxFileSizeMb: MAX_FILE_SIZE_MB,
        maxJobAttempts: MAX_JOB_ATTEMPTS,
        geminiTimeoutMs: GEMINI_TIMEOUT_MS,
        gemini: Object.freeze({
            schedulerMode: GEMINI_SCHEDULER_MODE,
            activeProjectLimit: GEMINI_ACTIVE_PROJECT_LIMIT,
            projectLimits: GEMINI_PROJECT_LIMITS,
        }),
        translation: p003Config,
        r2: Object.freeze({
            accountId: r2AccountId,
            accessKeyId: r2AccessKeyId,
            secretAccessKey: r2SecretAccessKey,
            bucketName: r2BucketName,
            endpoint: parsedR2Endpoint.toString().replace(/\/$/, ''),
            region: r2Region,
            presignedUrlTtlSeconds: readPositiveInteger('R2_PRESIGNED_URL_TTL_SECONDS'),
            uploadConcurrency: readPositiveInteger('R2_UPLOAD_CONCURRENCY'),
            sourceRetentionDays: R2_SOURCE_RETENTION_DAYS,
        }),
    });
}
