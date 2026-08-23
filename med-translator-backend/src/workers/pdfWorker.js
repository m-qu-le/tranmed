import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';

function pageRanges(totalPages, pagesPerChunk) {
    const ranges = [];
    for (let start = 0; start < totalPages; start += pagesPerChunk) {
        ranges.push({ pageStart: start + 1, pageEnd: Math.min(start + pagesPerChunk, totalPages) });
    }
    return ranges;
}

async function createChunk(document, range) {
    const output = await PDFDocument.create();
    const indexes = Array.from(
        { length: range.pageEnd - range.pageStart + 1 },
        (_, index) => range.pageStart - 1 + index
    );
    const copied = await output.copyPages(document, indexes);
    copied.forEach(page => output.addPage(page));
    return output.save();
}

async function execute() {
    try {
        const bytes = await fs.readFile(workerData.filePath);
        const document = await PDFDocument.load(bytes);
        const totalPages = document.getPageCount();
        const ranges = pageRanges(totalPages, workerData.pagesPerChunk);
        parentPort.postMessage({ type: 'ready', totalPages, pageRanges: ranges });

        parentPort.on('message', async message => {
            if (message?.type === 'close') {
                parentPort.close();
                return;
            }
            if (message?.type !== 'chunk' || !Number.isSafeInteger(message.chunkIndex)) return;
            try {
                const range = ranges[message.chunkIndex];
                if (!range) throw new RangeError('Chunk PDF không tồn tại.');
                const chunk = await createChunk(document, range);
                parentPort.postMessage(
                    { type: 'chunk', requestId: message.requestId, chunkIndex: message.chunkIndex, chunk },
                    [chunk.buffer]
                );
            } catch (error) {
                parentPort.postMessage({ type: 'chunk-error', requestId: message.requestId, error: error.message });
            }
        });
    } catch (error) {
        parentPort.postMessage({ type: 'error', error: error.message });
    }
}

void execute();
