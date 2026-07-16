import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGeminiApiKeys } from '../src/config/env.js';
import {
    BENCHMARK_VARIANTS,
    benchmarkSafeFileStem,
    runBenchmark,
} from './benchmark-project-003.js';
import { redactSensitiveText } from '../src/utils/redactSecrets.js';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), '../..');
const selectionPath = path.join(repositoryRoot, 'cline_docs', 'project-003-benchmark-selection.json');
const summaryPath = path.join(repositoryRoot, '.p003-local', 'benchmarks', 'batch-summary.json');
const benchmarkDirectory = path.dirname(summaryPath);

function valueAfter(args, name) {
    const index = args.indexOf(name);
    return index < 0 ? null : args[index + 1];
}

export function parseBatchArgs(args) {
    const variants = (valueAfter(args, '--variants') || 'B5')
        .split(',')
        .map(value => value.trim().toUpperCase())
        .filter(Boolean);
    if (variants.length === 0 || variants.some(variant => !BENCHMARK_VARIANTS[variant])) {
        throw new Error('--variants chứa biến thể không hợp lệ.');
    }
    const rawConcurrency = valueAfter(args, '--concurrency') || '2';
    const concurrency = Number.parseInt(rawConcurrency, 10);
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4 || String(concurrency) !== rawConcurrency) {
        throw new Error('--concurrency phải là số nguyên từ 1 đến 4.');
    }
    return Object.freeze({
        variants: [...new Set(variants)],
        concurrency,
        force: args.includes('--force'),
        dryRun: args.includes('--dry-run'),
    });
}

export function buildBatchTasks(selection, variants, keyCount) {
    if (!Array.isArray(selection?.samples) || selection.samples.length !== 20) {
        throw new Error('Selection benchmark phải có đúng 20 PDF.');
    }
    const effectiveKeyCount = Math.max(1, keyCount);
    return selection.samples.flatMap((sample, sampleIndex) => variants.map((variant, variantIndex) => ({
        variant,
        fileName: sample.fileName,
        startPage: sample.startPage,
        keyIndex: ((sampleIndex * variants.length) + variantIndex) % effectiveKeyCount,
    })));
}

async function artifactMatches(plan, artifactPath) {
    try {
        const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
        return artifact.schemaVersion === plan.schemaVersion
            && artifact.variant === plan.variant
            && artifact.model === plan.model
            && artifact.source?.inputSha256 === plan.source.inputSha256
            && artifact.requestConfig?.systemInstructionSha256 === plan.requestConfig.systemInstructionSha256
            && artifact.requestConfig?.pipelineInstructionSha256 === plan.requestConfig.pipelineInstructionSha256
            && Boolean(artifact.completedAt);
    } catch {
        return false;
    }
}

async function existingArtifactCandidates(task) {
    const prefix = `${task.variant.toLowerCase()}-${benchmarkSafeFileStem(task.fileName)}-p${task.startPage}-`;
    try {
        return (await readdir(benchmarkDirectory))
            .filter(name => name.startsWith(prefix) && name.endsWith('.json'))
            .map(name => path.join(benchmarkDirectory, name));
    } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
    }
}

async function runTask(task, options) {
    if (options.dryRun) return { task, outcome: 'planned', artifactPath: null };
    if (!options.force) {
        const candidates = await existingArtifactCandidates(task);
        if (candidates.length > 0) {
            const planned = await runBenchmark({ ...task, dryRun: true });
            for (const artifactPath of candidates) {
                if (await artifactMatches(planned.plan, artifactPath)) {
                    return { task, outcome: 'skipped', artifactPath };
                }
            }
        }
    }
    const result = await runBenchmark({ ...task, dryRun: false });
    return {
        task,
        outcome: 'completed',
        artifactPath: result.artifactPath,
        metadata: result.metadata,
        attempts: result.attempts,
        qualityStatus: result.qualityStatus,
        repairCount: result.repairCount,
    };
}

async function runTasks(tasks, options) {
    const results = new Array(tasks.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(options.concurrency, tasks.length) }, async () => {
        while (cursor < tasks.length) {
            const index = cursor;
            cursor += 1;
            try {
                results[index] = await runTask(tasks[index], options);
                console.log(JSON.stringify({
                    progress: `${index + 1}/${tasks.length}`,
                    variant: tasks[index].variant,
                    fileName: tasks[index].fileName,
                    outcome: results[index].outcome,
                }));
            } catch (error) {
                results[index] = {
                    task: tasks[index],
                    outcome: 'failed',
                    error: redactSensitiveText(error?.message || String(error)),
                    attempts: error?.benchmarkAttempts || [],
                };
                console.error(JSON.stringify({
                    progress: `${index + 1}/${tasks.length}`,
                    variant: tasks[index].variant,
                    fileName: tasks[index].fileName,
                    outcome: 'failed',
                    error: results[index].error,
                }));
            }
        }
    });
    await Promise.all(workers);
    return results;
}

async function main() {
    const options = parseBatchArgs(process.argv.slice(2));
    const selection = JSON.parse(await readFile(selectionPath, 'utf8'));
    const keyCount = getGeminiApiKeys().length;
    if (!options.dryRun && keyCount === 0) throw new Error('Không có GEMINI_API_KEYS để chạy benchmark batch.');
    const tasks = buildBatchTasks(selection, options.variants, keyCount || 7);
    const results = await runTasks(tasks, options);
    const summary = {
        schemaVersion: 1,
        completedAt: new Date().toISOString(),
        options,
        configuredKeyCount: keyCount,
        total: results.length,
        completed: results.filter(row => row.outcome === 'completed').length,
        skipped: results.filter(row => row.outcome === 'skipped').length,
        planned: results.filter(row => row.outcome === 'planned').length,
        failed: results.filter(row => row.outcome === 'failed').length,
        results,
    };
    await mkdir(path.dirname(summaryPath), { recursive: true });
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
        total: summary.total,
        completed: summary.completed,
        skipped: summary.skipped,
        planned: summary.planned,
        failed: summary.failed,
        summaryPath: path.relative(repositoryRoot, summaryPath),
    }, null, 2));
    if (summary.failed > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    main().catch(error => {
        console.error(redactSensitiveText(error?.stack || error));
        process.exitCode = 1;
    });
}
