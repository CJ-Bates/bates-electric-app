const path = require('path');
const PDFDocument = require('pdfkit');
const { SECTIONS, UPSELL_ITEMS, JOB_FIELDS } = require('./inspectionFields');

// ── Brand colours ──
const NAVY      = '#0B2545';
const GOLD      = '#F5B700';
const GOLD_LIGHT = '#FFF4D6';
const WHITE     = '#FFFFFF';
const LIGHT_BG  = '#F7F8FA';
const BORDER    = '#D0D5DD';
const TEXT_DARK  = '#1A1A1A';
const TEXT_MED   = '#4A5568';
const TEXT_LIGHT  = '#718096';

// Status colours
const GREEN     = '#16A34A';
const GREEN_BG  = '#DCFCE7';
const RED       = '#DC2626';
const RED_BG    = '#FEE2E2';
const AMBER     = '#D97706';
const AMBER_BG  = '#FEF3C7';
const GRAY      = '#6B7280';
const GRAY_BG   = '#F3F4F6';

const LOGO_PATH = path.resolve(__dirname, '..', '..', 'frontend', 'logo-mark.png');

const MARGIN = 48;
const PAGE_WIDTH = 612;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const CONTENT_RIGHT = PAGE_WIDTH - MARGIN;
const FOOTER_RESERVE = 40;

// Contact info for the header
const COMPANY_PHONE = '(636) 464-3939';
const COMPANY_EMAIL = 'inspections.bateselectric@gmail.com';

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
      drawRatingSummary(doc, d);
      drawJobInfo(doc, d);
      for (const [title, fields] of SECTIONS) {
        drawSection(doc, title, fields, d);
      }
      drawUpsell(doc, d);
      drawNotes(doc, d);
      drawSignatures(doc, d);

      const contentPageCount = doc.bufferedPageRange().count;
      trimTrailingPages(doc, contentPageCount);
      drawFooters(doc);

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ═══════════════════════════════════════════════════════════════
//  HEADER — navy banner with logo, company name, contact info
// ═══════════════════════════════════════════════════════════════

function drawHeader(doc, d) {
  const bannerH = 90;
  const bannerTop = 0;

  // Navy banner background — full width, bleeds into margins
  doc.save();
  doc.rect(0, bannerTop, PAGE_WIDTH, bannerH).fill(NAVY);

  // Gold accent strip at bottom of banner
  doc.rect(0, bannerH, PAGE_WIDTH, 3).fill(GOLD);
  doc.restore();

  // Logo
  let textX = MARGIN + 4;
  try {
    const logoSize = 52;
    const logoY = bannerTop + (bannerH - logoSize) / 2;
    doc.image(LOGO_PATH, MARGIN, logoY, { fit: [logoSize, logoSize] });
    textX = MARGIN + logoSize + 14;
  } catch (_) {
    // No logo; text-only header
  }

  // Company name
  doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(24)
    .text('BATES ELECTRIC', textX, bannerTop + 18, { lineBreak: false });

  // Subtitle
  doc.fillColor(GOLD).font('Helvetica').fontSize(10)
    .text('Electrical Safety Inspection Report', textX, bannerTop + 46, { lineBreak: false });

  // Contact info — right-aligned
  doc.fillColor(WHITE).font('Helvetica').fontSize(8);
  const contactY = bannerTop + 22;
  doc.text(COMPANY_PHONE, MARGIN, contactY, { width: CONTENT_WIDTH, align: 'right' });
  doc.text(COMPANY_EMAIL, MARGIN, contactY + 12, { width: CONTENT_WIDTH, align: 'right' });

  // Customer & date quick-reference below the contact info
  const custName = d.job_cust || '';
  const jobDate = d.job_date || '';
  if (custName || jobDate) {
    doc.fillColor('#CBD5E1').font('Helvetica').fontSize(7.5);
    const refParts = [];
    if (custName) refParts.push(custName);
    if (jobDate) refParts.push(jobDate);
    doc.text(refParts.join('  |  '), MARGIN, contactY + 28, { width: CONTENT_WIDTH, align: 'right' });
  }

  // Position cursor below banner + gold strip + spacing
  doc.y = bannerH + 3 + 16;
  doc.x = MARGIN;
  doc.fillColor(TEXT_DARK);
}

