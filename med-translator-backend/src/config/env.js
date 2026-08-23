import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';

const configDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(configDir, '../..');

// Local runtime deliberately reads a separate override so a launcher never
// needs to place a secret in a shortcut or command line. Existing shared
// provider credentials remain in .env and local-only limits stay in .env.local.
const requestedRuntimeMode = process.env.RUNTIME_MODE?.trim().toLowerCase();
const sharedEnvFile = path.join(backendRoot, '.env');
const envFile = process.env.ENV_FILE
    ? path.resolve(process.env.ENV_FILE)
    : path.join(backendRoot, requestedRuntimeMode === 'cloud' ? '.env' : '.env.local');

// Load the shared file first without replacing shell-provided values, then let
// the explicitly selected runtime file override only its own settings.
dotenv.config({ path: sharedEnvFile, quiet: true });
if (envFile !== sharedEnvFile) {
    dotenv.config({ path: envFile, override: true, quiet: true });
}

export const GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash-lite';
export const UPLOAD_DIR = path.join(backendRoot, 'uploads');

export function readRuntimeMode(source = process.env) {
    const mode = source.RUNTIME_MODE?.trim().toLowerCase() || 'local';
    if (!['local', 'cloud'].includes(mode)) {
        throw new Error('RUNTIME_MODE chỉ nhận local hoặc cloud.');
    }
    return mode;
}

export function readAppHost(source = process.env) {
    const mode = readRuntimeMode(source);
    const host = source.APP_HOST?.trim() || (mode === 'local' ? '127.0.0.1' : '0.0.0.0');
    if (mode === 'local' && host !== '127.0.0.1') {
        throw new Error('APP_HOST của local runtime bắt buộc là 127.0.0.1. LAN/public access cần một dự án security riêng.');
    }
    return host;
}

export function readDataRoot(source = process.env) {
    const rawValue = source.DATA_ROOT?.trim() || 'D:\\StudyMedData';
    const dataRoot = path.resolve(rawValue);
    if (!path.isAbsolute(dataRoot) || dataRoot === path.parse(dataRoot).root) {
        throw new Error('DATA_ROOT phải là một thư mục tuyệt đối, không được là root của ổ đĩa.');
    }
    return dataRoot;
}

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

function readBoolean(name, fallback, source = process.env) {
    const rawValue = source[name];
    if (rawValue === undefined || rawValue === '') return fallback;
    const normalized = String(rawValue).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    throw new Error(`${name} chỉ nhận true hoặc false.`);
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
    if (rawValue === undefined || rawValue === '') {
        return readRuntimeMode(source) === 'local' ? 48 : 15;
    }
    const normalized = String(rawValue).trim();
    const value = Number(normalized);
    if (!Number.isSafeInteger(value) || value < 10 || value > 100 || String(value) !== normalized) {
        throw new Error('PARALLEL_SOURCE_BUDGET_MB chỉ nhận số nguyên từ 10 đến 100.');
    }
    return value;
}

const p003Config = readP003Config();
export const RUNTIME_MODE = readRuntimeMode();
export const APP_HOST = readAppHost();
export const DATA_ROOT = readDataRoot();
export const TRANSLATION_PIPELINE_MODE = p003Config.pipelineMode;
export const PDF_PAGES_PER_CHUNK = p003Config.pagesPerChunk;
export const GEMINI_THINKING_LEVEL = p003Config.thinkingLevel;
export const QUALITY_MAX_REPAIR_CYCLES = p003Config.maxRepairCycles;
export const GEMINI_DIAGNOSTIC_PROBE_ENABLED = readBoolean(
    'GEMINI_DIAGNOSTIC_PROBE_ENABLED',
    false
);
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
// GEMINI_ACTIVE_PROJECT_LIMIT remains a backwards-compatible alias for the
// number of eligible projects. New deployments should use the explicit fields.
export const GEMINI_ELIGIBLE_PROJECT_LIMIT = readPositiveInteger(
    'GEMINI_ELIGIBLE_PROJECT_LIMIT',
    GEMINI_ACTIVE_PROJECT_LIMIT
);
export const GEMINI_PROJECT_GROUP_SIZE = readPositiveInteger(
    'GEMINI_PROJECT_GROUP_SIZE',
    Math.min(5, GEMINI_ELIGIBLE_PROJECT_LIMIT)
);
export const GEMINI_INITIAL_CONCURRENCY = readPositiveInteger(
    'GEMINI_INITIAL_CONCURRENCY',
    Math.min(5, GEMINI_PROJECT_GROUP_SIZE)
);
export const GEMINI_MAX_CONCURRENCY = readPositiveInteger(
    'GEMINI_MAX_CONCURRENCY',
    // Backwards-compatible deploys stay at the initial concurrency until
    // phase 2 explicitly opts into growth (production phase 2 sets this to 10).
    GEMINI_INITIAL_CONCURRENCY
);
export const GEMINI_PROJECT_GROUP_ROTATION_ENABLED = readBoolean(
    'GEMINI_PROJECT_GROUP_ROTATION_ENABLED',
    false
);
export const GEMINI_PROJECT_MAX_IN_FLIGHT = readPositiveInteger('GEMINI_PROJECT_MAX_IN_FLIGHT', 2);

