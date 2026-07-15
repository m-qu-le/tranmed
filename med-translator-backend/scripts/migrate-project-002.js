import mongoose from 'mongoose';
import '../src/config/env.js';
import Job from '../src/models/jobModel.js';
import UploadBatch from '../src/models/uploadBatchModel.js';
import { runProject002Migration } from '../src/migrations/project002Migration.js';
import { redactError } from '../src/utils/redactSecrets.js';

const mongodbUri = process.env.MONGODB_URI?.trim();
const dryRun = process.argv.includes('--dry-run');
if (!mongodbUri) {
    console.error('Thiếu biến môi trường MONGODB_URI.');
    process.exit(1);
}

try {
    await mongoose.connect(mongodbUri, { serverSelectionTimeoutMS: 5000 });
    const result = await runProject002Migration({ Job, UploadBatch, dryRun });
    console.log(`P002 migration ${dryRun ? 'dry-run' : 'hoàn thành'}:`, result);
} catch (error) {
    console.error('P002 migration thất bại:', redactError(error));
    process.exitCode = 1;
} finally {
    await mongoose.disconnect();
}
