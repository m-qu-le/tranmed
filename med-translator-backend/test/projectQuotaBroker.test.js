import assert from 'node:assert/strict';
import test from 'node:test';
import { GeminiKeyScheduler } from '../src/services/geminiKeyScheduler.js';
import { ErrorCodes, ProcessingError } from '../src/utils/processingError.js';

const fiftyProjects = Array.from({ length: 50 }, (_, index) => ({
    id: `project-${index + 1}`,
    apiKey: `secret-${index + 1}`,
    index,
}));

function scheduler(options = {}) {
    return new GeminiKeyScheduler({
        projectsProvider: () => fiftyProjects,
        limits: {
            rpm: 1000,
            tpm: 10_000_000,
            normalRpd: 1000,
            retryRpd: 1000,
            totalRpd: 2000,
            maxInFlight: 2,
        },
        sleep: async () => {},
        ...options,
    });
}

test('50 projects returning schema-invalid still issue at most three physical attempts', async () => {
    const broker = scheduler();
    let calls = 0;
    await assert.rejects(
        broker.execute(async () => {
            calls += 1;
            throw new ProcessingError(
                ErrorCodes.GEMINI_SCHEMA_INVALID,
                'invalid schema',
                { retryable: true }
            );
        }),
        error => error.code === ErrorCodes.GEMINI_SCHEMA_INVALID
    );
    assert.equal(calls, 3);
    assert.equal(broker.metricsSnapshot().amplificationRatio, 3);
});

test('one 429 mixed with schema failures retains the content cause', async () => {
    const broker = scheduler();
    let calls = 0;
    await assert.rejects(
        broker.execute(async () => {
            calls += 1;
            if (calls === 1) {
                const error = new Error('quota');
                error.status = 429;
                error.retryAfter = 30;
                throw error;
            }
            throw new ProcessingError(
                ErrorCodes.GEMINI_SCHEMA_INVALID,
                'invalid schema',
                { retryable: true }
            );
        }),
        error => error.code === ErrorCodes.GEMINI_SCHEMA_INVALID
    );
    assert.equal(calls, 3);
});

test('widespread 503 never scans all 50 projects', async () => {
    const broker = scheduler();
    let calls = 0;
    await assert.rejects(
        broker.execute(async () => {
            calls += 1;
            const error = new Error('service unavailable');
            error.status = 503;
            throw error;
        }),
        error => error.code === ErrorCodes.GEMINI_UNAVAILABLE
    );
    assert.equal(calls, 3);
});

test('one project never has more than two in-flight requests', async () => {
    const project = fiftyProjects.slice(0, 1);
    const broker = scheduler({
        projectsProvider: () => project,
        maxInlineWaitMs: 5_000,
    });
    let active = 0;
    let maximum = 0;
    const releases = [];
    const request = () => broker.execute(async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise(resolve => releases.push(resolve));
        active -= 1;
        return { metadata: { usage: { promptTokenCount: 1 } } };
    }, { estimatedInputTokens: 1 });

    const pending = [request(), request(), request()];
    while (releases.length < 2) await new Promise(resolve => setImmediate(resolve));
    assert.equal(maximum, 2);
    releases.splice(0).forEach(resolve => resolve());
    while (releases.length < 1) await new Promise(resolve => setImmediate(resolve));
    releases.splice(0).forEach(resolve => resolve());
    await Promise.all(pending);
    assert.equal(maximum, 2);
});

