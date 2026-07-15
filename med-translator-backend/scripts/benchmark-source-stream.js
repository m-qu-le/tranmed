import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { performance } from 'node:perf_hooks';
import { SourceService } from '../src/services/sourceService.js';

const MB = 1024 * 1024;
const sizesMb = [1, 3, 30, 350];
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tranmed-stream-benchmark-'));

async function benchmark(sizeMb) {
    const sourceSize = sizeMb * MB;
    const chunk = Buffer.alloc(MB, 0x20);
    chunk.write('%PDF-', 0, 'ascii');
    const r2 = {
        async downloadToFile({ destinationPath }) {
            async function* chunks() {
                for (let index = 0; index < sizeMb; index += 1) yield chunk;
            }
            await pipeline(Readable.from(chunks()), createWriteStream(destinationPath, { flags: 'wx' }));
        },
    };
    const sourceService = new SourceService({ r2, uploadDir: tempDir, assertCapacity: async () => {} });
    if (global.gc) global.gc();
    const baselineRss = process.memoryUsage().rss;
    let peakRss = baselineRss;
    const sampler = setInterval(() => {
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 2);
    const startedAt = performance.now();
    let resolved;
    try {
        resolved = await sourceService.resolve({
            jobId: `benchmark-${sizeMb}mb`,
            storageProvider: 'r2',
            storageKey: `benchmark/${sizeMb}mb.pdf`,
            sourceState: 'ready',
            sourceSize,
        });
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        const stat = await fs.stat(resolved.filePath);
        return {
            sizeMb,
            diskBytes: stat.size,
            elapsedMs: Math.round(performance.now() - startedAt),
            peakRssDeltaMb: Number(((peakRss - baselineRss) / MB).toFixed(1)),
        };
    } finally {
        clearInterval(sampler);
        if (resolved) await sourceService.cleanup(resolved);
    }
}

try {
    const results = [];
    for (const sizeMb of sizesMb) results.push(await benchmark(sizeMb));
    const nearMax = results.at(-1);
    if (nearMax.diskBytes !== nearMax.sizeMb * MB) throw new Error('Benchmark disk byte mismatch.');
    process.stdout.write(`${JSON.stringify({ chunkSizeMb: 1, results }, null, 2)}\n`);
} finally {
    await fs.rm(tempDir, { recursive: true, force: true });
}
