import { minimumQualityCoverageItems } from './translationQuality.js';

const CATEGORY_LABELS = Object.freeze({
    mistranslation: 'Dịch sai nghĩa',
    omission: 'Thiếu nội dung',
    addition: 'Thêm nội dung không có trong nguồn',
    terminology: 'Thuật ngữ chưa chính xác',
    negation_modality: 'Sai phủ định hoặc mức độ chắc chắn',
    causal_relation: 'Sai quan hệ nguyên nhân–kết quả',
    number_unit: 'Sai số liệu hoặc đơn vị',
    table_figure: 'Sai hoặc thiếu nội dung bảng/hình',
    formatting: 'Lỗi định dạng ảnh hưởng nội dung',
});

const SEVERITY_LABELS = Object.freeze({
    critical: 'Nghiêm trọng',
    major: 'Quan trọng',
    minor: 'Nhẹ',
});

const COVERAGE_LABELS = Object.freeze({
    meaning: 'Ý nghĩa chính',
    terminology: 'Thuật ngữ',
    number_unit: 'Số liệu hoặc đơn vị',
    negation_modality: 'Phủ định hoặc mức độ chắc chắn',
    causal_relation: 'Quan hệ nguyên nhân–kết quả',
    table_figure: 'Bảng, hình hoặc chú thích',
    recommendation: 'Khuyến cáo lâm sàng',
});

const TECHNICAL_REASON_LABELS = Object.freeze({
    GEMINI_BLOCKED: 'Bước sửa tự động bị hệ thống xử lý chặn nên không tạo được bản sửa hợp lệ',
    GEMINI_OUTPUT_TRUNCATED: 'Đầu ra của bước sửa tự động bị cắt ngắn nên không thể dùng an toàn',
    GEMINI_RESPONSE_INVALID: 'Bước sửa tự động không trả về nội dung có thể sử dụng',
    GEMINI_SCHEMA_INVALID: 'Đầu ra của bước sửa tự động không đúng cấu trúc bắt buộc',
});

// ponytail: Giới hạn 500 ký tự giữ header dễ đọc; tăng giới hạn hoặc cấu hình hóa nếu review thực tế cần thêm ngữ cảnh.
const MAX_EXCERPT_LENGTH = 500;

