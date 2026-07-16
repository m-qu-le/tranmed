import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchmarkSafeFileStem } from './benchmark-project-003.js';
import { extractPdfPageRange } from '../src/utils/pdfSplitter.js';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), '../..');
const reportPath = path.join(repositoryRoot, 'cline_docs', 'project-003-full-corpus-report.json');
const sampleDirectory = path.join(repositoryRoot, 'samplepdf');
const artifactDirectory = path.join(repositoryRoot, '.p003-local', 'benchmarks');
const outputDirectory = path.join(repositoryRoot, '.p003-local', 'review-bundle');

function markdownQuote(value) {
    const text = typeof value === 'string' && value.trim() ? value.trim() : '(trống)';
    return text.split(/\r?\n/).map(line => `> ${line}`).join('\n');
}

function findingLabel(finding) {
    return `${finding.severity.toUpperCase()} · ${finding.category}`;
}

export function sortReviewQueue(queue) {
    return [...queue].sort((left, right) => {
        const leftCritical = left.findings.some(finding => finding.severity === 'critical');
        const rightCritical = right.findings.some(finding => finding.severity === 'critical');
        return Number(rightCritical) - Number(leftCritical);
    });
}

export function buildReviewForm({ caseNumber, fileName, startPage, endPage, findings }) {
    const sections = findings.map((finding, index) => `## Finding ${index + 1} — ${findingLabel(finding)}\n\n` +
        `Đoạn nguồn được model viện dẫn:\n\n${markdownQuote(finding.sourceExcerpt)}\n\n` +
        `Đoạn dịch được model viện dẫn:\n\n${markdownQuote(finding.targetExcerpt)}\n\n` +
        `Sửa chữa model yêu cầu:\n\n${markdownQuote(finding.requiredCorrection)}\n\n` +
        `Lý do model đưa ra:\n\n${markdownQuote(finding.explanation)}\n\n` +
        `Kết luận của người duyệt — chỉ chọn một:\n\n` +
        `- [ ] Đúng: bản dịch thực sự sai hoặc thiếu.\n` +
        `- [ ] Sai cảnh báo: bản dịch hiện tại đúng.\n` +
        `- [ ] Chấp nhận được: cách diễn đạt chưa tối ưu nhưng không làm sai ý.\n\n` +
        `Bản sửa bạn đề nghị, nếu có:\n\n` +
        `> \n`).join('\n');

    return `# Phiếu ${String(caseNumber).padStart(2, '0')} — ${fileName}, trang ${startPage}–${endPage}\n\n` +
        `## Tệp cần mở\n\n` +
        `- Nguồn: [01-source-pages-${startPage}-${endPage}.pdf](./01-source-pages-${startPage}-${endPage}.pdf)\n` +
        `- Bản dịch cuối: [02-final-translation.md](./02-final-translation.md)\n\n` +
        `Đọc PDF nguồn và bản dịch cuối trước, sau đó xác minh từng finding bên dưới. Không cần chấm lỗi minor hoặc văn phong ngoài phạm vi finding.\n\n` +
        sections +
        `## Kết luận toàn chunk\n\n` +
        `- [ ] Có thể dùng nguyên trạng.\n` +
        `- [ ] Chỉ dùng sau khi áp dụng sửa chữa ghi trên.\n` +
        `- [ ] Không nên dùng; cần dịch/review lại toàn chunk.\n\n` +
        `Ghi chú thêm, tối đa ba ý ngắn:\n\n` +
        `1. \n2. \n3. \n\n` +
        `Người duyệt: \n\nNgày duyệt: \n`;
}

function buildIndex(cases) {
    const rows = cases.map(item => {
        const labels = item.findings.map(findingLabel).join(', ');
        return `- [ ] [Phiếu ${String(item.caseNumber).padStart(2, '0')} — ${item.fileName}, trang ${item.startPage}–${item.endPage}](./${item.directoryName}/03-review-form.md) — ${labels}`;
    }).join('\n');
    return `# PROJECT 003 — Bộ duyệt critical/major\n\n` +
        `Bộ này có ${cases.length} chunk cần người dùng xác minh. Phiếu critical được xếp đầu. Toàn bộ nội dung nằm trong thư mục local đã được Git ignore.\n\n` +
        `## Cách làm\n\n` +
        `1. Mở từng phiếu theo danh sách dưới đây.\n` +
        `2. Đọc PDF nguồn và bản dịch cuối.\n` +
        `3. Với mỗi finding, chỉ chọn một kết luận và ghi bản sửa nếu cần.\n` +
        `4. Chọn một kết luận toàn chunk.\n` +
        `5. Khi hoàn tất, báo Codex: \"Tôi đã duyệt xong bộ review P003\".\n\n` +
        `Không mở hoặc sửa raw benchmark JSON; mọi thông tin cần thiết đã được đưa vào từng phiếu.\n\n` +
        `## Danh sách\n\n${rows}\n`;
}

