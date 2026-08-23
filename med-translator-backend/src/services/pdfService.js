import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ErrorCodes, ProcessingError } from '../utils/processingError.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class PdfSplitGate {
    constructor() {
        this.busy = false;
        this.waiters = [];
    }

    acquire(signal) {
        return new Promise((resolve, reject) => {
            const waiter = () => {
                cleanup();
                this.busy = true;
                resolve(() => this.release());
            };
            const onAbort = () => {
                this.waiters = this.waiters.filter(candidate => candidate !== waiter);
                cleanup();
                reject(resourceAbortError(signal));
            };
            const cleanup = () => signal?.removeEventListener('abort', onAbort);
            if (signal?.aborted) return onAbort();
            if (!this.busy) return waiter();
            this.waiters.push(waiter);
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    release() {
        const waiter = this.waiters.shift();
        if (waiter) return waiter();
        this.busy = false;
    }
}

const splitGate = new PdfSplitGate();

function resourceAbortError(signal) {
    const resourceBlocked = signal?.reason === ErrorCodes.LOCAL_RESOURCE_PRESSURE;
    return new ProcessingError(
        resourceBlocked ? ErrorCodes.LOCAL_RESOURCE_PRESSURE : ErrorCodes.CANCELLED,
        resourceBlocked ? 'PDF split bị dừng vì máy đang thiếu tài nguyên.' : 'Tác vụ đã bị hủy khi đang cắt PDF.',
        {
            retryable: resourceBlocked,
            publicMessage: resourceBlocked
                ? 'Máy đang chịu áp lực tài nguyên; PDF sẽ tự tiếp tục khi ổn định.'
                : 'Tác vụ đã được hủy.',
        }
    );
}

class PdfSplitSession {
    constructor({ worker, totalPages, pageRanges, signal, onSplitActivity }) {
        this.worker = worker;
        this.totalPages = totalPages;
        this.pageRanges = pageRanges;
        this.signal = signal;
        this.onSplitActivity = onSplitActivity;
        this.closed = false;
        this.sequence = 0;
        this.pending = new Map();
        worker.on('message', message => this.handleMessage(message));
        worker.on('error', error => this.failPending(error));
        worker.on('exit', code => {
            if (!this.closed && code !== 0) this.failPending(new Error(`PDF worker bị ngắt (${code}).`));
        });
    }

    handleMessage(message) {
        if (message?.type !== 'chunk' && message?.type !== 'chunk-error') return;
        const pending = this.pending.get(message.requestId);
        if (!pending) return;
        this.pending.delete(message.requestId);
        if (message.type === 'chunk-error') pending.reject(new Error(message.error));
        else pending.resolve(Buffer.from(message.chunk));
    }

    failPending(error) {
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
    }

    async getChunk(chunkIndex, signal = this.signal) {
        if (this.closed) throw new Error('PDF split session đã đóng.');
        const release = await splitGate.acquire(signal);
        this.onSplitActivity?.(true);
        try {
            if (signal?.aborted) throw resourceAbortError(signal);
            const requestId = ++this.sequence;
            const result = await new Promise((resolve, reject) => {
                this.pending.set(requestId, { resolve, reject });
                this.worker.postMessage({ type: 'chunk', requestId, chunkIndex });
            });
            if (signal?.aborted) throw resourceAbortError(signal);
            return result;
        } finally {
            this.onSplitActivity?.(false);
            release();
        }
    }

    async close() {
        if (this.closed) return;
        this.closed = true;
        this.failPending(new Error('PDF split session đã đóng.'));
        this.worker.postMessage({ type: 'close' });
        await this.worker.terminate();
    }
}

/**
 * Opens a split session without materialising every PDF chunk in main-process
 * memory. The singleton gate serialises parse/copy work across all source lanes.
 */
export async function processPdf(filePath, signal, { onSplitActivity = null } = {}) {
    const release = await splitGate.acquire(signal);
    onSplitActivity?.(true);
    try {
        if (signal?.aborted) throw resourceAbortError(signal);
        const worker = new Worker(path.resolve(__dirname, '../workers/pdfWorker.js'), {
            workerData: { filePath, pagesPerChunk: Number(process.env.PDF_PAGES_PER_CHUNK || 2) },
        });
        const ready = await new Promise((resolve, reject) => {
            let settled = false;
            const settle = (callback, value) => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener('abort', onAbort);
                callback(value);
            };
            const onAbort = () => {
                void worker.terminate();
                settle(reject, resourceAbortError(signal));
            };
            worker.once('error', error => settle(reject, error));
            worker.once('exit', code => {
                if (code !== 0) settle(reject, new Error(`PDF worker bị ngắt (${code}).`));
            });
            worker.once('message', message => {
                if (message?.type === 'ready') settle(resolve, message);
                else if (message?.type === 'error') settle(reject, new Error(message.error));
            });
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });
        });
        return new PdfSplitSession({ worker, ...ready, signal, onSplitActivity });
    } finally {
        onSplitActivity?.(false);
        release();
    }
}
