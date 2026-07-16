export const QUALITY_DOCUMENT_CONTEXT_VERSION = 'p003-context-v1';
const MINIMUM_CONTEXT_ITEMS = 3;

const TERM_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['sourceTerm', 'preferredVietnamese', 'note'],
    properties: {
        sourceTerm: { type: 'string' },
        preferredVietnamese: { type: 'string' },
        note: { type: 'string' },
    },
});

const RULE_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['sourceExcerpt', 'rule'],
    properties: {
        sourceExcerpt: { type: 'string' },
        rule: { type: 'string' },
    },
});

export const DOCUMENT_CONTEXT_JSON_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['documentFocus', 'terminology', 'abbreviations', 'consistencyRules', 'highRiskNotes'],
    properties: {
        documentFocus: { type: 'string' },
        terminology: { type: 'array', items: TERM_SCHEMA },
        abbreviations: { type: 'array', items: TERM_SCHEMA },
        consistencyRules: { type: 'array', items: RULE_SCHEMA },
        highRiskNotes: { type: 'array', items: { type: 'string' } },
    },
});

function validText(value, maximum = 800) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function validTerm(value) {
    return value && validText(value.sourceTerm, 240)
        && validText(value.preferredVietnamese, 240)
        && validText(value.note, 600);
}

function validRule(value) {
    return value && validText(value.sourceExcerpt, 600) && validText(value.rule, 600);
}

export function isQualityDocumentContext(value) {
    if (!value || !validText(value.documentFocus, 600)
        || !Array.isArray(value.terminology) || value.terminology.length > 80
        || !Array.isArray(value.abbreviations) || value.abbreviations.length > 50
        || !Array.isArray(value.consistencyRules) || value.consistencyRules.length > 40
        || !Array.isArray(value.highRiskNotes) || value.highRiskNotes.length > 30) return false;
    if (!value.terminology.every(validTerm) || !value.abbreviations.every(validTerm)
        || !value.consistencyRules.every(validRule) || !value.highRiskNotes.every(note => validText(note, 600))) return false;
    if (value.terminology.length + value.abbreviations.length
        + value.consistencyRules.length + value.highRiskNotes.length < MINIMUM_CONTEXT_ITEMS) return false;
    return JSON.stringify(value).length <= 60_000;
}
