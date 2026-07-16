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
export const QUALITY_COVERAGE_FOCUSES = Object.freeze([
    'meaning',
    'terminology',
    'number_unit',
    'negation_modality',
    'causal_relation',
    'table_figure',
    'recommendation',
]);

const COVERAGE_ITEM_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['focus', 'sourceExcerpt', 'targetExcerpt', 'result'],
    properties: {
        focus: { type: 'string', enum: QUALITY_COVERAGE_FOCUSES },
        sourceExcerpt: { type: 'string' },
        targetExcerpt: { type: 'string' },
        result: { type: 'string', enum: ['match', 'error'] },
    },
});

export const QUALITY_REPORT_JSON_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['status', 'errors', 'coverage'],
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
        coverage: {
            type: 'object',
            additionalProperties: false,
            required: ['status', 'items'],
            properties: {
                status: { type: 'string', enum: ['COMPLETE', 'INCOMPLETE'] },
                items: { type: 'array', items: COVERAGE_ITEM_SCHEMA },
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
    if (!value.coverage || !['COMPLETE', 'INCOMPLETE'].includes(value.coverage.status)
        || !Array.isArray(value.coverage.items) || value.coverage.items.length === 0) return false;
    if (value.status === 'PASS' && (value.errors.length > 0 || value.coverage.status !== 'COMPLETE')) return false;
    if (value.status === 'FAIL' && value.errors.length === 0 && value.coverage.status === 'COMPLETE') return false;

    const errorsValid = value.errors.every(error => error
        && QUALITY_ERROR_CATEGORIES.includes(error.category)
        && QUALITY_ERROR_SEVERITIES.includes(error.severity)
        && isNonEmptyString(error.sourceExcerpt)
        && typeof error.targetExcerpt === 'string'
        && isNonEmptyString(error.requiredCorrection)
        && isNonEmptyString(error.explanation));
    const coverageValid = value.coverage.items.every(item => item
        && QUALITY_COVERAGE_FOCUSES.includes(item.focus)
        && isNonEmptyString(item.sourceExcerpt)
        && typeof item.targetExcerpt === 'string'
        && ['match', 'error'].includes(item.result));
    return errorsValid && coverageValid;
}

export function minimumQualityCoverageItems(referenceText) {
    const length = typeof referenceText === 'string' ? referenceText.replace(/\s+/g, '').length : 0;
    return Math.max(4, Math.min(20, Math.ceil(length / 500)));
}

export function isQualityCoverageComplete(report, referenceText) {
    return report?.coverage?.status === 'COMPLETE'
        && Array.isArray(report.coverage.items)
        && report.coverage.items.length >= minimumQualityCoverageItems(referenceText);
}

export function hasQualityErrors(report) {
    return report?.status !== 'PASS' || !Array.isArray(report.errors) || report.errors.length > 0;
}
