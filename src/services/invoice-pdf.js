const PDFDocument = require('pdfkit');
const path = require('path');
const fs   = require('fs');

const LOGO_PATH = process.env.COMPANY_LOGO_PATH
  || path.join(__dirname, '../../public/assets/logo.png');

const CO = {
  name:    process.env.COMPANY_NAME    || 'KARV ADTECH LLP',
  gst:     process.env.COMPANY_GST     || '',
  pan:     process.env.COMPANY_PAN     || '',
  address: process.env.COMPANY_ADDRESS || 'India',
  email:   process.env.COMPANY_EMAIL   || process.env.GMAIL_USER || '',
  phone:   process.env.COMPANY_PHONE   || '',
};

const ORANGE    = '#ff5c00';
const DARK      = '#111827';
const MUTED     = '#6b7280';
const LINE      = '#e5e7eb';
const FAINT     = '#f3f4f6';
const GREEN_FG  = '#16a34a';
const GREEN_BG  = '#dcfce7';
const BLUE_FG   = '#1d4ed8';
const BLUE_BG   = '#eff6ff';
const BODY_BG   = '#edecea';
const CARD_BG   = '#ffffff';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function rupee(n) {
  return `Rs.${parseFloat(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmt(d) {
  if (!d) return '—';
  const iso = (d instanceof Date) ? d.toISOString().slice(0,10) : String(d).slice(0,10);
  const [yr, m, day] = iso.split('-');
  return `${day} ${MONTHS[parseInt(m,10)-1]} ${yr}`;
}

// Fetch logo buffer from URL or local file
async function fetchLogoBuffer() {
  const logoUrl = process.env.COMPANY_LOGO_URL;
  if (logoUrl) {
    try {
      const res = await fetch(logoUrl);
      if (res.ok) return Buffer.from(await res.arrayBuffer());
    } catch {}
  }
  const logoPath = process.env.COMPANY_LOGO_PATH
    || path.join(__dirname, '../../public/assets/logo.png');
  if (fs.existsSync(logoPath)) {
    try { return fs.readFileSync(logoPath); } catch {}
  }
  return null;
}

/**
 * @param {object} campaign
 * @param {object} user
 * @param {string} invoiceNo
 * @param {object} [payment]  { razorpay_payment_id, method }
 */
async function generateInvoicePDF(campaign, user, invoiceNo, payment = {}) {
  const logoBuffer = await fetchLogoBuffer();
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 0 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end',  () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const PW = doc.page.width;   // 595.28
      const PH = doc.page.height;  // 841.89

      // Card insets
      const CX = 28, CY = 28;
      const CW = PW - CX * 2;   // card width
      const IL = CX + 32;        // inner left  (padding inside card)
      const IR = CX + CW - 32;   // inner right
      const IW = IR - IL;        // inner width

      // ── BODY BACKGROUND ──────────────────────────────────────────────────
      doc.rect(0, 0, PW, PH).fill(BODY_BG);

      // ── WHITE CARD (draw outline now; we'll know final height after content) ─
      // We draw card background first (full estimated height), content on top
      const CARD_H_EST = PH - CY * 2;
      doc.roundedRect(CX, CY, CW, CARD_H_EST, 10).fill(CARD_BG);
      // card border
      doc.roundedRect(CX, CY, CW, CARD_H_EST, 10)
        .strokeColor('#d1d5db').lineWidth(0.5).stroke();

      let y = CY; // running Y inside card

      // ── 1. HEADER ─────────────────────────────────────────────────────────
      // white bg (already drawn by card), just draw content
      const HDR_PAD = 26;
      const hdrContentY = y + HDR_PAD;

      // Logo icon box
      const iconX = IL, iconY = hdrContentY;
      doc.rect(iconX, iconY, 40, 40).fillAndStroke('#fff3ed', '#e5e7eb');
      if (logoBuffer) {
        try { doc.image(logoBuffer, iconX + 4, iconY + 4, { fit: [32, 32] }); } catch {}
      } else {
        // fallback: drawn screen icon
        doc.rect(iconX + 7, iconY + 9, 26, 17).strokeColor(ORANGE).lineWidth(1.5).stroke();
        doc.moveTo(iconX + 14, iconY + 26).lineTo(iconX + 14, iconY + 31).stroke();
        doc.moveTo(iconX + 26, iconY + 26).lineTo(iconX + 26, iconY + 31).stroke();
        doc.moveTo(iconX + 11, iconY + 31).lineTo(iconX + 29, iconY + 31).stroke();
        doc.save().opacity(0.7).rect(iconX + 12, iconY + 13, 8, 7).fill(ORANGE).restore();
      }

      // Company name + subtitle
      const brandX = iconX + 52;
      doc.fontSize(16).font('Helvetica-Bold').fillColor(DARK)
        .text(CO.name, brandX, hdrContentY + 3, { width: 200, lineBreak: false });
      doc.fontSize(9).font('Helvetica').fillColor(MUTED)
        .text('EXTRRAVENUE · DIGITAL OOH PLATFORM', brandX, hdrContentY + 24, { width: 200, lineBreak: false });

      // INVOICE + number (right side)
      doc.fontSize(30).font('Helvetica-Bold').fillColor(DARK)
        .text('INVOICE', IL, hdrContentY, { width: IW, align: 'right', lineBreak: false });
      doc.fontSize(11).font('Helvetica').fillColor(MUTED)
        .text(invoiceNo, IL, hdrContentY + 36, { width: IW, align: 'right', lineBreak: false });

      y = hdrContentY + 46 + HDR_PAD;

      // bottom border of header
      doc.moveTo(CX, y).lineTo(CX + CW, y).strokeColor(LINE).lineWidth(0.5).stroke();

      // ── 2. META BAR ──────────────────────────────────────────────────────
      const META_H  = 64;
      const cellW   = CW / 4;
      const period  = `${fmt(campaign.start_date)} – ${fmt(campaign.end_date)}`;
      const issueDate = fmt(new Date());

      // Compact period: "01 Oct – 31 Oct 2026" (drop start year if same year)
      const sISO = fmt(campaign.start_date), eISO = fmt(campaign.end_date);
      const sYear = sISO.slice(-4), eYear = eISO.slice(-4);
      const compactPeriod = sYear === eYear
        ? `${sISO.slice(0, -5)} – ${eISO}`   // "01 Oct – 31 Oct 2026"
        : period;

      const metaItems = [
        { label: 'ISSUE DATE',      value: issueDate,      badge: null },
        { label: 'DUE DATE',        value: 'Immediate',    badge: null },
        { label: 'STATUS',          value: null,           badge: { text: 'PAID', bg: GREEN_BG, fg: GREEN_FG } },
        { label: 'CAMPAIGN PERIOD', value: null,           badge: { text: compactPeriod, bg: BLUE_BG, fg: BLUE_FG } },
      ];

      metaItems.forEach(({ label, value, badge }, i) => {
        const cx = CX + i * cellW;
        const lx = cx + 20;

        // vertical divider
        if (i > 0) {
          doc.moveTo(cx, y).lineTo(cx, y + META_H).strokeColor(LINE).lineWidth(0.5).stroke();
        }

        // label
        doc.fontSize(8).font('Helvetica-Bold').fillColor(MUTED)
          .text(label, lx, y + 14, { width: cellW - 24, lineBreak: false });

        if (badge) {
          const maxBw = cellW - 24;
          doc.fontSize(8).font('Helvetica-Bold');
          const textW = Math.min(doc.widthOfString(badge.text), maxBw - 14);
          const bw    = Math.min(textW + 16, maxBw);
          doc.rect(lx, y + 29, bw, 18).fill(badge.bg);
          doc.fillColor(badge.fg)
            .text(badge.text, lx + 7, y + 33, { width: bw - 10, lineBreak: false });
        } else {
          doc.fontSize(13).font('Helvetica-Bold').fillColor(DARK)
            .text(value, lx, y + 30, { width: cellW - 24, lineBreak: false });
        }
      });

      y += META_H;
      doc.moveTo(CX, y).lineTo(CX + CW, y).strokeColor(LINE).lineWidth(0.5).stroke();

      // ── 3. ADDRESSES ────────────────────────────────────────────────────
      const addrW  = IW / 2 - 16;
      const col2X  = IL + IW / 2 + 8;
      let ay = y + 26;

      // FROM
      doc.fontSize(8).font('Helvetica-Bold').fillColor(ORANGE)
        .text('FROM', IL, ay, { lineBreak: false });
      doc.fontSize(14).font('Helvetica-Bold').fillColor(DARK)
        .text(CO.name, IL, ay + 14, { width: addrW, lineBreak: false });
      let fromY = ay + 34;
      const fromLines = [
        CO.address,
        [CO.email, CO.phone].filter(Boolean).join('  ·  '),
        CO.gst ? `GST:  ${CO.gst}` : null,
        CO.pan ? `PAN:  ${CO.pan}` : null,
      ].filter(Boolean);
      fromLines.forEach(l => {
        doc.fontSize(10).font('Helvetica').fillColor(MUTED)
          .text(l, IL, fromY, { width: addrW, lineBreak: true });
        fromY = doc.y + 2;
      });

      // BILLED TO
      const clientName = user.business_name
        || `${user.first_name || ''} ${user.last_name || ''}`.trim()
        || user.email;
      doc.fontSize(8).font('Helvetica-Bold').fillColor(ORANGE)
        .text('BILLED TO', col2X, ay, { lineBreak: false });
      doc.fontSize(14).font('Helvetica-Bold').fillColor(DARK)
        .text(clientName, col2X, ay + 14, { width: addrW, lineBreak: false });
      let toY = ay + 34;
      const toLines = [
        [user.email, user.mobile].filter(Boolean).join('  ·  '),
        user.city,
        user.gst_number ? `GST:  ${user.gst_number}` : null,
      ].filter(Boolean);
      toLines.forEach(l => {
        doc.fontSize(10).font('Helvetica').fillColor(MUTED)
          .text(l, col2X, toY, { width: addrW, lineBreak: true });
        toY = doc.y + 2;
      });

      y = Math.max(fromY, toY) + 22;
      doc.moveTo(CX, y).lineTo(CX + CW, y).strokeColor(LINE).lineWidth(0.5).stroke();
      y += 16;

      // ── 4. TABLE ─────────────────────────────────────────────────────────
      const COL_NUM  = { x: IL,          w: 26 };
      const COL_DESC = { x: IL + 28,     w: IW - 28 - 110 - 100 };
      const COL_SCR  = { x: IR - 206,    w: 100 };
      const COL_AMT  = { x: IR - 100,    w: 100 };

      // Table header row
      doc.fontSize(8.5).font('Helvetica-Bold').fillColor(MUTED)
        .text('#',           COL_NUM.x,  y, { width: COL_NUM.w,  lineBreak: false })
        .text('DESCRIPTION', COL_DESC.x, y, { width: COL_DESC.w, lineBreak: false })
        .text('SCREENS',     COL_SCR.x,  y, { width: COL_SCR.w,  align: 'right', lineBreak: false })
        .text('AMOUNT',      COL_AMT.x,  y, { width: COL_AMT.w,  align: 'right', lineBreak: false });
      y += 14;
      // thick underline
      doc.moveTo(IL, y).lineTo(IR, y).strokeColor(DARK).lineWidth(1.8).stroke();
      y += 14;

      // Row — draw # / screens / amount first (same y), then description block
      const slotSec   = campaign.slot_duration_sec || 15;
      const startD    = campaign.start_date instanceof Date ? campaign.start_date : new Date(campaign.start_date);
      const endD      = campaign.end_date   instanceof Date ? campaign.end_date   : new Date(campaign.end_date);
      const durationDays = Math.round((endD - startD) / (1000 * 60 * 60 * 24)) + 1;
      const metaLine  = `${slotSec}-sec slot · Standard package · ${durationDays} days`;
      const codeLine  = `${campaign.campaign_code || ''}  ·  ${fmt(campaign.start_date)} – ${fmt(campaign.end_date)}`;

      const rowStartY = y;
      // # column
      doc.fontSize(11).font('Helvetica').fillColor(MUTED)
        .text('01', COL_NUM.x, rowStartY, { width: COL_NUM.w, lineBreak: false });
      // screens column
      doc.fontSize(11).font('Helvetica').fillColor(MUTED)
        .text('--', COL_SCR.x, rowStartY, { width: COL_SCR.w, align: 'right', lineBreak: false });
      // amount column
      doc.fontSize(12).font('Helvetica-Bold').fillColor(DARK)
        .text(rupee(campaign.amount_base), COL_AMT.x, rowStartY, { width: COL_AMT.w, align: 'right', lineBreak: false });

      // description block — allow wrapping, track cursor after
      doc.fontSize(12).font('Helvetica-Bold').fillColor(DARK)
        .text(campaign.title || campaign.campaign_code, COL_DESC.x, rowStartY, { width: COL_DESC.w, lineBreak: true });
      const afterTitle = doc.y;
      doc.fontSize(9.5).font('Helvetica').fillColor(MUTED)
        .text(metaLine, COL_DESC.x, afterTitle + 2, { width: COL_DESC.w, lineBreak: false });
      doc.fontSize(9).font('Helvetica').fillColor(MUTED)
        .text(codeLine, COL_DESC.x, afterTitle + 16, { width: COL_DESC.w, lineBreak: false });

      y = afterTitle + 32;
      doc.moveTo(IL, y).lineTo(IR, y).strokeColor(LINE).lineWidth(0.5).stroke();
      y += 12;

      // ── 5. TOTALS ────────────────────────────────────────────────────────
      const TOT_W = 290;
      const TOT_X = IR - TOT_W;

      const ROW_H = 30;

      function totLine(label, value, valColor = DARK, bold = false) {
        const font = bold ? 'Helvetica-Bold' : 'Helvetica';
        const textY = y + 9;
        doc.fontSize(11).font('Helvetica').fillColor(MUTED)
          .text(label, TOT_X, textY, { width: TOT_W * 0.6, lineBreak: false });
        doc.font(font).fillColor(valColor)
          .text(value, TOT_X, textY, { width: TOT_W, align: 'right', lineBreak: false });
        y += ROW_H;
        doc.moveTo(TOT_X, y).lineTo(IR, y).strokeColor(LINE).lineWidth(0.5).stroke();
      }

      if (campaign.coupon_code && parseFloat(campaign.discount_amount) > 0) {
        totLine('Subtotal (before discount)',
          rupee(parseFloat(campaign.amount_base) + parseFloat(campaign.discount_amount)));
        totLine(`Coupon ${campaign.coupon_code} (-${Math.round(parseFloat(campaign.discount_amount) / (parseFloat(campaign.amount_base) + parseFloat(campaign.discount_amount)) * 100)}%)`,
          `-${rupee(campaign.discount_amount)}`, GREEN_FG);
      }
      totLine('Base Amount', rupee(campaign.amount_base));
      totLine('GST @ 18%',   rupee(campaign.amount_gst));

      // Grand total — inline (no box), large orange amount
      y += 10;
      doc.fontSize(13).font('Helvetica-Bold').fillColor(DARK)
        .text('Total Paid', TOT_X, y + 6, { width: TOT_W * 0.5, lineBreak: false });
      doc.fontSize(22).font('Helvetica-Bold').fillColor(ORANGE)
        .text(rupee(campaign.amount_total), TOT_X, y, { width: TOT_W, align: 'right', lineBreak: false });
      y += 38;

      // ── 6. NOTE BOX ──────────────────────────────────────────────────────
      y += 10;
      const noteText = 'Your campaign is now under review. Once approved, it will go live automatically on the scheduled start date. You will receive a confirmation email and WhatsApp message when it is approved.';
      const noteH = 54;
      const noteInnerW = IW - 28;
      doc.rect(IL, y, IW, noteH).fill(FAINT);
      doc.rect(IL, y, 3, noteH).fill(ORANGE);
      // measure bold prefix width to continue inline
      doc.fontSize(9.5).font('Helvetica-Bold');
      const boldPfxW = doc.widthOfString('Campaign Status: ');
      doc.fillColor(DARK)
        .text('Campaign Status: ', IL + 14, y + 11, { lineBreak: false });
      doc.font('Helvetica').fillColor(MUTED)
        .text(noteText, IL + 14 + boldPfxW, y + 11, { width: noteInnerW - boldPfxW, lineBreak: true });
      y += noteH + 20;

      // ── 7. FOOTER ────────────────────────────────────────────────────────
      doc.moveTo(CX, y).lineTo(CX + CW, y).strokeColor(LINE).lineWidth(0.5).stroke();
      y += 14;

      // Left side
      doc.fontSize(9.5).font('Helvetica-Bold').fillColor(DARK)
        .text(`${CO.name}`, IL, y, { lineBreak: false });
      doc.fontSize(9.5).font('Helvetica').fillColor(MUTED)
        .text(' · SignageCMS', IL + doc.widthOfString(CO.name, { fontSize: 9.5 }) + 2, y, { lineBreak: false });

      doc.fontSize(9).font('Helvetica').fillColor(MUTED)
        .text('This is a computer-generated invoice and does not require a signature.', IL, y + 14, { lineBreak: false });

      // GSTIN chip
      if (CO.gst) {
        const chipText = `GSTIN:  ${CO.gst}`;
        const chipW = doc.widthOfString(chipText, { fontSize: 8.5 }) + 16;
        doc.rect(IL, y + 30, chipW, 16).fill(FAINT);
        doc.fontSize(8.5).font('Helvetica').fillColor(DARK)
          .text(chipText, IL + 8, y + 33, { lineBreak: false });
      }

      // Right side
      const payRef = payment.razorpay_payment_id || '';
      const payMethod = payment.method || 'Razorpay';
      const rightLines = [
        payRef ? `Payment Reference: ${payRef}` : null,
        payRef ? `Method: ${payMethod}` : null,
        'https://extrravenue.com',
      ].filter(Boolean);

      let ry = y;
      rightLines.forEach(l => {
        doc.fontSize(9).font('Helvetica').fillColor(MUTED)
          .text(l, IL, ry, { width: IW, align: 'right', lineBreak: false });
        ry += 14;
      });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function generatePoPPDF(userName, dateStr, rows) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end',  () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = doc.page.width - 80;

      doc.rect(40, 40, W, 56).fill(DARK);
      const logoExists = fs.existsSync(LOGO_PATH);
      if (logoExists) {
        try { doc.image(LOGO_PATH, 48, 48, { fit: [44, 44] }); } catch (_) {}
      }
      const tX = logoExists ? 102 : 58;
      doc.fontSize(16).font('Helvetica-Bold').fillColor('#ffffff').text(CO.name, tX, 52);
      doc.fontSize(9).font('Helvetica').fillColor('#aaaaaa').text('Proof of Play Report', tX, 72);

      doc.fontSize(20).font('Helvetica-Bold').fillColor(DARK).text('Daily PoP Report', 40, 114);
      doc.fontSize(10).font('Helvetica').fillColor(MUTED).text(`Date: ${dateStr}   •   Advertiser: ${userName}`, 40, 140);

      const divY = 162;
      doc.moveTo(40, divY).lineTo(40 + W, divY).strokeColor(LINE).lineWidth(1).stroke();

      const tblY = divY + 12;
      doc.rect(40, tblY, W, 26).fill(DARK);
      ['Campaign', 'Code', 'Plays Today', 'Screens'].forEach((h, i) => {
        const xs = [50, 210, 330, 450];
        doc.fontSize(8).font('Helvetica-Bold').fillColor('#ffffff').text(h, xs[i], tblY + 9);
      });

      let rowY = tblY + 26;
      const totalPlays = rows.reduce((s, r) => s + parseInt(r.plays || 0), 0);
      rows.forEach((r, idx) => {
        doc.rect(40, rowY, W, 24).fill(idx % 2 === 0 ? FAINT : '#ffffff');
        doc.fontSize(9).font('Helvetica').fillColor(DARK)
          .text(r.title || r.campaign_code, 50, rowY + 7, { width: 155 })
          .text(r.campaign_code, 210, rowY + 7, { width: 110 })
          .text(String(r.plays || 0), 330, rowY + 7, { width: 110 })
          .text(String(r.screens || 0), 450, rowY + 7, { width: 80 });
        rowY += 24;
      });

      rowY += 4;
      doc.moveTo(40, rowY).lineTo(40 + W, rowY).strokeColor(LINE).lineWidth(1).stroke();
      rowY += 6;
      doc.fontSize(10).font('Helvetica-Bold').fillColor(DARK).text('Total Plays Today', 50, rowY);
      doc.fillColor(ORANGE).text(String(totalPlays), 330, rowY);

      doc.end();
    } catch (err) { reject(err); }
  });
}

module.exports = { generateInvoicePDF, generatePoPPDF };
