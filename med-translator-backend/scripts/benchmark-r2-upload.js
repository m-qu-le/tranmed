import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { r2Service } from '../src/services/runtimeServices.js';

const MB = 1024 * 1024;
const concurrency = 4;
const cases = [50, 200];
const body = Buffer.alloc(MB, 0x20);
body.write('%PDF-', 0, 'ascii');

async function runPool(items, worker) {
    let cursor = 0;
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            await worker(items[index]);
        }
    });
    await Promise.all(runners);
}

async function retry(operation, attempts = 3) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return { value: await operation(), attempt };
        } catch (error) {
            lastError = error;
            if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 250 * attempt));
        }
    }
    throw lastError;
}

async function benchmark(fileCount) {
    const runId = randomUUID();
    const items = Array.from({ length: fileCount }, (_, index) => ({
        key: `benchmark/${runId}/${String(index).padStart(3, '0')}.pdf`,
    }));
    let putAttempts = 0;
    let confirmAttempts = 0;
    try {
        await Promise.all(items.map(async item => {
            item.url = await r2Service.createPresignedPut({ key: item.key, contentType: 'application/pdf' });
        }));

        const putStartedAt = performance.now();
        await runPool(items, async item => {
            const result = await retry(async () => {
                const response = await fetch(item.url, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/pdf' },
                    body,
                });
                if (!response.ok) throw new Error(`R2 PUT status ${response.status}`);
            });
            putAttempts += result.attempt;
        });
        const putMs = performance.now() - putStartedAt;

        const confirmStartedAt = performance.now();
        await runPool(items, async item => {
            const result = await retry(async () => {
                const metadata = await r2Service.headObject(item.key);
                if (metadata.contentLength !== body.length || !metadata.etag) {
                    throw new Error('R2 HEAD metadata mismatch.');
                }
            });
            confirmAttempts += result.attempt;
        });
        const confirmMs = performance.now() - confirmStartedAt;
        const totalBytes = fileCount * body.length;
        return {
            fileCount,
            totalBytes,
            concurrency,
            putMs: Math.round(putMs),
            confirmMs: Math.round(confirmMs),
            throughputMbps: Number((totalBytes * 8 / 1_000_000 / (putMs / 1000)).toFixed(2)),
            putRetries: putAttempts - fileCount,
            confirmRetries: confirmAttempts - fileCount,
        };
    } finally {
        await runPool(items, async item => {
            await retry(() => r2Service.deleteObject(item.key)).catch(() => {});
        });
    }
}

const results = [];
for (const fileCount of cases) results.push(await benchmark(fileCount));
process.stdout.write(`${JSON.stringify({ fileSizeBytes: body.length, results }, null, 2)}\n`);
