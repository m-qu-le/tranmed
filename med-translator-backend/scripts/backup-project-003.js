import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import mongoose from 'mongoose';
import { EJSON } from 'bson';
import '../src/config/env.js';
import { redactError } from '../src/utils/redactSecrets.js';

const mongodbUri = process.env.MONGODB_URI?.trim();
const backupDir = process.env.P003_BACKUP_DIR?.trim();
if (!mongodbUri) throw new Error('Thiếu biến môi trường MONGODB_URI.');
if (!backupDir) throw new Error('Thiếu biến môi trường P003_BACKUP_DIR.');

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputPath = path.resolve(backupDir, `p003-before-migration-${timestamp}.ejson.gz`);
const collections = ['jobs', 'translationchunks', 'uploadbatches', 'systems'];

try {
    await mongoose.connect(mongodbUri, { serverSelectionTimeoutMS: 5000 });
    const database = mongoose.connection.db;
    const data = {};
    const indexes = {};
    for (const name of collections) {
        data[name] = await database.collection(name).find({}).toArray();
        indexes[name] = await database.collection(name).indexes()
            .catch(error => error?.codeName === 'NamespaceNotFound' ? [] : Promise.reject(error));
    }
    const payload = EJSON.stringify({
        format: 'P003_EJSON_BACKUP_V1',
        createdAt: new Date(),
        databaseName: database.databaseName,
        collections: data,
        indexes,
    }, { relaxed: false });
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, gzipSync(payload, { level: 9 }), { flag: 'wx' });
    const counts = Object.fromEntries(collections.map(name => [name, data[name].length]));
    console.log('P003 backup hoàn thành:', { outputPath, counts });
} catch (error) {
    console.error('P003 backup thất bại:', redactError(error));
    process.exitCode = 1;
} finally {
    await mongoose.disconnect();
}
