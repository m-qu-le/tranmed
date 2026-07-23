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
    } = {}) {
        if (![initialLimit, minLimit, maxLimit, successesPerIncrease]
            .every(Number.isSafeInteger)
            || minLimit < 1
            || initialLimit < minLimit
            || initialLimit > maxLimit
            || successesPerIncrease < 1) {
            throw new Error('Cấu hình adaptive Gemini limiter không hợp lệ.');
        }
        this.limit = initialLimit;
        this.minLimit = minLimit;
        this.maxLimit = maxLimit;
        this.successesPerIncrease = successesPerIncrease;
        this.consecutiveSuccesses = 0;
        this.activeCount = 0;
        this.waiting = [];
    }

    snapshot() {
        return {
            limit: this.limit,
            minLimit: this.minLimit,
            maxLimit: this.maxLimit,
            activeCount: this.activeCount,
            waitingCount: this.waiting.length,
            consecutiveSuccesses: this.consecutiveSuccesses,
        };
    }

    onPoolExhausted() {
        this.limit = Math.max(this.minLimit, Math.floor(this.limit / 2));
        this.onKeyRateLimit();
        this.drain();
        return this.limit;
    }

    onKeyRateLimit() {
        this.consecutiveSuccesses = 0;
    }

    async run(task, { signal } = {}) {
        if (signal?.aborted) throw cancelledError();
        return new Promise((resolve, reject) => {
            const entry = { task, resolve, reject, signal, onAbort: null };
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

    drain() {
        while (this.activeCount < this.limit && this.waiting.length > 0) {
            const entry = this.waiting.shift();
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
        if (this.limit >= this.maxLimit) return;
        this.consecutiveSuccesses += 1;
        if (this.consecutiveSuccesses < this.successesPerIncrease) return;
        this.limit += 1;
        this.consecutiveSuccesses = 0;
        this.drain();
    }
}
