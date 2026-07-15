export const QUALITY_ERROR_CATEGORIES = Object.freeze([
    'mistranslation',
    'omission',
    'addition',
    'terminology',
    'negation_modality',
    'causal_relation',
    'number_unit',
    'table_figure',
    'formatting',
]);

export const QUALITY_ERROR_SEVERITIES = Object.freeze(['critical', 'major', 'minor']);

export const QUALITY_REPORT_JSON_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['status', 'errors'],
    properties: {
        status: { type: 'string', enum: ['PASS', 'FAIL'] },
        errors: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: [
                    'category',
                    'severity',
                    'sourceExcerpt',
                    'targetExcerpt',
                    'requiredCorrection',
                    'explanation',
                ],
                properties: {
                    category: { type: 'string', enum: QUALITY_ERROR_CATEGORIES },
                    severity: { type: 'string', enum: QUALITY_ERROR_SEVERITIES },
                    sourceExcerpt: { type: 'string' },
                    targetExcerpt: { type: 'string' },
                    requiredCorrection: { type: 'string' },
                    explanation: { type: 'string' },
                },
            },
        },
    },
});

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

export function isQualityReport(value) {
    if (!value || typeof value !== 'object' || !['PASS', 'FAIL'].includes(value.status) || !Array.isArray(value.errors)) {
        return false;
    }
    if (value.status === 'PASS' && value.errors.length > 0) return false;
    if (value.status === 'FAIL' && value.errors.length === 0) return false;

    return value.errors.every(error => error
        && QUALITY_ERROR_CATEGORIES.includes(error.category)
        && QUALITY_ERROR_SEVERITIES.includes(error.severity)
        && isNonEmptyString(error.sourceExcerpt)
        && typeof error.targetExcerpt === 'string'
        && isNonEmptyString(error.requiredCorrection)
        && isNonEmptyString(error.explanation));
}

export function hasBlockingQualityErrors(report) {
    return report.status === 'FAIL'
        && report.errors.some(error => error.severity === 'critical' || error.severity === 'major');
}
