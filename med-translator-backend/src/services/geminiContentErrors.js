import { ErrorCodes } from '../utils/processingError.js';

export const GEMINI_CONTENT_ERROR_CODES = new Set([
    ErrorCodes.GEMINI_BLOCKED,
    ErrorCodes.GEMINI_OUTPUT_TRUNCATED,
    ErrorCodes.GEMINI_RESPONSE_INVALID,
    ErrorCodes.GEMINI_SCHEMA_INVALID,
]);

export function isGeminiContentError(code) {
    return GEMINI_CONTENT_ERROR_CODES.has(code);
}
