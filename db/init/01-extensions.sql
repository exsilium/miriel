-- Runs once on first database creation (docker-entrypoint-initdb.d).
-- Migrations also do CREATE EXTENSION IF NOT EXISTS, so this is belt and braces.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