export const GEMINI_PROJECT_LIMITS = Object.freeze({
    rpm: Math.max(1, Math.round(GEMINI_PROJECT_RPM * GEMINI_PROJECT_HEADROOM)),
    tpm: Math.max(1, Math.floor(GEMINI_PROJECT_TPM * GEMINI_PROJECT_HEADROOM)),
    // Normal and retry share the same RPD pool. The separate counters remain
    // telemetry only; neither kind has its own hard cap.
    totalRpd: GEMINI_PROJECT_RPD,
    maxInFlight: GEMINI_PROJECT_MAX_IN_FLIGHT,
});

function readRequiredString(name, missing) {
    const value = process.env[name]?.trim();
    if (!value) missing.push(name);
    return value || null;
}

export const MAX_UPLOAD_STORAGE_MB = readPositiveInteger('MAX_UPLOAD_STORAGE_MB', 400);
export const MAX_FILE_SIZE_MB = readPositiveInteger(
    'MAX_FILE_SIZE_MB',
    RUNTIME_MODE === 'local' ? 159 : 350
);
export const MAX_JOB_ATTEMPTS = readPositiveInteger('MAX_JOB_ATTEMPTS', 3);
export const GEMINI_TIMEOUT_MS = readPositiveInteger('GEMINI_TIMEOUT_MS', 180000);
export const R2_SOURCE_RETENTION_DAYS = readPositiveInteger('R2_SOURCE_RETENTION_DAYS', 7);
// Cloud uses direct-to-R2 batches, so its control-plane requests are small and
// idempotent. Keep a separate, higher guard for them instead of applying the
// old per-PDF limit to every local upload.
export const CLOUD_DIRECT_UPLOAD_RATE_LIMIT_PER_HOUR = readPositiveInteger(
    'CLOUD_DIRECT_UPLOAD_RATE_LIMIT_PER_HOUR',
    120
);
export const CLOUD_UPLOAD_CONTROL_RATE_LIMIT_PER_HOUR = readPositiveInteger(
    'CLOUD_UPLOAD_CONTROL_RATE_LIMIT_PER_HOUR',
    600
);
export const LOCAL_DISK_RESERVE_MB = readPositiveInteger('LOCAL_DISK_RESERVE_MB', 10_240);
export const LOCAL_RESOURCE_CPU_PAUSE_PERCENT = readPositiveInteger('LOCAL_RESOURCE_CPU_PAUSE_PERCENT', 75);
export const LOCAL_RESOURCE_CPU_RESUME_PERCENT = readPositiveInteger('LOCAL_RESOURCE_CPU_RESUME_PERCENT', 50);

