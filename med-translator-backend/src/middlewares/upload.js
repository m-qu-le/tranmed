import multer from 'multer';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { MAX_FILE_SIZE_MB, UPLOAD_DIR } from '../config/env.js';

// Tạo thư mục tạm 'uploads' ở thư mục gốc của project nếu chưa có
if (!fs.existsSync(UPLOAD_DIR)){
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Cấu hình lưu trữ file xuống ổ cứng (Disk Storage)
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, UPLOAD_DIR);
    },
    filename: function (req, file, cb) {
        // 1. GIẢI MÃ ENCODING: Ép ngược từ latin1 sang utf8 để giữ nguyên tiếng Việt và ký tự đặc biệt
        const decodedName = Buffer.from(file.originalname, 'latin1').toString('utf8');

        // 2. SANITIZE (Vệ sinh tên file - Optional nhưng là Best Practice của System Architect): 
        // Xóa hoặc thay thế các ký tự có thể gây lỗi đường dẫn trên hệ điều hành (như \ / : * ? " < > |)
        file.originalname = decodedName;

        // Tên lưu vật lý độc lập với tên người dùng để tránh URL/path quá dài hoặc ký tự đặc biệt.
        cb(null, `${randomUUID()}.pdf`);
    }
});

const upload = multer({ 
    storage: storage,
    fileFilter: (req, file, cb) => {
        // Chỉ chấp nhận file PDF (Giữ nguyên logic của bạn)
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Chỉ chấp nhận định dạng file PDF.'), false);
        }
    },
    limits: {
        fileSize: MAX_FILE_SIZE_MB * 1024 * 1024,
        files: 1,
        fields: 5,
        fieldNameSize: 100,
        fieldSize: 16 * 1024
    }
});

export default upload;
