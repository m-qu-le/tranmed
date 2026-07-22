import assert from 'node:assert/strict';
import test from 'node:test';
import System from '../src/models/systemModel.js';
import { PARALLEL_SOURCE_BUDGET_BYTES } from '../src/config/env.js';
import {
    CIRCUIT_BREAKER_WAKEUP_POLICY,
    QueueManager,
    nextCircuitBreakerWakeup,
} from '../src/services/queueManager.js';

const MiB = 1024 * 1024;
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

test('circuit breaker wakes at the next 15:00 in Vietnam instead of after four hours', () => {
    assert.equal(CIRCUIT_BREAKER_WAKEUP_POLICY, 'daily_15_asia_ho_chi_minh');
    assert.equal(
        nextCircuitBreakerWakeup(new Date('2026-07-18T07:59:59.000Z')).toISOString(),
        '2026-07-18T08:00:00.000Z'
    );
    assert.equal(
        nextCircuitBreakerWakeup(new Date('2026-07-18T08:00:00.000Z')).toISOString(),
        '2026-07-19T08:00:00.000Z'
    );
    assert.equal(
        nextCircuitBreakerWakeup(new Date('2026-12-31T09:00:00.000Z')).toISOString(),
        '2027-01-01T08:00:00.000Z'
    );
});

test('admission allows the 100 MiB budget but blocks the 101 MiB FIFO head and unknown-size jobs', async () => {
    const queue = new QueueManager({ concurrency: 5 });
    queue.activeJobs.set('active', { sourceSize: 80 * MiB });
    queue.activeSourceBytes = 80 * MiB;
    let claims = 0;
    queue.peekNextJob = async () => ({ _id: 'fits-exactly', sourceSize: 20 * MiB });
    queue.claimNextJob = async id => {
        claims += 1;
        return { jobId: String(id), sourceSize: 20 * MiB };
    };

    assert.equal((await queue.claimAdmissibleJob()).jobId, 'fits-exactly');
    assert.equal(claims, 1);

    queue.activeSourceBytes = 100 * MiB;
    queue.peekNextJob = async () => ({ _id: 'fifo-head', sourceSize: MiB });
    assert.equal(await queue.claimAdmissibleJob(), null);
    assert.equal(claims, 1, 'the FIFO head must not be claimed or skipped when it does not fit');

    queue.activeJobs.set('active', { sourceSize: null });
    let peeked = false;
    queue.peekNextJob = async () => { peeked = true; return { _id: 'behind-unknown', sourceSize: MiB }; };
    assert.equal(await queue.claimAdmissibleJob(), null);
    assert.equal(peeked, false, 'an unknown-size active job must run alone');
    assert.equal(PARALLEL_SOURCE_BUDGET_BYTES, 100 * MiB);
});

test('worker pool activates five valid-source jobs without claiming a sixth over budget job', async () => {
    const queue = new QueueManager({ concurrency: 5 });
    const gates = Array.from({ length: 5 }, deferred);
    const jobs = Array.from({ length: 6 }, (_, index) => ({
        _id: `job-${index + 1}`,
        jobId: `job-${index + 1}`,
        sourceSize: 20 * MiB,
        processingToken: `token-${index + 1}`,
        attemptCount: 1,
        maxAttempts: 3,
    }));
    const claimedIds = [];
    queue.recoverExpiredLeases = async () => 0;
    queue.scheduleNextRetry = async () => {};
    queue.createLeaseHeartbeat = () => null;
    queue.peekNextJob = async () => jobs[0] || null;
    queue.claimNextJob = async candidateId => {
        const index = candidateId
            ? jobs.findIndex(job => job._id === candidateId)
            : 0;
        const job = index < 0 ? null : jobs.splice(index, 1)[0];
        if (job) claimedIds.push(job.jobId);
        return job;
    };
    queue.processClaimedJob = async job => gates[Number(job.jobId.slice(-1)) - 1].promise;

    await queue.startWorker();

    assert.equal(queue.activeJobs.size, 5);
    assert.equal(queue.activeSourceBytes, 100 * MiB);
    assert.deepEqual(claimedIds, ['job-1', 'job-2', 'job-3', 'job-4', 'job-5']);
    assert.equal(jobs[0].jobId, 'job-6');

    queue.isMaintenancePaused = true;
    gates.forEach(gate => gate.resolve());
    await new Promise(resolve => setImmediate(resolve));
});

