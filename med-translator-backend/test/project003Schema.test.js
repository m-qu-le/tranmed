import assert from 'node:assert/strict';
import test from 'node:test';
import Job from '../src/models/jobModel.js';
import TranslationChunk from '../src/models/translationChunkModel.js';
import { QUALITY_PIPELINE_VERSION, QUALITY_STAGES } from '../src/services/qualityPipelineState.js';

test('P003 schemas remain additive for legacy jobs and validate versioned quality jobs', async () => {
    const legacy = new Job({
        jobId: 'legacy-schema',
        originalName: 'legacy.pdf',
        filePath: 'legacy.pdf',
    });
    await legacy.validate();
    assert.equal(legacy.translationMode, null);

    const quality = new Job({
        jobId: 'quality-schema',
        originalName: 'quality.pdf',
        filePath: 'quality.pdf',
        translationMode: 'quality',
        translationPipelineVersion: QUALITY_PIPELINE_VERSION,
        currentQualityStage: 'medical_audit',
    });
    await quality.validate();

    const missingVersion = new Job({
        jobId: 'invalid-quality-schema',
        originalName: 'quality.pdf',
        filePath: 'quality.pdf',
        translationMode: 'quality',
    });
    await assert.rejects(missingVersion.validate(), /translationPipelineVersion/);
});

test('P003 chunk schema supports nullable final content, bounded repair and every persisted stage', async () => {
    for (const stage of QUALITY_STAGES) {
        const chunk = new TranslationChunk({
            jobId: `stage-${stage}`,
            chunkIndex: 0,
            pipelineVersion: QUALITY_PIPELINE_VERSION,
            pipelineMode: 'quality',
            pageStart: 1,
            pageEnd: 2,
            totalPages: 2,
            stage,
            draftContent: stage === 'translated' ? 'draft' : null,
        });
        await chunk.validate();
    }

    const invalidRepair = new TranslationChunk({
        jobId: 'repair-overflow',
        chunkIndex: 0,
        repairCount: 2,
    });
    await assert.rejects(invalidRepair.validate(), /repairCount/);

    const indexes = TranslationChunk.schema.indexes().map(([keys]) => JSON.stringify(keys));
    assert.equal(indexes.includes(JSON.stringify({ jobId: 1, chunkIndex: 1 })), true);
    assert.equal(indexes.includes(JSON.stringify({ jobId: 1, qualityStatus: 1, chunkIndex: 1 })), true);
});
