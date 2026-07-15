import { hasBlockingQualityErrors } from './translationQuality.js';

export const QUALITY_PIPELINE_VERSION = 'p003-v1';
export const QUALITY_PROMPT_VERSION = 'p003-prompts-v1';

export const QUALITY_STAGES = Object.freeze([
    'pending',
    'translated',
    'audited',
    'revised',
    'verified',
    'repaired',
    'reverified',
    'completed',
    'needs_review',
]);

export const QUALITY_STATUSES = Object.freeze(['pending', 'passed', 'needs_review']);
export const QUALITY_ACTIONS = Object.freeze([
    'translate',
    'medical_audit',
    'revise',
    'verify',
    'repair',
    'reverify',
]);

const TERMINAL_STAGES = new Set(['completed', 'needs_review']);

export function isTerminalQualityStage(stage) {
    return TERMINAL_STAGES.has(stage);
}

export function getNextQualityAction(chunk) {
    switch (chunk.stage || 'pending') {
        case 'pending': return 'translate';
        case 'translated': return 'medical_audit';
        case 'audited': return 'revise';
        case 'revised': return 'verify';
        case 'verified': return chunk.repairCount >= 1 ? 'complete_needs_review' : 'repair';
        case 'repaired': return 'reverify';
        case 'reverified': return 'complete_needs_review';
        case 'completed':
        case 'needs_review': return null;
        default: throw new Error(`Quality stage không hợp lệ: ${chunk.stage}`);
    }
}

export function transitionForAction(action, result, chunk) {
    const usagePath = `usageByStage.${action}`;
    const baseSet = {
        promptVersion: QUALITY_PROMPT_VERSION,
        stageUpdatedAt: new Date(),
    };
    if (result?.metadata) baseSet[usagePath] = result.metadata;

    switch (action) {
        case 'translate':
            return { nextStage: 'translated', set: { ...baseSet, draftContent: result.text } };
        case 'medical_audit':
            return { nextStage: 'audited', set: { ...baseSet, auditReport: result.json } };
        case 'revise':
            return { nextStage: 'revised', set: { ...baseSet, revisedContent: result.text } };
        case 'verify': {
            const set = { ...baseSet, verificationReport: result.json };
            if (hasBlockingQualityErrors(result.json)) return { nextStage: 'verified', set };
            return {
                nextStage: 'completed',
                set: { ...set, content: chunk.revisedContent, qualityStatus: 'passed' },
                unset: ['draftContent', 'revisedContent', 'repairedContent'],
            };
        }
        case 'repair':
            if (result.invalid) {
                return {
                    nextStage: 'needs_review',
                    set: {
                        ...baseSet,
                        content: chunk.revisedContent || chunk.draftContent,
                        qualityStatus: 'needs_review',
                        repairCount: 1,
                    },
                };
            }
            return {
                nextStage: 'repaired',
                set: { ...baseSet, repairedContent: result.text, repairCount: 1 },
            };
        case 'reverify': {
            const set = { ...baseSet, reverifyReport: result.json, content: chunk.repairedContent };
            if (hasBlockingQualityErrors(result.json)) {
                return { nextStage: 'needs_review', set: { ...set, qualityStatus: 'needs_review' } };
            }
            return {
                nextStage: 'completed',
                set: { ...set, qualityStatus: 'passed' },
                unset: ['draftContent', 'revisedContent', 'repairedContent'],
            };
        }
        case 'complete_needs_review':
            return {
                nextStage: 'needs_review',
                set: {
                    ...baseSet,
                    content: chunk.repairedContent || chunk.revisedContent || chunk.draftContent,
                    qualityStatus: 'needs_review',
                },
            };
        default:
            throw new Error(`Quality action không hợp lệ: ${action}`);
    }
}

export function shouldResetForVersion(chunk, pipelineVersion = QUALITY_PIPELINE_VERSION) {
    if (!chunk) return false;
    if (chunk.content && (!chunk.stage || isTerminalQualityStage(chunk.stage))) return false;
    return Boolean(chunk.pipelineVersion && chunk.pipelineVersion !== pipelineVersion);
}

export function versionResetUpdate(pipelineVersion = QUALITY_PIPELINE_VERSION) {
    return {
        $set: {
            pipelineVersion,
            pipelineMode: 'quality',
            promptVersion: QUALITY_PROMPT_VERSION,
            stage: 'pending',
            qualityStatus: 'pending',
            repairCount: 0,
            usageByStage: {},
            stageUpdatedAt: new Date(),
        },
        $unset: {
            draftContent: 1,
            auditReport: 1,
            revisedContent: 1,
            verificationReport: 1,
            repairedContent: 1,
            reverifyReport: 1,
        },
    };
}
