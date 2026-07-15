import mongoose from 'mongoose';

const translationChunkSchema = new mongoose.Schema({
    jobId: { type: String, required: true },
    chunkIndex: { type: Number, required: true, min: 0 },
    content: { type: String, required: true }
}, { timestamps: true });

translationChunkSchema.index({ jobId: 1, chunkIndex: 1 }, { unique: true });

export default mongoose.model('TranslationChunk', translationChunkSchema);
