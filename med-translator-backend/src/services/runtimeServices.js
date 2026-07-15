import { validateRuntimeEnv } from '../config/env.js';
import Job from '../models/jobModel.js';
import UploadBatch from '../models/uploadBatchModel.js';
import { createR2Service } from './r2Service.js';
import { UploadBatchService } from './uploadBatchService.js';

export const runtimeConfig = validateRuntimeEnv();
export const r2Service = createR2Service(runtimeConfig.r2);
export const uploadBatchService = new UploadBatchService({
    Job,
    UploadBatch,
    r2: r2Service,
    config: {
        maxFiles: 500,
        maxFileSizeBytes: runtimeConfig.maxFileSizeMb * 1024 * 1024,
        maxBatchBytes: 2 * 1024 * 1024 * 1024,
        maxJobAttempts: runtimeConfig.maxJobAttempts,
        confirmConcurrency: runtimeConfig.r2.uploadConcurrency,
    },
});
