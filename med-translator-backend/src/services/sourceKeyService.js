const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function requireSafeId(name, value) {
    if (typeof value !== 'string' || !SAFE_ID_PATTERN.test(value)) {
        throw new TypeError(`${name} không hợp lệ.`);
    }
    return value;
}

export function createIncomingStorageKey(batchId, jobId) {
    return `incoming/${requireSafeId('batchId', batchId)}/${requireSafeId('jobId', jobId)}.pdf`;
}
