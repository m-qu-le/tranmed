import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { operationalMetrics } from './operationalMetrics.js';

const eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
eventLoopHistogram.enable();
let eventLoopSampledAt = 0;
let cachedEventLoopP95Ms = 0;

function memoryLimitBytes() {
    const constrained = process.constrainedMemory?.();
    if (Number.isFinite(constrained) && constrained > 0) return constrained;
    return os.totalmem();
}

export function runtimeResourceSnapshot() {
    const rssBytes = process.memoryUsage().rss;
    const limitBytes = memoryLimitBytes();
    const now = Date.now();
    if (now - eventLoopSampledAt >= 5_000) {
        const percentile = eventLoopHistogram.percentile(95);
        cachedEventLoopP95Ms = Number.isFinite(percentile) ? percentile / 1_000_000 : 0;
        eventLoopHistogram.reset();
        eventLoopSampledAt = now;
    }
    const mongoP95Ms = operationalMetrics.getTiming('mongodb.operation.latency')?.p95Ms || 0;
    return {
        rssBytes,
        memoryLimitBytes: limitBytes,
        memoryRatio: limitBytes > 0 ? rssBytes / limitBytes : 0,
        eventLoopP95Ms: Math.round(cachedEventLoopP95Ms),
        mongoP95Ms,
    };
}
