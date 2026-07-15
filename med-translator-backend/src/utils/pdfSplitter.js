import { PDFDocument } from 'pdf-lib';

function assertPositiveInteger(value, name) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${name} phải là số nguyên dương.`);
    }
}

export async function extractPdfPageRange(pdfBuffer, startPage, pageCount) {
    assertPositiveInteger(startPage, 'startPage');
    assertPositiveInteger(pageCount, 'pageCount');

    const originalPdf = await PDFDocument.load(pdfBuffer);
    const totalPages = originalPdf.getPageCount();
    if (startPage > totalPages) {
        throw new RangeError(`startPage ${startPage} vượt quá tổng ${totalPages} trang.`);
    }

    const endPage = Math.min(startPage + pageCount - 1, totalPages);
    const pageIndices = Array.from(
        { length: endPage - startPage + 1 },
        (_, index) => startPage - 1 + index
    );
    const rangePdf = await PDFDocument.create();
    const copiedPages = await rangePdf.copyPages(originalPdf, pageIndices);
    copiedPages.forEach(page => rangePdf.addPage(page));

    return Object.freeze({
        buffer: Buffer.from(await rangePdf.save()),
        totalPages,
        startPage,
        endPage,
        pageCount: pageIndices.length,
    });
}

/**
 * Hàm cắt PDF từ Buffer gốc thành mảng các Buffer nhỏ (mỗi Buffer là 1 chunk)
 */
export async function splitPdfToBuffers(pdfBuffer, pagesPerChunk = 2) {
    assertPositiveInteger(pagesPerChunk, 'pagesPerChunk');
    // 1. Tải file PDF từ bộ nhớ RAM
    const originalPdf = await PDFDocument.load(pdfBuffer);
    const totalPages = originalPdf.getPageCount();
    const chunkBuffers = [];

    // 2. Vòng lặp để cắt từng khúc
    for (let i = 0; i < totalPages; i += pagesPerChunk) {
        // Tạo một file PDF trống mới
        const chunkPdf = await PDFDocument.create();
        
        // Tính toán trang bắt đầu và kết thúc (ngừa trường hợp chunk cuối bị lẻ)
        const endIndex = Math.min(i + pagesPerChunk, totalPages);
        const pageIndices = Array.from({ length: endIndex - i }, (_, k) => i + k);

        // Copy các trang từ file gốc sang file trống vừa tạo
        const copiedPages = await chunkPdf.copyPages(originalPdf, pageIndices);
        copiedPages.forEach((page) => chunkPdf.addPage(page));

        // Giữ Uint8Array gốc để Worker có thể transfer ArrayBuffer mà không clone thêm.
        const chunkBytes = await chunkPdf.save();
        chunkBuffers.push(chunkBytes);
    }

    return { chunkBuffers, totalPages };
}
