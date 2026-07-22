import { GEMINI_THINKING_LEVEL } from '../config/env.js';

const PROFILES = Object.freeze({
    legacy: Object.freeze({
        mode: 'legacy',
        stage: 'legacy_translate',
        validationMode: 'legacy',
        generateConfig: Object.freeze({}),
    }),
    quality: Object.freeze({
        mode: 'quality',
        stage: 'quality_translate',
        validationMode: 'strict',
        generateConfig: Object.freeze({
            maxOutputTokens: 65536,
            thinkingConfig: Object.freeze({
                thinkingLevel: GEMINI_THINKING_LEVEL,
                includeThoughts: false,
            }),
        }),
    }),
});

export function getTranslationProfile(mode) {
    const profile = PROFILES[mode];
    if (!profile) throw new Error(`Translation pipeline mode không hỗ trợ: ${mode}`);
    return profile;
}
