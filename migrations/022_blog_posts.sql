CREATE TABLE IF NOT EXISTS blog_posts (
  id          SERIAL PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'Platform News',
  content_html TEXT NOT NULL,
  hero_image_url TEXT,
  read_time   TEXT DEFAULT '4 min read',
  language    TEXT DEFAULT 'hi',
  is_published BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  published_at TIMESTAMPTZ
);
