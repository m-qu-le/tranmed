export const ErrorCodes = Object.freeze({
    CANCELLED: 'CANCELLED',
    FILE_MISSING: 'FILE_MISSING',
    R2_SOURCE_MISSING: 'R2_SOURCE_MISSING',
    R2_AUTH: 'R2_AUTH',
    R2_RATE_LIMIT: 'R2_RATE_LIMIT',
    R2_UNAVAILABLE: 'R2_UNAVAILABLE',
    R2_TIMEOUT: 'R2_TIMEOUT',
    DISK_CAPACITY: 'DISK_CAPACITY',
    INVALID_PDF: 'INVALID_PDF',
    UPLOAD_INVALID: 'UPLOAD_INVALID',
    GEMINI_AUTH: 'GEMINI_AUTH',
    GEMINI_CONFIG: 'GEMINI_CONFIG',
    GEMINI_RATE_LIMIT: 'GEMINI_RATE_LIMIT',
    GEMINI_UNAVAILABLE: 'GEMINI_UNAVAILABLE',
    GEMINI_BLOCKED: 'GEMINI_BLOCKED',
    GEMINI_OUTPUT_TRUNCATED: 'GEMINI_OUTPUT_TRUNCATED',
    GEMINI_RESPONSE_INVALID: 'GEMINI_RESPONSE_INVALID',
    GEMINI_SCHEMA_INVALID: 'GEMINI_SCHEMA_INVALID',
    SCHEDULER_SUSPENDED: 'SCHEDULER_SUSPENDED',
    DATABASE_UNAVAILABLE: 'DATABASE_UNAVAILABLE',
    UNKNOWN_PROCESSING_ERROR: 'UNKNOWN_PROCESSING_ERROR'
});

export class ProcessingError extends Error {
    constructor(code, message, options = {}) {
        super(message, options.cause ? { cause: options.cause } : undefined);
        this.name = 'ProcessingError';
        this.code = code;
        this.retryable = options.retryable ?? false;
        this.quotaRelated = options.quotaRelated ?? false;
        this.poolExhausted = options.poolExhausted ?? false;
        this.publicMessage = options.publicMessage || message;
    }
}

export function normalizeProcessingError(error) {
    if (error instanceof ProcessingError) return error;

    return new ProcessingError(
        ErrorCodes.UNKNOWN_PROCESSING_ERROR,
        error?.message || 'Lỗi xử lý không xác định.',
        {
            retryable: true,
            publicMessage: 'Có lỗi tạm thời khi xử lý tài liệu.'
        }
    );
}
