import { ThinkingLevel } from '@google/genai';
import {
    GEMINI_ACTIVE_PROJECT_LIMIT,
    GEMINI_MODEL,
    GEMINI_PROJECT_LIMITS,
    GEMINI_SCHEDULER_MODE,
    GEMINI_TIMEOUT_MS,
    getGeminiApiKeys,
    getGeminiProjects,
} from '../config/env.js';
import { createGeminiFileContents, createPdfContents, generateGeminiContent } from './geminiAdapter.js';
import { GeminiKeyScheduler } from './geminiKeyScheduler.js';
import { AdaptiveGeminiLimiter } from './adaptiveGeminiLimiter.js';
import GeminiQuotaState from '../models/geminiQuotaStateModel.js';
import { operationalMetrics } from './operationalMetrics.js';
import { runtimeResourceSnapshot } from './runtimeResourceMonitor.js';
import {
    buildAuditInstruction,
    buildRepairInstruction,
    buildRevisionInstruction,
    buildVerifyInstruction,
    buildDocumentContextInstruction,
    buildTranslateInstruction,
    DOCUMENT_CONTEXT_SYSTEM_INSTRUCTION,
    MEDICAL_AUDIT_SYSTEM_INSTRUCTION,
    MEDICAL_REPAIR_SYSTEM_INSTRUCTION,
    MEDICAL_REVISION_SYSTEM_INSTRUCTION,
    MEDICAL_VERIFY_SYSTEM_INSTRUCTION,
    QUALITY_TRANSLATION_SYSTEM_INSTRUCTION,
} from './qualityPrompts.js';
import {
    isQualityCoverageComplete,
    isQualityReport,
    minimumQualityCoverageItems,
    QUALITY_REPORT_JSON_SCHEMA,
} from './translationQuality.js';
import { normalizeQualityMarkdown } from './qualityMarkdown.js';
import { assertQualityTextCoverage } from './qualityTextGuard.js';
import { DOCUMENT_CONTEXT_JSON_SCHEMA, isQualityDocumentContext } from './qualityDocumentContext.js';
import { ErrorCodes, ProcessingError } from '../utils/processingError.js';
import { qualityStageAttemptKey } from './qualityPipelineState.js';

const legacyProjectsProvider = () => getGeminiApiKeys().map((apiKey, index) => ({
    id: `legacy-key-${index + 1}`,
    apiKey,
    index,
}));
const projectProvider = GEMINI_SCHEDULER_MODE === 'legacy'
    ? legacyProjectsProvider
    : getGeminiProjects;
const configuredProjectCount = projectProvider().length;
const activeProjectCount = GEMINI_SCHEDULER_MODE === 'legacy'
    ? configuredProjectCount
    : Math.min(GEMINI_ACTIVE_PROJECT_LIMIT, configuredProjectCount);
const schedulerLimits = GEMINI_SCHEDULER_MODE === 'legacy'
    ? {
        rpm: 12,
        tpm: 200_000,
        normalRpd: 400,
        retryRpd: 400,
        totalRpd: 400,
        maxInFlight: Number.MAX_SAFE_INTEGER,
    }
    : GEMINI_PROJECT_LIMITS;

export const qualityKeyScheduler = new GeminiKeyScheduler({
    projectsProvider: projectProvider,
    StateModel: GEMINI_SCHEDULER_MODE === 'project_pool' ? GeminiQuotaState : null,
    limits: schedulerLimits,
    activeProjectLimit: activeProjectCount,
    maxPhysicalAttempts: GEMINI_SCHEDULER_MODE === 'legacy'
        ? Math.max(1, configuredProjectCount)
        : 3,
    maxInlineWaitMs: 60_000,
});
export const qualityGeminiLimiter = new AdaptiveGeminiLimiter({
    initialLimit: GEMINI_SCHEDULER_MODE === 'legacy' ? 3 : Math.max(1, activeProjectCount),
    minLimit: GEMINI_SCHEDULER_MODE === 'legacy' ? 3 : Math.max(1, activeProjectCount),
    maxLimit: GEMINI_SCHEDULER_MODE === 'legacy'
        ? 6
        : Math.max(1, Math.min(100, activeProjectCount * 2)),
    successesPerIncrease: 30,
    resourceProvider: runtimeResourceSnapshot,
});

function wait(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new ProcessingError(ErrorCodes.CANCELLED, 'Đã hủy khi chờ Gemini xử lý PDF.'));
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new ProcessingError(ErrorCodes.CANCELLED, 'Đã hủy khi chờ Gemini xử lý PDF.'));
        }, { once: true });
    });
}

async function waitForGeminiFile(client, initialFile, signal) {
    let file = initialFile;
    for (let attempt = 0; file?.state === 'PROCESSING' && attempt < 60; attempt += 1) {
        await wait(1000, signal);
        file = await client.files.get({ name: file.name });
    }
    if (file?.state === 'FAILED') {
        throw new ProcessingError(ErrorCodes.GEMINI_RESPONSE_INVALID, 'Gemini không xử lý được PDF context.', { retryable: true });
    }
    if (!file?.uri || file?.state === 'PROCESSING') {
        throw new ProcessingError(ErrorCodes.GEMINI_UNAVAILABLE, 'Gemini chưa sẵn sàng PDF context.', { retryable: true });
    }
    return file;
}

function stageConfig(systemInstruction, responseType, jsonSchema = QUALITY_REPORT_JSON_SCHEMA) {
    const config = {
        systemInstruction,
        maxOutputTokens: responseType === 'json' ? 16384 : 65536,
        thinkingConfig: {
            thinkingLevel: ThinkingLevel.HIGH,
            includeThoughts: false,
        },
        httpOptions: { timeout: GEMINI_TIMEOUT_MS },
    };
    if (responseType === 'json') {
        config.responseMimeType = 'application/json';
        config.responseJsonSchema = jsonSchema;
    }
    return config;
}

export function createQualityGeminiExecutors({
    scheduler = qualityKeyScheduler,
    limiter = qualityGeminiLimiter,
    generate = generateGeminiContent,
    onSchedulerEvent = () => {},
    schedulingContext = {},
    uploadFile = async ({ apiKey, sourcePath, signal }) => {
        const { GoogleGenAI } = await import('@google/genai');
        const client = new GoogleGenAI({ apiKey });
        const file = await client.files.upload({
            file: sourcePath,
            config: { mimeType: 'application/pdf' },
        });
        return { client, file };
    },
} = {}) {
    const schedule = async (requestFactory, options) => {
        operationalMetrics.increment('gemini.logical_stages');
        if (options.metricStage) {
            operationalMetrics.increment(`gemini.${options.metricStage}.logical_stages`);
        }
        let physicalAttempts = 0;
        let lastProjectIndex = null;
        try {
            const result = await scheduler.execute(
                credentials => limiter.run(
                    () => {
                        credentials.markPhysicalStart?.();
                        return requestFactory(credentials);
                    },
                    {
                        signal: options.signal,
                        priority: schedulingContext.priority || 0,
                        jobId: schedulingContext.jobId || null,
                    }
                ),
                {
                    ...options,
                    deferPhysicalStart: true,
                    jobId: schedulingContext.jobId || null,
                    onEvent: event => {
                        if (event.type === 'reserved') {
                            physicalAttempts = Math.max(
                                physicalAttempts,
                                Number(event.physicalAttempt) || physicalAttempts + 1
                            );
                            lastProjectIndex = event.keyIndex;
                            operationalMetrics.increment('gemini.physical_attempts');
                            if (options.metricStage) {
                                operationalMetrics.increment(
                                    `gemini.${options.metricStage}.physical_attempts`
                                );
                            }
                        }
                        if (event.type === 'cooldown' && event.status === 429) {
                            operationalMetrics.increment('gemini.rate_limit_responses');
                            operationalMetrics.increment(`gemini.project_${event.keyIndex}.rate_limit_responses`);
                            limiter.onKeyRateLimit();
                        }
                        if (event.type === 'content_retry') {
                            operationalMetrics.increment('gemini.content_retries');
                        }
                        if (event.type === 'service_retry') {
                            operationalMetrics.increment('gemini.service_retries');
                        }
                        options.onEvent?.(event);
                    },
                }
            );
            if (options.metricStage && Number.isFinite(result?.metadata?.latencyMs)) {
                operationalMetrics.observe(
                    `gemini.${options.metricStage}.latency`,
                    result.metadata.latencyMs
                );
            }
            const usage = result?.metadata?.usage;
            if (options.metricStage && Number.isFinite(usage?.promptTokenCount)) {
                operationalMetrics.observeDistribution(
                    `gemini.${options.metricStage}.prompt_tokens`,
                    usage.promptTokenCount
                );
            }
            if (options.metricStage && Number.isFinite(usage?.totalTokenCount)) {
                operationalMetrics.observeDistribution(
                    `gemini.${options.metricStage}.total_tokens`,
                    usage.totalTokenCount
                );
            }
            return result;
        } catch (error) {
            if (error?.poolExhausted) limiter.onPoolExhausted();
            error.schedulerMetadata = {
                physicalAttempts,
                projectIndex: lastProjectIndex,
            };
            throw error;
        }
    };

    const attemptKindFor = (chunk, stage) => (
        Number(chunk?.stageAttempts?.[qualityStageAttemptKey(stage, chunk)] || 0) > 1
            ? 'retry'
            : 'normal'
    );

    const execute = async ({
        stage,
        pdfBuffer,
        instruction,
        systemInstruction,
        responseType = 'text',
        referenceText = null,
        requireCoverage = false,
        jsonSchema = QUALITY_REPORT_JSON_SCHEMA,
        structuredValidator = isQualityReport,
        chunk = null,
        signal,
    }) => {
        const result = await schedule(
            async ({ apiKey, keyIndex }) => {
                const generated = await generate({
                    apiKey,
                    keyIndex,
                    model: GEMINI_MODEL,
                    contents: createPdfContents(
                        typeof pdfBuffer === 'function' ? pdfBuffer() : pdfBuffer,
                        instruction
                    ),
                    config: stageConfig(systemInstruction, responseType, jsonSchema),
                    signal,
                    stage,
                    validationMode: 'strict',
                    responseType,
                    structuredValidator: responseType === 'json' ? structuredValidator : undefined,
                });
                if (responseType === 'json') {
                    if (requireCoverage && !isQualityCoverageComplete(generated.json, referenceText)) {
                        const error = new ProcessingError(
                            ErrorCodes.GEMINI_SCHEMA_INVALID,
                            `Gemini stage ${stage} không cung cấp coverage checklist đủ sâu.`,
                            { retryable: true, publicMessage: 'Báo cáo kiểm định chưa đủ chi tiết; hệ thống sẽ thử lại.' }
                        );
                        error.geminiMetadata = generated.metadata;
                        throw error;
                    }
                    return generated;
                }
                const normalized = { ...generated, text: normalizeQualityMarkdown(generated.text) };
                if (referenceText) {
                    assertQualityTextCoverage({
                        candidate: normalized.text,
                        reference: referenceText,
                        stage,
                        metadata: normalized.metadata,
                    });
                }
                return normalized;
            },
            {
                estimatedInputTokens: 10_000,
                metricStage: stage,
                attemptKind: attemptKindFor(chunk, stage),
                signal,
                onEvent: event => onSchedulerEvent({ stage, ...event }),
            }
        );
        return result;
    };

    return Object.freeze({
        document_context: ({ sourcePath, totalPages, signal }) => schedule(
            async ({ apiKey, keyIndex }) => {
                const { client, file } = await uploadFile({ apiKey, sourcePath, signal });
                try {
                    const readyFile = await waitForGeminiFile(client, file, signal);
                    const generated = await generate({
                        apiKey,
                        keyIndex,
                        model: GEMINI_MODEL,
                        contents: createGeminiFileContents(readyFile, buildDocumentContextInstruction()),
                        config: stageConfig(DOCUMENT_CONTEXT_SYSTEM_INSTRUCTION, 'json', DOCUMENT_CONTEXT_JSON_SCHEMA),
                        signal,
                        stage: 'document_context',
                        validationMode: 'strict',
                        responseType: 'json',
                        structuredValidator: isQualityDocumentContext,
                        clientFactory: () => client,
                    });
                    return generated;
                } finally {
                    if (file?.name) await client.files.delete({ name: file.name }).catch(() => {});
                }
            },
            {
                estimatedInputTokens: Math.min(200_000, Math.max(20_000, totalPages * 258)),
                metricStage: 'document_context',
                attemptKind: 'normal',
                signal,
                onEvent: event => onSchedulerEvent({ stage: 'document_context', ...event }),
            }
        ),
        translate: ({ pdfBuffer, chunk, documentContext, signal }) => execute({
            stage: 'translate',
            pdfBuffer,
            chunk,
            instruction: buildTranslateInstruction(documentContext),
            systemInstruction: QUALITY_TRANSLATION_SYSTEM_INSTRUCTION,
            signal,
        }),
        medical_audit: ({ pdfBuffer, chunk, documentContext, signal }) => execute({
            stage: 'medical_audit',
            pdfBuffer,
            chunk,
            instruction: buildAuditInstruction(chunk.draftContent, {
                documentContext,
                minimumCoverageItems: minimumQualityCoverageItems(chunk.draftContent),
            }),
            systemInstruction: MEDICAL_AUDIT_SYSTEM_INSTRUCTION,
            responseType: 'json',
            referenceText: chunk.draftContent,
            requireCoverage: true,
            signal,
        }),
        revise: ({ pdfBuffer, chunk, documentContext, signal }) => execute({
            stage: 'revise',
            pdfBuffer,
            chunk,
            instruction: buildRevisionInstruction(chunk.draftContent, chunk.auditReport, { documentContext }),
            systemInstruction: MEDICAL_REVISION_SYSTEM_INSTRUCTION,
            referenceText: chunk.draftContent,
            signal,
        }),
        verify: ({ pdfBuffer, chunk, documentContext, signal }) => execute({
            stage: 'verify',
            pdfBuffer,
            chunk,
            instruction: buildVerifyInstruction(chunk.revisedContent, {
                documentContext,
                minimumCoverageItems: minimumQualityCoverageItems(chunk.revisedContent),
            }),
            systemInstruction: MEDICAL_VERIFY_SYSTEM_INSTRUCTION,
            responseType: 'json',
            referenceText: chunk.revisedContent,
            signal,
        }),
        repair: ({ pdfBuffer, chunk, documentContext, signal }) => execute({
            stage: 'repair',
            pdfBuffer,
            chunk,
            instruction: buildRepairInstruction(
                chunk.repairedContent || chunk.revisedContent,
                chunk.reverifyReport || chunk.verificationReport,
                { documentContext }
            ),
            systemInstruction: MEDICAL_REPAIR_SYSTEM_INSTRUCTION,
            referenceText: chunk.repairedContent || chunk.revisedContent,
            signal,
        }),
        reverify: ({ pdfBuffer, chunk, documentContext, signal }) => execute({
            stage: 'reverify',
            pdfBuffer,
            chunk,
            instruction: buildVerifyInstruction(chunk.repairedContent, {
                documentContext,
                minimumCoverageItems: minimumQualityCoverageItems(chunk.repairedContent),
            }),
            systemInstruction: MEDICAL_VERIFY_SYSTEM_INSTRUCTION,
            responseType: 'json',
            referenceText: chunk.repairedContent,
            signal,
        }),
    });
}
