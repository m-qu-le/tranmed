import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import mongoose from 'mongoose';
import { EJSON } from 'bson';
import '../src/config/env.js';
import { redactError } from '../src/utils/redactSecrets.js';

const mongodbUri = process.env.MONGODB_URI?.trim();
const backupDir = process.env.P002_BACKUP_DIR?.trim();
if (!mongodbUri) throw new Error('Thiếu biến môi trường MONGODB_URI.');
if (!backupDir) throw new Error('Thiếu biến môi trường P002_BACKUP_DIR.');

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputPath = path.resolve(backupDir, `p002-before-migration-${timestamp}.ejson.gz`);

try {
    await mongoose.connect(mongodbUri, { serverSelectionTimeoutMS: 5000 });
    const database = mongoose.connection.db;
    const [jobs, uploadBatches, jobIndexes, uploadBatchIndexes] = await Promise.all([
        database.collection('jobs').find({}).toArray(),
        database.collection('uploadbatches').find({}).toArray(),
        database.collection('jobs').indexes(),
        database.collection('uploadbatches').indexes().catch(error => error?.codeName === 'NamespaceNotFound' ? [] : Promise.reject(error)),
    ]);
    const payload = EJSON.stringify({
        format: 'P002_EJSON_BACKUP_V1',
        createdAt: new Date(),
        databaseName: database.databaseName,
        collections: { jobs, uploadbatches: uploadBatches },
        indexes: { jobs: jobIndexes, uploadbatches: uploadBatchIndexes },
    }, { relaxed: false });
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, gzipSync(payload, { level: 9 }), { flag: 'wx' });
    console.log('P002 backup hoàn thành:', {
        outputPath,
        jobs: jobs.length,
        uploadBatches: uploadBatches.length,
    });
} catch (error) {
    console.error('P002 backup thất bại:', redactError(error));
    process.exitCode = 1;
} finally {
    await mongoose.disconnect();
}
