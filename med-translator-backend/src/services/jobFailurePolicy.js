import { ErrorCodes } from '../utils/processingError.js';
import { R2_SOURCE_RETENTION_DAYS } from '../config/env.js';

export const INFRASTRUCTURE_ERROR_CODES = new Set([
    ErrorCodes.GEMINI_RATE_LIMIT,
    ErrorCodes.GEMINI_UNAVAILABLE,
    ErrorCodes.R2_RATE_LIMIT,
    ErrorCodes.R2_UNAVAILABLE,
    ErrorCodes.R2_TIMEOUT,
    ErrorCodes.DISK_CAPACITY,
    ErrorCodes.DATABASE_UNAVAILABLE,
    ErrorCodes.UNKNOWN_PROCESSING_ERROR,
]);

export const CONTENT_ERROR_CODES = new Set([
    ErrorCodes.GEMINI_BLOCKED,
    ErrorCodes.GEMINI_OUTPUT_TRUNCATED,
    ErrorCodes.GEMINI_RESPONSE_INVALID,
    ErrorCodes.GEMINI_SCHEMA_INVALID,
]);

export const INFRASTRUCTURE_RETRY_WINDOW_MS = 48 * 60 * 60 * 1000;
export const CONTENT_MAX_ATTEMPTS = 7;
export const SOURCE_RETENTION_MS = R2_SOURCE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const CONTENT_RETRY_DELAYS_MS = [5, 15, 30, 60, 120, 240].map(minutes => minutes * 60 * 1000);

export function classifyFailure(code) {
    if (INFRASTRUCTURE_ERROR_CODES.has(code)) return 'infrastructure';
    if (CONTENT_ERROR_CODES.has(code)) return 'content';
    return 'terminal';
}

export function isTerminalRetryable(code) {
    return classifyFailure(code) !== 'terminal';
}

export function failureAdvice({ errorCode, sourceState, storageProvider } = {}) {
    if (storageProvider === 'r2' && ['deleted', 'missing'].includes(sourceState)) {
        return 'File nguồn không còn trên Cloud. Hãy chọn lại PDF gốc và tải lên như một job mới.';
    }
    if ([ErrorCodes.INVALID_PDF, ErrorCodes.UPLOAD_INVALID].includes(errorCode)) {
        return 'PDF không hợp lệ hoặc bị hỏng. Hãy kiểm tra và tải lại bản PDF gốc.';
    }
    if ([ErrorCodes.FILE_MISSING, ErrorCodes.R2_SOURCE_MISSING].includes(errorCode)) {
        return 'Không tìm thấy file nguồn. Hãy chọn lại PDF gốc và tải lên như một job mới.';
    }
    if ([ErrorCodes.GEMINI_AUTH, ErrorCodes.GEMINI_CONFIG, ErrorCodes.R2_AUTH].includes(errorCode)) {
        return 'Cần sửa cấu hình hoặc quyền truy cập dịch vụ, sau đó dùng nút “Thử lại lỗi có thể phục hồi”.';
    }
    if (isTerminalRetryable(errorCode)) {
        return 'File nguồn vẫn được giữ tạm thời. Có thể dùng nút “Thử lại lỗi có thể phục hồi”.';
    }
    return 'Job không thể tự xử lý tiếp. Hãy kiểm tra ghi chú và tải lại PDF nếu cần.';
}
