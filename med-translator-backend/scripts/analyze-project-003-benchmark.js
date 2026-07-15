import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), '../..');
const artifactDirectory = path.join(repositoryRoot, '.p003-local', 'benchmarks');
const selectionPath = path.join(repositoryRoot, 'cline_docs', 'project-003-benchmark-selection.json');
const manifestPath = path.join(repositoryRoot, 'cline_docs', 'project-003-sample-manifest.json');
const reportPath = path.join(repositoryRoot, 'cline_docs', 'project-003-benchmark-report.json');
const reviewDirectory = path.join(repositoryRoot, '.p003-local', 'blind-review');
const VARIANTS = ['B0', 'B1', 'B2', 'B3', 'B4'];
const BLIND_VARIANTS = ['B1', 'B2', 'B3', 'B4'];

function quantile(values, fraction) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function summarizeNumbers(values) {
    const finite = values.filter(Number.isFinite);
    if (finite.length === 0) return { mean: null, p50: null, p95: null, min: null, max: null };
    return {
        mean: Math.round(finite.reduce((sum, value) => sum + value, 0) / finite.length),
        p50: Math.round(quantile(finite, 0.5)),
        p95: Math.round(quantile(finite, 0.95)),
        min: Math.round(Math.min(...finite)),
        max: Math.round(Math.max(...finite)),
    };
}

function usageOf(metadata, field) {
    return metadata?.usage?.[field];
}

function allStageRows(artifact) {
    if (artifact.variant !== 'B4') return [{ stage: artifact.variant, metadata: artifact.response?.metadata }];
    return Object.entries(artifact.stages || {}).map(([stage, value]) => ({ stage, metadata: value.metadata }));
}

function countFindings(reports) {
    const categories = {};
    const severities = {};
    for (const report of reports.filter(Boolean)) {
        for (const error of report.errors || []) {
            categories[error.category] = (categories[error.category] || 0) + 1;
            severities[error.severity] = (severities[error.severity] || 0) + 1;
        }
    }
    return { categories, severities };
}

