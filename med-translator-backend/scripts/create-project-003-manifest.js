import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, '../..');
const sampleDirectory = path.join(repositoryRoot, 'samplepdf');
const outputPath = path.join(repositoryRoot, 'cline_docs', 'project-003-sample-manifest.json');
const pagesPerChunk = 2;

const specialtyRules = [
    [/Hormones and Disorders of Mineral Metabolism|Endocrine Functions of Bone|Osteoporosis|Rickets and Osteomalacia/i, 'Nội tiết và chuyển hóa xương'],
    [/Kidney Stones|Renal Disease|Kidney|Dialysis/i, 'Thận học'],
    [/Neurological|Neurointensive|Neuroendovascular|Pain Management/i, 'Thần kinh học'],
    [/Hematopoietic Stem Cell Transplantation/i, 'Huyết học và ghép tế bào gốc'],
    [/Allergy|Asthma|Allergic Rhinitis|Atopic Dermatitis/i, 'Dị ứng và miễn dịch lâm sàng'],
];

function inferSpecialty(fileName) {
    return specialtyRules.find(([pattern]) => pattern.test(fileName))?.[1] || 'Chưa phân loại';
}

async function createManifest() {
    const fileNames = (await readdir(sampleDirectory))
        .filter(fileName => fileName.toLowerCase().endsWith('.pdf'))
        .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));

    const files = [];
    for (const fileName of fileNames) {
        const bytes = await readFile(path.join(sampleDirectory, fileName));
        const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
        const pageCount = pdf.getPageCount();

        files.push({
            fileName,
            specialty: inferSpecialty(fileName),
            pageCount,
            chunkCount: Math.ceil(pageCount / pagesPerChunk),
            sizeBytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
        });
    }

    const totals = files.reduce((summary, file) => ({
        fileCount: summary.fileCount + 1,
        pageCount: summary.pageCount + file.pageCount,
        chunkCount: summary.chunkCount + file.chunkCount,
        sizeBytes: summary.sizeBytes + file.sizeBytes,
    }), { fileCount: 0, pageCount: 0, chunkCount: 0, sizeBytes: 0 });

    return {
        schemaVersion: 1,
        pagesPerChunk,
        sourceDirectory: 'samplepdf/',
        totals,
        files,
    };
}

const manifest = await createManifest();
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Đã ghi manifest: ${outputPath}`);
console.log(JSON.stringify(manifest.totals));
