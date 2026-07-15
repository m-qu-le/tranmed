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
    R2_SOURCE_RETENTION_DAYS: '3',
};

for (const [name, value] of Object.entries(defaults)) {
    if (!process.env[name]) process.env[name] = value;
}
