import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalResourceGovernor } from '../src/services/localResourceGovernor.js';

test('local resource governor ignores RAM and pauses admission only for sustained CPU pressure', () => {
    let now = 0;
    let snapshot = {
        rssBytes: 100,
        availableMemoryBytes: 1_000,
        systemCpuPercent: 10,
        eventLoopP95Ms: 1,
    };
    const governor = new LocalResourceGovernor({
        config: {
            enabled: true,
            cpuPausePercent: 75,
            cpuResumePercent: 50,
            cpuPressureDurationMs: 15_000,
            recoveryDurationMs: 30_000,
            sampleIntervalMs: 5_000,
        },
        snapshot: () => snapshot,
        clock: { now: () => now },
    });

    assert.equal(governor.evaluate().state, 'normal');
    snapshot = { ...snapshot, systemCpuPercent: 80 };
    assert.equal(governor.evaluate().state, 'normal', 'CPU pressure needs a sustained sample');
    now += 15_000;
    assert.equal(governor.evaluate().state, 'pressured');
    assert.equal(governor.canClaim(), false);
    assert.equal(governor.canStartStage(), true, 'an already running Gemini stage may persist');

    snapshot = { ...snapshot, rssBytes: 999_999, availableMemoryBytes: 1, systemCpuPercent: 10 };
    assert.equal(governor.evaluate().state, 'recovering');
    now += 30_000;
    assert.equal(governor.evaluate().state, 'normal');
    assert.equal(governor.canClaim(), true);
});