async function loadCase(item, caseNumber) {
    const stem = benchmarkSafeFileStem(item.fileName);
    const artifactName = `b4-${stem}-p${item.startPage}-${item.endPage}.json`;
    const artifact = JSON.parse(await readFile(path.join(artifactDirectory, artifactName), 'utf8'));
    if (artifact.source?.fileName !== item.fileName
        || artifact.source?.startPage !== item.startPage
        || artifact.source?.endPage !== item.endPage
        || artifact.qualityStatus !== 'needs_review') {
        throw new Error(`Artifact không khớp review queue: ${artifactName}`);
    }
    const findings = (artifact.finalReport?.errors || [])
        .filter(finding => ['critical', 'major'].includes(finding.severity));
    if (findings.length !== item.findings.length) {
        throw new Error(`Số finding critical/major không khớp: ${artifactName}`);
    }

    const sourcePath = path.join(sampleDirectory, item.fileName);
    const sourceBytes = await readFile(sourcePath);
    const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
    if (sourceSha256 !== artifact.source.sourceSha256) {
        throw new Error(`PDF nguồn đã thay đổi: ${item.fileName}`);
    }
    const pageRange = await extractPdfPageRange(
        sourceBytes,
        item.startPage,
        item.endPage - item.startPage + 1
    );
    const directoryName = `${String(caseNumber).padStart(2, '0')}-${stem}-p${item.startPage}-${item.endPage}`;
    return { ...item, caseNumber, directoryName, artifact, findings, pageRange };
}

async function main() {
    const expectedParent = path.join(repositoryRoot, '.p003-local');
    if (path.dirname(outputDirectory) !== expectedParent) {
        throw new Error('Review bundle phải nằm trực tiếp trong .p003-local.');
    }
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    const queue = sortReviewQueue(report.quality?.reviewQueue || []);
    if (queue.length !== report.quality?.needsReview || queue.length === 0) {
        throw new Error('Review queue thiếu hoặc không khớp số chunk needs_review.');
    }

    const cases = [];
    for (const [index, item] of queue.entries()) {
        cases.push(await loadCase(item, index + 1));
    }

    await rm(outputDirectory, { recursive: true, force: true });
    await mkdir(outputDirectory, { recursive: true });
    for (const item of cases) {
        const caseDirectory = path.join(outputDirectory, item.directoryName);
        await mkdir(caseDirectory, { recursive: true });
        await Promise.all([
            writeFile(
                path.join(caseDirectory, `01-source-pages-${item.startPage}-${item.endPage}.pdf`),
                item.pageRange.buffer
            ),
            writeFile(
                path.join(caseDirectory, '02-final-translation.md'),
                `# Bản dịch cuối — ${item.fileName}, trang ${item.startPage}–${item.endPage}\n\n${item.artifact.response.text.trim()}\n`,
                'utf8'
            ),
            writeFile(
                path.join(caseDirectory, '03-review-form.md'),
                buildReviewForm(item),
                'utf8'
            ),
        ]);
    }

    const manifest = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        caseCount: cases.length,
        criticalCaseCount: cases.filter(item => item.findings.some(finding => finding.severity === 'critical')).length,
        cases: cases.map(item => ({
            caseNumber: item.caseNumber,
            directoryName: item.directoryName,
            fileName: item.fileName,
            startPage: item.startPage,
            endPage: item.endPage,
            findings: item.findings.map(finding => ({ category: finding.category, severity: finding.severity })),
        })),
    };
    await Promise.all([
        writeFile(path.join(outputDirectory, '00-REVIEW-INDEX.md'), buildIndex(cases), 'utf8'),
        writeFile(path.join(outputDirectory, 'bundle-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    ]);
    console.log(JSON.stringify({
        outputDirectory: path.relative(repositoryRoot, outputDirectory),
        caseCount: manifest.caseCount,
        criticalCaseCount: manifest.criticalCaseCount,
        index: path.relative(repositoryRoot, path.join(outputDirectory, '00-REVIEW-INDEX.md')),
    }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    main().catch(error => {
        console.error(error?.stack || error);
        process.exitCode = 1;
    });
}
