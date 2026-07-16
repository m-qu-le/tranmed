import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { GEMINI_MODEL, GEMINI_TIMEOUT_MS, getGeminiApiKeys } from '../src/config/env.js';
import { createGeminiFileContents, createPdfContents, generateGeminiContent } from '../src/services/geminiAdapter.js';
import {
    LEGACY_TRANSLATION_SYSTEM_INSTRUCTION,
    TRANSLATE_USER_INSTRUCTION,
} from '../src/services/geminiPrompts.js';
import {
    buildAuditInstruction,
    buildDocumentContextInstruction,
    buildRepairInstruction,
    buildRevisionInstruction,
    buildTranslateInstruction,
    buildVerifyInstruction,
    DOCUMENT_CONTEXT_SYSTEM_INSTRUCTION,
    MEDICAL_AUDIT_SYSTEM_INSTRUCTION,
    MEDICAL_REPAIR_SYSTEM_INSTRUCTION,
    MEDICAL_REVISION_SYSTEM_INSTRUCTION,
    MEDICAL_VERIFY_SYSTEM_INSTRUCTION,
    QUALITY_TRANSLATION_SYSTEM_INSTRUCTION,
} from '../src/services/qualityPrompts.js';
import {
    hasBlockingQualityErrors,
    isQualityCoverageComplete,
    isQualityReport,
    QUALITY_REPORT_JSON_SCHEMA,
} from '../src/services/translationQuality.js';
import { isQualityDocumentContext } from '../src/services/qualityDocumentContext.js';
import { extractPdfPageRange } from '../src/utils/pdfSplitter.js';
import { redactSensitiveText } from '../src/utils/redactSecrets.js';
import { normalizeQualityMarkdown } from '../src/services/qualityMarkdown.js';
import { assertQualityTextCoverage } from '../src/services/qualityTextGuard.js';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), '../..');
const sampleDirectory = path.join(repositoryRoot, 'samplepdf');
const localOutputDirectory = path.join(repositoryRoot, '.p003-local', 'benchmarks');
const localInputDirectory = path.join(repositoryRoot, '.p003-local', 'benchmark-inputs');
const MIN_KEY_INTERVAL_MS = 5200;
const nextKeyRequestAt = new Map();
let rateGate = Promise.resolve();

export const BENCHMARK_VARIANTS = Object.freeze({
    B0: Object.freeze({
        pagesPerChunk: 3,
        temperature: 0.1,
        thinkingLevel: null,
        validationMode: 'legacy',
        retryMode: 'legacy',
    }),
    B1: Object.freeze({
        pagesPerChunk: 2,
        temperature: 1,
        thinkingLevel: ThinkingLevel.MINIMAL,
        validationMode: 'strict',
        retryMode: 'quality',
    }),
    B2: Object.freeze({
        pagesPerChunk: 2,
        temperature: 1,
        thinkingLevel: ThinkingLevel.MEDIUM,
        validationMode: 'strict',
        retryMode: 'quality',
    }),
    B3: Object.freeze({
        pagesPerChunk: 2,
        temperature: 1,
        thinkingLevel: ThinkingLevel.HIGH,
        validationMode: 'strict',
        retryMode: 'quality',
    }),
    B4: Object.freeze({
        pagesPerChunk: 2,
        temperature: 1,
        thinkingLevel: ThinkingLevel.HIGH,
        validationMode: 'strict',
        retryMode: 'quality',
        pipeline: 'translate_audit_revise_verify_repair',
    }),
    B5: Object.freeze({
        pagesPerChunk: 2,
        temperature: 1,
        thinkingLevel: ThinkingLevel.HIGH,
        validationMode: 'strict',
        retryMode: 'quality',
        pipeline: 'document_context_translate_audit_revise_verify_repair',
    }),
});

function argumentValue(args, name) {
    const index = args.indexOf(name);
    return index === -1 ? null : args[index + 1];
}

