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
        if (expected && typeof expected === 'object' && '$gt' in expected) {
            return actual > expected.$gt;
        }
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
        for (const [path, value] of Object.entries(update.$inc || {})) {
            setPath(this.row, path, Number(getPath(this.row, path) || 0) + value);
        }
        for (const path of Object.keys(update.$unset || {})) unsetPath(this.row, path);
        return clone(this.row);
    }

    async updateOne(filter, update) {
        if (!matches(this.row, filter)) return { matchedCount: 0, modifiedCount: 0 };
        for (const [path, value] of Object.entries(update.$set || {})) setPath(this.row, path, value);
        for (const [path, value] of Object.entries(update.$inc || {})) {
            setPath(this.row, path, Number(getPath(this.row, path) || 0) + value);
        }
        for (const path of Object.keys(update.$unset || {})) unsetPath(this.row, path);
        return { matchedCount: 1, modifiedCount: 1 };
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
        if (!this.hasThrown && filter.stage === this.stage && update.$set?.stage) {
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
        if (!this.hasThrown && filter.stage === this.stage && update.$set?.stage) {
            this.hasThrown = true;
            throw new Error(`database unavailable before committing ${this.stage}`);
        }
        return super.findOneAndUpdate(filter, update, options);
    }
}

const completeCoverage = {
    status: 'COMPLETE',
    items: Array.from({ length: 4 }, (_, index) => ({
        focus: 'meaning', sourceExcerpt: `source ${index}`, targetExcerpt: `target ${index}`, result: 'match',
    })),
};
const passReport = { status: 'PASS', errors: [], coverage: completeCoverage };
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
    coverage: completeCoverage,
};
const minorFailReport = {
    ...failReport,
    errors: [{ ...failReport.errors[0], severity: 'minor' }],
};
const incompleteCoverageReport = {
    status: 'FAIL',
    errors: [],
    coverage: {
        status: 'INCOMPLETE',
        items: [completeCoverage.items[0]],
    },
};

function result(action, report = passReport) {
    const metadata = { stage: action, finishReason: 'STOP', keyIndex: 0 };
    return ['medical_audit', 'verify', 'reverify'].includes(action)
        ? { json: report, metadata }
        : { text: `${action} markdown`, metadata };
}

