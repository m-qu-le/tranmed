import assert from 'node:assert/strict';
import test from 'node:test';
import {
    hasBlockingQualityErrors,
    isQualityReport,
    QUALITY_REPORT_JSON_SCHEMA,
} from '../src/services/translationQuality.js';

const majorError = {
    category: 'negation_modality',
    severity: 'major',
    sourceExcerpt: 'does not increase mortality',
    targetExcerpt: 'làm tăng tỷ lệ tử vong',
    requiredCorrection: 'không làm tăng tỷ lệ tử vong',
    explanation: 'Bản dịch đảo ngược phủ định.',
};

test('quality report validator enforces PASS/FAIL consistency and required evidence', () => {
    assert.equal(isQualityReport({ status: 'PASS', errors: [] }), true);
    assert.equal(isQualityReport({ status: 'FAIL', errors: [majorError] }), true);
    assert.equal(isQualityReport({ status: 'PASS', errors: [majorError] }), false);
    assert.equal(isQualityReport({ status: 'FAIL', errors: [] }), false);
    assert.equal(isQualityReport({ status: 'FAIL', errors: [{ ...majorError, sourceExcerpt: '' }] }), false);
    assert.deepEqual(QUALITY_REPORT_JSON_SCHEMA.required, ['status', 'errors']);
});

test('only critical and major errors trigger the bounded repair loop', () => {
    assert.equal(hasBlockingQualityErrors({ status: 'PASS', errors: [] }), false);
    assert.equal(hasBlockingQualityErrors({ status: 'FAIL', errors: [{ ...majorError, severity: 'minor' }] }), false);
    assert.equal(hasBlockingQualityErrors({ status: 'FAIL', errors: [majorError] }), true);
});
