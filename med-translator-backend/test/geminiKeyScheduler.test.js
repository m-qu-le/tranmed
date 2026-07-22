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

test('public status initializes all keys without exposing values and tracks passive state', async () => {
    let now = 1_000_000;
    const scheduler = new GeminiKeyScheduler({ keysProvider: () => sevenKeys, clock: () => now });

    assert.deepEqual(scheduler.publicStatus(), sevenKeys.map((_, index) => ({
        index: index + 1,
        status: 'untested',
        cooldownUntil: null,
    })));

    await scheduler.execute(async ({ keyIndex }) => {
        if (keyIndex === 0) {
            const error = new Error('quota');
            error.status = 429;
            error.response = { headers: { get: () => '2' } };
            throw error;
        }
        return { metadata: { usage: { promptTokenCount: 1 } } };
    }, { estimatedInputTokens: 1 });

    const status = scheduler.publicStatus();
    assert.deepEqual(status[0], { index: 1, status: 'cooldown', cooldownUntil: new Date(now + 2000).toISOString() });
    assert.deepEqual(status[1], { index: 2, status: 'available', cooldownUntil: null });
    assert.equal(status.slice(2).every(key => key.status === 'untested' && key.cooldownUntil === null), true);
    assert.doesNotMatch(JSON.stringify(status), /secret-key/);

    now += 2001;
    assert.deepEqual(scheduler.publicStatus()[0], { index: 1, status: 'untested', cooldownUntil: null });
});

test('public status reports disabled keys without exposing internal scheduler details', async () => {
    const scheduler = new GeminiKeyScheduler({ keysProvider: () => ['secret-key'] });
    await assert.rejects(
        scheduler.execute(async () => {
            const error = new Error('forbidden');
            error.status = 403;
            throw error;
        }),
        error => error.code === ErrorCodes.GEMINI_AUTH
    );
    assert.deepEqual(scheduler.publicStatus(), [{ index: 1, status: 'disabled', cooldownUntil: null }]);
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
            && error.poolExhausted
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
        error => error.retryAfterMs === 60_000
    );
});

test('all-key quota exhaustion wakes at the earliest key Retry-After', async () => {
    const now = 1_000_000;
    const scheduler = new GeminiKeyScheduler({ keysProvider: () => sevenKeys, clock: () => now });
    await assert.rejects(
        scheduler.execute(async ({ keyIndex }) => {
            const error = new Error('quota');
            error.status = 429;
            error.response = { headers: { get: () => String(keyIndex + 2) } };
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

test('5xx and network failures rotate finitely, while all 403 keys fail as auth config', async () => {
    for (const status of [500, 502, 503, 504, null]) {
        const scheduler = new GeminiKeyScheduler({ keysProvider: () => ['key-a', 'key-b'] });
        const calls = [];
        const result = await scheduler.execute(async ({ keyIndex }) => {
            calls.push(keyIndex);
            if (keyIndex === 0) {
                const error = new Error(status == null ? 'network timeout' : `http ${status}`);
                if (status != null) error.status = status;
                throw error;
            }
            return { value: 'ok', metadata: { usage: { promptTokenCount: 1 } } };
        }, { estimatedInputTokens: 1 });
        assert.equal(result.value, 'ok');
        assert.deepEqual(calls, [0, 1]);
    }

    const authScheduler = new GeminiKeyScheduler({ keysProvider: () => ['key-a', 'key-b'] });
    await assert.rejects(
        authScheduler.execute(async () => {
            const error = new Error('forbidden');
            error.status = 403;
            throw error;
        }),
        error => error.code === ErrorCodes.GEMINI_AUTH
    );
    assert.equal(authScheduler.snapshot().every(key => key.disabled), true);
});
