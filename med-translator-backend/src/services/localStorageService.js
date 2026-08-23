import fs from 'node:fs/promises';
import path from 'node:path';
import { ErrorCodes, ProcessingError } from '../utils/processingError.js';

function isWithin(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function toNumber(value) {
    return typeof value === 'bigint' ? Number(value) : Number(value);
}

/**
 * Owns every local-runtime filesystem path.  Database values are never trusted
 * as paths: every read/delete is constrained to DATA_ROOT and rejects links.
 */
export class LocalStorageService {
    constructor({ dataRoot, diskReserveBytes }) {
        this.dataRoot = path.resolve(dataRoot);
        this.sourceDir = path.join(this.dataRoot, 'sources');
        this.tempDir = path.join(this.dataRoot, 'temp');
        this.logDir = path.join(this.dataRoot, 'logs');
        this.diskReserveBytes = diskReserveBytes;
    }

    async initialize() {
        if (this.dataRoot === path.parse(this.dataRoot).root) {
            throw new Error('DATA_ROOT không được là root của ổ đĩa.');
        }
        await fs.mkdir(this.dataRoot, { recursive: true });
        await this.assertNoLinks(this.dataRoot, this.dataRoot);
        await Promise.all([
            fs.mkdir(this.sourceDir, { recursive: true }),
            fs.mkdir(this.tempDir, { recursive: true }),
            fs.mkdir(this.logDir, { recursive: true }),
        ]);
        await Promise.all([
            this.assertNoLinks(this.sourceDir, this.dataRoot),
            this.assertNoLinks(this.tempDir, this.dataRoot),
            this.assertNoLinks(this.logDir, this.dataRoot),
        ]);
        return this.paths();
    }

    paths() {
        return Object.freeze({
            dataRoot: this.dataRoot,
            sourceDir: this.sourceDir,
            tempDir: this.tempDir,
            logDir: this.logDir,
        });
    }

    async assertNoLinks(candidate, boundary = this.dataRoot) {
        const resolved = path.resolve(candidate);
        const resolvedBoundary = path.resolve(boundary);
        if (!isWithin(resolvedBoundary, resolved)) {
            throw new Error('Đường dẫn nằm ngoài DATA_ROOT.');
        }

        let current = resolved;
        while (isWithin(resolvedBoundary, current)) {
            try {
                const stat = await fs.lstat(current);
                if (stat.isSymbolicLink()) {
                    throw new Error('DATA_ROOT không cho phép symbolic link hoặc junction.');
                }
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
            }
            if (current === resolvedBoundary) break;
            current = path.dirname(current);
        }
        return resolved;
    }

    async assertManagedSource(filePath) {
        const resolved = path.resolve(filePath || '');
        if (!isWithin(this.sourceDir, resolved)) {
            throw new ProcessingError(ErrorCodes.FILE_MISSING, 'Local source nằm ngoài DATA_ROOT.', {
                publicMessage: 'File nguồn local không hợp lệ hoặc đã bị di chuyển.',
            });
        }
        await this.assertNoLinks(resolved, this.dataRoot);
        return resolved;
    }

    async getFreeBytes() {
        const stats = await fs.statfs(this.dataRoot);
        const availableBlocks = stats.bavail ?? stats.bfree;
        const blockSize = stats.bsize ?? stats.frsize;
        const bytes = toNumber(availableBlocks) * toNumber(blockSize);
        if (!Number.isFinite(bytes) || bytes < 0) throw new Error('Không thể xác định dung lượng trống DATA_ROOT.');
        return bytes;
    }

    async assertCapacity(incomingBytes = 0) {
        const requested = Number(incomingBytes);
        if (!Number.isFinite(requested) || requested < 0) {
            throw new ProcessingError(ErrorCodes.DISK_CAPACITY, 'Kích thước source local không hợp lệ.', {
                publicMessage: 'Không thể xác nhận dung lượng file nguồn.',
            });
        }
        const freeBytes = await this.getFreeBytes();
        if (freeBytes - requested < this.diskReserveBytes) {
            throw new ProcessingError(ErrorCodes.DISK_CAPACITY, 'DATA_ROOT không còn đủ dung lượng dự phòng.', {
                retryable: true,
                publicMessage: 'Ổ dữ liệu local cần chừa ít nhất 10 GB trống; hãy giải phóng dung lượng rồi thử lại.',
            });
        }
        return { freeBytes, diskReserveBytes: this.diskReserveBytes };
    }

    async readiness() {
        await this.initialize();
        const { freeBytes, diskReserveBytes } = await this.assertCapacity(0);
        return {
            configured: true,
            available: true,
            mode: 'local',
            freeBytes,
            diskReserveBytes,
        };
    }

    uploadPartPath(id) {
        return path.join(this.tempDir, `${id}.part`);
    }

    uploadFinalPath(id) {
        return path.join(this.sourceDir, `${id}.pdf`);
    }

    async removeManagedFile(filePath) {
        const resolved = path.resolve(filePath || '');
        if (!isWithin(this.sourceDir, resolved) && !isWithin(this.tempDir, resolved)) {
            throw new Error('Từ chối xóa đường dẫn nằm ngoài DATA_ROOT.');
        }
        await this.assertNoLinks(resolved, this.dataRoot);
        try {
            await fs.unlink(resolved);
            return true;
        } catch (error) {
            if (error?.code === 'ENOENT') return false;
            throw error;
        }
    }

    async cleanupOrphanParts(gracePeriodMs = 5 * 60 * 1000) {
        await this.initialize();
        const entries = await fs.readdir(this.tempDir, { withFileTypes: true });
        let removed = 0;
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.part')) continue;
            const candidate = path.join(this.tempDir, entry.name);
            await this.assertNoLinks(candidate, this.dataRoot);
            const stat = await fs.stat(candidate);
            if (Date.now() - stat.mtimeMs < gracePeriodMs) continue;
            await this.removeManagedFile(candidate);
            removed += 1;
        }
        return removed;
    }
}
