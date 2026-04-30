const path = require('path');
const PDFDocument = require('pdfkit');
const { SECTIONS, UPSELL_ITEMS, JOB_FIELDS } = require('./inspectionFields');

const NAVY = '#0B2545';
const GOLD = '#F5B700';
const BORDER = '#cccccc';

const LOGO_PATH = path.resolve(__dirname, '..', '..', 'frontend', 'logo-icon.png');

const MARGIN = 50;
const PAGE_WIDTH = 612;          // LETTER, 8.5" x 72
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2; // 512
const CONTENT_RIGHT = PAGE_WIDTH - MARGIN;     // 562
const FOOTER_RESERVE = 40;       // keep this much room above the bottom for the footer

function buildInspectionPdf(data) {
  return new Promise((resolve, reject) => {
    try {
      const d = data || {};
      const doc = new PDFDocument({
        size: 'LETTER',
        margin: MARGIN,
        bufferPages: true,
      });
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

      // Snapshot the page count BEFORE we paint footers so we can trim any
      // accidental blank pages PDFKit added during content layout.
      const contentPageCount = doc.bufferedPageRange().count;
      trimTrailingPages(doc, contentPageCount);
      drawFooters(doc);

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ---------- branding ----------

function drawHeader(doc) {
  const top = MARGIN;
  let textX = MARGIN;

  // Logo (optional — fail silently if not bundled with the deploy).
  try {
    doc.image(LOGO_PATH, MARGIN, top, { fit: [54, 54] });
    textX = MARGIN + 64;
  } catch (_) {
    // No logo available; fall back to text-only header.
  }

  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(22)
    .text('BATES ELECTRIC', textX, top, { lineBreak: false });
  doc.fillColor('#444').font('Helvetica').fontSize(11)
    .text('Electrical Safety Inspection Report', textX, top + 26, { lineBreak: false });

  // Move below the header block, then draw the gold rule.
  doc.y = top + 58;
  doc.moveTo(MARGIN, doc.y).lineTo(CONTENT_RIGHT, doc.y)
    .strokeColor(GOLD).lineWidth(2).stroke();

  doc.fillColor('#666').font('Helvetica').fontSize(9)
    .text(`Generated ${new Date().toLocaleString()}`, MARGIN, doc.y + 6, { lineBreak: false });
  doc.y += 24;
  // After absolute-positioned text the cursor sits past the last glyph; reset
  // x so the first section title (and everything after) starts at the margin.
  doc.x = MARGIN;
  doc.fillColor('#222');
}

function drawFooters(doc) {
  const range = doc.bufferedPageRange();
  const total = range.count;
  for (let i = 0; i < total; i++) {
    doc.switchToPage(range.start + i);
    // Footer sits inside the bottom margin band. PDFKit's line wrapper would
    // auto-paginate any text past `pageHeight - margin.bottom`, so drop the
    // bottom margin to zero just for the footer write and restore it after.
    const origBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const bottom = doc.page.height - 30;
    doc.save();
    doc.font('Helvetica').fontSize(8).fillColor('#888')
      .text(
        `Bates Electric  —  Electrical Safety Inspection            Page ${i + 1} of ${total}`,
        MARGIN, bottom,
        { width: CONTENT_WIDTH, align: 'center', lineBreak: false }
      );
    doc.restore();
    doc.page.margins.bottom = origBottom;
  }
}

// Pop trailing pages from PDFKit's internal buffer. Used to remove blank
// trailing pages that auto-pagination occasionally leaves behind. Mutates
// `_pageBuffer` plus the page tree (`Kids` + `Count`); only safe before
// `flushPages()` / `end()`, which is the case here because we use
// `bufferPages: true`.
function trimTrailingPages(doc, keepCount) {
  if (!doc._pageBuffer || doc._pageBuffer.length <= keepCount) return;
  const pageTree = doc._root && doc._root.data && doc._root.data.Pages
    ? doc._root.data.Pages.data
    : null;
  while (doc._pageBuffer.length > keepCount) {
    doc._pageBuffer.pop();
    if (pageTree) {
      pageTree.Kids.pop();
      pageTree.Count = pageTree.Kids.length;
    }
  }
  // Reset doc.page so any later writes (e.g. footers via switchToPage) target
  // a still-buffered page instead of the popped one.
  doc.page = doc._pageBuffer[doc._pageBuffer.length - 1] || doc.page;
}

// ---------- layout helpers ----------

function ensureRoom(doc, needed = 80) {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom - FOOTER_RESERVE) {
    doc.addPage();
  }
}

function sectionTitle(doc, title) {
  ensureRoom(doc, 60);
  // Drawing functions that place text via absolute (x, y) leave `doc.x` at the
  // end of the last glyph. Reset before/after so flow content following the
  // title (and the title itself) starts at the left margin.
  doc.x = MARGIN;
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(13).text(title);
  doc.moveTo(MARGIN, doc.y + 2).lineTo(CONTENT_RIGHT, doc.y + 2)
    .strokeColor(NAVY).lineWidth(0.7).stroke();
  doc.moveDown(0.4);
  doc.x = MARGIN;
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
  const tableLeft = MARGIN;
  const labelWidth = 180;
  const valueWidth = CONTENT_WIDTH - labelWidth;
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
  // Restore the left margin for any flow text that follows the table.
  doc.x = MARGIN;
}

function drawUpsell(doc, d) {
  // Newer drafts store the label string; older drafts stored `true`.
  const checked = UPSELL_ITEMS
    .map(([n, label]) => {
      const v = d[n];
      if (!v) return null;
      return typeof v === 'string' ? v : label;
    })
    .filter(Boolean);
  if (checked.length === 0 && !d.up_other) return;
  sectionTitle(doc, 'Recommended Services');
  doc.font('Helvetica').fontSize(10).fillColor('#222');
  if (checked.length) doc.text(checked.join(', '), { width: CONTENT_WIDTH });
  if (d.up_other) {
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').text('Other:', { continued: true });
    doc.font('Helvetica').text(' ' + d.up_other, { width: CONTENT_WIDTH });
  }
  doc.moveDown(0.6);
}

function drawNotes(doc, d) {
  if (!d.insp_notes) return;
  sectionTitle(doc, 'Notes');
  doc.font('Helvetica').fontSize(10).fillColor('#222').text(d.insp_notes, { width: CONTENT_WIDTH });
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
      // White backdrop behind the signature: JPEG canvases occasionally come
      // through with a black flood for the transparent pixels (older drafts).
      const sigW = 240;
      const sigH = 80;
      const x = doc.x;
      const y = doc.y;
      doc.save();
      doc.rect(x, y, sigW, sigH).fillColor('#FFFFFF').fill();
      doc.restore();
      doc.image(buf, x, y, { fit: [sigW, sigH] });
      doc.y = y + sigH;
    } catch (e) {
      doc.font('Helvetica').fillColor('#999').text('(signature could not be rendered)');
    }
    doc.moveDown(0.4);
  }
}

function formatValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'Yes' : '';
  return String(v);
}

module.exports = { buildInspectionPdf };
