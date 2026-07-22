import {
    GEMINI_MODEL,
    GEMINI_TIMEOUT_MS,
    getGeminiApiKeys,
    TRANSLATION_PIPELINE_MODE,
} from '../config/env.js';
import { ErrorCodes, ProcessingError } from '../utils/processingError.js';
import { runBoundedTasks } from '../utils/runBoundedTasks.js';
import { createPdfContents, generateGeminiContent } from './geminiAdapter.js';
import { LEGACY_TRANSLATION_SYSTEM_INSTRUCTION, TRANSLATE_USER_INSTRUCTION } from './geminiPrompts.js';
import { getTranslationProfile } from './translationProfiles.js';

// [ĐÃ SỬA]: Lazy Loading (Lấy Key khi thực thi thay vì lấy lúc khởi tạo file)
const getApiKeys = () => {
    const keys = getGeminiApiKeys();
    if (keys.length === 0) {
        console.error("🔴 [CẢNH BÁO]: Chưa tìm thấy GEMINI_API_KEYS trong file .env!");
    }
    return keys;
};

const TARGET_MODEL = GEMINI_MODEL;
let currentKeyIndex = 0;

const delay = (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
    }, ms);
    const onAbort = () => {
        clearTimeout(timer);
        reject(new ProcessingError(ErrorCodes.CANCELLED, 'Tác vụ đã được hủy.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
});

function reserveKeyIndex(keysCount) {
    const reservedIndex = currentKeyIndex % keysCount;
    currentKeyIndex = (currentKeyIndex + 1) % keysCount;
    return reservedIndex;
}

function assertNotCancelled(signal) {
    if (signal?.aborted) {
        throw new ProcessingError(ErrorCodes.CANCELLED, 'Tác vụ đã được hủy.');
    }
}

async function callGeminiWithKeyRotation(base64Data, chunkLabel, emitLog, signal, profile) {
    const keys = getApiKeys();
    const keysCount = keys.length;
    if (keysCount === 0) {
        throw new ProcessingError(
            ErrorCodes.GEMINI_CONFIG,
            'Không có Gemini API key hợp lệ.',
            { publicMessage: 'Server chưa được cấu hình Gemini API key.' }
        );
    }

    const firstKeyIndex = reserveKeyIndex(keysCount);
    let lastError = null;
    let lastStatus = null;
    let authFailures = 0;
    let quotaFailures = 0;

    for (let keysTried = 0; keysTried < keysCount; keysTried += 1) {
        assertNotCancelled(signal);
        let retries = 0;
        let finalStatus = null;
        const maxRetriesPerKey = 3;
        const attemptingKeyIndex = (firstKeyIndex + keysTried) % keysCount;

        while (retries <= maxRetriesPerKey) {
            assertNotCancelled(signal);
            try {
                const response = await generateGeminiContent({
                    apiKey: keys[attemptingKeyIndex],
                    keyIndex: attemptingKeyIndex,
                    model: TARGET_MODEL,
                    contents: createPdfContents(base64Data, TRANSLATE_USER_INSTRUCTION),
                    config: {
                        systemInstruction: LEGACY_TRANSLATION_SYSTEM_INSTRUCTION,
                        ...profile.generateConfig,
                        httpOptions: { timeout: GEMINI_TIMEOUT_MS },
                    },
                    signal,
                    stage: profile.stage,
                    validationMode: profile.validationMode,
                });

                return { 
                    text: response.text, 
                    modelUsed: TARGET_MODEL, 
                    keyUsed: `Key ${attemptingKeyIndex + 1}`,
                    metadata: response.metadata,
                };

            } catch (error) {
                if (error instanceof ProcessingError) throw error;
                if (signal?.aborted || error?.name === 'AbortError') {
                    throw new ProcessingError(ErrorCodes.CANCELLED, 'Tác vụ đã được hủy.');
                }

                lastError = error;
                const status = error?.status || error?.response?.status || null;
                lastStatus = status;
                finalStatus = status;

                if (status === 401 || status === 403) {
                    authFailures += 1;
                    emitLog(`🔑 [${chunkLabel}] Key ${attemptingKeyIndex + 1} không hợp lệ, chuyển key khác.`);
                    break;
                }

                if (status === 400 || status === 404) {
                    throw new ProcessingError(
                        ErrorCodes.GEMINI_CONFIG,
                        error.message,
                        { publicMessage: 'Gemini từ chối model hoặc dữ liệu đầu vào.' }
                    );
                }

                if (status === 429 || [500, 502, 503, 504].includes(status) || status === null) {
                    if (retries < maxRetriesPerKey) {
                        retries++;
                        const waitTime = retries * 12000;
                        
                        emitLog(`⚠️ [${chunkLabel}] API Key ${attemptingKeyIndex + 1} đang bận (Lỗi ${status}). Đợi ${waitTime/1000}s thử lại lần ${retries}/${maxRetriesPerKey}...`);
                        await delay(waitTime, signal);
                    } else {
                        emitLog(`🛑 [${chunkLabel}] API Key ${attemptingKeyIndex + 1} THẤT BẠI sau ${maxRetriesPerKey} lần thử.`);
                        break; 
                    }
                } else {
                    throw new ProcessingError(
                        ErrorCodes.GEMINI_UNAVAILABLE,
                        error.message,
                        { retryable: true, publicMessage: 'Không thể kết nối dịch vụ Gemini.' }
                    );
                }
            }
        }
        if (finalStatus === 429) quotaFailures += 1;
    } 

    if (authFailures === keysCount) {
        throw new ProcessingError(
            ErrorCodes.GEMINI_AUTH,
            'Toàn bộ Gemini API key đều bị từ chối.',
            { publicMessage: 'Toàn bộ Gemini API key không hợp lệ.' }
        );
    }

    if (quotaFailures === keysCount) {
        const error = new ProcessingError(
            ErrorCodes.GEMINI_RATE_LIMIT,
            lastError?.message || 'Gemini đã hết quota.',
            {
                retryable: true,
                quotaRelated: true,
                poolExhausted: true,
                publicMessage: 'Toàn bộ Gemini key đang chờ quota, hệ thống sẽ thử lại.'
            }
        );
        error.retryAfterMs = 60_000;
        throw error;
    }

    if (lastStatus === 429) {
        throw new ProcessingError(
            ErrorCodes.GEMINI_UNAVAILABLE,
            lastError?.message || 'Gemini tạm thời không khả dụng.',
            { retryable: true, publicMessage: 'Gemini tạm thời không khả dụng, hệ thống sẽ thử lại.' }
        );
    }

    throw new ProcessingError(
        ErrorCodes.GEMINI_UNAVAILABLE,
        lastError?.message || 'Gemini tạm thời không khả dụng.',
        { retryable: true, publicMessage: 'Gemini tạm thời không khả dụng, hệ thống sẽ thử lại.' }
    );
}

async function translateSingleChunk(buffer, chunkIndex, emitLog, signal, profile) {
    const chunkLabel = `Chunk ${chunkIndex + 1}`;
    let base64Data;

    try {
        assertNotCancelled(signal);
        // 🛠️ FIX: Kiểm tra an toàn loại dữ liệu trả về từ Worker
        const validBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
        base64Data = validBuffer.toString('base64');

        // Chặn luồng ngay nếu dữ liệu Worker truyền về quá nhỏ (Bị lỗi hỏng file)
        if (!base64Data || base64Data.length < 100) {
            throw new Error(`Dữ liệu PDF bị hỏng trong quá trình truyền tải Đa luồng (Kích thước chuỗi Base64: ${base64Data.length}).`);
        }
        
        emitLog(`⏳ [${chunkLabel}] Bắt đầu dịch... (Đang nạp Key ${currentKeyIndex + 1})`);
        const result = await callGeminiWithKeyRotation(base64Data, chunkLabel, emitLog, signal, profile);
        
        emitLog(`✅ [${chunkLabel}] Xong! (Dùng: ${result.modelUsed} - Bằng: ${result.keyUsed})`);
        emitLog(`📊 [${chunkLabel}] stage=${result.metadata.stage} model=${result.metadata.modelVersion || result.modelUsed} finish=${result.metadata.finishReason || 'MISSING'} input=${result.metadata.usage.promptTokenCount ?? 'n/a'} output=${result.metadata.usage.candidatesTokenCount ?? 'n/a'} thought=${result.metadata.usage.thoughtsTokenCount ?? 'n/a'} total=${result.metadata.usage.totalTokenCount ?? 'n/a'} latencyMs=${result.metadata.latencyMs}`);
        return result;
    } catch (error) {
        emitLog(`❌ LỖI NGHIÊM TRỌNG tại ${chunkLabel}: ${error.message}`);
        throw error;
    }
}

export const processTranslation = async (chunkBuffers, emitLog, options = {}) => {
    const {
        signal,
        existingChunks = new Map(),
        onChunkTranslated = async () => {},
        mode = TRANSLATION_PIPELINE_MODE,
    } = options;
    const profile = getTranslationProfile(mode);
    const keysCount = getApiKeys().length;
    emitLog(`🚀 Bắt đầu dịch ${chunkBuffers.length} chunk với ${keysCount} API key...`);

    const translatedChunks = Array(chunkBuffers.length);
    const remainingIndexes = [];
    for (let index = 0; index < chunkBuffers.length; index += 1) {
        if (existingChunks.has(index)) {
            translatedChunks[index] = existingChunks.get(index);
        } else {
            remainingIndexes.push(index);
        }
    }

    await runBoundedTasks(remainingIndexes, 2, async chunkIndex => {
        assertNotCancelled(signal);
        const result = await translateSingleChunk(
            chunkBuffers[chunkIndex],
            chunkIndex,
            emitLog,
            signal,
            profile
        );
        assertNotCancelled(signal);
        translatedChunks[chunkIndex] = result.text;
        await onChunkTranslated(chunkIndex, result.text, result.metadata);
        return result.text;
    });

    return translatedChunks;
};
