import { ErrorCodes, ProcessingError } from '../utils/processingError.js';
import { isQualityDocumentContext, QUALITY_DOCUMENT_CONTEXT_VERSION } from './qualityDocumentContext.js';

function plain(value) {
    return value?.toObject ? value.toObject() : value;
}

export class QualityDocumentContextService {
    constructor({ JobModel, executors, contextVersion = QUALITY_DOCUMENT_CONTEXT_VERSION }) {
        this.JobModel = JobModel;
        this.executors = executors;
        this.contextVersion = contextVersion;
    }

    async prepare({ job, sourcePath, totalPages, signal, assertActive = async () => {}, onStage = async () => {} }) {
        const current = plain(await this.JobModel.findOne({ jobId: job.jobId }));
        if (current?.qualityContextVersion === this.contextVersion
            && isQualityDocumentContext(current.qualityDocumentContext)) {
            return current.qualityDocumentContext;
        }

        await assertActive();
        await onStage({ phase: 'started', action: 'document_context' });
        const result = await this.executors.document_context({ sourcePath, totalPages, signal });
        await assertActive();
        if (!isQualityDocumentContext(result?.json)) {
            throw new ProcessingError(ErrorCodes.GEMINI_SCHEMA_INVALID, 'Context passport không đạt schema.', { retryable: true });
        }

        const updated = plain(await this.JobModel.findOneAndUpdate(
            {
                jobId: job.jobId,
                status: 'processing',
                processingToken: job.processingToken,
                cancelRequested: { $ne: true },
            },
            {
                $set: {
                    qualityContextVersion: this.contextVersion,
                    qualityDocumentContext: result.json,
                    qualityContextUsage: result.metadata,
                    qualityContextGeneratedAt: new Date(),
                },
            },
            { returnDocument: 'after' }
        ));
        if (updated?.qualityContextVersion === this.contextVersion
            && isQualityDocumentContext(updated.qualityDocumentContext)) {
            await onStage({ phase: 'completed', action: 'document_context' });
            return updated.qualityDocumentContext;
        }

        const recovered = plain(await this.JobModel.findOne({ jobId: job.jobId }));
        if (recovered?.qualityContextVersion === this.contextVersion
            && isQualityDocumentContext(recovered.qualityDocumentContext)) {
            await onStage({ phase: 'completed', action: 'document_context' });
            return recovered.qualityDocumentContext;
        }
        throw new ProcessingError(
            ErrorCodes.DATABASE_UNAVAILABLE,
            'Không thể lưu context passport của tài liệu.',
            { retryable: true }
        );
    }
}
