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

test('normal and retry share one RPD pool and reset together at Pacific midnight', async () => {
    let now = Date.parse('2026-01-01T07:59:00.000Z'); // 23:59 Pacific
    const broker = scheduler({
        projectsProvider: () => fiftyProjects.slice(0, 1),
        clock: () => now,
        limits: {
            rpm: 100,
            tpm: 1_000_000,
            totalRpd: 2,
            maxInFlight: 2,
        },
    });
    const succeed = () => ({ metadata: { usage: { promptTokenCount: 1 } } });
    await broker.execute(succeed, { estimatedInputTokens: 1 });
    // Retry can consume all remaining total capacity; there is no 50-request bucket.
    await broker.execute(succeed, { estimatedInputTokens: 1, attemptKind: 'retry' });
    broker.globalGateUntil = 0;
    await assert.rejects(
        broker.execute(succeed, { estimatedInputTokens: 1 }),
        error => error.code === ErrorCodes.GEMINI_RATE_LIMIT
    );

    now += 2 * 60 * 1000;
    await broker.execute(succeed, { estimatedInputTokens: 1 });
    assert.equal(broker.snapshot()[0].normalRpd, 1);
    assert.equal(broker.snapshot()[0].retryRpd, 0);
});

test('retry remains eligible above 50 requests while total RPD has capacity', async () => {
    const broker = scheduler({
        projectsProvider: () => fiftyProjects.slice(0, 1),
        limits: {
            rpm: 1000,
            tpm: 10_000_000,
            totalRpd: 100,
            maxInFlight: 2,
        },
    });
    const succeed = () => ({ metadata: { usage: { promptTokenCount: 1 } } });
    for (let request = 0; request < 51; request += 1) {
        await broker.execute(succeed, { estimatedInputTokens: 1, attemptKind: 'retry' });
    }
    await broker.execute(succeed, { estimatedInputTokens: 1, attemptKind: 'retry' });
    assert.equal(broker.snapshot()[0].retryRpd, 52);
    assert.equal(broker.snapshot()[0].totalRpd, 52);
});

test('working groups rotate in fixed groups of five and the cursor survives restart', async () => {
    let schedulerRow = null;
    const SchedulerStateModel = {
        findOne() {
            return { lean: async () => clone(schedulerRow) };
        },
        async findOneAndUpdate(_filter, update) {
            schedulerRow = clone(update.$set);
            return clone(schedulerRow);
        },
    };
    const clone = value => value == null ? value : structuredClone(value);
    const broker = scheduler({
        SchedulerStateModel,
        eligibleProjectLimit: 50,
        projectGroupSize: 5,
        groupRotationEnabled: true,
        limits: {
            rpm: 1000,
            tpm: 10_000_000,
            totalRpd: 1,
            maxInFlight: 2,
        },
    });
    const keyIndexes = [];
    for (let request = 0; request < 11; request += 1) {
        await broker.execute(async ({ keyIndex }) => {
            keyIndexes.push(keyIndex);
            return { metadata: { usage: { promptTokenCount: 1 } } };
        }, { estimatedInputTokens: 1 });
    }
    assert.deepEqual(keyIndexes.slice(0, 5), [0, 1, 2, 3, 4]);
    assert.deepEqual(keyIndexes.slice(5, 10), [5, 6, 7, 8, 9]);
    assert.equal(keyIndexes[10], 10);
    assert.equal(broker.metricsSnapshot().currentGroup, 3);

    const restarted = scheduler({
        SchedulerStateModel,
        eligibleProjectLimit: 50,
        projectGroupSize: 5,
        groupRotationEnabled: true,
    });
    await restarted.hydrate();
    assert.equal(restarted.metricsSnapshot().currentGroup, 3);
});

test('quota reservation is created only after the concurrency limiter grants a permit', async () => {
    const broker = scheduler({ projectsProvider: () => fiftyProjects.slice(0, 1) });
    let releasePermit;
    const permit = new Promise(resolve => { releasePermit = resolve; });
    let waitingForPermit = false;
    const pending = broker.execute(
        async () => ({ metadata: { usage: { promptTokenCount: 1 } } }),
        {
            estimatedInputTokens: 1,
            admitPhysical: async task => {
                waitingForPermit = true;
                await permit;
                return task();
            },
        }
    );
    while (!waitingForPermit) await new Promise(resolve => setImmediate(resolve));
    assert.equal(broker.snapshot()[0].rpm, 0);
    assert.equal(broker.snapshot()[0].activeCount, 0);
    releasePermit();
    await pending;
    assert.equal(broker.snapshot()[0].rpm, 1);
});

test('rotation rollback confines capacity checks to the first five-project working set', async () => {
    const broker = scheduler({
        eligibleProjectLimit: 50,
        projectGroupSize: 5,
        groupRotationEnabled: false,
        limits: {
            rpm: 1000,
            tpm: 10_000_000,
            totalRpd: 1,
            maxInFlight: 2,
        },
    });
    const used = [];
    for (let request = 0; request < 5; request += 1) {
        await broker.execute(async ({ keyIndex }) => {
            used.push(keyIndex);
            return { metadata: { usage: { promptTokenCount: 1 } } };
        }, { estimatedInputTokens: 1 });
    }
    await assert.rejects(
        broker.execute(async () => ({ metadata: {} }), { estimatedInputTokens: 1 }),
        error => error.code === ErrorCodes.GEMINI_RATE_LIMIT && error.poolExhausted
    );
    assert.deepEqual(used, [0, 1, 2, 3, 4]);
    assert.equal(broker.metricsSnapshot().currentGroup, 1);
});

test('global quota gate opens only after all 50 projects are exhausted and clears after Pacific reset', async () => {
    let now = Date.parse('2026-01-01T06:00:00.000Z');
    const broker = scheduler({
        clock: () => now,
        eligibleProjectLimit: 50,
        projectGroupSize: 5,
        groupRotationEnabled: true,
        limits: {
            rpm: 1000,
            tpm: 10_000_000,
            totalRpd: 1,
            maxInFlight: 2,
        },
    });
    const succeed = () => ({ metadata: { usage: { promptTokenCount: 1 } } });
    for (let request = 0; request < 50; request += 1) {
        await broker.execute(succeed, { estimatedInputTokens: 1 });
    }
    let resetAt;
    await assert.rejects(
        broker.execute(succeed, { estimatedInputTokens: 1 }),
        error => {
            resetAt = new Date(error.nextAvailableAt).getTime();
            return error.code === ErrorCodes.GEMINI_RATE_LIMIT && error.poolExhausted;
        }
    );
    assert.equal(broker.availabilitySnapshot().gated, true);

    now = resetAt + 1;
    await broker.execute(succeed, { estimatedInputTokens: 1 });
    assert.equal(broker.availabilitySnapshot().gated, false);
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
