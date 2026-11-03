-- 024: Bulk insert 34 Ahmedabad screens (Vasna + Shyamal groups)
-- ER_005 to ER_038, all Society / 1080x1920 portrait
-- Idempotent: safe to run multiple times

DO $$
DECLARE
  vasna_group_id   UUID;
  shyamal_group_id UUID;
BEGIN

-- ── 1. SCREEN GROUPS (insert only if name doesn't exist) ─────────────────────

SELECT id INTO vasna_group_id FROM screen_groups WHERE name = 'Vasna' LIMIT 1;
IF vasna_group_id IS NULL THEN
  INSERT INTO screen_groups (name, description)
  VALUES ('Vasna', 'Vasna area — Zone A & B societies, Ahmedabad')
  RETURNING id INTO vasna_group_id;
END IF;

SELECT id INTO shyamal_group_id FROM screen_groups WHERE name = 'Shyamal' LIMIT 1;
IF shyamal_group_id IS NULL THEN
  INSERT INTO screen_groups (name, description)
  VALUES ('Shyamal', 'Shyamal area — Zone A societies, Ahmedabad')
  RETURNING id INTO shyamal_group_id;
END IF;

-- ── 2. INSERT SCREENS (ON CONFLICT skip duplicates) ───────────────────────────
-- width_px=1080, height_px=1920 (portrait), venue_type='Society', approx_footfall=100
-- daily_impressions=150, status=offline (will go online when player connects)

INSERT INTO screens (screen_code, name, location, city, zone, width_px, height_px, venue_type, approx_footfall, daily_impressions, status)
VALUES
  -- Vasna Zone A
  ('ER_005', 'Rajyash Rains_A',     'Vasna', 'Ahmedabad', 'A', 1080, 1920, 'Society', 100, 150, 'offline'),
  ('ER_006', 'Rajyash Rains_B',     'Vasna', 'Ahmedabad', 'A', 1080, 1920, 'Society', 100, 150, 'offline'),
  ('ER_007', 'Rajyash Rains_C',     'Vasna', 'Ahmedabad', 'A', 1080, 1920, 'Society', 100, 150, 'offline'),
  ('ER_008', 'Rajyash Rains_D',     'Vasna', 'Ahmedabad', 'A', 1080, 1920, 'Society', 100, 150, 'offline'),
  ('ER_009', 'Rajyash Rains_E',     'Vasna', 'Ahmedabad', 'A', 1080, 1920, 'Society', 100, 150, 'offline'),
  -- Vasna Zone B
  ('ER_010', 'Sahaj Solarium-2_A',  'Vasna', 'Ahmedabad', 'B', 1080, 1920, 'Society', 100, 150, 'offline'),
  ('ER_011', 'Sahaj Solarium-2_B',  'Vasna', 'Ahmedabad', 'B', 1080, 1920, 'Society', 100, 150, 'offline'),
  ('ER_012', 'Sahaj Solarium-2_C',  'Vasna', 'Ahmedabad', 'B', 1080, 1920, 'Society', 100, 150, 'offline'),
  ('ER_013', 'Sahaj Solarium-2_D',  'Vasna', 'Ahmedabad', 'B', 1080, 1920, 'Society', 100, 150, 'offline'),
  ('ER_014', 'Sahaj Solarium-2_E',  'Vasna', 'Ahmedabad', 'B', 1080, 1920, 'Society', 100, 150, 'offline'),
  ('ER_015', 'Sahaj Solarium-2_F',  'Vasna', 'Ahmedabad', 'B', 1080, 1920, 'Society', 100, 150, 'offline'),
  ('ER_016', 'Sahaj Solarium-1_G',  'Vasna', 'Ahmedabad', 'B', 1080, 1920, 'Society', 100, 150, 'offline'),
  ('ER_017', 'Sahaj Solarium-1_H',  'Vasna', 'Ahmedabad', 'B', 1080, 1920, 'Society', 100, 150, 'offline'),
  ('ER_018', 'Sahaj Solarium-1_I',  'Vasna', 'Ahmedabad', 'B', 1080, 1920, 'Society', 100, 150, 'offline'),
  ('ER_019', 'Silver Flora_A',      'Vasna', 'Ahmedabad', 'B', 1080, 1920, 'Society', 100, 150, 'offline'),
  ('ER_020', 'Silver Flora_B',      'Vasna', 'Ahmedabad', 'B', 1080, 1920, 'Society', 100, 150, 'offline'),
  ('ER_021', 'Silver Flora_C',      'Vasna', 'Ahmedabad', 'B', 1080, 1920, 'Society', 100, 150, 'offline'),
  -- Shyamal Zone A
  ('ER_022', 'Sanjay Tower_A',      'Shyamal', 'Ahmedabad', 'A', 1080, 1920, 'Society', 100, 150, 'offline'),
  ('ER_023', 'Sanjay Tower_B',      'Shyamal', 'Ahmedabad', 'A', 1080, 1920, 'Society', 100, 150, 'offline'),
  ('ER_024', 'Sanjay Tower_C',      'Shyamal', 'Ahmedabad', 'A', 1080, 1920, 'Society', 100, 150, 'offline'),
  ('ER_025', 'Kasturi 2_A',         'Shyamal', 'Ahmedabad', 'A', 1080, 1920, 'Society', 100, 150, 'offline'),
  ('ER_026', 'Kasturi 2_B',         'Shyamal', 'Ahmedabad', 'A', 1080, 1920, 'Society', 100, 150, 'offline'),
  ('ER_027', 'Kasturi 2_C',         'Shyamal', 'Ahmedabad', 'A', 1080, 1920, 'Society', 100, 150, 'offline'),
  ('ER_028', 'Kasturi 2_D',         'Shyamal', 'Ahmedabad', 'A', 1080, 1920, 'Society', 100, 150, 'offline'),
  ('ER_029', 'Nilkanth Elegance_A', 'Shyamal', 'Ahmedabad', 'A', 1080, 1920, 'Society', 100, 150, 'offline'),
  ('ER_030', 'Nilkanth Elegance_B', 'Shyamal', 'Ahmedabad', 'A', 1080, 1920, 'Society', 100, 150, 'offline'),
  ('ER_031', 'Nilkanth Elegance_C', 'Shyamal', 'Ahmedabad', 'A', 1080, 1920, 'Society', 100, 150, 'offline'),
  ('ER_032', 'Nilkanth Elegance_D', 'Shyamal', 'Ahmedabad', 'A', 1080, 1920, 'Society', 100, 150, 'offline'),
  ('ER_033', 'Shreeji Enclave_A',   'Shyamal', 'Ahmedabad', 'A', 1080, 1920, 'Society', 100, 150, 'offline'),
  ('ER_034', 'Shreeji Enclave_B',   'Shyamal', 'Ahmedabad', 'A', 1080, 1920, 'Society', 100, 150, 'offline'),
  ('ER_035', 'Shreeji Enclave_C',   'Shyamal', 'Ahmedabad', 'A', 1080, 1920, 'Society', 100, 150, 'offline'),
  ('ER_036', 'Shreeji Enclave_D',   'Shyamal', 'Ahmedabad', 'A', 1080, 1920, 'Society', 100, 150, 'offline'),
  ('ER_037', 'Shreeji Enclave_E',   'Shyamal', 'Ahmedabad', 'A', 1080, 1920, 'Society', 100, 150, 'offline'),
  ('ER_038', 'Shreeji Enclave_F',   'Shyamal', 'Ahmedabad', 'A', 1080, 1920, 'Society', 100, 150, 'offline')
ON CONFLICT (screen_code) DO NOTHING;

-- ── 3. ASSIGN SCREENS TO GROUPS ───────────────────────────────────────────────

INSERT INTO screen_group_members (group_id, screen_id)
SELECT vasna_group_id, id FROM screens
WHERE screen_code IN (
  'ER_005','ER_006','ER_007','ER_008','ER_009',
  'ER_010','ER_011','ER_012','ER_013','ER_014',
  'ER_015','ER_016','ER_017','ER_018','ER_019',
  'ER_020','ER_021'
)
ON CONFLICT DO NOTHING;

INSERT INTO screen_group_members (group_id, screen_id)
SELECT shyamal_group_id, id FROM screens
WHERE screen_code IN (
  'ER_022','ER_023','ER_024','ER_025','ER_026',
  'ER_027','ER_028','ER_029','ER_030','ER_031',
  'ER_032','ER_033','ER_034','ER_035','ER_036',
  'ER_037','ER_038'
)
ON CONFLICT DO NOTHING;

RAISE NOTICE '024: 34 screens seeded, groups Vasna=% Shyamal=%', vasna_group_id, shyamal_group_id;

END $$;
