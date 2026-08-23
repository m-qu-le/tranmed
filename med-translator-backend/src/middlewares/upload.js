import multer from 'multer';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { MAX_FILE_SIZE_MB, UPLOAD_DIR } from '../config/env.js';
import { localStorageService, runtimeConfig } from '../services/runtimeServices.js';

function invalidUpload(message) {
    const error = new Error(message);
    error.code = 'UPLOAD_INVALID';
    error.status = 400;
    return error;
}

class AtomicPdfStorage {
    _handleFile(_req, file, callback) {
        void (async () => {
            const id = randomUUID();
            const isLocal = runtimeConfig.runtimeMode === 'local';
            if (isLocal) await localStorageService.initialize();
            else await fsp.mkdir(UPLOAD_DIR, { recursive: true });

            const directory = isLocal ? localStorageService.sourceDir : UPLOAD_DIR;
            const tempDirectory = isLocal ? localStorageService.tempDir : UPLOAD_DIR;
            const finalPath = isLocal
                ? localStorageService.uploadFinalPath(id)
                : path.join(directory, `${id}.pdf`);
            const partPath = isLocal
                ? localStorageService.uploadPartPath(id)
                : `${finalPath}.part`;
            const capacity = isLocal ? await localStorageService.assertCapacity(0) : null;
            const maxWritableBytes = capacity
                ? Math.max(0, capacity.freeBytes - capacity.diskReserveBytes)
                : Number.POSITIVE_INFINITY;
            const hash = createHash('sha256');
            const firstBytes = Buffer.alloc(5);
            let firstByteCount = 0;
            let size = 0;
            let finished = false;
            const output = fs.createWriteStream(partPath, { flags: 'wx' });

            const cleanupAndFail = async error => {
                if (finished) return;
                finished = true;
                output.destroy();
                await fsp.unlink(partPath).catch(() => {});
                callback(error);
            };

            file.stream.on('data', chunk => {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                if (firstByteCount < firstBytes.length) {
                    const count = Math.min(firstBytes.length - firstByteCount, buffer.length);
                    buffer.copy(firstBytes, firstByteCount, 0, count);
                    firstByteCount += count;
                }
                size += buffer.length;
                hash.update(buffer);
                if (size > maxWritableBytes) {
                    file.stream.destroy(invalidUpload('Ổ dữ liệu local không còn đủ dung lượng dự phòng.'));
                }
            });
            file.stream.once('error', error => { void cleanupAndFail(error); });
            output.once('error', error => { void cleanupAndFail(error); });
            output.once('finish', () => {
                void (async () => {
                    if (finished) return;
                    if (firstByteCount !== 5 || firstBytes.toString('ascii') !== '%PDF-') {
                        return cleanupAndFail(invalidUpload(`${file.originalname} không phải PDF hợp lệ.`));
                    }
                    try {
                        await fsp.rename(partPath, finalPath);
                        finished = true;
                        callback(null, {
                            destination: directory,
                            filename: path.basename(finalPath),
                            path: finalPath,
                            size,
                            sha256: hash.digest('hex'),
                        });
                    } catch (error) {
                        await cleanupAndFail(error);
                    }
                })();
            });
            file.stream.pipe(output);
        })().catch(error => callback(error));
    }

    _removeFile(_req, file, callback) {
        const remove = runtimeConfig.runtimeMode === 'local'
            ? localStorageService.removeManagedFile(file.path)
            : fsp.unlink(file.path).catch(error => {
                if (error?.code !== 'ENOENT') throw error;
            });
        void remove.then(() => callback(null)).catch(callback);
    }
}

const upload = multer({
    storage: new AtomicPdfStorage(),
    fileFilter: (_req, file, callback) => {
        if (file.mimetype === 'application/pdf') callback(null, true);
        else callback(invalidUpload('Chỉ chấp nhận định dạng file PDF.'), false);
    },
    limits: {
        fileSize: MAX_FILE_SIZE_MB * 1024 * 1024,
        files: 1,
        fields: 5,
        fieldNameSize: 100,
        fieldSize: 16 * 1024,
    },
});

export default upload;