function createExecutors(calls, {
    verifyReport = passReport,
    reverifyReport = passReport,
    reverifyReports = null,
    onExecute,
} = {}) {
    let reverifyIndex = 0;
    return Object.fromEntries([
        'translate', 'medical_audit', 'revise', 'verify', 'repair', 'reverify',
    ].map(action => [action, async context => {
        calls.push(action);
        onExecute?.(action, context);
        if (action === 'verify') return result(action, verifyReport);
        if (action === 'reverify') return result(
            action,
            reverifyReports?.[reverifyIndex++] || reverifyReport
        );
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

test('runOneStage persists exactly one transition before returning to the dispatcher', async () => {
    const model = new MemoryChunkModel();
    const calls = [];
    const service = new QualityPipelineService({
        ChunkModel: model,
        executors: createExecutors(calls),
    });
    const chunk = await service.runOneStage({
        jobId: 'job-1',
        chunkIndex: 0,
        pageStart: 1,
        pageEnd: 2,
        totalPages: 2,
        pdfBuffer: Buffer.alloc(100),
    });
    assert.deepEqual(calls, ['translate']);
    assert.equal(chunk.stage, 'translated');
});

test('zero-physical quota deferral rolls back the stage attempt but persists its wake time', async () => {
    const model = new MemoryChunkModel();
    const nextAvailableAt = new Date(Date.now() + 60_000);
    const quotaError = new ProcessingError(
        ErrorCodes.GEMINI_RATE_LIMIT,
        'pool exhausted',
        { retryable: true, quotaRelated: true, poolExhausted: true }
    );
    quotaError.nextAvailableAt = nextAvailableAt;
    quotaError.deferredReason = 'rpd';
    quotaError.schedulerMetadata = { physicalAttempts: 0, projectIndex: null };
    const service = new QualityPipelineService({
        ChunkModel: model,
        executors: {
            translate: async () => { throw quotaError; },
        },
    });
    await assert.rejects(
        service.runOneStage({
            jobId: 'job-1',
            chunkIndex: 0,
            pageStart: 1,
            pageEnd: 2,
            totalPages: 2,
            pdfBuffer: Buffer.alloc(100),
        }),
        error => error.code === ErrorCodes.GEMINI_RATE_LIMIT
    );
    assert.equal(model.row.stage, 'pending');
    assert.equal(model.row.stageAttempts.translate, 0);
    assert.equal(model.row.physicalAttemptCount, 0);
    assert.equal(model.row.lastStageErrorCode, ErrorCodes.GEMINI_RATE_LIMIT);
    assert.equal(new Date(model.row.deferredUntil).getTime(), nextAvailableAt.getTime());
});

test('priority suspension happens only after the running stage artifact is persisted', async () => {
    const model = new MemoryChunkModel();
    const calls = [];
    let boundaryChecks = 0;
    const service = new QualityPipelineService({
        ChunkModel: model,
        executors: createExecutors(calls),
    });
    await assert.rejects(
        run(service, {
            assertCanStartStage: async () => {
                boundaryChecks += 1;
                if (boundaryChecks > 1) {
                    throw new ProcessingError(
                        ErrorCodes.SCHEDULER_SUSPENDED,
                        'priority arrived'
                    );
                }
            },
        }),
        error => error.code === ErrorCodes.SCHEDULER_SUSPENDED
    );
    assert.deepEqual(calls, ['translate']);
    assert.equal(model.row.stage, 'translated');
    assert.equal(model.row.draftContent, 'translate markdown');
    assert.equal(model.row.stageAttempts.translate, 1);
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

test('minor-only FAIL is repaired instead of being promoted to passed', async () => {
    const model = new MemoryChunkModel();
    const calls = [];
    const service = new QualityPipelineService({
        ChunkModel: model,
        executors: createExecutors(calls, { verifyReport: minorFailReport, reverifyReport: passReport }),
    });

    const final = await run(service);

    assert.deepEqual(calls, ['translate', 'medical_audit', 'revise', 'verify', 'repair', 'reverify']);
    assert.equal(final.stage, 'completed');
    assert.equal(final.qualityStatus, 'passed');
    assert.equal(final.repairCount, 1);
    assert.equal(final.reverifyReport.status, 'PASS');
});

test('a remaining error gets a second targeted repair using the latest text and report', async () => {
    const model = new MemoryChunkModel();
    const calls = [];
    const repairInputs = [];
    const service = new QualityPipelineService({
        ChunkModel: model,
        executors: createExecutors(calls, {
            verifyReport: failReport,
            reverifyReports: [minorFailReport, passReport],
            onExecute(action, context) {
                if (action === 'repair') repairInputs.push(clone(context.chunk));
            },
        }),
    });

    const final = await run(service);

    assert.deepEqual(calls, [
        'translate', 'medical_audit', 'revise', 'verify',
        'repair', 'reverify', 'repair', 'reverify',
    ]);
    assert.equal(repairInputs[0].repairedContent, undefined);
    assert.equal(repairInputs[1].repairedContent, 'repair markdown');
    assert.deepEqual(repairInputs[1].reverifyReport, minorFailReport);
    assert.equal(final.stage, 'completed');
    assert.equal(final.qualityStatus, 'passed');
    assert.equal(final.repairCount, 2);
    assert.deepEqual(Object.keys(final.usageByStage), [
        'translate', 'medical_audit', 'revise', 'verify',
        'repair', 'reverify', 'repair_2', 'reverify_2',
    ]);
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

test('quality pipeline performs at most two repairs and keeps diagnostics after final reverify failure', async () => {
    const model = new MemoryChunkModel();
    const calls = [];
    const service = new QualityPipelineService({
        ChunkModel: model,
        executors: createExecutors(calls, { verifyReport: failReport, reverifyReport: failReport }),
    });

    const final = await run(service);

    assert.deepEqual(calls, [
        'translate', 'medical_audit', 'revise', 'verify',
        'repair', 'reverify', 'repair', 'reverify',
    ]);
    assert.equal(final.stage, 'needs_review');
    assert.equal(final.qualityStatus, 'needs_review');
    assert.equal(final.repairCount, 2);
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
    assert.deepEqual(
        {
            kind: final.qualityReviewReason.kind,
            stage: final.qualityReviewReason.stage,
            errorCode: final.qualityReviewReason.errorCode,
        },
        {
            kind: 'repair_output_invalid',
            stage: 'repair',
            errorCode: ErrorCodes.GEMINI_OUTPUT_TRUNCATED,
        }
    );
    assert.ok(final.qualityReviewReason.occurredAt instanceof Date);
});

test('every invalid repair output persists only its safe structured error code', async () => {
    for (const errorCode of [
        ErrorCodes.GEMINI_BLOCKED,
        ErrorCodes.GEMINI_OUTPUT_TRUNCATED,
        ErrorCodes.GEMINI_RESPONSE_INVALID,
        ErrorCodes.GEMINI_SCHEMA_INVALID,
    ]) {
        const model = new MemoryChunkModel();
        const calls = [];
        const executors = createExecutors(calls, { verifyReport: failReport });
        executors.repair = async () => {
            calls.push('repair');
            throw new ProcessingError(errorCode, 'raw response must not persist', { retryable: true });
        };
        const service = new QualityPipelineService({ ChunkModel: model, executors });
        const final = await run(service);
        assert.equal(final.qualityReviewReason.errorCode, errorCode);
        assert.doesNotMatch(JSON.stringify(final.qualityReviewReason), /raw response/);
    }
});

test('incomplete final coverage is never promoted to passed or sent through a blind repair', async () => {
    const model = new MemoryChunkModel();
    const calls = [];
    const service = new QualityPipelineService({
        ChunkModel: model,
        executors: createExecutors(calls, { verifyReport: incompleteCoverageReport }),
    });

    const final = await run(service);

    assert.deepEqual(calls, ['translate', 'medical_audit', 'revise', 'verify']);
    assert.equal(final.stage, 'needs_review');
    assert.equal(final.qualityStatus, 'needs_review');
    assert.equal(final.content, 'revise markdown');
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
