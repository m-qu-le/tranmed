import { translationQueue } from '../services/queueManager.js';
import TranslationChunk from '../models/translationChunkModel.js';
import mongoose from 'mongoose';
import Job from '../models/jobModel.js';
import UploadBatch from '../models/uploadBatchModel.js';
import { r2Service, runtimeConfig, uploadBatchService } from '../services/runtimeServices.js';
import { PRIORITY_FOLDER_NAME, UploadBatchError } from '../services/uploadBatchService.js';
import { appEvents } from '../services/appEvents.js';
import { operationalMetrics } from '../services/operationalMetrics.js';
import { qualityGeminiLimiter, qualityKeyScheduler } from '../services/qualityGeminiExecutors.js';
import { buildPublicJobUpdate, buildPublicQualitySummary } from '../services/qualityPublicView.js';
import { buildQualityReviewHeader, prependQualityReviewHeader } from '../services/qualityReviewMarkdown.js';
import {
    GeminiDiagnosticProbeError,
    geminiDiagnosticProbe,
} from '../services/geminiDiagnosticProbe.js';

const QUALITY_REVIEW_FIELDS = [
    'chunkIndex',
    'content',
    'pageStart',
    'pageEnd',
    'repairCount',
    'qualityStatus',
    'verificationReport',
    'reverifyReport',
    'qualityReviewReason',
].join(' ');
const UI_JOB_EVENT_THROTTLE_MS = 250;

async function getReviewChunks(jobId, job) {
    if (job?.status !== 'completed' || job?.translationMode !== 'quality') return [];
    return TranslationChunk.find({ jobId, qualityStatus: 'needs_review' }, QUALITY_REVIEW_FIELDS)
        .sort({ chunkIndex: 1 })
        .lean();
}

function sendUploadBatchError(res, error) {
    if (error instanceof UploadBatchError) {
        return res.status(error.status).json({ error: error.message, code: error.code });
    }
    throw error;
}

export function buildGeminiKeyStatusPayload(scheduler = qualityKeyScheduler) {
    const keys = scheduler.publicStatus();
    return {
        keyCount: keys.length,
        keys,
        quota: scheduler.quotaAggregate(),
    };
}

export const getGeminiKeyStatus = (_req, res) => {
    res.status(200).json(buildGeminiKeyStatusPayload());
};

export const runGeminiDiagnosticProbe = async (req, res) => {
    try {
        res.status(200).json(await geminiDiagnosticProbe.run(req.body?.model));
    } catch (error) {
        if (error instanceof GeminiDiagnosticProbeError) {
            if (error.retryAfterSeconds) {
                res.setHeader('Retry-After', String(error.retryAfterSeconds));
            }
            return res.status(error.status).json({
                error: error.message,
                code: error.code,
                ...(error.retryAfterSeconds
                    ? { retryAfterSeconds: error.retryAfterSeconds }
                    : {}),
            });
        }
        return res.status(500).json({
            error: 'Không thể chạy Gemini diagnostic probe.',
            code: 'PROBE_INTERNAL_ERROR',
        });
    }
};

export const prepareUploadBatch = async (req, res) => {
    try {
        res.status(201).json(await uploadBatchService.prepareBatch(req.body));
    } catch (error) {
        operationalMetrics.increment('upload.prepare.errors');
        try { return sendUploadBatchError(res, error); }
        catch { return res.status(500).json({ error: 'Không thể chuẩn bị upload batch.' }); }
    }
};

export const confirmUploadBatch = async (req, res) => {
    try {
        const jobIds = Array.isArray(req.body?.items)
            ? req.body.items.map(item => item?.jobId)
            : [];
        const result = await uploadBatchService.confirmBatch(req.params.batchId, jobIds);
        if (result.items.some(item => item.status === 'pending')) void translationQueue.startWorker();
        res.status(200).json(result);
    } catch (error) {
        operationalMetrics.increment('upload.confirm.errors');
        try { return sendUploadBatchError(res, error); }
        catch { return res.status(500).json({ error: 'Không thể xác nhận upload batch.' }); }
    }
};

export const getUploadBatchStatus = async (req, res) => {
    try {
        res.status(200).json(await uploadBatchService.getBatchStatus(req.params.batchId));
    } catch (error) {
        try { return sendUploadBatchError(res, error); }
        catch { return res.status(500).json({ error: 'Không thể đọc trạng thái upload batch.' }); }
    }
};

