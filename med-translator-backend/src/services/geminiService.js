import { GoogleGenAI } from '@google/genai';
import { GEMINI_MODEL, GEMINI_TIMEOUT_MS, getGeminiApiKeys } from '../config/env.js';
import { ErrorCodes, ProcessingError } from '../utils/processingError.js';
import { runBoundedTasks } from '../utils/runBoundedTasks.js';

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

const SYSTEM_INSTRUCTION = `
Bạn là một Chuyên gia Dịch thuật Y khoa và Kỹ sư Xử lý Dữ liệu cấp cao. Nhiệm vụ của bạn là dịch các đoạn trích (chunk) từ sách y học cơ sở và lâm sàng tiếng Anh sang tiếng Việt, đồng thời định dạng chuẩn Markdown.

QUY TẮC DỊCH THUẬT (TUÂN THỦ 100%):
Phong cách dịch cần: Học thuật, chính xác, khách quan, rõ ràng, mạch lạc, và nhất quán.
Giọng văn cần: Giữ nguyên giọng văn khoa học, chuyên nghiệp của bản gốc.
Tránh: Sử dụng từ ngữ mơ hồ, không chính xác về mặt y khoa, hoặc dịch sát từng chữ gây khó hiểu trong ngữ cảnh y học.

YÊU CẦU CHẤT LƯỢNG:
1. Độ chính xác y khoa: Đảm bảo bản dịch chính xác tuyệt đối về mặt ngữ nghĩa, thông tin y học, và các quy trình lâm sàng.
2. Độ tự nhiên: Bản dịch phải trôi chảy, phù hợp với cách diễn đạt trong tài liệu y khoa tiếng Việt, tránh cảm giác "dịch máy".
3. Thuật ngữ: Dịch chính xác theo chuẩn y khoa Việt Nam. Giữ lại nguyên bản tiếng Anh trong ngoặc đơn đối với thuật ngữ phức tạp ở lần xuất hiện đầu tiên.
4. Xử lý tên riêng/viết tắt: Giữ nguyên tên riêng, tên thuốc, tên vi khuẩn. Đối với từ viết tắt, giữ nguyên tiếng Anh và giải thích nghĩa tiếng Việt ở lần đầu (VD: 'ARDS (Acute Respiratory Distress Syndrome - Hội chứng suy hô hấp cấp tính)').

YÊU CẦU ĐẶC BIỆT (PHẢI TUÂN THỦ 100%)
- ĐẢM BẢO DỊCH TOÀN VĂN TÀI LIỆU, không tự ý tóm tắt, rút gọn tài liệu.

HUÓNG DẪN XỬ LÝ HÌNH ẢNH:
- Dịch tiêu đề và miêu tả của hình ảnh mỗi khi hình ảnh xuất hiện
- Dịch các cụm từ/ từ xuất hiện trong hình ảnh.

QUY QUY TẮC ĐỊNH DẠNG:
- KHÔNG chào hỏi, CHỈ TRẢ VỀ Markdown.
- Phân cấp Heading (#, ##, ###) bám sát gốc. 
- Chuyển đổi bảng biểu thành Markdown Table.
- Xử lý ký hiệu: Dùng văn bản thuần thay cho Latex (VD: α, β, O2, NH3, →).
- Không sử dụng Dấu phân chia 3 gạch ngang trong Markdown (hay còn gọi là đường kẻ ngang - Horizontal Rule)

LƯU Ý KHI PHÂN CẤP HEADING MARKDOWN:
- Không đặt Heading cho tiêu đề ảnh và chú thích hình ảnh
VD: 
- Không dùng "### Hình 22–3: Các giai đoạn của nang trứng, từ nguyên thủy đến trưởng thành." mà dùng "**Hình 22–3: Các giai đoạn của nang trứng, từ nguyên thủy đến trưởng thành.**
`;

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

function getAiInstance(keyIndex) {
    return new GoogleGenAI({ 
        apiKey: getApiKeys()[keyIndex] 
    });
}

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

