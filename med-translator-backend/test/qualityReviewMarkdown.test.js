import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildQualityReviewHeader,
    prependQualityReviewHeader,
} from '../src/services/qualityReviewMarkdown.js';

const categoryLabels = {
    mistranslation: 'Dịch sai nghĩa',
    omission: 'Thiếu nội dung',
    addition: 'Thêm nội dung không có trong nguồn',
    terminology: 'Thuật ngữ chưa chính xác',
    negation_modality: 'Sai phủ định hoặc mức độ chắc chắn',
    causal_relation: 'Sai quan hệ nguyên nhân–kết quả',
    number_unit: 'Sai số liệu hoặc đơn vị',
    table_figure: 'Sai hoặc thiếu nội dung bảng/hình',
    formatting: 'Lỗi định dạng ảnh hưởng nội dung',
};

function error(category = 'omission', severity = 'critical', overrides = {}) {
    return {
        category,
        severity,
        sourceExcerpt: 'Không dùng thuốc khi có chống chỉ định.',
        targetExcerpt: '',
        requiredCorrection: 'Bổ sung mệnh đề bị thiếu.',
        explanation: 'Bản dịch bỏ sót ý phủ định.',
        ...overrides,
    };
}

function coverage(status = 'COMPLETE', count = 4, result = 'match') {
    return {
        status,
        items: Array.from({ length: count }, (_, index) => ({
            focus: index === 0 ? 'negation_modality' : 'meaning',
            sourceExcerpt: `nguồn ${index}`,
            targetExcerpt: `đích ${index}`,
            result: index === 0 ? result : 'match',
        })),
    };
}

function reviewChunk(overrides = {}) {
    return {
        chunkIndex: 1,
        content: '# Bản dịch',
        pageStart: 3,
        pageEnd: 4,
        repairCount: 2,
        qualityStatus: 'needs_review',
        verificationReport: {
            status: 'FAIL',
            errors: [error()],
            coverage: coverage('COMPLETE', 4, 'error'),
        },
        ...overrides,
    };
}

const qualityJob = {
    status: 'completed',
    translationMode: 'quality',
    chunkCount: 5,
    passedChunks: 3,
};

