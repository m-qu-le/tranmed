import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchmarkArtifactPath, runBenchmark } from './benchmark-project-003.js';
import { buildFullCorpusTasks } from './benchmark-project-003-full-corpus.js';
import { qualityTextCoverageRatio } from '../src/services/qualityTextGuard.js';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), '../..');
const manifestPath = path.join(repositoryRoot, 'cline_docs', 'project-003-sample-manifest.json');
const summaryPath = path.join(repositoryRoot, '.p003-local', 'full-corpus', 'summary.json');
const jsonReportPath = path.join(repositoryRoot, 'cline_docs', 'project-003-full-corpus-report.json');
const markdownReportPath = path.join(repositoryRoot, 'cline_docs', 'project-003-full-corpus-report.md');

function quantile(values, fraction) {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function stats(values) {
    assert.ok(values.length > 0);
    return {
        mean: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
        p50: Math.round(quantile(values, 0.5)),
        p95: Math.round(quantile(values, 0.95)),
        min: Math.round(Math.min(...values)),
        max: Math.round(Math.max(...values)),
    };
}

function laneWallMs(durations, concurrency) {
    const lanes = Array.from({ length: concurrency }, () => 0);
    for (const duration of durations) {
        const lane = lanes.indexOf(Math.min(...lanes));
        lanes[lane] += duration;
    }
    return Math.max(...lanes);
}

function increment(target, key, amount = 1) {
    const normalized = key || 'UNKNOWN';
    target[normalized] = (target[normalized] || 0) + amount;
}

function aggregateFindings(artifacts) {
    const categories = {};
    const severities = {};
    for (const artifact of artifacts) {
        for (const error of artifact.finalReport?.errors || []) {
            increment(categories, error.category);
            increment(severities, error.severity);
        }
    }
    return { categories, severities };
}

export function compactReviewQueue(artifacts) {
    return artifacts
        .filter(artifact => artifact.qualityStatus === 'needs_review')
        .map(artifact => ({
            fileName: artifact.source.fileName,
            startPage: artifact.source.startPage,
            endPage: artifact.source.endPage,
            findings: (artifact.finalReport?.errors || [])
                .filter(error => ['critical', 'major'].includes(error.severity))
                .map(error => ({ category: error.category, severity: error.severity })),
        }));
}

function minutes(milliseconds) {
    return Math.round((milliseconds / 60_000) * 10) / 10;
}

function markdown(report) {
    const reviewLines = report.quality.reviewQueue.map(item => {
        const findings = item.findings.map(finding => `${finding.severity} ${finding.category}`).join(', ');
        return `- \`${item.fileName}\`, trang ${item.startPage}–${item.endPage}: ${findings}.`;
    }).join('\n');
    return `# PROJECT 003 — Full-corpus quality run\n\n` +
        `Ngày tổng hợp: ${report.generatedAt.slice(0, 10)}. Báo cáo không chứa nội dung PDF hoặc bản dịch.\n\n` +
        `## Kết quả\n\n` +
        `- Đủ ${report.scope.pdfCount} PDF, ${report.scope.pageCount} trang, ${report.scope.chunkCount} chunk theo thứ tự 2 trang/chunk.\n` +
        `- ${report.quality.passed} chunk PASS, ${report.quality.needsReview} chunk \`needs_review\`, ${report.quality.repairs} chunk qua repair/reverify.\n` +
        `- ${report.requests.successfulCalls} call thành công trên ${report.requests.attempts} attempt; lỗi theo status/code được tổng hợp trong JSON đi kèm.\n` +
        `- Coverage thấp nhất của revise là ${(report.coverage.minimumRevisionRatio * 100).toFixed(1)}%; repair là ${(report.coverage.minimumRepairRatio * 100).toFixed(1)}%. Mọi artifact đều đạt guard 80%.\n\n` +
        `## Hiệu năng live\n\n` +
        `- End-to-end model latency trung bình ${minutes(report.performance.chunkEndToEndMs.mean)} phút/chunk, p95 ${minutes(report.performance.chunkEndToEndMs.p95)} phút.\n` +
        `- Xếp latency của đủ 191 artifact lên ${report.performance.benchmarkConcurrency} lane như runner: ${minutes(report.performance.scheduledAtBenchmarkConcurrencyMs)} phút model wall-time; theo production target 2 lane là ${minutes(report.performance.scheduledAtProductionConcurrencyMs)} phút.\n` +
        `- Runner resume thực tế mất ${minutes(report.performance.runnerElapsedMs)} phút vì chạy mới ${report.checkpoint.completedThisResume} chunk và tái sử dụng ${report.checkpoint.reusedFromCheckpoints} checkpoint hợp lệ.\n` +
        `- Single call tối đa ${Math.round(report.performance.singleCallMs.max / 1000)} giây, dưới timeout 180 giây.\n\n` +
        `## Hàng đợi review critical/major\n\n` +
        `${reviewLines}\n\n` +
        `## Cổng rollout\n\n` +
        `- Chunk \`needs_review\` vẫn có final content nhưng bắt buộc hiển thị warning/page range.\n` +
        `- Cần duyệt các finding critical/major và canary production trước khi bật mặc định quality.\n`;
}

async function loadArtifacts(manifest, keyCount) {
    const tasks = buildFullCorpusTasks(manifest, keyCount);
    const artifacts = [];
    for (const task of tasks) {
        const planned = await runBenchmark({ ...task, dryRun: true });
        const artifactPath = benchmarkArtifactPath(planned.plan);
        const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
        assert.equal(artifact.source.fileName, task.fileName);
        assert.equal(artifact.source.startPage, task.startPage);
        assert.equal(artifact.source.endPage, task.endPage);
        assert.equal(artifact.source.sourceSha256, manifest.files.find(file => file.fileName === task.fileName).sha256);
        artifacts.push(artifact);
    }
    return artifacts;
}

async function main() {
    const [manifest, summary] = await Promise.all([
        readFile(manifestPath, 'utf8').then(JSON.parse),
        readFile(summaryPath, 'utf8').then(JSON.parse),
    ]);
    assert.equal(summary.total, manifest.totals.chunkCount);
    assert.equal(summary.processed, summary.total, 'Full-corpus checkpoint chưa hoàn tất.');
    assert.equal(summary.planned, 0, 'Đây là checkpoint dry-run, không phải full-corpus live.');
    assert.equal(summary.failed, 0, 'Full-corpus còn task failed.');
    const artifacts = await loadArtifacts(manifest, summary.configuredKeyCount || 7);
    assert.equal(artifacts.length, manifest.totals.chunkCount);

    const durations = [];
    const singleCalls = [];
    const keyDistribution = {};
    const errorCodes = {};
    const errorStatuses = {};
    let attempts = 0;
    let successfulCalls = 0;
    const revisionRatios = [];
    const repairRatios = [];
    for (const artifact of artifacts) {
        const stages = Object.values(artifact.stages || {}).filter(stage => stage?.metadata);
        const latencies = stages.map(stage => stage.metadata.latencyMs);
        durations.push(latencies.reduce((sum, value) => sum + value, 0));
        singleCalls.push(...latencies);
        successfulCalls += stages.length;
        revisionRatios.push(qualityTextCoverageRatio(
            artifact.stages?.revise?.text,
            artifact.stages?.translate?.text
        ));
        if (artifact.stages?.repair?.text) {
            repairRatios.push(qualityTextCoverageRatio(
                artifact.stages.repair.text,
                artifact.stages?.revise?.text
            ));
        }
        for (const attempt of artifact.attempts || []) {
            attempts += 1;
            increment(keyDistribution, String(attempt.keyIndex));
            if (attempt.outcome === 'error') {
                increment(errorCodes, attempt.code);
                increment(errorStatuses, attempt.status == null ? 'NO_STATUS' : String(attempt.status));
            }
        }
    }
    assert.ok(Math.min(...revisionRatios) >= 0.8);
    assert.ok(repairRatios.length === 0 || Math.min(...repairRatios) >= 0.8);

    const byFile = manifest.files.map(file => {
        const rows = artifacts.filter(artifact => artifact.source.fileName === file.fileName);
        return {
            fileName: file.fileName,
            specialty: file.specialty,
            pages: file.pageCount,
            chunks: rows.length,
            passed: rows.filter(row => row.qualityStatus === 'passed').length,
            needsReview: rows.filter(row => row.qualityStatus === 'needs_review').length,
            repairs: rows.filter(row => row.repairCount > 0).length,
        };
    });
    const report = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        scope: {
            pdfCount: manifest.totals.fileCount,
            pageCount: manifest.totals.pageCount,
            chunkCount: manifest.totals.chunkCount,
            pagesPerChunk: manifest.pagesPerChunk,
            inputSha256Verified: true,
        },
        quality: {
            passed: artifacts.filter(row => row.qualityStatus === 'passed').length,
            needsReview: artifacts.filter(row => row.qualityStatus === 'needs_review').length,
            repairs: artifacts.filter(row => row.repairCount > 0).length,
            finalFindings: aggregateFindings(artifacts),
            reviewQueue: compactReviewQueue(artifacts),
            byFile,
        },
        coverage: {
            guardMinimumRatio: 0.8,
            minimumRevisionRatio: Math.min(...revisionRatios),
            minimumRepairRatio: repairRatios.length ? Math.min(...repairRatios) : 1,
            allArtifactsPassedGuard: true,
        },
        requests: {
            configuredKeyCount: summary.configuredKeyCount,
            successfulCalls,
            attempts,
            attemptErrors: attempts - successfulCalls,
            keyDistribution,
            errorCodes,
            errorStatuses,
        },
        performance: {
            chunkEndToEndMs: stats(durations),
            singleCallMs: stats(singleCalls),
            benchmarkConcurrency: summary.options.concurrency,
            productionConcurrency: 2,
            scheduledAtBenchmarkConcurrencyMs: laneWallMs(durations, summary.options.concurrency),
            scheduledAtProductionConcurrencyMs: laneWallMs(durations, 2),
            runnerElapsedMs: Date.parse(summary.completedAt) - Date.parse(summary.startedAt),
            source: 'Sum of persisted live Gemini stage latency for every corpus chunk.',
        },
        checkpoint: {
            startedAt: summary.startedAt,
            completedAt: summary.completedAt,
            completedThisResume: summary.completed,
            reusedFromCheckpoints: summary.skipped,
        },
    };
    await Promise.all([
        writeFile(jsonReportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
        writeFile(markdownReportPath, markdown(report), 'utf8'),
    ]);
    console.log(JSON.stringify({
        jsonReport: path.relative(repositoryRoot, jsonReportPath),
        markdownReport: path.relative(repositoryRoot, markdownReportPath),
        quality: report.quality,
        requests: report.requests,
        performance: report.performance,
        coverage: report.coverage,
    }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    main().catch(error => {
        console.error(error?.stack || error);
        process.exitCode = 1;
    });
}