function safeText(value, fallback) {
    if (typeof value !== 'string' || !value.trim()) return fallback;
    const normalized = value.replace(/\s+/g, ' ').trim();
    const shortened = normalized.length > MAX_EXCERPT_LENGTH
        ? `${normalized.slice(0, MAX_EXCERPT_LENGTH - 1)}…`
        : normalized;
    return shortened
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/([\\`*_[\]|])/g, '\\$1');
}

function pageLabel(chunk) {
    const start = Number.isInteger(chunk?.pageStart) ? chunk.pageStart : null;
    const end = Number.isInteger(chunk?.pageEnd) ? chunk.pageEnd : null;
    if (!start) return '';
    return end && end !== start ? ` — trang ${start}–${end}` : ` — trang ${start}`;
}

function finalReport(chunk) {
    return chunk?.reverifyReport ?? chunk?.verificationReport ?? null;
}

function coverageSummary(report, content) {
    const coverage = report?.coverage;
    if (!coverage || !Array.isArray(coverage.items)) {
        return 'Không có đủ dữ liệu coverage để hệ thống tự xác nhận đã kiểm hết phần này.';
    }
    const minimum = minimumQualityCoverageItems(content);
    if (coverage.status !== 'COMPLETE') {
        return `Chưa đủ bằng chứng xác nhận đã kiểm hết phần này (${coverage.items.length}/${minimum} checkpoint tối thiểu).`;
    }
    if (coverage.items.length < minimum) {
        return `Checklist coverage chỉ có ${coverage.items.length}/${minimum} checkpoint tối thiểu nên chưa đủ bằng chứng xác nhận đã kiểm hết phần này.`;
    }
    return 'Đã kiểm đủ checklist coverage, nhưng phần này vẫn còn phát hiện cần đối chiếu.';
}

function reviewReasons(chunk, report) {
    const reasons = [];
    if (report?.status === 'FAIL' && Array.isArray(report.errors) && report.errors.length > 0) {
        reasons.push('Xác minh cuối vẫn phát hiện lỗi nội dung');
    }
    const coverage = report?.coverage;
    const minimum = minimumQualityCoverageItems(chunk?.content);
    if (!coverage || coverage.status !== 'COMPLETE') {
        reasons.push('coverage chưa đủ bằng chứng để tự xác nhận đã kiểm hết phần này');
    } else if (!Array.isArray(coverage.items) || coverage.items.length < minimum) {
        reasons.push('checklist coverage ngắn hơn mức tối thiểu');
    }
    if (chunk?.qualityReviewReason) {
        reasons.push(TECHNICAL_REASON_LABELS[chunk.qualityReviewReason.errorCode]
            || 'Đầu ra ở bước sửa tự động không hợp lệ nên không thể dùng an toàn');
    }
    return reasons.length
        ? `${reasons.join('; ')}.`
        : 'Hệ thống không có đủ dữ liệu để tự xác nhận phần này đã đạt yêu cầu.';
}

function renderError(error, index) {
    const severity = SEVERITY_LABELS[error?.severity] || 'Chưa xác định mức độ';
    const category = CATEGORY_LABELS[error?.category] || 'Vấn đề chưa phân loại';
    const targetFallback = error?.category === 'omission'
        ? 'Không tìm thấy đoạn tương ứng trong bản dịch.'
        : 'Không có trích đoạn bản dịch trong dữ liệu kiểm định.';
    return [
        `### Lỗi ${index + 1} — ${severity}: ${category}`,
        '',
        `- Giải thích: ${safeText(error?.explanation, 'Không có giải thích chi tiết trong dữ liệu kiểm định.')}`,
        `- Cần sửa: ${safeText(error?.requiredCorrection, 'Đối chiếu phần này với PDF gốc và hiệu chỉnh nếu cần.')}`,
        `- Nguồn PDF: “${safeText(error?.sourceExcerpt, 'Không có trích đoạn nguồn trong dữ liệu kiểm định.')}”`,
        `- Bản dịch hiện tại: “${safeText(error?.targetExcerpt, targetFallback)}”`,
    ].join('\n');
}

function renderCoverage(chunk, report) {
    const items = Array.isArray(report?.coverage?.items) ? report.coverage.items : [];
    const failedItems = items.filter(item => item?.result === 'error');
    const lines = [
        '### Coverage',
        '',
        `- Trạng thái: ${coverageSummary(report, chunk?.content)}`,
    ];
    for (const item of failedItems) {
        lines.push(
            `- Checkpoint lỗi — ${COVERAGE_LABELS[item?.focus] || 'Nội dung chưa phân loại'}`,
            `  - Nguồn PDF: “${safeText(item?.sourceExcerpt, 'Không có trích đoạn nguồn trong dữ liệu kiểm định.')}”`,
            `  - Bản dịch hiện tại: “${safeText(item?.targetExcerpt, 'Không có trích đoạn tương ứng trong bản dịch.')}”`
        );
    }
    return lines.join('\n');
}

function renderChunk(chunk) {
    const report = finalReport(chunk);
    const repairCount = Number.isInteger(chunk?.repairCount) && chunk.repairCount > 0
        ? chunk.repairCount
        : 0;
    const errors = Array.isArray(report?.errors) ? report.errors : [];
    const sections = [
        `## Phần ${(Number.isInteger(chunk?.chunkIndex) ? chunk.chunkIndex : 0) + 1}${pageLabel(chunk)}`,
        '',
        `- Kết quả: ${repairCount > 0 ? `Cần xem lại sau ${repairCount} vòng sửa.` : 'Cần xem lại; chưa có vòng sửa tự động.'}`,
        `- Lý do: ${reviewReasons(chunk, report)}`,
    ];
    for (const [index, error] of errors.entries()) sections.push('', renderError(error, index));
    sections.push('', renderCoverage(chunk, report));
    return sections.join('\n');
}

export function buildQualityReviewHeader({ job, reviewChunks }) {
    if (job?.status !== 'completed' || job?.translationMode !== 'quality' || !Array.isArray(reviewChunks)) return '';
    const chunks = reviewChunks
        .filter(chunk => chunk?.qualityStatus === 'needs_review')
        .sort((left, right) => (left.chunkIndex ?? 0) - (right.chunkIndex ?? 0));
    if (chunks.length === 0) return '';

    const totalChunks = Number.isInteger(job.chunkCount) && job.chunkCount > 0
        ? job.chunkCount
        : Math.max(chunks.length, Number(job.passedChunks || 0) + chunks.length);
    return [
        '# ⚠️ Lưu ý kiểm soát chất lượng',
        '',
        `> Bản dịch đã hoàn thành nhưng còn ${chunks.length}/${totalChunks} phần cần đối chiếu thủ công với PDF gốc. Thông tin dưới đây là hỗ trợ rà soát, không phải kết luận chuyên môn cuối cùng.`,
        '',
        chunks.map(renderChunk).join('\n\n'),
        '',
        '---',
        '',
        '# Nội dung bản dịch',
    ].join('\n');
}

export function prependQualityReviewHeader(content, header) {
    return header ? `${header}\n\n${content || ''}` : (content || '');
}
