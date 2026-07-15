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

export const MAX_UPLOAD_STORAGE_MB = readPositiveInteger('MAX_UPLOAD_STORAGE_MB', 400);
export const MAX_FILE_SIZE_MB = readPositiveInteger('MAX_FILE_SIZE_MB', 350);
export const MAX_JOB_ATTEMPTS = readPositiveInteger('MAX_JOB_ATTEMPTS', 3);
export const GEMINI_TIMEOUT_MS = readPositiveInteger('GEMINI_TIMEOUT_MS', 180000);

export function validateRuntimeEnv() {
    const missing = [];
    if (!process.env.MONGODB_URI?.trim()) missing.push('MONGODB_URI');
    if (getGeminiApiKeys().length === 0) missing.push('GEMINI_API_KEYS');

    if (missing.length > 0) {
        throw new Error(`Thiếu biến môi trường bắt buộc: ${missing.join(', ')}`);
    }
    if (MAX_FILE_SIZE_MB >= MAX_UPLOAD_STORAGE_MB) {
        throw new Error('MAX_FILE_SIZE_MB phải nhỏ hơn MAX_UPLOAD_STORAGE_MB để chừa dung lượng vận hành.');
    }

    return Object.freeze({
        port: readPositiveInteger('PORT', 8080),
        mongodbUri: process.env.MONGODB_URI.trim(),
        frontendUrl: process.env.FRONTEND_URL?.trim() || null,
        maxUploadStorageMb: MAX_UPLOAD_STORAGE_MB,
        maxFileSizeMb: MAX_FILE_SIZE_MB,
        maxJobAttempts: MAX_JOB_ATTEMPTS,
        geminiTimeoutMs: GEMINI_TIMEOUT_MS,
    });
}
