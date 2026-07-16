import assert from 'node:assert/strict';
import test from 'node:test';
import { ErrorCodes } from '../src/utils/processingError.js';
import {
    assertQualityTextCoverage,
    isQualityTextCoverageAcceptable,
    qualityTextCoverageRatio,
} from '../src/services/qualityTextGuard.js';

test('quality text guard ignores whitespace while accepting targeted edits', () => {
    const reference = 'Một đoạn văn bản y khoa đầy đủ. '.repeat(20);
    const candidate = `\n${reference.replaceAll('đầy đủ', 'hoàn chỉnh')}\n`;
    assert.ok(qualityTextCoverageRatio(candidate, reference) > 0.9);
    assert.equal(isQualityTextCoverageAcceptable(candidate, reference), true);
    assert.ok(assertQualityTextCoverage({ candidate, reference, stage: 'repair' }) > 0.9);
});

test('quality text guard rejects a repair that collapses to one small subsection', () => {
    const reference = 'Nội dung nguồn phải được giữ nguyên. '.repeat(100);
    const candidate = 'Chỉ còn một bảng ngắn. '.repeat(20);
    assert.equal(isQualityTextCoverageAcceptable(candidate, reference), false);
    assert.throws(
        () => assertQualityTextCoverage({
            candidate,
            reference,
            stage: 'repair',
            metadata: { finishReason: 'STOP' },
        }),
        error => error.code === ErrorCodes.GEMINI_RESPONSE_INVALID
            && error.retryable
            && error.coverageRatio < 0.8
            && error.geminiMetadata.finishReason === 'STOP'
    );
});
