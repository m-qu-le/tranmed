#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
    copyFile,
    lstat,
    mkdir,
    open,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

export const DEFAULT_SOURCE_PATH = String.raw`D:\1. File chờ dịch`;
export const DEFAULT_API_URL = 'https://tranmed-api.duckdns.org/api/translate';
export const MAX_FILES_PER_BATCH = 500;
export const MAX_BATCH_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_FILE_BYTES = 350 * 1024 * 1024;
export const UPLOAD_CONCURRENCY = 4;
export const CONFIRM_CHUNK_SIZE = 50;
export const LEDGER_VERSION = 1;

const naturalVietnamese = new Intl.Collator('vi', {
    numeric: true,
    sensitivity: 'base',
});
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export class UploaderError extends Error {
    constructor(message, { code = 'UPLOADER_ERROR', status = null, cause = null } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'UploaderError';
        this.code = code;
        this.status = status;
    }
}

export class ValidationError extends UploaderError {
    constructor(errors) {
        super('Cấu trúc hoặc file nguồn không hợp lệ.', { code: 'PREFLIGHT_FAILED' });
        this.name = 'ValidationError';
        this.errors = errors;
    }
}

export class StateError extends UploaderError {
    constructor(message, options = {}) {
        super(message, { code: 'STATE_ERROR', ...options });
        this.name = 'StateError';
    }
}

export class HttpError extends UploaderError {
    constructor(message, status = null, options = {}) {
        super(message, { code: 'HTTP_ERROR', status, ...options });
        this.name = 'HttpError';
    }
}

function normalizeForComparison(value) {
    return value.normalize('NFC').toLocaleLowerCase('vi');
}

export function normalizeApiUrl(value) {
    let parsed;
    try {
        parsed = new URL(value);
    } catch (error) {
        throw new UploaderError('API URL không hợp lệ.', { code: 'INVALID_API_URL', cause: error });
    }
    const isLocalHttp = parsed.protocol === 'http:'
        && ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !isLocalHttp) {
        throw new UploaderError('API URL phải dùng HTTPS; HTTP chỉ được phép cho localhost.', {
            code: 'INSECURE_API_URL',
        });
    }
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
}

export function sourceKeyFor(sourcePath) {
    const resolved = path.normalize(path.resolve(sourcePath));
    return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

export function resolveLedgerPath(environment = process.env) {
    const localAppData = environment.LOCALAPPDATA?.trim();
    if (!localAppData) {
        throw new StateError('Không tìm thấy LOCALAPPDATA để lưu sổ upload an toàn.');
    }
    return path.join(localAppData, 'StudyMed', 'Uploader', 'state-v1.json');
}

async function hashFile(filePath) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    return hash.digest('hex');
}

async function readPdfMagic(filePath) {
    const handle = await open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(5);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return buffer.subarray(0, bytesRead).toString('ascii');
    } finally {
        await handle.close();
    }
}

async function runPool(items, concurrency, worker) {
    let cursor = 0;
    const results = new Array(items.length);
    const runners = Array.from(
        { length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) },
        async () => {
            while (cursor < items.length) {
                const index = cursor;
                cursor += 1;
                results[index] = await worker(items[index], index);
            }
        }
    );
    await Promise.all(runners);
    return results;
}

async function inspectPdf(candidate) {
    const before = await stat(candidate.fullPath);
    if (!before.isFile()) {
        throw new UploaderError('Không còn là file thông thường.', { code: 'SOURCE_CHANGED' });
    }
    if (before.size <= 0) {
        throw new UploaderError('File rỗng.', { code: 'EMPTY_PDF' });
    }
    if (before.size > MAX_FILE_BYTES) {
        throw new UploaderError('Vượt giới hạn 350 MB mỗi file.', { code: 'PDF_TOO_LARGE' });
    }
    const magic = await readPdfMagic(candidate.fullPath);
    if (magic !== '%PDF-') {
        throw new UploaderError('Nội dung không có chữ ký %PDF-.', { code: 'INVALID_PDF_MAGIC' });
    }
    const sha256 = await hashFile(candidate.fullPath);
    const after = await stat(candidate.fullPath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new UploaderError('File đã thay đổi trong lúc kiểm tra.', { code: 'SOURCE_CHANGED' });
    }
    return {
        ...candidate,
        size: after.size,
        mtimeMs: after.mtimeMs,
        sha256,
    };
}

