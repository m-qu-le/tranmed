import express from 'express';
import { timingSafeEqual } from 'crypto';
import upload from '../middlewares/upload.js';
import { enforceStorageBudget, getCapacity, reserveUploadCapacity } from '../middlewares/capacity.js';
import validatePdf from '../middlewares/validatePdf.js';
import { rateLimit } from 'express-rate-limit';
import { 
    uploadFiles, 
    getJobsSummary, 
    getFolderJobsSummary,
    getTerminalFailures,
    retryTerminalFailures,
    getJobStats,
    getActiveJobs,
    getGeminiKeyStatus,
    getJobResult, 
    downloadJobResult,
    streamLogs,
    deleteJob,
    bulkDeleteJobs,
    getSystemStatus,
    getOperationalMetrics,
    runGeminiDiagnosticProbe,
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
const HOUR_MS = 60 * 60 * 1000;

function createCloudUploadRateLimit(limit, message) {
    return rateLimit({
        windowMs: HOUR_MS,
        limit,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        // Local only binds to 127.0.0.1 and serializes writes with
        // reserveUploadCapacity. A per-IP hourly cap there prevents a normal
        // library import while adding no protection.
        skip: () => runtimeConfig.runtimeMode === 'local',
        handler: (req, res) => {
            const resetTime = req.rateLimit?.resetTime;
            const retryAfterSeconds = resetTime instanceof Date
                ? Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
                : 60;
            res.set('Retry-After', String(retryAfterSeconds));
            return res.status(429).json({
                error: message,
                code: 'UPLOAD_RATE_LIMIT',
                retryAfterSeconds,
            });
        },
    });
}

const directCloudUploadRateLimit = createCloudUploadRateLimit(
    runtimeConfig.uploadRateLimits.cloudDirectPerHour,
    'Đã gửi quá nhiều upload trực tiếp trong một giờ. Vui lòng thử lại sau.'
);
const cloudUploadControlRateLimit = createCloudUploadRateLimit(
    runtimeConfig.uploadRateLimits.cloudControlPerHour,
    'Đã gửi quá nhiều yêu cầu điều phối upload trong một giờ. Vui lòng thử lại sau.'
);
const diagnosticProbeRateLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 4,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
        error: 'Đã chạy quá nhiều Gemini diagnostic probe trong một giờ.',
        code: 'PROBE_RATE_LIMIT',
    },
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

function requireCloudStorage(_req, res, next) {
    if (runtimeConfig.runtimeMode === 'cloud') return next();
    return res.status(410).json({
        error: 'Upload batch R2 không khả dụng ở local runtime; hãy upload PDF trực tiếp vào StudyMed local.',
        code: 'LOCAL_DIRECT_UPLOAD_ONLY',
    });
}

// Frontend có thể giữ hàng trăm file trong Local Queue, nhưng backend chỉ nhận một file/lần.
router.post('/', directCloudUploadRateLimit, reserveUploadCapacity, upload.array('files', 1), validatePdf, enforceStorageBudget, uploadFiles);
router.get('/capacity', getCapacity);
router.post('/upload-batches/prepare', requireCloudStorage, cloudUploadControlRateLimit, prepareUploadBatch);
router.post('/upload-batches/:batchId/confirm', requireCloudStorage, cloudUploadControlRateLimit, confirmUploadBatch);
router.post('/upload-batches/:batchId/abandon', requireCloudStorage, cloudUploadControlRateLimit, abandonUploadBatchItems);
router.get('/upload-batches', requireCloudStorage, listUploadBatches);
router.get('/upload-batches/:batchId', requireCloudStorage, getUploadBatchStatus);

// 2. Các API lấy trạng thái và kết quả
router.get('/jobs', getJobsSummary);
router.get('/folders/:folderName/jobs', getFolderJobsSummary);
router.get('/jobs/stats', getJobStats);
router.get('/jobs/active', getActiveJobs);
router.get('/jobs/terminal-failures', getTerminalFailures);
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
router.post('/jobs/retry-terminal', retryTerminalFailures);

// 5. API Xóa tiến trình đơn lẻ
// Định tuyến DELETE /jobs/:jobId
router.delete('/jobs/:jobId', deleteJob);

// [THÊM MỚI] 6. API Ép hệ thống thức dậy thủ công
// Gọi POST /force-wakeup để hủy trạng thái ngủ đông
router.post('/force-wakeup', forceWakeUpSystem);
router.post('/maintenance/pause', requireMaintenanceControl, pauseForRedeploy);
router.post('/maintenance/cancel', requireMaintenanceControl, cancelRedeployPause);
router.post(
    '/diagnostics/gemini-probe',
    requireMaintenanceControl,
    diagnosticProbeRateLimit,
    runGeminiDiagnosticProbe
);

// [THÊM MỚI] 7. API Xóa toàn bộ hàng đợi thư mục (Nhận folderName qua URL params)
router.delete('/folder/:folderName', deleteFolderQueue);

export default router;
