import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    HttpError,
    StateError,
    ValidationError,
    buildUploadPlan,
    createEmptyLedger,
    executeOperation,
    fingerprintFor,
    loadLedger,
    parseArguments,
    partitionFiles,
    putPdfToR2,
    retryOperation,
    saveLedger,
    scanSource,
    sourceKeyFor,
} from '../scripts/local-uploader.js';

const PDF_BYTES = Buffer.from('%PDF-1.7\n% StudyMed test fixture\n');

test('retry waits for a server-supplied rate-limit reset instead of retrying immediately', async () => {
    const delays = [];
    let calls = 0;

    const result = await retryOperation(async () => {
        calls += 1;
        if (calls === 1) throw new HttpError('rate limited', 429, { retryAfterMs: 12_000 });
        return 'accepted';
    }, {
        sleep: async milliseconds => { delays.push(milliseconds); },
    });

    assert.equal(result, 'accepted');
    assert.equal(calls, 2);
    assert.deepEqual(delays, [12_000]);
});

async function createTempRoot(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'studymed-uploader-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
}

async function addBook(root, bookName, childName, fileNames) {
    const child = path.join(root, bookName, childName);
    await mkdir(child, { recursive: true });
    for (const fileName of fileNames) {
        await writeFile(path.join(child, fileName), PDF_BYTES);
    }
    return child;
}

