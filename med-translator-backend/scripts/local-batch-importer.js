#!/usr/bin/env node

import { openAsBlob } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import {
    DEFAULT_SOURCE_PATH,
    HttpError,
    StateError,
    UploaderError,
    ValidationError,
    buildUploadPlan,
    createEmptyLedger,
    registerNewOperations,
    retryOperation,
    saveLedger,
    scanSource,
    retryAfterMs,
} from './local-uploader.js';

export const LOCAL_API_URL = 'http://127.0.0.1:8080/api/translate';
export const LOCAL_MAX_FILE_BYTES = 159 * 1024 * 1024;
export const LOCAL_UPLOAD_TIMEOUT_MS = 15 * 60_000;

const RETRYABLE_STATUS_CODES = new Set([408, 429]);

function wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function isRetryableUploadError(error) {
    return error instanceof HttpError
        && (!error.status || RETRYABLE_STATUS_CODES.has(error.status) || error.status >= 500);
}

function ensureFixedLocalApiUrl(value) {
    if (value !== LOCAL_API_URL) {
        throw new StateError('Local importer chỉ được phép gửi PDF tới StudyMed tại 127.0.0.1:8080.');
    }
    return value;
}

export function resolveLocalLedgerPath(environment = process.env) {
    const localAppData = environment.LOCALAPPDATA?.trim();
    if (!localAppData) {
        throw new StateError('Không tìm thấy LOCALAPPDATA để lưu sổ nạp local an toàn.');
    }
    return path.join(localAppData, 'StudyMed', 'LocalImporter', 'state-v1.json');
}

export function parseLocalArguments(argv) {
    const options = {
        sourcePath: DEFAULT_SOURCE_PATH,
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
        } else {
            throw new UploaderError(`Tham số không hỗ trợ: ${argument}`, { code: 'INVALID_ARGUMENT' });
        }
    }
    return options;
}

function printHelp(output = console.log) {
    output(`StudyMed Local Importer

Cách dùng:
  node scripts/local-batch-importer.js [--source <thư mục>] [--dry-run] [--yes]

Mặc định:
  --source "${DEFAULT_SOURCE_PATH}"
  --đích   "${LOCAL_API_URL}"

Chỉ nhận StudyMed local đang sẵn sàng tại 127.0.0.1:8080.
Mỗi lần chạy là một phiên nạp độc lập; PDF có thể được nạp lại ở lần chạy sau.
--dry-run chỉ quét và lập kế hoạch cho phiên mới, không gọi API và không ghi trạng thái.
--yes bỏ qua câu hỏi xác nhận; chỉ dùng cho automation đã được chủ hệ thống phê duyệt.`);
}

function formatMegabytes(bytes) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatLocalPlanSummary(scan, plan) {
    const lines = [
        '',
        '===== STUDYMED LOCAL IMPORTER =====',
        `Nguồn: ${scan.sourcePath}`,
        `Đích:  ${LOCAL_API_URL}`,
        `Tổng:  ${scan.books.length} sách · ${scan.totalFiles} PDF · ${formatMegabytes(scan.totalBytes)}`,
        `Phiên mới: ${plan.newFiles.length} PDF sẽ được nạp`,
        'Mỗi lần chạy độc lập; không tiếp tục hoặc bỏ qua PDF theo lần chạy trước.',
        '',
    ];
    for (const book of scan.books) {
        const newCount = plan.newFiles.filter(file => file.bookName === book.name).length;
        const pendingCount = plan.pendingFiles.filter(file => file.bookName === book.name).length;
        const confirmedCount = plan.confirmedFiles.filter(file => file.bookName === book.name).length;
        lines.push(
            `- ${book.name}: ${book.files.length} file`
            + ` (mới ${newCount}, resume ${pendingCount}, đã nạp ${confirmedCount})`
        );
    }
    return lines.join('\n');
}

export function validateLocalFileLimits(scan) {
    const oversized = scan.files.filter(file => file.size > LOCAL_MAX_FILE_BYTES);
    if (oversized.length === 0) return scan;
    throw new ValidationError(oversized.map(file => (
        `${file.fullPath}: vượt giới hạn local 159 MB mỗi PDF.`
    )));
}

async function readResponseJson(response) {
    const text = await response.text();
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new HttpError('StudyMed local trả dữ liệu không phải JSON hợp lệ.', response.status, {
            cause: error,
        });
    }
}

