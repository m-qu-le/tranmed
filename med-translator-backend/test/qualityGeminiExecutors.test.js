import assert from 'node:assert/strict';
import test from 'node:test';
import { createQualityGeminiExecutors } from '../src/services/qualityGeminiExecutors.js';
import { AdaptiveGeminiLimiter } from '../src/services/adaptiveGeminiLimiter.js';
import { QUALITY_REPORT_JSON_SCHEMA } from '../src/services/translationQuality.js';
import { ErrorCodes, ProcessingError } from '../src/utils/processingError.js';

const completeCoverage = {
    status: 'COMPLETE',
    items: Array.from({ length: 4 }, (_, index) => ({
        focus: 'meaning', sourceExcerpt: `source ${index}`, targetExcerpt: `target ${index}`, result: 'match',
    })),
};
const documentContext = {
    documentFocus: 'Bệnh học',
    terminology: [{ sourceTerm: 'lesion', preferredVietnamese: 'tổn thương', note: 'Dùng nhất quán.' }],
    abbreviations: [],
    consistencyRules: [{ sourceExcerpt: 'Dose', rule: 'Giữ nguyên đơn vị.' }],
    highRiskNotes: ['Kiểm tra liều.'],
};

test('quality executors use high thinking, bounded output and structured JSON without leaking artifacts to events', async () => {
    const requests = [];
    const events = [];
    let limiterCalls = 0;
    const limiter = { run: async task => { limiterCalls += 1; return task(); }, onPoolExhausted: () => {} };
    const scheduler = {
        async execute(factory, options) {
            return options.admitPhysical(() => {
                options.onEvent({ type: 'reserved', keyIndex: 3 });
                return factory({ apiKey: 'secret-key', keyIndex: 3 });
            });
        },
    };
    const generate = async request => {
        requests.push(request);
        return request.responseType === 'json'
            ? { text: '{"status":"PASS","errors":[],"coverage":{"status":"COMPLETE","items":[]}}', json: { status: 'PASS', errors: [], coverage: completeCoverage }, metadata: { stage: request.stage } }
            : { text: '# Markdown', metadata: { stage: request.stage } };
    };
    const executors = createQualityGeminiExecutors({ scheduler, limiter, generate, onSchedulerEvent: event => events.push(event) });
    const pdfBuffer = Buffer.alloc(100, 1);
    const chunk = {
        draftContent: 'draft',
        auditReport: { status: 'PASS', errors: [], coverage: completeCoverage },
        revisedContent: 'revised',
        verificationReport: { status: 'FAIL', errors: [], coverage: { ...completeCoverage, status: 'INCOMPLETE' } },
        repairedContent: 'repaired',
        reverifyReport: {
            status: 'FAIL',
            errors: [{
                category: 'terminology',
                severity: 'minor',
                sourceExcerpt: 'latest source',
                targetExcerpt: 'latest target',
                requiredCorrection: 'latest correction',
                explanation: 'latest explanation',
            }],
            coverage: completeCoverage,
        },
    };

    let lazyPayloadReads = 0;
    await executors.translate({
        pdfBuffer: () => {
            lazyPayloadReads += 1;
            return pdfBuffer.toString('base64');
        },
    });
    await executors.medical_audit({ pdfBuffer, chunk });
    await executors.revise({ pdfBuffer, chunk });
    await executors.verify({ pdfBuffer, chunk });
    await executors.repair({ pdfBuffer, chunk });
    await executors.reverify({ pdfBuffer, chunk });

    assert.deepEqual(requests.map(request => request.stage), [
        'translate', 'medical_audit', 'revise', 'verify', 'repair', 'reverify',
    ]);
    assert.equal(limiterCalls, 6);
    assert.equal(lazyPayloadReads, 1);
    for (const request of requests) {
        assert.equal(Object.hasOwn(request.config, 'temperature'), false);
        assert.equal(request.config.thinkingConfig.thinkingLevel, 'HIGH');
        assert.equal(request.config.thinkingConfig.includeThoughts, false);
        assert.equal(request.validationMode, 'strict');
    }
    for (const request of requests.filter(request => request.responseType === 'json')) {
        assert.equal(request.config.responseMimeType, 'application/json');
        assert.equal(request.config.maxOutputTokens, 16384);
        assert.deepEqual(request.config.responseJsonSchema, QUALITY_REPORT_JSON_SCHEMA);
        assert.equal(typeof request.structuredValidator, 'function');
    }
    for (const request of requests.filter(request => request.responseType !== 'json')) {
        assert.equal(request.config.maxOutputTokens, 65536);
    }
    const secondRepairRequest = requests.find(request => request.stage === 'repair');
    const secondRepairPayload = JSON.stringify(secondRepairRequest.contents);
    assert.match(secondRepairPayload, /repaired/);
    assert.match(secondRepairPayload, /latest source/);
    assert.doesNotMatch(secondRepairPayload, /<<<TRANSLATION>>>\\nrevised/);
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
        chunk: { draftContent: reference, auditReport: { status: 'PASS', errors: [], coverage: completeCoverage } },
    });

    assert.deepEqual(requestedKeys, [0, 1]);
    assert.equal(result.text, reference.trim());
});

test('only all-key quota exhaustion lowers the shared Gemini limit', async () => {
    const limiter = new AdaptiveGeminiLimiter({ initialLimit: 6, minLimit: 3, maxLimit: 6 });
    const scheduler = {
        async execute() {
            throw new ProcessingError(ErrorCodes.GEMINI_RATE_LIMIT, 'all keys cooling down', {
                retryable: true,
                poolExhausted: true,
            });
        },
    };
    const executors = createQualityGeminiExecutors({ scheduler, limiter });

    await assert.rejects(
        executors.translate({ pdfBuffer: Buffer.alloc(10), documentContext }),
        error => error.code === ErrorCodes.GEMINI_RATE_LIMIT
    );
    assert.equal(limiter.snapshot().limit, 3);
});

test('document context uses an ephemeral Gemini File API PDF and deletes it after generation', async () => {
    const deleted = [];
    const scheduler = {
        async execute(factory, options) {
            return options.admitPhysical(() => factory({ apiKey: 'key-0', keyIndex: 0 }));
        },
    };
    const client = { files: { delete: async ({ name }) => deleted.push(name) } };
    const requests = [];
    let limiterCalls = 0;
    const limiter = { run: async task => { limiterCalls += 1; return task(); }, onPoolExhausted: () => {} };
    const executors = createQualityGeminiExecutors({
        scheduler,
        limiter,
        uploadFile: async () => ({ client, file: { name: 'files/context', uri: 'gemini://context', mimeType: 'application/pdf', state: 'ACTIVE' } }),
        generate: async request => {
            requests.push(request);
            return { json: documentContext, metadata: { stage: request.stage, finishReason: 'STOP' } };
        },
    });

    const result = await executors.document_context({ sourcePath: 'source.pdf', totalPages: 20 });

    assert.deepEqual(result.json, documentContext);
    assert.equal(limiterCalls, 1);
    assert.equal(requests[0].stage, 'document_context');
    assert.equal(requests[0].contents[0].parts[0].fileData.fileUri, 'gemini://context');
    assert.deepEqual(deleted, ['files/context']);
});
