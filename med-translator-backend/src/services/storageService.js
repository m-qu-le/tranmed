import fs from 'fs/promises';
import path from 'path';
import Job from '../models/jobModel.js';
import { MAX_FILE_SIZE_MB, MAX_UPLOAD_STORAGE_MB, UPLOAD_DIR } from '../config/env.js';

const budgetBytes = MAX_UPLOAD_STORAGE_MB * 1024 * 1024;

export async function getUploadStorageUsage() {
    let entries = [];
    try {
        entries = await fs.readdir(UPLOAD_DIR, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') return 0;
        throw error;
    }

    const sizes = await Promise.all(entries
        .filter(entry => entry.isFile())
        .map(async entry => {
            const stat = await fs.stat(path.join(UPLOAD_DIR, entry.name));
            return stat.size;
        }));
    return sizes.reduce((total, size) => total + size, 0);
}

export async function getCapacityStatus(uploadInProgress = false) {
    if (!uploadInProgress) {
        await cleanupOrphanUploads(0);
    }
    const [usedBytes, activeSourceFiles] = await Promise.all([
        getUploadStorageUsage(),
        Job.countDocuments({ status: { $in: ['pending', 'processing'] } })
    ]);

    let reason = null;
    if (uploadInProgress) reason = 'UPLOAD_IN_PROGRESS';
    else if (activeSourceFiles > 0) reason = 'SERVER_JOB_ACTIVE';
    else if (usedBytes >= budgetBytes) reason = 'STORAGE_BUDGET_REACHED';

    return {
        canAcceptUpload: reason === null,
        reason,
        activeSourceFiles,
        usedBytes,
        budgetBytes,
        maxFileSizeBytes: MAX_FILE_SIZE_MB * 1024 * 1024
    };
}

export async function cleanupOrphanUploads(gracePeriodMs = 5 * 60 * 1000) {
    let entries = [];
    try {
        entries = await fs.readdir(UPLOAD_DIR, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') return 0;
        throw error;
    }

    const activeJobs = await Job.find(
        { status: { $in: ['pending', 'processing'] } },
        'filePath'
    ).lean();
    const referencedPaths = new Set(activeJobs.map(job => path.resolve(job.filePath)));
    let deletedCount = 0;

    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const filePath = path.resolve(UPLOAD_DIR, entry.name);
        if (referencedPaths.has(filePath)) continue;

        const stat = await fs.stat(filePath);
        if (Date.now() - stat.mtimeMs < gracePeriodMs) continue;
        await fs.unlink(filePath).catch(() => {});
        deletedCount += 1;
    }

    return deletedCount;
}
