const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');
const { authenticate, requireAdmin } = require('../middleware/auth');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// GET /api/blog — public: list published posts
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, slug, title, description, category, hero_image_url, read_time, language, published_at
       FROM blog_posts WHERE is_published = true ORDER BY published_at DESC LIMIT 20`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[Blog] list error:', err.message);
    res.json([]);
  }
});

// GET /api/blog/drafts — admin: list all posts including drafts
router.get('/drafts', authenticate, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, slug, title, description, category, hero_image_url, read_time, language, is_published, created_at, published_at
       FROM blog_posts ORDER BY created_at DESC LIMIT 50`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[Blog] drafts error:', err.message);
    res.status(500).json({ error: 'Failed to load drafts' });
  }
});

// GET /api/blog/:slug — public: get single post content
router.get('/:slug', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM blog_posts WHERE slug = $1 AND is_published = true`,
      [req.params.slug]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[Blog] get error:', err.message);
    res.status(500).json({ error: 'Failed to load post' });
  }
});

// POST /api/blog/generate — admin only: generate a new article via Claude
router.post('/generate', authenticate, requireAdmin, async (req, res) => {
  const { topic, language = 'hi' } = req.body;

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const now = new Date();
  const monthYear = now.toLocaleString('en-IN', { month: 'long', year: 'numeric' });

  const systemPrompt = `You are a content writer for extrravenue — a digital signage SaaS platform for small businesses in India (restaurants, gyms, salons, clinics).
Platform plans:
- Trial: FREE (1 screen, basic)
- Starter: ₹1,499/month (1 screen)
- Complete: ₹3,499/month (3 screens, FB+IG sync)
- Growth: ₹5,999/month (5 screens, priority placement + QR leads)

Website: signagecrm-production.up.railway.app
Blog URL pattern: /blog/[slug].html

Write engaging, informative blog articles in Hinglish (mix of Hindi and English — casual, friendly tone). Target audience: Indian small business owners.

Always return a valid JSON object with these exact keys:
- title: string (article headline, 60-80 chars)
- slug: string (URL-friendly, kebab-case, no .html)
- description: string (meta description, 150-160 chars)
- category: string (one of: "Platform News", "How It Works", "Case Study", "Tips & Tricks", "Industry Insights")
- read_time: string (e.g. "4 min read")
- hero_image_url: string (use an Unsplash URL like https://images.unsplash.com/photo-XXXXXXX?w=1200&h=525&fit=crop&q=80)
- content_html: string (full article HTML — article body only, no <html>/<head>/<body> tags; use <h2>, <p>, <ul>, <div class="pull-quote"><p>...</p></div>, <div class="cta-inline"><h3>...</h3><p>...</p><a href="https://signagecrm-production.up.railway.app">Account Banao</a></div>)`;

  const userPrompt = topic
    ? `Write a blog article about: ${topic}. Make it relevant for ${monthYear}.`
    : `Write a blog article for ${monthYear} covering one of these angles:
    - A seasonal business tip (festival season promotion, new year offers, etc.)
    - A digital signage industry update or insight
    - How a specific business type (salon, clinic, restaurant) can use extrravenue better
    - A feature spotlight or use case
    Choose the most relevant and timely angle. Make it practical and actionable.`;

  try {
    const message = await client.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const fullText = message.content.filter(b => b.type === 'text').map(b => b.text).join('');

    // Parse JSON from response (strip markdown fences if any)
    const jsonStr = fullText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    const article = JSON.parse(jsonStr);

    // Validate required fields
    const required = ['title', 'slug', 'description', 'category', 'content_html'];
    for (const field of required) {
      if (!article[field]) throw new Error(`Missing field: ${field}`);
    }

    // Ensure slug is unique
    let slug = article.slug.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').toLowerCase();
    const existing = await pool.query('SELECT slug FROM blog_posts WHERE slug = $1', [slug]);
    if (existing.rows.length) {
      slug = slug + '-' + Date.now().toString(36);
    }

    // Save as draft
    const insert = await pool.query(
      `INSERT INTO blog_posts (slug, title, description, category, content_html, hero_image_url, read_time, language, is_published)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false) RETURNING id, slug`,
      [
        slug,
        article.title,
        article.description,
        article.category || 'Platform News',
        article.content_html,
        article.hero_image_url || null,
        article.read_time || '4 min read',
        language,
      ]
    );

    res.json({ ok: true, id: insert.rows[0].id, slug: insert.rows[0].slug, title: article.title, preview: article.description });
  } catch (err) {
    console.error('[Blog] generate error:', err.message);
    res.status(500).json({ error: 'Generation failed: ' + err.message });
  }
});

// POST /api/blog/:id/publish — admin only: publish a draft
router.post('/:id/publish', authenticate, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE blog_posts SET is_published = true, published_at = NOW() WHERE id = $1 RETURNING id, slug, title`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Post not found' });
    res.json({ ok: true, ...result.rows[0] });
  } catch (err) {
    console.error('[Blog] publish error:', err.message);
    res.status(500).json({ error: 'Publish failed' });
  }
});

// DELETE /api/blog/:id — admin only: delete a post
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM blog_posts WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Blog] delete error:', err.message);
    res.status(500).json({ error: 'Delete failed' });
  }
});

module.exports = router;
