import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const outputPath = process.argv[2] || path.join(os.tmpdir(), 'study-med-project-001-smoke.pdf');
const pdf = await PDFDocument.create();
const page = pdf.addPage([595, 842]);
const font = await pdf.embedFont(StandardFonts.Helvetica);

page.drawText('Chapter 1: Cardiovascular System', {
    x: 60,
    y: 760,
    size: 20,
    font,
    color: rgb(0.1, 0.1, 0.1)
});
page.drawText('The heart pumps blood through the body and supplies oxygen to tissues.', {
    x: 60,
    y: 710,
    size: 12,
    font,
    color: rgb(0.1, 0.1, 0.1)
});

await fs.writeFile(outputPath, await pdf.save());
console.log(outputPath);
