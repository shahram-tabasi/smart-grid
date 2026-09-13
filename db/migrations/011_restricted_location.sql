-- 011_restricted_location.sql
--
-- SECURITY-CRITICAL: this is the ONLY table in the entire schema allowed to hold a precise address or
-- coordinate. It is never joined by any endpoint under /api/* except the narrow, explicitly-authorized
-- field-dispatch endpoint, which requires the `location:read_precise` permission (users.can_read_precise_location).
-- Every SELECT against this table MUST be paired with an audit_log INSERT (enforced in the API service layer,
-- app/api/src/modules/locations/restricted-location.service.ts).
--
-- The AI service's database role has no GRANT on this table at all.

CREATE TABLE site_location_restricted (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  substation_id  UUID NOT NULL UNIQUE REFERENCES substations(id) ON DELETE CASCADE,
  address        TEXT,
  latitude       NUMERIC(9,6),
  longitude      NUMERIC(9,6),
  access_notes   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE site_location_restricted IS
  'Restricted precise-location data. Never exposed via general API, map, AI, or executive views. Access requires location:read_precise permission and is audit-logged on every read.';
