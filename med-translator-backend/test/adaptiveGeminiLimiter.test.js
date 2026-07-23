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

test('priority stages overtake queued normal stages and normal issuance can be gated', async () => {
    const limiter = new AdaptiveGeminiLimiter({ initialLimit: 1, minLimit: 1, maxLimit: 1 });
    const blocker = deferred();
    const order = [];
    const running = limiter.run(async () => blocker.promise, { priority: 0, jobId: 'normal-running' });
    const normal = limiter.run(async () => order.push('normal'), { priority: 0, jobId: 'normal' });
    const priority = limiter.run(async () => order.push('priority'), { priority: 1, jobId: 'priority' });
    blocker.resolve();
    await Promise.all([running, normal, priority]);
    assert.deepEqual(order, ['priority', 'normal']);

    limiter.setPriorityGate(true);
    let started = false;
    const gated = limiter.run(async () => { started = true; }, { priority: 0, jobId: 'normal' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(started, false);
    limiter.setPriorityGate(false);
    await gated;
    assert.equal(started, true);
});

test('equal-priority stages are dispatched round-robin by source job', async () => {
    const limiter = new AdaptiveGeminiLimiter({ initialLimit: 1, minLimit: 1, maxLimit: 1 });
    const blocker = deferred();
    const order = [];
    const running = limiter.run(async () => blocker.promise, { jobId: 'blocker' });
    const queued = [
        limiter.run(async () => order.push('a1'), { jobId: 'a' }),
        limiter.run(async () => order.push('a2'), { jobId: 'a' }),
        limiter.run(async () => order.push('b1'), { jobId: 'b' }),
        limiter.run(async () => order.push('c1'), { jobId: 'c' }),
    ];
    blocker.resolve();
    await Promise.all([running, ...queued]);
    assert.deepEqual(order, ['a1', 'b1', 'c1', 'a2']);
});

test('resource pressure reduces concurrency once per pressure transition', () => {
    let resource = { memoryRatio: 0.75, eventLoopP95Ms: 20, mongoP95Ms: 20 };
    const limiter = new AdaptiveGeminiLimiter({
        initialLimit: 10,
        minLimit: 1,
        maxLimit: 10,
        resourceProvider: () => resource,
    });
    limiter.applyResourceGuard();
    assert.equal(limiter.snapshot().limit, 8);
    limiter.applyResourceGuard();
    assert.equal(limiter.snapshot().limit, 8);
    resource = { memoryRatio: 0.85, eventLoopP95Ms: 20, mongoP95Ms: 20 };
    limiter.applyResourceGuard();
    assert.equal(limiter.snapshot().limit, 4);
});

test('suspending a normal job removes queued stages but lets its running stage finish', async () => {
    const limiter = new AdaptiveGeminiLimiter({ initialLimit: 1, minLimit: 1, maxLimit: 1 });
    const blocker = deferred();
    let runningFinished = false;
    const running = limiter.run(async () => {
        await blocker.promise;
        runningFinished = true;
    }, { jobId: 'normal-job' });
    const queued = limiter.run(async () => {
        throw new Error('queued stage must not start');
    }, { jobId: 'normal-job' });
    const rejected = assert.rejects(
        queued,
        error => error.code === 'SCHEDULER_SUSPENDED'
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(limiter.suspendJob('normal-job'), 1);
    assert.equal(runningFinished, false);
    blocker.resolve();
    await Promise.all([running, rejected]);
    assert.equal(runningFinished, true);
});