test('an empty lane claims a large or unknown-size FIFO head to run alone', async () => {
    const queue = new QueueManager({ concurrency: 2 });
    const large = { jobId: 'large', sourceSize: 30 * MiB };
    queue.claimNextJob = async () => large;
    assert.equal(await queue.claimAdmissibleJob(), large);
});

test('twenty concurrent pump calls never exceed two active jobs or duplicate a claim', async () => {
    const queue = new QueueManager({ concurrency: 2 });
    const gates = [deferred(), deferred()];
    const jobs = [
        { jobId: 'job-a', sourceSize: 3 * MiB, processingToken: 'token-a', attemptCount: 1, maxAttempts: 3 },
        { jobId: 'job-b', sourceSize: 4 * MiB, processingToken: 'token-b', attemptCount: 1, maxAttempts: 3 },
    ];
    const claimedIds = [];
    let peakActive = 0;
    queue.recoverExpiredLeases = async () => 0;
    queue.scheduleNextRetry = async () => {};
    queue.createLeaseHeartbeat = () => null;
    queue.claimAdmissibleJob = async () => {
        const job = jobs.shift() || null;
        if (job) claimedIds.push(job.jobId);
        return job;
    };
    queue.processClaimedJob = async job => {
        peakActive = Math.max(peakActive, queue.activeJobs.size);
        await gates[job.jobId === 'job-a' ? 0 : 1].promise;
    };

    await Promise.all(Array.from({ length: 20 }, () => queue.startWorker()));
    assert.equal(queue.activeJobs.size, 2);
    assert.equal(queue.activeSourceBytes, 7 * MiB);
    assert.equal(peakActive, 2);
    assert.deepEqual(claimedIds, ['job-a', 'job-b']);

    gates[0].resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(queue.activeJobs.size, 1);
    gates[1].resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(queue.activeJobs.size, 0);
    assert.equal(queue.activeSourceBytes, 0);
});

test('concurrency one keeps the legacy single active-job ceiling', async () => {
    const queue = new QueueManager({ concurrency: 1 });
    const gates = [deferred(), deferred()];
    const jobs = [
        { jobId: 'single-a', sourceSize: MiB, processingToken: 'token-a', attemptCount: 1, maxAttempts: 3 },
        { jobId: 'single-b', sourceSize: MiB, processingToken: 'token-b', attemptCount: 1, maxAttempts: 3 },
    ];
    let peakActive = 0;
    queue.recoverExpiredLeases = async () => 0;
    queue.scheduleNextRetry = async () => {};
    queue.createLeaseHeartbeat = () => null;
    queue.claimAdmissibleJob = async () => jobs.shift() || null;
    queue.processClaimedJob = async job => {
        peakActive = Math.max(peakActive, queue.activeJobs.size);
        await gates[job.jobId === 'single-a' ? 0 : 1].promise;
    };

    await queue.startWorker();
    assert.equal(queue.activeJobs.size, 1);
    gates[0].resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(queue.activeJobs.size, 1);
    assert.equal(peakActive, 1);
    gates[1].resolve();
    await new Promise(resolve => setImmediate(resolve));
});

