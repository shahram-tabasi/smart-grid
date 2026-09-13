-- Phase 2.1: worldwide projects.
--
-- The original model assumed every project was in Iran: projects.province_id and city_id were both
-- NOT NULL and referenced Iran-only reference tables. Electro Kavir has branches outside Iran and
-- ships switchgear worldwide, so a project must be able to exist in any country.
--
-- APPROACH — additive, not a rewrite:
--   * a countries table becomes the top of the location hierarchy;
--   * provinces gain a country (existing rows become Iran, which they are);
--   * projects gain country_code, an optional site coordinate, and a free-text location label;
--   * province_id / city_id become NULLABLE, so a project abroad is not forced into Iranian
--     administrative divisions that do not apply to it.
-- Every existing row keeps working unchanged: nothing is dropped and nothing is renamed.
--
-- ON COORDINATES — this is a deliberate change of policy, recorded here so it is not mistaken for
-- an oversight. Phase 1 forbade storing a site position anywhere except site_location_restricted,
-- because the system was framed as monitoring utility substations, where publishing positions is a
-- genuine security problem. The owner has since specified the opposite requirement for their own
-- business data: a switchgear manufacturer tracking where its own panels are installed, placed by
-- clicking a map. projects.site_lat / site_lon exist for that. site_location_restricted remains for
-- anything the operator marks as sensitive, and the map still falls back to city centroids when a
-- project has no explicit position.

-- ---------------------------------------------------------------------------------------------
-- 1. Countries
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS countries (
  code        TEXT PRIMARY KEY,          -- ISO 3166-1 alpha-2
  name_en     TEXT NOT NULL,
  name_fa     TEXT,
  -- Country centroid, used only to centre the map when a country is selected. Country-level
  -- granularity, not a site position.
  centroid_lon DOUBLE PRECISION,
  centroid_lat DOUBLE PRECISION
);

COMMENT ON TABLE countries IS
  'Top of the location hierarchy. Added when the company moved from Iran-only projects to worldwide installations.';

INSERT INTO countries (code, name_en, name_fa, centroid_lon, centroid_lat) VALUES
  ('IR','Iran','ایران',53.688,32.428),
  ('IQ','Iraq','عراق',43.679,33.223),
  ('AF','Afghanistan','افغانستان',67.710,33.939),
  ('TR','Türkiye','ترکیه',35.243,38.964),
  ('AE','United Arab Emirates','امارات متحده عربی',53.848,23.424),
  ('OM','Oman','عمان',55.923,21.513),
  ('QA','Qatar','قطر',51.184,25.355),
  ('KW','Kuwait','کویت',47.482,29.312),
  ('SA','Saudi Arabia','عربستان سعودی',45.079,23.886),
  ('BH','Bahrain','بحرین',50.638,25.931),
  ('AZ','Azerbaijan','آذربایجان',47.577,40.143),
  ('AM','Armenia','ارمنستان',45.038,40.069),
  ('GE','Georgia','گرجستان',43.356,42.315),
  ('TM','Turkmenistan','ترکمنستان',59.556,38.970),
  ('UZ','Uzbekistan','ازبکستان',64.585,41.377),
  ('KZ','Kazakhstan','قزاقستان',66.924,48.020),
  ('TJ','Tajikistan','تاجیکستان',71.276,38.861),
  ('PK','Pakistan','پاکستان',69.345,30.375),
  ('IN','India','هند',78.962,20.594),
  ('CN','China','چین',104.195,35.862),
  ('RU','Russia','روسیه',105.319,61.524),
  ('DE','Germany','آلمان',10.452,51.166),
  ('IT','Italy','ایتالیا',12.567,41.872),
  ('FR','France','فرانسه',2.213,46.228),
  ('ES','Spain','اسپانیا',-3.749,40.464),
  ('GB','United Kingdom','بریتانیا',-3.436,55.378),
  ('NL','Netherlands','هلند',5.291,52.132),
  ('SE','Sweden','سوئد',18.644,60.128),
  ('PL','Poland','لهستان',19.145,51.919),
  ('RO','Romania','رومانی',24.967,45.943),
  ('EG','Egypt','مصر',30.802,26.821),
  ('LY','Libya','لیبی',17.228,26.335),
  ('DZ','Algeria','الجزایر',1.660,28.034),
  ('MA','Morocco','مراکش',-7.093,31.792),
  ('TN','Tunisia','تونس',9.537,33.887),
  ('ZA','South Africa','آفریقای جنوبی',22.938,-30.559),
  ('NG','Nigeria','نیجریه',8.675,9.082),
  ('KE','Kenya','کنیا',37.906,-0.024),
  ('BR','Brazil','برزیل',-51.925,-14.235),
  ('AR','Argentina','آرژانتین',-63.617,-38.416),
  ('US','United States','ایالات متحده',-95.713,37.090),
  ('CA','Canada','کانادا',-106.347,56.130),
  ('MX','Mexico','مکزیک',-102.553,23.635),
  ('AU','Australia','استرالیا',133.775,-25.274),
  ('ID','Indonesia','اندونزی',113.921,-0.789),
  ('MY','Malaysia','مالزی',101.976,4.210),
  ('VN','Vietnam','ویتنام',108.277,14.058),
  ('TH','Thailand','تایلند',100.993,15.870),
  ('JP','Japan','ژاپن',138.253,36.205),
  ('KR','South Korea','کره جنوبی',127.766,35.908),
  ('SY','Syria','سوریه',38.997,34.802),
  ('LB','Lebanon','لبنان',35.862,33.855),
  ('JO','Jordan','اردن',36.238,30.585),
  ('YE','Yemen','یمن',48.516,15.553)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------------------------
