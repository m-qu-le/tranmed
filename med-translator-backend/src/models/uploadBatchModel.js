import mongoose from 'mongoose';

const uploadBatchSchema = new mongoose.Schema({
    batchId: { type: String, required: true, unique: true },
    clientBatchId: { type: String, unique: true, sparse: true },
    folderName: { type: String, required: true, maxlength: 120 },
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
    readyAt: { type: Date, default: null },
}, {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
});

uploadBatchSchema.virtual('canCloseClient').get(function canCloseClient() {
    return this.status === 'ready' && this.confirmedFiles === this.totalFiles;
});

uploadBatchSchema.pre('validate', function validateBatchCounts() {
    if (this.confirmedFiles + this.failedFiles > this.totalFiles) {
        this.invalidate('confirmedFiles', 'Tổng confirmed/failed không được vượt totalFiles.');
    }
    if (this.confirmedBytes > this.totalBytes) {
        this.invalidate('confirmedBytes', 'confirmedBytes không được vượt totalBytes.');
    }
    if (this.status === 'ready' && this.confirmedFiles !== this.totalFiles) {
        this.invalidate('status', 'Batch ready phải xác nhận đủ toàn bộ file.');
    }
});

uploadBatchSchema.index({ status: 1, updatedAt: 1 });
uploadBatchSchema.index({ folderName: 1, createdAt: -1 });

export default mongoose.model('UploadBatch', uploadBatchSchema);
