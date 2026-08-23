import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { operationalMetrics } from './operationalMetrics.js';

const eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
eventLoopHistogram.enable();
let eventLoopSampledAt = 0;
let cachedEventLoopP95Ms = 0;
let previousCpuSample = null;

function memoryLimitBytes() {
    const constrained = process.constrainedMemory?.();
    if (Number.isFinite(constrained) && constrained > 0) return constrained;
    return os.totalmem();
}

function sampleSystemCpuPercent() {
    const now = Date.now();
    const totals = os.cpus().reduce((total, cpu) => {
        const times = cpu.times;
        return {
            idle: total.idle + times.idle,
            total: total.total + times.user + times.nice + times.sys + times.idle + times.irq,
        };
    }, { idle: 0, total: 0 });
    const previous = previousCpuSample;
    previousCpuSample = { ...totals, sampledAt: now };
    if (!previous || totals.total <= previous.total) return 0;
    const totalDelta = totals.total - previous.total;
    const idleDelta = Math.max(0, totals.idle - previous.idle);
    return Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
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
        availableMemoryBytes: os.freemem(),
        systemCpuPercent: Math.round(sampleSystemCpuPercent()),
        eventLoopP95Ms: Math.round(cachedEventLoopP95Ms),
        mongoP95Ms,
    };
}