async function classifyEntry(parentPath, entry) {
    const fullPath = path.join(parentPath, entry.name);
    const metadata = await lstat(fullPath);
    if (metadata.isSymbolicLink()) return { kind: 'link', name: entry.name, fullPath };
    if (metadata.isDirectory()) return { kind: 'directory', name: entry.name, fullPath };
    if (metadata.isFile()) return { kind: 'file', name: entry.name, fullPath };
    return { kind: 'other', name: entry.name, fullPath };
}

export async function scanSource(sourcePath, { hashConcurrency = 4 } = {}) {
    const resolvedSource = path.resolve(sourcePath);
    let sourceMetadata;
    try {
        sourceMetadata = await lstat(resolvedSource);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            throw new ValidationError([`Không tìm thấy thư mục nguồn: ${resolvedSource}`]);
        }
        throw error;
    }
    if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isDirectory()) {
        throw new ValidationError([`Nguồn phải là thư mục thật, không phải file/junction/symlink: ${resolvedSource}`]);
    }

    const errors = [];
    const candidates = [];
    const rootEntries = await readdir(resolvedSource, { withFileTypes: true });
    const rootClassified = await Promise.all(rootEntries.map(entry => classifyEntry(resolvedSource, entry)));
    const books = rootClassified
        .filter(entry => entry.kind === 'directory')
        .sort((left, right) => naturalVietnamese.compare(left.name, right.name));

    for (const entry of rootClassified.filter(entry => entry.kind !== 'directory')) {
        errors.push(`Cấp nguồn chỉ được chứa thư mục tên sách: ${entry.fullPath}`);
    }
    if (books.length === 0) errors.push('Thư mục nguồn không có thư mục sách nào.');

    for (const book of books) {
        if (book.name.length > 120) {
            errors.push(`Tên sách vượt quá 120 ký tự: ${book.name}`);
        }
        if (book.name.localeCompare('Ưu tiên', 'vi', { sensitivity: 'base' }) === 0) {
            errors.push('Tên sách "Ưu tiên" được dành riêng cho hàng đợi ưu tiên.');
        }

        const bookEntries = await readdir(book.fullPath, { withFileTypes: true });
        const bookClassified = await Promise.all(
            bookEntries.map(entry => classifyEntry(book.fullPath, entry))
        );
        const childDirectories = bookClassified.filter(entry => entry.kind === 'directory');
        const invalidBookEntries = bookClassified.filter(entry => entry.kind !== 'directory');
        if (childDirectories.length !== 1) {
            errors.push(`Sách "${book.name}" phải có đúng một thư mục con; hiện có ${childDirectories.length}.`);
        }
        for (const entry of invalidBookEntries) {
            errors.push(`Không được đặt file/link trực tiếp trong thư mục sách: ${entry.fullPath}`);
        }
        if (childDirectories.length !== 1) continue;

        const uploadDirectory = childDirectories[0];
        const uploadEntries = await readdir(uploadDirectory.fullPath, { withFileTypes: true });
        const uploadClassified = await Promise.all(
            uploadEntries.map(entry => classifyEntry(uploadDirectory.fullPath, entry))
        );
        const pdfEntries = [];
        for (const entry of uploadClassified) {
            if (entry.kind !== 'file') {
                errors.push(`Thư mục chứa PDF không được có thư mục sâu/link: ${entry.fullPath}`);
                continue;
            }
            if (!entry.name.toLocaleLowerCase('en-US').endsWith('.pdf')) {
                errors.push(`Chỉ chấp nhận file PDF trong thư mục tải lên: ${entry.fullPath}`);
                continue;
            }
            if (entry.name.length > 255) {
                errors.push(`Tên file vượt quá 255 ký tự: ${entry.fullPath}`);
                continue;
            }
            pdfEntries.push(entry);
        }
        if (pdfEntries.length === 0) {
            errors.push(`Không tìm thấy PDF trực tiếp trong: ${uploadDirectory.fullPath}`);
            continue;
        }

        const seenNames = new Set();
        for (const entry of pdfEntries.sort((left, right) => naturalVietnamese.compare(left.name, right.name))) {
            const normalizedName = normalizeForComparison(entry.name);
            if (seenNames.has(normalizedName)) {
                errors.push(`Tên PDF bị trùng trong sách "${book.name}": ${entry.name}`);
                continue;
            }
            seenNames.add(normalizedName);
            candidates.push({
                bookName: book.name,
                uploadDirectoryName: uploadDirectory.name,
                fileName: entry.name,
                fullPath: entry.fullPath,
            });
        }
    }

    const inspected = await runPool(candidates, hashConcurrency, async candidate => {
        try {
            return await inspectPdf(candidate);
        } catch (error) {
            errors.push(`${candidate.fullPath}: ${error.message}`);
            return null;
        }
    });
    if (errors.length > 0) throw new ValidationError(errors);

    const files = inspected.filter(Boolean);
    const filesByBook = new Map();
    for (const file of files) {
        const rows = filesByBook.get(file.bookName) || [];
        rows.push(file);
        filesByBook.set(file.bookName, rows);
    }
    const scannedBooks = [...filesByBook.entries()]
        .map(([name, bookFiles]) => ({
            name,
            files: bookFiles,
            totalBytes: bookFiles.reduce((sum, file) => sum + file.size, 0),
        }))
        .sort((left, right) => naturalVietnamese.compare(left.name, right.name));

    return {
        sourcePath: resolvedSource,
        sourceKey: sourceKeyFor(resolvedSource),
        books: scannedBooks,
        files,
        totalFiles: files.length,
        totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    };
}

