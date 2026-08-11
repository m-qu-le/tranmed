import mongoose from 'mongoose';
import Job from '../src/models/jobModel.js';
import TranslationChunk from '../src/models/translationChunkModel.js';
import UploadBatch from '../src/models/uploadBatchModel.js';
import { r2Service } from '../src/services/runtimeServices.js';
import {
    isP014PurgeConfirmed,
    purgeP014WorkData,
} from '../src/services/project014PurgeService.js';
import { redactError } from '../src/utils/redactSecrets.js';

const args = process.argv.slice(2);
const executeRequested = args.includes('--execute');
const confirmed = isP014PurgeConfirmed({ args });
const mongodbUri = process.env.MONGODB_URI?.trim();

if (!mongodbUri) {
    console.error('Thiếu biến môi trường MONGODB_URI.');
    process.exit(1);
}

if (executeRequested && !confirmed) {
    console.error('Từ chối purge: cần cả --execute và P014_PURGE_CONFIRM=DELETE_WORK_DATA.');
    process.exit(1);
}

try {
    await mongoose.connect(mongodbUri, { serverSelectionTimeoutMS: 5000 });
    const result = await purgeP014WorkData(
        { r2: r2Service, Job, TranslationChunk, UploadBatch },
        { execute: confirmed }
    );
    console.log('P014 work-data purge result:', result);
    if (!confirmed) {
        console.log('Dry-run only: không object hay document nào bị thay đổi.');
    }
} catch (error) {
    console.error('P014 work-data purge thất bại:', redactError(error));
    process.exitCode = 1;
} finally {
    await mongoose.disconnect();
}
