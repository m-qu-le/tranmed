import mongoose from 'mongoose';

const requestEventSchema = new mongoose.Schema({
    id: { type: Number, required: true },
    at: { type: Date, required: true },
    count: { type: Number, required: true, min: 0 },
    kind: { type: String, enum: ['normal', 'retry'], required: true },
}, { _id: false });

const geminiQuotaStateSchema = new mongoose.Schema({
    projectId: { type: String, required: true, unique: true },
    requestEvents: { type: [requestEventSchema], default: () => [] },
    quotaDay: { type: String, default: null },
    dailyNormalCount: { type: Number, default: 0, min: 0 },
    dailyRetryCount: { type: Number, default: 0, min: 0 },
    cooldownUntil: { type: Date, default: null },
    disabled: { type: Boolean, default: false },
    hasSucceeded: { type: Boolean, default: false },
    lastSuccessAt: { type: Date, default: null },
    lastReservedAt: { type: Date, default: null },
}, { timestamps: true });

geminiQuotaStateSchema.index({ cooldownUntil: 1 });

export default mongoose.model('GeminiQuotaState', geminiQuotaStateSchema);
