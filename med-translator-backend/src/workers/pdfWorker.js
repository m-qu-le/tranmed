import { parentPort, workerData } from 'worker_threads';
import fs from 'fs/promises';
import { splitPdfToBuffers } from '../utils/pdfSplitter.js';

async function executeSplit() {
    try {
        // 🛠️ FIX: Ép kiểu ngược lại thành Node.js Buffer chuẩn ngay khi nhận từ Main Thread
        // Điều này đảm bảo thư viện băm PDF (pdf-lib) đọc đúng format
        const validFileBuffer = await fs.readFile(workerData.filePath);
        
        const { chunkBuffers, totalPages, pageRanges } = await splitPdfToBuffers(validFileBuffer, workerData.pagesPerChunk);
        
        const transferList = chunkBuffers.map(chunk => chunk.buffer);
        parentPort.postMessage({ success: true, chunkBuffers, totalPages, pageRanges }, transferList);
    } catch (error) {
        parentPort.postMessage({ success: false, error: error.message });
    }
}

executeSplit();
