import { EventEmitter } from 'node:events';
import { runtimeResourceSnapshot } from './runtimeResourceMonitor.js';

const STATE_REASON = Object.freeze({
    normal: null,
    pressured: 'LOCAL_RESOURCE_PRESSURE',
    suspended: 'LOCAL_RESOURCE_HARD_PRESSURE',
    recovering: 'LOCAL_RESOURCE_RECOVERING',
});

/**
 * CPU-only admission governor for the local Windows runtime. It never changes
 * the Gemini quota scheduler; RAM availability and process RSS are telemetry,
 * not queue-admission conditions.
 */
export class LocalResourceGovernor extends EventEmitter {
    constructor({ config, snapshot = runtimeResourceSnapshot, clock = Date }) {
        super();
        this.config = config;
        this.snapshot = snapshot;
        this.clock = clock;
        this.state = config?.enabled ? 'normal' : 'disabled';
        this.stateSince = this.clock.now();
        this.pressureSince = null;
        this.recoverySince = null;
        this.lastSnapshot = null;
        this.timer = null;
    }

    getSnapshot() {
        return this.lastSnapshot || this.sample();
    }

    getStatus() {
        const snapshot = this.getSnapshot();
        return {
            enabled: Boolean(this.config?.enabled),
            state: this.state,
            reason: STATE_REASON[this.state] || null,
            stateSince: new Date(this.stateSince),
            snapshot,
            canClaim: this.canClaim(),
        };
    }

    canClaim() {
        return !this.config?.enabled || this.state === 'normal';
    }

    canStartStage() {
        return !this.config?.enabled || !['suspended', 'recovering'].includes(this.state);
    }

    sample() {
        const snapshot = this.snapshot();
        this.lastSnapshot = Object.freeze({
            ...snapshot,
            sampledAt: new Date(this.clock.now()),
        });
        return this.lastSnapshot;
    }

    isCpuPressure(snapshot) {
        return snapshot.systemCpuPercent >= this.config.cpuPausePercent;
    }

    isRecovered(snapshot) {
        return snapshot.systemCpuPercent < this.config.cpuResumePercent;
    }

    transition(nextState, snapshot, now) {
        if (nextState === this.state) return false;
        const previousState = this.state;
        this.state = nextState;
        this.stateSince = now;
        this.emit('transition', {
            previousState,
            state: nextState,
            reason: STATE_REASON[nextState] || null,
            snapshot,
            at: new Date(now),
        });
        return true;
    }

    evaluate() {
        if (!this.config?.enabled) return this.getStatus();
        const snapshot = this.sample();
        const now = this.clock.now();
        const cpu = this.isCpuPressure(snapshot);
        const pressure = cpu;

        if (pressure) {
            this.recoverySince = null;
            this.pressureSince ??= now;
            if (this.state === 'normal' && now - this.pressureSince >= this.config.cpuPressureDurationMs) {
                this.transition('pressured', snapshot, now);
            } else if (this.state === 'recovering') {
                this.transition('pressured', snapshot, now);
            }
            return this.getStatus();
        }

        this.pressureSince = null;
        if (this.state === 'normal') return this.getStatus();
        if (!this.isRecovered(snapshot)) {
            this.recoverySince = null;
            return this.getStatus();
        }
        this.recoverySince ??= now;
        if (this.state !== 'recovering') this.transition('recovering', snapshot, now);
        if (now - this.recoverySince >= this.config.recoveryDurationMs) {
            this.recoverySince = null;
            this.transition('normal', snapshot, now);
        }
        return this.getStatus();
    }

    start() {
        if (!this.config?.enabled || this.timer) return;
        this.evaluate();
        this.timer = setInterval(() => this.evaluate(), this.config.sampleIntervalMs);
        this.timer.unref?.();
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }
}
