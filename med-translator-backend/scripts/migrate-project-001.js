import mongoose from 'mongoose';
import '../src/config/env.js';
import Job from '../src/models/jobModel.js';
import System from '../src/models/systemModel.js';
import TranslationChunk from '../src/models/translationChunkModel.js';

const mongodbUri = process.env.MONGODB_URI?.trim();
const dryRun = process.argv.includes('--dry-run');
if (!mongodbUri) {
    console.error('❌ Thiếu biến môi trường MONGODB_URI.');
    process.exit(1);
}

try {
    await mongoose.connect(mongodbUri, { serverSelectionTimeoutMS: 5000 });

    const filters = {
        attemptCount: { attemptCount: { $exists: false } },
        maxAttempts: { maxAttempts: { $exists: false } },
        cancelRequested: { cancelRequested: { $exists: false } },
        chunkCount: { chunkCount: { $exists: false } },
        completedChunks: { completedChunks: { $exists: false } }
    };
    const report = Object.fromEntries(await Promise.all(
        Object.entries(filters).map(async ([name, filter]) => [name, await Job.countDocuments(filter)])
    ));
    const totals = {
        jobs: await Job.countDocuments({}),
        systems: await System.countDocuments({}),
        translationChunks: await TranslationChunk.countDocuments({})
    };

    console.log(`🔎 P001 migration ${dryRun ? 'dry-run' : 'thực thi'} — tổng document:`, totals);
    console.log('🔎 Document Job cần bổ sung field:', report);
    if (dryRun) {
        console.log('✅ Dry-run hoàn thành; không document hoặc index nào bị thay đổi.');
    } else {
        const maxJobAttempts = Number.parseInt(process.env.MAX_JOB_ATTEMPTS || '3', 10);

        const updates = await Promise.all([
            Job.updateMany(filters.attemptCount, { $set: { attemptCount: 0 } }),
            Job.updateMany(filters.maxAttempts, { $set: { maxAttempts: maxJobAttempts } }),
            Job.updateMany(filters.cancelRequested, { $set: { cancelRequested: false } }),
            Job.updateMany(filters.chunkCount, { $set: { chunkCount: 0 } }),
            Job.updateMany(filters.completedChunks, { $set: { completedChunks: 0 } })
        ]);

        await Promise.all([
            Job.syncIndexes(),
            System.syncIndexes(),
            TranslationChunk.syncIndexes()
        ]);

        console.log('✅ P001 migration hoàn thành:', updates.map(result => result.modifiedCount));
    }
} catch (error) {
    console.error('❌ P001 migration thất bại:', error.message);
    process.exitCode = 1;
} finally {
    await mongoose.disconnect();
}
