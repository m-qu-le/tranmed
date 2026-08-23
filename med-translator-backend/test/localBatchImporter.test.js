import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    LOCAL_API_URL,
    LOCAL_MAX_FILE_BYTES,
    assertSourceUnchanged,
    checkLocalAvailability,
    createLocalApiClient,
    executeLocalOperation,
    parseLocalArguments,
    resolveLocalLedgerPath,
    runLocalImporterCli,
    validateLocalFileLimits,
} from '../scripts/local-batch-importer.js';
import {
    ValidationError,
    buildUploadPlan,
    createEmptyLedger,
    loadLedger,
    saveLedger,
} from '../scripts/local-uploader.js';

const PDF_BYTES = Buffer.from('%PDF-1.7\n% StudyMed local importer fixture\n');

async function createTempRoot(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studymed-local-importer-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}

async function createSourceFile(root, fileName, bytes = PDF_BYTES) {
    const fullPath = path.join(root, fileName);
    await fs.writeFile(fullPath, bytes);
    const metadata = await stat(fullPath);
    return {
        bookName: 'Nội khoa',
        fileName,
        fullPath,
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
        sha256: `${fileName.charCodeAt(0)}`.repeat(64).slice(0, 64),
    };
}

function sourceScan(root, files) {
    return {
        sourcePath: root,
        sourceKey: root.toLowerCase(),
        books: [{
            name: 'Nội khoa',
            files,
            totalBytes: files.reduce((sum, file) => sum + file.size, 0),
        }],
        files,
        totalFiles: files.length,
        totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    };
}

function readyResponse(url) {
    if (String(url).endsWith('/api/readiness')) {
        return new Response(JSON.stringify({
            status: 'ready',
            runtimeMode: 'local',
            database: { available: true },
            storage: { available: true, mode: 'local' },
        }), { status: 200 });
    }
    return new Response(JSON.stringify({
        isMaintenancePaused: false,
        storage: { available: true, mode: 'local' },
    }), { status: 200 });
}

test('local importer only accepts its fixed loopback protocol and arguments', () => {
    assert.deepEqual(parseLocalArguments([]), {
        sourcePath: String.raw`D:\1. File chờ dịch`,
        dryRun: false,
        assumeYes: false,
        help: false,
    });
    assert.deepEqual(parseLocalArguments(['--source', 'D:\\PDF', '--dry-run', '--yes']), {
        sourcePath: 'D:\\PDF',
        dryRun: true,
        assumeYes: true,
        help: false,
    });
    assert.throws(() => parseLocalArguments(['--api-url', 'https://tranmed.onrender.com']), /không hỗ trợ/);
    assert.throws(
        () => createLocalApiClient({ apiUrl: 'https://tranmed.onrender.com/api/translate' }),
        /127\.0\.0\.1:8080/
    );
});

test('local importer uses a separate ledger and rejects PDFs above the P015 limit', () => {
    assert.equal(
        resolveLocalLedgerPath({ LOCALAPPDATA: 'D:\\AppData' }),
        path.join('D:\\AppData', 'StudyMed', 'LocalImporter', 'state-v1.json')
    );
    assert.throws(
        () => validateLocalFileLimits({
            files: [{ fullPath: 'D:\\source\\too-large.pdf', size: LOCAL_MAX_FILE_BYTES + 1 }],
        }),
        error => error instanceof ValidationError && /159 MB/.test(error.errors[0])
    );
});

