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
    queue.consecutiveFailures = 2;
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
    assert.equal(queue.consecutiveFailures, 0);

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
    assert.equal(queue.consecutiveFailures, 1);
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
