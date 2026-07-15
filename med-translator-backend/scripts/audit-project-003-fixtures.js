import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createQualityGeminiExecutors } from '../src/services/qualityGeminiExecutors.js';
import { extractPdfPageRange } from '../src/utils/pdfSplitter.js';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), '../..');
const artifactDirectory = path.join(repositoryRoot, '.p003-local', 'benchmarks');
const outputDirectory = path.join(repositoryRoot, '.p003-local', 'audit-fixtures');
const publicReportPath = path.join(repositoryRoot, 'cline_docs', 'project-003-audit-fixture-report.json');
const sampleFileName = '31. Kidney Stones.pdf';
const sampleStartPage = 11;

function replaceFirst(text, pattern, replacement, fixture) {
    if (!pattern.test(text)) throw new Error(`Không tìm thấy pattern cho fixture ${fixture}.`);
    pattern.lastIndex = 0;
    return text.replace(pattern, replacement);
}

function buildFixtures(original) {
    const paragraphs = original.split(/\n\s*\n/);
    const omissionIndex = paragraphs
        .map((value, index) => ({ index, length: value.trim().length, value }))
        .filter(row => row.length > 200 && !row.value.trim().startsWith('#') && !row.value.trim().startsWith('|'))
        .sort((left, right) => right.length - left.length)[0]?.index;
    if (!Number.isInteger(omissionIndex)) throw new Error('Không tìm được đoạn phù hợp cho fixture omission.');
    const omitted = paragraphs.filter((_, index) => index !== omissionIndex).join('\n\n');

    return [
        {
            id: 'omission',
            expectedCategories: ['omission'],
            needle: null,
            draft: omitted,
        },
        {
            id: 'negation_modality',
            expectedCategories: ['negation_modality', 'mistranslation'],
            needle: 'chắc chắn luôn',
            draft: replaceFirst(original, /\bkhông\b/i, 'chắc chắn luôn', 'negation_modality'),
        },
        {
            id: 'number_unit',
            expectedCategories: ['number_unit'],
            needle: '999',
            draft: replaceFirst(
                original,
                /\d+(?:[.,]\d+)?(?=\s*(?:mg|g|kg|mL|L|mmol|mEq|µg|mcg|%))/i,
                '999',
                'number_unit'
            ),
        },
        {
            id: 'causal_relation',
            expectedCategories: ['causal_relation', 'mistranslation', 'addition'],
            needle: 'trực tiếp gây ra',
            draft: replaceFirst(
                original,
                /(?:có\s+)?liên quan\s+(?:đến|với)/i,
                'trực tiếp gây ra',
                'causal_relation'
            ),
        },
        {
            id: 'terminology',
            expectedCategories: ['terminology', 'mistranslation'],
            needle: 'tuyến giáp',
            draft: replaceFirst(original, /\bthận\b/i, 'tuyến giáp', 'terminology'),
        },
    ];
}

function categoryCount(report, categories) {
    return (report?.errors || []).filter(error => categories.includes(error.category)).length;
}

function detectsFixture(report, fixture, baseline) {
    const matching = (report?.errors || []).filter(error => fixture.expectedCategories.includes(error.category));
    if (fixture.needle) {
        return matching.some(error => JSON.stringify(error).toLocaleLowerCase('vi-VN')
            .includes(fixture.needle.toLocaleLowerCase('vi-VN')));
    }
    return matching.length > categoryCount(baseline, fixture.expectedCategories);
}

async function loadArtifact() {
    const names = (await readdir(artifactDirectory)).filter(name => /^b3-.*\.json$/i.test(name));
    for (const name of names) {
        const artifact = JSON.parse(await readFile(path.join(artifactDirectory, name), 'utf8'));
        if (artifact.source?.fileName === sampleFileName && artifact.source?.startPage === sampleStartPage) return artifact;
    }
    throw new Error('Không tìm thấy B3 artifact cho audit fixture.');
}

async function main() {
    const artifact = await loadArtifact();
    const sourceBytes = await readFile(path.join(repositoryRoot, 'samplepdf', sampleFileName));
    const pageRange = await extractPdfPageRange(sourceBytes, sampleStartPage, 2);
    const executors = createQualityGeminiExecutors();
    const audit = draftContent => executors.medical_audit({
        pdfBuffer: pageRange.buffer,
        chunk: { draftContent },
    });

    const baselineResult = await audit(artifact.response.text);
    const fixtures = buildFixtures(artifact.response.text);
    const rows = [];
    await mkdir(outputDirectory, { recursive: true });
    for (const fixture of fixtures) {
        const result = await audit(fixture.draft);
        const detected = detectsFixture(result.json, fixture, baselineResult.json);
        rows.push({
            id: fixture.id,
            expectedCategories: fixture.expectedCategories,
            detected,
            returnedStatus: result.json.status,
            returnedCategories: [...new Set(result.json.errors.map(error => error.category))],
            returnedSeverities: [...new Set(result.json.errors.map(error => error.severity))],
            errorCount: result.json.errors.length,
        });
        await writeFile(path.join(outputDirectory, `${fixture.id}.json`), `${JSON.stringify({
            fixture,
            report: result.json,
            metadata: result.metadata,
            detected,
        }, null, 2)}\n`, 'utf8');
    }
    const detectedCount = rows.filter(row => row.detected).length;
    const report = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        source: { fileName: sampleFileName, startPage: sampleStartPage, endPage: sampleStartPage + 1 },
        threshold: { requiredDetected: 4, totalFixtures: rows.length },
        detectedCount,
        passed: detectedCount >= 4,
        fixtures: rows,
    };
    await writeFile(publicReportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    main().catch(error => {
        console.error(error?.stack || error);
        process.exitCode = 1;
    });
}
