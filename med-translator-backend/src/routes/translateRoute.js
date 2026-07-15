import express from 'express';
import upload from '../middlewares/upload.js';
import { enforceStorageBudget, getCapacity, reserveUploadCapacity } from '../middlewares/capacity.js';
import validatePdf from '../middlewares/validatePdf.js';
import { rateLimit } from 'express-rate-limit';
import { 
    uploadFiles, 
    getJobsSummary, 
    getJobResult, 
    downloadJobResult,
    streamLogs,
    deleteJob,
    bulkDeleteJobs,
    getSystemStatus,
    forceWakeUpSystem, // [THÊM MỚI] Import hàm ép thức dậy
    deleteFolderQueue // [THÊM DÒNG NÀY]
} from '../controllers/translateController.js'; 

const router = express.Router();
const uploadRateLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Đã gửi quá nhiều upload trong một giờ. Vui lòng thử lại sau.' }
});

// Frontend có thể giữ hàng trăm file trong Local Queue, nhưng backend chỉ nhận một file/lần.
router.post('/', uploadRateLimit, reserveUploadCapacity, upload.array('files', 1), validatePdf, enforceStorageBudget, uploadFiles);
router.get('/capacity', getCapacity);

// 2. Các API lấy trạng thái và kết quả
router.get('/jobs', getJobsSummary);
router.get('/status', getSystemStatus); // Route lấy trạng thái hệ thống
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

// [THÊM MỚI] 7. API Xóa toàn bộ hàng đợi thư mục (Nhận folderName qua URL params)
router.delete('/folder/:folderName', deleteFolderQueue);

export default router;
