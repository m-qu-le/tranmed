import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BSON } from 'bson';
import { processPdf } from '../src/services/pdfService.js';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), '../..');
const benchmarkDirectory = path.join(repositoryRoot, '.p003-local', 'benchmarks');
const selectionPath = path.join(repositoryRoot, 'cline_docs', 'project-003-benchmark-selection.json');
const manifestPath = path.join(repositoryRoot, 'cline_docs', 'project-003-sample-manifest.json');
const benchmarkReportPath = path.join(repositoryRoot, 'cline_docs', 'project-003-benchmark-report.json');
const jsonReportPath = path.join(repositoryRoot, 'cline_docs', 'project-003-performance-resource.json');
const markdownReportPath = path.join(repositoryRoot, 'cline_docs', 'project-003-performance-resource.md');
const sampleDirectory = path.join(repositoryRoot, 'samplepdf');

function quantile(values, fraction) {
    assert.ok(values.length > 0);
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

export function summarize(values) {
    const finite = values.filter(Number.isFinite);
    assert.ok(finite.length > 0);
    return {
        mean: Math.round(finite.reduce((total, value) => total + value, 0) / finite.length),
        p50: Math.round(quantile(finite, 0.5)),
        p95: Math.round(quantile(finite, 0.95)),
        min: Math.round(Math.min(...finite)),
        max: Math.round(Math.max(...finite)),
    };
}

export function estimateTwoLaneWallMs(durations, taskCount) {
    assert.ok(durations.length > 0);
    const lanes = [0, 0];
    for (let index = 0; index < taskCount; index += 1) {
        const laneIndex = lanes[0] <= lanes[1] ? 0 : 1;
        lanes[laneIndex] += durations[index % durations.length];
    }
    return Math.max(...lanes);
}

function artifactNameMatches(name, sample) {
    if (!name.startsWith('b4-') || !name.endsWith('.json')) return false;
    const pageMarker = `-p${sample.startPage}-${sample.endPage}.json`;
    return name.endsWith(pageMarker);
}

async function currentB4Artifacts(selection) {
    const names = await readdir(benchmarkDirectory);
    const parsed = [];
    for (const name of names.filter(name => name.startsWith('b4-') && name.endsWith('.json'))) {
        const artifact = JSON.parse(await readFile(path.join(benchmarkDirectory, name), 'utf8'));
        parsed.push({ name, artifact });
    }

    return selection.samples.map(sample => {
        const candidates = parsed.filter(({ name, artifact }) => (
            artifactNameMatches(name, sample)
            && artifact.source?.fileName === sample.fileName
            && artifact.source?.startPage === sample.startPage
            && artifact.source?.endPage === sample.endPage
        )).sort((left, right) => String(right.artifact.completedAt).localeCompare(String(left.artifact.completedAt)));
        assert.ok(candidates.length > 0, `Thiếu B4 artifact cho ${sample.fileName}.`);
        return candidates[0].artifact;
    });
}

function stageEntries(artifact) {
    return Object.entries(artifact.stages || {}).filter(([, stage]) => stage?.metadata);
}

function bsonArtifact(artifact, { peak = false } = {}) {
    const stages = artifact.stages || {};
    const usageByStage = Object.fromEntries(stageEntries(artifact).map(([stage, value]) => [stage, value.metadata]));
    const base = {
        _id: '000000000000000000000000',
        jobId: 'p003-resource-estimate',
        chunkIndex: 0,
        content: artifact.response?.text || '',
        pipelineVersion: 'p003-v1',
        pipelineMode: 'quality',
        promptVersion: 'p003-prompts-v1',
        pageStart: artifact.source.startPage,
        pageEnd: artifact.source.endPage,
        totalPages: artifact.source.totalPages,
        stage: artifact.qualityStatus === 'needs_review' ? 'needs_review' : 'completed',
        auditReport: stages.medical_audit?.report || null,
        verificationReport: stages.verify?.report || null,
        reverifyReport: stages.reverify?.report || null,
        repairCount: artifact.repairCount || 0,
        qualityStatus: artifact.qualityStatus,
        usageByStage,
        stageUpdatedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
    };

    if (peak || artifact.qualityStatus === 'needs_review') {
        base.draftContent = stages.translate?.text || null;
        base.revisedContent = stages.revise?.text || null;
        base.repairedContent = stages.repair?.text || null;
    }
    return base;
}

function mb(bytes) {
    return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

function minutes(milliseconds) {
    return Math.round((milliseconds / 60_000) * 10) / 10;
}

async function measureLargestPdf(manifest) {
    const largest = [...manifest.files].sort((left, right) => right.sizeBytes - left.sizeBytes)[0];
    if (global.gc) global.gc();
    const before = process.memoryUsage();
    let peakRss = before.rss;
    let peakHeapUsed = before.heapUsed;
    const sampler = setInterval(() => {
        const current = process.memoryUsage();
        peakRss = Math.max(peakRss, current.rss);
        peakHeapUsed = Math.max(peakHeapUsed, current.heapUsed);
    }, 10);
    const startedAt = Date.now();
    let splitResult;
    try {
        splitResult = await processPdf(path.join(sampleDirectory, largest.fileName), new AbortController().signal);
    } finally {
        clearInterval(sampler);
    }
    const after = process.memoryUsage();
    const returnedChunkBytes = splitResult.chunkBuffers.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    return {
        fileName: largest.fileName,
        sourceBytes: largest.sizeBytes,
        totalPages: splitResult.totalPages,
        chunkCount: splitResult.chunkBuffers.length,
        returnedChunkBytes,
        splitElapsedMs: Date.now() - startedAt,
        processMemory: {
            beforeRssBytes: before.rss,
            peakRssBytes: Math.max(peakRss, after.rss),
            rssIncreaseBytes: Math.max(0, Math.max(peakRss, after.rss) - before.rss),
            beforeHeapUsedBytes: before.heapUsed,
            peakHeapUsedBytes: Math.max(peakHeapUsed, after.heapUsed),
            heapIncreaseBytes: Math.max(0, Math.max(peakHeapUsed, after.heapUsed) - before.heapUsed),
        },
    };
}

function markdown(report) {
    const performance = report.performance;
    const resource = report.resources;
    return `# PROJECT 003 — Hiệu năng và tài nguyên\n\n` +
        `Ngày đo: ${report.generatedAt.slice(0, 10)}. Phép đo không gọi Gemini mới; latency lấy từ 20 B4 artifact hiện hành, tài nguyên PDF đo bằng Worker thật.\n\n` +
        `## Hiệu năng\n\n` +
        `- B4 end-to-end quan sát trên 20 chunk: trung bình ${minutes(performance.chunkEndToEndMs.mean)} phút, p95 ${minutes(performance.chunkEndToEndMs.p95)} phút, tối đa ${minutes(performance.chunkEndToEndMs.max)} phút/chunk.\n` +
        `- Mỗi chunk dùng trung bình ${performance.callsPerChunk.mean.toFixed(1)} call; ${performance.repairRatePercent}% mẫu cần repair/reverify.\n` +
        `- Với scheduler 2 chunk song song, 191 chunk được ngoại suy khoảng ${minutes(performance.fullCorpus.twoLaneEmpiricalMs)} phút theo chuỗi latency thực nghiệm; biên bảo thủ dùng p95 là ${minutes(performance.fullCorpus.twoLaneP95BoundMs)} phút. Đây là ngoại suy, chưa phải một lượt live đủ 370 trang.\n` +
        `- Request Gemini quan sát tối đa ${Math.round(performance.maxSingleCallMs / 1000)} giây, thấp hơn timeout ${Math.round(performance.geminiTimeoutMs / 1000)} giây. Lease 5 phút được heartbeat mỗi 60 giây, nên thời lượng toàn job không phụ thuộc một lease cố định.\n\n` +
        `## Tài nguyên\n\n` +
        `- PDF lớn nhất: \`${resource.largestPdf.fileName}\`, ${resource.largestPdf.totalPages} trang, ${resource.largestPdf.chunkCount} chunk; source ${mb(resource.largestPdf.sourceBytes)} MiB, tổng buffer chunk trả về ${mb(resource.largestPdf.returnedChunkBytes)} MiB.\n` +
        `- Worker split mất ${resource.largestPdf.splitElapsedMs} ms; RSS process tăng tối đa ${mb(resource.largestPdf.processMemory.rssIncreaseBytes)} MiB, heap tăng ${mb(resource.largestPdf.processMemory.heapIncreaseBytes)} MiB trong lượt đo.\n` +
        `- BSON terminal trung bình ${Math.round(resource.mongoBson.terminalBytes.mean / 1024)} KiB/chunk; peak trung bình ${Math.round(resource.mongoBson.peakBytes.mean / 1024)} KiB/chunk. Ước tính payload terminal cho 191 chunk là ${mb(resource.mongoBson.estimatedTerminalCorpusBytes)} MiB.\n` +
        `- PASS artifact không giữ draft/revised/repaired full-text; smoke production E011 cũng xác nhận cleanup. \`needs_review\` giữ artifact chẩn đoán theo thiết kế.\n\n` +
        `## Giới hạn và cổng còn lại\n\n` +
        `- BSON là payload document trước compression/index overhead; Mongo storage thực phải được theo dõi ở canary/batch.\n` +
        `- RSS trên máy local không thay thế Render metrics. Cần xác nhận lại bằng một PDF dài ở canary và theo dõi production 24 giờ.\n` +
        `- Để đóng G8-S11 hoàn toàn, chạy full-corpus live khi quota cho phép và so kết quả với ngoại suy này.\n`;
}

async function main() {
    const [selection, manifest, benchmarkReport] = await Promise.all([
        readFile(selectionPath, 'utf8').then(JSON.parse),
        readFile(manifestPath, 'utf8').then(JSON.parse),
        readFile(benchmarkReportPath, 'utf8').then(JSON.parse),
    ]);
    const artifacts = await currentB4Artifacts(selection);
    assert.equal(artifacts.length, 20);

    const chunkDurations = artifacts.map(artifact => stageEntries(artifact)
        .reduce((sum, [, stage]) => sum + stage.metadata.latencyMs, 0));
    const calls = artifacts.map(artifact => stageEntries(artifact).length);
    const maxSingleCallMs = Math.max(...artifacts.flatMap(artifact => stageEntries(artifact)
        .map(([, stage]) => stage.metadata.latencyMs)));
    const peakBytes = artifacts.map(artifact => BSON.calculateObjectSize(bsonArtifact(artifact, { peak: true })));
    const terminalBytes = artifacts.map(artifact => BSON.calculateObjectSize(bsonArtifact(artifact)));
    const passedArtifacts = artifacts.filter(artifact => artifact.qualityStatus === 'passed');
    assert.ok(passedArtifacts.every(artifact => {
        const terminal = bsonArtifact(artifact);
        return !('draftContent' in terminal) && !('revisedContent' in terminal) && !('repairedContent' in terminal);
    }));

    const largestPdf = await measureLargestPdf(manifest);
    const p95Duration = quantile(chunkDurations, 0.95);
    const terminalSummary = summarize(terminalBytes);
    const report = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        evidence: {
            benchmarkSamples: artifacts.length,
            corpusPages: manifest.totals.pageCount,
            corpusChunks: manifest.totals.chunkCount,
            observedModelAttempts: Object.values(benchmarkReport.byVariant)
                .reduce((sum, variant) => sum + variant.requestAttempts, 0),
            liveFullCorpusRun: false,
        },
        performance: {
            chunkEndToEndMs: summarize(chunkDurations),
            callsPerChunk: {
                mean: calls.reduce((sum, value) => sum + value, 0) / calls.length,
                min: Math.min(...calls),
                max: Math.max(...calls),
            },
            repairRatePercent: Math.round((artifacts.filter(artifact => artifact.repairCount > 0).length / artifacts.length) * 100),
            maxSingleCallMs,
            geminiTimeoutMs: 180_000,
            leaseDurationMs: 300_000,
            leaseHeartbeatMs: 60_000,
            fullCorpus: {
                chunkCount: manifest.totals.chunkCount,
                concurrency: 2,
                twoLaneEmpiricalMs: estimateTwoLaneWallMs(chunkDurations, manifest.totals.chunkCount),
                twoLaneP95BoundMs: Math.ceil(manifest.totals.chunkCount / 2) * p95Duration,
                method: 'Extrapolated from the 20 observed B4 end-to-end chunk durations.',
            },
        },
        resources: {
            corpusSourceBytes: manifest.totals.sizeBytes,
            largestPdf,
            mongoBson: {
                measurement: 'BSON document payload before database compression and index overhead.',
                terminalBytes: terminalSummary,
                peakBytes: summarize(peakBytes),
                needsReviewTerminalBytes: terminalBytes.filter((_, index) => artifacts[index].qualityStatus === 'needs_review'),
                estimatedTerminalCorpusBytes: Math.round(terminalSummary.mean * manifest.totals.chunkCount),
                passedTransientTextRemoved: true,
            },
        },
        gates: {
            individualRequestBelowTimeout: maxSingleCallMs < 180_000,
            leaseHeartbeatCoveredByUnitTest: true,
            fullCorpusLiveStillRequired: true,
            renderMetricsStillRequiredAtCanary: true,
        },
    };
    await Promise.all([
        writeFile(jsonReportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
        writeFile(markdownReportPath, markdown(report), 'utf8'),
    ]);
    console.log(JSON.stringify({
        jsonReport: path.relative(repositoryRoot, jsonReportPath),
        markdownReport: path.relative(repositoryRoot, markdownReportPath),
        chunkEndToEndMs: report.performance.chunkEndToEndMs,
        fullCorpusMinutes: minutes(report.performance.fullCorpus.twoLaneEmpiricalMs),
        largestPdf: report.resources.largestPdf,
        mongoBson: report.resources.mongoBson,
    }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    main().catch(error => {
        console.error(error?.stack || error);
        process.exitCode = 1;
    });
}
