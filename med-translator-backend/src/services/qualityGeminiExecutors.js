import { ThinkingLevel } from '@google/genai';
import { GEMINI_MODEL, GEMINI_TIMEOUT_MS, getGeminiApiKeys } from '../config/env.js';
import { createGeminiFileContents, createPdfContents, generateGeminiContent } from './geminiAdapter.js';
import { GeminiKeyScheduler } from './geminiKeyScheduler.js';
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

export const qualityKeyScheduler = new GeminiKeyScheduler({ keysProvider: getGeminiApiKeys });

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
    generate = generateGeminiContent,
    onSchedulerEvent = () => {},
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
        signal,
    }) => {
        const result = await scheduler.execute(
            async ({ apiKey, keyIndex }) => {
                const generated = await generate({
                    apiKey,
                    keyIndex,
                    model: GEMINI_MODEL,
                    contents: createPdfContents(pdfBuffer, instruction),
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
                signal,
                onEvent: event => onSchedulerEvent({ stage, ...event }),
            }
        );
        return result;
    };

    return Object.freeze({
        document_context: ({ sourcePath, totalPages, signal }) => scheduler.execute(
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
                signal,
                onEvent: event => onSchedulerEvent({ stage: 'document_context', ...event }),
            }
        ),
        translate: ({ pdfBuffer, documentContext, signal }) => execute({
            stage: 'translate',
            pdfBuffer,
            instruction: buildTranslateInstruction(documentContext),
            systemInstruction: QUALITY_TRANSLATION_SYSTEM_INSTRUCTION,
            signal,
        }),
        medical_audit: ({ pdfBuffer, chunk, documentContext, signal }) => execute({
            stage: 'medical_audit',
            pdfBuffer,
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
            instruction: buildRevisionInstruction(chunk.draftContent, chunk.auditReport, { documentContext }),
            systemInstruction: MEDICAL_REVISION_SYSTEM_INSTRUCTION,
            referenceText: chunk.draftContent,
            signal,
        }),
        verify: ({ pdfBuffer, chunk, documentContext, signal }) => execute({
            stage: 'verify',
            pdfBuffer,
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