export function createEmptyLedger(now = new Date()) {
    return {
        version: LEDGER_VERSION,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        records: {},
        operations: {},
    };
}

function validateLedger(ledger, ledgerPath) {
    if (!ledger || ledger.version !== LEDGER_VERSION
        || typeof ledger.records !== 'object' || Array.isArray(ledger.records)
        || typeof ledger.operations !== 'object' || Array.isArray(ledger.operations)) {
        throw new StateError(
            `Sổ upload không hợp lệ hoặc khác phiên bản: ${ledgerPath}. Không tự đặt lại để tránh upload trùng.`
        );
    }
    for (const [operationId, operation] of Object.entries(ledger.operations)) {
        const valid = operation?.operationId === operationId
            && ['planned', 'ready'].includes(operation.status)
            && typeof operation.apiUrl === 'string'
            && typeof operation.sourceKey === 'string'
            && typeof operation.bookName === 'string'
            && typeof operation.clientBatchId === 'string'
            && Array.isArray(operation.files)
            && operation.files.length > 0;
        if (!valid) {
            throw new StateError(
                `Operation ${operationId} trong sổ upload bị hỏng. Không tiếp tục để tránh upload trùng.`
            );
        }
        if (operation.status === 'ready'
            && operation.files.some(file => ledger.records[file.fingerprint]?.status !== 'confirmed')) {
            throw new StateError(`Operation ${operationId} đã ready nhưng thiếu record xác nhận.`);
        }
    }
    return ledger;
}

export async function loadLedger(ledgerPath) {
    let raw;
    try {
        raw = await readFile(ledgerPath, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') {
            try {
                await stat(`${ledgerPath}.bak`);
                throw new StateError(
                    `Thiếu sổ upload chính nhưng còn bản backup: ${ledgerPath}. `
                    + 'Không tạo sổ mới để tránh upload trùng.'
                );
            } catch (backupError) {
                if (backupError instanceof StateError) throw backupError;
                if (backupError?.code === 'ENOENT') return createEmptyLedger();
                throw new StateError(`Không thể kiểm tra backup của sổ upload: ${ledgerPath}`, {
                    cause: backupError,
                });
            }
        }
        throw new StateError(`Không thể đọc sổ upload: ${ledgerPath}`, { cause: error });
    }
    try {
        return validateLedger(JSON.parse(raw), ledgerPath);
    } catch (error) {
        if (error instanceof StateError) throw error;
        throw new StateError(
            `Sổ upload bị lỗi JSON: ${ledgerPath}. Không tự đặt lại để tránh upload trùng.`,
            { cause: error }
        );
    }
}

