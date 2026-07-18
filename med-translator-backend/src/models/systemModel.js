import mongoose from 'mongoose';

const systemSchema = new mongoose.Schema({
    key: { type: String, default: 'circuit_breaker', unique: true },
    isHibernating: { type: Boolean, default: false },
    stats: {
        startTime: String,
        wakeupTime: String,
        wakeupPolicy: String,
        hibernationCount: Number
    }
}, { timestamps: true });

export default mongoose.model('System', systemSchema);
