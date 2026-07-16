import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildReviewForm,
    sortReviewQueue,
} from '../scripts/create-project-003-review-bundle.js';

test('review bundle sorts a critical case before major-only cases', () => {
    const queue = sortReviewQueue([
        { fileName: 'major.pdf', findings: [{ severity: 'major' }] },
        { fileName: 'critical.pdf', findings: [{ severity: 'critical' }] },
    ]);
    assert.deepEqual(queue.map(item => item.fileName), ['critical.pdf', 'major.pdf']);
});

test('review form includes evidence and exactly three explicit reviewer outcomes', () => {
    const form = buildReviewForm({
        caseNumber: 1,
        fileName: 'medical.pdf',
        startPage: 1,
        endPage: 2,
        findings: [{
            category: 'terminology',
            severity: 'critical',
            sourceExcerpt: 'source evidence',
            targetExcerpt: 'target evidence',
            requiredCorrection: 'required correction',
            explanation: 'evidence-based reason',
        }],
    });

    assert.match(form, /CRITICAL · terminology/);
    assert.match(form, /source evidence/);
    assert.match(form, /target evidence/);
    assert.match(form, /required correction/);
    assert.match(form, /evidence-based reason/);
    assert.equal((form.match(/- \[ \] (Đúng|Sai cảnh báo|Chấp nhận được):/g) || []).length, 3);
});
