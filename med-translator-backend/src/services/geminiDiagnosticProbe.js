import { performance } from 'node:perf_hooks';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
    GEMINI_DIAGNOSTIC_PROBE_ENABLED,
    GEMINI_TIMEOUT_MS,
    getGeminiApiKeys,
} from '../config/env.js';
import { createPdfContents } from './geminiAdapter.js';
import {
    QUALITY_TRANSLATION_SYSTEM_INSTRUCTION,
    buildTranslateInstruction,
} from './qualityPrompts.js';
import { redactSensitiveText } from '../utils/redactSecrets.js';

export const GEMINI_DIAGNOSTIC_MODELS = Object.freeze([
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
]);
export const GEMINI_DIAGNOSTIC_COOLDOWN_MS = 5 * 60 * 1000;

export class GeminiDiagnosticProbeError extends Error {
    constructor(status, code, message, details = {}) {
        super(message);
        this.name = 'GeminiDiagnosticProbeError';
        this.status = status;
        this.code = code;
        Object.assign(this, details);
    }
}

function safeText(value, maxLength = 2000, extraSecrets = []) {
    return redactSensitiveText(value, extraSecrets)
        .replace(/[\r\n]+/g, ' ')
        .slice(0, maxLength);
}

function safeQuotaViolation(violation = {}) {
    return {
        quotaMetric: violation.quotaMetric || null,
        quotaId: violation.quotaId || null,
        quotaValue: violation.quotaValue ?? null,
        quotaDimensions: {
            model: violation.quotaDimensions?.model || null,
            location: violation.quotaDimensions?.location || null,
        },
    };
}

function safeErrorDetail(detail = {}) {
    const metadata = detail.metadata || {};
    return {
        type: detail['@type'] || detail.type || null,
        reason: detail.reason || null,
        domain: detail.domain || null,
        retryDelay: detail.retryDelay || detail.retryInfo?.retryDelay || null,
        quotaMetric: detail.quotaMetric || metadata.quotaMetric || metadata.quota_metric || null,
        quotaId: detail.quotaId || metadata.quotaId || metadata.quota_limit || null,
        quotaValue: detail.quotaValue ?? metadata.quotaValue ?? null,
        model: metadata.model || null,
        service: metadata.service || null,
        violations: Array.isArray(detail.violations)
            ? detail.violations.map(safeQuotaViolation)
            : [],
    };
}

export function sanitizeGeminiDiagnosticError(error, extraSecrets = []) {
    const details = Array.isArray(error?.errorDetails)
        ? error.errorDetails
        : Array.isArray(error?.details)
            ? error.details
            : [];
    return {
        upstreamStatus: error?.status
            || error?.response?.status
            || error?.$metadata?.httpStatusCode
            || null,
        upstreamCode: typeof error?.code === 'string' || typeof error?.code === 'number'
            ? error.code
            : null,
        message: safeText(error?.message || 'Gemini probe failed.', 2000, extraSecrets),
        retryAfter: error?.retryAfter
            || error?.response?.headers?.get?.('retry-after')
            || error?.response?.headers?.['retry-after']
            || null,
        details: details.map(safeErrorDetail),
    };
}

let fixturePromise = null;

async function createProbePdf() {
    if (!fixturePromise) {
        fixturePromise = (async () => {
            const pdf = await PDFDocument.create();
            const page = pdf.addPage([595, 842]);
            const font = await pdf.embedFont(StandardFonts.Helvetica);
            page.drawText(
                'Cardiac output is the volume of blood pumped by the heart per minute.',
                { x: 50, y: 760, size: 13, font }
            );
            page.drawText(
                'It equals heart rate multiplied by stroke volume.',
                { x: 50, y: 730, size: 13, font }
            );
            return Buffer.from(await pdf.save());
        })();
    }
    return fixturePromise;
}

