import fs from 'fs/promises';
import path from 'path';
import { UPLOAD_DIR } from '../config/env.js';
import { ErrorCodes, ProcessingError } from '../utils/processingError.js';
import { assertWorkerDiskCapacity } from './storageService.js';

function mapR2Error(error) {
    if (error instanceof ProcessingError) return error;
    const status = error?.$metadata?.httpStatusCode || error?.statusCode;
    const name = error?.name || error?.Code || error?.code;
    if (status === 404 || ['NotFound', 'NoSuchKey'].includes(name)) {
        return new ProcessingError(ErrorCodes.R2_SOURCE_MISSING, 'R2 source object không tồn tại.', {
            publicMessage: 'File nguồn không còn tồn tại trên Cloud.',
        });
    }
    if (status === 401 || status === 403 || ['AccessDenied', 'InvalidAccessKeyId', 'SignatureDoesNotMatch'].includes(name)) {
        return new ProcessingError(ErrorCodes.R2_AUTH, 'R2 credentials hoặc chữ ký không hợp lệ.', {
            publicMessage: 'Cấu hình lưu trữ Cloud không hợp lệ.',
        });
    }
    if (status === 429 || name === 'SlowDown') {
        return new ProcessingError(ErrorCodes.R2_RATE_LIMIT, 'R2 đang giới hạn request.', {
            retryable: true, publicMessage: 'Cloud Storage đang giới hạn tốc độ; hệ thống sẽ thử lại.',
        });
    }
    if (['TimeoutError', 'RequestTimeout', 'ETIMEDOUT', 'ECONNRESET'].includes(name)) {
        return new ProcessingError(ErrorCodes.R2_TIMEOUT, 'R2 request timeout.', {
            retryable: true, publicMessage: 'Kết nối Cloud Storage bị gián đoạn; hệ thống sẽ thử lại.',
        });
    }
    return new ProcessingError(ErrorCodes.R2_UNAVAILABLE, error?.message || 'R2 unavailable.', {
        retryable: !status || status >= 500,
        publicMessage: 'Cloud Storage tạm thời không khả dụng.',
    });
}

async function validateDownloadedPdf(filePath, expectedSize) {
    const stat = await fs.stat(filePath);
    if (stat.size !== expectedSize) {
        throw new ProcessingError(ErrorCodes.R2_UNAVAILABLE, 'R2 download không đủ byte.', {
            retryable: true, publicMessage: 'File tải từ Cloud chưa đầy đủ; hệ thống sẽ tải lại.',
        });
    }
    const handle = await fs.open(filePath, 'r');
    try {
        const signature = Buffer.alloc(5);
        await handle.read(signature, 0, 5, 0);
        if (signature.toString() !== '%PDF-') {
            throw new ProcessingError(ErrorCodes.INVALID_PDF, 'R2 source không có PDF magic bytes.', {
                publicMessage: 'File trên Cloud không phải PDF hợp lệ.',
            });
        }
    } finally {
        await handle.close();
    }
}

export class SourceService {
    constructor({ r2, uploadDir = UPLOAD_DIR, assertCapacity = assertWorkerDiskCapacity }) {
        this.r2 = r2;
        this.uploadDir = uploadDir;
        this.assertCapacity = assertCapacity;
    }

    async resolve(job) {
        if (job.storageProvider !== 'r2') {
            if (!job.filePath) throw new ProcessingError(ErrorCodes.FILE_MISSING, 'Job legacy không có filePath.');
            try { await fs.access(job.filePath); }
            catch { throw new ProcessingError(ErrorCodes.FILE_MISSING, 'File gốc bị mất trên Render.', { publicMessage: 'File gốc đã bị mất trên Render.' }); }
            return { filePath: job.filePath, temporary: false };
        }
        if (!job.storageKey || job.sourceState !== 'ready') {
            throw new ProcessingError(ErrorCodes.R2_SOURCE_MISSING, 'Job R2 chưa có source sẵn sàng.');
        }
        await fs.mkdir(this.uploadDir, { recursive: true });
        const finalPath = path.join(this.uploadDir, `r2-${job.jobId}.pdf`);
        const partPath = `${finalPath}.part`;
        await Promise.all([fs.unlink(partPath).catch(() => {}), fs.unlink(finalPath).catch(() => {})]);
        try {
            await this.assertCapacity(job.sourceSize);
        } catch (error) {
            throw new ProcessingError(ErrorCodes.DISK_CAPACITY, error.message, {
                retryable: true, publicMessage: 'Render chưa đủ dung lượng tạm; hệ thống sẽ thử lại.',
            });
        }
        try {
            await this.r2.downloadToFile({ key: job.storageKey, destinationPath: partPath });
            await validateDownloadedPdf(partPath, job.sourceSize);
            await fs.rename(partPath, finalPath);
            return { filePath: finalPath, temporary: true };
        } catch (error) {
            await fs.unlink(partPath).catch(() => {});
            throw mapR2Error(error);
        }
    }

    async cleanup(resolvedSource) {
        if (!resolvedSource?.temporary) return;
        await Promise.all([
            fs.unlink(resolvedSource.filePath).catch(() => {}),
            fs.unlink(`${resolvedSource.filePath}.part`).catch(() => {}),
        ]);
    }
}
