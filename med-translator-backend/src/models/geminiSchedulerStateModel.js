import mongoose from 'mongoose';

const geminiSchedulerStateSchema = new mongoose.Schema({
    schedulerId: { type: String, required: true, unique: true },
    currentGroupIndex: { type: Number, min: 0, default: 0 },
    lastRotatedAt: { type: Date, default: null },
    rotationReason: { type: String, default: null },
    executionVersion: { type: String, default: null },
}, { timestamps: true });

export default mongoose.model('GeminiSchedulerState', geminiSchedulerStateSchema);
