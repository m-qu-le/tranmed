import assert from 'node:assert/strict';
import test from 'node:test';
import { AdaptiveGeminiLimiter } from '../src/services/adaptiveGeminiLimiter.js';

const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

test('adaptive Gemini limiter starts at three, grows to six, and falls back to three only after pool exhaustion', async () => {
    const limiter = new AdaptiveGeminiLimiter({ successesPerIncrease: 2 });
    assert.equal(limiter.snapshot().limit, 3);

    for (let index = 0; index < 6; index += 1) await limiter.run(async () => index);
    assert.equal(limiter.snapshot().limit, 6);

    limiter.onPoolExhausted();
    assert.equal(limiter.snapshot().limit, 3);
});

test('one key cooldown delays growth but does not lower the global Gemini limit', async () => {
    const limiter = new AdaptiveGeminiLimiter({ successesPerIncrease: 2 });
    await limiter.run(async () => {});
    limiter.onKeyRateLimit();
    await limiter.run(async () => {});

    assert.equal(limiter.snapshot().limit, 3);
    assert.equal(limiter.snapshot().consecutiveSuccesses, 1);
});

test('adaptive Gemini limiter never starts more requests than its current global limit', async () => {
    const limiter = new AdaptiveGeminiLimiter({ initialLimit: 3, minLimit: 3, maxLimit: 6 });
    const gates = Array.from({ length: 4 }, deferred);
    const started = [];
    const jobs = gates.map((gate, index) => limiter.run(async () => {
        started.push(index);
        await gate.promise;
    }));

    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started, [0, 1, 2]);
    gates[0].resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started, [0, 1, 2, 3]);
    gates.slice(1).forEach(gate => gate.resolve());
    await Promise.all(jobs);
});
