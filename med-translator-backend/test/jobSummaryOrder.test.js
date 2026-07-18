import assert from 'node:assert/strict';
import test from 'node:test';
import Job from '../src/models/jobModel.js';
import { QueueManager } from '../src/services/queueManager.js';

test('job history pages follow creation order so uploaded A-Z files stay A-Z', async (context) => {
    const originalFind = Job.find;
    const calls = {};
    Job.find = filter => {
        calls.filter = filter;
        return {
            sort(value) { calls.sort = value; return this; },
            limit(value) { calls.limit = value; return this; },
            async lean() {
                return [{ _id: '000000000000000000000101' }, { _id: '000000000000000000000102' }];
            },
        };
    };
    context.after(() => { Job.find = originalFind; });

    const result = await new QueueManager().getJobsSummary({
        limit: 1,
        cursor: '000000000000000000000100',
    });

    assert.deepEqual(calls.filter, { _id: { $gt: '000000000000000000000100' } });
    assert.deepEqual(calls.sort, { _id: 1 });
    assert.equal(calls.limit, 2);
    assert.deepEqual(result.items.map(item => item._id), ['000000000000000000000101']);
    assert.equal(result.nextCursor, '000000000000000000000101');
});