export function parseBenchmarkArgs(args) {
    const usesNamedArguments = args.includes('--variant') || args.includes('--file') || args.includes('--start-page');
    const variant = (argumentValue(args, '--variant') || (!usesNamedArguments ? args[0] : '') || '').toUpperCase();
    const fileName = argumentValue(args, '--file') || (!usesNamedArguments ? args[1] : null);
    const rawStartPage = argumentValue(args, '--start-page') || (!usesNamedArguments ? args[2] : null) || '1';
    const startPage = Number.parseInt(rawStartPage, 10);
    const positionalKeyIndex = !usesNamedArguments && args[3] !== 'dry-run' ? args[3] : null;
    const rawKeyIndex = argumentValue(args, '--key-index') || positionalKeyIndex || '0';
    const keyIndex = Number.parseInt(rawKeyIndex, 10);
    const dryRun = args.includes('--dry-run') || args.includes('dry-run');

    if (!BENCHMARK_VARIANTS[variant]) {
        throw new Error(`--variant phải là một trong: ${Object.keys(BENCHMARK_VARIANTS).join(', ')}.`);
    }
    if (!fileName || path.basename(fileName) !== fileName || !fileName.toLowerCase().endsWith('.pdf')) {
        throw new Error('--file phải là tên một PDF trực tiếp trong samplepdf/.');
    }
    if (!Number.isSafeInteger(startPage) || startPage <= 0 || String(startPage) !== rawStartPage) {
        throw new Error('--start-page phải là số nguyên dương theo hệ 1-based.');
    }
    if (!Number.isSafeInteger(keyIndex) || keyIndex < 0 || String(keyIndex) !== rawKeyIndex) {
        throw new Error('--key-index phải là số nguyên không âm, theo hệ 0-based.');
    }

    return Object.freeze({ variant, fileName, startPage, keyIndex, dryRun });
}

