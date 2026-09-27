-- User accounts (docs/build-spec-checklist.md §3 decisions 7-11, §4). Local accounts only: an admin creates them
-- (web UI or `npm run user -- add`); there is no self sign-up. Passwords are scrypt hashes
-- ("scrypt$N$r$p$salt$hash", packages/shared/src/users.ts). A session row is keyed by the sha256 of the cookie
-- token, so a database dump holds no usable session. Every user has at least one run (a character / playthrough)
-- that checklist progress belongs to.

CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username              text NOT NULL CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,31}$'),
  password_hash         text NOT NULL,
  role                  text NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  must_change_password  boolean NOT NULL DEFAULT true,
  disabled_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  last_login_at         timestamptz
);

CREATE UNIQUE INDEX users_username_key ON users (username);

CREATE TABLE sessions (
  id            text PRIMARY KEY,               -- sha256 hex of the session cookie value
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  user_agent    text
);

CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
