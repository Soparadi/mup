-- Migration 001 — Phase 1 Auth MUP
-- Tables : user, session, verification_token, audit_log
-- Cible : namespace soparadi / database movup
-- Idempotent grace à IF NOT EXISTS sur tables, fields et index.

-- ── user ──
DEFINE TABLE IF NOT EXISTS user SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS email ON user TYPE string ASSERT string::is::email($value);
DEFINE FIELD IF NOT EXISTS password_hash ON user TYPE string;
DEFINE FIELD IF NOT EXISTS email_verified ON user TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS created_at ON user TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS siret ON user TYPE string ASSERT string::len($value) = 14;
DEFINE FIELD IF NOT EXISTS raison_sociale ON user TYPE string;
DEFINE FIELD IF NOT EXISTS code_naf ON user TYPE option<string>;
DEFINE FIELD IF NOT EXISTS adresse ON user TYPE string;
DEFINE FIELD IF NOT EXISTS code_postal ON user TYPE string;
DEFINE FIELD IF NOT EXISTS ville ON user TYPE string;
DEFINE FIELD IF NOT EXISTS lat ON user TYPE option<float>;
DEFINE FIELD IF NOT EXISTS lng ON user TYPE option<float>;
DEFINE FIELD IF NOT EXISTS plan ON user TYPE string DEFAULT "gratuit";
DEFINE INDEX IF NOT EXISTS user_email_unique ON user FIELDS email UNIQUE;
DEFINE INDEX IF NOT EXISTS user_siret_unique ON user FIELDS siret UNIQUE;

-- ── session ──
DEFINE TABLE IF NOT EXISTS session SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS user_id ON session TYPE record<user>;
DEFINE FIELD IF NOT EXISTS token ON session TYPE string;
DEFINE FIELD IF NOT EXISTS expires_at ON session TYPE datetime;
DEFINE FIELD IF NOT EXISTS created_at ON session TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS session_token_unique ON session FIELDS token UNIQUE;

-- ── verification_token ──
DEFINE TABLE IF NOT EXISTS verification_token SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS user_id ON verification_token TYPE record<user>;
DEFINE FIELD IF NOT EXISTS token ON verification_token TYPE string;
DEFINE FIELD IF NOT EXISTS type ON verification_token TYPE string ASSERT $value IN ["email_verify", "password_reset"];
DEFINE FIELD IF NOT EXISTS expires_at ON verification_token TYPE datetime;
DEFINE FIELD IF NOT EXISTS used ON verification_token TYPE bool DEFAULT false;
DEFINE INDEX IF NOT EXISTS vtoken_unique ON verification_token FIELDS token UNIQUE;

-- ── audit_log ──
DEFINE TABLE IF NOT EXISTS audit_log SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS user_id ON audit_log TYPE option<record<user>>;
DEFINE FIELD IF NOT EXISTS event ON audit_log TYPE string;
DEFINE FIELD IF NOT EXISTS ip ON audit_log TYPE option<string>;
DEFINE FIELD IF NOT EXISTS user_agent ON audit_log TYPE option<string>;
DEFINE FIELD IF NOT EXISTS metadata ON audit_log TYPE option<object>;
DEFINE FIELD IF NOT EXISTS created_at ON audit_log TYPE datetime DEFAULT time::now();
