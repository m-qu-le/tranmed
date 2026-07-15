import { open, unlink } from 'fs/promises';

export default async function validatePdf(req, res, next) {
    const files = req.files || [];
    try {
        for (const file of files) {
            const handle = await open(file.path, 'r');
            let isPdf = false;
            try {
                const signature = Buffer.alloc(5);
                const { bytesRead } = await handle.read(signature, 0, 5, 0);
                isPdf = bytesRead === 5 && signature.toString('ascii') === '%PDF-';
            } finally {
                await handle.close();
            }
            if (!isPdf) {
                await Promise.all(files.map(item => unlink(item.path).catch(() => {})));
                return res.status(400).json({ error: `${file.originalname} không phải PDF hợp lệ.` });
            }
        }
        next();
    } catch (error) {
        await Promise.all(files.map(file => unlink(file.path).catch(() => {})));
        next(error);
    }
}
