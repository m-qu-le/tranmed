import assert from 'node:assert/strict';
import test from 'node:test';
import { QualityPipelineService } from '../src/services/qualityPipelineService.js';
import { QUALITY_PIPELINE_VERSION } from '../src/services/qualityPipelineState.js';
import { ErrorCodes, ProcessingError } from '../src/utils/processingError.js';

function clone(value) {
    return value == null ? value : structuredClone(value);
}

function getPath(target, path) {
    return path.split('.').reduce((value, key) => value?.[key], target);
}

function setPath(target, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    let cursor = target;
    for (const key of keys) cursor = cursor[key] ||= {};
    cursor[last] = clone(value);
}

function unsetPath(target, path) {
    const keys = path.split('.');
    const last = keys.pop();
    const parent = keys.reduce((value, key) => value?.[key], target);
    if (parent) delete parent[last];
}

function matches(row, filter) {
    if (!row) return false;
    return Object.entries(filter).every(([path, expected]) => {
        const actual = getPath(row, path);
        return expected === null ? actual == null : actual === expected;
    });
}

class MemoryChunkModel {
    constructor(row = null) {
        this.row = clone(row);
    }

    async findOne(filter) {
        return matches(this.row, filter) ? clone(this.row) : null;
    }

    async findOneAndUpdate(filter, update, options = {}) {
        if (!matches(this.row, filter)) {
            if (!options.upsert || this.row) return null;
            this.row = clone(filter);
            for (const [path, value] of Object.entries(update.$setOnInsert || {})) setPath(this.row, path, value);
            return clone(this.row);
        }
        for (const [path, value] of Object.entries(update.$set || {})) setPath(this.row, path, value);
        for (const path of Object.keys(update.$unset || {})) unsetPath(this.row, path);
        return clone(this.row);
    }
}

class CommitThenThrowOnceModel extends MemoryChunkModel {
    constructor(stage) {
        super();
        this.stage = stage;
        this.hasThrown = false;
    }

    async findOneAndUpdate(filter, update, options = {}) {
        const result = await super.findOneAndUpdate(filter, update, options);
        if (!this.hasThrown && filter.stage === this.stage) {
            this.hasThrown = true;
            throw new Error(`connection lost after committing ${this.stage}`);
        }
        return result;
    }
}

class ThrowBeforeCommitOnceModel extends MemoryChunkModel {
    constructor(stage) {
        super();
        this.stage = stage;
        this.hasThrown = false;
    }

    async findOneAndUpdate(filter, update, options = {}) {
        if (!this.hasThrown && filter.stage === this.stage) {
            this.hasThrown = true;
            throw new Error(`database unavailable before committing ${this.stage}`);
        }
        return super.findOneAndUpdate(filter, update, options);
    }
}

const passReport = { status: 'PASS', errors: [] };
const failReport = {
    status: 'FAIL',
    errors: [{
        category: 'mistranslation',
        severity: 'major',
        sourceExcerpt: 'source',
        targetExcerpt: 'target',
        requiredCorrection: 'correction',
        explanation: 'reason',
    }],
};

function result(action, report = passReport) {
    const metadata = { stage: action, finishReason: 'STOP', keyIndex: 0 };
    return ['medical_audit', 'verify', 'reverify'].includes(action)
        ? { json: report, metadata }
        : { text: `${action} markdown`, metadata };
}

function createExecutors(calls, { verifyReport = passReport, reverifyReport = passReport, onExecute } = {}) {
    return Object.fromEntries([
        'translate', 'medical_audit', 'revise', 'verify', 'repair', 'reverify',
    ].map(action => [action, async context => {
        calls.push(action);
        onExecute?.(action, context);
        if (action === 'verify') return result(action, verifyReport);
        if (action === 'reverify') return result(action, reverifyReport);
        return result(action);
    }]));
}

function baseRow(stage, fields = {}) {
    return {
        jobId: 'job-1',
        chunkIndex: 0,
        pipelineVersion: QUALITY_PIPELINE_VERSION,
        pipelineMode: 'quality',
        stage,
        qualityStatus: 'pending',
        repairCount: 0,
        usageByStage: {},
        ...fields,
    };
}

