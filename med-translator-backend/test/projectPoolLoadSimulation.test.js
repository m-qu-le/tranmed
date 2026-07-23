import assert from 'node:assert/strict';
import test from 'node:test';
import { GeminiKeyScheduler } from '../src/services/geminiKeyScheduler.js';

test('300-stage normal load keeps physical/logical amplification at or below 1.15', async () => {
    const projects = Array.from({ length: 50 }, (_, index) => ({
        id: `load-project-${index + 1}`,
        apiKey: `load-secret-${index + 1}`,
        index,
    }));
    const broker = new GeminiKeyScheduler({
        projectsProvider: () => projects,
        activeProjectLimit: 50,
        maxInlineWaitMs: 5_000,
        limits: {
            rpm: 14,
            tpm: 225_000,
            normalRpd: 450,
            retryRpd: 50,
            totalRpd: 500,
            maxInFlight: 2,
        },
    });

    await Promise.all(Array.from({ length: 300 }, () => broker.execute(
        async () => ({ metadata: { usage: { promptTokenCount: 1000 } } }),
        { estimatedInputTokens: 1000 }
    )));

    const metrics = broker.metricsSnapshot();
    assert.equal(metrics.logicalRequests, 300);
    assert.equal(metrics.physicalAttempts, 300);
    assert.equal(metrics.amplificationRatio <= 1.15, true);
    assert.equal(broker.snapshot().every(project => project.activeCount === 0), true);
});
