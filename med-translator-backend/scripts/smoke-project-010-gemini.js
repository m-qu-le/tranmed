import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { GEMINI_MODEL, getGeminiApiKeys } from '../src/config/env.js';

const JSON_SCHEMA = Object.freeze({
    type: 'object',
    properties: { status: { type: 'string', enum: ['OK'] } },
    required: ['status'],
});

function textConfig() {
    return {
        systemInstruction: 'Return only the requested token.',
        maxOutputTokens: 65536,
        thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH, includeThoughts: false },
    };
}

function jsonConfig() {
    return {
        systemInstruction: 'Follow the response schema exactly.',
        maxOutputTokens: 16384,
        thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH, includeThoughts: false },
        responseMimeType: 'application/json',
        responseJsonSchema: JSON_SCHEMA,
    };
}

async function createFixture(directory) {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([595, 842]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText('P010 Gemini File API smoke test', {
        x: 60,
        y: 760,
        size: 16,
        font,
        color: rgb(0.1, 0.1, 0.1),
    });
    const filePath = path.join(directory, 'p010-smoke.pdf');
    await writeFile(filePath, await pdf.save());
    return filePath;
}

async function waitForActiveFile(client, initialFile) {
    let file = initialFile;
    for (let attempt = 0; file?.state === 'PROCESSING' && attempt < 30; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        file = await client.files.get({ name: file.name });
    }
    assert.ok(file?.uri, 'Gemini File API không trả URI PDF.');
    assert.notEqual(file.state, 'PROCESSING', 'Gemini File API không kích hoạt PDF trong 30 giây.');
    assert.notEqual(file.state, 'FAILED', 'Gemini File API không xử lý được PDF.');
    return file;
}

async function smokeWithKey(apiKey, fixturePath) {
    const client = new GoogleGenAI({ apiKey });
    let file;
    try {
        const text = await client.models.generateContent({
            model: GEMINI_MODEL,
            contents: 'Reply exactly OK.',
            config: textConfig(),
        });
        assert.equal(text.text.trim(), 'OK');

        const json = await client.models.generateContent({
            model: GEMINI_MODEL,
            contents: 'Return the required JSON object.',
            config: jsonConfig(),
        });
        assert.deepEqual(JSON.parse(json.text), { status: 'OK' });

        file = await client.files.upload({ file: fixturePath, config: { mimeType: 'application/pdf' } });
        const readyFile = await waitForActiveFile(client, file);
        const pdf = await client.models.generateContent({
            model: GEMINI_MODEL,
            contents: [{
                role: 'user',
                parts: [
                    { fileData: { fileUri: readyFile.uri, mimeType: readyFile.mimeType } },
                    { text: 'Reply exactly OK.' },
                ],
            }],
            config: textConfig(),
        });
        assert.equal(pdf.text.trim(), 'OK');

        return {
            textFinishReason: text.candidates?.[0]?.finishReason || null,
            jsonFinishReason: json.candidates?.[0]?.finishReason || null,
            pdfFinishReason: pdf.candidates?.[0]?.finishReason || null,
            modelVersion: pdf.modelVersion || null,
        };
    } finally {
        if (file?.name) await client.files.delete({ name: file.name }).catch(() => {});
    }
}

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'study-med-p010-'));
try {
    const fixturePath = await createFixture(temporaryDirectory);
    let lastError;
    for (const apiKey of getGeminiApiKeys()) {
        try {
            const result = await smokeWithKey(apiKey, fixturePath);
            console.log(JSON.stringify({
                outcome: 'passed',
                model: GEMINI_MODEL,
                structuredJsonValidated: true,
                fileApiValidated: true,
                ...result,
            }));
            process.exitCode = 0;
            break;
        } catch (error) {
            lastError = error;
        }
    }
    if (process.exitCode !== 0) {
        throw new Error(`P010 Gemini smoke thất bại với tất cả API key: ${lastError?.status || 'unknown status'}.`);
    }
} finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
}