test('quality review header renders the final report, evidence and coverage before translated content', () => {
    const chunk = reviewChunk({
        verificationReport: {
            status: 'FAIL',
            errors: [error('mistranslation', 'major', { explanation: 'finding cũ đã sửa' })],
            coverage: coverage(),
        },
        reverifyReport: {
            status: 'FAIL',
            errors: [error()],
            coverage: coverage('COMPLETE', 4, 'error'),
        },
    });
    const header = buildQualityReviewHeader({ job: qualityJob, reviewChunks: [chunk] });
    const output = prependQualityReviewHeader('# Nội dung thật', header);

    assert.match(output, /^# ⚠️ Lưu ý kiểm soát chất lượng/);
    assert.match(output, /1\/5 phần cần đối chiếu/);
    assert.match(output, /## Phần 2 — trang 3–4/);
    assert.match(output, /sau 2 vòng sửa/);
    assert.match(output, /Nghiêm trọng: Thiếu nội dung/);
    assert.match(output, /Không tìm thấy đoạn tương ứng trong bản dịch/);
    assert.match(output, /Checkpoint lỗi — Phủ định hoặc mức độ chắc chắn/);
    assert.doesNotMatch(output, /finding cũ đã sửa/);
    assert.equal(output.match(/# ⚠️ Lưu ý kiểm soát chất lượng/g).length, 1);
    assert.match(output, /# Nội dung bản dịch\n\n# Nội dung thật$/);
});

test('category, severity and unknown-value mappings remain readable', () => {
    const errors = Object.keys(categoryLabels).map((category, index) => error(
        category,
        ['critical', 'major', 'minor'][index % 3],
        { targetExcerpt: `đích ${index}` }
    ));
    errors.push(error('future_category', 'future_severity'));
    const header = buildQualityReviewHeader({
        job: qualityJob,
        reviewChunks: [reviewChunk({
            verificationReport: { status: 'FAIL', errors, coverage: coverage() },
        })],
    });

    for (const label of Object.values(categoryLabels)) assert.match(header, new RegExp(label));
    for (const label of ['Nghiêm trọng', 'Quan trọng', 'Nhẹ']) assert.match(header, new RegExp(label));
    assert.match(header, /Vấn đề chưa phân loại/);
    assert.match(header, /Chưa xác định mức độ/);
});

test('coverage fallbacks distinguish incomplete, short and missing legacy reports', () => {
    const incomplete = buildQualityReviewHeader({
        job: qualityJob,
        reviewChunks: [reviewChunk({
            verificationReport: { status: 'FAIL', errors: [], coverage: coverage('INCOMPLETE', 1) },
        })],
    });
    assert.match(incomplete, /1\/4 checkpoint tối thiểu/);

    const short = buildQualityReviewHeader({
        job: qualityJob,
        reviewChunks: [reviewChunk({
            content: 'a'.repeat(2501),
            verificationReport: { status: 'FAIL', errors: [error()], coverage: coverage('COMPLETE', 4) },
        })],
    });
    assert.match(short, /4\/6 checkpoint tối thiểu/);

    const missing = buildQualityReviewHeader({
        job: qualityJob,
        reviewChunks: [reviewChunk({ verificationReport: null })],
    });
    assert.match(missing, /Không có đủ dữ liệu coverage/);
    assert.match(missing, /chưa đủ bằng chứng để tự xác nhận/i);
});

test('technical repair reasons are translated without exposing codes or raw diagnostics', () => {
    const labels = {
        GEMINI_BLOCKED: /bị hệ thống xử lý chặn/,
        GEMINI_OUTPUT_TRUNCATED: /bị cắt ngắn/,
        GEMINI_RESPONSE_INVALID: /không trả về nội dung/,
        GEMINI_SCHEMA_INVALID: /không đúng cấu trúc/,
    };
    for (const [errorCode, label] of Object.entries(labels)) {
        const header = buildQualityReviewHeader({
            job: qualityJob,
            reviewChunks: [reviewChunk({
                verificationReport: null,
                qualityReviewReason: {
                    kind: 'repair_output_invalid',
                    stage: 'repair',
                    errorCode,
                    rawMessage: 'secret prompt and stack trace',
                },
            })],
        });
        assert.match(header, label);
        assert.doesNotMatch(header, new RegExp(errorCode));
        assert.doesNotMatch(header, /secret prompt|stack trace/);
    }
});

test('report excerpts cannot create headings, HTML, code blocks or emphasis', () => {
    const hostile = '<script>alert(1)</script>\n# injected\n```js\n*bold* [link](x)';
    const header = buildQualityReviewHeader({
        job: qualityJob,
        reviewChunks: [reviewChunk({
            verificationReport: {
                status: 'FAIL',
                errors: [error('mistranslation', 'major', {
                    sourceExcerpt: hostile,
                    targetExcerpt: hostile,
                    explanation: hostile,
                })],
                coverage: coverage(),
            },
        })],
    });
    assert.doesNotMatch(header, /<script>|\n# injected|```js|\*bold\*/);
    assert.match(header, /&lt;script&gt;/);
    assert.match(header, /\\`\\`\\`js/);
    assert.match(header, /\\\*bold\\\*/);
});

test('legacy, passed and non-completed jobs remain byte-for-byte unchanged', () => {
    const content = '# Bản dịch cũ\n\nNội dung.';
    for (const job of [
        { status: 'completed', translationMode: 'legacy' },
        { status: 'processing', translationMode: 'quality' },
        qualityJob,
    ]) {
        const reviewChunks = job === qualityJob
            ? [{ ...reviewChunk(), qualityStatus: 'passed' }]
            : [reviewChunk()];
        const header = buildQualityReviewHeader({ job, reviewChunks });
        assert.equal(prependQualityReviewHeader(content, header), content);
    }
});

test('renderer is deterministic, orders chunks and never mutates stored artifacts', () => {
    const reviewChunks = [
        reviewChunk({ chunkIndex: 2, content: 'phần ba' }),
        reviewChunk({ chunkIndex: 0, content: 'phần một' }),
    ];
    const original = structuredClone(reviewChunks);
    const first = buildQualityReviewHeader({ job: qualityJob, reviewChunks });
    const second = buildQualityReviewHeader({ job: qualityJob, reviewChunks });

    assert.equal(first, second);
    assert.ok(first.indexOf('## Phần 1') < first.indexOf('## Phần 3'));
    assert.deepEqual(reviewChunks, original);
    assert.doesNotMatch(reviewChunks[0].content, /Lưu ý kiểm soát chất lượng/);
});
