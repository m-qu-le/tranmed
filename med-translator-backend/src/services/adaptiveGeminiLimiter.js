import { ErrorCodes, ProcessingError } from '../utils/processingError.js';

function cancelledError() {
    return new ProcessingError(ErrorCodes.CANCELLED, 'Đã hủy khi chờ lượt gọi Gemini.');
}

export class AdaptiveGeminiLimiter {
    constructor({
        initialLimit = 3,
        minLimit = 3,
        maxLimit = 6,
        successesPerIncrease = 30,
        increaseStep = 1,
        resourceProvider = () => ({}),
    } = {}) {
        if (![initialLimit, minLimit, maxLimit, successesPerIncrease, increaseStep]
            .every(Number.isSafeInteger)
            || minLimit < 1
            || initialLimit < minLimit
            || initialLimit > maxLimit
            || successesPerIncrease < 1
            || increaseStep < 1) {
            throw new Error('Cấu hình adaptive Gemini limiter không hợp lệ.');
        }
        this.limit = initialLimit;
        this.minLimit = minLimit;
        this.maxLimit = maxLimit;
        this.successesPerIncrease = successesPerIncrease;
        this.increaseStep = increaseStep;
        this.resourceProvider = resourceProvider;
        this.consecutiveSuccesses = 0;
        this.activeCount = 0;
        this.waiting = [];
        this.sequence = 0;
        this.dispatchSequence = 0;
        this.jobLastServed = new Map();
        this.lastResourceSnapshot = {};
        this.lastAdjustment = null;
        this.resourcePressureLevel = 0;
        this.lastResourceReductionAt = 0;
        this.rateLimitWindow = [];
        this.priorityGate = false;
    }

    snapshot() {
        return {
            limit: this.limit,
            minLimit: this.minLimit,
            maxLimit: this.maxLimit,
            activeCount: this.activeCount,
            waitingCount: this.waiting.length,
            consecutiveSuccesses: this.consecutiveSuccesses,
            lastResourceSnapshot: this.lastResourceSnapshot,
            lastAdjustment: this.lastAdjustment,
            rateLimitRatio: this.rateLimitWindow.length
                ? this.rateLimitWindow.reduce((sum, value) => sum + value, 0) / this.rateLimitWindow.length
                : 0,
            priorityGate: this.priorityGate,
        };
    }

    setPriorityGate(enabled) {
        this.priorityGate = Boolean(enabled);
        this.drain();
    }

    suspendJob(jobId) {
        if (!jobId) return 0;
        let suspended = 0;
        for (let index = this.waiting.length - 1; index >= 0; index -= 1) {
            const entry = this.waiting[index];
            if (entry.jobId !== jobId || entry.priority > 0) continue;
            this.waiting.splice(index, 1);
            entry.signal?.removeEventListener('abort', entry.onAbort);
            entry.reject(new ProcessingError(
                ErrorCodes.SCHEDULER_SUSPENDED,
                'Stage đang chờ đã nhường lượt cho job ưu tiên.'
            ));
            suspended += 1;
        }
        return suspended;
    }

    forgetJob(jobId) {
        if (jobId) this.jobLastServed.delete(jobId);
    }

    onPoolExhausted() {
        this.limit = Math.max(this.minLimit, Math.floor(this.limit / 2));
        this.onKeyRateLimit();
        this.drain();
        return this.limit;
    }

    onKeyRateLimit() {
        this.consecutiveSuccesses = 0;
        this.rateLimitWindow.push(1);
        if (this.rateLimitWindow.length > 100) this.rateLimitWindow.shift();
    }

    async run(task, {
        signal,
        priority = 0,
        retryPriority = 0,
        jobId = null,
    } = {}) {
        if (signal?.aborted) throw cancelledError();
        return new Promise((resolve, reject) => {
            const entry = {
                task,
                resolve,
                reject,
                signal,
                priority: Number(priority) || 0,
                retryPriority: Number(retryPriority) || 0,
                jobId,
                sequence: ++this.sequence,
                onAbort: null,
            };
            entry.onAbort = () => {
                const index = this.waiting.indexOf(entry);
                if (index >= 0) this.waiting.splice(index, 1);
                reject(cancelledError());
            };
            signal?.addEventListener('abort', entry.onAbort, { once: true });
            this.waiting.push(entry);
            this.drain();
        });
    }