// ═══════════════════════════════════════════════════════════════
//  RATING SUMMARY — quick-glance box showing each section rating
// ═══════════════════════════════════════════════════════════════

function drawRatingSummary(doc, d) {
  const ratingKeys = [
    ['Main Panel', 'mp_rating'],
    ['Sub Panel', 'sp_rating'],
    ['Service', 'svc_rating'],
    ['General Wiring', 'gw_rating'],
    ['Smoke/CO', 'sm_rating'],
    ['Attic/Crawl', 'ac_rating'],
    ['HVAC', 'hv_rating'],
  ];

  const ratings = ratingKeys
    .map(([label, key]) => [label, d[key]])
    .filter(([, v]) => v);

  if (ratings.length === 0) return;

  ensureRoom(doc, 70);

  const boxTop = doc.y;
  const boxH = 52;

  // Light background box with gold left border
  doc.save();
  doc.rect(MARGIN, boxTop, CONTENT_WIDTH, boxH)
    .fillColor(GOLD_LIGHT).fill();
  doc.rect(MARGIN, boxTop, 4, boxH)
    .fillColor(GOLD).fill();
  doc.restore();

  // Title
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9)
    .text('INSPECTION SUMMARY', MARGIN + 14, boxTop + 8, { lineBreak: false });

  // Rating chips
  const chipY = boxTop + 26;
  let chipX = MARGIN + 14;
  const chipH = 18;

  for (const [label, value] of ratings) {
    const { bg, fg } = ratingColors(value);
    const chipLabel = `${label}: ${value}`;
    const textW = doc.font('Helvetica-Bold').fontSize(7.5)
      .widthOfString(chipLabel);
    const chipW = textW + 14;

    if (chipX + chipW > CONTENT_RIGHT - 10) {
      // Wrap to next line if too wide (shouldn't happen normally)
      break;
    }

    doc.save();
    roundedRect(doc, chipX, chipY, chipW, chipH, 4);
    doc.fillColor(bg).fill();
    doc.restore();

    doc.fillColor(fg).font('Helvetica-Bold').fontSize(7.5)
      .text(chipLabel, chipX + 7, chipY + 4.5, { lineBreak: false });

    chipX += chipW + 6;
  }

  doc.y = boxTop + boxH + 12;
  doc.x = MARGIN;
  doc.fillColor(TEXT_DARK);
}

// ═══════════════════════════════════════════════════════════════
//  SECTION TITLES
// ═══════════════════════════════════════════════════════════════

function sectionTitle(doc, title) {
  ensureRoom(doc, 50);
  doc.x = MARGIN;

  const titleH = 24;
  const titleY = doc.y;

  // Navy background bar
  doc.save();
  doc.rect(MARGIN, titleY, CONTENT_WIDTH, titleH).fill(NAVY);
  // Gold left accent
  doc.rect(MARGIN, titleY, 4, titleH).fill(GOLD);
  doc.restore();

  doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(11)
    .text(title.toUpperCase(), MARGIN + 12, titleY + 6.5, { lineBreak: false });

  doc.y = titleY + titleH + 6;
  doc.x = MARGIN;
  doc.fillColor(TEXT_DARK);
}

// ═══════════════════════════════════════════════════════════════
//  JOB INFO
// ═══════════════════════════════════════════════════════════════

function drawJobInfo(doc, d) {
  sectionTitle(doc, 'Job Information');
  const rows = JOB_FIELDS.map(([label, key]) => [label, formatValue(d[key])]);
  drawTable(doc, rows, false);  // no status badges for job info
  doc.moveDown(0.6);
}

// ═══════════════════════════════════════════════════════════════
//  INSPECTION SECTIONS
// ═══════════════════════════════════════════════════════════════

function drawSection(doc, title, fields, d) {
  const rows = fields
    .map(([label, key]) => [label, formatValue(d[key])])
    .filter(([, v]) => v !== '');
  if (rows.length === 0) return;
  sectionTitle(doc, title);
  drawTable(doc, rows, true);  // with status badges
  doc.moveDown(0.6);
}

// ═══════════════════════════════════════════════════════════════
//  TABLE — alternating rows with optional status badges
// ═══════════════════════════════════════════════════════════════

