import assert from 'node:assert/strict';
import test from 'node:test';
import { QualityDocumentContextService } from '../src/services/qualityDocumentContextService.js';
import {
    DOCUMENT_CONTEXT_JSON_SCHEMA,
    isQualityDocumentContext,
    QUALITY_DOCUMENT_CONTEXT_VERSION,
} from '../src/services/qualityDocumentContext.js';

const context = {
    documentFocus: 'Thần kinh học lâm sàng',
    terminology: [{ sourceTerm: 'stroke', preferredVietnamese: 'đột quỵ', note: 'Dùng nhất quán.' }],
    abbreviations: [{ sourceTerm: 'TIA', preferredVietnamese: 'cơn thiếu máu não thoáng qua', note: 'Giữ viết tắt sau lần đầu.' }],
    consistencyRules: [],
    highRiskNotes: ['Giữ nguyên phân biệt cấp tính và mạn tính.'],
};

class MemoryJobModel {
    constructor(row) {
        this.row = row;
    }

    async findOne(filter) {
        return this.row?.jobId === filter.jobId ? { ...this.row } : null;
    }

    async findOneAndUpdate(filter, update) {
        if (this.row?.jobId !== filter.jobId || this.row.status !== filter.status
            || this.row.processingToken !== filter.processingToken || this.row.cancelRequested) return null;
        Object.assign(this.row, update.$set);
        return { ...this.row };
    }
}

test('document context rejects a superficial passport without enough document-specific items', () => {
    assert.equal(isQualityDocumentContext({
        documentFocus: 'Y học', terminology: [], abbreviations: [], consistencyRules: [], highRiskNotes: [],
    }), false);
});

test('document context schema leaves array bounds to the business validator for Gemini compatibility', () => {
    assert.doesNotMatch(JSON.stringify(DOCUMENT_CONTEXT_JSON_SCHEMA), /minItems|maxItems/);
});

test('document context is persisted once and reused on resume without another full-PDF call', async () => {
    const model = new MemoryJobModel({
        jobId: 'job-context', status: 'processing', processingToken: 'token', cancelRequested: false,
    });
    let calls = 0;
    const service = new QualityDocumentContextService({
        JobModel: model,
        executors: {
            document_context: async () => {
                calls += 1;
                return { json: context, metadata: { stage: 'document_context', finishReason: 'STOP' } };
            },
        },
    });
    const job = { jobId: 'job-context', processingToken: 'token' };

    const first = await service.prepare({ job, sourcePath: 'source.pdf', totalPages: 20 });
    const second = await service.prepare({ job, sourcePath: 'source.pdf', totalPages: 20 });

    assert.deepEqual(first, context);
    assert.deepEqual(second, context);
    assert.equal(calls, 1);
    assert.equal(model.row.qualityContextVersion, QUALITY_DOCUMENT_CONTEXT_VERSION);
    assert.deepEqual(model.row.qualityDocumentContext, context);
});
