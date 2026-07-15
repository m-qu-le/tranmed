import assert from 'node:assert/strict';
import test from 'node:test';
import { runBoundedTasks } from '../src/utils/runBoundedTasks.js';

test('runBoundedTasks stops assigning new work after the first failure', async () => {
    const started = [];

    await assert.rejects(
        runBoundedTasks([0, 1, 2, 3, 4], 2, async taskId => {
            started.push(taskId);
            if (taskId === 0) throw new Error('chunk failed');
            await new Promise(resolve => setTimeout(resolve, 10));
            return taskId;
        }),
        /chunk failed/
    );

    assert.deepEqual(started.sort(), [0, 1]);
});
