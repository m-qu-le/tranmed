import { MAX_UPLOAD_STORAGE_MB } from '../config/env.js';
import { getCapacityStatus, getUploadStorageUsage } from '../services/storageService.js';
import { unlink } from 'fs/promises';

const budgetBytes = MAX_UPLOAD_STORAGE_MB * 1024 * 1024;
let uploadInProgress = false;

export async function getCapacity(req, res) {
    try {
        res.status(200).json(await getCapacityStatus(uploadInProgress));
    } catch (error) {
        console.error('[CAPACITY] Không thể đọc dung lượng:', error.message);
        res.status(503).json({ error: 'Không thể kiểm tra dung lượng server.' });
    }
}

export async function reserveUploadCapacity(req, res, next) {
    const release = () => { uploadInProgress = false; };
    try {
        // Chiếm khóa trước await đầu tiên để hai request đồng thời không cùng vượt guard.
        if (uploadInProgress) {
            return res.status(409).json({
                error: 'Server đang nhận một file khác. File vẫn được giữ trong Local Queue.'
            });
        }
        uploadInProgress = true;

        const contentLength = Number.parseInt(req.headers['content-length'] || '0', 10);
        if (Number.isFinite(contentLength) && contentLength > budgetBytes) {
            release();
            return res.status(413).json({ error: 'Request lớn hơn ngân sách lưu trữ của server.' });
        }

        const capacity = await getCapacityStatus(false);
        if (!capacity.canAcceptUpload) {
            release();
            return res.status(409).json({
                error: 'Server đang xử lý một tài liệu khác. File vẫn được giữ trong Local Queue.',
                capacity
            });
        }

        res.once('finish', release);
        res.once('close', release);
        next();
    } catch (error) {
        release();
        next(error);
    }
}

export async function enforceStorageBudget(req, res, next) {
    try {
        const usedBytes = await getUploadStorageUsage();
        if (usedBytes <= budgetBytes) return next();

        await Promise.all((req.files || []).map(file => unlink(file.path).catch(() => {})));
        return res.status(507).json({
            error: 'Upload đã bị hủy vì vượt ngân sách ổ đĩa của Render.'
        });
    } catch (error) {
        next(error);
    }
}
