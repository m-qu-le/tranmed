import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildFullCorpusTasks,
    fullCorpusSummaryPath,
    isReusableFullCorpusArtifact,
    parseFullCorpusArgs,
} from '../scripts/benchmark-project-003-full-corpus.js';

test('full corpus task builder preserves per-file page order and key distribution', () => {
    const manifest = {
        pagesPerChunk: 2,
        totals: { chunkCount: 5 },
        files: [
            { fileName: 'a.pdf', pageCount: 5 },
            { fileName: 'b.pdf', pageCount: 3 },
        ],
    };
    const tasks = buildFullCorpusTasks(manifest, 3);
    assert.deepEqual(tasks.map(task => [task.fileName, task.startPage, task.endPage, task.keyIndex]), [
        ['a.pdf', 1, 2, 0],
        ['a.pdf', 3, 4, 1],
        ['a.pdf', 5, 5, 2],
        ['b.pdf', 1, 2, 0],
        ['b.pdf', 3, 3, 1],
    ]);
});

test('full corpus args default to production chunk concurrency', () => {
    assert.deepEqual(parseFullCorpusArgs([]), { concurrency: 2, force: false, dryRun: false });
    assert.deepEqual(parseFullCorpusArgs(['--concurrency', '4', '--dry-run']), {
        concurrency: 4,
        force: false,
        dryRun: true,
    });
    assert.throws(() => parseFullCorpusArgs(['--concurrency', '5']), /1 đến 4/);
});

test('full corpus dry-run cannot overwrite the live checkpoint', () => {
    assert.notEqual(
        fullCorpusSummaryPath({ dryRun: true }),
        fullCorpusSummaryPath({ dryRun: false })
    );
});

test('full corpus resume reuses only complete version-matched artifacts with safe coverage', () => {
    const plan = {
        schemaVersion: 1,
        variant: 'B4',
        model: 'gemini-3.1-flash-lite',
        source: { inputSha256: 'input-sha' },
        requestConfig: {
            systemInstructionSha256: 'system-sha',
            pipelineInstructionSha256: 'pipeline-sha',
        },
    };
    const text = 'Nội dung y khoa đầy đủ. '.repeat(100);
    const artifact = {
        ...plan,
        completedAt: '2026-07-16T00:00:00.000Z',
        qualityStatus: 'passed',
        repairCount: 0,
        response: { text },
        stages: {
            translate: { text, metadata: {} },
            medical_audit: { report: { status: 'PASS', errors: [] }, metadata: {} },
            revise: { text, metadata: {} },
            verify: { report: { status: 'PASS', errors: [] }, metadata: {} },
        },
    };

    assert.equal(isReusableFullCorpusArtifact(artifact, plan), true);
    assert.equal(isReusableFullCorpusArtifact({ ...artifact, completedAt: null }, plan), false);
    assert.equal(isReusableFullCorpusArtifact({
        ...artifact,
        stages: { ...artifact.stages, revise: { text: 'Bản bị cụt.', metadata: {} } },
    }, plan), false);
});
