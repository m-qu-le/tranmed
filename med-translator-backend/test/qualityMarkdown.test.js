import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeQualityMarkdown } from '../src/services/qualityMarkdown.js';

test('quality Markdown removes thematic rules without damaging table separators', () => {
    const source = [
        '# Tiêu đề',
        '',
        '---',
        '',
        '| Cột A | Cột B |',
        '| --- | --- |',
        '| 1 | 2 |',
        '',
        '***',
        'Nội dung',
        '___',
    ].join('\n');
    const normalized = normalizeQualityMarkdown(source);
    assert.equal(normalized.includes('\n---\n'), false);
    assert.equal(normalized.includes('\n***\n'), false);
    assert.equal(normalized.includes('| --- | --- |'), true);
    assert.equal(normalized.endsWith('Nội dung'), true);
});