function outputChecks(artifact) {
    const text = artifact.response?.text || '';
    const stageRows = allStageRows(artifact);
    return {
        nonEmpty: text.trim().length > 0,
        outputChars: text.length,
        headingCount: (text.match(/^#{1,6}\s+/gm) || []).length,
        tableRowCount: (text.match(/^\|.*\|\s*$/gm) || []).length,
        horizontalRuleCount: (text.match(/^\s*---+\s*$/gm) || []).length,
        allFinishStop: stageRows.every(row => row.metadata?.finishReason === 'STOP'),
        structuredReportsValid: artifact.variant !== 'B4' || Boolean(
            artifact.stages?.medical_audit?.report
            && artifact.stages?.verify?.report
            && artifact.finalReport
        ),
    };
}

function deterministicOrder(fileName) {
    return [...BLIND_VARIANTS].sort((left, right) => {
        const leftHash = createHash('sha256').update(`${fileName}:${left}`).digest('hex');
        const rightHash = createHash('sha256').update(`${fileName}:${right}`).digest('hex');
        return leftHash.localeCompare(rightHash);
    });
}

function safeStem(fileName) {
    return path.basename(fileName, '.pdf').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}

export function buildAggregateReport(artifacts, selection) {
    const selected = artifacts.filter(artifact => selection.samples.some(sample => (
        sample.fileName === artifact.source?.fileName && sample.startPage === artifact.source?.startPage
    )) && VARIANTS.includes(artifact.variant));
    const uniqueKeys = new Set(selected.map(row => `${row.variant}:${row.source.fileName}`));
    if (uniqueKeys.size !== 100) throw new Error(`Cần đúng 100 artifact hiện hành, nhận ${uniqueKeys.size}.`);

    const inputConsistencyFailures = [];
    const lengthWarnings = [];
    for (const sample of selection.samples) {
        const qualityRows = selected.filter(row => row.source.fileName === sample.fileName && BLIND_VARIANTS.includes(row.variant));
        if (new Set(qualityRows.map(row => row.source.inputSha256)).size !== 1) inputConsistencyFailures.push(sample.fileName);
        const lengths = qualityRows.map(row => row.response?.text?.length || 0);
        const median = quantile(lengths, 0.5) || 1;
        for (const row of qualityRows) {
            const ratio = (row.response?.text?.length || 0) / median;
            if (ratio < 0.65 || ratio > 1.5) lengthWarnings.push({
                fileName: sample.fileName,
                variant: row.variant,
                ratioToMedian: Number(ratio.toFixed(3)),
            });
        }
    }

    const attempts = selected.flatMap(artifact => (artifact.attempts || []).map(attempt => ({
        variant: artifact.variant,
        ...attempt,
    })));
    const keyDistribution = {};
    const errorCodeDistribution = {};
    const errorStatusDistribution = {};
    for (const attempt of attempts) {
        const key = String(attempt.keyIndex);
        keyDistribution[key] = (keyDistribution[key] || 0) + 1;
        if (attempt.outcome === 'error') {
            const code = attempt.code || 'NO_CODE';
            const status = String(attempt.status ?? 'NO_STATUS');
            errorCodeDistribution[code] = (errorCodeDistribution[code] || 0) + 1;
            errorStatusDistribution[status] = (errorStatusDistribution[status] || 0) + 1;
        }
    }

    const byVariant = Object.fromEntries(VARIANTS.map(variant => {
        const rows = selected.filter(row => row.variant === variant);
        const stageRows = rows.flatMap(allStageRows);
        const checks = rows.map(outputChecks);
        return [variant, {
            samples: rows.length,
            modelCalls: stageRows.length,
            requestAttempts: attempts.filter(attempt => attempt.variant === variant).length,
            attemptErrors: attempts.filter(attempt => attempt.variant === variant && attempt.outcome === 'error').length,
            attempts429: attempts.filter(attempt => attempt.variant === variant && attempt.status === 429).length,
            latencyMs: summarizeNumbers(stageRows.map(row => row.metadata?.latencyMs)),
            promptTokens: summarizeNumbers(stageRows.map(row => usageOf(row.metadata, 'promptTokenCount'))),
            outputTokens: summarizeNumbers(stageRows.map(row => usageOf(row.metadata, 'candidatesTokenCount'))),
            thoughtTokens: summarizeNumbers(stageRows.map(row => usageOf(row.metadata, 'thoughtsTokenCount'))),
            outputChars: summarizeNumbers(checks.map(check => check.outputChars)),
            nonStop: checks.filter(check => !check.allFinishStop).length,
            empty: checks.filter(check => !check.nonEmpty).length,
            invalidStructured: checks.filter(check => !check.structuredReportsValid).length,
            horizontalRules: checks.reduce((sum, check) => sum + check.horizontalRuleCount, 0),
            qualityPassed: rows.filter(row => row.qualityStatus === 'passed').length,
            needsReview: rows.filter(row => row.qualityStatus === 'needs_review').length,
            repairs: rows.reduce((sum, row) => sum + (row.repairCount || 0), 0),
        }];
    }));

    const b4Rows = selected.filter(row => row.variant === 'B4');
    const b4BySpecialty = {};
    for (const row of b4Rows) {
        const specialty = selection.samples.find(sample => sample.fileName === row.source.fileName)?.specialty || 'Chưa phân loại';
        const bucket = b4BySpecialty[specialty] ||= { samples: 0, passed: 0, needsReview: 0, repairs: 0 };
        bucket.samples += 1;
        bucket.passed += row.qualityStatus === 'passed' ? 1 : 0;
        bucket.needsReview += row.qualityStatus === 'needs_review' ? 1 : 0;
        bucket.repairs += row.repairCount || 0;
    }
    const b4StageMetrics = Object.fromEntries([
        'translate', 'medical_audit', 'revise', 'verify', 'repair', 'reverify',
    ].map(stage => {
        const rows = b4Rows.map(row => row.stages?.[stage]?.metadata).filter(Boolean);
        return [stage, {
            calls: rows.length,
            latencyMs: summarizeNumbers(rows.map(row => row.latencyMs)),
            promptTokens: summarizeNumbers(rows.map(row => usageOf(row, 'promptTokenCount'))),
            outputTokens: summarizeNumbers(rows.map(row => usageOf(row, 'candidatesTokenCount'))),
            thoughtTokens: summarizeNumbers(rows.map(row => usageOf(row, 'thoughtsTokenCount'))),
        }];
    }));

    return {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        scope: { pdfCount: 20, variants: VARIANTS, artifactCount: selected.length },
        automatedChecks: {
            inputConsistencyFailures,
            lengthWarnings,
            nonStopTotal: Object.values(byVariant).reduce((sum, row) => sum + row.nonStop, 0),
            emptyTotal: Object.values(byVariant).reduce((sum, row) => sum + row.empty, 0),
            invalidStructuredTotal: Object.values(byVariant).reduce((sum, row) => sum + row.invalidStructured, 0),
        },
        errors: {
            attempts429: attempts.filter(row => row.status === 429).length,
            attempts5xx: attempts.filter(row => Number(row.status) >= 500).length,
            attemptsAuth: attempts.filter(row => [401, 403].includes(row.status)).length,
            attemptErrors: attempts.filter(row => row.outcome === 'error').length,
            errorCodeDistribution,
            errorStatusDistribution,
        },
        keyDistribution,
        byVariant,
        b4Quality: {
            bySpecialty: b4BySpecialty,
            stageMetrics: b4StageMetrics,
            auditFindings: countFindings(b4Rows.map(row => row.stages?.medical_audit?.report)),
            finalFindings: countFindings(b4Rows.map(row => row.finalReport)),
            cases: b4Rows.map(row => ({
                fileName: row.source.fileName,
                specialty: selection.samples.find(sample => sample.fileName === row.source.fileName)?.specialty || null,
                startPage: row.source.startPage,
                endPage: row.source.endPage,
                qualityStatus: row.qualityStatus,
                repairCount: row.repairCount || 0,
                finalErrors: (row.finalReport?.errors || []).map(error => ({
                    category: error.category,
                    severity: error.severity,
                })),
            })),
        },
    };
}

async function createBlindReview(artifacts, selection) {
    const blindIndex = [];
    const answerKey = [];
    for (const sample of selection.samples) {
        const sampleDirectory = path.join(reviewDirectory, safeStem(sample.fileName));
        await mkdir(sampleDirectory, { recursive: true });
        const order = deterministicOrder(sample.fileName);
        const labels = [];
        for (const [index, variant] of order.entries()) {
            const artifact = artifacts.find(row => row.variant === variant
                && row.source?.fileName === sample.fileName
                && row.source?.startPage === sample.startPage);
            if (!artifact) throw new Error(`Thiếu artifact ${variant} cho ${sample.fileName}.`);
            const label = String.fromCharCode(65 + index);
            const fileName = `${label}.md`;
            await writeFile(path.join(sampleDirectory, fileName), `${artifact.response.text.trim()}\n`, 'utf8');
            labels.push({ label, fileName });
            answerKey.push({ fileName: sample.fileName, label, variant });
        }
        blindIndex.push({
            sampleId: safeStem(sample.fileName),
            fileName: sample.fileName,
            startPage: sample.startPage,
            endPage: sample.endPage,
            labels,
        });
    }
    await writeFile(path.join(reviewDirectory, 'blind-index.json'), `${JSON.stringify(blindIndex, null, 2)}\n`, 'utf8');
    await writeFile(path.join(reviewDirectory, 'answer-key.json'), `${JSON.stringify(answerKey, null, 2)}\n`, 'utf8');
}

async function main() {
    const selection = JSON.parse(await readFile(selectionPath, 'utf8'));
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const specialtyByFile = new Map(manifest.files.map(file => [file.fileName, file.specialty]));
    selection.samples = selection.samples.map(sample => ({
        ...sample,
        specialty: specialtyByFile.get(sample.fileName) || null,
    }));
    const names = (await readdir(artifactDirectory)).filter(name => /^b[0-4]-.*\.json$/i.test(name));
    const artifacts = await Promise.all(names.map(async name => JSON.parse(await readFile(path.join(artifactDirectory, name), 'utf8'))));
    const report = buildAggregateReport(artifacts, selection);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await createBlindReview(artifacts, selection);
    console.log(JSON.stringify({
        reportPath: path.relative(repositoryRoot, reportPath),
        blindReviewPath: path.relative(repositoryRoot, reviewDirectory),
        scope: report.scope,
        automatedChecks: report.automatedChecks,
        errors: report.errors,
    }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    main().catch(error => {
        console.error(error?.stack || error);
        process.exitCode = 1;
    });
}
