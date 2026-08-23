import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import translateRoute from './routes/translateRoute.js';
import { redactError } from './utils/redactSecrets.js';
import {
    localStorageService,
    runtimeConfig,
    storageReadiness,
    uploadBatchService,
} from './services/runtimeServices.js';
import { translationQueue } from './services/queueManager.js';
import { qualityKeyScheduler } from './services/qualityGeminiExecutors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDist = path.resolve(__dirname, '../../med-translator-frontend/dist');
const app = express();
const PORT = runtimeConfig.port;
let server = null;
let shutdownPromise = null;

const geminiKeyCount = qualityKeyScheduler.initialize();
console.log(`🔑 [GEMINI] Key pool: ${geminiKeyCount} keys loaded.`);

if (runtimeConfig.runtimeMode === 'cloud') {
    app.set('trust proxy', 1);
    const allowedOrigins = [
        'https://tranmed.vercel.app',
        'https://med-translator-frontend.vercel.app',
        'http://localhost:5173',
        runtimeConfig.frontendUrl,
    ].filter(Boolean);
    app.use(cors({
        origin(origin, callback) {
            if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
            return callback(new Error('Not allowed by CORS'));
        },
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
        credentials: true,
    }));
}

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

function hasMaintenanceToken(request) {
    const expected = runtimeConfig.maintenanceControlToken;
    const received = request.get('X-Maintenance-Token') || '';
    if (!expected) return false;
    const expectedBuffer = Buffer.from(expected);
    const receivedBuffer = Buffer.from(received);
    return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
}

async function shutdown(reason) {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
        console.log(`[SHUTDOWN] Đang dừng an toàn (${reason}); không nhận job mới.`);
        server?.close();
        // Queue maintenance waits for a running Gemini stage to persist, then
        // returns jobs to pending at the next stage boundary.
        await translationQueue.shutdown();
        server?.closeAllConnections?.(); // closes only after queue is safe; SSE must not keep Node alive
        await mongoose.disconnect();
        console.log('[SHUTDOWN] Queue và MongoDB đã đóng an toàn.');
        process.exit(0);
    })().catch(error => {
        console.error('[SHUTDOWN] Không thể đóng an toàn:', redactError(error));
        process.exit(1);
    });
    return shutdownPromise;
}

app.post('/api/maintenance/shutdown', (req, res) => {
    if (runtimeConfig.runtimeMode !== 'local') return res.status(404).end();
    if (!runtimeConfig.maintenanceControlToken) {
        return res.status(503).json({ error: 'Local launcher cần MAINTENANCE_CONTROL_TOKEN để dừng an toàn.' });
    }
    if (!hasMaintenanceToken(req)) return res.status(403).json({ error: 'Mã quản trị không hợp lệ.' });
    res.status(202).json({ message: 'Đang dừng an toàn sau ranh giới stage hiện tại.' });
    setImmediate(() => { void shutdown('launcher'); });
});

app.get('/api/health', async (_req, res) => {
    try {
        await mongoose.connection.db.admin().ping();
        res.status(200).json({ status: 'success', message: 'StudyMed API và MongoDB đang hoạt động.' });
    } catch (error) {
        console.error('Database connection failed during health check:', redactError(error));
        res.status(500).json({ status: 'error', message: 'Database connection failed' });
    }
});

app.get('/api/readiness', async (_req, res) => {
    try {
        const storage = await storageReadiness();
        await mongoose.connection.db.admin().ping();
        res.status(200).json({
            status: 'ready',
            runtimeMode: runtimeConfig.runtimeMode,
            database: { available: true },
            storage: { configured: storage.configured, available: storage.available, mode: storage.mode },
        });
    } catch (error) {
        console.error('Readiness check failed:', redactError(error));
        res.status(503).json({
            status: 'not_ready',
            database: { available: mongoose.connection.readyState === 1 },
            storage: { configured: true, available: false, mode: runtimeConfig.storage.mode },
        });
    }
});

app.get('/api/runtime', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ mode: runtimeConfig.runtimeMode, appHost: runtimeConfig.appHost });
});

app.use('/api/translate', translateRoute);

if (runtimeConfig.runtimeMode === 'local') {
    app.use(express.static(frontendDist, { index: false, fallthrough: true }));
    app.get('/{*splat}', async (_req, res, next) => {
        try {
            await fs.access(path.join(frontendDist, 'index.html'));
            return res.sendFile(path.join(frontendDist, 'index.html'));
        } catch (error) {
            return next(error);
        }
    });
}

app.use((err, _req, res, _next) => {
    console.error('Unhandled server error:', redactError(err));
    if (err.name === 'MulterError') {
        const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        return res.status(status).json({ error: err.message });
    }
    if (err.code === 'UPLOAD_INVALID' || err.status === 400) return res.status(400).json({ error: err.message });
    if (err.message === 'Not allowed by CORS') return res.status(403).json({ error: 'Origin không được phép.' });
    return res.status(500).json({ error: 'Lỗi Server Nội Bộ!' });
});

mongoose.connect(runtimeConfig.mongodbUri, { serverSelectionTimeoutMS: 5000 })
    .then(async () => {
        if (localStorageService) await localStorageService.initialize();
        console.log('🟢 [DATABASE] Đã kết nối thành công tới MongoDB.');
        await translationQueue.initDB();
        if (runtimeConfig.runtimeMode === 'cloud') uploadBatchService.startReconciler();

        server = app.listen(PORT, runtimeConfig.appHost, () => {
            console.log(`🚀 StudyMed ${runtimeConfig.runtimeMode} đang chạy tại: http://${runtimeConfig.appHost}:${PORT}`);
        });
    })
    .catch(error => {
        console.error('[DATABASE] Lỗi kết nối MongoDB:', redactError(error));
        process.exit(1);
    });

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
