import assert from 'node:assert/strict';
import test from 'node:test';
import { GeminiKeyScheduler } from '../src/services/geminiKeyScheduler.js';
import { buildGeminiKeyStatusPayload } from '../src/controllers/translateController.js';

test('Gemini key status payload contains only the public key pool fields', () => {
    const scheduler = new GeminiKeyScheduler({ keysProvider: () => ['secret-key-a', 'secret-key-b'] });
    const payload = buildGeminiKeyStatusPayload(scheduler);

    assert.equal(payload.keyCount, 2);
    assert.deepEqual(payload.keys, [
        { index: 1, status: 'untested', cooldownUntil: null },
        { index: 2, status: 'untested', cooldownUntil: null },
    ]);
    assert.equal(payload.quota.configuredProjects, 2);
    assert.equal(payload.quota.activeProjectLimit, 2);
    assert.equal(payload.quota.inFlightRequests, 0);
    assert.doesNotMatch(JSON.stringify(payload), /secret-key|project-[a-z]|fingerprint/i);
});