export function validateRuntimeEnv() {
    const missing = [];
    const runtimeMode = readRuntimeMode();
    const appHost = readAppHost();
    const mongodbUri = readRequiredString('MONGODB_URI', missing);
    if (getGeminiApiKeys().length === 0) missing.push('GEMINI_API_KEYS');
    if (GEMINI_SCHEDULER_MODE === 'project_pool') {
        const projectIds = getGeminiProjectIds();
        if (projectIds.length === 0) missing.push('GEMINI_PROJECT_IDS');
        if (getGeminiApiKeys().length > 0 && projectIds.length > 0) {
            const projects = getGeminiProjects();
            if (GEMINI_ELIGIBLE_PROJECT_LIMIT > projects.length) {
                throw new Error('GEMINI_ELIGIBLE_PROJECT_LIMIT không được vượt quá số Gemini project đã cấu hình.');
            }
            if (GEMINI_PROJECT_GROUP_SIZE > GEMINI_ELIGIBLE_PROJECT_LIMIT) {
                throw new Error('GEMINI_PROJECT_GROUP_SIZE không được vượt quá số Gemini project eligible.');
            }
            if (GEMINI_INITIAL_CONCURRENCY > GEMINI_MAX_CONCURRENCY) {
                throw new Error('GEMINI_INITIAL_CONCURRENCY không được vượt quá GEMINI_MAX_CONCURRENCY.');
            }
            if (GEMINI_MAX_CONCURRENCY > 100) {
                throw new Error('GEMINI_MAX_CONCURRENCY không được vượt quá 100.');
            }
            if (GEMINI_PROJECT_MAX_IN_FLIGHT > 2) {
                throw new Error('GEMINI_PROJECT_MAX_IN_FLIGHT không được vượt quá 2 trên Render miễn phí.');
            }
        }
    }

    const r2AccountId = runtimeMode === 'cloud' ? readRequiredString('R2_ACCOUNT_ID', missing) : null;
    const r2AccessKeyId = runtimeMode === 'cloud' ? readRequiredString('R2_ACCESS_KEY_ID', missing) : null;
    const r2SecretAccessKey = runtimeMode === 'cloud' ? readRequiredString('R2_SECRET_ACCESS_KEY', missing) : null;
    const r2BucketName = runtimeMode === 'cloud' ? readRequiredString('R2_BUCKET_NAME', missing) : null;
    const r2Endpoint = runtimeMode === 'cloud' ? readRequiredString('R2_ENDPOINT', missing) : null;
    const r2Region = runtimeMode === 'cloud' ? readRequiredString('R2_REGION', missing) : null;
    if (runtimeMode === 'cloud') {
        readRequiredString('R2_PRESIGNED_URL_TTL_SECONDS', missing);
        readRequiredString('R2_UPLOAD_CONCURRENCY', missing);
        readRequiredString('R2_SOURCE_RETENTION_DAYS', missing);
    }

    if (missing.length > 0) {
        throw new Error(`Thiếu biến môi trường bắt buộc: ${missing.join(', ')}`);
    }
    if (runtimeMode === 'cloud' && MAX_FILE_SIZE_MB >= MAX_UPLOAD_STORAGE_MB) {
        throw new Error('MAX_FILE_SIZE_MB phải nhỏ hơn MAX_UPLOAD_STORAGE_MB để chừa dung lượng vận hành.');
    }
    if (runtimeMode === 'local' && MAX_FILE_SIZE_MB > 159) {
        throw new Error('MAX_FILE_SIZE_MB của local runtime không được vượt 159 MB.');
    }
    if (LOCAL_RESOURCE_CPU_RESUME_PERCENT >= LOCAL_RESOURCE_CPU_PAUSE_PERCENT) {
        throw new Error('LOCAL_RESOURCE_CPU_RESUME_PERCENT phải nhỏ hơn LOCAL_RESOURCE_CPU_PAUSE_PERCENT.');
    }

    let parsedR2Endpoint = null;
    if (runtimeMode === 'cloud') {
        try {
            parsedR2Endpoint = new URL(r2Endpoint);
        } catch {
            throw new Error('R2_ENDPOINT phải là URL HTTPS hợp lệ.');
        }
        if (parsedR2Endpoint.protocol !== 'https:') {
            throw new Error('R2_ENDPOINT phải sử dụng HTTPS.');
        }
    }

    return Object.freeze({
        port: readPositiveInteger('PORT', 8080),
        runtimeMode,
        appHost,
        dataRoot: runtimeMode === 'local' ? readDataRoot() : null,
        mongodbUri,
        frontendUrl: process.env.FRONTEND_URL?.trim() || null,
        maintenanceControlToken: process.env.MAINTENANCE_CONTROL_TOKEN?.trim() || null,
        maxUploadStorageMb: MAX_UPLOAD_STORAGE_MB,
        maxFileSizeMb: MAX_FILE_SIZE_MB,
        maxJobAttempts: MAX_JOB_ATTEMPTS,
        geminiTimeoutMs: GEMINI_TIMEOUT_MS,
        uploadRateLimits: Object.freeze({
            cloudDirectPerHour: CLOUD_DIRECT_UPLOAD_RATE_LIMIT_PER_HOUR,
            cloudControlPerHour: CLOUD_UPLOAD_CONTROL_RATE_LIMIT_PER_HOUR,
        }),
        gemini: Object.freeze({
            schedulerMode: GEMINI_SCHEDULER_MODE,
            activeProjectLimit: GEMINI_ELIGIBLE_PROJECT_LIMIT,
            eligibleProjectLimit: GEMINI_ELIGIBLE_PROJECT_LIMIT,
            projectGroupSize: GEMINI_PROJECT_GROUP_SIZE,
            initialConcurrency: GEMINI_INITIAL_CONCURRENCY,
            maxConcurrency: GEMINI_MAX_CONCURRENCY,
            groupRotationEnabled: GEMINI_PROJECT_GROUP_ROTATION_ENABLED,
            projectLimits: GEMINI_PROJECT_LIMITS,
        }),
        translation: p003Config,
        storage: Object.freeze({
            mode: runtimeMode === 'local' ? 'local' : 'r2',
            dataRoot: runtimeMode === 'local' ? readDataRoot() : null,
            diskReserveBytes: LOCAL_DISK_RESERVE_MB * 1024 * 1024,
        }),
        resourceGovernor: Object.freeze({
            enabled: runtimeMode === 'local',
            cpuPausePercent: LOCAL_RESOURCE_CPU_PAUSE_PERCENT,
            cpuResumePercent: LOCAL_RESOURCE_CPU_RESUME_PERCENT,
            cpuPressureDurationMs: 15_000,
            recoveryDurationMs: 30_000,
            sampleIntervalMs: 5_000,
        }),
        r2: runtimeMode === 'cloud' ? Object.freeze({
            accountId: r2AccountId,
            accessKeyId: r2AccessKeyId,
            secretAccessKey: r2SecretAccessKey,
            bucketName: r2BucketName,
            endpoint: parsedR2Endpoint.toString().replace(/\/$/, ''),
            region: r2Region,
            presignedUrlTtlSeconds: readPositiveInteger('R2_PRESIGNED_URL_TTL_SECONDS'),
            uploadConcurrency: readPositiveInteger('R2_UPLOAD_CONCURRENCY'),
            sourceRetentionDays: R2_SOURCE_RETENTION_DAYS,
        }) : null,
    });
}
