-- Filler screen assignments: empty = plays on all screens
CREATE TABLE IF NOT EXISTS filler_screen_assignments (
  filler_id  UUID REFERENCES filler_content(id) ON DELETE CASCADE,
  screen_id  UUID REFERENCES screens(id)        ON DELETE CASCADE,
  PRIMARY KEY (filler_id, screen_id)
);