test('scanner accepts the exact book/one-child/PDF structure with Unicode names', async t => {
    const root = await createTempRoot(t);
    await addBook(root, 'Nội khoa 10', 'Các phần đã cắt', ['Bài 10.pdf', 'Bài 2.pdf']);
    await addBook(root, 'Dược lý', 'Split tùy ý', ['Chương 1.PDF']);

    const result = await scanSource(root, { hashConcurrency: 2 });

    assert.equal(result.books.length, 2);
    assert.equal(result.totalFiles, 3);
    assert.equal(result.totalBytes, PDF_BYTES.length * 3);
    assert.deepEqual(result.books.map(book => book.name), ['Dược lý', 'Nội khoa 10']);
    assert.deepEqual(
        result.books.find(book => book.name === 'Nội khoa 10').files.map(file => file.fileName),
        ['Bài 2.pdf', 'Bài 10.pdf']
    );
    assert.ok(result.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
});

test('scanner fails the whole preflight for wrong depth, direct files, non-PDF and fake PDF', async t => {
    const root = await createTempRoot(t);
    const validChild = await addBook(root, 'Sách hợp lệ', 'Split', ['Đúng.pdf']);
    await mkdir(path.join(validChild, 'Tầng sâu'));
    await writeFile(path.join(root, 'Sách hợp lệ', 'đặt sai.pdf'), PDF_BYTES);
    await addBook(root, 'Sách có TXT', 'Khác', ['Đúng.pdf']);
    await writeFile(path.join(root, 'Sách có TXT', 'Khác', 'ghi-chú.txt'), 'not a PDF');
    await addBook(root, 'Sách PDF giả', 'Split', ['Giả.pdf']);
    await writeFile(path.join(root, 'Sách PDF giả', 'Split', 'Giả.pdf'), 'not a PDF');

    await assert.rejects(
        scanSource(root),
        error => {
            assert.ok(error instanceof ValidationError);
            assert.match(error.errors.join('\n'), /Không được đặt file/);
            assert.match(error.errors.join('\n'), /không được có thư mục sâu/);
            assert.match(error.errors.join('\n'), /Chỉ chấp nhận file PDF/);
            assert.match(error.errors.join('\n'), /%PDF-/);
            return true;
        }
    );
});

test('scanner rejects books with zero or multiple child directories', async t => {
    const root = await createTempRoot(t);
    await mkdir(path.join(root, 'Không có child'), { recursive: true });
    await addBook(root, 'Hai child', 'A', ['A.pdf']);
    await addBook(root, 'Hai child', 'B', ['B.pdf']);

    await assert.rejects(
        scanSource(root),
        error => {
            assert.ok(error instanceof ValidationError);
            assert.match(error.errors.join('\n'), /hiện có 0/);
            assert.match(error.errors.join('\n'), /hiện có 2/);
            return true;
        }
    );
});

test('partitioning respects 500 files and 2 GiB per batch', () => {
    const smallFiles = Array.from({ length: 501 }, (_, index) => ({
        fileName: `${index}.pdf`,
        size: 1,
    }));
    assert.deepEqual(partitionFiles(smallFiles).map(chunk => chunk.length), [500, 1]);

    const oneGiB = 1024 * 1024 * 1024;
    const byteChunks = partitionFiles([
        { fileName: 'a.pdf', size: oneGiB },
        { fileName: 'b.pdf', size: oneGiB },
        { fileName: 'c.pdf', size: 1 },
    ]);
    assert.deepEqual(byteChunks.map(chunk => chunk.length), [2, 1]);
});

test('automation confirmation is explicit and never changes the interactive default', () => {
    assert.equal(parseArguments([]).assumeYes, false);
    assert.equal(parseArguments(['--yes']).assumeYes, true);
    assert.equal(parseArguments(['--dry-run', '--yes']).dryRun, true);
});

test('ledger makes confirmed files idempotent and refuses corrupt state', async t => {
    const root = await createTempRoot(t);
    const ledgerPath = path.join(root, 'state-v1.json');
    const apiUrl = 'https://tranmed.onrender.com/api/translate';
    const file = {
        bookName: 'Nội khoa',
        fileName: 'Bài 1.pdf',
        fullPath: path.join(root, 'Bài 1.pdf'),
        size: PDF_BYTES.length,
        mtimeMs: 1,
        sha256: 'a'.repeat(64),
    };
    const scan = {
        sourcePath: root,
        sourceKey: sourceKeyFor(root),
        books: [{ name: file.bookName, files: [file], totalBytes: file.size }],
        files: [file],
        totalFiles: 1,
        totalBytes: file.size,
    };
    const ledger = createEmptyLedger();
    const first = buildUploadPlan(scan, ledger, apiUrl);
    assert.equal(first.newFiles.length, 1);
    assert.equal(first.newOperations.length, 1);

    const fingerprint = fingerprintFor(apiUrl, file);
    ledger.records[fingerprint] = { status: 'confirmed' };
    const second = buildUploadPlan(scan, ledger, apiUrl);
    assert.equal(second.newFiles.length, 0);
    assert.equal(second.confirmedFiles.length, 1);

    await saveLedger(ledgerPath, ledger);
    assert.equal((await loadLedger(ledgerPath)).version, 1);
    await writeFile(ledgerPath, '{broken json');
    await assert.rejects(loadLedger(ledgerPath), StateError);

    await saveLedger(ledgerPath, ledger);
    await rm(ledgerPath);
    await assert.rejects(loadLedger(ledgerPath), /còn bản backup/);
});

function createOperationFixture(scan, apiUrl, ledger) {
    const plan = buildUploadPlan(scan, ledger, apiUrl);
    const operation = plan.newOperations[0];
    ledger.operations[operation.operationId] = operation;
    return { plan, operation };
}

function createFakeApi(operation, {
    confirmed = new Set(),
    statusReady = () => confirmed.size === operation.files.length,
} = {}) {
    let prepareCalls = 0;
    const jobIdByClientId = new Map(
        operation.files.map((file, index) => [file.clientUploadId, `job-${index + 1}`])
    );
    return {
        get prepareCalls() { return prepareCalls; },
        confirmed,
        async prepare() {
            prepareCalls += 1;
            return {
                batchId: 'batch-test',
                items: operation.files.map(file => {
                    const jobId = jobIdByClientId.get(file.clientUploadId);
                    return {
                        jobId,
                        clientUploadId: file.clientUploadId,
                        name: file.fileName,
                        size: file.size,
                        status: confirmed.has(jobId) ? 'pending' : 'uploading',
                        ...(!confirmed.has(jobId) ? {
                            uploadUrl: `https://account.r2.cloudflarestorage.com/${jobId}?signed=test`,
                            requiredHeaders: { 'Content-Type': 'application/pdf' },
                        } : {}),
                    };
                }),
            };
        },
        async confirm(_batchId, jobIds) {
            for (const jobId of jobIds) confirmed.add(jobId);
            return {
                items: jobIds.map(jobId => ({ jobId, status: 'pending' })),
                canCloseClient: statusReady(),
            };
        },
        async getBatchStatus() {
            return {
                batchId: 'batch-test',
                canCloseClient: statusReady(),
                confirmedFiles: confirmed.size,
                skippedFiles: 0,
            };
        },
    };
}

test('upload operation refreshes expired signatures, limits concurrency and confirms atomically', async t => {
    const root = await createTempRoot(t);
    await addBook(root, 'Tim mạch', 'Split', ['A.pdf', 'B.pdf', 'C.pdf']);
    const scan = await scanSource(root);
    const apiUrl = 'https://tranmed.onrender.com/api/translate';
    const ledger = createEmptyLedger();
    const { plan, operation } = createOperationFixture(scan, apiUrl, ledger);
    const ledgerPath = path.join(root, 'state.json');
    await saveLedger(ledgerPath, ledger);
    const api = createFakeApi(operation);
    let active = 0;
    let maxActive = 0;
    let firstExpired = true;

    await executeOperation({
        operation,
        filesByFingerprint: plan.byFingerprint,
        ledger,
        ledgerPath,
        apiClient: api,
        uploadConcurrency: 2,
        confirmChunkSize: 2,
        sleep: async () => {},
        async putFile({ filePath }) {
            if (firstExpired && filePath.endsWith(`${path.sep}A.pdf`)) {
                firstExpired = false;
                throw new HttpError('expired', 403);
            }
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise(resolve => setImmediate(resolve));
            active -= 1;
        },
    });

    assert.equal(operation.status, 'ready');
    assert.equal(Object.keys(ledger.records).length, 3);
    assert.ok(api.prepareCalls >= 3);
    assert.ok(maxActive >= 1 && maxActive <= 2);
    const persisted = JSON.parse(await readFile(ledgerPath, 'utf8'));
    assert.equal(persisted.operations[operation.operationId].status, 'ready');
});

test('a partial upload persists confirmations and rerun uploads only the unfinished file', async t => {
    const root = await createTempRoot(t);
    await addBook(root, 'Huyết học', 'Split', ['A.pdf', 'B.pdf']);
    const scan = await scanSource(root);
    const apiUrl = 'https://tranmed.onrender.com/api/translate';
    const ledger = createEmptyLedger();
    const { plan, operation } = createOperationFixture(scan, apiUrl, ledger);
    const ledgerPath = path.join(root, 'state.json');
    await saveLedger(ledgerPath, ledger);
    const confirmed = new Set();
    const api = createFakeApi(operation, { confirmed });

    await assert.rejects(
        executeOperation({
            operation,
            filesByFingerprint: plan.byFingerprint,
            ledger,
            ledgerPath,
            apiClient: api,
            sleep: async () => {},
            async putFile({ filePath }) {
                if (filePath.endsWith(`${path.sep}B.pdf`)) {
                    throw new HttpError('temporary outage', 500);
                }
            },
        }),
        /chưa an toàn/
    );
    assert.equal(confirmed.size, 1);
    assert.equal(Object.keys(ledger.records).length, 1);
    assert.equal(operation.status, 'planned');

    const uploadedOnResume = [];
    await executeOperation({
        operation,
        filesByFingerprint: plan.byFingerprint,
        ledger,
        ledgerPath,
        apiClient: api,
        sleep: async () => {},
        async putFile({ filePath }) {
            uploadedOnResume.push(path.basename(filePath));
        },
    });

    assert.deepEqual(uploadedOnResume, ['B.pdf']);
    assert.equal(confirmed.size, 2);
    assert.equal(operation.status, 'ready');
    assert.equal(Object.keys(ledger.records).length, 2);
});

test('R2 PUT rejects untrusted hosts before sending a PDF', async t => {
    const root = await createTempRoot(t);
    const pdfPath = path.join(root, 'fixture.pdf');
    await writeFile(pdfPath, PDF_BYTES);
    let fetchCalls = 0;

    await assert.rejects(
        putPdfToR2({
            uploadUrl: 'https://evil.example/upload',
            filePath: pdfPath,
            size: PDF_BYTES.length,
            fetchImpl: async () => {
                fetchCalls += 1;
                return new Response(null, { status: 200 });
            },
        }),
        /không phải Cloudflare R2/
    );
    assert.equal(fetchCalls, 0);
});

test('R2 PUT streams the PDF with the required content headers', async t => {
    const root = await createTempRoot(t);
    const pdfPath = path.join(root, 'fixture.pdf');
    await writeFile(pdfPath, PDF_BYTES);
    let received = Buffer.alloc(0);

    await putPdfToR2({
        uploadUrl: 'https://account.r2.cloudflarestorage.com/object?signed=test',
        filePath: pdfPath,
        size: PDF_BYTES.length,
        async fetchImpl(target, options) {
            assert.equal(target.hostname, 'account.r2.cloudflarestorage.com');
            assert.equal(options.method, 'PUT');
            assert.equal(options.headers['Content-Type'], 'application/pdf');
            assert.equal(options.headers['Content-Length'], String(PDF_BYTES.length));
            for await (const chunk of options.body) {
                received = Buffer.concat([received, chunk]);
            }
            return new Response(null, { status: 200 });
        },
    });

    assert.deepEqual(received, PDF_BYTES);
});
