import { ErrorCodes, ProcessingError } from '../utils/processingError.js';
import {
    GEMINI_CONTENT_ERROR_CODES,
    isGeminiContentError,
} from './geminiContentErrors.js';

export const QUALITY_STAGE_CONTENT_FAILURE_LIMIT = 3;
export const QUALITY_STAGE_CONTENT_RETRY_DELAYS_MS = Object.freeze([
    5 * 60 * 1000,
    15 * 60 * 1000,
]);

export const QUALITY_CONTENT_ERROR_CODES = GEMINI_CONTENT_ERROR_CODES;

export function isQualityContentError(code) {
    return isGeminiContentError(code);
}

export function qualityStageRetryAt(failureCount, now = Date.now()) {
    const normalizedCount = Number.isSafeInteger(failureCount) && failureCount > 0
        ? failureCount
        : 1;
    const delay = QUALITY_STAGE_CONTENT_RETRY_DELAYS_MS[
        Math.min(normalizedCount - 1, QUALITY_STAGE_CONTENT_RETRY_DELAYS_MS.length - 1)
    ];
    return new Date(now + delay);
}

export function createQualityStageRetryError(error, failureCount, now = Date.now()) {
    const nextAvailableAt = qualityStageRetryAt(failureCount, now);
    const retry = new ProcessingError(
        ErrorCodes.QUALITY_STAGE_RETRY,
        'Quality stage được hoãn sau lỗi nội dung để các chunk khác tiếp tục.',
        {
            retryable: true,
            publicMessage: 'Một phần của tài liệu cần thử xử lý lại; các phần khác vẫn tiếp tục.',
        }
    );
    retry.stageErrorCode = error?.code || ErrorCodes.GEMINI_RESPONSE_INVALID;
    retry.nextAvailableAt = nextAvailableAt;
    retry.retryAfterMs = Math.max(1, nextAvailableAt.getTime() - now);
    retry.deferredReason = 'content_retry';
    retry.failureCount = failureCount;
    return retry;
}