function publicError(error) {
    const status = error?.status || error?.response?.status || null;
    return {
        status,
        code: error?.code || null,
        message: redactSensitiveText(error?.message || 'Unknown Gemini error'),
        finishReason: error?.geminiMetadata?.finishReason || null,
    };
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForBenchmarkHeadroom(keyIndex) {
    let release;
    const previousGate = rateGate;
    rateGate = new Promise(resolve => { release = resolve; });
    await previousGate;
    const now = Date.now();
    const scheduledAt = Math.max(now, nextKeyRequestAt.get(keyIndex) || 0);
    nextKeyRequestAt.set(keyIndex, scheduledAt + MIN_KEY_INTERVAL_MS);
    release();
    if (scheduledAt > now) await delay(scheduledAt - now);
}

async function callWithBenchmarkRotation(request, keys, firstKeyIndex) {
    const attempts = [];
    let lastError;

    for (let keysTried = 0; keysTried < keys.length; keysTried += 1) {
        const keyIndex = (firstKeyIndex + keysTried) % keys.length;
        const retriesOnKey = request.retryMode === 'legacy' ? 3 : 0;
        for (let retry = 0; retry <= retriesOnKey; retry += 1) {
            try {
                await waitForBenchmarkHeadroom(keyIndex);
                let result = await generateGeminiContent({
                    ...request,
                    apiKey: keys[keyIndex],
                    keyIndex,
                });
                request.validateResult?.(result);
                if (request.responseType !== 'json') {
                    result = { ...result, text: normalizeQualityMarkdown(result.text) };
                    if (request.referenceText) {
                        assertQualityTextCoverage({
                            candidate: result.text,
                            reference: request.referenceText,
                            stage: request.stage,
                            metadata: result.metadata,
                        });
                    }
                }
                attempts.push({ keyIndex, retry, outcome: 'success', finishReason: result.metadata.finishReason });
                return { ...result, attempts };
            } catch (error) {
                lastError = error;
                const detail = publicError(error);
                attempts.push({ keyIndex, retry, outcome: 'error', ...detail });
                const retryableTransport = detail.status === 429
                    || [500, 502, 503, 504].includes(detail.status)
                    || detail.status === null;

                if (request.retryMode !== 'legacy' || !retryableTransport || retry === retriesOnKey) break;
                await delay((retry + 1) * 12000);
            }
        }
    }

    lastError.benchmarkAttempts = attempts;
    throw lastError;
}

function createGenerateConfig(variantConfig, variant) {
    const config = {
        systemInstruction: variant === 'B0'
            ? LEGACY_TRANSLATION_SYSTEM_INSTRUCTION
            : QUALITY_TRANSLATION_SYSTEM_INSTRUCTION,
        temperature: variantConfig.temperature,
        httpOptions: { timeout: GEMINI_TIMEOUT_MS },
    };
    if (variantConfig.thinkingLevel) {
        config.thinkingConfig = {
            thinkingLevel: variantConfig.thinkingLevel,
            includeThoughts: false,
        };
    }
    return config;
}

function createQualityStageConfig(systemInstruction, responseType = 'text') {
    const config = {
        systemInstruction,
        temperature: 1,
        maxOutputTokens: responseType === 'json' ? 16384 : 32768,
        thinkingConfig: {
            thinkingLevel: ThinkingLevel.HIGH,
            includeThoughts: false,
        },
        httpOptions: { timeout: GEMINI_TIMEOUT_MS },
    };
    if (responseType === 'json') {
        config.responseMimeType = 'application/json';
        config.responseJsonSchema = QUALITY_REPORT_JSON_SCHEMA;
    }
    return config;
}

async function waitForBenchmarkFile(client, initialFile) {
    let file = initialFile;
    for (let attempt = 0; file?.state === 'PROCESSING' && attempt < 60; attempt += 1) {
        await delay(1000);
        file = await client.files.get({ name: file.name });
    }
    if (file?.state === 'FAILED' || !file?.uri || file?.state === 'PROCESSING') {
        throw new Error('Gemini File API chưa sẵn sàng PDF context.');
    }
    return file;
}

async function buildBenchmarkDocumentContext(sourcePath, totalPages, keys, firstKeyIndex) {
    const attempts = [];
    let lastError;
    for (let keysTried = 0; keysTried < keys.length; keysTried += 1) {
        const keyIndex = (firstKeyIndex + keysTried) % keys.length;
        let client = null;
        let file = null;
        try {
            await waitForBenchmarkHeadroom(keyIndex);
            client = new GoogleGenAI({ apiKey: keys[keyIndex] });
            file = await client.files.upload({ file: sourcePath, config: { mimeType: 'application/pdf' } });
            const readyFile = await waitForBenchmarkFile(client, file);
            const result = await generateGeminiContent({
                apiKey: keys[keyIndex],
                keyIndex,
                model: GEMINI_MODEL,
                contents: createGeminiFileContents(readyFile, buildDocumentContextInstruction()),
                config: {
                    ...createQualityStageConfig(DOCUMENT_CONTEXT_SYSTEM_INSTRUCTION, 'json'),
                },
                stage: 'document_context',
                validationMode: 'strict',
                responseType: 'json',
                structuredValidator: isQualityDocumentContext,
                clientFactory: () => client,
            });
            attempts.push({ keyIndex, outcome: 'success', finishReason: result.metadata.finishReason });
            return { context: result.json, metadata: result.metadata, attempts };
        } catch (error) {
            lastError = error;
            attempts.push({ keyIndex, outcome: 'error', ...publicError(error) });
        } finally {
            if (file?.name) await client?.files.delete({ name: file.name }).catch(() => {});
        }
    }
    lastError.benchmarkAttempts = attempts;
    throw lastError;
}

async function runQualityPipeline(pageRange, keys, firstKeyIndex, documentContext = null) {
    const stages = {};
    const attempts = [];
    let nextKeyIndex = firstKeyIndex;

    const executeStage = async ({
        stage,
        instruction,
        systemInstruction,
        responseType = 'text',
        referenceText = null,
        requireCoverage = false,
    }) => {
        const result = await callWithBenchmarkRotation({
            model: GEMINI_MODEL,
            contents: createPdfContents(pageRange.buffer, instruction),
            config: createQualityStageConfig(systemInstruction, responseType),
            stage,
            validationMode: 'strict',
            responseType,
            structuredValidator: responseType === 'json' ? isQualityReport : undefined,
            retryMode: 'quality',
            referenceText,
            validateResult: requireCoverage ? result => {
                if (!isQualityCoverageComplete(result.json, referenceText)) {
                    const error = new Error(`Gemini stage ${stage} không cung cấp coverage checklist đủ sâu.`);
                    error.code = 'GEMINI_SCHEMA_INVALID';
                    throw error;
                }
            } : undefined,
        }, keys, nextKeyIndex);
        attempts.push(...result.attempts.map(attempt => ({ stage, ...attempt })));
        nextKeyIndex = (result.metadata.keyIndex + 1) % keys.length;
        stages[stage] = {
            text: responseType === 'text' ? result.text : undefined,
            report: responseType === 'json' ? result.json : undefined,
            metadata: result.metadata,
        };
        return result;
    };

    const translated = await executeStage({
        stage: 'translate',
        instruction: buildTranslateInstruction(documentContext),
        systemInstruction: QUALITY_TRANSLATION_SYSTEM_INSTRUCTION,
    });
    const audit = await executeStage({
        stage: 'medical_audit',
        instruction: buildAuditInstruction(translated.text, { documentContext }),
        systemInstruction: MEDICAL_AUDIT_SYSTEM_INSTRUCTION,
        responseType: 'json',
        referenceText: translated.text,
        requireCoverage: true,
    });
    const revised = await executeStage({
        stage: 'revise',
        instruction: buildRevisionInstruction(translated.text, audit.json, { documentContext }),
        systemInstruction: MEDICAL_REVISION_SYSTEM_INSTRUCTION,
        referenceText: translated.text,
    });
    const verified = await executeStage({
        stage: 'verify',
        instruction: buildVerifyInstruction(revised.text, { documentContext }),
        systemInstruction: MEDICAL_VERIFY_SYSTEM_INSTRUCTION,
        responseType: 'json',
    });

    let finalText = revised.text;
    let finalMetadata = revised.metadata;
    let finalReport = verified.json;
    let repairCount = 0;
    if (hasBlockingQualityErrors(verified.json)) {
        const repaired = await executeStage({
            stage: 'repair',
            instruction: buildRepairInstruction(revised.text, verified.json, { documentContext }),
            systemInstruction: MEDICAL_REPAIR_SYSTEM_INSTRUCTION,
            referenceText: revised.text,
        });
        repairCount = 1;
        finalText = repaired.text;
        finalMetadata = repaired.metadata;
        const reverified = await executeStage({
            stage: 'reverify',
            instruction: buildVerifyInstruction(repaired.text, { documentContext }),
            systemInstruction: MEDICAL_VERIFY_SYSTEM_INSTRUCTION,
            responseType: 'json',
        });
        finalReport = reverified.json;
    }

    return {
        text: finalText,
        metadata: finalMetadata,
        attempts,
        stages,
        finalReport,
        repairCount,
        qualityStatus: hasBlockingQualityErrors(finalReport) || !isQualityCoverageComplete(finalReport, finalText)
            ? 'needs_review'
            : 'passed',
    };
}

export function benchmarkSafeFileStem(fileName) {
    return path.basename(fileName, path.extname(fileName))
        .normalize('NFKD')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase()
        .slice(0, 80);
}

export function benchmarkArtifactPath(plan) {
    const outputName = `${plan.variant.toLowerCase()}-${benchmarkSafeFileStem(plan.source.fileName)}-p${plan.source.startPage}-${plan.source.endPage}.json`;
    return path.join(localOutputDirectory, outputName);
}

export async function runBenchmark(options) {
    const variantConfig = BENCHMARK_VARIANTS[options.variant];
    const sourcePath = path.join(sampleDirectory, options.fileName);
    const sourceBytes = await readFile(sourcePath);
    const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
    const pageRange = await extractPdfPageRange(sourceBytes, options.startPage, variantConfig.pagesPerChunk);
    let benchmarkInput = pageRange.buffer;
    await mkdir(localInputDirectory, { recursive: true });
    const cachedInputPath = path.join(
        localInputDirectory,
        `${sourceSha256}-p${pageRange.startPage}-${pageRange.endPage}.pdf`
    );
    try {
        benchmarkInput = await readFile(cachedInputPath);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        if (!options.dryRun) {
            try {
                await writeFile(cachedInputPath, pageRange.buffer, { flag: 'wx' });
            } catch (writeError) {
                if (writeError?.code !== 'EEXIST') throw writeError;
                benchmarkInput = await readFile(cachedInputPath);
            }
        }
    }
    const inputSha256 = createHash('sha256').update(benchmarkInput).digest('hex');
    const generateConfig = createGenerateConfig(variantConfig, options.variant);
    const source = {
        fileName: options.fileName,
        sourceSha256,
        totalPages: pageRange.totalPages,
        startPage: pageRange.startPage,
        endPage: pageRange.endPage,
        pageCount: pageRange.pageCount,
        inputSha256,
    };
    const plan = {
        schemaVersion: 1,
        variant: options.variant,
        model: GEMINI_MODEL,
        source,
        requestConfig: {
            temperature: variantConfig.temperature,
            thinkingLevel: variantConfig.thinkingLevel,
            includeThoughts: variantConfig.thinkingLevel ? false : null,
            validationMode: variantConfig.validationMode,
            retryMode: variantConfig.retryMode,
            firstKeyIndex: options.keyIndex,
            pipeline: variantConfig.pipeline || 'single_pass',
            systemInstructionSha256: createHash('sha256')
                .update(options.variant === 'B0' ? LEGACY_TRANSLATION_SYSTEM_INSTRUCTION : QUALITY_TRANSLATION_SYSTEM_INSTRUCTION)
                .digest('hex'),
            pipelineInstructionSha256: ['B4', 'B5'].includes(options.variant)
                ? createHash('sha256').update([
                    ...(options.variant === 'B5' ? [DOCUMENT_CONTEXT_SYSTEM_INSTRUCTION] : []),
                    MEDICAL_AUDIT_SYSTEM_INSTRUCTION,
                    MEDICAL_REVISION_SYSTEM_INSTRUCTION,
                    MEDICAL_VERIFY_SYSTEM_INSTRUCTION,
                    MEDICAL_REPAIR_SYSTEM_INSTRUCTION,
                ].join('\n')).digest('hex')
                : null,
        },
    };

    if (options.dryRun) return { plan, artifactPath: null };

    const keys = getGeminiApiKeys();
    if (keys.length === 0) throw new Error('Không có GEMINI_API_KEYS để chạy benchmark.');
    let context = null;
    let contextResult = null;
    if (options.variant === 'B5') {
        contextResult = await buildBenchmarkDocumentContext(sourcePath, pageRange.totalPages, keys, options.keyIndex % keys.length);
        context = contextResult.context;
    }
    const result = ['B4', 'B5'].includes(options.variant)
        ? await runQualityPipeline({ ...pageRange, buffer: benchmarkInput }, keys, options.keyIndex % keys.length, context)
        : await callWithBenchmarkRotation({
            model: GEMINI_MODEL,
            contents: createPdfContents(
                benchmarkInput,
                options.variant === 'B0' ? TRANSLATE_USER_INSTRUCTION : QUALITY_TRANSLATE_USER_INSTRUCTION
            ),
            config: generateConfig,
            stage: options.variant,
            validationMode: variantConfig.validationMode,
            retryMode: variantConfig.retryMode,
        }, keys, options.keyIndex % keys.length);
    const artifact = {
        ...plan,
        completedAt: new Date().toISOString(),
        configuredKeyCount: keys.length,
        attempts: [...(contextResult?.attempts || []), ...result.attempts],
        response: {
            text: result.text,
            metadata: result.metadata,
        },
        qualityStatus: result.qualityStatus || null,
        repairCount: result.repairCount || 0,
        finalReport: result.finalReport || null,
        stages: result.stages || null,
        documentContext: contextResult ? {
            sha256: createHash('sha256').update(JSON.stringify(context)).digest('hex'),
            metadata: contextResult.metadata,
        } : null,
    };

    await mkdir(localOutputDirectory, { recursive: true });
    const artifactPath = benchmarkArtifactPath(plan);
    await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    return {
        plan,
        artifactPath,
        metadata: result.metadata,
        attempts: result.attempts,
        qualityStatus: result.qualityStatus || null,
        repairCount: result.repairCount || 0,
        finalReport: result.finalReport || null,
    };
}

async function main() {
    const options = parseBenchmarkArgs(process.argv.slice(2));
    const result = await runBenchmark(options);
    console.log(JSON.stringify({
        ...result.plan,
        artifactPath: result.artifactPath ? path.relative(repositoryRoot, result.artifactPath) : null,
        metadata: result.metadata || null,
        attempts: result.attempts || [],
        qualityStatus: result.qualityStatus || null,
        repairCount: result.repairCount || 0,
        finalReport: result.finalReport || null,
    }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    main().catch(error => {
        console.error(redactSensitiveText(error?.stack || error));
        if (error?.benchmarkAttempts) console.error(JSON.stringify(error.benchmarkAttempts, null, 2));
        process.exitCode = 1;
    });
}