export const listUploadBatches = async (req, res) => {
    try {
        const requestedLimit = Number.parseInt(req.query.limit || '20', 10);
        res.status(200).json({ items: await uploadBatchService.listRecentBatches(requestedLimit) });
    } catch {
        res.status(500).json({ error: 'Không thể đọc danh sách upload batch.' });
    }
};

export const abandonUploadBatchItems = async (req, res) => {
    try {
        const jobIds = Array.isArray(req.body?.items) ? req.body.items.map(item => item?.jobId) : [];
        res.status(200).json(await uploadBatchService.abandonItems(req.params.batchId, jobIds));
    } catch (error) {
        try { return sendUploadBatchError(res, error); }
        catch { return res.status(500).json({ error: 'Không thể bỏ các file upload lỗi.' }); }
    }
};

// API 1: Bọc try-catch, dùng Promise.all để ghi đa file vào DB
export const uploadFiles = async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'Không tìm thấy file nào được tải lên.' });
        }

        // [THÊM MỚI] Trích xuất tên thư mục từ request, nếu không có thì để "Mặc định"
        if (typeof req.body.priority !== 'undefined' && !['true', 'false'].includes(req.body.priority)) {
            return res.status(400).json({ error: 'priority không hợp lệ.' });
        }
        const priority = req.body.priority === 'true';
        const requestedFolderName = (req.body.folderName || 'Mặc định').trim().slice(0, 120) || 'Mặc định';
        if (!priority && requestedFolderName.localeCompare(PRIORITY_FOLDER_NAME, 'vi', { sensitivity: 'base' }) === 0) {
            return res.status(400).json({ error: `Tên thư mục ${PRIORITY_FOLDER_NAME} chỉ dùng cho hàng đợi ưu tiên.` });
        }
        const folderName = priority
            ? PRIORITY_FOLDER_NAME
            : requestedFolderName;
        const clientUploadId = typeof req.body.clientUploadId === 'string'
            ? req.body.clientUploadId.trim().slice(0, 100)
            : null;
        const jobs = [];
        const failures = [];

        for (const file of req.files) {
            try {
                jobs.push(await translationQueue.addJob(file, folderName, clientUploadId, priority));
            } catch (error) {
                await translationQueue.safeUnlink(file.path);
                failures.push({ originalName: file.originalname, error: 'Không thể tạo job trong MongoDB.' });
                console.error(`[UPLOAD] Không thể tạo job cho ${file.originalname}:`, error.message);
            }
        }

        if (jobs.length === 0) {
            return res.status(500).json({
                error: 'Không thể tạo job cho các file đã tải lên.',
                failures
            });
        }
        
        res.status(failures.length > 0 ? 207 : 200).json({
            message: 'Đã đưa vào hàng chờ xử lý trên Cloud/Database', 
            jobs: jobs.map(j => ({ 
                jobId: j.jobId, 
                originalName: j.originalName, 
                status: j.status,
                folderName: j.folderName 
            })),
            failures
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// API 2: Đổi thành Async
export const getJobsSummary = async (req, res) => {
    try {
        const requestedLimit = Number.parseInt(req.query.limit || '100', 10);
        const limit = Math.min(200, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 100));
        const cursor = req.query.cursor || null;
        if (cursor && !mongoose.isValidObjectId(cursor)) {
            return res.status(400).json({ error: 'Cursor không hợp lệ.' });
        }

        const page = await translationQueue.getJobsSummary({ limit, cursor });
        res.status(200).json(page);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const getJobStats = async (_req, res) => {
    try {
        res.status(200).json(await translationQueue.getJobStats());
    } catch {
        res.status(500).json({ error: 'Không thể đọc thống kê công việc.' });
    }
};

// API 3: Trích xuất qua ID từ Database
export const getJobResult = async (req, res) => {
    try {
        const { jobId } = req.params;
        const job = await translationQueue.getJobResult(jobId);
        
        if (!job) return res.status(404).json({ error: 'Không tìm thấy công việc này.' });
        if (job.status !== 'completed') return res.status(400).json({ error: 'Tài liệu chưa dịch xong.' });
        
        if (job.result) {
            const quality = buildPublicQualitySummary(job);
            const header = buildQualityReviewHeader({ job, reviewChunks: await getReviewChunks(jobId, job) });
            const result = prependQualityReviewHeader(job.result, header);
            return res.status(200).json(quality ? { result, quality } : { result });
        }

        const [chunks, reviewChunks] = await Promise.all([
            TranslationChunk.find({ jobId, content: { $type: 'string' } }, 'content chunkIndex')
                .sort({ chunkIndex: 1 })
                .lean(),
            getReviewChunks(jobId, job),
        ]);
        const header = buildQualityReviewHeader({ job, reviewChunks });
        const result = prependQualityReviewHeader(chunks.map(chunk => chunk.content).join('\n\n'), header);
        const quality = buildPublicQualitySummary(job);
        res.status(200).json(quality ? { result, quality } : { result });
    } catch (error) {
         res.status(500).json({ error: error.message });
    }
};

// API 4: Luồng SSE (Giữ kết nối mở cho Cloud)
export const streamLogs = (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders(); 

    res.write(`data: ${JSON.stringify({ type: 'connected', msg: 'SSE Stream Ready' })}\n\n`);

    // [THÊM MỚI] Cơ chế Heartbeat ép Proxy/Load Balancer không ngắt mạng
    const heartbeat = setInterval(() => {
        // Gửi ký tự comment rỗng theo chuẩn SSE, phía Frontend sẽ tự động bỏ qua
        res.write(`: keep-alive-ping\n\n`);
    }, 15000); 

    const pendingJobUpdates = new Map();
    const jobUpdateTimers = new Map();
    const lastJobUpdateAt = new Map();
    const writeJobUpdate = job => {
        lastJobUpdateAt.set(job.jobId, Date.now());
        res.write(`data: ${JSON.stringify(buildPublicJobUpdate(job))}\n\n`);
    };
    const onJobUpdated = job => {
        const terminal = ['completed', 'failed', 'cancelled'].includes(job.status);
        const elapsed = Date.now() - (lastJobUpdateAt.get(job.jobId) || 0);
        if (terminal || elapsed >= UI_JOB_EVENT_THROTTLE_MS) {
            clearTimeout(jobUpdateTimers.get(job.jobId));
            jobUpdateTimers.delete(job.jobId);
            pendingJobUpdates.delete(job.jobId);
            writeJobUpdate(job);
            return;
        }
        pendingJobUpdates.set(job.jobId, job);
        if (jobUpdateTimers.has(job.jobId)) return;
        jobUpdateTimers.set(job.jobId, setTimeout(() => {
            jobUpdateTimers.delete(job.jobId);
            const latest = pendingJobUpdates.get(job.jobId);
            pendingJobUpdates.delete(job.jobId);
            if (latest) writeJobUpdate(latest);
        }, Math.max(1, UI_JOB_EVENT_THROTTLE_MS - elapsed)));
    };

    const onJobLog = ({ jobId, msg }) => {
        const payload = { type: 'log', jobId, msg };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    // [THÊM MỚI] Lắng nghe sự thay đổi trạng thái Ngủ đông
    const onSystemStatusChanged = (statusPayload) => {
        const payload = { type: 'systemStatus', data: statusPayload };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const onBatchUpdated = (batch) => {
        res.write(`data: ${JSON.stringify({ type: 'batchStatus', data: batch })}\n\n`);
    };

    const onSourceCleanup = (cleanup) => {
        res.write(`data: ${JSON.stringify({ type: 'sourceCleanup', data: cleanup })}\n\n`);
    };

    translationQueue.on('systemStatusChanged', onSystemStatusChanged);
    translationQueue.on('jobUpdated', onJobUpdated);
    translationQueue.on('jobLog', onJobLog);
    appEvents.on('batchUpdated', onBatchUpdated);
    appEvents.on('sourceCleanup', onSourceCleanup);

    req.on('close', () => {
        translationQueue.off('systemStatusChanged', onSystemStatusChanged); // Bổ sung off event
        translationQueue.off('jobUpdated', onJobUpdated);
        translationQueue.off('jobLog', onJobLog);
        appEvents.off('batchUpdated', onBatchUpdated);
        appEvents.off('sourceCleanup', onSourceCleanup);
        for (const timer of jobUpdateTimers.values()) clearTimeout(timer);
        jobUpdateTimers.clear();
        pendingJobUpdates.clear();
        clearInterval(heartbeat); // Ngăn rò rỉ bộ nhớ (Memory Leak)
        res.end();
    });
};

// API 5: Xóa tiến trình khỏi Database
export const deleteJob = async (req, res) => {
    try {
        const { jobId } = req.params;
        const result = await translationQueue.cancelAndDeleteJob(jobId);

        if (!result.found) {
            return res.status(404).json({ error: 'Không tìm thấy tiến trình để xóa.' });
        }

        res.status(result.pending ? 202 : 200).json({
            message: result.pending
                ? 'Đã gửi yêu cầu hủy. Tiến trình sẽ được dọn sau khi request hiện tại dừng.'
                : 'Đã xóa tiến trình thành công.',
            pending: result.pending
        });
    } catch (error) {
         res.status(500).json({ error: error.message });
    }
};

// API 6: Xóa hàng loạt tiến trình (Tối ưu Database I/O bằng deleteMany)
export const bulkDeleteJobs = async (req, res) => {
    try {
        const { jobIds } = req.body; // Nhận mảng các jobId từ Frontend
        
        if (!Array.isArray(jobIds) || jobIds.length === 0 || jobIds.length > 500 || jobIds.some(id => typeof id !== 'string')) {
            return res.status(400).json({ error: 'Danh sách ID không hợp lệ.' });
        }

        const result = await translationQueue.cancelAndDeleteJobs([...new Set(jobIds)]);
        
        res.status(result.pendingCount > 0 ? 202 : 200).json({
            message: `Đã xử lý ${result.foundCount} tiến trình; ${result.pendingCount} tiến trình đang chờ hủy.`,
            deletedCount: result.foundCount - result.pendingCount,
            pendingCount: result.pendingCount
        });
    } catch (error) {
         res.status(500).json({ error: error.message });
    }
};

// API 7: Lấy trạng thái hệ thống (Kiểm tra xem có đang ngủ đông không)
export const getSystemStatus = async (req, res) => {
    try {
        const [readiness, cleanupBacklog, uploadBacklog] = await Promise.all([
            r2Service.checkReadiness().catch(() => ({ configured: true, available: false })),
            Job.countDocuments({ sourceCleanupState: { $in: ['pending', 'retry'] } }),
            UploadBatch.countDocuments({ status: { $in: ['uploading', 'partial'] } }),
        ]);
        res.status(200).json({
            ...translationQueue.getSystemStatus(),
            maintenance: { controlEnabled: Boolean(runtimeConfig.maintenanceControlToken) },
            storage: {
                configured: readiness.configured,
                available: readiness.available,
                cleanupBacklog,
                uploadBacklog,
            },
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const getOperationalMetrics = async (req, res) => {
    try {
        const cleanupBacklog = await Job.countDocuments({ sourceCleanupState: { $in: ['pending', 'retry'] } });
        const metrics = operationalMetrics.snapshot();
        const elapsedHours = Math.max(
            1 / 3600,
            (Date.now() - new Date(metrics.startedAt).getTime()) / 3_600_000
        );
        const pagesCompleted = metrics.counters['translation.pages_completed'] || 0;
        const queueStatus = translationQueue.getSystemStatus();
        res.status(200).json({
            ...metrics,
            gauges: {
                ...metrics.gauges,
                cleanupBacklog,
                pagesPerHour: pagesCompleted / elapsedHours,
            },
            gemini: qualityKeyScheduler.metricsSnapshot(),
            dispatcher: {
                ...qualityGeminiLimiter.snapshot(),
                ...queueStatus.dispatcher,
            },
            geminiKeyPool: qualityKeyScheduler.snapshot(),
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// [THÊM MỚI] API 8: Ép hệ thống thức dậy thủ công
export const forceWakeUpSystem = async (req, res) => {
    try {
        // Cần await vì forceWakeUp trong queueManager.js là hàm async
        const isWokenUp = await translationQueue.forceWakeUp();
        
        if (isWokenUp) {
            res.status(200).json({ message: 'Đã ép hệ thống thức dậy thành công!' });
        } else {
            res.status(400).json({ message: 'Hệ thống hiện không ở trạng thái ngủ đông.' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const getFolderJobsSummary = async (req, res) => {
    try {
        const requestedLimit = Number.parseInt(req.query.limit || '100', 10);
        const limit = Math.min(100, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 100));
        const cursor = req.query.cursor || null;
        const requestedFolderName = typeof req.params.folderName === 'string' ? req.params.folderName.trim() : '';
        if (!requestedFolderName || requestedFolderName.length > 120) {
            return res.status(400).json({ error: 'Tên thư mục không hợp lệ.' });
        }
        if (cursor && !mongoose.isValidObjectId(cursor)) {
            return res.status(400).json({ error: 'Cursor không hợp lệ.' });
        }
        const folderName = requestedFolderName.localeCompare(PRIORITY_FOLDER_NAME, 'vi', { sensitivity: 'base' }) === 0
            ? PRIORITY_FOLDER_NAME
            : requestedFolderName;
        res.status(200).json(await translationQueue.getFolderJobsSummary({ folderName, limit, cursor }));
    } catch {
        res.status(500).json({ error: 'Không thể đọc danh sách tài liệu của thư mục.' });
    }
};

export const getTerminalFailures = async (req, res) => {
    try {
        const requestedLimit = Number.parseInt(req.query.limit || '100', 10);
        const limit = Math.min(200, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 100));
        const cursor = req.query.cursor || null;
        if (cursor && !mongoose.isValidObjectId(cursor)) return res.status(400).json({ error: 'Cursor không hợp lệ.' });
        res.status(200).json(await translationQueue.getTerminalFailures({ limit, cursor }));
    } catch {
        res.status(500).json({ error: 'Không thể đọc danh sách file cần xử lý.' });
    }
};

export const retryTerminalFailures = async (_req, res) => {
    try {
        res.status(200).json(await translationQueue.retryTerminalFailures());
    } catch {
        res.status(500).json({ error: 'Không thể thử lại các file có thể phục hồi.' });
    }
};

export const pauseForRedeploy = (_req, res) => {
    const status = translationQueue.pauseForRedeploy();
    res.status(200).json({
        message: status.worker.activeJobs > 0
            ? `Đã dừng nhận job mới. Chờ ${status.worker.activeJobs} job đang chạy hoàn tất trước khi redeploy.`
            : 'Hàng đợi đã dừng an toàn; có thể redeploy.',
        ...status,
    });
};

export const cancelRedeployPause = async (_req, res) => {
    try {
        const status = await translationQueue.cancelRedeployPause();
        res.status(200).json({ message: 'Đã tiếp tục nhận job mới.', ...status });
    } catch {
        res.status(500).json({ error: 'Không thể tiếp tục hàng đợi.' });
    }
};

// [THÊM MỚI] API 9: Xóa toàn bộ hàng đợi của một thư mục (Bao gồm DB và File vật lý)
export const deleteFolderQueue = async (req, res) => {
    try {
        const { folderName } = req.params;
        
        const result = await translationQueue.cancelAndDeleteFolder(folderName);
        
        res.status(result.pendingCount > 0 ? 202 : 200).json({
            message: `Đã xử lý thư mục [${folderName}] với ${result.foundCount} tiến trình.`,
            deletedCount: result.foundCount - result.pendingCount,
            pendingCount: result.pendingCount
        });
    } catch (error) {
         res.status(500).json({ error: error.message });
    }
};

export const downloadJobResult = async (req, res) => {
    try {
        const { jobId } = req.params;
        const job = await translationQueue.getJobResult(jobId);
        if (!job) return res.status(404).json({ error: 'Không tìm thấy công việc này.' });
        if (job.status !== 'completed') return res.status(400).json({ error: 'Tài liệu chưa dịch xong.' });

        const baseName = (job.originalName || 'tai-lieu').replace(/\.pdf$/i, '');
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${baseName}_vi.md`)}`);

        const header = buildQualityReviewHeader({ job, reviewChunks: await getReviewChunks(jobId, job) });
        if (job.result) {
            return res.end(prependQualityReviewHeader(job.result, header));
        }

        let firstChunk = !header;
        if (header) res.write(header);
        const cursor = TranslationChunk.find({ jobId, content: { $type: 'string' } }, 'content chunkIndex')
            .sort({ chunkIndex: 1 })
            .cursor();
        for await (const chunk of cursor) {
            if (!firstChunk) res.write('\n\n');
            res.write(chunk.content);
            firstChunk = false;
        }
        res.end();
    } catch (error) {
        if (!res.headersSent) res.status(500).json({ error: error.message });
        else res.end();
    }
};
