export async function runBoundedTasks(taskIds, concurrency, runTask) {
    const results = new Map();
    let cursor = 0;
    let firstError = null;

    const worker = async () => {
        while (!firstError) {
            const position = cursor;
            cursor += 1;
            if (position >= taskIds.length) return;

            const taskId = taskIds[position];
            try {
                results.set(taskId, await runTask(taskId));
            } catch (error) {
                firstError ||= error;
            }
        }
    };

    const workerCount = Math.min(Math.max(1, concurrency), Math.max(1, taskIds.length));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    if (firstError) throw firstError;
    return results;
}
