import { ErrorCodes, ProcessingError } from '../utils/processingError.js';

export const DEFAULT_GEMINI_HEADROOM = Object.freeze({
    rpm: 12,
    tpm: 200_000,
    rpd: 400,
});

function statusOf(error) {
    return error?.status || error?.response?.status || error?.$metadata?.httpStatusCode || null;
}

function retryAfterMs(error, now) {
    const headers = error?.response?.headers;
    const raw = headers?.get?.('retry-after') || headers?.['retry-after'] || error?.retryAfter;
    if (raw == null) return null;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = new Date(raw).getTime();
    return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function cancellationError() {
    return new ProcessingError(ErrorCodes.CANCELLED, 'Tác vụ đã được hủy khi chờ Gemini key.');
}

function rateLimitError(message, retryMs) {
    const error = new ProcessingError(
        ErrorCodes.GEMINI_RATE_LIMIT,
        message,
        { retryable: true, quotaRelated: true, publicMessage: 'Gemini đang hết quota, hệ thống sẽ thử lại.' }
    );
    error.retryAfterMs = retryMs;
    return error;
}

const CONTENT_RESPONSE_ERROR_CODES = new Set([
    ErrorCodes.GEMINI_BLOCKED,
    ErrorCodes.GEMINI_OUTPUT_TRUNCATED,
    ErrorCodes.GEMINI_RESPONSE_INVALID,
    ErrorCodes.GEMINI_SCHEMA_INVALID,
]);

export class GeminiKeyScheduler {
    constructor({
        keysProvider,
        limits = DEFAULT_GEMINI_HEADROOM,
        clock = () => Date.now(),
        random = Math.random,
    }) {
        this.keysProvider = keysProvider;
        this.limits = limits;
        this.clock = clock;
        this.random = random;
        this.nextIndex = 0;
        this.states = [];
        this.reservationId = 0;
        this.exhaustionCount = 0;
    }

    ensureStates(keyCount) {
        while (this.states.length < keyCount) {
            this.states.push({
                disabled: false,
                cooldownUntil: 0,
                hasSucceeded: false,
                requestTimes: [],
                tokenEvents: [],
                day: null,
                dailyCount: 0,
            });
        }
        if (this.states.length > keyCount) this.states.length = keyCount;
    }

    prune(state, now) {
        const minuteAgo = now - 60_000;
        state.requestTimes = state.requestTimes.filter(time => time > minuteAgo);
        state.tokenEvents = state.tokenEvents.filter(event => event.at > minuteAgo);
        const day = new Date(now).toISOString().slice(0, 10);
        if (state.day !== day) {
            state.day = day;
            state.dailyCount = 0;
        }
    }

    reserve(keyCount, excluded, estimatedInputTokens) {
        const now = this.clock();
        this.ensureStates(keyCount);
        for (let offset = 0; offset < keyCount; offset += 1) {
            const keyIndex = (this.nextIndex + offset) % keyCount;
            if (excluded.has(keyIndex)) continue;
            const state = this.states[keyIndex];
            this.prune(state, now);
            const rollingTokens = state.tokenEvents.reduce((sum, event) => sum + event.count, 0);
            if (state.disabled
                || state.cooldownUntil > now
                || state.requestTimes.length >= this.limits.rpm
                || rollingTokens + estimatedInputTokens > this.limits.tpm
                || state.dailyCount >= this.limits.rpd) {
                continue;
            }

            this.nextIndex = (keyIndex + 1) % keyCount;
            state.requestTimes.push(now);
            state.dailyCount += 1;
            const tokenEvent = { id: ++this.reservationId, at: now, count: estimatedInputTokens };
            state.tokenEvents.push(tokenEvent);
            return { keyIndex, state, tokenEvent };
        }
        return null;
    }

    recordSuccess(reservation, result) {
        reservation.state.hasSucceeded = true;
        const actualInput = result?.metadata?.usage?.promptTokenCount;
        if (Number.isFinite(actualInput) && actualInput >= 0) reservation.tokenEvent.count = actualInput;
    }

    initialize() {
        const keyCount = this.keysProvider().length;
        this.ensureStates(keyCount);
        return keyCount;
    }

    snapshot() {
        const now = this.clock();
        return this.states.map((state, keyIndex) => {
            this.prune(state, now);
            return {
                keyIndex,
                disabled: state.disabled,
                cooldownUntil: state.cooldownUntil || null,
                rpm: state.requestTimes.length,
                rollingInputTokens: state.tokenEvents.reduce((sum, event) => sum + event.count, 0),
                rpd: state.dailyCount,
            };
        });
    }

    publicStatus() {
        this.initialize();
        const now = this.clock();
        return this.states.map((state, keyIndex) => ({
            index: keyIndex + 1,
            status: state.disabled
                ? 'disabled'
                : state.cooldownUntil > now
                    ? 'cooldown'
                    : state.hasSucceeded
                        ? 'available'
                        : 'untested',
            cooldownUntil: state.cooldownUntil > now
                ? new Date(state.cooldownUntil).toISOString()
                : null,
        }));
    }

    async execute(requestFactory, options = {}) {
        const {
            estimatedInputTokens = 10_000,
            signal,
            onEvent = () => {},
        } = options;
        const keys = this.keysProvider();
        if (!keys.length) {
            throw new ProcessingError(
                ErrorCodes.GEMINI_CONFIG,
                'Không có Gemini API key hợp lệ.',
                { publicMessage: 'Server chưa được cấu hình Gemini API key.' }
            );
        }
        this.ensureStates(keys.length);

        const excluded = new Set();
        let authFailures = 0;
        let quotaFailures = 0;
        let lastError = null;
        let longestRetryMs = 0;
        while (excluded.size < keys.length) {
            if (signal?.aborted) throw cancellationError();
            const reservation = this.reserve(keys.length, excluded, estimatedInputTokens);
            if (!reservation) break;
            const { keyIndex, state } = reservation;
            excluded.add(keyIndex);
            onEvent({ type: 'reserved', keyIndex });
            try {
                const result = await requestFactory({ apiKey: keys[keyIndex], keyIndex });
                this.recordSuccess(reservation, result);
                this.exhaustionCount = 0;
                onEvent({ type: 'succeeded', keyIndex, usage: result?.metadata?.usage || null });
                return result;
            } catch (error) {
                if (signal?.aborted || error?.code === ErrorCodes.CANCELLED || error?.name === 'AbortError') {
                    throw cancellationError();
                }
                lastError = error;
                const status = statusOf(error);
                if (status === 400 || status === 404 || error?.code === ErrorCodes.GEMINI_CONFIG) throw error;
                if (status === 401 || status === 403) {
                    state.disabled = true;
                    authFailures += 1;
                    onEvent({ type: 'disabled', keyIndex, status });
                    continue;
                }
                if (status === 429) {
                    const explicitRetryMs = retryAfterMs(error, this.clock());
                    const waitMs = explicitRetryMs ?? 60_000;
                    state.cooldownUntil = this.clock() + waitMs;
                    if (explicitRetryMs != null) {
                        longestRetryMs = Math.max(longestRetryMs, explicitRetryMs);
                    }
                    quotaFailures += 1;
                    onEvent({ type: 'cooldown', keyIndex, status, retryAfterMs: waitMs });
                    continue;
                }

                const transient = status == null
                    || [500, 502, 503, 504].includes(status)
                    || error?.retryable;
                if (!transient) throw error;
                const waitMs = 1000 + Math.floor(this.random() * 1000);
                state.cooldownUntil = this.clock() + waitMs;
                onEvent({ type: 'rotated', keyIndex, status, retryAfterMs: waitMs, code: error?.code || null });
            }
        }

        if (authFailures === keys.length || this.states.slice(0, keys.length).every(state => state.disabled)) {
            throw new ProcessingError(
                ErrorCodes.GEMINI_AUTH,
                'Toàn bộ Gemini API key đều bị từ chối.',
                { publicMessage: 'Toàn bộ Gemini API key không hợp lệ.' }
            );
        }
        if (quotaFailures > 0 || !lastError) {
            this.exhaustionCount += 1;
            const exponentialRetryMs = (60_000 * (2 ** Math.min(this.exhaustionCount - 1, 5)))
                + Math.floor(this.random() * 15_000);
            throw rateLimitError(
                quotaFailures > 0 ? 'Tất cả Gemini key khả dụng đang cooling down.' : 'Gemini key pool đã chạm headroom nội bộ.',
                longestRetryMs || exponentialRetryMs
            );
        }
        if (CONTENT_RESPONSE_ERROR_CODES.has(lastError?.code)) throw lastError;
        throw new ProcessingError(
            ErrorCodes.GEMINI_UNAVAILABLE,
            lastError?.message || 'Gemini tạm thời không khả dụng.',
            { retryable: true, publicMessage: 'Gemini tạm thời không khả dụng, hệ thống sẽ thử lại.' }
        );
    }
}
