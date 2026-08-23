import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractPdfPageRange, splitPdfToBuffers } from '../src/utils/pdfSplitter.js';
import { processPdf } from '../src/services/pdfService.js';
import { ErrorCodes } from '../src/utils/processingError.js';

test('splitPdfToBuffers preserves page count and chunk order', async () => {
    const source = await PDFDocument.create();
    for (let page = 0; page < 4; page += 1) {
        source.addPage([200, 200]);
    }

    const sourceBytes = await source.save();
    const { chunkBuffers, totalPages, pageRanges } = await splitPdfToBuffers(Buffer.from(sourceBytes), 3);

    assert.equal(totalPages, 4);
    assert.equal(chunkBuffers.length, 2);
    assert.deepEqual(pageRanges, [
        { pageStart: 1, pageEnd: 3 },
        { pageStart: 4, pageEnd: 4 },
    ]);

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

test('processPdf exposes one transferable chunk at a time instead of all chunk buffers', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studymed-pdf-session-'));
    const filePath = path.join(directory, 'source.pdf');
    const source = await PDFDocument.create();
    for (let page = 0; page < 3; page += 1) source.addPage([200, 200]);
    await fs.writeFile(filePath, Buffer.from(await source.save()));
    let session;
    try {
        session = await processPdf(filePath);
        assert.equal(session.totalPages, 3);
        assert.deepEqual(session.pageRanges, [
            { pageStart: 1, pageEnd: 2 },
            { pageStart: 3, pageEnd: 3 },
        ]);
        assert.equal((await PDFDocument.load(await session.getChunk(0))).getPageCount(), 2);
        assert.equal((await PDFDocument.load(await session.getChunk(1))).getPageCount(), 1);
    } finally {
        await session?.close();
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('extractPdfPageRange uses one-based inclusive ranges and truncates the last chunk', async () => {
    const source = await PDFDocument.create();
    for (let page = 0; page < 5; page += 1) source.addPage([200 + page, 200]);

    const sourceBytes = Buffer.from(await source.save());
    const middle = await extractPdfPageRange(sourceBytes, 2, 2);
    const tail = await extractPdfPageRange(sourceBytes, 5, 2);

    assert.deepEqual(
        { totalPages: middle.totalPages, startPage: middle.startPage, endPage: middle.endPage, pageCount: middle.pageCount },
        { totalPages: 5, startPage: 2, endPage: 3, pageCount: 2 }
    );
    assert.equal((await PDFDocument.load(middle.buffer)).getPageCount(), 2);
    assert.deepEqual(
        { startPage: tail.startPage, endPage: tail.endPage, pageCount: tail.pageCount },
        { startPage: 5, endPage: 5, pageCount: 1 }
    );
});

test('extractPdfPageRange rejects invalid page ranges', async () => {
    const source = await PDFDocument.create();
    source.addPage();
    const bytes = Buffer.from(await source.save());

    await assert.rejects(extractPdfPageRange(bytes, 0, 1), /startPage/);
    await assert.rejects(extractPdfPageRange(bytes, 2, 1), /vượt quá/);
    await assert.rejects(extractPdfPageRange(bytes, 1, 0), /pageCount/);
});

test('two-page chunking covers 1, 2, 3, odd and many-page PDFs in order', async () => {
    for (const [totalPages, expectedChunkPages] of [
        [1, [1]],
        [2, [2]],
        [3, [2, 1]],
        [5, [2, 2, 1]],
        [10, [2, 2, 2, 2, 2]],
    ]) {
        const source = await PDFDocument.create();
        for (let page = 0; page < totalPages; page += 1) source.addPage([200 + page, 200]);
        const result = await splitPdfToBuffers(Buffer.from(await source.save()));
        const actualChunkPages = [];
        for (const chunk of result.chunkBuffers) {
            actualChunkPages.push((await PDFDocument.load(chunk)).getPageCount());
        }
        assert.equal(result.totalPages, totalPages);
        assert.deepEqual(actualChunkPages, expectedChunkPages);
    }
});
