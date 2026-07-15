import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { splitPdfToBuffers } from '../src/utils/pdfSplitter.js';
import { processPdf } from '../src/services/pdfService.js';
import { ErrorCodes } from '../src/utils/processingError.js';

test('splitPdfToBuffers preserves page count and chunk order', async () => {
    const source = await PDFDocument.create();
    for (let page = 0; page < 4; page += 1) {
        source.addPage([200, 200]);
    }

    const sourceBytes = await source.save();
    const { chunkBuffers, totalPages } = await splitPdfToBuffers(Buffer.from(sourceBytes), 3);

    assert.equal(totalPages, 4);
    assert.equal(chunkBuffers.length, 2);

    const firstChunk = await PDFDocument.load(chunkBuffers[0]);
    const secondChunk = await PDFDocument.load(chunkBuffers[1]);
    assert.equal(firstChunk.getPageCount(), 3);
    assert.equal(secondChunk.getPageCount(), 1);
});

test('processPdf stops its worker when cancellation was already requested', async () => {
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
        processPdf('file-does-not-need-to-exist.pdf', controller.signal),
        error => error.code === ErrorCodes.CANCELLED
    );
});