export async function saveLedger(ledgerPath, ledger, now = new Date()) {
    const directory = path.dirname(ledgerPath);
    await mkdir(directory, { recursive: true });
    ledger.updatedAt = now.toISOString();
    const temporaryPath = `${ledgerPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporaryPath, `${JSON.stringify(ledger, null, 2)}\n`, {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600,
        });
        try {
            await copyFile(ledgerPath, `${ledgerPath}.bak`);
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
        await rename(temporaryPath, ledgerPath);
    } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => {});
        throw new StateError(`Không thể ghi sổ upload an toàn: ${ledgerPath}`, { cause: error });
    }
}

export function fingerprintFor(apiUrl, file) {
    return createHash('sha256')
        .update(JSON.stringify([
            normalizeApiUrl(apiUrl),
            file.bookName.normalize('NFC'),
            file.fileName.normalize('NFC'),
            file.sha256,
        ]))
        .digest('hex');
}

export function partitionFiles(files) {
    const chunks = [];
    let current = [];
    let currentBytes = 0;
    for (const file of files) {
        const wouldOverflow = current.length >= MAX_FILES_PER_BATCH
            || currentBytes + file.size > MAX_BATCH_BYTES;
        if (wouldOverflow && current.length > 0) {
            chunks.push(current);
            current = [];
            currentBytes = 0;
        }
        current.push(file);
        currentBytes += file.size;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
}

function createOperation({ apiUrl, sourceKey, bookName, files, now = new Date() }) {
    const operationId = randomUUID();
    return {
        operationId,
        apiUrl,
        sourceKey,
        bookName,
        status: 'planned',
        clientBatchId: randomUUID(),
        batchId: null,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        files: files.map(file => ({
            fingerprint: file.fingerprint,
            clientUploadId: randomUUID(),
            fileName: file.fileName,
            size: file.size,
            sha256: file.sha256,
        })),
    };
}

export function buildUploadPlan(scan, ledger, apiUrl) {
    const normalizedApiUrl = normalizeApiUrl(apiUrl);
    const scannedFiles = scan.files.map(file => ({
        ...file,
        fingerprint: fingerprintFor(normalizedApiUrl, file),
    }));
    const byFingerprint = new Map(scannedFiles.map(file => [file.fingerprint, file]));
    const pendingOperations = Object.values(ledger.operations)
        .filter(operation => operation.status === 'planned'
            && operation.apiUrl === normalizedApiUrl
            && operation.sourceKey === scan.sourceKey)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const pendingFingerprints = new Set();
    const conflicts = [];

    for (const operation of pendingOperations) {
        for (const file of operation.files) {
            const scanned = byFingerprint.get(file.fingerprint);
            if (!scanned) {
                conflicts.push(
                    `Batch đang dở ${operation.operationId} thiếu hoặc đã đổi file: `
                    + `${operation.bookName}\\${file.fileName}`
                );
                continue;
            }
            if (scanned.size !== file.size || scanned.sha256 !== file.sha256) {
                conflicts.push(`File của batch đang dở đã thay đổi: ${scanned.fullPath}`);
            }
            pendingFingerprints.add(file.fingerprint);
        }
    }
    if (conflicts.length > 0) throw new StateError(conflicts.join('\n'));

    const confirmedFiles = [];
    const newFiles = [];
    for (const file of scannedFiles) {
        if (ledger.records[file.fingerprint]?.status === 'confirmed') confirmedFiles.push(file);
        else if (!pendingFingerprints.has(file.fingerprint)) newFiles.push(file);
    }

    const newOperations = [];
    const newFilesByBook = new Map();
    for (const file of newFiles) {
        const rows = newFilesByBook.get(file.bookName) || [];
        rows.push(file);
        newFilesByBook.set(file.bookName, rows);
    }
    for (const [bookName, files] of [...newFilesByBook.entries()]
        .sort(([left], [right]) => naturalVietnamese.compare(left, right))) {
        for (const chunk of partitionFiles(files)) {
            newOperations.push(createOperation({
                apiUrl: normalizedApiUrl,
                sourceKey: scan.sourceKey,
                bookName,
                files: chunk,
            }));
        }
    }

    return {
        apiUrl: normalizedApiUrl,
        sourceKey: scan.sourceKey,
        scannedFiles,
        byFingerprint,
        pendingOperations,
        newOperations,
        confirmedFiles,
        newFiles,
        pendingFiles: scannedFiles.filter(file => pendingFingerprints.has(file.fingerprint)),
    };
}

export async function registerNewOperations(plan, ledger, ledgerPath) {
    for (const operation of plan.newOperations) {
        ledger.operations[operation.operationId] = operation;
    }
    if (plan.newOperations.length > 0) await saveLedger(ledgerPath, ledger);
    return [...plan.pendingOperations, ...plan.newOperations];
}

function shouldRetry(error) {
    return error instanceof HttpError
        && (!error.status || [408, 429].includes(error.status) || error.status >= 500);
}

function isExpiredSignature(error) {
    return [400, 401, 403].includes(error?.status);
}

export async function retryOperation(
    operation,
    { attempts = 3, sleep = wait, retryWhen = shouldRetry } = {}
) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await operation(attempt);
        } catch (error) {
            lastError = error;
            if (attempt === attempts || !retryWhen(error)) throw error;
            await sleep(300 * (2 ** (attempt - 1)));
        }
    }
    throw lastError;
}

async function readResponseJson(response) {
    const text = await response.text();
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new HttpError('Server trả dữ liệu không phải JSON hợp lệ.', response.status, {
            cause: error,
        });
    }
}

export function createApiClient({
    apiUrl,
    fetchImpl = globalThis.fetch,
    sleep = wait,
    apiTimeoutMs = 60_000,
} = {}) {
    const normalizedApiUrl = normalizeApiUrl(apiUrl);
    if (typeof fetchImpl !== 'function') {
        throw new UploaderError('Môi trường Node không có fetch.', { code: 'FETCH_UNAVAILABLE' });
    }

    const requestJson = async (method, targetUrl, body = undefined) => retryOperation(async () => {
        let response;
        try {
            response = await fetchImpl(targetUrl, {
                method,
                headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
                redirect: 'error',
                signal: AbortSignal.timeout(apiTimeoutMs),
            });
        } catch (error) {
            throw new HttpError('Không kết nối được tới StudyMed.', null, { cause: error });
        }
        const payload = await readResponseJson(response);
        if (!response.ok) {
            throw new HttpError(
                typeof payload?.error === 'string' ? payload.error : `StudyMed trả HTTP ${response.status}.`,
                response.status
            );
        }
        return payload;
    }, { sleep });

    return {
        apiUrl: normalizedApiUrl,
        async checkAvailability() {
            const origin = new URL(normalizedApiUrl).origin;
            const [readiness, status] = await Promise.all([
                requestJson('GET', `${origin}/api/readiness`),
                requestJson('GET', `${normalizedApiUrl}/status`),
            ]);
            if (readiness.status !== 'ready'
                || readiness.database?.available !== true
                || readiness.storage?.available !== true) {
                throw new UploaderError('Backend, MongoDB hoặc R2 chưa sẵn sàng.', {
                    code: 'BACKEND_NOT_READY',
                });
            }
            if (status.isMaintenancePaused) {
                throw new UploaderError('StudyMed đang tạm dừng để bảo trì/redeploy.', {
                    code: 'MAINTENANCE_PAUSED',
                });
            }
            if (status.storage?.available !== true) {
                throw new UploaderError('Cloudflare R2 hiện không sẵn sàng.', {
                    code: 'STORAGE_UNAVAILABLE',
                });
            }
            return { readiness, status };
        },
        prepare(manifest) {
            return requestJson('POST', `${normalizedApiUrl}/upload-batches/prepare`, manifest);
        },
        confirm(batchId, jobIds) {
            return requestJson(
                'POST',
                `${normalizedApiUrl}/upload-batches/${encodeURIComponent(batchId)}/confirm`,
                { items: jobIds.map(jobId => ({ jobId })) }
            );
        },
        getBatchStatus(batchId) {
            return requestJson(
                'GET',
                `${normalizedApiUrl}/upload-batches/${encodeURIComponent(batchId)}`
            );
        },
    };
}

export async function putPdfToR2({
    uploadUrl,
    filePath,
    size,
    requiredHeaders = {},
    fetchImpl = globalThis.fetch,
    timeoutMs = 15 * 60_000,
}) {
    let target;
    try {
        target = new URL(uploadUrl);
    } catch (error) {
        throw new UploaderError('Backend trả URL upload R2 không hợp lệ.', {
            code: 'INVALID_UPLOAD_URL',
            cause: error,
        });
    }
    if (target.protocol !== 'https:' || !target.hostname.endsWith('.r2.cloudflarestorage.com')) {
        throw new UploaderError('Từ chối upload tới host không phải Cloudflare R2.', {
            code: 'UNTRUSTED_UPLOAD_HOST',
        });
    }
    let response;
    try {
        response = await fetchImpl(target, {
            method: 'PUT',
            headers: {
                ...requiredHeaders,
                'Content-Type': 'application/pdf',
                'Content-Length': String(size),
            },
            body: createReadStream(filePath),
            duplex: 'half',
            redirect: 'error',
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (error) {
        throw new HttpError('Kết nối upload R2 bị gián đoạn.', null, { cause: error });
    }
    if (!response.ok) {
        await response.text().catch(() => {});
        throw new HttpError(`Cloudflare R2 trả HTTP ${response.status}.`, response.status);
    }
    await response.arrayBuffer();
}

function buildManifest(operation) {
    return {
        clientBatchId: operation.clientBatchId,
        folderName: operation.bookName,
        priority: false,
        files: operation.files.map(file => ({
            clientUploadId: file.clientUploadId,
            name: file.fileName,
            size: file.size,
            type: 'application/pdf',
        })),
    };
}

function validatePrepared(operation, prepared) {
    if (!prepared || typeof prepared.batchId !== 'string' || !Array.isArray(prepared.items)) {
        throw new StateError('Response prepare không đúng contract.');
    }
    if (operation.batchId && operation.batchId !== prepared.batchId) {
        throw new StateError(`Server đổi batchId của operation ${operation.operationId}.`);
    }
    if (prepared.items.length !== operation.files.length) {
        throw new StateError(`Số file prepare không khớp operation ${operation.operationId}.`);
    }
    const byClientUploadId = new Map();
    for (const item of prepared.items) {
        if (!item || typeof item.clientUploadId !== 'string'
            || byClientUploadId.has(item.clientUploadId)) {
            throw new StateError('Response prepare có clientUploadId thiếu hoặc trùng.');
        }
        byClientUploadId.set(item.clientUploadId, item);
    }
    for (const file of operation.files) {
        const item = byClientUploadId.get(file.clientUploadId);
        if (!item || item.name !== file.fileName || item.size !== file.size
            || typeof item.jobId !== 'string') {
            throw new StateError(`Server trả manifest khác cho file ${file.fileName}.`);
        }
        if (item.status === 'uploading' && typeof item.uploadUrl !== 'string') {
            throw new StateError(`File ${file.fileName} thiếu URL upload.`);
        }
    }
    return byClientUploadId;
}

async function assertFileUnchanged(sourceFile) {
    const current = await stat(sourceFile.fullPath);
    if (!current.isFile()
        || current.size !== sourceFile.size
        || current.mtimeMs !== sourceFile.mtimeMs) {
        throw new UploaderError(`File đã thay đổi sau preflight: ${sourceFile.fullPath}`, {
            code: 'SOURCE_CHANGED',
        });
    }
}

function markConfirmed(ledger, operation, operationFile, item, now = new Date()) {
    ledger.records[operationFile.fingerprint] = {
        status: 'confirmed',
        apiUrl: operation.apiUrl,
        bookName: operation.bookName,
        fileName: operationFile.fileName,
        size: operationFile.size,
        sha256: operationFile.sha256,
        operationId: operation.operationId,
        batchId: operation.batchId,
        jobId: item.jobId,
        confirmedAt: now.toISOString(),
    };
}

export async function executeOperation({
    operation,
    filesByFingerprint,
    ledger,
    ledgerPath,
    apiClient,
    putFile = putPdfToR2,
    uploadConcurrency = UPLOAD_CONCURRENCY,
    confirmChunkSize = CONFIRM_CHUNK_SIZE,
    sleep = wait,
    onProgress = () => {},
}) {
    const manifest = buildManifest(operation);
    let prepared = await apiClient.prepare(manifest);
    let preparedByClientId = validatePrepared(operation, prepared);
    operation.batchId = prepared.batchId;
    operation.updatedAt = new Date().toISOString();
    await saveLedger(ledgerPath, ledger);

    const uploadItems = operation.files
        .map(operationFile => ({
            operationFile,
            item: preparedByClientId.get(operationFile.clientUploadId),
            sourceFile: filesByFingerprint.get(operationFile.fingerprint),
        }))
        .filter(row => row.item.status === 'uploading');
    const failures = [];

    const uploadResults = await runPool(uploadItems, uploadConcurrency, async row => {
        if (!row.sourceFile) {
            const error = new StateError(`Không còn file nguồn cho ${row.operationFile.fileName}.`);
            failures.push({ row, error });
            return null;
        }
        try {
            await assertFileUnchanged(row.sourceFile);
            let currentItem = row.item;
            for (let refreshAttempt = 1; refreshAttempt <= 3; refreshAttempt += 1) {
                try {
                    await retryOperation(
                        () => putFile({
                            uploadUrl: currentItem.uploadUrl,
                            filePath: row.sourceFile.fullPath,
                            size: row.sourceFile.size,
                            requiredHeaders: currentItem.requiredHeaders || {},
                        }),
                        { retryWhen: shouldRetry, sleep }
                    );
                    onProgress({
                        type: 'uploaded',
                        bookName: operation.bookName,
                        fileName: row.operationFile.fileName,
                    });
                    return { ...row, item: currentItem };
                } catch (error) {
                    if (!isExpiredSignature(error) || refreshAttempt === 3) throw error;
                    prepared = await apiClient.prepare(manifest);
                    preparedByClientId = validatePrepared(operation, prepared);
                    currentItem = preparedByClientId.get(row.operationFile.clientUploadId);
                    if (currentItem.status !== 'uploading' || !currentItem.uploadUrl) {
                        return { ...row, item: currentItem, alreadyConfirmed: true };
                    }
                }
            }
        } catch (error) {
            failures.push({ row, error });
            onProgress({
                type: 'upload-error',
                bookName: operation.bookName,
                fileName: row.operationFile.fileName,
                error,
            });
        }
        return null;
    });

    const uploadedRows = uploadResults.filter(result => result && !result.alreadyConfirmed);
    for (let index = 0; index < uploadedRows.length; index += confirmChunkSize) {
        const chunk = uploadedRows.slice(index, index + confirmChunkSize);
        const confirmation = await apiClient.confirm(
            operation.batchId,
            chunk.map(row => row.item.jobId)
        );
        const confirmedByJobId = new Map(
            (confirmation.items || []).map(item => [item?.jobId, item])
        );
        for (const row of chunk) {
            const confirmed = confirmedByJobId.get(row.item.jobId);
            if (!confirmed) {
                throw new StateError(`Confirm thiếu job ${row.item.jobId}.`);
            }
            markConfirmed(ledger, operation, row.operationFile, confirmed);
        }
        await saveLedger(ledgerPath, ledger);
        onProgress({
            type: 'confirmed',
            bookName: operation.bookName,
            count: chunk.length,
        });
    }

    const batchStatus = await apiClient.getBatchStatus(operation.batchId);
    const fullyConfirmed = batchStatus.canCloseClient === true
        && batchStatus.confirmedFiles === operation.files.length
        && (batchStatus.skippedFiles || 0) === 0;
    if (failures.length > 0 || !fullyConfirmed) {
        const failedNames = failures.map(failure => failure.row.operationFile.fileName);
        throw new UploaderError(
            `Batch "${operation.bookName}" chưa an toàn trên Cloud`
            + `${failedNames.length ? `; file lỗi: ${failedNames.join(', ')}` : ''}.`,
            { code: 'BATCH_NOT_SAFE' }
        );
    }

    const currentPrepared = await apiClient.prepare(manifest);
    const finalItems = validatePrepared(operation, currentPrepared);
    for (const operationFile of operation.files) {
        markConfirmed(
            ledger,
            operation,
            operationFile,
            finalItems.get(operationFile.clientUploadId)
        );
    }
    operation.status = 'ready';
    operation.updatedAt = new Date().toISOString();
    operation.readyAt = new Date().toISOString();
    await saveLedger(ledgerPath, ledger);
    return batchStatus;
}

function formatMiB(bytes) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatPlanSummary(scan, plan) {
    const lines = [
        '',
        '===== STUDYMED LOCAL UPLOADER =====',
        `Nguồn: ${scan.sourcePath}`,
        `Đích:  ${plan.apiUrl}`,
        `Tổng:  ${scan.books.length} sách · ${scan.totalFiles} PDF · ${formatMiB(scan.totalBytes)}`,
        `Mới:   ${plan.newFiles.length} PDF`,
        `Resume:${plan.pendingFiles.length} PDF`,
        `Đã tải:${plan.confirmedFiles.length} PDF`,
        '',
    ];
    for (const book of scan.books) {
        const newCount = plan.newFiles.filter(file => file.bookName === book.name).length;
        const pendingCount = plan.pendingFiles.filter(file => file.bookName === book.name).length;
        const confirmedCount = plan.confirmedFiles.filter(file => file.bookName === book.name).length;
        lines.push(
            `- ${book.name}: ${book.files.length} file`
            + ` (mới ${newCount}, resume ${pendingCount}, đã tải ${confirmedCount})`
        );
    }
    return lines.join('\n');
}

export function parseArguments(argv) {
    const options = {
        sourcePath: DEFAULT_SOURCE_PATH,
        apiUrl: DEFAULT_API_URL,
        dryRun: false,
        assumeYes: false,
        help: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--dry-run') options.dryRun = true;
        else if (argument === '--yes') options.assumeYes = true;
        else if (argument === '--help' || argument === '-h') options.help = true;
        else if (argument === '--source') {
            const value = argv[index + 1];
            if (!value) throw new UploaderError('--source cần một đường dẫn.', { code: 'INVALID_ARGUMENT' });
            options.sourcePath = value;
            index += 1;
        } else if (argument === '--api-url') {
            const value = argv[index + 1];
            if (!value) throw new UploaderError('--api-url cần một URL.', { code: 'INVALID_ARGUMENT' });
            options.apiUrl = value;
            index += 1;
        } else {
            throw new UploaderError(`Tham số không hỗ trợ: ${argument}`, { code: 'INVALID_ARGUMENT' });
        }
    }
    options.apiUrl = normalizeApiUrl(options.apiUrl);
    return options;
}

function printHelp(output = console.log) {
    output(`StudyMed Local Uploader

Cách dùng:
  node scripts/local-uploader.js [--source <thư mục>] [--api-url <URL>] [--dry-run] [--yes]

Mặc định:
  --source  "${DEFAULT_SOURCE_PATH}"
  --api-url "${DEFAULT_API_URL}"

--dry-run chỉ quét và đối chiếu ledger, không gọi mạng và không ghi trạng thái.
--yes bỏ qua câu hỏi xác nhận; chỉ dùng cho automation đã được chủ hệ thống phê duyệt.`);
}

async function askForConfirmation({ input = process.stdin, output = process.stdout } = {}) {
    if (!input.isTTY) return false;
    const terminal = createInterface({ input, output });
    try {
        const answer = (await terminal.question(
            '\nTạo các job dịch thật trên production? Nhập Y để tiếp tục [y/N]: '
        )).trim().toLocaleLowerCase('vi');
        return ['y', 'yes', 'có', 'co'].includes(answer);
    } finally {
        terminal.close();
    }
}

export async function runCli({
    argv = process.argv.slice(2),
    environment = process.env,
    input = process.stdin,
    output = process.stdout,
    errorOutput = process.stderr,
    apiClientFactory = createApiClient,
} = {}) {
    const writeLine = value => output.write(`${value}\n`);
    const writeError = value => errorOutput.write(`${value}\n`);
    try {
        const options = parseArguments(argv);
        if (options.help) {
            printHelp(writeLine);
            return 0;
        }
        writeLine('Đang kiểm tra cấu trúc và tính SHA-256 cho các PDF...');
        const scan = await scanSource(options.sourcePath);
        const ledgerPath = resolveLedgerPath(environment);
        const ledger = await loadLedger(ledgerPath);
        const plan = buildUploadPlan(scan, ledger, options.apiUrl);
        writeLine(formatPlanSummary(scan, plan));

        if (options.dryRun) {
            writeLine('\nDRY-RUN hoàn tất: không gọi mạng, không ghi ledger, không tạo job.');
            return 0;
        }
        const operationCount = plan.pendingOperations.length + plan.newOperations.length;
        if (operationCount === 0) {
            writeLine('\nKhông có file mới hoặc batch dang dở. Không tạo request upload.');
            return 0;
        }
        if (options.assumeYes) {
            writeLine('\nĐã nhận --yes: tiếp tục upload theo phê duyệt automation.');
        } else if (!await askForConfirmation({ input, output })) {
            writeLine('\nĐã hủy. Chưa tạo job hoặc thay đổi ledger.');
            return 0;
        }

        writeLine('\nĐang kiểm tra production, MongoDB và R2...');
        const apiClient = apiClientFactory({ apiUrl: plan.apiUrl });
        await apiClient.checkAvailability();
        const operations = await registerNewOperations(plan, ledger, ledgerPath);
        const filesByFingerprint = new Map(
            plan.scannedFiles.map(file => [file.fingerprint, file])
        );
        let completedOperations = 0;
        for (const operation of operations) {
            writeLine(`\n[${completedOperations + 1}/${operations.length}] Upload sách: ${operation.bookName}`);
            await executeOperation({
                operation,
                filesByFingerprint,
                ledger,
                ledgerPath,
                apiClient,
                onProgress(event) {
                    if (event.type === 'uploaded') writeLine(`  ↑ ${event.fileName}`);
                    if (event.type === 'confirmed') writeLine(`  ✓ Đã xác nhận ${event.count} file`);
                    if (event.type === 'upload-error') {
                        writeError(`  ✗ ${event.fileName}: ${event.error.message}`);
                    }
                },
            });
            completedOperations += 1;
            writeLine(`  ✓ Batch an toàn trên Cloud: ${operation.batchId}`);
        }
        writeLine(`\nHOÀN TẤT: ${completedOperations}/${operations.length} batch an toàn trên Cloud.`);
        writeLine('Có thể đóng cửa sổ; backend sẽ tiếp tục dịch.');
        return 0;
    } catch (error) {
        if (error instanceof ValidationError) {
            writeError('\nPREFLIGHT THẤT BẠI — chưa tạo job:');
            for (const detail of error.errors) writeError(`- ${detail}`);
        } else {
            writeError(`\nLỖI [${error.code || 'UNKNOWN'}]: ${error.message}`);
        }
        return 1;
    }
}

const invokedAsScript = process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
    process.exitCode = await runCli();
}
