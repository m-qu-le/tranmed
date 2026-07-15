import { validateRuntimeEnv } from '../config/env.js';
import Job from '../models/jobModel.js';
import UploadBatch from '../models/uploadBatchModel.js';
import { createR2Service } from './r2Service.js';
import { UploadBatchService } from './uploadBatchService.js';
import { SourceService } from './sourceService.js';
import { SourceCleanupService } from './sourceCleanupService.js';
import { QUALITY_PIPELINE_VERSION } from './qualityPipelineState.js';

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
        translationMode: runtimeConfig.translation.pipelineMode,
        translationPipelineVersion: QUALITY_PIPELINE_VERSION,
    },
});
export const sourceService = new SourceService({ r2: r2Service });
export const sourceCleanupService = new SourceCleanupService({ Job, r2: r2Service });
