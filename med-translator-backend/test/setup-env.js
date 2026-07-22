const defaults = {
    MONGODB_URI: 'mongodb://127.0.0.1:27017/tranmed-test',
    GEMINI_API_KEYS: 'test-gemini-key',
    R2_ACCOUNT_ID: 'test-account',
    R2_ACCESS_KEY_ID: 'test-access-key',
    R2_SECRET_ACCESS_KEY: 'test-secret-key',
    R2_BUCKET_NAME: 'test-bucket',
    R2_ENDPOINT: 'https://test-account.r2.cloudflarestorage.com',
    R2_REGION: 'auto',
    R2_PRESIGNED_URL_TTL_SECONDS: '1800',
    R2_UPLOAD_CONCURRENCY: '4',
    R2_SOURCE_RETENTION_DAYS: '7',
    GEMINI_MODEL: 'gemini-3.5-flash-lite',
    GEMINI_TIMEOUT_MS: '180000',
    TRANSLATION_PIPELINE_MODE: 'quality',
    PDF_PAGES_PER_CHUNK: '2',
    GEMINI_THINKING_LEVEL: 'HIGH',
    QUALITY_MAX_REPAIR_CYCLES: '2',
    TRANSLATION_WORKER_CONCURRENCY: '5',
    PARALLEL_SOURCE_BUDGET_MB: '100',
};

for (const [name, value] of Object.entries(defaults)) {
    if (!process.env[name]) process.env[name] = value;
}
