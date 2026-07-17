import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { PDFDocument } from 'pdf-lib';
import Job from '../src/models/jobModel.js';
import TranslationChunk from '../src/models/translationChunkModel.js';
import { getJobResult, downloadJobResult } from '../src/controllers/translateController.js';
import { runtimeConfig, r2Service } from '../src/services/runtimeServices.js';
import { QueueManager } from '../src/services/queueManager.js';
import { QUALITY_PIPELINE_VERSION } from '../src/services/qualityPipelineState.js';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), '../..');
const fixturePath = path.join(repositoryRoot, 'samplepdf', '77 Allergy Assessment.pdf');
const reportPath = path.join(repositoryRoot, 'archive', 'project-003', 'project-003-quality-smoke-report.json');
const runId = randomUUID();
const databaseName = `p003smk_${runId.replaceAll('-', '').slice(0, 20)}`;
const storageKey = `p003-smoke/${runId}/allergy-assessment-page-1.pdf`;
const jobId = `p003-smoke-${runId}`;
const batchId = `p003-smoke-batch-${runId}`;

async function firstPagePdf(sourcePath) {
    const source = await PDFDocument.load(await readFile(sourcePath));
    const output = await PDFDocument.create();
    const [page] = await output.copyPages(source, [0]);
    output.addPage(page);
    return Buffer.from(await output.save());
}

function createResponseCapture() {
    return {
        statusCode: 200,
        headers: {},
        headersSent: false,
        chunks: [],
        jsonBody: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        setHeader(name, value) {
            this.headers[name.toLowerCase()] = value;
        },
        json(value) {
            this.jsonBody = value;
            this.headersSent = true;
            return this;
        },
        write(value) {
            this.headersSent = true;
            this.chunks.push(Buffer.from(String(value)));
            return true;
        },
        end(value) {
            if (value !== undefined) this.chunks.push(Buffer.from(String(value)));
            this.headersSent = true;
            return this;
        },
        text() {
            return Buffer.concat(this.chunks).toString('utf8');
        },
    };
}

async function assertR2ObjectDeleted(key) {
    const remaining = await r2Service.listObjects({ prefix: key, maxKeys: 2 });
    assert.equal(remaining.objects.some(object => object.key === key), false, 'R2 source vẫn còn sau khi job hoàn tất.');
}

let databaseDropped = false;
let r2CleanupConfirmed = false;
let connected = false;
const startedAt = Date.now();
let report;

