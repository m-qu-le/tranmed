import { redactSensitiveText } from '../utils/redactSecrets.js';

const BASE_RETRY_MS = 60_000;

function retryAt(attempt) {
    const delay = Math.min(6 * 60 * 60 * 1000, BASE_RETRY_MS * (2 ** Math.max(0, attempt - 1)));
    return new Date(Date.now() + delay);
}

export class SourceCleanupService {
    constructor({ Job, r2 }) {
        this.Job = Job;
        this.r2 = r2;
    }

    async cleanupSource(job, { reason = 'terminal' } = {}) {
        if (!job || job.storageProvider !== 'r2' || !job.storageKey) {
            return { cleaned: true, notRequired: true };
        }
        if (job.sourceState === 'deleted' || job.sourceCleanupState === 'succeeded') {
            return { cleaned: true, alreadyDeleted: true };
        }

        await this.Job.updateOne(
            { jobId: job.jobId, sourceState: { $ne: 'deleted' } },
            {
                $set: {
                    sourceState: 'delete_pending',
                    sourceCleanupState: 'pending',
                    sourceCleanupNextRetryAt: null,
                },
            }
        );

        try {
            await this.r2.deleteObject(job.storageKey);
            const deletedAt = new Date();
            await this.Job.updateOne(
                { jobId: job.jobId },
                {
                    $set: {
                        sourceState: 'deleted',
                        sourceDeletedAt: deletedAt,
                        sourceCleanupState: 'succeeded',
                        sourceCleanupNextRetryAt: null,
                        sourceCleanupLastError: null,
                    },
                }
            );
            return { cleaned: true, deletedAt, reason };
        } catch (error) {
            const attempt = (job.sourceCleanupAttempts || 0) + 1;
            const nextRetryAt = retryAt(attempt);
            await this.Job.updateOne(
                { jobId: job.jobId },
                {
                    $set: {
                        sourceState: 'delete_pending',
                        sourceCleanupState: 'retry',
                        sourceCleanupNextRetryAt: nextRetryAt,
                        sourceCleanupLastError: redactSensitiveText(error?.message || 'R2 DELETE failed').slice(0, 500),
                    },
                    $inc: { sourceCleanupAttempts: 1 },
                }
            );
            return { cleaned: false, retryScheduled: true, nextRetryAt };
        }
    }

    async sweepRetries({ limit = 50, now = new Date() } = {}) {
        const jobs = await this.Job.find({
            storageProvider: 'r2',
            sourceCleanupState: { $in: ['pending', 'retry'] },
            $or: [
                { sourceCleanupNextRetryAt: null },
                { sourceCleanupNextRetryAt: { $lte: now } },
            ],
        }).sort({ sourceCleanupNextRetryAt: 1 }).limit(limit).lean();
        const results = [];
        for (const job of jobs) {
            results.push({ job, result: await this.cleanupSource(job, { reason: 'retry_sweeper' }) });
        }
        return results;
    }
}
