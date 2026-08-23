import { validateRuntimeEnv } from '../config/env.js';
import Job from '../models/jobModel.js';
import UploadBatch from '../models/uploadBatchModel.js';
import { createR2Service } from './r2Service.js';
import { UploadBatchService } from './uploadBatchService.js';
import { SourceService } from './sourceService.js';
import { SourceCleanupService } from './sourceCleanupService.js';
import { QUALITY_PIPELINE_VERSION } from './qualityPipelineState.js';
import { LocalStorageService } from './localStorageService.js';

export const runtimeConfig = validateRuntimeEnv();
export const localStorageService = runtimeConfig.runtimeMode === 'local'
    ? new LocalStorageService(runtimeConfig.storage)
    : null;
export const r2Service = runtimeConfig.runtimeMode === 'cloud'
    ? createR2Service(runtimeConfig.r2)
    : null;

export async function storageReadiness() {
    if (localStorageService) return localStorageService.readiness();
    const status = await r2Service.checkReadiness();
    return { ...status, mode: 'r2' };
}

export const uploadBatchService = new UploadBatchService({
    Job,
    UploadBatch,
    r2: r2Service,
    config: {
        maxFiles: 500,
        maxFileSizeBytes: runtimeConfig.maxFileSizeMb * 1024 * 1024,
        maxBatchBytes: 2 * 1024 * 1024 * 1024,
        maxJobAttempts: runtimeConfig.maxJobAttempts,
        // The local uploader writes directly to DATA_ROOT, so it has no R2
        // confirmation stage. Keep this value defined for the shared batch
        // service without dereferencing the absent cloud configuration.
        confirmConcurrency: runtimeConfig.r2?.uploadConcurrency ?? 1,
        translationMode: runtimeConfig.translation.pipelineMode,
        translationPipelineVersion: QUALITY_PIPELINE_VERSION,
    },
});
export const sourceService = new SourceService({ r2: r2Service, localStorage: localStorageService });
export const sourceCleanupService = new SourceCleanupService({
    Job,
    r2: r2Service,
    localStorage: localStorageService,
});
