import mongoose from 'mongoose';
import { QUALITY_ACTIONS } from '../services/qualityPipelineState.js';

const jobSchema = new mongoose.Schema({
    jobId: { type: String, required: true, unique: true },
    clientUploadId: { type: String },
    originalName: { type: String, required: true },
    folderName: { type: String, default: 'Mặc định' }, // [THÊM MỚI] Nhóm các file lại thành thư mục
    priority: { type: Number, enum: [0, 1], default: 0 },
    filePath: { type: String, default: null },
    status: { 
        type: String, 
        enum: ['uploading', 'pending', 'processing', 'completed', 'failed', 'cancelled'],
        default: 'pending' 
    },
    storageProvider: { type: String, enum: ['local', 'r2'], default: null },
    storageKey: { type: String, default: null },
    sourceSize: { type: Number, min: 0, default: null },
    sourceEtag: { type: String, default: null },
    sourceState: {
        type: String,
        enum: ['prepared', 'ready', 'delete_pending', 'deleted', 'missing'],
        default: null
    },
    uploadBatchId: { type: String, default: null },
    uploadConfirmedAt: { type: Date, default: null },
    sourceDeletedAt: { type: Date, default: null },
    sourceCleanupState: {
        type: String,
        enum: ['not_required', 'pending', 'retry', 'succeeded'],
        default: null
    },
    sourceCleanupAttempts: { type: Number, default: 0, min: 0 },
    sourceCleanupNextRetryAt: { type: Date, default: null },
    sourceCleanupLastError: { type: String, default: null },
    result: { type: String, default: null }, // Legacy: job mới lưu nội dung theo TranslationChunk
    error: { type: String, default: null },
    errorCode: { type: String, default: null },
    attemptCount: { type: Number, default: 0, min: 0 },
    maxAttempts: { type: Number, default: 3, min: 1 },
    quotaRetryCount: { type: Number, default: 0, min: 0 },
    nextRetryAt: { type: Date, default: null },
    cancelRequested: { type: Boolean, default: false },
    processingToken: { type: String, default: null },
    leaseExpiresAt: { type: Date, default: null },
    chunkCount: { type: Number, default: 0, min: 0 },
    completedChunks: { type: Number, default: 0, min: 0 },
    translationPipelineVersion: { type: String, default: null },
    translationMode: { type: String, enum: ['legacy', 'quality'], default: null },
    currentQualityStage: { type: String, enum: QUALITY_ACTIONS, default: null },
    qualityContextVersion: { type: String, default: null },
    qualityDocumentContext: { type: mongoose.Schema.Types.Mixed, default: null },
    qualityContextUsage: { type: mongoose.Schema.Types.Mixed, default: null },
    qualityContextGeneratedAt: { type: Date, default: null },
    passedChunks: { type: Number, default: 0, min: 0 },
    needsReviewChunks: { type: Number, default: 0, min: 0 },
    qualityWarnings: [{
        chunkIndex: { type: Number, min: 0 },
        pageStart: { type: Number, min: 1 },
        pageEnd: { type: Number, min: 1 },
    }]
}, { timestamps: true });

jobSchema.pre('validate', function validateSourceInvariant() {
    const hasLocalSource = Boolean(this.filePath);
    const hasR2Source = this.storageProvider === 'r2' && Boolean(this.storageKey);
    if (!hasLocalSource && !hasR2Source) {
        this.invalidate('filePath', 'Job phải tham chiếu file local hoặc object R2.');
    }

    if (this.storageProvider === 'r2') {
        if (!this.storageKey) this.invalidate('storageKey', 'Job R2 bắt buộc có storageKey.');
        if (!this.uploadBatchId) this.invalidate('uploadBatchId', 'Job R2 bắt buộc có uploadBatchId.');
        if (this.status === 'uploading' && this.sourceState !== 'prepared') {
            this.invalidate('sourceState', 'Job uploading phải có sourceState=prepared.');
        }
        if (this.status === 'pending' && this.sourceState !== 'ready') {
            this.invalidate('sourceState', 'Job pending trên R2 phải có sourceState=ready.');
        }
    }

    if (this.sourceDeletedAt && this.sourceState !== 'deleted') {
        this.invalidate('sourceDeletedAt', 'sourceDeletedAt chỉ được đặt sau khi sourceState=deleted.');
    }
    if (this.sourceState === 'deleted' && !this.sourceDeletedAt) {
        this.invalidate('sourceState', 'sourceState=deleted bắt buộc có sourceDeletedAt.');
    }
    if (this.translationMode === 'quality' && !this.translationPipelineVersion) {
        this.invalidate('translationPipelineVersion', 'Job quality bắt buộc có translationPipelineVersion.');
    }
});

// ============================================================================
// [KIẾN TRÚC TỐI ƯU HÓA I/O DATABASE - INDEXING STRATEGY]
// ============================================================================

// 1. Index Đơn (Single Index): Giải quyết dứt điểm lỗi "Sort exceeded 32MB RAM" 
// trên API GET /jobs bằng cách map thẳng thứ tự giảm dần vào ổ cứng của MongoDB.
jobSchema.index({ createdAt: -1 });

// 2. Index Phức hợp (Compound Index) #1: Tối ưu cho hàm startWorker()
// Truy vấn: Job.findOne({ status: 'pending' }).sort({ createdAt: 1 })
// Tránh Full Collection Scan khi hàng đợi có hàng ngàn file.
jobSchema.index({ status: 1, priority: -1, createdAt: 1, _id: 1 });

// Claim job đến hạn và phục hồi processing lease đã hết hạn.
jobSchema.index({ status: 1, nextRetryAt: 1, createdAt: 1 });
jobSchema.index({ status: 1, leaseExpiresAt: 1 });
jobSchema.index({ status: 1, sourceState: 1, createdAt: 1 });

// 3. Index Phức hợp (Compound Index) #2: Tối ưu cho cơ chế Auto-Recovery (Sweeper)
// Truy vấn: Job.updateMany({ status: 'failed', updatedAt: { $lte: thirtyMinsAgo } })
jobSchema.index({ status: 1, updatedAt: 1 });

// 4. Index Đơn: Tăng tốc độ thực thi API Xóa toàn bộ hàng đợi của một thư mục
// Truy vấn: Job.deleteMany({ folderName })
jobSchema.index({ folderName: 1 });
jobSchema.index({ clientUploadId: 1 }, { unique: true, sparse: true });
jobSchema.index({ storageKey: 1 }, { unique: true, sparse: true });
jobSchema.index({ uploadBatchId: 1, createdAt: 1 });
jobSchema.index({ sourceState: 1, updatedAt: 1 });
jobSchema.index({ sourceCleanupState: 1, sourceCleanupNextRetryAt: 1 });

export default mongoose.model('Job', jobSchema);
