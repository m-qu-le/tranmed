import { ErrorCodes, ProcessingError } from '../utils/processingError.js';
import { operationalMetrics } from './operationalMetrics.js';

const PACIFIC_TIME_ZONE = 'America/Los_Angeles';
const CONTENT_RESPONSE_ERROR_CODES = new Set([
    ErrorCodes.GEMINI_BLOCKED,
    ErrorCodes.GEMINI_OUTPUT_TRUNCATED,
    ErrorCodes.GEMINI_RESPONSE_INVALID,
    ErrorCodes.GEMINI_SCHEMA_INVALID,
]);
const SERVICE_STATUSES = new Set([500, 502, 503, 504]);

export const DEFAULT_GEMINI_HEADROOM = Object.freeze({
    rpm: 14,
    tpm: 225_000,
    totalRpd: 500,
    maxInFlight: 2,
});
export const PROJECT_POOL_EXECUTION_VERSION = 'project-pool-v2';
const SCHEDULER_STATE_ID = 'gemini-project-pool';

function statusOf(error) {
    return error?.status || error?.response?.status || error?.$metadata?.httpStatusCode || null;
}

function retryAfterMs(error, now) {
    const headers = error?.response?.headers;
    const raw = headers?.get?.('retry-after') || headers?.['retry-after'] || error?.retryAfter;
    if (raw != null) {
        const seconds = Number(raw);
        if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
        const date = new Date(raw).getTime();
        if (Number.isFinite(date)) return Math.max(0, date - now);
    }

    const details = error?.errorDetails || error?.details || [];
    for (const detail of Array.isArray(details) ? details : []) {
        const retryDelay = detail?.retryDelay || detail?.retryInfo?.retryDelay;
        if (typeof retryDelay === 'string') {
            const match = retryDelay.match(/^(\d+(?:\.\d+)?)s$/);
            if (match) return Number(match[1]) * 1000;
        }
        if (Number.isFinite(retryDelay?.seconds)) {
            return (retryDelay.seconds * 1000) + Math.floor((retryDelay.nanos || 0) / 1_000_000);
        }
    }
    return null;
}

function pacificDayKey(now) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: PACIFIC_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date(now));
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}

export function nextPacificResetMs(now) {
    const currentDay = pacificDayKey(now);
    let low = now;
    let high = now + (30 * 60 * 60 * 1000);
    while (pacificDayKey(high) === currentDay) high += 6 * 60 * 60 * 1000;
    while (high - low > 1000) {
        const middle = Math.floor((low + high) / 2);
        if (pacificDayKey(middle) === currentDay) low = middle;
        else high = middle;
    }
    return high;
}

function cancellationError() {
    return new ProcessingError(ErrorCodes.CANCELLED, 'Tác vụ đã bị hủy khi chờ Gemini project.');
}

function noProjectCapacityError() {
    const error = new Error('Không có project capacity trong working set.');
    error.noProjectCapacity = true;
    return error;
}

function schedulerSuspensionError() {
    return new ProcessingError(
        ErrorCodes.SCHEDULER_SUSPENDED,
        'Logical stage đang chờ đã nhường lượt cho job ưu tiên.'
    );
}

function databaseError(error) {
    return new ProcessingError(
        ErrorCodes.DATABASE_UNAVAILABLE,
        error?.message || 'Không thể lưu quota Gemini.',
        { retryable: true, publicMessage: 'MongoDB tạm thời không lưu được quota Gemini.' }
    );
}

function rateLimitError(message, retryMs, now, {
    poolExhausted = true,
    deferredReason = 'quota',
} = {}) {
    const error = new ProcessingError(
        ErrorCodes.GEMINI_RATE_LIMIT,
        message,
        {
            retryable: true,
            quotaRelated: true,
            poolExhausted,
            publicMessage: poolExhausted
                ? 'Toàn bộ Gemini project đang chờ quota, hệ thống sẽ thử lại.'
                : 'Stage đang chờ một Gemini project khác khả dụng.'
        }
    );
    error.retryAfterMs = retryMs;
    error.nextAvailableAt = Number.isFinite(retryMs) ? new Date(now + retryMs) : null;
    error.deferredReason = deferredReason;
    return error;
}

