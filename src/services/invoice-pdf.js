const PDFDocument = require('pdfkit');

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

function rupee(n) { return `Rs. ${parseFloat(n || 0).toFixed(2)}`; }
function fmt(d)   { return d ? String(d).slice(0, 10) : '—'; }

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
      doc.circle(66, 78, 14).fill(ORANGE);
      doc.fontSize(9).fillColor('#ffffff').text('▶', 61, 73);
      doc.fontSize(16).font('Helvetica-Bold').fillColor('#ffffff').text('SignageCMS', 88, 62);
      doc.fontSize(9).font('Helvetica').fillColor('#aaaaaa').text('Digital Out-of-Home Platform', 88, 82);

      // ── Invoice label + number ────────────────────────────────────────────
      doc.moveDown(0.5);
      const topY = 124;
      doc.fontSize(22).font('Helvetica-Bold').fillColor(DARK).text('INVOICE', 50, topY);
      doc.fontSize(10).font('Helvetica').fillColor(MUTED).text(invoiceNo, 50, topY + 28);

      // right side: date + status
      const issueDate = fmt(new Date());
      doc.fontSize(9).fillColor(MUTED).text('Issue Date', 380, topY, { width: 165, align: 'right' });
      doc.fontSize(11).font('Helvetica-Bold').fillColor(DARK).text(issueDate, 380, topY + 14, { width: 165, align: 'right' });
      doc.fontSize(9).font('Helvetica').fillColor(MUTED).text('Status', 380, topY + 34, { width: 165, align: 'right' });
      doc.rect(doc.page.width - 50 - 60, topY + 48, 60, 18).fill('#dcfce7');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#16a34a').text('PAID', doc.page.width - 50 - 60, topY + 52, { width: 60, align: 'center' });

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
      doc.rect(50, tblY, W, 28).fill(DARK);
      ['Description', 'Campaign Code', 'Period', 'Amount'].forEach((h, i) => {
        const xs = [60, 210, 330, 480]; const ws = [140, 110, 140, 65];
        doc.fontSize(8).font('Helvetica-Bold').fillColor('#ffffff').text(h, xs[i], tblY + 9, { width: ws[i] });
      });

      // row
      const rowY = tblY + 28;
      const period = `${fmt(campaign.start_date)} – ${fmt(campaign.end_date)}`;
      doc.rect(50, rowY, W, 26).fill(LIGHT);
      doc.fontSize(9).font('Helvetica').fillColor(DARK)
        .text(campaign.title || campaign.campaign_code, 60, rowY + 7, { width: 140 })
        .text(campaign.campaign_code || '—', 210, rowY + 7, { width: 110 })
        .text(period, 330, rowY + 7, { width: 140 })
        .text(rupee(campaign.amount_base), 480, rowY + 7, { width: 65 });

      // ── Totals block ──────────────────────────────────────────────────────
      let sumY = rowY + 40;
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
      const ftY = doc.page.height - 80;
      doc.rect(50, ftY, W, 1).fill(LINE);
      doc.fontSize(8).font('Helvetica').fillColor(MUTED)
        .text(`${CO.name} · This is a computer-generated invoice and does not require a signature.`, 50, ftY + 10, { width: W, align: 'center' });
      if (CO.gst) {
        doc.text(`GSTIN: ${CO.gst}`, 50, ftY + 24, { width: W, align: 'center' });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateInvoicePDF };
