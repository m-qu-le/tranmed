import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ThinkingLevel } from '@google/genai';
import { GEMINI_MODEL, GEMINI_TIMEOUT_MS, getGeminiApiKeys } from '../src/config/env.js';
import { createPdfContents, generateGeminiContent } from '../src/services/geminiAdapter.js';
import {
    LEGACY_TRANSLATION_SYSTEM_INSTRUCTION,
    TRANSLATE_USER_INSTRUCTION,
} from '../src/services/geminiPrompts.js';
import {
    buildAuditInstruction,
    buildRepairInstruction,
    buildRevisionInstruction,
    buildVerifyInstruction,
    MEDICAL_AUDIT_SYSTEM_INSTRUCTION,
    MEDICAL_REVISION_SYSTEM_INSTRUCTION,
    MEDICAL_VERIFY_SYSTEM_INSTRUCTION,
    QUALITY_TRANSLATION_SYSTEM_INSTRUCTION,
} from '../src/services/qualityPrompts.js';
import {
    hasBlockingQualityErrors,
    isQualityReport,
    QUALITY_REPORT_JSON_SCHEMA,
} from '../src/services/translationQuality.js';
import { extractPdfPageRange } from '../src/utils/pdfSplitter.js';
import { redactSensitiveText } from '../src/utils/redactSecrets.js';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), '../..');
const sampleDirectory = path.join(repositoryRoot, 'samplepdf');
const localOutputDirectory = path.join(repositoryRoot, '.p003-local', 'benchmarks');
const localInputDirectory = path.join(repositoryRoot, '.p003-local', 'benchmark-inputs');

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

async function callWithBenchmarkRotation(request, keys, firstKeyIndex) {
    const attempts = [];
    let lastError;

    for (let keysTried = 0; keysTried < keys.length; keysTried += 1) {
        const keyIndex = (firstKeyIndex + keysTried) % keys.length;
        const retriesOnKey = request.retryMode === 'legacy' ? 3 : 0;
        for (let retry = 0; retry <= retriesOnKey; retry += 1) {
            try {
                const result = await generateGeminiContent({
                    ...request,
                    apiKey: keys[keyIndex],
                    keyIndex,
                });
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
        maxOutputTokens: responseType === 'json' ? 8192 : 32768,
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

async function runQualityPipeline(pageRange, keys, firstKeyIndex) {
    const stages = {};
    const attempts = [];
    let nextKeyIndex = firstKeyIndex;

    const executeStage = async ({ stage, instruction, systemInstruction, responseType = 'text' }) => {
        const result = await callWithBenchmarkRotation({
            model: GEMINI_MODEL,
            contents: createPdfContents(pageRange.buffer, instruction),
            config: createQualityStageConfig(systemInstruction, responseType),
            stage,
            validationMode: 'strict',
            responseType,
            structuredValidator: responseType === 'json' ? isQualityReport : undefined,
            retryMode: 'quality',
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
        instruction: TRANSLATE_USER_INSTRUCTION,
        systemInstruction: QUALITY_TRANSLATION_SYSTEM_INSTRUCTION,
    });
    const audit = await executeStage({
        stage: 'medical_audit',
        instruction: buildAuditInstruction(translated.text),
        systemInstruction: MEDICAL_AUDIT_SYSTEM_INSTRUCTION,
        responseType: 'json',
    });
    const revised = await executeStage({
        stage: 'revise',
        instruction: buildRevisionInstruction(translated.text, audit.json),
        systemInstruction: MEDICAL_REVISION_SYSTEM_INSTRUCTION,
    });
    const verified = await executeStage({
        stage: 'verify',
        instruction: buildVerifyInstruction(revised.text),
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
            instruction: buildRepairInstruction(revised.text, verified.json),
            systemInstruction: MEDICAL_REVISION_SYSTEM_INSTRUCTION,
        });
        repairCount = 1;
        finalText = repaired.text;
        finalMetadata = repaired.metadata;
        const reverified = await executeStage({
            stage: 'reverify',
            instruction: buildVerifyInstruction(repaired.text),
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
        qualityStatus: hasBlockingQualityErrors(finalReport) ? 'needs_review' : 'passed',
    };
}

function safeFileStem(fileName) {
    return path.basename(fileName, path.extname(fileName))
        .normalize('NFKD')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase()
        .slice(0, 80);
}

export async function runBenchmark(options) {
    const variantConfig = BENCHMARK_VARIANTS[options.variant];
    const sourcePath = path.join(sampleDirectory, options.fileName);
    const sourceBytes = await readFile(sourcePath);
    const pageRange = await extractPdfPageRange(sourceBytes, options.startPage, variantConfig.pagesPerChunk);
    const inputSha256 = createHash('sha256').update(pageRange.buffer).digest('hex');
    let benchmarkInput = pageRange.buffer;
    if (!options.dryRun) {
        await mkdir(localInputDirectory, { recursive: true });
        const cachedInputPath = path.join(localInputDirectory, `${inputSha256}.pdf`);
        try {
            benchmarkInput = await readFile(cachedInputPath);
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
            await writeFile(cachedInputPath, pageRange.buffer);
        }
    }
    const generateConfig = createGenerateConfig(variantConfig, options.variant);
    const source = {
        fileName: options.fileName,
        sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'),
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
        },
    };

    if (options.dryRun) return { plan, artifactPath: null };

    const keys = getGeminiApiKeys();
    if (keys.length === 0) throw new Error('Không có GEMINI_API_KEYS để chạy benchmark.');
    const result = options.variant === 'B4'
        ? await runQualityPipeline({ ...pageRange, buffer: benchmarkInput }, keys, options.keyIndex % keys.length)
        : await callWithBenchmarkRotation({
            model: GEMINI_MODEL,
            contents: createPdfContents(benchmarkInput, TRANSLATE_USER_INSTRUCTION),
            config: generateConfig,
            stage: options.variant,
            validationMode: variantConfig.validationMode,
            retryMode: variantConfig.retryMode,
        }, keys, options.keyIndex % keys.length);
    const artifact = {
        ...plan,
        completedAt: new Date().toISOString(),
        configuredKeyCount: keys.length,
        attempts: result.attempts,
        response: {
            text: result.text,
            metadata: result.metadata,
        },
        qualityStatus: result.qualityStatus || null,
        repairCount: result.repairCount || 0,
        finalReport: result.finalReport || null,
        stages: result.stages || null,
    };

    await mkdir(localOutputDirectory, { recursive: true });
    const outputName = `${options.variant.toLowerCase()}-${safeFileStem(options.fileName)}-p${source.startPage}-${source.endPage}.json`;
    const artifactPath = path.join(localOutputDirectory, outputName);
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
