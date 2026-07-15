import { ThinkingLevel } from '@google/genai';
import { GEMINI_MODEL, GEMINI_TIMEOUT_MS, getGeminiApiKeys } from '../config/env.js';
import { createPdfContents, generateGeminiContent } from './geminiAdapter.js';
import { GeminiKeyScheduler } from './geminiKeyScheduler.js';
import {
    buildAuditInstruction,
    buildRepairInstruction,
    buildRevisionInstruction,
    buildVerifyInstruction,
    MEDICAL_AUDIT_SYSTEM_INSTRUCTION,
    MEDICAL_REPAIR_SYSTEM_INSTRUCTION,
    MEDICAL_REVISION_SYSTEM_INSTRUCTION,
    MEDICAL_VERIFY_SYSTEM_INSTRUCTION,
    QUALITY_TRANSLATION_SYSTEM_INSTRUCTION,
} from './qualityPrompts.js';
import { isQualityReport, QUALITY_REPORT_JSON_SCHEMA } from './translationQuality.js';

const TRANSLATE_INSTRUCTION = 'Dựa trên PDF nguồn ở trên, dịch toàn văn sang tiếng Việt và chỉ trả Markdown hoàn chỉnh.';

export const qualityKeyScheduler = new GeminiKeyScheduler({ keysProvider: getGeminiApiKeys });

function stageConfig(systemInstruction, responseType) {
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

export function createQualityGeminiExecutors({
    scheduler = qualityKeyScheduler,
    generate = generateGeminiContent,
    onSchedulerEvent = () => {},
} = {}) {
    const execute = ({ stage, pdfBuffer, instruction, systemInstruction, responseType = 'text', signal }) => (
        scheduler.execute(
            ({ apiKey, keyIndex }) => generate({
                apiKey,
                keyIndex,
                model: GEMINI_MODEL,
                contents: createPdfContents(pdfBuffer, instruction),
                config: stageConfig(systemInstruction, responseType),
                signal,
                stage,
                validationMode: 'strict',
                responseType,
                structuredValidator: responseType === 'json' ? isQualityReport : undefined,
            }),
            {
                estimatedInputTokens: 10_000,
                signal,
                onEvent: event => onSchedulerEvent({ stage, ...event }),
            }
        )
    );

    return Object.freeze({
        translate: ({ pdfBuffer, signal }) => execute({
            stage: 'translate',
            pdfBuffer,
            instruction: TRANSLATE_INSTRUCTION,
            systemInstruction: QUALITY_TRANSLATION_SYSTEM_INSTRUCTION,
            signal,
        }),
        medical_audit: ({ pdfBuffer, chunk, signal }) => execute({
            stage: 'medical_audit',
            pdfBuffer,
            instruction: buildAuditInstruction(chunk.draftContent),
            systemInstruction: MEDICAL_AUDIT_SYSTEM_INSTRUCTION,
            responseType: 'json',
            signal,
        }),
        revise: ({ pdfBuffer, chunk, signal }) => execute({
            stage: 'revise',
            pdfBuffer,
            instruction: buildRevisionInstruction(chunk.draftContent, chunk.auditReport),
            systemInstruction: MEDICAL_REVISION_SYSTEM_INSTRUCTION,
            signal,
        }),
        verify: ({ pdfBuffer, chunk, signal }) => execute({
            stage: 'verify',
            pdfBuffer,
            instruction: buildVerifyInstruction(chunk.revisedContent),
            systemInstruction: MEDICAL_VERIFY_SYSTEM_INSTRUCTION,
            responseType: 'json',
            signal,
        }),
        repair: ({ pdfBuffer, chunk, signal }) => execute({
            stage: 'repair',
            pdfBuffer,
            instruction: buildRepairInstruction(chunk.revisedContent, chunk.verificationReport),
            systemInstruction: MEDICAL_REPAIR_SYSTEM_INSTRUCTION,
            signal,
        }),
        reverify: ({ pdfBuffer, chunk, signal }) => execute({
            stage: 'reverify',
            pdfBuffer,
            instruction: buildVerifyInstruction(chunk.repairedContent),
            systemInstruction: MEDICAL_VERIFY_SYSTEM_INSTRUCTION,
            responseType: 'json',
            signal,
        }),
    });
}
