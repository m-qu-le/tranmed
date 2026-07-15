import mongoose from 'mongoose';
import '../src/config/env.js';
import Job from '../src/models/jobModel.js';
import { r2Service } from '../src/services/runtimeServices.js';
import { redactError } from '../src/utils/redactSecrets.js';

const mongodbUri = process.env.MONGODB_URI?.trim();
if (!mongodbUri) {
    console.error('Thiếu biến môi trường MONGODB_URI.');
    process.exit(1);
}

async function listAllIncomingObjects() {
    const objects = [];
    let continuationToken;
    do {
        const page = await r2Service.listObjects({ prefix: 'incoming/', continuationToken });
        objects.push(...page.objects);
        continuationToken = page.nextContinuationToken;
    } while (continuationToken);
    return objects;
}

try {
    await mongoose.connect(mongodbUri, { serverSelectionTimeoutMS: 5000 });
    const [jobs, objects, lifecycleRules] = await Promise.all([
        Job.find(
            { storageProvider: 'r2', storageKey: { $ne: null } },
            'jobId status storageKey sourceState sourceSize uploadBatchId'
        ).lean(),
        listAllIncomingObjects(),
        r2Service.getLifecycleRules().catch(error => {
            console.warn('Không đọc được lifecycle qua S3 API:', error?.name || 'Error', '-', error?.message || 'unknown');
            return [];
        }),
    ]);
    const objectByKey = new Map(objects.map(object => [object.key, object]));
    const referencedKeys = new Set(jobs
        .filter(job => job.sourceState !== 'deleted')
        .map(job => job.storageKey));
    const missing = jobs.filter(job => job.sourceState !== 'deleted' && !objectByKey.has(job.storageKey));
    const orphan = objects.filter(object => !referencedKeys.has(object.key));
    const referencedObjects = objects.filter(object => referencedKeys.has(object.key));
    const incomingLifecycle = lifecycleRules.find(rule => {
        const prefix = rule.Filter?.Prefix ?? rule.Prefix;
        const days = rule.Expiration?.Days;
        return rule.Status === 'Enabled' && prefix === 'incoming/' && Number(days) <= 3;
    });

    console.log('P002 R2 reconciliation report (read-only):', {
        jobs: jobs.length,
        objects: objects.length,
        referencedObjects: referencedObjects.length,
        referencedBytes: referencedObjects.reduce((sum, object) => sum + object.size, 0),
        missingJobs: missing.length,
        missingJobIds: missing.slice(0, 50).map(job => job.jobId),
        orphanObjects: orphan.length,
        orphanBytes: orphan.reduce((sum, object) => sum + object.size, 0),
        orphanKeys: orphan.slice(0, 50).map(object => object.key),
        incomingLifecycleEnabled: Boolean(incomingLifecycle),
        incomingLifecycleRuleId: incomingLifecycle?.ID || null,
    });
    if (!incomingLifecycle) console.warn('CẢNH BÁO: chưa xác minh được lifecycle incoming/ <= 3 ngày.');
    console.log('Không object hoặc document nào bị xóa/thay đổi.');
} catch (error) {
    console.error('P002 R2 reconciliation thất bại:', redactError(error));
    process.exitCode = 1;
} finally {
    await mongoose.disconnect();
}
