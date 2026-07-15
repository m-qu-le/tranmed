import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import '../src/config/env.js';
import Job from '../src/models/jobModel.js';
import System from '../src/models/systemModel.js';
import TranslationChunk from '../src/models/translationChunkModel.js';

const mongodbUri = process.env.MONGODB_URI?.trim();
if (!mongodbUri) {
    console.error('❌ Thiếu biến môi trường MONGODB_URI.');
    process.exit(1);
}

function findIndex(indexes, key) {
    const expectedKey = JSON.stringify(key);
    return indexes.find(index => JSON.stringify(index.key) === expectedKey);
}

try {
    await mongoose.connect(mongodbUri, { serverSelectionTimeoutMS: 5000 });

    const [jobIndexes, systemIndexes, chunkIndexes, totals] = await Promise.all([
        Job.collection.indexes(),
        System.collection.indexes(),
        TranslationChunk.collection.indexes(),
        Promise.all([
            Job.countDocuments({}),
            System.countDocuments({}),
            TranslationChunk.countDocuments({})
        ])
    ]);

    const requiredIndexes = {
        jobId: findIndex(jobIndexes, { jobId: 1 }),
        clientUploadId: findIndex(jobIndexes, { clientUploadId: 1 }),
        systemKey: findIndex(systemIndexes, { key: 1 }),
        translationChunk: findIndex(chunkIndexes, { jobId: 1, chunkIndex: 1 })
    };

    for (const [name, index] of Object.entries(requiredIndexes)) {
        assert(index, `Thiếu index ${name}.`);
        assert.equal(index.unique, true, `Index ${name} phải là unique.`);
    }
    assert.equal(requiredIndexes.clientUploadId.sparse, true, 'clientUploadId phải là sparse.');

    console.log('✅ P001 production verification đạt:', {
        totals: {
            jobs: totals[0],
            systems: totals[1],
            translationChunks: totals[2]
        },
        uniqueIndexes: Object.fromEntries(
            Object.entries(requiredIndexes).map(([name, index]) => [name, index.name])
        )
    });
} catch (error) {
    console.error('❌ P001 production verification thất bại:', error.message);
    process.exitCode = 1;
} finally {
    await mongoose.disconnect();
}
