export class OperationalMetrics {
    constructor() {
        this.startedAt = new Date();
        this.counters = new Map();
        this.timings = new Map();
        this.distributions = new Map();
        this.gauges = new Map();
    }

    increment(name, amount = 1) {
        this.counters.set(name, (this.counters.get(name) || 0) + amount);
    }

    observe(name, milliseconds) {
        const current = this.timings.get(name) || {
            count: 0,
            totalMs: 0,
            maxMs: 0,
            samples: [],
        };
        current.count += 1;
        current.totalMs += milliseconds;
        current.maxMs = Math.max(current.maxMs, milliseconds);
        current.samples.push(milliseconds);
        if (current.samples.length > 1000) current.samples.shift();
        this.timings.set(name, current);
    }

    setGauge(name, value) {
        this.gauges.set(name, value);
    }

    observeDistribution(name, value) {
        const current = this.distributions.get(name) || {
            count: 0,
            total: 0,
            max: 0,
            samples: [],
        };
        current.count += 1;
        current.total += value;
        current.max = Math.max(current.max, value);
        current.samples.push(value);
        if (current.samples.length > 1000) current.samples.shift();
        this.distributions.set(name, current);
    }

    getDistribution(name) {
        const current = this.distributions.get(name);
        if (!current) return null;
        const samples = [...current.samples].sort((left, right) => left - right);
        const p95Index = Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1);
        return {
            count: current.count,
            average: current.count ? Math.round(current.total / current.count) : 0,
            max: Math.round(current.max),
            p95: samples.length ? Math.round(samples[p95Index]) : 0,
        };
    }

    getTiming(name) {
        const current = this.timings.get(name);
        if (!current) return null;
        const samples = [...current.samples].sort((left, right) => left - right);
        const p95Index = Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1);
        return {
            count: current.count,
            averageMs: current.count ? Math.round(current.totalMs / current.count) : 0,
            maxMs: Math.round(current.maxMs),
            p95Ms: samples.length ? Math.round(samples[p95Index]) : 0,
        };
    }

    snapshot() {
        return {
            startedAt: this.startedAt,
            counters: Object.fromEntries(this.counters),
            timings: Object.fromEntries(
                [...this.timings.keys()].map(name => [name, this.getTiming(name)])
            ),
            distributions: Object.fromEntries(
                [...this.distributions.keys()].map(name => [name, this.getDistribution(name)])
            ),
            gauges: Object.fromEntries(this.gauges),
        };
    }
}

export const operationalMetrics = new OperationalMetrics();