try {
    const input = await firstPagePdf(fixturePath);
    await r2Service.putObject({ key: storageKey, body: input, contentType: 'application/pdf' });
    const uploaded = await r2Service.headObject(storageKey);
    assert.equal(uploaded.contentLength, input.length);

    await mongoose.connect(runtimeConfig.mongodbUri, { dbName: databaseName });
    connected = true;
    await Promise.all([Job.syncIndexes(), TranslationChunk.syncIndexes()]);

    await Job.create({
        jobId,
        originalName: '77 Allergy Assessment - page 1.pdf',
        folderName: 'P003 isolated smoke',
        status: 'pending',
        storageProvider: 'r2',
        storageKey,
        sourceSize: input.length,
        sourceEtag: uploaded.etag,
        sourceState: 'ready',
        sourceCleanupState: 'pending',
        uploadBatchId: batchId,
        uploadConfirmedAt: new Date(),
        maxAttempts: runtimeConfig.maxJobAttempts,
        nextRetryAt: new Date(),
        translationMode: 'quality',
        translationPipelineVersion: QUALITY_PIPELINE_VERSION,
    });

    const queue = new QueueManager();
    const claimed = await queue.claimNextJob();
    assert.equal(claimed?.jobId, jobId, 'Worker không claim được job smoke cô lập.');
    const heartbeat = queue.createLeaseHeartbeat(claimed.jobId, claimed.processingToken);
    try {
        await queue.processClaimedJob(claimed, new AbortController().signal);
    } catch (error) {
        await queue.handleProcessingFailure(claimed, error);
        throw error;
    } finally {
        clearInterval(heartbeat);
    }

    const [job, chunks] = await Promise.all([
        Job.findOne({ jobId }).lean(),
        TranslationChunk.find({ jobId }).sort({ chunkIndex: 1 }).lean(),
    ]);
    assert.equal(job.status, 'completed');
    assert.equal(job.translationMode, 'quality');
    assert.equal(job.chunkCount, 1);
    assert.equal(chunks.length, 1);
    assert.ok(['completed', 'needs_review'].includes(chunks[0].stage));
    assert.ok(chunks[0].content?.trim());
    assert.equal(chunks[0].pageStart, 1);
    assert.equal(chunks[0].pageEnd, 1);
    if (chunks[0].qualityStatus === 'passed') {
        assert.equal(chunks[0].draftContent, undefined);
        assert.equal(chunks[0].revisedContent, undefined);
        assert.equal(chunks[0].repairedContent, undefined);
    }

    const previewResponse = createResponseCapture();
    await getJobResult({ params: { jobId } }, previewResponse);
    assert.equal(previewResponse.statusCode, 200);
    assert.equal(previewResponse.jsonBody.result, chunks[0].content);
    assert.equal(previewResponse.jsonBody.quality.mode, 'quality');
    assert.equal('auditReport' in previewResponse.jsonBody.quality, false);
    assert.equal('verificationReport' in previewResponse.jsonBody.quality, false);

    const downloadResponse = createResponseCapture();
    await downloadJobResult({ params: { jobId } }, downloadResponse);
    assert.equal(downloadResponse.statusCode, 200);
    assert.equal(downloadResponse.text(), previewResponse.jsonBody.result);
    assert.match(downloadResponse.headers['content-type'], /^text\/markdown/);

    await assertR2ObjectDeleted(storageKey);
    r2CleanupConfirmed = true;

    report = {
        schemaVersion: 1,
        outcome: 'passed',
        fixture: '77 Allergy Assessment.pdf, page 1',
        isolation: {
            mongoDatabase: 'random per run; dropped after verification',
            r2Prefix: 'p003-smoke/<run-id>/; deleted after terminal processing',
        },
        job: {
            status: job.status,
            translationMode: job.translationMode,
            pipelineVersion: job.translationPipelineVersion,
            chunkCount: job.chunkCount,
            completedChunks: job.completedChunks,
            passedChunks: job.passedChunks,
            needsReviewChunks: job.needsReviewChunks,
            sourceState: job.sourceState,
            sourceCleanupState: job.sourceCleanupState,
        },
        chunk: {
            stage: chunks[0].stage,
            qualityStatus: chunks[0].qualityStatus,
            repairCount: chunks[0].repairCount,
            contentBytes: Buffer.byteLength(chunks[0].content, 'utf8'),
            pageStart: chunks[0].pageStart,
            pageEnd: chunks[0].pageEnd,
            persistedUsageStages: Object.keys(chunks[0].usageByStage || {}).sort(),
            transientTextRemovedAfterPass: chunks[0].qualityStatus === 'passed'
                ? !chunks[0].draftContent && !chunks[0].revisedContent && !chunks[0].repairedContent
                : null,
        },
        api: {
            previewStatus: previewResponse.statusCode,
            downloadStatus: downloadResponse.statusCode,
            previewDownloadMatch: downloadResponse.text() === previewResponse.jsonBody.result,
            publicQualitySummaryExcludesPrivateReports: true,
        },
        cleanup: {
            r2SourceDeleted: r2CleanupConfirmed,
            mongoDatabaseDropped: true,
        },
        elapsedMs: Date.now() - startedAt,
    };
} finally {
    await r2Service.deleteObject(storageKey).catch(() => {});
    if (connected) {
        try {
            await mongoose.connection.dropDatabase();
            databaseDropped = true;
        } finally {
            await mongoose.disconnect();
        }
    }
}

assert.equal(databaseDropped, true, 'Database smoke cô lập chưa được drop.');
assert.equal(r2CleanupConfirmed, true, 'Chưa xác nhận source R2 đã được xóa.');
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
