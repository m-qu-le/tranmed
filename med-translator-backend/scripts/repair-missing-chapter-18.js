import { randomUUID } from 'crypto';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import Job from '../src/models/jobModel.js';
import UploadBatch from '../src/models/uploadBatchModel.js';
import { createIncomingStorageKey } from '../src/services/sourceKeyService.js';
import { ErrorCodes } from '../src/utils/processingError.js';
import { redactError } from '../src/utils/redactSecrets.js';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(backendRoot, '.env'), quiet: true });

const APPLY = process.argv.includes('--apply');
const BATCH_ID = '63ee6ab6-9629-443b-ba44-ae368642ab94';
const ORIGINAL_NAME = '18 Blood.pdf';

async function inspect() {
    const batch = await UploadBatch.findOne({ batchId: BATCH_ID }).lean();
    if (!batch) throw new Error('Không tìm thấy batch Boron cần sửa.');
    const jobs = await Job.find({ uploadBatchId: BATCH_ID }).sort({ createdAt: 1 }).lean();
    const existing = jobs.find(job => job.originalName === ORIGINAL_NAME);
    return { batch, jobs, existing };
}

async function main() {
    if (!process.env.MONGODB_URI) throw new Error('Thiếu MONGODB_URI.');
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
    const before = await inspect();
    if (before.existing) {
        console.log(JSON.stringify({
            outcome: 'already_repaired',
            jobId: before.existing.jobId,
            status: before.existing.status,
            errorCode: before.existing.errorCode,
        }, null, 2));
        return;
    }
    if (before.batch.totalFiles !== 63 || before.batch.confirmedFiles !== 63 || before.jobs.length !== 62) {
        throw new Error('Precondition thay đổi; từ chối sửa tự động để không ghi nhầm dữ liệu.');
    }

    const jobId = randomUUID();
    const clientUploadId = `recovered-legacy-${randomUUID()}`;
    const reference = before.jobs[0] || {};
    const recoveredItem = {
        jobId,
        clientUploadId,
        originalName: ORIGINAL_NAME,
        sourceSize: null,
    };
    const items = [
        ...before.jobs.map(job => ({
            jobId: job.jobId,
            clientUploadId: job.clientUploadId || `legacy-${job.jobId}`,
            originalName: job.originalName,
            sourceSize: job.sourceSize ?? null,
        })),
        recoveredItem,
    ].sort((left, right) => left.originalName.localeCompare(
        right.originalName,
        'en',
        { numeric: true, sensitivity: 'base' }
    ));

    const plan = {
        outcome: APPLY ? 'apply' : 'dry_run',
        batchId: BATCH_ID,
        beforeJobs: before.jobs.length,
        manifestItems: items.length,
        recovered: {
            jobId,
            originalName: ORIGINAL_NAME,
            status: 'failed',
            errorCode: ErrorCodes.MANIFEST_JOB_MISSING,
        },
    };
    if (!APPLY) {
        console.log(JSON.stringify(plan, null, 2));
        return;
    }

    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            await Job.create([{
                jobId,
                clientUploadId,
                originalName: ORIGINAL_NAME,
                folderName: before.batch.folderName,
                priority: before.batch.priority || 0,
                filePath: null,
                status: 'failed',
                storageProvider: 'r2',
                storageKey: createIncomingStorageKey(BATCH_ID, jobId),
                sourceSize: null,
                sourceState: 'missing',
                uploadBatchId: BATCH_ID,
                uploadConfirmedAt: before.batch.readyAt || before.batch.updatedAt || new Date(),
                maxAttempts: reference.maxAttempts || 3,
                error: 'Job đã biến mất do lỗi ownership cũ; source R2 không còn để xác minh hoặc tiếp tục dịch.',
                errorCode: ErrorCodes.MANIFEST_JOB_MISSING,
                failureCategory: 'terminal',
                terminalAt: new Date(),
                failureAdvice: 'Tải lại file 18 Blood.pdf để dịch lại.',
                translationMode: reference.translationMode || null,
                translationPipelineVersion: reference.translationPipelineVersion || null,
            }], { session });
            const updated = await UploadBatch.updateOne(
                {
                    batchId: BATCH_ID,
                    $or: [
                        { items: { $exists: false } },
                        { items: { $size: 0 } },
                    ],
                },
                { $set: { items } },
                { session }
            );
            if (updated.matchedCount !== 1) {
                throw new Error('Batch manifest đã thay đổi trong lúc sửa; transaction bị hủy.');
            }
        });
    } finally {
        await session.endSession();
    }

    const after = await inspect();
    console.log(JSON.stringify({
        ...plan,
        afterJobs: after.jobs.length,
        verifiedStatus: after.existing?.status,
        verifiedErrorCode: after.existing?.errorCode,
    }, null, 2));
}

main()
    .catch(error => {
        console.error(redactError(error));
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect();
    });
