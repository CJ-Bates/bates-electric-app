const PDFDocument = require('pdfkit');
const { SECTIONS, UPSELL_NAMES, JOB_FIELDS } = require('./inspectionFields');

const NAVY = '#0B2545';
const GOLD = '#F5B700';
const BORDER = '#cccccc';

function buildInspectionPdf(data) {
  return new Promise((resolve, reject) => {
    try {
      const d = data || {};
      const doc = new PDFDocument({ size: 'LETTER', margin: 50, bufferPages: true });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      drawHeader(doc, d);
      drawJobInfo(doc, d);
      for (const [title, fields] of SECTIONS) {
        drawSection(doc, title, fields, d);
      }
      drawUpsell(doc, d);
      drawNotes(doc, d);
      drawSignatures(doc, d);
      drawPageNumbers(doc);

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

function drawHeader(doc, d) {
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(18)
    .text('Bates Electric — Electrical Safety Inspection', { align: 'left' });
  doc.moveTo(50, doc.y + 4).lineTo(562, doc.y + 4).strokeColor(GOLD).lineWidth(2).stroke();
  doc.moveDown(0.8);

  const date = d.job_date || new Date().toLocaleDateString();
  doc.font('Helvetica').fontSize(9).fillColor('#666')
    .text(`Generated ${new Date().toLocaleString()} • Inspection date ${date}`);
  doc.moveDown(0.8);
}

function ensureRoom(doc, needed = 80) {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }
}

function sectionTitle(doc, title) {
  ensureRoom(doc, 60);
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(13).text(title);
  doc.moveTo(50, doc.y + 2).lineTo(562, doc.y + 2).strokeColor(NAVY).lineWidth(0.7).stroke();
  doc.moveDown(0.4);
}

function drawJobInfo(doc, d) {
  sectionTitle(doc, 'Job Information');
  const rows = JOB_FIELDS.map(([label, key]) => [label, formatValue(d[key])]);
  drawTable(doc, rows);
  doc.moveDown(0.6);
}

function drawSection(doc, title, fields, d) {
  const rows = fields
    .map(([label, key]) => [label, formatValue(d[key])])
    .filter(([, v]) => v !== '');
  if (rows.length === 0) return;
  sectionTitle(doc, title);
  drawTable(doc, rows);
  doc.moveDown(0.6);
}

function drawTable(doc, rows) {
  const tableLeft = 50;
  const tableWidth = 512;
  const labelWidth = 180;
  const valueWidth = tableWidth - labelWidth;
  const padX = 6;
  const padY = 4;

  doc.font('Helvetica').fontSize(9).fillColor('#222');

  for (const [label, value] of rows) {
    const labelHeight = doc.heightOfString(label, { width: labelWidth - padX * 2 });
    const valueHeight = doc.heightOfString(value || '—', { width: valueWidth - padX * 2 });
    const rowHeight = Math.max(labelHeight, valueHeight) + padY * 2;

    ensureRoom(doc, rowHeight + 10);

    const y = doc.y;
    doc.lineWidth(0.5).strokeColor(BORDER);
    doc.rect(tableLeft, y, labelWidth, rowHeight).stroke();
    doc.rect(tableLeft + labelWidth, y, valueWidth, rowHeight).stroke();

    doc.font('Helvetica-Bold').fillColor(NAVY)
      .text(label, tableLeft + padX, y + padY, { width: labelWidth - padX * 2 });
    doc.font('Helvetica').fillColor('#222')
      .text(value || '—', tableLeft + labelWidth + padX, y + padY, { width: valueWidth - padX * 2 });

    doc.y = y + rowHeight;
  }
}

function drawUpsell(doc, d) {
  const checked = UPSELL_NAMES.map((n) => d[n]).filter(Boolean);
  if (checked.length === 0 && !d.up_other) return;
  sectionTitle(doc, 'Recommended Services');
  doc.font('Helvetica').fontSize(10).fillColor('#222');
  if (checked.length) doc.text(checked.join(', '), { width: 512 });
  if (d.up_other) {
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').text('Other:', { continued: true });
    doc.font('Helvetica').text(' ' + d.up_other, { width: 512 });
  }
  doc.moveDown(0.6);
}

function drawNotes(doc, d) {
  if (!d.insp_notes) return;
  sectionTitle(doc, 'Notes');
  doc.font('Helvetica').fontSize(10).fillColor('#222').text(d.insp_notes, { width: 512 });
  doc.moveDown(0.6);
}

function drawSignatures(doc, d) {
  sectionTitle(doc, 'Signatures');

  const rows = [
    ['Technician Name', d.sig_tech_name || ''],
    ['Date', d.sig_date || ''],
    ['Customer Name', d.sig_cust_name || ''],
  ];
  drawTable(doc, rows);
  doc.moveDown(0.4);

  const sigs = [
    ['Technician Signature', d.sigTech],
    ['Customer Signature', d.sigCust],
  ];
  for (const [label, dataUrl] of sigs) {
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) continue;
    ensureRoom(doc, 110);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(NAVY).text(label);
    doc.moveDown(0.2);
    try {
      const b64 = dataUrl.split(',')[1];
      const buf = Buffer.from(b64, 'base64');
      doc.image(buf, { fit: [240, 80] });
    } catch (e) {
      doc.font('Helvetica').fillColor('#999').text('(signature could not be rendered)');
    }
    doc.moveDown(0.4);
  }
}

function drawPageNumbers(doc) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const bottom = doc.page.height - 30;
    doc.font('Helvetica').fontSize(8).fillColor('#888')
      .text(`Bates Electric  •  Page ${i + 1} of ${range.count}`, 50, bottom, {
        width: 512, align: 'center', lineBreak: false,
      });
  }
}

function formatValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'Yes' : '';
  return String(v);
}

module.exports = { buildInspectionPdf };
