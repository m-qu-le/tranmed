import assert from 'node:assert/strict';
import test from 'node:test';
import Job from '../src/models/jobModel.js';
import TranslationChunk from '../src/models/translationChunkModel.js';
import { QueueManager } from '../src/services/queueManager.js';
import {
    qualityGeminiLimiter,
    qualityKeyScheduler,
} from '../src/services/qualityGeminiExecutors.js';

test('watchdog never mutates queue state during maintenance', async () => {
    const originalExists = Job.exists;
    let queried = false;
    Job.exists = async () => {
        queried = true;
        return true;
    };
    try {
        const queue = new QueueManager();
        queue.isMaintenancePaused = true;
        assert.equal(await queue.runDeadTimeWatchdog(), false);
        assert.equal(queried, false);
    } finally {
        Job.exists = originalExists;
    }
});

test('watchdog rebuilds only deferred pending jobs after two idle minutes', async () => {
    const originals = {
        exists: Job.exists,
        jobUpdateMany: Job.updateMany,
        distinct: TranslationChunk.distinct,
        chunkUpdateMany: TranslationChunk.updateMany,
        recoverWorkingGroup: qualityKeyScheduler.recoverWorkingGroup,
        clearStaleGate: qualityKeyScheduler.clearStaleGate,
        availabilitySnapshot: qualityKeyScheduler.availabilitySnapshot,
        limiterSnapshot: qualityGeminiLimiter.snapshot,
    };
    let jobFilter = null;
    let chunkUpdateCalled = false;
    Job.exists = async () => ({ _id: 'backlog' });
    Job.updateMany = async (filter) => {
        jobFilter = filter;
        return { modifiedCount: 1 };
    };
    TranslationChunk.distinct = async () => ['deferred-job'];
    TranslationChunk.updateMany = async () => {
        chunkUpdateCalled = true;
        return { modifiedCount: 1 };
    };
    qualityKeyScheduler.recoverWorkingGroup = async () => true;
    qualityKeyScheduler.clearStaleGate = () => false;
    qualityKeyScheduler.availabilitySnapshot = () => ({
        anyCapacity: true,
        gated: false,
        nextAvailableAt: null,
    });
    qualityGeminiLimiter.snapshot = () => ({ activeCount: 0, waitingCount: 0 });
    try {
        const queue = new QueueManager();
        queue.lastStageActivityAt = Date.now() - 121_000;
        queue.watchdogState.idleSince = new Date(Date.now() - 121_000);
        queue.startWorker = async () => {};
        assert.equal(await queue.runDeadTimeWatchdog(), true);
        assert.equal(chunkUpdateCalled, true);
        assert.equal(jobFilter.status, 'pending');
        assert.equal(jobFilter.schedulerDeferred, true);
        assert.equal(jobFilter.jobId.$in[0], 'deferred-job');
        assert.equal(queue.watchdogState.recoveries, 1);
    } finally {
        Job.exists = originals.exists;
        Job.updateMany = originals.jobUpdateMany;
        TranslationChunk.distinct = originals.distinct;
        TranslationChunk.updateMany = originals.chunkUpdateMany;
        qualityKeyScheduler.recoverWorkingGroup = originals.recoverWorkingGroup;
        qualityKeyScheduler.clearStaleGate = originals.clearStaleGate;
        qualityKeyScheduler.availabilitySnapshot = originals.availabilitySnapshot;
        qualityGeminiLimiter.snapshot = originals.limiterSnapshot;
    }
});
