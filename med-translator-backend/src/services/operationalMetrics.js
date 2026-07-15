export class OperationalMetrics {
    constructor() {
        this.startedAt = new Date();
        this.counters = new Map();
        this.timings = new Map();
    }

    increment(name, amount = 1) {
        this.counters.set(name, (this.counters.get(name) || 0) + amount);
    }

    observe(name, milliseconds) {
        const current = this.timings.get(name) || { count: 0, totalMs: 0, maxMs: 0 };
        current.count += 1;
        current.totalMs += milliseconds;
        current.maxMs = Math.max(current.maxMs, milliseconds);
        this.timings.set(name, current);
    }

    snapshot() {
        return {
            startedAt: this.startedAt,
            counters: Object.fromEntries(this.counters),
            timings: Object.fromEntries([...this.timings].map(([name, value]) => [name, {
                count: value.count,
                averageMs: value.count ? Math.round(value.totalMs / value.count) : 0,
                maxMs: Math.round(value.maxMs),
            }])),
        };
    }
}

export const operationalMetrics = new OperationalMetrics();
