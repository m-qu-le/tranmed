import assert from 'node:assert/strict';
import test from 'node:test';
import { GeminiKeyScheduler } from '../src/services/geminiKeyScheduler.js';
import { ErrorCodes, ProcessingError } from '../src/utils/processingError.js';

const sevenKeys = Array.from({ length: 7 }, (_, index) => `secret-key-${index}`);

test('quality scheduler distributes 700 requests evenly without exposing key values', async () => {
    const scheduler = new GeminiKeyScheduler({
        keysProvider: () => sevenKeys,
        limits: { rpm: 1000, tpm: 10_000_000, rpd: 1000 },
    });
    const counts = Array(7).fill(0);
    for (let request = 0; request < 700; request += 1) {
        await scheduler.execute(async ({ keyIndex }) => {
            counts[keyIndex] += 1;
            return { metadata: { usage: { promptTokenCount: 100 } } };
        }, { estimatedInputTokens: 100 });
    }
    assert.deepEqual(counts, Array(7).fill(100));
    assert.doesNotMatch(JSON.stringify(scheduler.snapshot()), /secret-key/);
});

test('429 rotates immediately to the next project and respects Retry-After', async () => {
    let now = 1_000_000;
    const scheduler = new GeminiKeyScheduler({ keysProvider: () => sevenKeys, clock: () => now });
    const calls = [];
    const events = [];
    const result = await scheduler.execute(async ({ keyIndex }) => {
        calls.push(keyIndex);
        if (keyIndex === 0) {
            const error = new Error('quota');
            error.status = 429;
            error.response = { headers: { get: () => '2' } };
            throw error;
        }
        return { value: 'ok', metadata: { usage: { promptTokenCount: 50 } } };
    }, { estimatedInputTokens: 50, onEvent: event => events.push(event) });

    assert.equal(result.value, 'ok');
    assert.deepEqual(calls, [0, 1]);
    assert.equal(scheduler.snapshot()[0].cooldownUntil, now + 2000);
    assert.equal(events.some(event => event.type === 'cooldown' && event.keyIndex === 0), true);
});

test('auth failure disables one key while other keys and later requests continue', async () => {
    const scheduler = new GeminiKeyScheduler({ keysProvider: () => sevenKeys });
    const firstCalls = [];
    await scheduler.execute(async ({ keyIndex }) => {
        firstCalls.push(keyIndex);
        if (keyIndex === 0) {
            const error = new Error('unauthorized');
            error.status = 401;
            throw error;
        }
        return { metadata: { usage: { promptTokenCount: 1 } } };
    }, { estimatedInputTokens: 1 });
    assert.deepEqual(firstCalls, [0, 1]);
    assert.equal(scheduler.snapshot()[0].disabled, true);

    const next = [];
    await scheduler.execute(async ({ keyIndex }) => {
        next.push(keyIndex);
        return { metadata: { usage: { promptTokenCount: 1 } } };
    }, { estimatedInputTokens: 1 });
    assert.deepEqual(next, [2]);
});

test('all-key quota exhaustion returns one durable retry error without spinning', async () => {
    let now = 1_000_000;
    const scheduler = new GeminiKeyScheduler({
        keysProvider: () => sevenKeys,
        clock: () => now,
        random: () => 0,
    });
    const calls = [];
    await assert.rejects(
        scheduler.execute(async ({ keyIndex }) => {
            calls.push(keyIndex);
            const error = new Error('quota');
            error.status = 429;
            throw error;
        }),
        error => error.code === ErrorCodes.GEMINI_RATE_LIMIT
            && error.quotaRelated
            && error.retryAfterMs === 60_000
    );
    assert.equal(calls.length, 7);

    now += 60_001;
    await assert.rejects(
        scheduler.execute(async () => {
            const error = new Error('quota');
            error.status = 429;
            throw error;
        }),
        error => error.retryAfterMs === 120_000
    );
});

test('all-key quota exhaustion publishes the server Retry-After when present', async () => {
    const scheduler = new GeminiKeyScheduler({ keysProvider: () => sevenKeys });
    await assert.rejects(
        scheduler.execute(async () => {
            const error = new Error('quota');
            error.status = 429;
            error.response = { headers: { get: () => '2' } };
            throw error;
        }),
        error => error.code === ErrorCodes.GEMINI_RATE_LIMIT && error.retryAfterMs === 2_000
    );
});

test('invalid structured response rotates key, while config error stops immediately', async () => {
    const scheduler = new GeminiKeyScheduler({ keysProvider: () => sevenKeys });
    const calls = [];
    await scheduler.execute(async ({ keyIndex }) => {
        calls.push(keyIndex);
        if (keyIndex === 0) {
            throw new ProcessingError(ErrorCodes.GEMINI_SCHEMA_INVALID, 'bad json', { retryable: true });
        }
        return { metadata: { usage: { promptTokenCount: 1 } } };
    }, { estimatedInputTokens: 1 });
    assert.deepEqual(calls, [0, 1]);

    const configScheduler = new GeminiKeyScheduler({ keysProvider: () => sevenKeys });
    let configCalls = 0;
    await assert.rejects(
        configScheduler.execute(async () => {
            configCalls += 1;
            const error = new ProcessingError(ErrorCodes.GEMINI_CONFIG, 'bad model');
            error.status = 400;
            throw error;
        }),
        error => error.code === ErrorCodes.GEMINI_CONFIG
    );
    assert.equal(configCalls, 1);
});

test('headroom and cancellation are enforced before issuing extra requests', async () => {
    const scheduler = new GeminiKeyScheduler({
        keysProvider: () => ['only-key'],
        limits: { rpm: 1, tpm: 1000, rpd: 10 },
    });
    await scheduler.execute(async () => ({ metadata: { usage: { promptTokenCount: 10 } } }), { estimatedInputTokens: 10 });
    await assert.rejects(
        scheduler.execute(async () => ({ metadata: {} }), { estimatedInputTokens: 10 }),
        error => error.code === ErrorCodes.GEMINI_RATE_LIMIT
    );

    const controller = new AbortController();
    controller.abort();
    const cancelScheduler = new GeminiKeyScheduler({ keysProvider: () => ['only-key'] });
    await assert.rejects(
        cancelScheduler.execute(async () => ({ metadata: {} }), { signal: controller.signal }),
        error => error.code === ErrorCodes.CANCELLED
    );
});
