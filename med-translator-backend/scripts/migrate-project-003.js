import mongoose from 'mongoose';
import '../src/config/env.js';
import Job from '../src/models/jobModel.js';
import TranslationChunk from '../src/models/translationChunkModel.js';
import { runProject003Migration } from '../src/migrations/project003Migration.js';
import { redactError } from '../src/utils/redactSecrets.js';

const mongodbUri = process.env.MONGODB_URI?.trim();
const dryRun = process.argv.includes('--dry-run');
if (!mongodbUri) {
    console.error('Thiếu biến môi trường MONGODB_URI.');
    process.exit(1);
}

try {
    await mongoose.connect(mongodbUri, { serverSelectionTimeoutMS: 5000 });
    const result = await runProject003Migration({ Job, TranslationChunk, dryRun });
    console.log(`P003 migration ${dryRun ? 'dry-run' : 'hoàn thành'}:`, result);
} catch (error) {
    console.error('P003 migration thất bại:', redactError(error));
    process.exitCode = 1;
} finally {
    await mongoose.disconnect();
}
