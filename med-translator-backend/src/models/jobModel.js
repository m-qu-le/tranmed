import mongoose from 'mongoose';

const jobSchema = new mongoose.Schema({
    jobId: { type: String, required: true, unique: true },
    clientUploadId: { type: String },
    originalName: { type: String, required: true },
    folderName: { type: String, default: 'Mặc định' }, // [THÊM MỚI] Nhóm các file lại thành thư mục
    filePath: { type: String, required: true },
    status: { 
        type: String, 
        enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'],
        default: 'pending' 
    },
    result: { type: String, default: null }, // Legacy: job mới lưu nội dung theo TranslationChunk
    error: { type: String, default: null },
    errorCode: { type: String, default: null },
    attemptCount: { type: Number, default: 0, min: 0 },
    maxAttempts: { type: Number, default: 3, min: 1 },
    nextRetryAt: { type: Date, default: null },
    cancelRequested: { type: Boolean, default: false },
    processingToken: { type: String, default: null },
    leaseExpiresAt: { type: Date, default: null },
    chunkCount: { type: Number, default: 0, min: 0 },
    completedChunks: { type: Number, default: 0, min: 0 }
}, { timestamps: true });

// ============================================================================
// [KIẾN TRÚC TỐI ƯU HÓA I/O DATABASE - INDEXING STRATEGY]
// ============================================================================

// 1. Index Đơn (Single Index): Giải quyết dứt điểm lỗi "Sort exceeded 32MB RAM" 
// trên API GET /jobs bằng cách map thẳng thứ tự giảm dần vào ổ cứng của MongoDB.
jobSchema.index({ createdAt: -1 });

// 2. Index Phức hợp (Compound Index) #1: Tối ưu cho hàm startWorker()
// Truy vấn: Job.findOne({ status: 'pending' }).sort({ createdAt: 1 })
// Tránh Full Collection Scan khi hàng đợi có hàng ngàn file.
jobSchema.index({ status: 1, createdAt: 1 });

// Claim job đến hạn và phục hồi processing lease đã hết hạn.
jobSchema.index({ status: 1, nextRetryAt: 1, createdAt: 1 });
jobSchema.index({ status: 1, leaseExpiresAt: 1 });

// 3. Index Phức hợp (Compound Index) #2: Tối ưu cho cơ chế Auto-Recovery (Sweeper)
// Truy vấn: Job.updateMany({ status: 'failed', updatedAt: { $lte: thirtyMinsAgo } })
jobSchema.index({ status: 1, updatedAt: 1 });

// 4. Index Đơn: Tăng tốc độ thực thi API Xóa toàn bộ hàng đợi của một thư mục
// Truy vấn: Job.deleteMany({ folderName })
jobSchema.index({ folderName: 1 });
jobSchema.index({ clientUploadId: 1 }, { unique: true, sparse: true });

export default mongoose.model('Job', jobSchema);