    applyResourceGuard() {
        const snapshot = this.resourceProvider?.() || {};
        this.lastResourceSnapshot = snapshot;
        const severe = snapshot.memoryRatio >= 0.8 || snapshot.eventLoopP95Ms >= 200;
        const constrained = snapshot.memoryRatio >= 0.7
            || snapshot.eventLoopP95Ms >= 100;
        const pressureLevel = severe ? 2 : constrained ? 1 : 0;
        const previous = this.limit;
        const now = Date.now();
        const shouldReduce = pressureLevel > 0 && (
            pressureLevel > this.resourcePressureLevel
            || now - this.lastResourceReductionAt >= 30_000
        );
        if (shouldReduce) {
            if (severe) this.limit = Math.max(this.minLimit, Math.floor(this.limit / 2));
            else this.limit = Math.max(this.minLimit, Math.floor(this.limit * 0.8));
            this.lastResourceReductionAt = now;
        }
        this.resourcePressureLevel = pressureLevel;
        if (this.limit !== previous) {
            this.consecutiveSuccesses = 0;
            this.lastAdjustment = {
                type: severe ? 'severe_resource_pressure' : 'resource_pressure',
                previous,
                current: this.limit,
                at: new Date(),
            };
        }
        return { ...snapshot, severe, constrained };
    }

    takeNextEntry() {
        if (this.waiting.length === 0) return null;
        const highestPriority = this.waiting.reduce(
            (highest, entry) => Math.max(highest, entry.priority),
            -Infinity
        );
        if (this.priorityGate && highestPriority < 1) return null;
        const highestRetryPriority = this.waiting
            .filter(entry => entry.priority === highestPriority)
            .reduce(
                (highest, entry) => Math.max(highest, entry.retryPriority || 0),
                -Infinity
            );
        const eligible = this.waiting
            .map((entry, index) => ({ entry, index }))
            .filter(candidate => (
                candidate.entry.priority === highestPriority
                && (candidate.entry.retryPriority || 0) === highestRetryPriority
            ))
            .sort((left, right) => (
                (this.jobLastServed.get(left.entry.jobId) || 0)
                    - (this.jobLastServed.get(right.entry.jobId) || 0)
                || left.entry.sequence - right.entry.sequence
            ));
        const index = eligible[0].index;
        const [entry] = this.waiting.splice(index, 1);
        if (entry.jobId) {
            this.jobLastServed.set(entry.jobId, ++this.dispatchSequence);
        }
        return entry;
    }

    drain() {
        this.applyResourceGuard();
        while (this.activeCount < this.limit && this.waiting.length > 0) {
            const entry = this.takeNextEntry();
            if (!entry) break;
            entry.signal?.removeEventListener('abort', entry.onAbort);
            if (entry.signal?.aborted) {
                entry.reject(cancelledError());
                continue;
            }
            this.activeCount += 1;
            Promise.resolve()
                .then(entry.task)
                .then(result => {
                    this.recordSuccess();
                    entry.resolve(result);
                }, entry.reject)
                .finally(() => {
                    this.activeCount -= 1;
                    this.drain();
                });
        }
    }

    recordSuccess() {
        this.rateLimitWindow.push(0);
        if (this.rateLimitWindow.length > 100) this.rateLimitWindow.shift();
        if (this.limit >= this.maxLimit) return;
        const resource = this.applyResourceGuard();
        if (resource.constrained || resource.severe) return;
        const canGrow = (resource?.memoryRatio == null || resource.memoryRatio < 0.65)
            && (resource?.eventLoopP95Ms == null || resource.eventLoopP95Ms < 100)
            && (resource?.mongoP95Ms == null || resource.mongoP95Ms < 200);
        if (!canGrow) return;
        this.consecutiveSuccesses += 1;
        if (this.consecutiveSuccesses < this.successesPerIncrease) return;
        const rateLimitRatio = this.rateLimitWindow.length
            ? this.rateLimitWindow.reduce((sum, value) => sum + value, 0) / this.rateLimitWindow.length
            : 0;
        if (rateLimitRatio >= 0.01) {
            this.consecutiveSuccesses = 0;
            return;
        }
        const previous = this.limit;
        this.limit = Math.min(this.maxLimit, this.limit + this.increaseStep);
        this.consecutiveSuccesses = 0;
        this.lastAdjustment = {
            type: 'success_growth',
            previous,
            current: this.limit,
            at: new Date(),
        };
        this.drain();
    }
}
