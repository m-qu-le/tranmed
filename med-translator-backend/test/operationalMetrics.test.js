import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationalMetrics } from '../src/services/operationalMetrics.js';

test('operational metrics expose aggregate counters and latency without request details', () => {
    const metrics = new OperationalMetrics();
    metrics.increment('upload.confirm.requests');
    metrics.increment('upload.confirm.requests', 2);
    metrics.observe('r2.head.latency', 10);
    metrics.observe('r2.head.latency', 30);
    metrics.observeDistribution('gemini.translate.prompt_tokens', 1000);
    metrics.observeDistribution('gemini.translate.prompt_tokens', 2000);

    const snapshot = metrics.snapshot();
    assert.equal(snapshot.counters['upload.confirm.requests'], 3);
    assert.deepEqual(snapshot.timings['r2.head.latency'], {
        count: 2,
        averageMs: 20,
        maxMs: 30,
        p95Ms: 30,
    });
    assert.deepEqual(snapshot.distributions['gemini.translate.prompt_tokens'], {
        count: 2,
        average: 1500,
        max: 2000,
        p95: 2000,
    });
    assert.deepEqual(
        Object.keys(snapshot).sort(),
        ['counters', 'distributions', 'gauges', 'startedAt', 'timings']
    );
    assert.doesNotMatch(JSON.stringify(snapshot), /storageKey|uploadUrl|credential|secret/i);
});
