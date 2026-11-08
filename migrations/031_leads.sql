-- Lead capture: website inquiries + manually added prospects
CREATE TABLE leads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name   VARCHAR(200) NOT NULL,
  owner_name      VARCHAR(100),
  phone           VARCHAR(20)  NOT NULL,
  city            VARCHAR(100),
  venue_category  VARCHAR(50)  NOT NULL DEFAULT 'other',
  footfall_estimate INT,
  screen_count    INT          NOT NULL DEFAULT 0,
  source          VARCHAR(30)  NOT NULL DEFAULT 'website', -- website / walk_in / referral / field
  status          VARCHAR(30)  NOT NULL DEFAULT 'new',
  -- new → assigned → contacted → meeting_scheduled → meeting_done →
  -- site_visited → agreement_pending → agreement_signed →
  -- installation_pending → installation_done → live
  -- (dropped / site_rejected at any stage)
  assigned_to     UUID REFERENCES users(id) ON DELETE SET NULL,
  venue_partner_id UUID REFERENCES venue_partners(id) ON DELETE SET NULL,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Activity log: every status change, call note, photo, document
CREATE TABLE lead_activities (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id       UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  actor_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  activity_type VARCHAR(30) NOT NULL, -- note / status_change / call / photo / document
  old_status    VARCHAR(30),
  new_status    VARCHAR(30),
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_leads_status   ON leads(status);
CREATE INDEX idx_leads_city     ON leads(city);
CREATE INDEX idx_leads_assigned ON leads(assigned_to);
CREATE INDEX idx_lead_act_lead  ON lead_activities(lead_id);
