import assert from 'node:assert/strict';
import test from 'node:test';
import { readP003Config } from '../src/config/env.js';
import { getTranslationProfile } from '../src/services/translationProfiles.js';

test('P003 config defaults to the selected quality pipeline with two-page chunks', () => {
    assert.deepEqual(readP003Config({}), {
        pipelineMode: 'quality',
        pagesPerChunk: 2,
        thinkingLevel: 'HIGH',
        maxRepairCycles: 2,
    });
});

test('P003 config rejects unsupported modes, downgraded thinking and unbounded repair', () => {
    assert.throws(() => readP003Config({ TRANSLATION_PIPELINE_MODE: 'fast' }), /legacy hoặc quality/);
    assert.throws(() => readP003Config({ GEMINI_THINKING_LEVEL: 'MEDIUM' }), /bắt buộc là HIGH/);
    assert.equal(readP003Config({ QUALITY_MAX_REPAIR_CYCLES: '0' }).maxRepairCycles, 0);
    assert.equal(readP003Config({ QUALITY_MAX_REPAIR_CYCLES: '1' }).maxRepairCycles, 1);
    assert.equal(readP003Config({ QUALITY_MAX_REPAIR_CYCLES: '2' }).maxRepairCycles, 2);
    assert.throws(() => readP003Config({ QUALITY_MAX_REPAIR_CYCLES: '3' }), /không được vượt quá 2/);
    assert.throws(() => readP003Config({ PDF_PAGES_PER_CHUNK: '0' }), /số nguyên dương/);
    assert.throws(() => readP003Config({ PDF_PAGES_PER_CHUNK: '2pages' }), /số nguyên dương/);
});

test('translation profiles isolate rollback behavior from strict quality behavior', () => {
    assert.deepEqual(getTranslationProfile('legacy'), {
        mode: 'legacy',
        stage: 'legacy_translate',
        validationMode: 'legacy',
        generateConfig: { temperature: 0.1 },
    });
    assert.deepEqual(getTranslationProfile('quality'), {
        mode: 'quality',
        stage: 'quality_translate',
        validationMode: 'strict',
        generateConfig: {
            temperature: 1,
            maxOutputTokens: 32768,
            thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: false },
        },
    });
});
