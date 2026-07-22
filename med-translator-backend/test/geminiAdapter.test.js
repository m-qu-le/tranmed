import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createPdfContents,
    generateGeminiContent,
    validateGeminiResponse,
} from '../src/services/geminiAdapter.js';
import { ErrorCodes } from '../src/utils/processingError.js';

function mockResponse(overrides = {}) {
    return {
        text: '# Bản dịch',
        candidates: [{ finishReason: 'STOP' }],
        modelVersion: 'gemini-test-version',
        responseId: 'response-1',
        usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 20,
            thoughtsTokenCount: 10,
            totalTokenCount: 130,
        },
        ...overrides,
    };
}

test('strict Gemini validation returns text and complete public telemetry', () => {
    const result = validateGeminiResponse(mockResponse(), {
        validationMode: 'strict',
        keyIndex: 2,
        stage: 'translate',
        latencyMs: 123.6,
    });

    assert.equal(result.text, '# Bản dịch');
    assert.deepEqual(result.metadata, {
        stage: 'translate',
        keyIndex: 2,
        latencyMs: 124,
        finishReason: 'STOP',
        finishMessage: null,
        modelVersion: 'gemini-test-version',
        responseId: 'response-1',
        blockReason: null,
        usage: {
            promptTokenCount: 100,
            candidatesTokenCount: 20,
            thoughtsTokenCount: 10,
            totalTokenCount: 130,
        },
    });
});

test('strict Gemini validation rejects MAX_TOKENS, missing candidates and invalid JSON', () => {
    assert.throws(
        () => validateGeminiResponse(mockResponse({ candidates: [{ finishReason: 'MAX_TOKENS' }] })),
        error => error.code === ErrorCodes.GEMINI_OUTPUT_TRUNCATED
            && error.geminiMetadata.finishReason === 'MAX_TOKENS'
    );
    assert.throws(
        () => validateGeminiResponse(mockResponse({ candidates: [], promptFeedback: { blockReason: 'SAFETY' } })),
        error => error.code === ErrorCodes.GEMINI_BLOCKED
            && error.geminiMetadata.blockReason === 'SAFETY'
    );
    assert.throws(
        () => validateGeminiResponse(mockResponse({ text: '{broken' }), { responseType: 'json' }),
        error => error.code === ErrorCodes.GEMINI_SCHEMA_INVALID
    );
    assert.throws(
        () => validateGeminiResponse(mockResponse({ text: '   ' })),
        error => error.code === ErrorCodes.GEMINI_RESPONSE_INVALID
    );
    for (const finishReason of ['SAFETY', 'RECITATION']) {
        assert.throws(
            () => validateGeminiResponse(mockResponse({ candidates: [{ finishReason }] })),
            error => error.code === ErrorCodes.GEMINI_RESPONSE_INVALID
                && error.geminiMetadata.finishReason === finishReason
        );
    }
});

test('legacy validation records MAX_TOKENS without changing baseline acceptance behavior', () => {
    const result = validateGeminiResponse(
        mockResponse({ candidates: [{ finishReason: 'MAX_TOKENS' }] }),
        { validationMode: 'legacy' }
    );

    assert.equal(result.text, '# Bản dịch');
    assert.equal(result.metadata.finishReason, 'MAX_TOKENS');
});

test('Gemini adapter sends PDF/config through the injected SDK client without exposing the key', async () => {
    let request;
    const result = await generateGeminiContent({
        apiKey: 'secret-test-key',
        keyIndex: 4,
        model: 'gemini-test',
        contents: createPdfContents(Buffer.alloc(100, 1), 'Dịch tài liệu.'),
        config: { thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: false } },
        validationMode: 'strict',
        clientFactory: apiKey => {
            assert.equal(apiKey, 'secret-test-key');
            return {
                models: {
                    generateContent: async value => {
                        request = value;
                        return mockResponse();
                    },
                },
            };
        },
    });

    assert.equal(request.model, 'gemini-test');
    assert.equal(Object.hasOwn(request.config, 'temperature'), false);
    assert.deepEqual(request.config.thinkingConfig, { thinkingLevel: 'HIGH', includeThoughts: false });
    assert.equal(result.metadata.keyIndex, 4);
    assert.doesNotMatch(JSON.stringify(result), /secret-test-key/);
});
