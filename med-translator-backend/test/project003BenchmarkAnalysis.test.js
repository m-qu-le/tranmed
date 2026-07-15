import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAggregateReport } from '../scripts/analyze-project-003-benchmark.js';

function artifact(fileName, variant, keyIndex) {
    const metadata = {
        keyIndex,
        latencyMs: 100,
        finishReason: 'STOP',
        usage: { promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: variant === 'B0' ? null : 5 },
    };
    const base = {
        schemaVersion: 1,
        variant,
        model: 'model',
        source: { fileName, startPage: 2, inputSha256: `input-${fileName}` },
        attempts: [{ keyIndex, outcome: 'success', finishReason: 'STOP' }],
        response: { text: '# Bản dịch\n\nNội dung đầy đủ.', metadata },
        qualityStatus: null,
        repairCount: 0,
        stages: null,
    };
    if (variant === 'B4') {
        base.qualityStatus = 'passed';
        base.stages = {
            translate: { metadata },
            medical_audit: { metadata, report: { status: 'PASS', errors: [] } },
            revise: { metadata },
            verify: { metadata, report: { status: 'PASS', errors: [] } },
        };
        base.finalReport = { status: 'PASS', errors: [] };
    }
    return base;
}

test('P003 analyzer accepts exactly 20 × 5 current artifacts and emits content-free aggregates', () => {
    const samples = Array.from({ length: 20 }, (_, index) => ({ fileName: `${index}.pdf`, startPage: 2 }));
    const artifacts = samples.flatMap((sample, sampleIndex) => ['B0', 'B1', 'B2', 'B3', 'B4']
        .map(variant => artifact(sample.fileName, variant, sampleIndex % 7)));
    const report = buildAggregateReport(artifacts, { samples });
    assert.equal(report.scope.artifactCount, 100);
    assert.equal(report.byVariant.B4.qualityPassed, 20);
    assert.equal(report.automatedChecks.nonStopTotal, 0);
    assert.equal(report.automatedChecks.inputConsistencyFailures.length, 0);
    assert.equal(JSON.stringify(report).includes('Nội dung đầy đủ'), false);
});