async function requestGeminiProbe({ apiKey, model }) {
    const pdfBuffer = await createProbePdf();
    const client = new GoogleGenAI({ apiKey });
    const response = await client.models.generateContent({
        model,
        contents: createPdfContents(pdfBuffer, buildTranslateInstruction(null)),
        config: {
            systemInstruction: QUALITY_TRANSLATION_SYSTEM_INSTRUCTION,
            maxOutputTokens: 65_536,
            thinkingConfig: {
                thinkingLevel: ThinkingLevel.HIGH,
                includeThoughts: false,
            },
            httpOptions: { timeout: GEMINI_TIMEOUT_MS },
        },
    });
    return { response, pdfBytes: pdfBuffer.length };
}

export class GeminiDiagnosticProbe {
    constructor({
        enabled = GEMINI_DIAGNOSTIC_PROBE_ENABLED,
        cooldownMs = GEMINI_DIAGNOSTIC_COOLDOWN_MS,
        keysProvider = getGeminiApiKeys,
        request = requestGeminiProbe,
        clock = () => Date.now(),
    } = {}) {
        this.enabled = Boolean(enabled);
        this.cooldownMs = cooldownMs;
        this.keysProvider = keysProvider;
        this.request = request;
        this.clock = clock;
        this.inFlight = false;
        this.lastRunByModel = new Map();
    }

    async run(modelValue) {
        if (!this.enabled) {
            throw new GeminiDiagnosticProbeError(
                503,
                'PROBE_DISABLED',
                'Gemini diagnostic probe đang tắt.'
            );
        }

        const model = typeof modelValue === 'string' ? modelValue.trim() : '';
        if (!GEMINI_DIAGNOSTIC_MODELS.includes(model)) {
            throw new GeminiDiagnosticProbeError(
                400,
                'MODEL_NOT_ALLOWED',
                `Model chỉ nhận một trong các giá trị: ${GEMINI_DIAGNOSTIC_MODELS.join(', ')}.`
            );
        }
        if (this.inFlight) {
            throw new GeminiDiagnosticProbeError(
                409,
                'PROBE_IN_FLIGHT',
                'Một Gemini diagnostic probe khác đang chạy.'
            );
        }

        const now = this.clock();
        const lastRunAt = this.lastRunByModel.get(model) || 0;
        const retryAfterMs = this.cooldownMs - (now - lastRunAt);
        if (lastRunAt > 0 && retryAfterMs > 0) {
            throw new GeminiDiagnosticProbeError(
                429,
                'PROBE_COOLDOWN',
                'Model này đang trong thời gian cooldown của diagnostic probe.',
                { retryAfterSeconds: Math.ceil(retryAfterMs / 1000) }
            );
        }

        const apiKey = this.keysProvider()[0];
        if (!apiKey) {
            throw new GeminiDiagnosticProbeError(
                503,
                'NO_GEMINI_KEY',
                'Không có Gemini API key để chạy diagnostic probe.'
            );
        }

        this.inFlight = true;
        this.lastRunByModel.set(model, now);
        const startedAt = performance.now();
        try {
            const { response, pdfBytes } = await this.request({ apiKey, model });
            const usage = response?.usageMetadata || {};
            return {
                ok: true,
                model,
                keyIndex: 0,
                latencyMs: Math.round(performance.now() - startedAt),
                modelVersion: response?.modelVersion || null,
                finishReason: response?.candidates?.[0]?.finishReason || null,
                responseId: response?.responseId || null,
                pdfBytes: Number.isSafeInteger(pdfBytes) ? pdfBytes : null,
                usage: {
                    promptTokenCount: usage.promptTokenCount ?? null,
                    candidatesTokenCount: usage.candidatesTokenCount ?? null,
                    thoughtsTokenCount: usage.thoughtsTokenCount ?? null,
                    totalTokenCount: usage.totalTokenCount ?? null,
                },
            };
        } catch (error) {
            return {
                ok: false,
                model,
                keyIndex: 0,
                latencyMs: Math.round(performance.now() - startedAt),
                ...sanitizeGeminiDiagnosticError(error, [apiKey]),
            };
        } finally {
            this.inFlight = false;
        }
    }
}

export const geminiDiagnosticProbe = new GeminiDiagnosticProbe();
