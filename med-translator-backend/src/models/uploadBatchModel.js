import mongoose from 'mongoose';

const uploadManifestItemSchema = new mongoose.Schema({
    jobId: { type: String, required: true },
    clientUploadId: { type: String, required: true },
    originalName: { type: String, required: true, maxlength: 255 },
    sourceSize: { type: Number, min: 0, default: null },
}, { _id: false });

const uploadBatchSchema = new mongoose.Schema({
    batchId: { type: String, required: true, unique: true },
    clientBatchId: { type: String, unique: true, sparse: true },
    folderName: { type: String, required: true, maxlength: 120 },
    priority: { type: Number, enum: [0, 1], default: 0 },
    status: {
        type: String,
        enum: ['uploading', 'ready', 'partial', 'failed', 'completed', 'cancelled'],
        default: 'uploading',
    },
    totalFiles: { type: Number, required: true, min: 1 },
    totalBytes: { type: Number, required: true, min: 0 },
    confirmedFiles: { type: Number, default: 0, min: 0 },
    confirmedBytes: { type: Number, default: 0, min: 0 },
    failedFiles: { type: Number, default: 0, min: 0 },
    skippedFiles: { type: Number, default: 0, min: 0 },
    readyAt: { type: Date, default: null },
    // Manifest bất biến là nguồn sự thật để có thể tái tạo một Job bị mất.
    items: { type: [uploadManifestItemSchema], default: [] },
}, {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
});

uploadBatchSchema.virtual('canCloseClient').get(function canCloseClient() {
    return this.status === 'ready' && this.confirmedFiles + this.skippedFiles === this.totalFiles;
});

uploadBatchSchema.pre('validate', function validateBatchCounts() {
    if (this.confirmedFiles + this.failedFiles + this.skippedFiles > this.totalFiles) {
        this.invalidate('confirmedFiles', 'Tổng confirmed/failed không được vượt totalFiles.');
    }
    if (this.confirmedBytes > this.totalBytes) {
        this.invalidate('confirmedBytes', 'confirmedBytes không được vượt totalBytes.');
    }
    if (this.status === 'ready' && this.confirmedFiles + this.skippedFiles !== this.totalFiles) {
        this.invalidate('status', 'Batch ready phải xác nhận hoặc bỏ qua đủ toàn bộ file.');
    }
    if (this.items.length > 0) {
        if (this.items.length !== this.totalFiles) {
            this.invalidate('items', 'Manifest item phải khớp totalFiles.');
        }
        if (new Set(this.items.map(item => item.jobId)).size !== this.items.length
            || new Set(this.items.map(item => item.clientUploadId)).size !== this.items.length) {
            this.invalidate('items', 'Manifest item không được trùng jobId/clientUploadId.');
        }
    }
});

uploadBatchSchema.index({ status: 1, updatedAt: 1 });
uploadBatchSchema.index({ folderName: 1, createdAt: -1 });

export default mongoose.model('UploadBatch', uploadBatchSchema);