-- 2. Provinces belong to a country
-- ---------------------------------------------------------------------------------------------

ALTER TABLE provinces ADD COLUMN IF NOT EXISTS country_code TEXT REFERENCES countries(code);
UPDATE provinces SET country_code = 'IR' WHERE country_code IS NULL;

-- ---------------------------------------------------------------------------------------------
-- 3. Projects can live anywhere
-- ---------------------------------------------------------------------------------------------

ALTER TABLE projects ADD COLUMN IF NOT EXISTS country_code TEXT REFERENCES countries(code);
UPDATE projects SET country_code = 'IR' WHERE country_code IS NULL;
ALTER TABLE projects ALTER COLUMN country_code SET DEFAULT 'IR';

-- Free-text place name for sites outside Iran, where our province/city tables do not apply
-- (e.g. "Basra Industrial Zone" or "Hamburg Hafen").
ALTER TABLE projects ADD COLUMN IF NOT EXISTS location_label TEXT;

-- Explicit site position, set by clicking the map. NULL means "no pin dropped": the map then falls
-- back to the city centroid, exactly as before.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS site_lat DOUBLE PRECISION;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS site_lon DOUBLE PRECISION;

-- Reject impossible coordinates rather than storing a marker that lands in the ocean off Africa,
-- which is where (0,0) and swapped lat/lon typically end up.
DO $$ BEGIN
  ALTER TABLE projects ADD CONSTRAINT projects_site_coords_valid CHECK (
    (site_lat IS NULL AND site_lon IS NULL)
    OR (site_lat BETWEEN -90 AND 90 AND site_lon BETWEEN -180 AND 180)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A project abroad has no Iranian province or city.
ALTER TABLE projects ALTER COLUMN province_id DROP NOT NULL;
ALTER TABLE projects ALTER COLUMN city_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS projects_country_idx ON projects (country_code);
CREATE INDEX IF NOT EXISTS projects_has_pin_idx ON projects (country_code) WHERE site_lat IS NOT NULL;

COMMENT ON COLUMN projects.site_lat IS
  'Site position placed by clicking the map. See the policy note at the top of migration 016 — this is company-owned installation data, deliberately distinct from the utility-substation privacy rule that governs site_location_restricted.';

-- ---------------------------------------------------------------------------------------------
-- 4. View: everything the map needs, in one place
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_project_locations AS
SELECT
  p.id                AS project_id,
  p.code,
  p.name,
  p.status,
  p.health_score,
  co.code             AS country_code,
  co.name_en          AS country_name_en,
  co.name_fa          AS country_name_fa,
  pr.id               AS province_id,
  pr.name_en          AS province_name_en,
  c.id                AS city_id,
  c.name_en           AS city_name_en,
  c.name_fa           AS city_name_fa,
  p.location_label,
  p.site_lat,
  p.site_lon,
  (p.site_lat IS NOT NULL) AS has_pin,
  COUNT(DISTINCT r.id)                                             AS relay_count,
  COUNT(DISTINCT r.id) FILTER (WHERE r.health_status = 'CRITICAL')  AS critical_relays,
  COUNT(DISTINCT r.id) FILTER (WHERE r.health_status = 'OFFLINE')   AS offline_relays
FROM projects p
LEFT JOIN countries co    ON co.code = p.country_code
LEFT JOIN provinces pr    ON pr.id = p.province_id
LEFT JOIN cities c        ON c.id = p.city_id
LEFT JOIN substations sub ON sub.project_id = p.id
LEFT JOIN switchgear sg   ON sg.substation_id = sub.id
LEFT JOIN panels pnl      ON pnl.switchgear_id = sg.id
LEFT JOIN relays r        ON r.panel_id = pnl.id
GROUP BY p.id, p.code, p.name, p.status, p.health_score,
         co.code, co.name_en, co.name_fa, pr.id, pr.name_en,
         c.id, c.name_en, c.name_fa, p.location_label, p.site_lat, p.site_lon;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'simorgh_api') THEN
    GRANT SELECT ON countries, v_project_locations TO simorgh_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'simorgh_ai_readonly') THEN
    GRANT SELECT ON countries TO simorgh_ai_readonly;
  END IF;
END $$;