function wait(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(cancellationError());
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, Math.max(0, ms));
        const onAbort = () => {
            clearTimeout(timer);
            reject(cancellationError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function clonePersistedState(state) {
    return {
        projectId: state.projectId,
        requestEvents: state.requestEvents.map(event => ({
            id: event.id,
            at: new Date(event.at),
            count: event.count,
            kind: event.kind,
        })),
        quotaDay: state.quotaDay,
        dailyNormalCount: state.dailyNormalCount,
        dailyRetryCount: state.dailyRetryCount,
        cooldownUntil: state.cooldownUntil ? new Date(state.cooldownUntil) : null,
        disabled: state.disabled,
        hasSucceeded: state.hasSucceeded,
        lastSuccessAt: state.lastSuccessAt ? new Date(state.lastSuccessAt) : null,
        lastReservedAt: state.lastReservedAt ? new Date(state.lastReservedAt) : null,
    };
}

export class GeminiKeyScheduler {
    constructor({
        projectsProvider,
        keysProvider,
        StateModel = null,
        SchedulerStateModel = null,
        limits = DEFAULT_GEMINI_HEADROOM,
        activeProjectLimit = Infinity,
        eligibleProjectLimit = activeProjectLimit,
        projectGroupSize = activeProjectLimit,
        groupRotationEnabled = false,
        executionVersion = PROJECT_POOL_EXECUTION_VERSION,
        clock = () => Date.now(),
        random = Math.random,
        maxPhysicalAttempts = 3,
        maxInlineWaitMs = 0,
        sleep = wait,
    }) {
        if (!projectsProvider && !keysProvider) {
            throw new Error('Gemini project scheduler cần projectsProvider hoặc keysProvider.');
        }
        this.projectsProvider = projectsProvider || (() => keysProvider().map((apiKey, index) => ({
            id: `project-${index + 1}`,
            apiKey,
            index,
        })));
        this.StateModel = StateModel;
        this.SchedulerStateModel = SchedulerStateModel;
        const legacyRpd = limits.rpd;
        this.limits = {
            ...DEFAULT_GEMINI_HEADROOM,
            ...limits,
            totalRpd: limits.totalRpd ?? legacyRpd ?? DEFAULT_GEMINI_HEADROOM.totalRpd,
        };
        this.eligibleProjectLimit = eligibleProjectLimit;
        // Kept as a public compatibility property. It now represents the
        // eligible pool, not concurrency or the current working group.
        this.activeProjectLimit = eligibleProjectLimit;
        this.projectGroupSize = projectGroupSize;
        this.groupRotationEnabled = Boolean(groupRotationEnabled);
        this.executionVersion = executionVersion;
        this.currentGroupIndex = 0;
        this.lastRotatedAt = 0;
        this.rotationReason = null;
        this.clock = clock;
        this.random = random;
        this.maxPhysicalAttempts = maxPhysicalAttempts;
        this.maxInlineWaitMs = maxInlineWaitMs;
        this.sleep = sleep;
        this.states = new Map();
        this.reservationId = 0;
        this.persistChains = new Map();
        this.schedulerPersistChain = Promise.resolve();
        this.hydrationPromise = null;
        this.hydrated = false;
        this.globalGateUntil = 0;
        this.waiters = new Set();
        this.suspendedJobs = new Set();
        this.metrics = {
            logicalRequests: 0,
            logicalIssuedRequests: 0,
            activeLogicalRequests: 0,
            physicalAttempts: 0,
            deferredBeforeIssue: 0,
            rateLimitResponses: 0,
            contentFailures: 0,
            serviceFailures: 0,
            groupRotations: 0,
        };
    }

    resolveProjects() {
        return this.projectsProvider().map((project, index) => ({
            ...project,
            index: Number.isSafeInteger(project.index) ? project.index : index,
        }));
    }

    ensureStates(projects = this.resolveProjects()) {
        const activeIds = new Set(projects.map(project => project.id));
        for (const project of projects) {
            if (this.states.has(project.id)) continue;
            this.states.set(project.id, {
                projectId: project.id,
                projectIndex: project.index,
                disabled: false,
                cooldownUntil: 0,
                hasSucceeded: false,
                requestEvents: [],
                quotaDay: null,
                dailyNormalCount: 0,
                dailyRetryCount: 0,
                activeCount: 0,
                lastSuccessAt: 0,
                lastReservedAt: 0,
            });
        }
        for (const projectId of this.states.keys()) {
            if (!activeIds.has(projectId)) this.states.delete(projectId);
        }
        return projects;
    }

    initialize() {
        const projects = this.ensureStates();
        return projects.length;
    }

    async hydrate() {
        if (this.hydrated || (!this.StateModel && !this.SchedulerStateModel)) return;
        if (this.hydrationPromise) return this.hydrationPromise;
        this.hydrationPromise = (async () => {
            const projects = this.ensureStates();
            const ids = projects.map(project => project.id);
            const [rows, schedulerRow] = await Promise.all([
                this.StateModel
                    ? this.StateModel.find({ projectId: { $in: ids } }).lean()
                    : [],
                this.SchedulerStateModel
                    ? this.SchedulerStateModel.findOne({ schedulerId: SCHEDULER_STATE_ID }).lean()
                    : null,
            ]);
            const now = this.clock();
            for (const row of rows) {
                const state = this.states.get(row.projectId);
                if (!state) continue;
                state.requestEvents = (row.requestEvents || []).map(event => ({
                    id: event.id,
                    at: new Date(event.at).getTime(),
                    count: event.count,
                    kind: event.kind,
                }));
                for (const event of state.requestEvents) {
                    if (Number.isSafeInteger(event.id)) {
                        this.reservationId = Math.max(this.reservationId, event.id);
                    }
                }
                state.quotaDay = row.quotaDay;
                state.dailyNormalCount = row.dailyNormalCount || 0;
                state.dailyRetryCount = row.dailyRetryCount || 0;
                state.cooldownUntil = row.cooldownUntil ? new Date(row.cooldownUntil).getTime() : 0;
                state.disabled = Boolean(row.disabled);
                state.hasSucceeded = Boolean(row.hasSucceeded);
                state.lastSuccessAt = row.lastSuccessAt ? new Date(row.lastSuccessAt).getTime() : 0;
                state.lastReservedAt = row.lastReservedAt ? new Date(row.lastReservedAt).getTime() : 0;
                this.prune(state, now);
            }
            if (schedulerRow) {
                const groupCount = this.groupCount(projects);
                this.currentGroupIndex = this.groupRotationEnabled && groupCount > 0
                    ? Math.max(0, Number(schedulerRow.currentGroupIndex) || 0) % groupCount
                    : 0;
                this.lastRotatedAt = schedulerRow.lastRotatedAt
                    ? new Date(schedulerRow.lastRotatedAt).getTime()
                    : 0;
                this.rotationReason = schedulerRow.rotationReason || null;
            }
            this.hydrated = true;
        })().catch(error => {
            this.hydrationPromise = null;
            throw databaseError(error);
        });
        return this.hydrationPromise;
    }

    prune(state, now) {
        const minuteAgo = now - 60_000;
        state.requestEvents = state.requestEvents.filter(event => event.at > minuteAgo);
        const day = pacificDayKey(now);
        if (state.quotaDay !== day) {
            state.quotaDay = day;
            state.dailyNormalCount = 0;
            state.dailyRetryCount = 0;
        }
    }

    projectCapacity(state, estimatedInputTokens, attemptKind, now) {
        this.prune(state, now);
        const rollingTokens = state.requestEvents.reduce((sum, event) => sum + event.count, 0);
        const dailyTotal = state.dailyNormalCount + state.dailyRetryCount;
        if (state.disabled) return { available: false, retryAt: Infinity, reason: 'disabled' };
        if (state.cooldownUntil > now) {
            return { available: false, retryAt: state.cooldownUntil, reason: 'cooldown' };
        }
        if (state.activeCount >= this.limits.maxInFlight) {
            return { available: false, retryAt: null, reason: 'in_flight' };
        }
        if (state.requestEvents.length >= this.limits.rpm) {
            return {
                available: false,
                retryAt: state.requestEvents[0].at + 60_000,
                reason: 'rpm',
            };
        }
        if (rollingTokens + estimatedInputTokens > this.limits.tpm) {
            return {
                available: false,
                retryAt: state.requestEvents[0]?.at + 60_000 || now + 60_000,
                reason: 'tpm',
            };
        }
        if (dailyTotal >= this.limits.totalRpd) {
            return {
                available: false,
                retryAt: nextPacificResetMs(now),
                reason: 'rpd',
            };
        }
        return { available: true, retryAt: now, reason: null };
    }

    eligibleProjects(projects = this.ensureStates()) {
        return projects.slice(0, Math.min(projects.length, this.eligibleProjectLimit));
    }

    groupCount(projects = this.ensureStates()) {
        const eligibleCount = this.eligibleProjects(projects).length;
        if (eligibleCount === 0) return 0;
        const size = Math.max(1, Math.min(this.projectGroupSize, eligibleCount));
        return Math.ceil(eligibleCount / size);
    }

    projectsInGroup(projects, groupIndex = this.currentGroupIndex) {
        const eligible = this.eligibleProjects(projects);
        if (!eligible.length) return [];
        const size = Math.max(1, Math.min(this.projectGroupSize, eligible.length));
        const count = Math.ceil(eligible.length / size);
        const normalized = Math.max(0, groupIndex) % count;
        return eligible.slice(normalized * size, (normalized + 1) * size);
    }

    groupIndexForProject(projects, projectId) {
        const eligible = this.eligibleProjects(projects);
        const position = eligible.findIndex(project => project.id === projectId);
        if (position < 0) return null;
        const size = Math.max(1, Math.min(this.projectGroupSize, eligible.length));
        return Math.floor(position / size);
    }

    async persistSchedulerState() {
        if (!this.SchedulerStateModel) return;
        const snapshot = {
            schedulerId: SCHEDULER_STATE_ID,
            currentGroupIndex: this.currentGroupIndex,
            lastRotatedAt: this.lastRotatedAt ? new Date(this.lastRotatedAt) : null,
            rotationReason: this.rotationReason,
            executionVersion: this.executionVersion,
        };
        const operation = this.schedulerPersistChain
            .catch(() => {})
            .then(async () => {
                const startedAt = performance.now();
                try {
                    return await this.SchedulerStateModel.findOneAndUpdate(
                        { schedulerId: SCHEDULER_STATE_ID },
                        { $set: snapshot },
                        { upsert: true, returnDocument: 'after' }
                    );
                } finally {
                    const duration = performance.now() - startedAt;
                    operationalMetrics.observe('mongodb.operation.latency', duration);
                    operationalMetrics.observe('mongodb.scheduler_state.latency', duration);
                }
            });
        this.schedulerPersistChain = operation;
        try {
            await operation;
        } catch (error) {
            throw databaseError(error);
        }
    }

    async rotateTo(groupIndex, reason, projects = this.ensureStates()) {
        const count = this.groupCount(projects);
        if (!this.groupRotationEnabled || count <= 1) return false;
        const normalized = ((groupIndex % count) + count) % count;
        if (normalized === this.currentGroupIndex) return false;
        const previous = this.currentGroupIndex;
        this.currentGroupIndex = normalized;
        this.lastRotatedAt = this.clock();
        this.rotationReason = reason || 'capacity';
        this.metrics.groupRotations += 1;
        operationalMetrics.increment('gemini.group_rotations');
        await this.persistSchedulerState();
        this.notifyCapacity();
        return { previous, current: normalized };
    }

    reserveFromGroup(groupProjects, excluded, estimatedInputTokens, attemptKind) {
        const now = this.clock();
        const candidates = groupProjects
            .filter(project => !excluded.has(project.id))
            .map(project => ({
                project,
                state: this.states.get(project.id),
            }))
            .map(candidate => ({
                ...candidate,
                capacity: this.projectCapacity(
                    candidate.state,
                    estimatedInputTokens,
                    attemptKind,
                    now
                ),
            }))
            .filter(candidate => candidate.capacity.available)
            .sort((left, right) => (
                left.state.lastReservedAt - right.state.lastReservedAt
                || (left.state.dailyNormalCount + left.state.dailyRetryCount)
                    - (right.state.dailyNormalCount + right.state.dailyRetryCount)
                || left.project.index - right.project.index
            ));
        const selected = candidates[0];
        if (!selected) return null;

        const { project, state } = selected;
        state.activeCount += 1;
        state.lastReservedAt = now;
        const event = {
            id: ++this.reservationId,
            at: now,
            count: estimatedInputTokens,
            kind: attemptKind,
        };
        state.requestEvents.push(event);
        if (attemptKind === 'retry') state.dailyRetryCount += 1;
        else state.dailyNormalCount += 1;
        return { project, state, event, attemptKind };
    }

    async reserve(projects, excluded, estimatedInputTokens, attemptKind) {
        const count = this.groupCount(projects);
        if (count === 0) return null;
        const groupsToTry = this.groupRotationEnabled ? count : 1;
        for (let offset = 0; offset < groupsToTry; offset += 1) {
            const groupIndex = (this.currentGroupIndex + offset) % count;
            const reservation = this.reserveFromGroup(
                this.projectsInGroup(projects, groupIndex),
                excluded,
                estimatedInputTokens,
                attemptKind
            );
            if (!reservation) continue;
            if (groupIndex !== this.currentGroupIndex) {
                await this.rotateTo(groupIndex, 'capacity', projects);
            }
            return reservation;
        }
        return null;
    }

    earliestRetryAt(projects, excluded, estimatedInputTokens, attemptKind) {
        const now = this.clock();
        const retryTimes = this.eligibleProjects(projects)
            .filter(project => !excluded.has(project.id))
            .map(project => this.projectCapacity(
                this.states.get(project.id),
                estimatedInputTokens,
                attemptKind,
                now
            ).retryAt)
            .filter(Number.isFinite);
        return retryTimes.length ? Math.min(...retryTimes) : null;
    }

    hasAnyCapacity(projects, estimatedInputTokens, attemptKind, excluded = new Set()) {
        const now = this.clock();
        return this.eligibleProjects(projects)
            .filter(project => !excluded.has(project.id))
            .some(project => this.projectCapacity(
                this.states.get(project.id),
                estimatedInputTokens,
                attemptKind,
                now
            ).available);
    }

    capacityScope(projects = this.ensureStates()) {
        return this.groupRotationEnabled
            ? this.eligibleProjects(projects)
            : this.projectsInGroup(projects, this.currentGroupIndex);
    }

    async persist(state, metricName = 'mongodb.quota_state.latency') {
        if (!this.StateModel) return;
        const snapshot = clonePersistedState(state);
        const previous = this.persistChains.get(state.projectId) || Promise.resolve();
        const current = previous
            .catch(() => {})
            .then(async () => {
                const startedAt = performance.now();
                try {
                    return await this.StateModel.findOneAndUpdate(
                        { projectId: state.projectId },
                        { $set: snapshot },
                        { upsert: true, returnDocument: 'after' }
                    );
                } finally {
                    const duration = performance.now() - startedAt;
                    operationalMetrics.observe('mongodb.operation.latency', duration);
                    operationalMetrics.observe('mongodb.quota_state.latency', duration);
                    if (metricName !== 'mongodb.quota_state.latency') {
                        operationalMetrics.observe(metricName, duration);
                    }
                }
            })
            .catch(error => {
                throw databaseError(error);
            });
        this.persistChains.set(state.projectId, current);
        try {
            await current;
        } finally {
            if (this.persistChains.get(state.projectId) === current) {
                this.persistChains.delete(state.projectId);
            }
        }
    }

    notifyCapacity() {
        for (const resolve of this.waiters) resolve();
        this.waiters.clear();
    }

    suspendJob(jobId) {
        if (!jobId) return;
        this.suspendedJobs.add(jobId);
        this.notifyCapacity();
    }

    resumeJob(jobId) {
        if (jobId) this.suspendedJobs.delete(jobId);
    }

    async waitForCapacity(delayMs, signal) {
        if (signal?.aborted) throw cancellationError();
        const boundedDelay = Number.isFinite(delayMs)
            ? Math.max(1, Math.min(delayMs, this.maxInlineWaitMs))
            : 1000;
        await new Promise((resolve, reject) => {
            const timer = setTimeout(done, boundedDelay);
            const onAbort = () => {
                cleanup();
                reject(cancellationError());
            };
            const onCapacity = () => {
                cleanup();
                resolve();
            };
            const cleanup = () => {
                clearTimeout(timer);
                this.waiters.delete(onCapacity);
                signal?.removeEventListener('abort', onAbort);
            };
            function done() {
                cleanup();
                resolve();
            }
            this.waiters.add(onCapacity);
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    async release(reservation, updates = {}) {
        const { state, event } = reservation;
        state.activeCount = Math.max(0, state.activeCount - 1);
        reservation.released = true;
        if (Number.isFinite(updates.actualInputTokens) && updates.actualInputTokens >= 0) {
            event.count = updates.actualInputTokens;
        }
        if (updates.success) {
            state.hasSucceeded = true;
            state.lastSuccessAt = this.clock();
        }
        if (updates.disabled) state.disabled = true;
        if (Number.isFinite(updates.cooldownUntil)) {
            state.cooldownUntil = Math.max(state.cooldownUntil, updates.cooldownUntil);
        }
        await this.persist(state, 'mongodb.quota_release.latency');
        this.notifyCapacity();
    }

    rollbackReservation(reservation) {
        const { state, event, attemptKind } = reservation;
        state.activeCount = Math.max(0, state.activeCount - 1);
        state.requestEvents = state.requestEvents.filter(candidate => candidate.id !== event.id);
        if (attemptKind === 'retry') {
            state.dailyRetryCount = Math.max(0, state.dailyRetryCount - 1);
        } else {
            state.dailyNormalCount = Math.max(0, state.dailyNormalCount - 1);
        }
        reservation.released = true;
        this.notifyCapacity();
    }

    snapshot() {
        const projects = this.ensureStates();
        const now = this.clock();
        return projects.map(project => {
            const state = this.states.get(project.id);
            this.prune(state, now);
            const groupIndex = this.groupIndexForProject(projects, project.id);
            return {
                keyIndex: project.index,
                groupIndex,
                groupStatus: groupIndex === this.currentGroupIndex ? 'active' : 'standby',
                disabled: state.disabled,
                cooldownUntil: state.cooldownUntil || null,
                rpm: state.requestEvents.length,
                rollingInputTokens: state.requestEvents.reduce((sum, event) => sum + event.count, 0),
                normalRpd: state.dailyNormalCount,
                retryRpd: state.dailyRetryCount,
                totalRpd: state.dailyNormalCount + state.dailyRetryCount,
                activeCount: state.activeCount,
            };
        });
    }

    publicStatus() {
        const projects = this.ensureStates();
        const now = this.clock();
        return projects.map(project => {
            const state = this.states.get(project.id);
            this.prune(state, now);
            const groupIndex = this.groupIndexForProject(projects, project.id);
            const dailyTotal = state.dailyNormalCount + state.dailyRetryCount;
            return {
                index: project.index + 1,
                group: groupIndex == null ? null : groupIndex + 1,
                status: state.disabled
                    ? 'disabled'
                    : state.cooldownUntil > now
                        ? 'cooldown'
                        : dailyTotal >= this.limits.totalRpd
                            ? 'quota_exhausted'
                            : groupIndex === this.currentGroupIndex
                                ? 'active'
                                : 'standby',
                credentialStatus: state.hasSucceeded ? 'validated' : 'untested',
                cooldownUntil: state.cooldownUntil > now
                    ? new Date(state.cooldownUntil).toISOString()
                    : null,
            };
        });
    }

    quotaAggregate() {
        const rows = this.snapshot();
        return {
            activeProjectLimit: this.projectsInGroup(this.ensureStates()).length,
            eligibleProjectLimit: Math.min(this.eligibleProjectLimit, rows.length),
            projectGroupSize: Math.min(this.projectGroupSize, rows.length),
            groupCount: this.groupCount(),
            currentGroup: this.groupCount() ? this.currentGroupIndex + 1 : null,
            groupRotationEnabled: this.groupRotationEnabled,
            configuredProjects: rows.length,
            rollingRequests: rows.reduce((sum, row) => sum + row.rpm, 0),
            rollingInputTokens: rows.reduce((sum, row) => sum + row.rollingInputTokens, 0),
            normalDailyRequests: rows.reduce((sum, row) => sum + row.normalRpd, 0),
            retryDailyRequests: rows.reduce((sum, row) => sum + row.retryRpd, 0),
            inFlightRequests: rows.reduce((sum, row) => sum + row.activeCount, 0),
            limitsPerProject: { ...this.limits },
        };
    }

    groupUtilizationSnapshot() {
        const projects = this.ensureStates();
        const rows = this.snapshot();
        const count = this.groupCount(projects);
        return Array.from({ length: count }, (_, groupIndex) => {
            const groupRows = rows.filter(row => row.groupIndex === groupIndex);
            const dailyRequests = groupRows.reduce((sum, row) => sum + row.totalRpd, 0);
            const dailyCapacity = groupRows.length * this.limits.totalRpd;
            return {
                group: groupIndex + 1,
                status: groupIndex === this.currentGroupIndex ? 'active' : 'standby',
                projectCount: groupRows.length,
                rollingRequests: groupRows.reduce((sum, row) => sum + row.rpm, 0),
                rollingInputTokens: groupRows.reduce(
                    (sum, row) => sum + row.rollingInputTokens,
                    0
                ),
                dailyRequests,
                dailyCapacity,
                utilization: dailyCapacity > 0 ? dailyRequests / dailyCapacity : 0,
                inFlightRequests: groupRows.reduce((sum, row) => sum + row.activeCount, 0),
                disabledProjects: groupRows.filter(row => row.disabled).length,
            };
        });
    }

    metricsSnapshot() {
        const logicalIssued = this.metrics.logicalIssuedRequests;
        return {
            ...this.metrics,
            amplificationRatio: logicalIssued ? this.metrics.physicalAttempts / logicalIssued : 0,
            activeProjectLimit: this.projectsInGroup(this.ensureStates()).length,
            eligibleProjectLimit: Math.min(
                this.eligibleProjectLimit,
                this.resolveProjects().length
            ),
            projectGroupSize: Math.min(
                this.projectGroupSize,
                this.resolveProjects().length
            ),
            groupCount: this.groupCount(),
            currentGroup: this.groupCount() ? this.currentGroupIndex + 1 : null,
            lastRotatedAt: this.lastRotatedAt ? new Date(this.lastRotatedAt) : null,
            rotationReason: this.rotationReason,
            groupRotationEnabled: this.groupRotationEnabled,
            configuredProjects: this.resolveProjects().length,
            limits: { ...this.limits },
            groupUtilization: this.groupUtilizationSnapshot(),
            nextAvailableAt: this.globalGateUntil > this.clock()
                ? new Date(this.globalGateUntil)
                : null,
        };
    }

    availabilitySnapshot() {
        const now = this.clock();
        const projects = this.ensureStates();
        const capacityProjects = this.capacityScope(projects);
        const anyCapacity = this.hasAnyCapacity(capacityProjects, 10_000, 'normal');
        const nextCapacityAt = this.earliestRetryAt(
            capacityProjects,
            new Set(),
            10_000,
            'normal'
        );
        const currentGroupCapacity = this.projectsInGroup(projects).some(project => (
            this.projectCapacity(
                this.states.get(project.id),
                10_000,
                'normal',
                now
            ).available
        ));
        return {
            gated: this.globalGateUntil > now,
            nextAvailableAt: this.globalGateUntil > now
                ? new Date(this.globalGateUntil)
                : Number.isFinite(nextCapacityAt) && nextCapacityAt > now
                    ? new Date(nextCapacityAt)
                    : null,
            anyCapacity,
            currentGroupCapacity,
            currentGroup: this.groupCount() ? this.currentGroupIndex + 1 : null,
            groupCount: this.groupCount(),
            rotationReason: this.rotationReason,
        };
    }

    openGlobalGate(retryMs, now = this.clock()) {
        const delay = Number.isFinite(retryMs) && retryMs > 0 ? retryMs : 60_000;
        this.globalGateUntil = Math.max(this.globalGateUntil, now + delay);
        return delay;
    }

    clearGlobalGate(reason = 'capacity_available') {
        const wasGated = this.globalGateUntil > this.clock();
        this.globalGateUntil = 0;
        if (wasGated) {
            operationalMetrics.increment('gemini.global_gate_recoveries');
            this.rotationReason = reason;
        }
        this.notifyCapacity();
        return wasGated;
    }

    clearStaleGate({ estimatedInputTokens = 10_000, attemptKind = 'normal' } = {}) {
        const projects = this.ensureStates();
        if (!this.hasAnyCapacity(
            this.capacityScope(projects),
            estimatedInputTokens,
            attemptKind
        )) return false;
        return this.clearGlobalGate('watchdog_capacity');
    }

    async recoverWorkingGroup({
        estimatedInputTokens = 10_000,
        attemptKind = 'normal',
    } = {}) {
        await this.hydrate();
        const projects = this.ensureStates();
        const count = this.groupCount(projects);
        if (!this.groupRotationEnabled || count <= 1) return false;
        const now = this.clock();
        const currentHasCapacity = this.projectsInGroup(projects).some(project => (
            this.projectCapacity(
                this.states.get(project.id),
                estimatedInputTokens,
                attemptKind,
                now
            ).available
        ));
        if (currentHasCapacity) return false;
        for (let offset = 1; offset < count; offset += 1) {
            const groupIndex = (this.currentGroupIndex + offset) % count;
            const hasCapacity = this.projectsInGroup(projects, groupIndex).some(project => (
                this.projectCapacity(
                    this.states.get(project.id),
                    estimatedInputTokens,
                    attemptKind,
                    now
                ).available
            ));
            if (hasCapacity) return this.rotateTo(groupIndex, 'watchdog_capacity', projects);
        }
        return false;
    }

    async execute(requestFactory, options = {}) {
        this.metrics.logicalRequests += 1;
        this.metrics.activeLogicalRequests += 1;
        try {
            return await this.executeLogical(requestFactory, options);
        } finally {
            this.metrics.activeLogicalRequests = Math.max(
                0,
                this.metrics.activeLogicalRequests - 1
            );
        }
    }

    async executeLogical(requestFactory, options = {}) {
        const {
            estimatedInputTokens = 10_000,
            signal,
            onEvent = () => {},
            attemptKind = 'normal',
            maxPhysicalAttempts = this.maxPhysicalAttempts,
            admitPhysical = task => task(),
            deferPhysicalStart = false,
            jobId = null,
        } = options;
        if (jobId && this.suspendedJobs.has(jobId)) throw schedulerSuspensionError();
        await this.hydrate();
        const projects = this.ensureStates();
        const eligibleProjects = this.eligibleProjects(projects);
        const capacityProjects = this.capacityScope(projects);
        if (!eligibleProjects.length) {
            throw new ProcessingError(
                ErrorCodes.GEMINI_CONFIG,
                'Không có Gemini project hợp lệ.',
                { publicMessage: 'Server chưa được cấu hình Gemini project.' }
            );
        }

        const excluded = new Set();
        const errors = [];
        let physicalAttempts = 0;
        let logicalIssued = false;
        let deferredRecorded = false;

        const recordDeferredBeforeIssue = () => {
            if (logicalIssued || deferredRecorded) return;
            deferredRecorded = true;
            this.metrics.deferredBeforeIssue += 1;
            operationalMetrics.increment('gemini.logical_stages.deferred_before_issue');
        };

        const throwCapacityError = async (kind, {
            projectsToInspect = capacityProjects,
            excludedProjects = new Set(),
            message = 'Không Gemini project nào có quota khả dụng.',
        } = {}) => {
            const now = this.clock();
            const hasCapacity = this.hasAnyCapacity(
                capacityProjects,
                estimatedInputTokens,
                kind,
                excludedProjects
            );
            if (hasCapacity) {
                this.clearGlobalGate('capacity_available');
                return false;
            }
            const retryAt = this.earliestRetryAt(
                projectsToInspect,
                excludedProjects,
                estimatedInputTokens,
                kind
            );
            const waitMs = Number.isFinite(retryAt) ? Math.max(1, retryAt - now) : 1000;
            if (excludedProjects.size === 0 && waitMs <= this.maxInlineWaitMs) {
                await this.waitForCapacity(waitMs, signal);
                return true;
            }

            const poolExhausted = !this.hasAnyCapacity(
                capacityProjects,
                estimatedInputTokens,
                kind
            );
            if (poolExhausted) this.openGlobalGate(waitMs, now);
            recordDeferredBeforeIssue();
            const reasonRows = capacityProjects.map(project => (
                this.projectCapacity(
                    this.states.get(project.id),
                    estimatedInputTokens,
                    kind,
                    now
                ).reason
            ));
            const deferredReason = reasonRows.every(reason => reason === 'rpd')
                ? 'rpd'
                : reasonRows.every(reason => reason === 'disabled')
                    ? 'disabled'
                    : reasonRows.includes('cooldown')
                        ? 'cooldown'
                        : 'quota';
            throw rateLimitError(message, waitMs, now, { poolExhausted, deferredReason });
        };

        while (physicalAttempts < maxPhysicalAttempts) {
            if (signal?.aborted) throw cancellationError();
            if (jobId && this.suspendedJobs.has(jobId)) throw schedulerSuspensionError();
            const gateWaitMs = this.globalGateUntil - this.clock();
            if (gateWaitMs > 0) {
                if (this.hasAnyCapacity(
                    capacityProjects,
                    estimatedInputTokens,
                    attemptKind
                )) {
                    this.clearGlobalGate('capacity_available');
                } else {
                    if (gateWaitMs <= this.maxInlineWaitMs) {
                        await this.waitForCapacity(gateWaitMs, signal);
                        continue;
                    }
                    recordDeferredBeforeIssue();
                    throw rateLimitError(
                        'Gemini project pool đang tạm đóng quota gate.',
                        gateWaitMs,
                        this.clock(),
                        { poolExhausted: true, deferredReason: 'quota' }
                    );
                }
            }

            const kind = physicalAttempts === 0 ? attemptKind : 'retry';
            let reservation = null;
            let project = null;
            let state = null;
            let physicalStarted = false;

            try {
                const admittedResult = await admitPhysical(async () => {
                    if (signal?.aborted) throw cancellationError();
                    if (jobId && this.suspendedJobs.has(jobId)) {
                        throw schedulerSuspensionError();
                    }
                    reservation = await this.reserve(
                        projects,
                        excluded,
                        estimatedInputTokens,
                        kind
                    );
                    if (!reservation) throw noProjectCapacityError();

                    ({ project, state } = reservation);
                    excluded.add(project.id);
                    await this.persist(state, 'mongodb.quota_reserve.latency');
                    if (signal?.aborted) {
                        this.rollbackReservation(reservation);
                        await this.persist(state, 'mongodb.quota_reservation_rollback.latency');
                        throw cancellationError();
                    }
                    if (jobId && this.suspendedJobs.has(jobId)) {
                        this.rollbackReservation(reservation);
                        await this.persist(state, 'mongodb.quota_reservation_rollback.latency');
                        throw schedulerSuspensionError();
                    }

                    const markPhysicalStart = () => {
                        if (physicalStarted) return;
                        physicalStarted = true;
                        physicalAttempts += 1;
                        this.metrics.physicalAttempts += 1;
                        if (!logicalIssued) {
                            logicalIssued = true;
                            this.metrics.logicalIssuedRequests += 1;
                        }
                        onEvent({
                            type: 'reserved',
                            keyIndex: project.index,
                            physicalAttempt: physicalAttempts,
                            attemptKind: reservation.attemptKind,
                            groupIndex: this.currentGroupIndex,
                        });
                    };
                    if (!deferPhysicalStart) markPhysicalStart();
                    const result = await requestFactory({
                        apiKey: project.apiKey,
                        keyIndex: project.index,
                        projectIndex: project.index,
                        markPhysicalStart,
                    });
                    if (!physicalStarted) markPhysicalStart();
                    return result;
                });

                await this.release(reservation, {
                    success: true,
                    actualInputTokens: admittedResult?.metadata?.usage?.promptTokenCount,
                });
                this.clearGlobalGate('request_succeeded');
                onEvent({
                    type: 'succeeded',
                    keyIndex: project.index,
                    physicalAttempt: physicalAttempts,
                    usage: admittedResult?.metadata?.usage || null,
                });
                return {
                    ...admittedResult,
                    metadata: {
                        ...(admittedResult?.metadata || {}),
                        scheduler: {
                            projectIndex: project.index,
                            physicalAttempts,
                            issuedAt: new Date(this.clock()),
                            groupIndex: this.currentGroupIndex,
                        },
                    },
                };
            } catch (error) {
                if (error?.noProjectCapacity) {
                    const allDisabled = capacityProjects.every(
                        candidate => this.states.get(candidate.id)?.disabled
                    );
                    if (allDisabled) {
                        throw new ProcessingError(
                            ErrorCodes.GEMINI_AUTH,
                            'Toàn bộ Gemini project eligible đã bị disable.',
                            { publicMessage: 'Gemini API key không hợp lệ.' }
                        );
                    }
                    const hasUntriedCapacity = this.hasAnyCapacity(
                        capacityProjects,
                        estimatedInputTokens,
                        kind,
                        excluded
                    );
                    if (errors.length > 0 && !hasUntriedCapacity) break;
                    await throwCapacityError(kind, { excludedProjects: excluded });
                    continue;
                }
                if (!reservation) {
                    if (error?.code === ErrorCodes.SCHEDULER_SUSPENDED) throw error;
                    if (signal?.aborted
                        || error?.code === ErrorCodes.CANCELLED
                        || error?.name === 'AbortError') {
                        throw cancellationError();
                    }
                    throw error;
                }
                if (error?.code === ErrorCodes.DATABASE_UNAVAILABLE) {
                    if (!reservation.released) this.rollbackReservation(reservation);
                    throw error;
                }
                if (error?.code === ErrorCodes.SCHEDULER_SUSPENDED) {
                    if (!physicalStarted) {
                        if (!reservation.released) this.rollbackReservation(reservation);
                        await this.persist(state, 'mongodb.quota_reservation_rollback.latency');
                    } else if (!reservation.released) {
                        await this.release(reservation);
                    }
                    throw error;
                }
                if (signal?.aborted || error?.code === ErrorCodes.CANCELLED || error?.name === 'AbortError') {
                    if (!physicalStarted) {
                        if (!reservation.released) this.rollbackReservation(reservation);
                        await this.persist(state, 'mongodb.quota_reservation_rollback.latency');
                    } else if (!reservation.released) {
                        await this.release(reservation);
                    }
                    throw cancellationError();
                }

                const status = statusOf(error);
                if (status === 400 || status === 404 || error?.code === ErrorCodes.GEMINI_CONFIG) {
                    await this.release(reservation);
                    throw error;
                }
                if (status === 401 || status === 403) {
                    await this.release(reservation, { disabled: true });
                    errors.push({ scope: 'auth', error });
                    onEvent({
                        type: 'disabled',
                        keyIndex: project.index,
                        status,
                        groupIndex: this.currentGroupIndex,
                    });
                    continue;
                }
                if (status === 429) {
                    const waitMs = retryAfterMs(error, this.clock()) ?? 60_000;
                    this.metrics.rateLimitResponses += 1;
                    await this.release(reservation, { cooldownUntil: this.clock() + waitMs });
                    errors.push({ scope: 'quota', error });
                    onEvent({
                        type: 'cooldown',
                        keyIndex: project.index,
                        status,
                        retryAfterMs: waitMs,
                        groupIndex: this.currentGroupIndex,
                    });
                    continue;
                }

                if (CONTENT_RESPONSE_ERROR_CODES.has(error?.code)) {
                    this.metrics.contentFailures += 1;
                    await this.release(reservation);
                    errors.push({ scope: 'content', error });
                    onEvent({
                        type: 'content_retry',
                        keyIndex: project.index,
                        code: error.code,
                        physicalAttempt: physicalAttempts,
                    });
                    continue;
                }

                const isServiceFailure = status == null
                    || SERVICE_STATUSES.has(status)
                    || error?.retryable;
                if (!isServiceFailure) {
                    await this.release(reservation);
                    throw error;
                }

                this.metrics.serviceFailures += 1;
                await this.release(reservation);
                errors.push({ scope: 'service', error });
                const backoffMs = (2 ** (physicalAttempts - 1)) * 1000
                    + Math.floor(this.random() * 250);
                onEvent({
                    type: 'service_retry',
                    keyIndex: project.index,
                    status,
                    retryAfterMs: backoffMs,
                    physicalAttempt: physicalAttempts,
                });
                if (physicalAttempts < maxPhysicalAttempts) await this.sleep(backoffMs, signal);
            }
        }

        const contentFailure = [...errors].reverse().find(item => item.scope === 'content');
        if (contentFailure) throw contentFailure.error;
        const serviceFailure = [...errors].reverse().find(item => item.scope === 'service');
        if (serviceFailure) {
            throw new ProcessingError(
                ErrorCodes.GEMINI_UNAVAILABLE,
                serviceFailure.error?.message || 'Gemini tạm thời không khả dụng.',
                { retryable: true, publicMessage: 'Gemini tạm thời không khả dụng, hệ thống sẽ thử lại.' }
            );
        }
        if (errors.length > 0 && errors.every(item => item.scope === 'auth')) {
            throw new ProcessingError(
                ErrorCodes.GEMINI_AUTH,
                'Các Gemini project được thử đều bị từ chối.',
                { publicMessage: 'Gemini API key không hợp lệ.' }
            );
        }

        const now = this.clock();
        const attemptedProjects = eligibleProjects.filter(project => excluded.has(project.id));
        const retryAt = this.earliestRetryAt(
            attemptedProjects.length > 0 ? attemptedProjects : eligibleProjects,
            new Set(),
            estimatedInputTokens,
            'retry'
        );
        const waitMs = Number.isFinite(retryAt) ? Math.max(1, retryAt - now) : 60_000;
        const poolExhausted = !this.hasAnyCapacity(
            capacityProjects,
            estimatedInputTokens,
            'retry'
        );
        if (poolExhausted) this.openGlobalGate(waitMs, now);
        recordDeferredBeforeIssue();
        throw rateLimitError(
            'Các Gemini project được thử đều đang chờ quota.',
            waitMs,
            now,
            { poolExhausted, deferredReason: 'cooldown' }
        );
    }
}
