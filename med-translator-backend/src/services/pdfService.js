import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import path from 'path';
import { ErrorCodes, ProcessingError } from '../utils/processingError.js';
import { PDF_PAGES_PER_CHUNK } from '../config/env.js';

// Xác định đường dẫn tuyệt đối đến file pdfWorker.js
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const processPdf = (filePath, signal) => {
    // Đóng gói tác vụ thành một Promise để QueueManager vẫn dùng được await như cũ
    return new Promise((resolve, reject) => {
        console.log("⚙️ [MAIN THREAD] Đang bàn giao tác vụ băm PDF sang Worker Thread...");
        
        const workerPath = path.resolve(__dirname, '../workers/pdfWorker.js');
        
        // Worker tự đọc file để Main Thread không giữ thêm một bản PDF lớn trong RAM.
        const worker = new Worker(workerPath, {
            workerData: { filePath, pagesPerChunk: PDF_PAGES_PER_CHUNK }
        });
        let settled = false;
        const settle = (callback, value) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            callback(value);
        };
        const onAbort = () => {
            void worker.terminate();
            settle(reject, new ProcessingError(ErrorCodes.CANCELLED, 'Tác vụ đã được hủy khi đang cắt PDF.'));
        };
        // Lắng nghe tín hiệu từ Worker trả về
        worker.on('message', (message) => {
            if (message.success) {
                console.log(`✅ [WORKER] Cắt thành công! Sách có ${message.totalPages} trang, chia thành ${message.chunkBuffers.length} chunk nhỏ.`);
                settle(resolve, message.chunkBuffers); // Trả mảng chunks về cho queueManager
            } else {
                settle(reject, new Error(message.error));
            }
        });

        // Xử lý các trường hợp ngoại khoa (lỗi vỡ luồng)
        worker.on('error', (err) => {
            console.error("❌ [WORKER ERROR]:", err);
            settle(reject, err);
        });

        worker.on('exit', (code) => {
            if (code !== 0) {
                settle(reject, new Error(`Worker Thread bị ngắt đột ngột với mã lỗi ${code}`));
            }
        });

        if (signal?.aborted) {
            onAbort();
            return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
    });
};