test('normal RPD, retry reserve and Pacific reset are independent', async () => {
    let now = Date.parse('2026-01-01T07:59:00.000Z'); // 23:59 Pacific
    const broker = scheduler({
        projectsProvider: () => fiftyProjects.slice(0, 1),
        clock: () => now,
        limits: {
            rpm: 100,
            tpm: 1_000_000,
            normalRpd: 1,
            retryRpd: 1,
            totalRpd: 2,
            maxInFlight: 2,
        },
    });
    const succeed = () => ({ metadata: { usage: { promptTokenCount: 1 } } });
    await broker.execute(succeed, { estimatedInputTokens: 1 });
    await assert.rejects(
        broker.execute(succeed, { estimatedInputTokens: 1 }),
        error => error.code === ErrorCodes.GEMINI_RATE_LIMIT
    );

    // The retry reserve remains usable even though the normal allocation is full.
    broker.globalGateUntil = 0;
    await broker.execute(succeed, { estimatedInputTokens: 1, attemptKind: 'retry' });
    broker.globalGateUntil = 0;
    await assert.rejects(
        broker.execute(succeed, { estimatedInputTokens: 1, attemptKind: 'retry' }),
        error => error.code === ErrorCodes.GEMINI_RATE_LIMIT
    );

    now += 2 * 60 * 1000;
    await broker.execute(succeed, { estimatedInputTokens: 1 });
    assert.equal(broker.snapshot()[0].normalRpd, 1);
    assert.equal(broker.snapshot()[0].retryRpd, 0);
});

test('quota and cooldown state hydrate after restart without storing a key', async () => {
    const rows = new Map();
    const StateModel = {
        find(filter) {
            return {
                lean: async () => [...rows.values()]
                    .filter(row => filter.projectId.$in.includes(row.projectId))
                    .map(row => structuredClone(row)),
            };
        },
        async findOneAndUpdate(filter, update) {
            rows.set(filter.projectId, structuredClone(update.$set));
            return structuredClone(update.$set);
        },
    };
    let now = 1_000_000;
    const oneProject = fiftyProjects.slice(0, 1);
    const first = scheduler({
        projectsProvider: () => oneProject,
        StateModel,
        clock: () => now,
    });
    await assert.rejects(
        first.execute(async () => {
            const error = new Error('quota');
            error.status = 429;
            error.retryAfter = 30;
            throw error;
        }),
        error => error.code === ErrorCodes.GEMINI_RATE_LIMIT
    );

    const restarted = scheduler({
        projectsProvider: () => oneProject,
        StateModel,
        clock: () => now,
    });
    await restarted.hydrate();
    assert.equal(restarted.snapshot()[0].cooldownUntil, now + 30_000);
    assert.equal(restarted.snapshot()[0].retryRpd, 0);
    assert.doesNotMatch(JSON.stringify([...rows.values()]), /secret-/);
});

test('a stage suspended before issuance rolls back quota and physical-attempt accounting', async () => {
    const broker = scheduler({ projectsProvider: () => fiftyProjects.slice(0, 1) });
    await assert.rejects(
        broker.execute(
            async () => {
                throw new ProcessingError(
                    ErrorCodes.SCHEDULER_SUSPENDED,
                    'priority preemption'
                );
            },
            { estimatedInputTokens: 1000, deferPhysicalStart: true }
        ),
        error => error.code === ErrorCodes.SCHEDULER_SUSPENDED
    );
    const state = broker.snapshot()[0];
    assert.equal(state.rpm, 0);
    assert.equal(state.normalRpd, 0);
    assert.equal(state.activeCount, 0);
    assert.equal(broker.metricsSnapshot().physicalAttempts, 0);
});

test('suspending a job wakes logical stages waiting inside the quota broker', async () => {
    const broker = scheduler({
        projectsProvider: () => fiftyProjects.slice(0, 1),
        maxInlineWaitMs: 5_000,
        limits: {
            rpm: 100,
            tpm: 1_000_000,
            normalRpd: 100,
            retryRpd: 100,
            totalRpd: 200,
            maxInFlight: 1,
        },
    });
    let releaseFirst;
    const first = broker.execute(
        async () => new Promise(resolve => {
            releaseFirst = () => resolve({ metadata: { usage: { promptTokenCount: 1 } } });
        }),
        { jobId: 'normal-job' }
    );
    while (!releaseFirst) await new Promise(resolve => setImmediate(resolve));
    const waiting = assert.rejects(
        broker.execute(
            async () => ({ metadata: { usage: { promptTokenCount: 1 } } }),
            { jobId: 'normal-job' }
        ),
        error => error.code === ErrorCodes.SCHEDULER_SUSPENDED
    );
    await new Promise(resolve => setImmediate(resolve));
    broker.suspendJob('normal-job');
    await waiting;
    releaseFirst();
    await first;
    assert.equal(broker.metricsSnapshot().physicalAttempts, 1);
});
