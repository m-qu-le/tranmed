import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import Job from '../src/models/jobModel.js';
import UploadBatch from '../src/models/uploadBatchModel.js';
import { redactError } from '../src/utils/redactSecrets.js';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(backendRoot, '.env'), quiet: true });
const APPLY = process.argv.includes('--apply');

function manifestItem(job) {
    return {
        jobId: job.jobId,
        clientUploadId: job.clientUploadId || `legacy-${job.jobId}`,
        originalName: job.originalName,
        sourceSize: job.sourceSize ?? null,
    };
}

async function main() {
    if (!process.env.MONGODB_URI) throw new Error('Thiếu MONGODB_URI.');
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
    const batches = await UploadBatch.find({}).sort({ createdAt: 1 }).lean();
    const report = [];
    for (const batch of batches) {
        if (Array.isArray(batch.items) && batch.items.length === batch.totalFiles) {
            report.push({ batchId: batch.batchId, outcome: 'already_complete', items: batch.items.length });
            continue;
        }
        const jobs = await Job.find({ uploadBatchId: batch.batchId }).sort({ createdAt: 1 }).lean();
        if (jobs.length !== batch.totalFiles) {
            report.push({
                batchId: batch.batchId,
                outcome: 'blocked_count_mismatch',
                totalFiles: batch.totalFiles,
                jobs: jobs.length,
            });
            continue;
        }
        const items = jobs.map(manifestItem);
        if (APPLY) {
            const result = await UploadBatch.updateOne(
                {
                    batchId: batch.batchId,
                    $or: [
                        { items: { $exists: false } },
                        { items: { $size: 0 } },
                    ],
                },
                { $set: { items } }
            );
            if (result.matchedCount !== 1) {
                throw new Error(`Manifest batch ${batch.batchId} thay đổi đồng thời; dừng backfill.`);
            }
        }
        report.push({
            batchId: batch.batchId,
            outcome: APPLY ? 'backfilled' : 'would_backfill',
            items: items.length,
        });
    }
    console.log(JSON.stringify({ mode: APPLY ? 'apply' : 'dry_run', report }, null, 2));
}

main()
    .catch(error => {
        console.error(redactError(error));
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect();
    });
