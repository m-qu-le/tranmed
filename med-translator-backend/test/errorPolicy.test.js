import assert from 'node:assert/strict';
import test from 'node:test';
import Job from '../src/models/jobModel.js';
import TranslationChunk from '../src/models/translationChunkModel.js';
import { QueueManager } from '../src/services/queueManager.js';
import { ErrorCodes, ProcessingError } from '../src/utils/processingError.js';

test('error policy retries quota errors but permanently fails invalid PDFs', async (context) => {
    const originalUpdateOne = Job.updateOne;
    const originalExists = Job.exists;
    const originalDeleteMany = TranslationChunk.deleteMany;
    const updates = [];

    Job.updateOne = async (filter, update) => {
        updates.push({ filter, update });
        return { matchedCount: 1 };
    };
    Job.exists = async () => null;
    TranslationChunk.deleteMany = async () => ({ deletedCount: 0 });
    context.after(() => {
        Job.updateOne = originalUpdateOne;
        Job.exists = originalExists;
        TranslationChunk.deleteMany = originalDeleteMany;
    });

    const queue = new QueueManager();
    queue.safeUnlink = async () => {};
    const hibernationCalls = [];
    queue.triggerHibernation = async retryAfterMs => {
        hibernationCalls.push(retryAfterMs);
        queue.isHibernating = true;
    };
    const job = {
        jobId: 'job-policy',
        filePath: 'fixture.pdf',
        processingToken: 'token',
        attemptCount: 1,
        maxAttempts: 3
    };

    await queue.handleProcessingFailure(
        job,
        new ProcessingError(ErrorCodes.INVALID_PDF, 'broken', { publicMessage: 'PDF hỏng' })
    );
    assert.equal(updates.at(-1).update.$set.status, 'failed');
    assert.deepEqual(hibernationCalls, []);

    await queue.handleProcessingFailure(
        job,
        new ProcessingError(ErrorCodes.GEMINI_RATE_LIMIT, 'quota', {
            retryable: true,
            quotaRelated: true,
            publicMessage: 'Hết quota'
        })
    );
    assert.equal(updates.at(-1).update.$set.status, 'pending');
    assert.equal(updates.at(-1).update.$set.errorCode, ErrorCodes.GEMINI_RATE_LIMIT);
    assert.deepEqual(hibernationCalls, []);

    const poolError = new ProcessingError(ErrorCodes.GEMINI_RATE_LIMIT, 'all keys cooling down', {
        retryable: true,
        quotaRelated: true,
        poolExhausted: true,
        publicMessage: 'Toàn bộ Gemini key đang chờ quota.'
    });
    poolError.retryAfterMs = 60_000;
    await queue.handleProcessingFailure(job, poolError);
    assert.equal(hibernationCalls.length, 1);
    assert.ok(hibernationCalls[0] >= 5 * 60 * 1000);
    assert.equal(updates.at(-1).update.$inc.retryCount, 1);
    assert.equal(updates.at(-1).update.$inc.quotaRetryCount, 1);
    assert.equal(updates.at(-1).update.$set.status, 'pending');
});

test('pool exhaustion keeps retrying within the forty-eight-hour recovery window', async context => {
    const originalUpdateOne = Job.updateOne;
    const originalExists = Job.exists;
    const originalDeleteMany = TranslationChunk.deleteMany;
    const updates = [];
    Job.updateOne = async (filter, update) => {
        updates.push({ filter, update });
        return { matchedCount: 1 };
    };
    Job.exists = async () => null;
    TranslationChunk.deleteMany = async () => ({ deletedCount: 0 });
    context.after(() => {
        Job.updateOne = originalUpdateOne;
        Job.exists = originalExists;
        TranslationChunk.deleteMany = originalDeleteMany;
    });

    const queue = new QueueManager();
    queue.safeUnlink = async () => {};
    queue.triggerHibernation = async () => {};
    const poolError = new ProcessingError(ErrorCodes.GEMINI_RATE_LIMIT, 'all keys cooling down', {
        retryable: true,
        quotaRelated: true,
        poolExhausted: true,
    });
    poolError.retryAfterMs = 60_000;

    await queue.handleProcessingFailure({
        jobId: 'quota-15', filePath: 'fixture.pdf', processingToken: 'token',
        attemptCount: 3, maxAttempts: 3, quotaRetryCount: 14,
    }, poolError);
    assert.equal(updates.at(-1).update.$set.status, 'pending');
    assert.deepEqual(updates.at(-1).update.$inc, { retryCount: 1, quotaRetryCount: 1 });

    await queue.handleProcessingFailure({
        jobId: 'quota-16', filePath: 'fixture.pdf', processingToken: 'token',
        attemptCount: 3, maxAttempts: 3, quotaRetryCount: 15,
    }, poolError);
    assert.equal(updates.at(-1).update.$set.status, 'pending');
    assert.deepEqual(updates.at(-1).update.$inc, { retryCount: 1, quotaRetryCount: 1 });
});

