import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGeminiApiKeys } from '../src/config/env.js';
import { benchmarkSafeFileStem, runBenchmark } from './benchmark-project-003.js';
import { redactSensitiveText } from '../src/utils/redactSecrets.js';
import { isQualityTextCoverageAcceptable } from '../src/services/qualityTextGuard.js';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), '../..');
const manifestPath = path.join(repositoryRoot, 'cline_docs', 'project-003-sample-manifest.json');
const benchmarkDirectory = path.join(repositoryRoot, '.p003-local', 'benchmarks');
const runDirectory = path.join(repositoryRoot, '.p003-local', 'full-corpus');
const summaryPath = path.join(runDirectory, 'summary.json');
const dryRunSummaryPath = path.join(runDirectory, 'dry-run-summary.json');

function valueAfter(args, name) {
    const index = args.indexOf(name);
    return index < 0 ? null : args[index + 1];
}

export function parseFullCorpusArgs(args) {
    const rawConcurrency = valueAfter(args, '--concurrency') || '2';
    const concurrency = Number.parseInt(rawConcurrency, 10);
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4 || String(concurrency) !== rawConcurrency) {
        throw new Error('--concurrency phải là số nguyên từ 1 đến 4.');
    }
    return Object.freeze({
        concurrency,
        force: args.includes('--force'),
        dryRun: args.includes('--dry-run'),
    });
}

export function buildFullCorpusTasks(manifest, keyCount) {
    if (manifest?.pagesPerChunk !== 2 || !Array.isArray(manifest.files)) {
        throw new Error('Manifest P003 không hợp lệ hoặc không dùng 2 trang/chunk.');
    }
    const effectiveKeyCount = Math.max(1, keyCount);
    const tasks = [];
    for (const file of manifest.files) {
        for (let startPage = 1; startPage <= file.pageCount; startPage += manifest.pagesPerChunk) {
            tasks.push({
                variant: 'B4',
                fileName: file.fileName,
                startPage,
                endPage: Math.min(file.pageCount, startPage + manifest.pagesPerChunk - 1),
                keyIndex: tasks.length % effectiveKeyCount,
            });
        }
    }
    if (tasks.length !== manifest.totals.chunkCount) {
        throw new Error(`Manifest khai báo ${manifest.totals.chunkCount} chunk nhưng dựng được ${tasks.length}.`);
    }
    return tasks;
}

export function fullCorpusSummaryPath(options) {
    return options.dryRun ? dryRunSummaryPath : summaryPath;
}

export function isReusableFullCorpusArtifact(artifact, plan) {
    const stages = artifact?.stages || {};
    const requiredTextStages = ['translate', 'revise'];
    const requiredReportStages = ['medical_audit', 'verify'];
    const baseStagesValid = requiredTextStages.every(stage => (
        typeof stages[stage]?.text === 'string'
        && stages[stage].text.trim().length > 0
        && stages[stage]?.metadata
    )) && requiredReportStages.every(stage => stages[stage]?.report && stages[stage]?.metadata);
    const repairStagesValid = artifact?.repairCount === 0 || (
        typeof stages.repair?.text === 'string'
        && stages.repair.text.trim().length > 0
        && stages.repair?.metadata
        && stages.reverify?.report
        && stages.reverify?.metadata
    );
    return Boolean(
        baseStagesValid
        && repairStagesValid
        && ['passed', 'needs_review'].includes(artifact?.qualityStatus)
        && typeof artifact?.response?.text === 'string'
        && artifact.response.text.trim().length > 0
        && artifact.schemaVersion === plan.schemaVersion
        && artifact.variant === plan.variant
        && artifact.model === plan.model
        && artifact.source?.inputSha256 === plan.source.inputSha256
        && artifact.requestConfig?.systemInstructionSha256 === plan.requestConfig.systemInstructionSha256
        && artifact.requestConfig?.pipelineInstructionSha256 === plan.requestConfig.pipelineInstructionSha256
        && isQualityTextCoverageAcceptable(stages.revise.text, stages.translate.text)
        && (!stages.repair?.text || isQualityTextCoverageAcceptable(stages.repair.text, stages.revise.text))
        && artifact.completedAt
    );
}

