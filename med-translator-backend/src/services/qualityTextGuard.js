import { ErrorCodes, ProcessingError } from '../utils/processingError.js';

export const MIN_QUALITY_TEXT_COVERAGE_RATIO = 0.8;

function meaningfulLength(value) {
    if (typeof value !== 'string') return 0;
    return value.replace(/\s+/g, '').length;
}

export function qualityTextCoverageRatio(candidate, reference) {
    const referenceLength = meaningfulLength(reference);
    if (referenceLength === 0) return 1;
    return meaningfulLength(candidate) / referenceLength;
}

export function isQualityTextCoverageAcceptable(candidate, reference, minimumRatio = MIN_QUALITY_TEXT_COVERAGE_RATIO) {
    return qualityTextCoverageRatio(candidate, reference) >= minimumRatio;
}

export function assertQualityTextCoverage({ candidate, reference, stage, metadata }) {
    const ratio = qualityTextCoverageRatio(candidate, reference);
    if (ratio >= MIN_QUALITY_TEXT_COVERAGE_RATIO) return ratio;
    const error = new ProcessingError(
        ErrorCodes.GEMINI_RESPONSE_INVALID,
        `Gemini stage ${stage} chỉ giữ ${(ratio * 100).toFixed(1)}% độ phủ văn bản; yêu cầu tối thiểu ${(MIN_QUALITY_TEXT_COVERAGE_RATIO * 100).toFixed(0)}%.`,
        {
            retryable: true,
            publicMessage: 'Bản hiệu chỉnh có dấu hiệu bỏ sót nội dung; hệ thống sẽ thử lại.',
        }
    );
    error.geminiMetadata = metadata || null;
    error.coverageRatio = ratio;
    throw error;
}