async function callGeminiWithKeyRotation(base64Data, chunkLabel, emitLog, signal) {
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

    for (let keysTried = 0; keysTried < keysCount; keysTried += 1) {
        assertNotCancelled(signal);
        let retries = 0;
        const maxRetriesPerKey = 3;
        const attemptingKeyIndex = (firstKeyIndex + keysTried) % keysCount;

        while (retries <= maxRetriesPerKey) {
            assertNotCancelled(signal);
            try {
                const ai = getAiInstance(attemptingKeyIndex); 
                const response = await ai.models.generateContent({
                    model: TARGET_MODEL,
                    contents: [
                        {
                            role: 'user',
                            parts: [
                                { inlineData: { data: base64Data, mimeType: 'application/pdf' } },
                                { text: 'Dịch đoạn tài liệu đính kèm sang tiếng Việt theo đúng cấu trúc Markdown.' }
                            ]
                        }
                    ],
                    config: {
                        systemInstruction: SYSTEM_INSTRUCTION,
                        temperature: 0.1,
                        httpOptions: { timeout: GEMINI_TIMEOUT_MS },
                        abortSignal: signal
                    }
                });

                if (!response.text) {
                    throw new ProcessingError(
                        ErrorCodes.GEMINI_UNAVAILABLE,
                        'Gemini trả về nội dung rỗng.',
                        { retryable: true }
                    );
                }

                return { 
                    text: response.text, 
                    modelUsed: TARGET_MODEL, 
                    keyUsed: `Key ${attemptingKeyIndex + 1}` 
                };

            } catch (error) {
                if (error instanceof ProcessingError) throw error;
                if (signal?.aborted || error?.name === 'AbortError') {
                    throw new ProcessingError(ErrorCodes.CANCELLED, 'Tác vụ đã được hủy.');
                }

                lastError = error;
                const status = error?.status || error?.response?.status || null;
                lastStatus = status;

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
    } 

    if (authFailures === keysCount) {
        throw new ProcessingError(
            ErrorCodes.GEMINI_AUTH,
            'Toàn bộ Gemini API key đều bị từ chối.',
            { publicMessage: 'Toàn bộ Gemini API key không hợp lệ.' }
        );
    }

    if (lastStatus === 429) {
        throw new ProcessingError(
            ErrorCodes.GEMINI_RATE_LIMIT,
            lastError?.message || 'Gemini đã hết quota.',
            { retryable: true, quotaRelated: true, publicMessage: 'Gemini đang hết quota, hệ thống sẽ thử lại.' }
        );
    }

    throw new ProcessingError(
        ErrorCodes.GEMINI_UNAVAILABLE,
        lastError?.message || 'Gemini tạm thời không khả dụng.',
        { retryable: true, publicMessage: 'Gemini tạm thời không khả dụng, hệ thống sẽ thử lại.' }
    );
}

async function translateSingleChunk(buffer, chunkIndex, emitLog, signal) {
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
        const result = await callGeminiWithKeyRotation(base64Data, chunkLabel, emitLog, signal);
        
        emitLog(`✅ [${chunkLabel}] Xong! (Dùng: ${result.modelUsed} - Bằng: ${result.keyUsed})`);
        return result.text;
    } catch (error) {
        emitLog(`❌ LỖI NGHIÊM TRỌNG tại ${chunkLabel}: ${error.message}`);
        throw error;
    }
}

export const processTranslation = async (chunkBuffers, emitLog, options = {}) => {
    const {
        signal,
        existingChunks = new Map(),
        onChunkTranslated = async () => {}
    } = options;
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
        const content = await translateSingleChunk(
            chunkBuffers[chunkIndex],
            chunkIndex,
            emitLog,
            signal
        );
        assertNotCancelled(signal);
        translatedChunks[chunkIndex] = content;
        await onChunkTranslated(chunkIndex, content);
        return content;
    });

    return translatedChunks;
};