function drawTable(doc, rows, useBadges) {
  const tableLeft = MARGIN;
  const labelWidth = 190;
  const valueWidth = CONTENT_WIDTH - labelWidth;
  const padX = 8;
  const padY = 5;

  doc.font('Helvetica').fontSize(9).fillColor(TEXT_DARK);

  for (let i = 0; i < rows.length; i++) {
    const [label, value] = rows[i];
    const isEven = i % 2 === 0;

    const labelHeight = doc.heightOfString(label, { width: labelWidth - padX * 2 });
    const valueHeight = doc.heightOfString(value || '—', { width: valueWidth - padX * 2 });
    const rowHeight = Math.max(labelHeight, valueHeight) + padY * 2;

    ensureRoom(doc, rowHeight + 4);

    const y = doc.y;

    // Alternating row background
    if (isEven) {
      doc.save();
      doc.rect(tableLeft, y, CONTENT_WIDTH, rowHeight).fill(LIGHT_BG);
      doc.restore();
    }

    // Subtle bottom border
    doc.save();
    doc.moveTo(tableLeft, y + rowHeight)
      .lineTo(tableLeft + CONTENT_WIDTH, y + rowHeight)
      .strokeColor(BORDER).lineWidth(0.3).stroke();
    doc.restore();

    // Label
    doc.font('Helvetica-Bold').fontSize(9).fillColor(NAVY)
      .text(label, tableLeft + padX, y + padY, { width: labelWidth - padX * 2 });

    // Value — with optional badge
    if (useBadges && isStatusValue(value)) {
      drawStatusBadge(doc, value, tableLeft + labelWidth + padX, y + padY);
    } else {
      doc.font('Helvetica').fontSize(9).fillColor(TEXT_DARK)
        .text(value || '—', tableLeft + labelWidth + padX, y + padY, { width: valueWidth - padX * 2 });
    }

    doc.y = y + rowHeight;
  }
  doc.x = MARGIN;
}

// ═══════════════════════════════════════════════════════════════
//  STATUS BADGES — color-coded chips for Y/N/NA/Good/Poor/Hazard
// ═══════════════════════════════════════════════════════════════

function isStatusValue(val) {
  if (!val) return false;
  const v = val.trim().toUpperCase();
  return ['Y', 'N', 'NA', 'N/A', 'GOOD', 'FAIR', 'POOR', 'HAZARD'].includes(v);
}

function drawStatusBadge(doc, value, x, y) {
  const { bg, fg } = statusColors(value);
  const label = value.trim().toUpperCase();

  doc.font('Helvetica-Bold').fontSize(8);
  const textW = doc.widthOfString(label);
  const badgeW = textW + 12;
  const badgeH = 15;

  doc.save();
  roundedRect(doc, x, y, badgeW, badgeH, 3);
  doc.fillColor(bg).fill();
  doc.restore();

  doc.fillColor(fg).font('Helvetica-Bold').fontSize(8)
    .text(label, x + 6, y + 3.5, { lineBreak: false });

  doc.fillColor(TEXT_DARK);
}

function statusColors(val) {
  const v = (val || '').trim().toUpperCase();
  if (v === 'Y' || v === 'GOOD') return { bg: GREEN_BG, fg: GREEN };
  if (v === 'N' || v === 'POOR' || v === 'HAZARD') return { bg: RED_BG, fg: RED };
  if (v === 'FAIR') return { bg: AMBER_BG, fg: AMBER };
  return { bg: GRAY_BG, fg: GRAY };  // NA, N/A, etc.
}

function ratingColors(val) {
  const v = (val || '').trim().toUpperCase();
  if (v === 'GOOD') return { bg: GREEN_BG, fg: GREEN };
  if (v === 'POOR' || v === 'HAZARD') return { bg: RED_BG, fg: RED };
  if (v === 'FAIR') return { bg: AMBER_BG, fg: AMBER };
  return { bg: GRAY_BG, fg: GRAY };
}

// ═══════════════════════════════════════════════════════════════
//  RECOMMENDED SERVICES — highlighted call-to-action box
// ═══════════════════════════════════════════════════════════════

