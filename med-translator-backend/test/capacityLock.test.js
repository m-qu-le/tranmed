import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import Job from '../src/models/jobModel.js';
import { reserveUploadCapacity } from '../src/middlewares/capacity.js';

class FakeResponse extends EventEmitter {
    statusCode = null;
    body = null;

    status(code) {
        this.statusCode = code;
        return this;
    }

    json(value) {
        this.body = value;
        return this;
    }
}

test('capacity guard admits only one of two simultaneous uploads', async (context) => {
    const originalFind = Job.find;
    const originalCountDocuments = Job.countDocuments;
    let releaseStorageScan;
    const storageScan = new Promise(resolve => { releaseStorageScan = resolve; });

    Job.find = () => ({ lean: async () => storageScan });
    Job.countDocuments = async () => 0;
    context.after(() => {
        Job.find = originalFind;
        Job.countDocuments = originalCountDocuments;
    });

    const request = { headers: { 'content-length': '1000' } };
    const firstResponse = new FakeResponse();
    const secondResponse = new FakeResponse();
    let firstAdvanced = false;

    const first = reserveUploadCapacity(request, firstResponse, () => {
        firstAdvanced = true;
    });
    await reserveUploadCapacity(request, secondResponse, () => {
        assert.fail('second upload must not reach Multer');
    });

    assert.equal(secondResponse.statusCode, 409);
    releaseStorageScan([]);
    await first;
    assert.equal(firstAdvanced, true);
    firstResponse.emit('finish');
});
