import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalStorageService } from '../src/services/localStorageService.js';

test('local storage constrains managed source paths to DATA_ROOT', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studymed-local-storage-'));
    const storage = new LocalStorageService({ dataRoot: root, diskReserveBytes: 1 });
    try {
        await storage.initialize();
        const sourcePath = storage.uploadFinalPath('source-1');
        await fs.writeFile(sourcePath, '%PDF-local');
        assert.equal(await storage.assertManagedSource(sourcePath), sourcePath);
        await assert.rejects(
            storage.assertManagedSource(path.join(os.tmpdir(), 'outside.pdf')),
            error => error.code === 'FILE_MISSING'
        );
        await assert.rejects(storage.removeManagedFile(path.join(os.tmpdir(), 'outside.pdf')), /ngoài DATA_ROOT/);
        assert.equal(await storage.removeManagedFile(sourcePath), true);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});