test('hibernation blocks refill while allowing in-flight work to finish', async () => {
    const queue = new QueueManager({ concurrency: 2 });
    const gate = deferred();
    let claims = 0;
    queue.recoverExpiredLeases = async () => 0;
    queue.scheduleNextRetry = async () => {};
    queue.createLeaseHeartbeat = () => null;
    queue.claimAdmissibleJob = async () => {
        claims += 1;
        return claims === 1
            ? { jobId: 'in-flight', sourceSize: MiB, processingToken: 'token', attemptCount: 1, maxAttempts: 3 }
            : null;
    };
    queue.processClaimedJob = async () => gate.promise;

    await queue.startWorker();
    assert.equal(queue.activeJobs.size, 1);
    queue.isHibernating = true;
    await queue.startWorker();
    assert.equal(claims, 2, 'the second claim is the initial attempt to fill lane two');

    gate.resolve();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(queue.activeJobs.size, 0);
    assert.equal(claims, 2, 'finishing in-flight work must not refill while hibernating');
});

test('redeploy pause stops refilling and is not carried into a new server instance', async () => {
    const queue = new QueueManager({ concurrency: 1 });
    const first = deferred();
    const second = deferred();
    const jobs = [
        { jobId: 'before-redeploy', sourceSize: MiB, processingToken: 'token-before', attemptCount: 1, maxAttempts: 3 },
        { jobId: 'after-redeploy', sourceSize: MiB, processingToken: 'token-after', attemptCount: 1, maxAttempts: 3 },
    ];
    let claims = 0;
    queue.recoverExpiredLeases = async () => 0;
    queue.scheduleNextRetry = async () => {};
    queue.createLeaseHeartbeat = () => null;
    queue.claimAdmissibleJob = async () => {
        claims += 1;
        return jobs.shift() || null;
    };
    queue.processClaimedJob = async job => {
        await (job.jobId === 'before-redeploy' ? first.promise : second.promise);
    };

    await queue.startWorker();
    assert.equal(queue.activeJobs.size, 1);
    const paused = queue.pauseForRedeploy();
    assert.equal(paused.isMaintenancePaused, true);
    assert.equal(new QueueManager().isMaintenancePaused, false);

    first.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(claims, 1, 'pause must not claim a replacement job');
    assert.equal(queue.activeJobs.size, 0);

    await queue.cancelRedeployPause();
    assert.equal(queue.activeJobs.size, 1, 'a running instance can cancel an accidental pause');
    second.resolve();
    await new Promise(resolve => setImmediate(resolve));
});

test('wake-up clears the pause and fills both configured lanes', async context => {
    const originalFindOneAndUpdate = System.findOneAndUpdate;
    System.findOneAndUpdate = async () => ({});
    context.after(() => { System.findOneAndUpdate = originalFindOneAndUpdate; });
    const queue = new QueueManager({ concurrency: 2 });
    const gates = [deferred(), deferred()];
    const jobs = [
        { jobId: 'wake-a', sourceSize: MiB, processingToken: 'wake-token-a', attemptCount: 1, maxAttempts: 3 },
        { jobId: 'wake-b', sourceSize: MiB, processingToken: 'wake-token-b', attemptCount: 1, maxAttempts: 3 },
    ];
    queue.isHibernating = true;
    queue.recoverExpiredLeases = async () => 0;
    queue.scheduleNextRetry = async () => {};
    queue.createLeaseHeartbeat = () => null;
    queue.claimAdmissibleJob = async () => jobs.shift() || null;
    queue.processClaimedJob = async job => gates[job.jobId === 'wake-a' ? 0 : 1].promise;

    await queue.wakeUp();

    assert.equal(queue.isHibernating, false);
    assert.equal(queue.activeJobs.size, 2);
    gates.forEach(gate => gate.resolve());
    await new Promise(resolve => setImmediate(resolve));
});

test('worker status exposes only aggregate pool observations', () => {
    const queue = new QueueManager({ concurrency: 2 });
    queue.activeJobs.set('private-job-id', { sourceSize: 3 * MiB });
    queue.activeSourceBytes = 3 * MiB;

    assert.deepEqual(queue.getSystemStatus().worker, {
        concurrency: 2,
        activeJobs: 1,
        activeSourceBytes: 3 * MiB,
        parallelSourceBudgetBytes: 100 * MiB,
    });
    assert.equal(JSON.stringify(queue.getSystemStatus()).includes('private-job-id'), false);
});
