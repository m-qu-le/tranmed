import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBatchTasks, parseBatchArgs } from '../scripts/benchmark-project-003-batch.js';

const samples = Array.from({ length: 20 }, (_, index) => ({
    fileName: `${index + 1}.pdf`,
    startPage: 2,
}));

test('P003 batch benchmark builds the complete 20 PDF × 6 variant matrix with even first keys', () => {
    const variants = ['B0', 'B1', 'B2', 'B3', 'B4', 'B5'];
    const tasks = buildBatchTasks({ samples }, variants, 7);
    assert.equal(tasks.length, 120);
    assert.deepEqual(
        Object.fromEntries(variants.map(variant => [
            variant,
            tasks.filter(task => task.variant === variant).length,
        ])),
        { B0: 20, B1: 20, B2: 20, B3: 20, B4: 20, B5: 20 }
    );
    const counts = Array(7).fill(0);
    for (const task of tasks) counts[task.keyIndex] += 1;
    assert.equal(Math.max(...counts) - Math.min(...counts) <= 1, true);
});

test('P003 batch benchmark CLI constrains variants and concurrency', () => {
    assert.deepEqual(parseBatchArgs(['--variants', 'B3,B5', '--concurrency', '4', '--dry-run']), {
        variants: ['B3', 'B5'],
        concurrency: 4,
        force: false,
        dryRun: true,
    });
    assert.throws(() => parseBatchArgs(['--variants', 'B6']), /không hợp lệ/);
    assert.throws(() => parseBatchArgs(['--concurrency', '5']), /từ 1 đến 4/);
});