async function matchingArtifact(task) {
    const prefix = `b4-${benchmarkSafeFileStem(task.fileName)}-p${task.startPage}-${task.endPage}`;
    let candidates;
    try {
        candidates = (await readdir(benchmarkDirectory))
            .filter(name => name === `${prefix}.json`)
            .map(name => path.join(benchmarkDirectory, name));
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
    if (candidates.length === 0) return null;
    const planned = await runBenchmark({ ...task, dryRun: true });
    for (const artifactPath of candidates) {
        try {
            const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
            if (isReusableFullCorpusArtifact(artifact, planned.plan)) {
                return { artifactPath, artifact };
            }
        } catch {
            // Artifact hỏng sẽ được chạy lại và ghi đè an toàn.
        }
    }
    return null;
}

function aggregateResult(task, outcome, detail = {}) {
    return {
        fileName: task.fileName,
        startPage: task.startPage,
        endPage: task.endPage,
        keyIndex: task.keyIndex,
        outcome,
        qualityStatus: detail.qualityStatus || null,
        repairCount: detail.repairCount || 0,
        attempts: Array.isArray(detail.attempts) ? detail.attempts.length : 0,
        error: detail.error || null,
    };
}

async function runOne(task, options) {
    if (options.dryRun) return aggregateResult(task, 'planned');
    if (!options.force) {
        const existing = await matchingArtifact(task);
        if (existing) {
            return aggregateResult(task, 'skipped', {
                qualityStatus: existing.artifact.qualityStatus,
                repairCount: existing.artifact.repairCount,
                attempts: existing.artifact.attempts,
            });
        }
    }
    const completed = await runBenchmark({ ...task, dryRun: false });
    return aggregateResult(task, 'completed', completed);
}

async function persistProgress(options, keyCount, results, total, startedAt) {
    const present = results.filter(Boolean);
    const summary = {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        startedAt,
        completedAt: present.length === total ? new Date().toISOString() : null,
        options,
        configuredKeyCount: keyCount,
        total,
        processed: present.length,
        completed: present.filter(row => row.outcome === 'completed').length,
        skipped: present.filter(row => row.outcome === 'skipped').length,
        planned: present.filter(row => row.outcome === 'planned').length,
        failed: present.filter(row => row.outcome === 'failed').length,
        passed: present.filter(row => row.qualityStatus === 'passed').length,
        needsReview: present.filter(row => row.qualityStatus === 'needs_review').length,
        repairs: present.filter(row => row.repairCount > 0).length,
        results: present,
    };
    await mkdir(runDirectory, { recursive: true });
    await writeFile(fullCorpusSummaryPath(options), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    return summary;
}

async function main() {
    const options = parseFullCorpusArgs(process.argv.slice(2));
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const keyCount = getGeminiApiKeys().length;
    if (!options.dryRun && keyCount === 0) throw new Error('Không có GEMINI_API_KEYS để chạy full corpus.');
    const tasks = buildFullCorpusTasks(manifest, keyCount || 7);
    const results = new Array(tasks.length);
    const startedAt = new Date().toISOString();
    let cursor = 0;
    let writeGate = Promise.resolve();

    const record = async (index, result) => {
        results[index] = result;
        writeGate = writeGate.then(() => persistProgress(options, keyCount, results, tasks.length, startedAt));
        await writeGate;
        console.log(JSON.stringify({
            progress: `${results.filter(Boolean).length}/${tasks.length}`,
            fileName: result.fileName,
            pages: `${result.startPage}-${result.endPage}`,
            outcome: result.outcome,
            qualityStatus: result.qualityStatus,
            repairCount: result.repairCount,
        }));
    };

    const workers = Array.from({ length: Math.min(options.concurrency, tasks.length) }, async () => {
        while (cursor < tasks.length) {
            const index = cursor;
            cursor += 1;
            try {
                await record(index, await runOne(tasks[index], options));
            } catch (error) {
                await record(index, aggregateResult(tasks[index], 'failed', {
                    attempts: error?.benchmarkAttempts,
                    error: redactSensitiveText(error?.message || String(error)),
                }));
            }
        }
    });
    await Promise.all(workers);
    const summary = await persistProgress(options, keyCount, results, tasks.length, startedAt);
    console.log(JSON.stringify({
        summaryPath: path.relative(repositoryRoot, fullCorpusSummaryPath(options)),
        total: summary.total,
        completed: summary.completed,
        skipped: summary.skipped,
        failed: summary.failed,
        passed: summary.passed,
        needsReview: summary.needsReview,
        repairs: summary.repairs,
    }, null, 2));
    if (summary.failed > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    main().catch(error => {
        console.error(redactSensitiveText(error?.stack || error));
        process.exitCode = 1;
    });
}
