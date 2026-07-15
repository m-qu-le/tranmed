const PRESIGNED_QUERY_PATTERN = /([?&])X-Amz-[^\s#]*/gi;
const MONGODB_CREDENTIAL_PATTERN = /(mongodb(?:\+srv)?:\/\/)[^@\s/]+@/gi;

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getRuntimeSecrets() {
    return [
        process.env.R2_ACCESS_KEY_ID,
        process.env.R2_SECRET_ACCESS_KEY,
        process.env.MONGODB_URI,
        ...(process.env.GEMINI_API_KEYS || '').split(','),
    ]
        .map(value => value?.trim())
        .filter(Boolean);
}

export function redactSensitiveText(value, extraSecrets = []) {
    let redacted = String(value ?? '');
    const secrets = [...getRuntimeSecrets(), ...extraSecrets]
        .map(secret => String(secret).trim())
        .filter(secret => secret.length >= 4)
        .sort((a, b) => b.length - a.length);

    for (const secret of secrets) {
        redacted = redacted.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED]');
    }

    redacted = redacted.replace(MONGODB_CREDENTIAL_PATTERN, '$1[REDACTED]@');
    redacted = redacted.replace(PRESIGNED_QUERY_PATTERN, '$1[REDACTED_PRESIGNED_QUERY]');
    return redacted;
}

export function redactError(error) {
    if (!error) return 'Unknown error';
    return redactSensitiveText(error.stack || error.message || error);
}