async function run(service, options = {}) {
    return service.runChunk({
        jobId: 'job-1',
        chunkIndex: 0,
        pageStart: 1,
        pageEnd: 2,
        totalPages: 2,
        pdfBuffer: Buffer.alloc(100),
        ...options,
    });
}

test('quality pipeline persists PASS stages and removes redundant full-text artifacts', async () => {
    const model = new MemoryChunkModel();
    const calls = [];
    const service = new QualityPipelineService({ ChunkModel: model, executors: createExecutors(calls) });

    const final = await run(service);

    assert.deepEqual(calls, ['translate', 'medical_audit', 'revise', 'verify']);
    assert.equal(final.stage, 'completed');
    assert.equal(final.qualityStatus, 'passed');
    assert.equal(final.content, 'revise markdown');
    assert.equal(final.draftContent, undefined);
    assert.equal(final.revisedContent, undefined);
    assert.deepEqual(final.auditReport, passReport);
    assert.deepEqual(Object.keys(final.usageByStage), ['translate', 'medical_audit', 'revise', 'verify']);
});

test('quality pipeline resumes after every persisted stage without repeating completed calls', async () => {
    const fixtures = [
        ['pending', {}, ['translate', 'medical_audit', 'revise', 'verify']],
        ['translated', { draftContent: 'draft' }, ['medical_audit', 'revise', 'verify']],
        ['audited', { draftContent: 'draft', auditReport: passReport }, ['revise', 'verify']],
        ['revised', { revisedContent: 'revised' }, ['verify']],
        ['verified', { revisedContent: 'revised', verificationReport: failReport }, ['repair', 'reverify']],
        ['repaired', { repairedContent: 'repaired', repairCount: 1 }, ['reverify']],
        ['completed', { content: 'final', qualityStatus: 'passed' }, []],
        ['needs_review', { content: 'final', qualityStatus: 'needs_review' }, []],
    ];

    for (const [stage, fields, expectedCalls] of fixtures) {
        const model = new MemoryChunkModel(baseRow(stage, fields));
        const calls = [];
        const service = new QualityPipelineService({ ChunkModel: model, executors: createExecutors(calls) });
        await run(service);
        assert.deepEqual(calls, expectedCalls, `resume từ ${stage}`);
    }
});

test('restart after an ambiguous DB acknowledgement never repeats a committed stage', async () => {
    const scenarios = [
        ...['pending', 'translated', 'audited', 'revised'].map(stage => ({
            stage,
            executorOptions: {},
            expected: ['translate', 'medical_audit', 'revise', 'verify'],
        })),
        ...['verified', 'repaired'].map(stage => ({
            stage,
            executorOptions: { verifyReport: failReport },
            expected: ['translate', 'medical_audit', 'revise', 'verify', 'repair', 'reverify'],
        })),
    ];

    for (const scenario of scenarios) {
        const model = new CommitThenThrowOnceModel(scenario.stage);
        const calls = [];
        const service = new QualityPipelineService({
            ChunkModel: model,
            executors: createExecutors(calls, scenario.executorOptions),
        });
        await assert.rejects(run(service), /connection lost after committing/);
        const final = await run(service);
        assert.equal(final.stage, 'completed', `restart từ ${scenario.stage}`);
        assert.deepEqual(calls, scenario.expected, `không lặp stage đã commit ${scenario.stage}`);
    }
});

test('restart repeats only the uncommitted stage after a DB failure before persist', async () => {
    const model = new ThrowBeforeCommitOnceModel('audited');
    const calls = [];
    const service = new QualityPipelineService({ ChunkModel: model, executors: createExecutors(calls) });
    await assert.rejects(run(service), /before committing audited/);
    assert.equal(model.row.stage, 'audited');
    const final = await run(service);
    assert.equal(final.stage, 'completed');
    assert.deepEqual(calls, ['translate', 'medical_audit', 'revise', 'revise', 'verify']);
});

test('FAIL verify followed by one successful repair/reverify completes with repaired content', async () => {
    const model = new MemoryChunkModel();
    const calls = [];
    const service = new QualityPipelineService({
        ChunkModel: model,
        executors: createExecutors(calls, { verifyReport: failReport, reverifyReport: passReport }),
    });
    const final = await run(service);
    assert.deepEqual(calls, ['translate', 'medical_audit', 'revise', 'verify', 'repair', 'reverify']);
    assert.equal(final.stage, 'completed');
    assert.equal(final.qualityStatus, 'passed');
    assert.equal(final.content, 'repair markdown');
    assert.equal(final.repairCount, 1);
});

