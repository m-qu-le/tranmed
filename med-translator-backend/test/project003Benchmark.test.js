import assert from 'node:assert/strict';
import test from 'node:test';
import { ThinkingLevel } from '@google/genai';
import {
    BENCHMARK_VARIANTS,
    parseBenchmarkArgs,
} from '../scripts/benchmark-project-003.js';

test('P003 benchmark variants preserve the fixed B0-B3 matrix', () => {
    assert.deepEqual(BENCHMARK_VARIANTS.B0, {
        pagesPerChunk: 3,
        temperature: 0.1,
        thinkingLevel: null,
        validationMode: 'legacy',
        retryMode: 'legacy',
    });
    assert.deepEqual(BENCHMARK_VARIANTS.B1, {
        pagesPerChunk: 2,
        temperature: 1,
        thinkingLevel: ThinkingLevel.MINIMAL,
        validationMode: 'strict',
        retryMode: 'quality',
    });
    assert.equal(BENCHMARK_VARIANTS.B2.thinkingLevel, ThinkingLevel.MEDIUM);
    assert.equal(BENCHMARK_VARIANTS.B3.thinkingLevel, ThinkingLevel.HIGH);
    assert.deepEqual(BENCHMARK_VARIANTS.B4, {
        pagesPerChunk: 2,
        temperature: 1,
        thinkingLevel: ThinkingLevel.HIGH,
        validationMode: 'strict',
        retryMode: 'quality',
        pipeline: 'translate_audit_revise_verify_repair',
    });
});

test('P003 benchmark CLI only accepts direct PDF names and one-based pages', () => {
    assert.deepEqual(
        parseBenchmarkArgs(['--variant', 'b3', '--file', '321 Acute Kidney Injury.pdf', '--start-page', '4', '--dry-run']),
        { variant: 'B3', fileName: '321 Acute Kidney Injury.pdf', startPage: 4, keyIndex: 0, dryRun: true }
    );
    assert.deepEqual(
        parseBenchmarkArgs(['B0', '321 Acute Kidney Injury.pdf', '1', 'dry-run']),
        { variant: 'B0', fileName: '321 Acute Kidney Injury.pdf', startPage: 1, keyIndex: 0, dryRun: true }
    );
    assert.deepEqual(
        parseBenchmarkArgs(['B2', '321 Acute Kidney Injury.pdf', '3', '5']),
        { variant: 'B2', fileName: '321 Acute Kidney Injury.pdf', startPage: 3, keyIndex: 5, dryRun: false }
    );
    assert.equal(parseBenchmarkArgs(['--variant', 'B4', '--file', 'book.pdf']).variant, 'B4');
    assert.throws(() => parseBenchmarkArgs(['--variant', 'B5', '--file', 'book.pdf']), /variant/);
    assert.throws(() => parseBenchmarkArgs(['--variant', 'B0', '--file', '..\\book.pdf']), /samplepdf/);
    assert.throws(() => parseBenchmarkArgs(['--variant', 'B0', '--file', 'book.pdf', '--start-page', '0']), /start-page/);
});