test('each local importer run ignores an unfinished ledger from an earlier run', async t => {
    const root = await createTempRoot(t);
    const sourceRoot = path.join(root, 'source');
    const uploadDirectory = path.join(sourceRoot, 'Nội khoa', 'PDF');
    const appData = path.join(root, 'app-data');
    await fs.mkdir(uploadDirectory, { recursive: true });
    await fs.writeFile(path.join(uploadDirectory, 'A.pdf'), PDF_BYTES);

    const ledgerPath = resolveLocalLedgerPath({ LOCALAPPDATA: appData });
    const staleLedger = createEmptyLedger();
    staleLedger.operations['stale-operation'] = {
        operationId: 'stale-operation',
        apiUrl: LOCAL_API_URL,
        sourceKey: sourceRoot.toLowerCase(),
        bookName: 'Sách cũ đã chuyển đi',
        status: 'planned',
        clientBatchId: 'old-client-batch',
        batchId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        files: [{
            fingerprint: 'stale-fingerprint',
            clientUploadId: 'stale-client-upload',
            fileName: 'Missing.pdf',
            size: PDF_BYTES.length,
            sha256: 'a'.repeat(64),
        }],
    };
    await saveLedger(ledgerPath, staleLedger);

    const uploaded = [];
    const exitCode = await runLocalImporterCli({
        argv: ['--source', sourceRoot, '--yes'],
        environment: { LOCALAPPDATA: appData },
        input: { isTTY: false },
        output: { write() {} },
        errorOutput: { write() {} },
        apiClientFactory: () => ({
            checkAvailability: async () => {},
            uploadFile: async ({ sourceFile }) => {
                uploaded.push(sourceFile.fileName);
                return { jobId: 'new-job' };
            },
        }),
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(uploaded, ['A.pdf']);
    const persisted = await loadLedger(ledgerPath);
    assert.equal(persisted.operations['stale-operation'], undefined);
    assert.equal(Object.keys(persisted.records).length, 1);
});

test('availability requires a ready local runtime and reports an unavailable backend', async () => {
    await checkLocalAvailability({ fetchImpl: async url => readyResponse(url) });

    await assert.rejects(
        checkLocalAvailability({
            fetchImpl: async url => {
                if (String(url).endsWith('/api/readiness')) {
                    return new Response(JSON.stringify({
                        status: 'ready',
                        runtimeMode: 'cloud',
                        database: { available: true },
                        storage: { available: true, mode: 'r2' },
                    }), { status: 200 });
                }
                return readyResponse(url);
            },
        }),
        error => error.code === 'BACKEND_NOT_READY'
    );

    await assert.rejects(
        checkLocalAvailability({ fetchImpl: async () => { throw new Error('offline'); } }),
        error => error.code === 'BACKEND_NOT_READY' && /Start StudyMed Local/.test(error.message)
    );
});

test('local client streams one PDF as exact multipart fields and retries with the same client ID', async t => {
    const root = await createTempRoot(t);
    const sourceFile = await createSourceFile(root, 'Bài 1.pdf');
    const calls = [];
    const api = createLocalApiClient({
        fetchImpl: async (_url, options) => {
            calls.push(options);
            if (calls.length === 1) {
                return new Response(JSON.stringify({ error: 'busy' }), { status: 503 });
            }
            const form = options.body;
            assert.equal(options.method, 'POST');
            assert.equal(form.get('folderName'), 'Nội khoa');
            assert.equal(form.get('priority'), 'false');
            assert.equal(form.get('clientUploadId'), 'durable-id');
            const uploaded = form.get('files');
            assert.equal(uploaded.name, 'Bài 1.pdf');
            assert.equal(uploaded.type, 'application/pdf');
            assert.deepEqual(Buffer.from(await uploaded.arrayBuffer()), PDF_BYTES);
            return new Response(JSON.stringify({ jobs: [{ jobId: 'job-1' }] }), { status: 200 });
        },
        sleep: async () => {},
    });

    const job = await api.uploadFile({
        sourceFile,
        folderName: 'Nội khoa',
        clientUploadId: 'durable-id',
    });

    assert.equal(job.jobId, 'job-1');
    assert.equal(calls.length, 2);
    assert.equal(calls.every(call => call.body.get('clientUploadId') === 'durable-id'), true);
});

test('operation saves confirmations one by one and resumes only the unfinished PDF', async t => {
    const root = await createTempRoot(t);
    const first = await createSourceFile(root, 'A.pdf');
    const second = await createSourceFile(root, 'B.pdf');
    const scan = sourceScan(root, [first, second]);
    const ledger = createEmptyLedger();
    const plan = buildUploadPlan(scan, ledger, LOCAL_API_URL);
    const operation = plan.newOperations[0];
    ledger.operations[operation.operationId] = operation;
    const ledgerPath = path.join(root, 'state-v1.json');
    await saveLedger(ledgerPath, ledger);

    const firstAttempt = [];
    await assert.rejects(
        executeLocalOperation({
            operation,
            filesByFingerprint: plan.byFingerprint,
            ledger,
            ledgerPath,
            apiClient: {
                async uploadFile({ sourceFile }) {
                    firstAttempt.push(sourceFile.fileName);
                    if (sourceFile.fileName === 'B.pdf') throw new Error('temporary failure');
                    return { jobId: 'job-a' };
                },
            },
        }),
        /temporary failure/
    );
    assert.deepEqual(firstAttempt, ['A.pdf', 'B.pdf']);
    assert.equal(Object.keys(ledger.records).length, 1);
    assert.equal(operation.status, 'planned');

    const resumed = [];
    await executeLocalOperation({
        operation,
        filesByFingerprint: plan.byFingerprint,
        ledger,
        ledgerPath,
        apiClient: {
            async uploadFile({ sourceFile }) {
                resumed.push(sourceFile.fileName);
                return { jobId: 'job-b' };
            },
        },
    });
    assert.deepEqual(resumed, ['B.pdf']);
    assert.equal(Object.keys(ledger.records).length, 2);
    assert.equal(operation.status, 'ready');
});

test('source mutation after preflight is refused before an upload request', async t => {
    const root = await createTempRoot(t);
    const sourceFile = await createSourceFile(root, 'changed.pdf');
    await fs.writeFile(sourceFile.fullPath, Buffer.concat([PDF_BYTES, Buffer.from('changed')]));

    await assert.rejects(
        assertSourceUnchanged(sourceFile),
        error => error.code === 'SOURCE_CHANGED'
    );
});
