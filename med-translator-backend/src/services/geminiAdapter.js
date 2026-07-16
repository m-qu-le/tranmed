import { performance } from 'node:perf_hooks';
import { GoogleGenAI } from '@google/genai';
import { ErrorCodes, ProcessingError } from '../utils/processingError.js';

function responseMetadata(response, latencyMs, keyIndex, stage) {
    const candidate = response?.candidates?.[0];
    const usage = response?.usageMetadata || {};

    return Object.freeze({
        stage,
        keyIndex,
        latencyMs: Math.round(latencyMs),
        finishReason: candidate?.finishReason || null,
        finishMessage: candidate?.finishMessage || null,
        modelVersion: response?.modelVersion || null,
        responseId: response?.responseId || null,
        blockReason: response?.promptFeedback?.blockReason || null,
        usage: Object.freeze({
            promptTokenCount: usage.promptTokenCount ?? null,
            candidatesTokenCount: usage.candidatesTokenCount ?? null,
            thoughtsTokenCount: usage.thoughtsTokenCount ?? null,
            totalTokenCount: usage.totalTokenCount ?? null,
        }),
    });
}

function invalidResponse(code, message, metadata) {
    const error = new ProcessingError(code, message, {
        retryable: true,
        publicMessage: 'Gemini trả về kết quả chưa hoàn chỉnh; hệ thống sẽ thử lại.',
    });
    error.geminiMetadata = metadata;
    return error;
}

export function validateGeminiResponse(response, options = {}) {
    const {
        validationMode = 'strict',
        responseType = 'text',
        keyIndex = null,
        stage = 'translate',
        latencyMs = 0,
        structuredValidator,
    } = options;
    const metadata = responseMetadata(response, latencyMs, keyIndex, stage);
    const candidate = response?.candidates?.[0];
    const text = response?.text?.trim();

    if (validationMode === 'strict') {
        if (!candidate) {
            throw invalidResponse(
                ErrorCodes.GEMINI_BLOCKED,
                `Gemini không trả candidate${metadata.blockReason ? ` (${metadata.blockReason})` : ''}.`,
                metadata
            );
        }
        if (metadata.finishReason === 'MAX_TOKENS') {
            throw invalidResponse(ErrorCodes.GEMINI_OUTPUT_TRUNCATED, 'Gemini dừng vì chạm giới hạn output token.', metadata);
        }
        if (metadata.finishReason !== 'STOP') {
            throw invalidResponse(
                ErrorCodes.GEMINI_RESPONSE_INVALID,
                `Gemini kết thúc với finishReason=${metadata.finishReason || 'MISSING'}.`,
                metadata
            );
        }
    }

    if (!text) {
        throw invalidResponse(ErrorCodes.GEMINI_RESPONSE_INVALID, 'Gemini trả về nội dung rỗng.', metadata);
    }

    if (responseType !== 'json') {
        return Object.freeze({ text, metadata });
    }

    let json;
    try {
        json = JSON.parse(text);
    } catch (cause) {
        const error = invalidResponse(ErrorCodes.GEMINI_SCHEMA_INVALID, 'Gemini trả về JSON không hợp lệ.', metadata);
        error.cause = cause;
        throw error;
    }
    if (structuredValidator && !structuredValidator(json)) {
        throw invalidResponse(ErrorCodes.GEMINI_SCHEMA_INVALID, 'JSON Gemini không đạt schema nghiệp vụ.', metadata);
    }

    return Object.freeze({ text, json, metadata });
}

export function createPdfContents(pdfData, instruction) {
    const base64Data = Buffer.isBuffer(pdfData) || pdfData instanceof Uint8Array
        ? Buffer.from(pdfData).toString('base64')
        : pdfData;

    if (typeof base64Data !== 'string' || base64Data.length < 100) {
        throw new ProcessingError(ErrorCodes.INVALID_PDF, 'Dữ liệu PDF không hợp lệ.');
    }

    return [{
        role: 'user',
        parts: [
            { inlineData: { data: base64Data, mimeType: 'application/pdf' } },
            { text: instruction },
        ],
    }];
}

export function createGeminiFileContents(file, instruction) {
    if (!file?.uri || !file?.mimeType) {
        throw new ProcessingError(ErrorCodes.GEMINI_RESPONSE_INVALID, 'Gemini File API không trả URI PDF hợp lệ.', { retryable: true });
    }
    return [{
        role: 'user',
        parts: [
            { fileData: { fileUri: file.uri, mimeType: file.mimeType } },
            { text: instruction },
        ],
    }];
}

export async function generateGeminiContent(options) {
    const {
        apiKey,
        keyIndex,
        model,
        contents,
        config = {},
        signal,
        stage = 'translate',
        validationMode = 'strict',
        responseType = 'text',
        structuredValidator,
        clientFactory = key => new GoogleGenAI({ apiKey: key }),
    } = options;

    if (!apiKey) {
        throw new ProcessingError(ErrorCodes.GEMINI_CONFIG, 'Thiếu Gemini API key.');
    }

    const startedAt = performance.now();
    const response = await clientFactory(apiKey).models.generateContent({
        model,
        contents,
        config: {
            ...config,
            abortSignal: signal,
        },
    });

    return validateGeminiResponse(response, {
        validationMode,
        responseType,
        keyIndex,
        stage,
        latencyMs: performance.now() - startedAt,
        structuredValidator,
    });
}
