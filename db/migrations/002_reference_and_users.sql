-- 002_reference_and_users.sql
-- Provinces/cities are the ONLY geography the platform stores for the management application.
-- No latitude/longitude/address columns exist here or anywhere outside site_location_restricted (011).

CREATE TABLE provinces (
  id            TEXT PRIMARY KEY,          -- e.g. 'IR-TEH'
  name_en       TEXT NOT NULL,
  name_fa       TEXT NOT NULL
);

CREATE TABLE cities (
  id            TEXT PRIMARY KEY,          -- e.g. 'city_tehran'
  province_id   TEXT NOT NULL REFERENCES provinces(id),
  name_en       TEXT NOT NULL,
  name_fa       TEXT NOT NULL
);
CREATE INDEX idx_cities_province ON cities(province_id);

CREATE TABLE customers (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          TEXT NOT NULL,
  industry      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE company (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          TEXT NOT NULL
);

CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  full_name      TEXT NOT NULL,
  role           user_role NOT NULL DEFAULT 'VIEWER',
  is_active      BOOLEAN NOT NULL DEFAULT true,
  can_read_precise_location BOOLEAN NOT NULL DEFAULT false, -- explicit, narrow authorization; see docs/ARCHITECTURE.md §9
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_role ON users(role);

CREATE TABLE refresh_tokens (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