test('content errors stop after seven processing attempts and retain the R2 source', async context => {
    const originalUpdateOne = Job.updateOne;
    const originalExists = Job.exists;
    const updates = [];
    Job.updateOne = async (filter, update) => { updates.push({ filter, update }); return { matchedCount: 1 }; };
    Job.exists = async () => null;
    context.after(() => { Job.updateOne = originalUpdateOne; Job.exists = originalExists; });

    const queue = new QueueManager();
    await queue.handleProcessingFailure({
        jobId: 'schema-seven', processingToken: 'token', attemptCount: 6, maxAttempts: 3,
        storageProvider: 'r2', sourceState: 'ready', storageKey: 'incoming/schema.pdf',
    }, new ProcessingError(ErrorCodes.GEMINI_SCHEMA_INVALID, 'invalid', { retryable: true }));
    assert.equal(updates.at(-1).update.$set.status, 'pending');
    assert.equal(updates.at(-1).update.$set.failureCategory, 'content');

    await queue.handleProcessingFailure({
        jobId: 'schema-terminal', processingToken: 'token', attemptCount: 7, maxAttempts: 3,
        storageProvider: 'r2', sourceState: 'ready', storageKey: 'incoming/schema-terminal.pdf',
    }, new ProcessingError(ErrorCodes.GEMINI_SCHEMA_INVALID, 'invalid', { retryable: true }));
    assert.equal(updates.at(-1).update.$set.status, 'failed');
    assert.equal(updates.at(-1).update.$set.failureCategory, 'content');
    assert.ok(updates.at(-1).update.$set.sourceRetentionUntil instanceof Date);
});

test('manual retry only requeues terminal jobs whose R2 source is still ready', async context => {
    const originalFind = Job.find;
    const originalUpdateOne = Job.updateOne;
    const updates = [];
    Job.find = () => ({ lean: async () => [
        { jobId: 'retryable', errorCode: ErrorCodes.GEMINI_SCHEMA_INVALID, storageProvider: 'r2', storageKey: 'incoming/ready.pdf', sourceState: 'ready' },
        { jobId: 'gone', errorCode: ErrorCodes.GEMINI_RATE_LIMIT, storageProvider: 'r2', storageKey: 'incoming/gone.pdf', sourceState: 'deleted' },
        { jobId: 'bad-pdf', errorCode: ErrorCodes.INVALID_PDF, storageProvider: 'r2', storageKey: 'incoming/bad.pdf', sourceState: 'ready' },
    ] });
    Job.updateOne = async (filter, update) => { updates.push({ filter, update }); return { modifiedCount: 1 }; };
    context.after(() => { Job.find = originalFind; Job.updateOne = originalUpdateOne; });
    const queue = new QueueManager();
    queue.startWorker = async () => {};
    const result = await queue.retryTerminalFailures();
    assert.deepEqual(result, { retried: 1, skipped: 2 });
    assert.equal(updates[0].filter.jobId, 'retryable');
    assert.equal(updates[0].update.$set.attemptCount, 0);
});

test('FILE_MISSING preserves translated chunks so a re-upload can resume', async (context) => {
    const originalUpdateOne = Job.updateOne;
    const originalExists = Job.exists;
    const originalDeleteMany = TranslationChunk.deleteMany;
    let deletedChunks = false;

    Job.updateOne = async () => ({ matchedCount: 1 });
    Job.exists = async () => null;
    TranslationChunk.deleteMany = async () => {
        deletedChunks = true;
        return { deletedCount: 0 };
    };
    context.after(() => {
        Job.updateOne = originalUpdateOne;
        Job.exists = originalExists;
        TranslationChunk.deleteMany = originalDeleteMany;
    });

    const queue = new QueueManager();
    queue.safeUnlink = async () => {};
    await queue.handleProcessingFailure(
        {
            jobId: 'resume-job',
            filePath: 'missing.pdf',
            processingToken: 'token',
            attemptCount: 1,
            maxAttempts: 3
        },
        new ProcessingError(ErrorCodes.FILE_MISSING, 'missing')
    );

    assert.equal(deletedChunks, false);
});
