import express from 'express';
import { timingSafeEqual } from 'crypto';
import upload from '../middlewares/upload.js';
import { enforceStorageBudget, getCapacity, reserveUploadCapacity } from '../middlewares/capacity.js';
import validatePdf from '../middlewares/validatePdf.js';
import { rateLimit } from 'express-rate-limit';
import { 
    uploadFiles, 
    getJobsSummary, 
    getJobStats,
    getGeminiKeyStatus,
    getJobResult, 
    downloadJobResult,
    streamLogs,
    deleteJob,
    bulkDeleteJobs,
    getSystemStatus,
    getOperationalMetrics,
    forceWakeUpSystem, // [THÊM MỚI] Import hàm ép thức dậy
    pauseForRedeploy,
    cancelRedeployPause,
    deleteFolderQueue, // [THÊM DÒNG NÀY]
    prepareUploadBatch,
    confirmUploadBatch,
    getUploadBatchStatus,
    listUploadBatches,
    abandonUploadBatchItems
} from '../controllers/translateController.js'; 
import { runtimeConfig } from '../services/runtimeServices.js';

const router = express.Router();
const uploadRateLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Đã gửi quá nhiều upload trong một giờ. Vui lòng thử lại sau.' }
});

function requireMaintenanceControl(req, res, next) {
    const expected = runtimeConfig.maintenanceControlToken;
    const received = req.get('X-Maintenance-Token') || '';
    if (!expected) return res.status(503).json({ error: 'Chưa cấu hình MAINTENANCE_CONTROL_TOKEN trên Render.' });
    const expectedBuffer = Buffer.from(expected);
    const receivedBuffer = Buffer.from(received);
    if (expectedBuffer.length !== receivedBuffer.length || !timingSafeEqual(expectedBuffer, receivedBuffer)) {
        return res.status(403).json({ error: 'Mã quản trị không hợp lệ.' });
    }
    next();
}

// Frontend có thể giữ hàng trăm file trong Local Queue, nhưng backend chỉ nhận một file/lần.
router.post('/', uploadRateLimit, reserveUploadCapacity, upload.array('files', 1), validatePdf, enforceStorageBudget, uploadFiles);
router.get('/capacity', getCapacity);
router.post('/upload-batches/prepare', uploadRateLimit, prepareUploadBatch);
router.post('/upload-batches/:batchId/confirm', uploadRateLimit, confirmUploadBatch);
router.post('/upload-batches/:batchId/abandon', uploadRateLimit, abandonUploadBatchItems);
router.get('/upload-batches', listUploadBatches);
router.get('/upload-batches/:batchId', getUploadBatchStatus);

// 2. Các API lấy trạng thái và kết quả
router.get('/jobs', getJobsSummary);
router.get('/jobs/stats', getJobStats);
router.get('/gemini-keys/status', getGeminiKeyStatus);
router.get('/status', getSystemStatus); // Route lấy trạng thái hệ thống
router.get('/metrics', getOperationalMetrics);
router.get('/jobs/:jobId/result', getJobResult);
router.get('/jobs/:jobId/download', downloadJobResult);

// 3. API Stream Server-Sent Events (SSE)
router.get('/stream', streamLogs);

// 4. API Xóa tiến trình hàng loạt 
// Định tuyến POST /bulk-delete (Nhận mảng jobIds qua req.body)
router.post('/bulk-delete', bulkDeleteJobs);

// 5. API Xóa tiến trình đơn lẻ
// Định tuyến DELETE /jobs/:jobId
router.delete('/jobs/:jobId', deleteJob);

// [THÊM MỚI] 6. API Ép hệ thống thức dậy thủ công
// Gọi POST /force-wakeup để hủy trạng thái ngủ đông
router.post('/force-wakeup', forceWakeUpSystem);
router.post('/maintenance/pause', requireMaintenanceControl, pauseForRedeploy);
router.post('/maintenance/cancel', requireMaintenanceControl, cancelRedeployPause);

// [THÊM MỚI] 7. API Xóa toàn bộ hàng đợi thư mục (Nhận folderName qua URL params)
router.delete('/folder/:folderName', deleteFolderQueue);

export default router;
