import assert from 'node:assert/strict';
import test from 'node:test';
import { createQualityGeminiExecutors } from '../src/services/qualityGeminiExecutors.js';
import { QUALITY_REPORT_JSON_SCHEMA } from '../src/services/translationQuality.js';
import { ErrorCodes } from '../src/utils/processingError.js';

test('quality executors use high thinking, bounded output and structured JSON without leaking artifacts to events', async () => {
    const requests = [];
    const events = [];
    const scheduler = {
        async execute(factory, options) {
            options.onEvent({ type: 'reserved', keyIndex: 3 });
            return factory({ apiKey: 'secret-key', keyIndex: 3 });
        },
    };
    const generate = async request => {
        requests.push(request);
        return request.responseType === 'json'
            ? { text: '{"status":"PASS","errors":[]}', json: { status: 'PASS', errors: [] }, metadata: { stage: request.stage } }
            : { text: '# Markdown', metadata: { stage: request.stage } };
    };
    const executors = createQualityGeminiExecutors({ scheduler, generate, onSchedulerEvent: event => events.push(event) });
    const pdfBuffer = Buffer.alloc(100, 1);
    const chunk = {
        draftContent: 'draft',
        auditReport: { status: 'PASS', errors: [] },
        revisedContent: 'revised',
        verificationReport: { status: 'FAIL', errors: [] },
        repairedContent: 'repaired',
    };

    await executors.translate({ pdfBuffer });
    await executors.medical_audit({ pdfBuffer, chunk });
    await executors.revise({ pdfBuffer, chunk });
    await executors.verify({ pdfBuffer, chunk });
    await executors.repair({ pdfBuffer, chunk });
    await executors.reverify({ pdfBuffer, chunk });

    assert.deepEqual(requests.map(request => request.stage), [
        'translate', 'medical_audit', 'revise', 'verify', 'repair', 'reverify',
    ]);
    for (const request of requests) {
        assert.equal(request.config.temperature, 1);
        assert.equal(request.config.thinkingConfig.thinkingLevel, 'HIGH');
        assert.equal(request.config.thinkingConfig.includeThoughts, false);
        assert.equal(request.validationMode, 'strict');
    }
    for (const request of requests.filter(request => request.responseType === 'json')) {
        assert.equal(request.config.responseMimeType, 'application/json');
        assert.equal(request.config.maxOutputTokens, 8192);
        assert.deepEqual(request.config.responseJsonSchema, QUALITY_REPORT_JSON_SCHEMA);
        assert.equal(typeof request.structuredValidator, 'function');
    }
    assert.equal(requests.find(request => request.stage === 'translate').config.maxOutputTokens, 32768);
    assert.doesNotMatch(JSON.stringify(events), /secret-key|draft|revised|repaired/);
});

test('revision coverage failure is raised inside the scheduler so another key can recover', async () => {
    const reference = 'Nội dung y khoa đầy đủ cần được giữ lại. '.repeat(80);
    const requestedKeys = [];
    const scheduler = {
        async execute(factory) {
            try {
                return await factory({ apiKey: 'key-0', keyIndex: 0 });
            } catch (error) {
                assert.equal(error.code, ErrorCodes.GEMINI_RESPONSE_INVALID);
                assert.ok(error.coverageRatio < 0.8);
                return factory({ apiKey: 'key-1', keyIndex: 1 });
            }
        },
    };
    const generate = async request => {
        requestedKeys.push(request.keyIndex);
        return {
            text: request.keyIndex === 0 ? 'Một mục ngắn bị cụt.' : reference,
            metadata: { stage: request.stage, keyIndex: request.keyIndex, finishReason: 'STOP' },
        };
    };
    const executors = createQualityGeminiExecutors({ scheduler, generate });
    const result = await executors.revise({
        pdfBuffer: Buffer.alloc(100, 1),
        chunk: { draftContent: reference, auditReport: { status: 'PASS', errors: [] } },
    });

    assert.deepEqual(requestedKeys, [0, 1]);
    assert.equal(result.text, reference.trim());
});