test('an expired worker token after a stage response cannot persist or start the next stage', async () => {
    const model = new MemoryChunkModel();
    const calls = [];
    let activeChecks = 0;
    const service = new QualityPipelineService({ ChunkModel: model, executors: createExecutors(calls) });
    await assert.rejects(
        run(service, {
            assertActive: async () => {
                activeChecks += 1;
                if (activeChecks === 2) {
                    throw new ProcessingError(ErrorCodes.CANCELLED, 'worker token expired');
                }
            },
        }),
        error => error.code === ErrorCodes.CANCELLED
    );
    assert.deepEqual(calls, ['translate']);
    assert.equal(model.row.stage, 'pending');
    assert.equal(model.row.draftContent, undefined);
});

test('quality pipeline performs at most one repair and keeps diagnostics after reverify failure', async () => {
    const model = new MemoryChunkModel();
    const calls = [];
    const service = new QualityPipelineService({
        ChunkModel: model,
        executors: createExecutors(calls, { verifyReport: failReport, reverifyReport: failReport }),
    });

    const final = await run(service);

    assert.deepEqual(calls, ['translate', 'medical_audit', 'revise', 'verify', 'repair', 'reverify']);
    assert.equal(final.stage, 'needs_review');
    assert.equal(final.qualityStatus, 'needs_review');
    assert.equal(final.repairCount, 1);
    assert.equal(final.content, 'repair markdown');
    assert.equal(final.draftContent, 'translate markdown');
    assert.equal(final.revisedContent, 'revise markdown');
    assert.equal(final.repairedContent, 'repair markdown');
});

test('invalid repair falls back to revised content and requires review', async () => {
    const model = new MemoryChunkModel();
    const calls = [];
    const executors = createExecutors(calls, { verifyReport: failReport });
    executors.repair = async () => {
        calls.push('repair');
        throw new ProcessingError(ErrorCodes.GEMINI_OUTPUT_TRUNCATED, 'repair truncated', { retryable: true });
    };
    const service = new QualityPipelineService({ ChunkModel: model, executors });

    const final = await run(service);

    assert.deepEqual(calls, ['translate', 'medical_audit', 'revise', 'verify', 'repair']);
    assert.equal(final.stage, 'needs_review');
    assert.equal(final.qualityStatus, 'needs_review');
    assert.equal(final.content, 'revise markdown');
    assert.equal(final.repairCount, 1);
    assert.equal(final.repairedContent, undefined);
});

test('incomplete artifact from another version resets, but terminal legacy content is untouched', async () => {
    const old = baseRow('translated', { pipelineVersion: 'p003-old', draftContent: 'stale' });
    const model = new MemoryChunkModel(old);
    const calls = [];
    const service = new QualityPipelineService({ ChunkModel: model, executors: createExecutors(calls) });
    const final = await run(service);
    assert.deepEqual(calls, ['translate', 'medical_audit', 'revise', 'verify']);
    assert.equal(final.stage, 'completed');
    assert.equal(final.pipelineVersion, QUALITY_PIPELINE_VERSION);

    const legacyModel = new MemoryChunkModel({ jobId: 'job-1', chunkIndex: 0, content: 'legacy final' });
    const legacyCalls = [];
    const legacyService = new QualityPipelineService({ ChunkModel: legacyModel, executors: createExecutors(legacyCalls) });
    const legacy = await run(legacyService);
    assert.equal(legacy.content, 'legacy final');
    assert.deepEqual(legacyCalls, []);
});

test('cancellation after a stage response prevents the stage from being persisted', async () => {
    const controller = new AbortController();
    const model = new MemoryChunkModel();
    const calls = [];
    const service = new QualityPipelineService({
        ChunkModel: model,
        executors: createExecutors(calls, {
            onExecute(action) {
                if (action === 'translate') controller.abort();
            },
        }),
    });

    await assert.rejects(
        run(service, { signal: controller.signal }),
        error => error.code === ErrorCodes.CANCELLED
    );
    assert.equal(model.row.stage, 'pending');
    assert.equal(model.row.draftContent, undefined);
});
