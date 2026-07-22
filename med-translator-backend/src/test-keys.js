import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { GEMINI_MODEL, getGeminiApiKeys } from './config/env.js';

async function testGeminiKeys() {
    // Trích xuất chuỗi keys từ biến môi trường, phân tách bằng dấu phẩy
    const keys = getGeminiApiKeys();

    if (keys.length === 0) {
        console.error("❌ Không tìm thấy GEMINI_API_KEYS trong biến môi trường.");
        return;
    }
    console.log(`🔍 Bắt đầu kiểm tra ${keys.length} API Keys...\n`);
    let compatibleKeys = 0;

    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        try {
            // Khởi tạo client với key hiện tại
            const ai = new GoogleGenAI({ apiKey: key });
            
            // Gửi request siêu nhẹ kiểm tra kết nối
            const response = await ai.models.generateContent({
                model: GEMINI_MODEL,
                contents: 'Reply strictly with the word "OK"',
                config: {
                    systemInstruction: 'Return only the requested token.',
                    maxOutputTokens: 65536,
                    thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH, includeThoughts: false },
                },
            });

            const finishReason = response.candidates?.[0]?.finishReason || null;
            if (response.text?.trim() !== 'OK' || finishReason !== 'STOP') {
                throw new Error('Gemini trả response không hoàn chỉnh.');
            }
            compatibleKeys += 1;
            console.log(`✅ Key ${i + 1}: TƯƠNG THÍCH - model=${response.modelVersion || GEMINI_MODEL}, finish=${finishReason}`);
        } catch (error) {
            console.log(`❌ Key ${i + 1}: LỖI`);
            
            const message = error?.message || '';
            if (/location is not supported/i.test(message)) {
                console.log(`   👉 Mã lỗi: 400 - Bị chặn địa lý (Location not supported)`);
            } else if (error.status === 400) {
                console.log('   👉 Mã lỗi: 400 - Gemini từ chối model hoặc cấu hình request.');
            } else if (error.status === 429) {
                console.log(`   👉 Mã lỗi: 429 - Hết Quota (Rate limit exceeded)`);
            } else {
                console.log(`   👉 Mã lỗi: ${error.status || 'không xác định'}`);
            }
        }
    }
    const failedKeys = keys.length - compatibleKeys;
    console.log(`\n🏁 Hoàn thành: ${compatibleKeys}/${keys.length} key tương thích, ${failedKeys} key lỗi.`);
    if (failedKeys > 0) process.exitCode = 1;
}

testGeminiKeys();
