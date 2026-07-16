import assert from 'node:assert/strict';
import test from 'node:test';
import {
    hasQualityErrors,
    isQualityReport,
    QUALITY_REPORT_JSON_SCHEMA,
} from '../src/services/translationQuality.js';

const completeCoverage = {
    status: 'COMPLETE',
    items: Array.from({ length: 4 }, (_, index) => ({
        focus: 'meaning',
        sourceExcerpt: `source ${index}`,
        targetExcerpt: `target ${index}`,
        result: 'match',
    })),
};

const majorError = {
    category: 'negation_modality',
    severity: 'major',
    sourceExcerpt: 'does not increase mortality',
    targetExcerpt: 'làm tăng tỷ lệ tử vong',
    requiredCorrection: 'không làm tăng tỷ lệ tử vong',
    explanation: 'Bản dịch đảo ngược phủ định.',
};

test('quality report validator enforces PASS/FAIL consistency and required evidence', () => {
    assert.doesNotMatch(JSON.stringify(QUALITY_REPORT_JSON_SCHEMA), /minItems|maxItems/);
    assert.equal(isQualityReport({ status: 'PASS', errors: [], coverage: completeCoverage }), true);
    assert.equal(isQualityReport({ status: 'FAIL', errors: [majorError], coverage: completeCoverage }), true);
    assert.equal(isQualityReport({ status: 'PASS', errors: [majorError], coverage: completeCoverage }), false);
    assert.equal(isQualityReport({ status: 'FAIL', errors: [], coverage: completeCoverage }), false);
    assert.equal(isQualityReport({ status: 'FAIL', errors: [{ ...majorError, sourceExcerpt: '' }], coverage: completeCoverage }), false);
    assert.equal(isQualityReport({ status: 'PASS', errors: [], coverage: { ...completeCoverage, status: 'INCOMPLETE' } }), false);
    assert.deepEqual(QUALITY_REPORT_JSON_SCHEMA.required, ['status', 'errors', 'coverage']);
});

test('strict error classifier never promotes minor-only FAIL to passed', () => {
    assert.equal(hasQualityErrors({ status: 'PASS', errors: [] }), false);
    assert.equal(hasQualityErrors({ status: 'FAIL', errors: [{ ...majorError, severity: 'minor' }] }), true);
    assert.equal(hasQualityErrors({ status: 'FAIL', errors: [majorError] }), true);
});
