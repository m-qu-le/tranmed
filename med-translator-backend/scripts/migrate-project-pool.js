import mongoose from 'mongoose';
import '../src/config/env.js';
import { getGeminiProjectIds } from '../src/config/env.js';
import Job from '../src/models/jobModel.js';
import TranslationChunk from '../src/models/translationChunkModel.js';
import GeminiQuotaState from '../src/models/geminiQuotaStateModel.js';
import { runProjectPoolMigration } from '../src/migrations/projectPoolMigration.js';
import { redactError } from '../src/utils/redactSecrets.js';

const mongodbUri = process.env.MONGODB_URI?.trim();
const dryRun = process.argv.includes('--dry-run');
if (!mongodbUri) {
    console.error('Thiếu biến môi trường MONGODB_URI.');
    process.exit(1);
}

try {
    await mongoose.connect(mongodbUri, { serverSelectionTimeoutMS: 5000 });
    const result = await runProjectPoolMigration({
        Job,
        TranslationChunk,
        GeminiQuotaState,
        projectIds: getGeminiProjectIds(),
        dryRun,
    });
    console.log(`Project-pool migration ${dryRun ? 'dry-run' : 'hoàn thành'}:`, result);
} catch (error) {
    console.error('Project-pool migration thất bại:', redactError(error));
    process.exitCode = 1;
} finally {
    await mongoose.disconnect();
}
