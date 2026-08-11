export const P014_R2_PREFIX = 'incoming/';

function assertIncomingKey(key) {
    if (typeof key !== 'string' || !key.startsWith(P014_R2_PREFIX)) {
        throw new Error('P014 chỉ được phép xóa object trong prefix incoming/.');
    }
}

function countFrom(result) {
    return Number.isSafeInteger(result?.deletedCount) ? result.deletedCount : 0;
}

export function isP014PurgeConfirmed({ args = [], environment = process.env } = {}) {
    return args.includes('--execute')
        && environment.P014_PURGE_CONFIRM === 'DELETE_WORK_DATA';
}

export async function listP014IncomingObjects(r2) {
    const objects = [];
    let continuationToken;

    do {
        const page = await r2.listObjects({
            prefix: P014_R2_PREFIX,
            continuationToken,
        });
        for (const object of page.objects || []) {
            assertIncomingKey(object?.key);
            objects.push(object);
        }
        if (page.truncated && !page.nextContinuationToken) {
            throw new Error('R2 báo còn trang tiếp theo nhưng không có continuation token.');
        }
        continuationToken = page.nextContinuationToken;
    } while (continuationToken);

    return objects;
}

export async function inspectP014WorkData({
    r2,
    Job,
    TranslationChunk,
    UploadBatch,
} = {}) {
    const objects = await listP014IncomingObjects(r2);
    const [translationChunks, jobs, uploadBatches] = await Promise.all([
        TranslationChunk.countDocuments({}),
        Job.countDocuments({}),
        UploadBatch.countDocuments({}),
    ]);

    return Object.freeze({
        r2: Object.freeze({
            prefix: P014_R2_PREFIX,
            objects: objects.length,
            bytes: objects.reduce((total, object) => total + (Number(object.size) || 0), 0),
        }),
        mongodb: Object.freeze({
            translationChunks,
            jobs,
            uploadBatches,
        }),
        objects,
    });
}

export async function purgeP014WorkData(dependencies, { execute = false } = {}) {
    const report = await inspectP014WorkData(dependencies);
    const summary = {
        mode: execute ? 'execute' : 'dry-run',
        r2: report.r2,
        mongodb: report.mongodb,
    };
    if (!execute) return summary;

    for (const object of report.objects) {
        await dependencies.r2.deleteObject(object.key);
    }

    const remainingObjects = await listP014IncomingObjects(dependencies.r2);
    if (remainingObjects.length > 0) {
        throw new Error('R2 incoming/ vẫn còn object sau purge; MongoDB chưa bị thay đổi.');
    }

    const translationChunks = await dependencies.TranslationChunk.deleteMany({});
    const jobs = await dependencies.Job.deleteMany({});
    const uploadBatches = await dependencies.UploadBatch.deleteMany({});

    return {
        ...summary,
        deleted: {
            r2Objects: report.objects.length,
            translationChunks: countFrom(translationChunks),
            jobs: countFrom(jobs),
            uploadBatches: countFrom(uploadBatches),
        },
    };
}
