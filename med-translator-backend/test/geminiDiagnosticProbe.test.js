import assert from 'node:assert/strict';
import test from 'node:test';
import {
    GeminiDiagnosticProbe,
    sanitizeGeminiDiagnosticError,
} from '../src/services/geminiDiagnosticProbe.js';

function successResponse() {
    return {
        modelVersion: 'gemini-3.1-flash-lite',
        responseId: 'safe-response-id',
        text: 'Nội dung dịch không được public qua probe.',
        candidates: [{ finishReason: 'STOP' }],
        usageMetadata: {
            promptTokenCount: 789,
            candidatesTokenCount: 31,
            thoughtsTokenCount: 400,
            totalTokenCount: 1220,
        },
    };
}

test('diagnostic probe is disabled by default unless explicitly enabled', async () => {
    let requests = 0;
    const probe = new GeminiDiagnosticProbe({
        enabled: false,
        request: async () => { requests += 1; },
        keysProvider: () => ['secret-key'],
    });

    await assert.rejects(
        probe.run('gemini-3.1-flash-lite'),
        error => error.status === 503 && error.code === 'PROBE_DISABLED'
    );
    assert.equal(requests, 0);
});

test('diagnostic probe rejects arbitrary models before reading a key', async () => {
    let keyReads = 0;
    const probe = new GeminiDiagnosticProbe({
        enabled: true,
        keysProvider: () => {
            keyReads += 1;
            return ['secret-key'];
        },
    });

    await assert.rejects(
        probe.run('gemini-attacker-controlled-model'),
        error => error.status === 400 && error.code === 'MODEL_NOT_ALLOWED'
    );
    assert.equal(keyReads, 0);
});

test('successful diagnostic response exposes metadata but never text or API key', async () => {
    let requestInput = null;
    const probe = new GeminiDiagnosticProbe({
        enabled: true,
        keysProvider: () => ['secret-key'],
        request: async input => {
            requestInput = input;
            return { response: successResponse(), pdfBytes: 986 };
        },
    });

    const result = await probe.run('gemini-3.1-flash-lite');

    assert.equal(requestInput.apiKey, 'secret-key');
    assert.equal(requestInput.model, 'gemini-3.1-flash-lite');
    assert.equal(result.ok, true);
    assert.equal(result.keyIndex, 0);
    assert.equal(result.pdfBytes, 986);
    assert.equal(result.usage.totalTokenCount, 1220);
    assert.equal('text' in result, false);
    assert.doesNotMatch(JSON.stringify(result), /secret-key|Nội dung dịch/);
});

test('upstream quota failure is sanitized and preserves safe quota diagnostics', async () => {
    const error = new Error('API key secret-key exceeded quota');
    error.status = 429;
    error.errorDetails = [{
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [{
            quotaMetric: 'generativelanguage.googleapis.com/generate_content_requests',
            quotaId: 'GenerateRequestsPerDayPerProjectPerModel',
            quotaValue: '100',
            quotaDimensions: {
                model: 'gemini-3.1-flash-lite',
                location: 'global',
                consumer: 'project:should-not-be-returned',
            },
        }],
    }, {
        '@type': 'type.googleapis.com/google.rpc.RetryInfo',
        retryDelay: '60s',
    }];

    const sanitized = sanitizeGeminiDiagnosticError(error, ['secret-key']);

    assert.equal(sanitized.upstreamStatus, 429);
    assert.equal(sanitized.details[0].violations[0].quotaValue, '100');
    assert.equal(sanitized.details[1].retryDelay, '60s');
    assert.equal('consumer' in sanitized.details[0].violations[0].quotaDimensions, false);
    assert.doesNotMatch(JSON.stringify(sanitized), /secret-key|should-not-be-returned/);
});

test('cooldown is enforced per model and a different allowed model can still run', async () => {
    let now = 1_000_000;
    let requests = 0;
    const probe = new GeminiDiagnosticProbe({
        enabled: true,
        cooldownMs: 300_000,
        clock: () => now,
        keysProvider: () => ['secret-key'],
        request: async () => {
            requests += 1;
            return { response: successResponse(), pdfBytes: 986 };
        },
    });

    await probe.run('gemini-3.1-flash-lite');
    await assert.rejects(
        probe.run('gemini-3.1-flash-lite'),
        error => (
            error.status === 429
            && error.code === 'PROBE_COOLDOWN'
            && error.retryAfterSeconds === 300
        )
    );
    await probe.run('gemini-3.5-flash-lite');
    assert.equal(requests, 2);

    now += 300_000;
    await probe.run('gemini-3.1-flash-lite');
    assert.equal(requests, 3);
});