async function requestJson({ fetchImpl, url, timeoutMs }) {
    let response;
    try {
        response = await fetchImpl(url, {
            method: 'GET',
            redirect: 'error',
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (error) {
        throw new UploaderError(
            'Không kết nối được tới StudyMed local. Hãy chạy Start StudyMed Local.cmd trước.',
            { code: 'BACKEND_NOT_READY', cause: error }
        );
    }
    const payload = await readResponseJson(response);
    if (!response.ok) {
        throw new UploaderError(
            typeof payload?.error === 'string' ? payload.error : `StudyMed local trả HTTP ${response.status}.`,
            { code: 'BACKEND_NOT_READY', status: response.status }
        );
    }
    return payload;
}

export async function checkLocalAvailability({
    fetchImpl = globalThis.fetch,
    apiUrl = LOCAL_API_URL,
    timeoutMs = 10_000,
} = {}) {
    ensureFixedLocalApiUrl(apiUrl);
    if (typeof fetchImpl !== 'function') {
        throw new UploaderError('Môi trường Node không có fetch.', { code: 'FETCH_UNAVAILABLE' });
    }
    const origin = new URL(apiUrl).origin;
    const [readiness, status] = await Promise.all([
        requestJson({ fetchImpl, url: `${origin}/api/readiness`, timeoutMs }),
        requestJson({ fetchImpl, url: `${apiUrl}/status`, timeoutMs }),
    ]);
    if (readiness.status !== 'ready'
        || readiness.runtimeMode !== 'local'
        || readiness.database?.available !== true
        || readiness.storage?.available !== true
        || readiness.storage?.mode !== 'local') {
        throw new UploaderError(
            'StudyMed local, MongoDB hoặc vùng lưu trữ local chưa sẵn sàng.',
            { code: 'BACKEND_NOT_READY' }
        );
    }
    if (status.isMaintenancePaused || status.storage?.available !== true || status.storage?.mode !== 'local') {
        throw new UploaderError(
            'StudyMed local đang tạm dừng hoặc vùng lưu trữ chưa sẵn sàng.',
            { code: 'BACKEND_NOT_READY' }
        );
    }
    return { readiness, status };
}

export async function assertSourceUnchanged(sourceFile) {
    let current;
    try {
        current = await stat(sourceFile.fullPath);
    } catch (error) {
        throw new UploaderError(`Không thể đọc lại file nguồn: ${sourceFile.fullPath}`, {
            code: 'SOURCE_CHANGED',
            cause: error,
        });
    }
    if (!current.isFile()
        || current.size !== sourceFile.size
        || current.mtimeMs !== sourceFile.mtimeMs) {
        throw new UploaderError(`File đã thay đổi sau preflight: ${sourceFile.fullPath}`, {
            code: 'SOURCE_CHANGED',
        });
    }
}

export function createLocalApiClient({
    apiUrl = LOCAL_API_URL,
    fetchImpl = globalThis.fetch,
    openBlob = openAsBlob,
    sleep = wait,
    uploadTimeoutMs = LOCAL_UPLOAD_TIMEOUT_MS,
} = {}) {
    ensureFixedLocalApiUrl(apiUrl);
    if (typeof fetchImpl !== 'function') {
        throw new UploaderError('Môi trường Node không có fetch.', { code: 'FETCH_UNAVAILABLE' });
    }
    if (typeof openBlob !== 'function') {
        throw new UploaderError('Node.js không hỗ trợ đọc PDF dạng stream.', { code: 'BLOB_UNAVAILABLE' });
    }

    return {
        checkAvailability: options => checkLocalAvailability({ fetchImpl, apiUrl, ...options }),
        async uploadFile({ sourceFile, folderName, clientUploadId }) {
            if (!clientUploadId) {
                throw new StateError(`Thiếu clientUploadId bền vững cho ${sourceFile?.fileName || 'PDF'}.`);
            }
            return retryOperation(async () => {
                await assertSourceUnchanged(sourceFile);
                const pdfBlob = await openBlob(sourceFile.fullPath, { type: 'application/pdf' });
                const form = new FormData();
                form.append('files', pdfBlob, sourceFile.fileName);
                form.append('folderName', folderName);
                form.append('priority', 'false');
                form.append('clientUploadId', clientUploadId);

                let response;
                try {
                    response = await fetchImpl(apiUrl, {
                        method: 'POST',
                        body: form,
                        redirect: 'error',
                        signal: AbortSignal.timeout(uploadTimeoutMs),
                    });
                } catch (error) {
                    throw new HttpError('Không kết nối được tới StudyMed local khi nạp PDF.', null, {
                        cause: error,
                    });
                }
                const payload = await readResponseJson(response);
                if (!response.ok) {
                    throw new HttpError(
                        typeof payload?.error === 'string'
                            ? payload.error
                            : `StudyMed local trả HTTP ${response.status} khi nạp PDF.`,
                        response.status,
                        { retryAfterMs: retryAfterMs(response, payload) }
                    );
                }
                const job = payload?.jobs?.[0];
                if (!job?.jobId) {
                    throw new UploaderError('StudyMed local chưa xác nhận job sau khi nhận PDF.', {
                        code: 'LOCAL_UPLOAD_UNCONFIRMED',
                    });
                }
                return job;
            }, { attempts: 3, sleep, retryWhen: isRetryableUploadError });
        },
    };
}

export function markLocalConfirmed(ledger, operation, operationFile, job, now = new Date()) {
    ledger.records[operationFile.fingerprint] = {
        status: 'confirmed',
        apiUrl: LOCAL_API_URL,
        bookName: operation.bookName,
        fileName: operationFile.fileName,
        size: operationFile.size,
        sha256: operationFile.sha256,
        operationId: operation.operationId,
        batchId: `local-${operation.clientBatchId}`,
        jobId: job.jobId,
        confirmedAt: now.toISOString(),
    };
}

export async function executeLocalOperation({
    operation,
    filesByFingerprint,
    ledger,
    ledgerPath,
    apiClient,
    onProgress = () => {},
}) {
    for (const operationFile of operation.files) {
        if (ledger.records[operationFile.fingerprint]?.status === 'confirmed') continue;
        const sourceFile = filesByFingerprint.get(operationFile.fingerprint);
        if (!sourceFile) {
            throw new StateError(`Không tìm thấy file của batch dở: ${operation.bookName}\\${operationFile.fileName}`);
        }
        const job = await apiClient.uploadFile({
            sourceFile,
            folderName: operation.bookName,
            clientUploadId: operationFile.clientUploadId,
        });
        markLocalConfirmed(ledger, operation, operationFile, job);
        await saveLedger(ledgerPath, ledger);
        onProgress({ type: 'confirmed', fileName: operationFile.fileName, jobId: job.jobId });
    }
    operation.batchId = `local-${operation.clientBatchId}`;
    operation.status = 'ready';
    operation.updatedAt = new Date().toISOString();
    operation.readyAt = new Date().toISOString();
    await saveLedger(ledgerPath, ledger);
    return operation;
}

async function askForConfirmation({ input = process.stdin, output = process.stdout } = {}) {
    if (!input.isTTY) return false;
    const terminal = createInterface({ input, output });
    try {
        const answer = (await terminal.question(
            '\nTạo các job dịch thật trong StudyMed local? Nhập Y để tiếp tục [y/N]: '
        )).trim().toLocaleLowerCase('vi');
        return ['y', 'yes', 'có', 'co'].includes(answer);
    } finally {
        terminal.close();
    }
}

export async function runLocalImporterCli({
    argv = process.argv.slice(2),
    environment = process.env,
    input = process.stdin,
    output = process.stdout,
    errorOutput = process.stderr,
    apiClientFactory = createLocalApiClient,
} = {}) {
    const writeLine = value => output.write(`${value}\n`);
    const writeError = value => errorOutput.write(`${value}\n`);
    try {
        const options = parseLocalArguments(argv);
        if (options.help) {
            printHelp(writeLine);
            return 0;
        }

        const apiClient = apiClientFactory();
        if (!options.dryRun) {
            writeLine('Đang kiểm tra StudyMed local, MongoDB và vùng lưu trữ...');
            await apiClient.checkAvailability();
        }

        writeLine('Đang kiểm tra cấu trúc và tính SHA-256 cho các PDF...');
        const scan = validateLocalFileLimits(await scanSource(options.sourcePath));
        const ledgerPath = resolveLocalLedgerPath(environment);
        // Chỉ dùng ledger để checkpoint trong lần chạy hiện tại. Không đọc ledger cũ,
        // vì người dùng chủ động chọn để các lần nạp hoàn toàn độc lập.
        const ledger = createEmptyLedger();
        const plan = buildUploadPlan(scan, ledger, LOCAL_API_URL);
        writeLine(formatLocalPlanSummary(scan, plan));

        if (options.dryRun) {
            writeLine('\nDRY-RUN hoàn tất: không gọi API, không ghi ledger, không tạo job.');
            return 0;
        }
        const operationCount = plan.pendingOperations.length + plan.newOperations.length;
        if (operationCount === 0) {
            writeLine('\nKhông có PDF mới hoặc batch dở. Không tạo request upload.');
            return 0;
        }
        if (options.assumeYes) {
            writeLine('\nĐã nhận --yes: tiếp tục nạp theo phê duyệt automation.');
        } else if (!await askForConfirmation({ input, output })) {
            writeLine('\nĐã hủy. Chưa tạo job hoặc thay đổi ledger.');
            return 0;
        }

        await apiClient.checkAvailability();
        const operations = await registerNewOperations(plan, ledger, ledgerPath);
        let completedOperations = 0;
        for (const operation of operations) {
            writeLine(`\n[${completedOperations + 1}/${operations.length}] Nạp sách: ${operation.bookName}`);
            await executeLocalOperation({
                operation,
                filesByFingerprint: plan.byFingerprint,
                ledger,
                ledgerPath,
                apiClient,
                onProgress(event) {
                    if (event.type === 'confirmed') {
                        writeLine(`  ✓ Đã nạp ${event.fileName} (job ${event.jobId})`);
                    }
                },
            });
            completedOperations += 1;
            writeLine(`  ✓ Đã nạp an toàn ${operation.bookName}.`);
        }
        writeLine(`\nHOÀN TẤT: ${completedOperations}/${operations.length} batch đã nạp an toàn vào StudyMed local.`);
        writeLine('Có thể đóng cửa sổ; backend sẽ tiếp tục dịch. File nguồn vẫn được giữ nguyên.');
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
    process.exitCode = await runLocalImporterCli();
}
