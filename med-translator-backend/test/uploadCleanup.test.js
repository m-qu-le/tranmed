import assert from 'node:assert/strict';
import test from 'node:test';
import { uploadFiles } from '../src/controllers/translateController.js';
import { translationQueue } from '../src/services/queueManager.js';

function createResponse() {
    return {
        statusCode: null,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(value) {
            this.body = value;
            return this;
        }
    };
}

test('upload cleanup removes the Multer file if MongoDB job creation fails', async (context) => {
    const originalAddJob = translationQueue.addJob;
    const originalSafeUnlink = translationQueue.safeUnlink;
    const removedPaths = [];

    translationQueue.addJob = async () => {
        throw new Error('database unavailable');
    };
    translationQueue.safeUnlink = async filePath => {
        removedPaths.push(filePath);
    };
    context.after(() => {
        translationQueue.addJob = originalAddJob;
        translationQueue.safeUnlink = originalSafeUnlink;
    });

    const req = {
        body: { folderName: 'Nội khoa', clientUploadId: 'upload-1' },
        files: [{ path: 'uploads/orphan.pdf', originalname: 'Tim mạch.pdf' }]
    };
    const res = createResponse();

    await uploadFiles(req, res);

    assert.equal(res.statusCode, 500);
    assert.deepEqual(removedPaths, ['uploads/orphan.pdf']);
    assert.equal(res.body.failures[0].originalName, 'Tim mạch.pdf');
});
