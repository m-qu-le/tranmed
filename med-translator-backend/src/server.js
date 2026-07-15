import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose'; 
import translateRoute from './routes/translateRoute.js';
import { validateRuntimeEnv } from './config/env.js';

// [THÊM MỚI] Bổ sung đường truyền tĩnh mạch: Import QueueManager để gọi khởi tạo sau khi có DB
import { translationQueue } from './services/queueManager.js'; 

const runtimeConfig = validateRuntimeEnv();
const app = express();
const PORT = runtimeConfig.port;
app.set('trust proxy', 1);

// [CẤU HÌNH CORS ĐỘNG VÀ LOGGING]
const allowedOrigins = [
    'https://tranmed.vercel.app',
    'https://med-translator-frontend.vercel.app',
    'http://localhost:5173',
    runtimeConfig.frontendUrl // Hỗ trợ biến môi trường linh hoạt
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Cho phép các request không có origin (như mobile apps hoặc curl)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.log(`⚠️ [CORS BLOCK] Từ chối request từ origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// [GIAI ĐOẠN 4]: Heartbeat Endpoint siêu nhẹ chống Cloud Sleep mode
app.get('/api/health', async (req, res) => {
    try {
        // Thực hiện lệnh ping trực tiếp vào admin database của MongoDB
        // Thao tác này cực nhẹ và không tốn nhiều tài nguyên
        await mongoose.connection.db.admin().ping();
        
        res.status(200).json({ 
            status: 'success', 
            message: 'Render server is awake and MongoDB connection is active!' 
        });
    } catch (error) {
        console.error('Database connection failed during health check:', error);
        res.status(500).json({ 
            status: 'error', 
            message: 'Database connection failed' 
        });
    }
});

app.use('/api/translate', translateRoute);

app.use((err, req, res, next) => {
    console.error('❌ Lỗi không xác định:', err.stack);
    if (err.name === 'MulterError') {
        const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        return res.status(status).json({ error: err.message });
    }
    if (err.message === 'Not allowed by CORS') {
        return res.status(403).json({ error: 'Origin không được phép.' });
    }
    res.status(500).json({ error: 'Lỗi Server Nội Bộ!' });
});

// Ép Mongoose không chờ (buffering) nếu mất kết nối, fail-fast ngay lập tức
mongoose.connect(runtimeConfig.mongodbUri, { serverSelectionTimeoutMS: 5000 })
    .then(async () => { 
        console.log(`🟢 [DATABASE] Đã kết nối thành công tới MongoDB.`);
        
        // Quét Zombie Jobs CHỈ KHI Database thực sự thông luồng
        await translationQueue.initDB(); 
        
        // Chỉ mở Port HTTP sau khi Database và Queue đã hoàn tất setup
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`-----------------------------------------------`);
            console.log(`🚀 Server đang chạy tại: http://0.0.0.0:${PORT}`);
            console.log(`-----------------------------------------------`);
        });
    })
    .catch((error) => {
        console.error(`🔴 [DATABASE] Lỗi kết nối MongoDB:`, error.message);
        process.exit(1); 
    });
