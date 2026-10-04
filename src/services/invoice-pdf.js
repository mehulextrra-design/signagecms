const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

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

const ORANGE = '#ff5c00';
const DARK   = '#1e1e1e';
const MUTED  = '#787068';
const LIGHT  = '#f7f4ef';
const LINE   = '#e0dbd3';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function rupee(n) { return `Rs.${parseFloat(n||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})}`; }
function fmt(d) {
  if (!d) return '—';
  // pg DATE columns arrive as Date objects; convert safely to ISO first
  const iso = (d instanceof Date) ? d.toISOString().slice(0,10) : String(d).slice(0,10);
  const [y, m, day] = iso.split('-');
  return `${day} ${MONTHS[parseInt(m,10)-1]} ${y}`;
}

/**
 * Generate an invoice PDF buffer for a campaign.
 * @param {object} campaign  — row from DB (all columns needed)
 * @param {object} user      — row from DB
 * @param {string} invoiceNo — e.g. "INV-2024-00042"
 * @returns {Promise<Buffer>}
 */
function generateInvoicePDF(campaign, user, invoiceNo) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = doc.page.width - 100; // usable width (50 margin each side)

      // ── Header bar ────────────────────────────────────────────────────────
      doc.rect(50, 50, W, 56).fill(DARK);

      const logoExists = fs.existsSync(LOGO_PATH);
      if (logoExists) {
        // Fit logo inside a 44×44 box at the left of the header
        try {
          doc.image(LOGO_PATH, 58, 58, { fit: [44, 44], align: 'center', valign: 'center' });
        } catch (_) { /* logo load failed — fall through to text */ }
      }

      const textX = logoExists ? 112 : 68;
      doc.fontSize(16).font('Helvetica-Bold').fillColor('#ffffff').text(CO.name, textX, 62);
      doc.fontSize(9).font('Helvetica').fillColor('#aaaaaa').text('Digital Out-of-Home Platform', textX, 82);

      if (!logoExists) {
        // Fallback dot indicator
        doc.circle(58, 78, 10).fill(ORANGE);
      }

      // ── Invoice label + number ────────────────────────────────────────────
      const topY = 124;
      doc.fontSize(26).font('Helvetica-Bold').fillColor(DARK).text('INVOICE', 50, topY);
      doc.fontSize(10).font('Helvetica').fillColor(MUTED).text(invoiceNo, 50, topY + 32);

      // right side: date + status
      const issueDate = fmt(new Date());
      doc.fontSize(8).font('Helvetica').fillColor(MUTED).text('Issue Date', 380, topY, { width: 165, align: 'right' });
      doc.fontSize(12).font('Helvetica-Bold').fillColor(DARK).text(issueDate, 380, topY + 13, { width: 165, align: 'right' });
      doc.fontSize(8).font('Helvetica').fillColor(MUTED).text('Status', 380, topY + 34, { width: 165, align: 'right' });
      doc.rect(doc.page.width - 50 - 50, topY + 47, 50, 16).fill('#dcfce7');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#16a34a').text('PAID', doc.page.width - 50 - 50, topY + 51, { width: 50, align: 'center' });

      // ── Divider ───────────────────────────────────────────────────────────
      const divY = topY + 74;
      doc.moveTo(50, divY).lineTo(50 + W, divY).strokeColor(LINE).lineWidth(1).stroke();

      // ── From / To columns ─────────────────────────────────────────────────
      const colY = divY + 16;
      const col2 = 300;

      doc.fontSize(8).font('Helvetica-Bold').fillColor(ORANGE).text('FROM', 50, colY);
      doc.fontSize(11).font('Helvetica-Bold').fillColor(DARK).text(CO.name, 50, colY + 14);
      let fromY = colY + 30;
      const fromLines = [CO.address, CO.phone, CO.email, CO.gst ? `GST: ${CO.gst}` : null, CO.pan ? `PAN: ${CO.pan}` : null].filter(Boolean);
      fromLines.forEach(l => { doc.fontSize(9).font('Helvetica').fillColor(MUTED).text(l, 50, fromY); fromY += 14; });

      doc.fontSize(8).font('Helvetica-Bold').fillColor(ORANGE).text('BILLED TO', col2, colY);
      const clientName = user.business_name || `${user.first_name || ''} ${user.last_name || ''}`.trim() || user.email;
      doc.fontSize(11).font('Helvetica-Bold').fillColor(DARK).text(clientName, col2, colY + 14);
      let toY = colY + 30;
      const toLines = [user.email, user.mobile, user.city, user.gst_number ? `GST: ${user.gst_number}` : null].filter(Boolean);
      toLines.forEach(l => { doc.fontSize(9).font('Helvetica').fillColor(MUTED).text(l, col2, toY); toY += 14; });

      // ── Campaign details table ─────────────────────────────────────────────
      const tblY = Math.max(fromY, toY) + 24;
      doc.rect(50, tblY, W, 24).fill(DARK);
      const hdrs = [['#', 36, 20], ['Description', 88, 260], ['Period', 350, 110], ['Amount', 462, 83]];
      hdrs.forEach(([h, x, w]) => doc.fontSize(8).font('Helvetica-Bold').fillColor('#ffffff').text(h, x, tblY + 7, { width: w }));

      // row — description includes campaign code as sub-line
      const rowY = tblY + 24;
      const period = `${fmt(campaign.start_date)} – ${fmt(campaign.end_date)}`;
      const rowH = 40;
      doc.rect(50, rowY, W, rowH).fill(LIGHT);
      // #
      doc.fontSize(9).font('Helvetica').fillColor(MUTED).text('01', 60, rowY + 8, { width: 20 });
      // description + code
      doc.fontSize(9).font('Helvetica-Bold').fillColor(DARK).text(campaign.title || campaign.campaign_code, 88, rowY + 7, { width: 255 });
      doc.fontSize(8).font('Helvetica').fillColor(MUTED).text(campaign.campaign_code || '', 88, rowY + 22, { width: 255 });
      // period
      doc.fontSize(9).font('Helvetica').fillColor(DARK).text(period, 350, rowY + 14, { width: 106 });
      // amount
      doc.fontSize(9).font('Helvetica-Bold').fillColor(DARK).text(rupee(campaign.amount_base), 462, rowY + 14, { width: 83, align: 'right' });

      // ── Totals block ──────────────────────────────────────────────────────
      let sumY = rowY + rowH + 12;
      const sumX = 370;
      const sumW = W - (sumX - 50);

      function sumRow(label, value, bold = false, color = DARK) {
        doc.moveTo(sumX, sumY).lineTo(50 + W, sumY).strokeColor(LINE).lineWidth(0.5).stroke();
        doc.fontSize(9)
          .font(bold ? 'Helvetica-Bold' : 'Helvetica')
          .fillColor(MUTED).text(label, sumX, sumY + 6, { width: sumW * 0.55 })
          .fillColor(color).text(value, sumX + sumW * 0.55, sumY + 6, { width: sumW * 0.45, align: 'right' });
        sumY += 22;
      }

      if (campaign.coupon_code && parseFloat(campaign.discount_amount) > 0) {
        sumRow(`Subtotal`, rupee(parseFloat(campaign.amount_base) + parseFloat(campaign.discount_amount)));
        sumRow(`Coupon (${campaign.coupon_code})`, `−${rupee(campaign.discount_amount)}`);
      }
      sumRow('Base Amount', rupee(campaign.amount_base));
      sumRow('GST (18%)', rupee(campaign.amount_gst));
      sumRow('Total Paid', rupee(campaign.amount_total), true, ORANGE);

      // ── Footer ────────────────────────────────────────────────────────────
      const ftY = doc.page.height - 72;
      doc.rect(50, ftY, W, 0.5).fill(LINE);
      // left side
      doc.fontSize(8).font('Helvetica-Bold').fillColor(DARK)
        .text(CO.name, 50, ftY + 10, { width: W / 2 });
      doc.fontSize(7.5).font('Helvetica').fillColor(MUTED)
        .text('This is a computer-generated invoice and does not require a signature.', 50, ftY + 22, { width: W / 2 });
      if (CO.gst) {
        doc.fontSize(7.5).fillColor(MUTED)
          .text(`GSTIN: ${CO.gst}`, 50, ftY + 34, { width: W / 2 });
      }
      // right side
      doc.fontSize(7.5).font('Helvetica').fillColor(MUTED)
        .text('signagecrm-production.up.railway.app', 50 + W / 2, ftY + 22, { width: W / 2, align: 'right' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Generate a daily Proof-of-Play report PDF.
 * @param {string} userName
 * @param {string} dateStr  e.g. "2024-01-15"
 * @param {Array}  rows     [{campaign_code, title, plays, screens}]
 * @returns {Promise<Buffer>}
 */
function generatePoPPDF(userName, dateStr, rows) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = doc.page.width - 100;

      // Header
      doc.rect(50, 50, W, 56).fill(DARK);
      const logoExists = fs.existsSync(LOGO_PATH);
      if (logoExists) {
        try { doc.image(LOGO_PATH, 58, 58, { fit: [44, 44] }); } catch (_) {}
      }
      const tX = logoExists ? 112 : 68;
      doc.fontSize(16).font('Helvetica-Bold').fillColor('#ffffff').text(CO.name, tX, 62);
      doc.fontSize(9).font('Helvetica').fillColor('#aaaaaa').text('Proof of Play Report', tX, 82);

      // Title
      doc.fontSize(20).font('Helvetica-Bold').fillColor(DARK).text('Daily PoP Report', 50, 124);
      doc.fontSize(10).font('Helvetica').fillColor(MUTED).text(`Date: ${dateStr}   •   Advertiser: ${userName}`, 50, 150);

      const divY = 172;
      doc.moveTo(50, divY).lineTo(50 + W, divY).strokeColor(LINE).lineWidth(1).stroke();

      // Table header
      const tblY = divY + 12;
      doc.rect(50, tblY, W, 26).fill(DARK);
      ['Campaign', 'Code', 'Plays Today', 'Screens'].forEach((h, i) => {
        const xs = [60, 220, 340, 460];
        doc.fontSize(8).font('Helvetica-Bold').fillColor('#ffffff').text(h, xs[i], tblY + 9);
      });

      let rowY = tblY + 26;
      const totalPlays = rows.reduce((s, r) => s + parseInt(r.plays || 0), 0);
      rows.forEach((r, idx) => {
        doc.rect(50, rowY, W, 24).fill(idx % 2 === 0 ? LIGHT : '#ffffff');
        doc.fontSize(9).font('Helvetica').fillColor(DARK)
          .text(r.title || r.campaign_code, 60, rowY + 7, { width: 155 })
          .text(r.campaign_code, 220, rowY + 7, { width: 110 })
          .text(String(r.plays || 0), 340, rowY + 7, { width: 110 })
          .text(String(r.screens || 0), 460, rowY + 7, { width: 80 });
        rowY += 24;
      });

      // Total row
      rowY += 4;
      doc.moveTo(50, rowY).lineTo(50 + W, rowY).strokeColor(LINE).lineWidth(1).stroke();
      rowY += 6;
      doc.fontSize(10).font('Helvetica-Bold').fillColor(DARK).text('Total Plays Today', 60, rowY);
      doc.fillColor(ORANGE).text(String(totalPlays), 340, rowY);

      // Footer
      const ftY = doc.page.height - 80;
      doc.rect(50, ftY, W, 1).fill(LINE);
      doc.fontSize(8).font('Helvetica').fillColor(MUTED)
        .text(`${CO.name} · Automated Proof of Play · ${dateStr}`, 50, ftY + 10, { width: W, align: 'center' });

      doc.end();
    } catch (err) { reject(err); }
  });
}

module.exports = { generateInvoicePDF, generatePoPPDF };
