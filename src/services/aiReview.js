const { query } = require('../db');

const REVIEW_PROMPT = `You are a content moderation system for a digital outdoor advertising (OOH/DOOH) platform in India. Analyze this advertisement image and decide if it is appropriate for display on public digital screens (malls, markets, roads, airports, offices).

REJECT if the content contains or promotes:
- Nudity, pornography, or sexually explicit acts
- Underwear / innerwear / lingerie shown suggestively
- Condoms or sexual health products shown explicitly
- Tobacco, pan masala, gutka, cigarettes, bidi, hookah
- Alcohol, liquor, beer, wine
- Political party / candidate promotion or electoral influence / propaganda
- Graphic violence, gore, or disturbing imagery
- Illegal drugs or narcotic substances
- Gambling, betting, online gaming (real money)

APPROVE if it is a normal advertisement for:
- Food, beverages (non-alcoholic), restaurants, cafes
- Consumer electronics, appliances, gadgets
- Clothing, fashion, accessories (non-explicit)
- Real estate, home decor, furniture
- Education, coaching institutes, skills training
- Healthcare, hospitals, pharmacies, wellness (general)
- Events, movies, concerts, entertainment (family-friendly)
- Vehicles, automobile services
- Finance, banking, insurance, investments
- Retail, shopping, e-commerce
- Travel, hotels, tourism
- Brand awareness, corporate identity

Respond ONLY with a valid JSON object (no markdown code blocks):
{"decision":"approved","confidence":95,"reason":"Normal food product advertisement — clearly a restaurant ad","flags":[]}

decision must be exactly: "approved", "rejected", or "pending"
confidence is 0-100
reason is a brief 1-sentence explanation
flags is an array of policy violations found (empty if approved)`;

async function reviewImage(imageUrl) {
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Fetch image
    const resp = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`Image fetch failed: ${resp.status}`);
    const buffer = await resp.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const contentType = resp.headers.get('content-type') || 'image/jpeg';

    const supported = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    const mediaType = supported.includes(contentType) ? contentType : 'image/jpeg';

    const result = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: REVIEW_PROMPT }
        ]
      }]
    });

    const text = result.content[0].text.trim();
    // Strip markdown if present
    const jsonStr = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
    return JSON.parse(jsonStr);
  } catch (err) {
    console.error('[AI Review] Image review error:', err.message);
    return { decision: 'pending', confidence: 0, reason: `AI review unavailable: ${err.message}`, flags: [] };
  }
}

async function reviewCampaign(campaignId) {
  if (!process.env.ANTHROPIC_API_KEY) {
    // No API key — leave as pending for manual review
    await query(
      `UPDATE campaigns SET ai_review_status='pending', ai_review_notes='AI review not configured — manual review required'
       WHERE id=$1`,
      [campaignId]
    );
    return;
  }

  try {
    const result = await query(
      `SELECT c.id, ct.file_url, ct.type AS content_type
       FROM campaigns c JOIN content ct ON ct.id = c.content_id
       WHERE c.id = $1 AND c.status = 'pending_approval'`,
      [campaignId]
    );
    if (!result.rows.length) return;

    const { file_url, content_type } = result.rows[0];
    let review;

    if (content_type === 'video') {
      review = { decision: 'pending', confidence: 0, reason: 'Video content requires manual review by admin', flags: [] };
    } else {
      review = await reviewImage(file_url);
    }

    const { decision, reason, flags } = review;
    const notes = `${reason}${flags?.length ? ` [Flags: ${flags.join(', ')}]` : ''}`;

    if (decision === 'approved' && review.confidence >= 80) {
      await query(
        `UPDATE campaigns SET status='approved', ai_review_status='approved', ai_review_notes=$1,
         approved_at=NOW(), updated_at=NOW() WHERE id=$2 AND status='pending_approval'`,
        [notes, campaignId]
      );
      console.log(`[AI Review] Auto-approved campaign ${campaignId}: ${reason}`);
    } else if (decision === 'rejected' && review.confidence >= 75) {
      await query(
        `UPDATE campaigns SET status='rejected', ai_review_status='rejected', ai_review_notes=$1,
         rejection_reason=$1, updated_at=NOW() WHERE id=$2 AND status='pending_approval'`,
        [notes, campaignId]
      );
      console.log(`[AI Review] Auto-rejected campaign ${campaignId}: ${reason}`);
    } else {
      // Low confidence or pending — let admin decide, just add notes
      await query(
        `UPDATE campaigns SET ai_review_status='pending', ai_review_notes=$1, updated_at=NOW()
         WHERE id=$2`,
        [notes, campaignId]
      );
      console.log(`[AI Review] Flagged for manual review ${campaignId}: ${reason}`);
    }
  } catch (err) {
    console.error('[AI Review] Campaign review failed:', err.message);
    await query(
      `UPDATE campaigns SET ai_review_status='pending', ai_review_notes=$1 WHERE id=$2`,
      [`Review error: ${err.message}`, campaignId]
    ).catch(() => {});
  }
}

module.exports = { reviewCampaign };