function drawUpsell(doc, d) {
  const checked = UPSELL_ITEMS
    .map(([n, label]) => {
      const v = d[n];
      if (!v) return null;
      return typeof v === 'string' ? v : label;
    })
    .filter(Boolean);
  if (checked.length === 0 && !d.up_other) return;

  sectionTitle(doc, 'Recommended Services & Upgrades');

  const boxTop = doc.y;

  // Calculate box height
  doc.font('Helvetica').fontSize(9);
  let textHeight = 0;
  // Intro text
  textHeight += 16;
  // Each item as a bullet
  for (const item of checked) {
    textHeight += doc.heightOfString(`•  ${item}`, { width: CONTENT_WIDTH - 36 }) + 3;
  }
  if (d.up_other) {
    textHeight += 16 + doc.heightOfString(d.up_other, { width: CONTENT_WIDTH - 36 });
  }
  const boxH = textHeight + 24;

  ensureRoom(doc, boxH + 10);

  // Gold-bordered box with light gold background
  doc.save();
  doc.rect(MARGIN, boxTop, CONTENT_WIDTH, boxH)
    .fillColor(GOLD_LIGHT).fill();
  doc.rect(MARGIN, boxTop, CONTENT_WIDTH, boxH)
    .strokeColor(GOLD).lineWidth(1.5).stroke();
  // Gold left accent bar
  doc.rect(MARGIN, boxTop, 4, boxH).fill(GOLD);
  doc.restore();

  let textY = boxTop + 10;
  const textX = MARGIN + 14;

  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9)
    .text('The following were identified during inspection and are recommended:', textX, textY, { width: CONTENT_WIDTH - 36 });
  textY += 18;

  doc.font('Helvetica').fontSize(9).fillColor(TEXT_DARK);
  for (const item of checked) {
    doc.text(`•  ${item}`, textX, textY, { width: CONTENT_WIDTH - 36 });
    textY = doc.y + 2;
  }

  if (d.up_other) {
    textY += 6;
    doc.font('Helvetica-Bold').fillColor(NAVY).text('Other:', textX, textY, { continued: true });
    doc.font('Helvetica').fillColor(TEXT_DARK).text(` ${d.up_other}`, { width: CONTENT_WIDTH - 36 });
  }

  doc.y = boxTop + boxH + 10;
  doc.x = MARGIN;
}

// ═══════════════════════════════════════════════════════════════
//  NOTES
// ═══════════════════════════════════════════════════════════════

function drawNotes(doc, d) {
  if (!d.insp_notes) return;
  sectionTitle(doc, 'Notes & Observations');

  const noteTop = doc.y;
  doc.font('Helvetica').fontSize(9).fillColor(TEXT_DARK);
  const noteH = doc.heightOfString(d.insp_notes, { width: CONTENT_WIDTH - 24 });
  const boxH = noteH + 20;

  ensureRoom(doc, boxH + 10);

  // Light background box
  doc.save();
  doc.rect(MARGIN, noteTop, CONTENT_WIDTH, boxH).fill(LIGHT_BG);
  doc.rect(MARGIN, noteTop, 3, boxH).fill(NAVY);
  doc.restore();

  doc.font('Helvetica').fontSize(9).fillColor(TEXT_DARK)
    .text(d.insp_notes, MARGIN + 12, noteTop + 10, { width: CONTENT_WIDTH - 24 });

  doc.y = noteTop + boxH + 10;
  doc.x = MARGIN;
}

// ═══════════════════════════════════════════════════════════════
//  SIGNATURES — professional block with lines
// ═══════════════════════════════════════════════════════════════

function drawSignatures(doc, d) {
  sectionTitle(doc, 'Signatures & Acknowledgment');

  ensureRoom(doc, 200);

  // Disclaimer text
  doc.font('Helvetica').fontSize(8).fillColor(TEXT_MED)
    .text(
      'By signing below, the technician certifies that this inspection was performed in accordance with applicable codes and standards. The customer acknowledges receipt of this report.',
      MARGIN, doc.y, { width: CONTENT_WIDTH }
    );
  doc.moveDown(0.8);

  const sigData = [
    { label: 'Technician', name: d.sig_tech_name, sigField: d.sigTech, date: d.sig_date },
    { label: 'Customer', name: d.sig_cust_name, sigField: d.sigCust, date: d.sig_date },
  ];

  for (const sig of sigData) {
    ensureRoom(doc, 110);

    const blockTop = doc.y;

    // Signature image or line
    doc.font('Helvetica-Bold').fontSize(9).fillColor(NAVY)
      .text(`${sig.label} Signature`, MARGIN, blockTop, { lineBreak: false });

    const sigY = blockTop + 16;
    const sigW = 260;
    const sigH = 60;

    if (sig.sigField && typeof sig.sigField === 'string' && sig.sigField.startsWith('data:image/')) {
      try {
        const b64 = sig.sigField.split(',')[1];
        const buf = Buffer.from(b64, 'base64');
        // White backdrop behind signature
        doc.save();
        doc.rect(MARGIN, sigY, sigW, sigH).fillColor(WHITE).fill();
        doc.rect(MARGIN, sigY, sigW, sigH).strokeColor(BORDER).lineWidth(0.5).stroke();
        doc.restore();
        doc.image(buf, MARGIN + 4, sigY + 4, { fit: [sigW - 8, sigH - 8] });
      } catch (_) {
        // Draw empty signature line
        drawSigLine(doc, MARGIN, sigY + sigH - 4, sigW);
      }
    } else {
      drawSigLine(doc, MARGIN, sigY + sigH - 4, sigW);
    }

    // Name and date fields to the right
    const infoX = MARGIN + sigW + 20;
    const infoW = CONTENT_WIDTH - sigW - 20;

    doc.font('Helvetica').fontSize(8).fillColor(TEXT_MED)
      .text('Printed Name', infoX, sigY, { lineBreak: false });
    doc.font('Helvetica').fontSize(10).fillColor(TEXT_DARK)
      .text(sig.name || '', infoX, sigY + 12, { width: infoW });
    drawSigLine(doc, infoX, sigY + 26, infoW);

    doc.font('Helvetica').fontSize(8).fillColor(TEXT_MED)
      .text('Date', infoX, sigY + 34, { lineBreak: false });
    doc.font('Helvetica').fontSize(10).fillColor(TEXT_DARK)
      .text(sig.date || '', infoX, sigY + 46, { width: infoW });
    drawSigLine(doc, infoX, sigY + 58, infoW);

    doc.y = sigY + sigH + 12;
    doc.x = MARGIN;
  }
}

function drawSigLine(doc, x, y, width) {
  doc.save();
  doc.moveTo(x, y).lineTo(x + width, y)
    .strokeColor(BORDER).lineWidth(0.7).stroke();
  doc.restore();
}

// ═══════════════════════════════════════════════════════════════
//  FOOTERS
// ═══════════════════════════════════════════════════════════════

function drawFooters(doc) {
  const range = doc.bufferedPageRange();
  const total = range.count;
  for (let i = 0; i < total; i++) {
    doc.switchToPage(range.start + i);
    const origBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const bottom = doc.page.height - 28;

    // Gold line above footer
    doc.save();
    doc.moveTo(MARGIN, bottom - 6).lineTo(CONTENT_RIGHT, bottom - 6)
      .strokeColor(GOLD).lineWidth(0.5).stroke();
    doc.restore();

    doc.font('Helvetica').fontSize(7).fillColor(TEXT_LIGHT)
      .text(
        `Bates Electric  •  Electrical Safety Inspection  •  ${COMPANY_PHONE}`,
        MARGIN, bottom,
        { width: CONTENT_WIDTH * 0.7, align: 'left', lineBreak: false }
      );
    doc.font('Helvetica').fontSize(7).fillColor(TEXT_LIGHT)
      .text(
        `Page ${i + 1} of ${total}`,
        MARGIN, bottom,
        { width: CONTENT_WIDTH, align: 'right', lineBreak: false }
      );

    doc.page.margins.bottom = origBottom;
  }
}

// ═══════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════

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
  doc.page = doc._pageBuffer[doc._pageBuffer.length - 1] || doc.page;
}

function ensureRoom(doc, needed = 80) {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom - FOOTER_RESERVE) {
    doc.addPage();
  }
}

function roundedRect(doc, x, y, w, h, r) {
  doc.moveTo(x + r, y)
    .lineTo(x + w - r, y)
    .quadraticCurveTo(x + w, y, x + w, y + r)
    .lineTo(x + w, y + h - r)
    .quadraticCurveTo(x + w, y + h, x + w - r, y + h)
    .lineTo(x + r, y + h)
    .quadraticCurveTo(x, y + h, x, y + h - r)
    .lineTo(x, y + r)
    .quadraticCurveTo(x, y, x + r, y)
    .closePath();
}

function formatValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'Yes' : '';
  return String(v);
}

module.exports = { buildInspectionPdf };
