-- Migration 001 — Phase 1 Auth MUP
-- Tables : user, session, verification_token, audit_log
-- Cible : namespace soparadi / database movup
-- Idempotent grace à IF NOT EXISTS sur tables, fields et index.

-- ── user ──
DEFINE TABLE IF NOT EXISTS user SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS email ON user TYPE string ASSERT string::is_email($value);
DEFINE FIELD IF NOT EXISTS password_hash ON user TYPE string;
DEFINE FIELD IF NOT EXISTS email_verified ON user TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS created_at ON user TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON user TYPE option<datetime>;
-- Identité personne — captée au signup (Phase 1).
DEFINE FIELD IF NOT EXISTS prenom ON user TYPE string;
DEFINE FIELD IF NOT EXISTS nom ON user TYPE string;
DEFINE FIELD IF NOT EXISTS name ON user TYPE option<string>;
DEFINE FIELD IF NOT EXISTS telephone ON user TYPE string;
-- Champs entreprise — captés à l'onboarding (Phase 1.5). Optionnels au signup.
-- OVERWRITE pour rétrograder les définitions précédentes (string requis → option<string>).
DEFINE FIELD OVERWRITE siret ON user TYPE option<string> ASSERT $value = NONE OR string::len($value) = 14;
DEFINE FIELD OVERWRITE raison_sociale ON user TYPE option<string>;
DEFINE FIELD OVERWRITE adresse ON user TYPE option<string>;
DEFINE FIELD OVERWRITE code_postal ON user TYPE option<string>;
DEFINE FIELD OVERWRITE ville ON user TYPE option<string>;
DEFINE FIELD IF NOT EXISTS code_naf ON user TYPE option<string>;
DEFINE FIELD IF NOT EXISTS lat ON user TYPE option<float>;
DEFINE FIELD IF NOT EXISTS lng ON user TYPE option<float>;
DEFINE FIELD IF NOT EXISTS plan ON user TYPE string DEFAULT "gratuit";
-- Géolocalisation IP captée au signup (best effort, peut être null).
-- FLEXIBLE pour autoriser des sous-champs libres (city, region, country,
-- country_code, postal_code, latitude, longitude, ip_used, provider,
-- detected_at) sans avoir à les déclarer un par un en SCHEMAFULL strict.
DEFINE FIELD OVERWRITE geo_data ON user TYPE option<object> FLEXIBLE;
-- Consentement marketing (case opt-in non pré-cochée au signup, RGPD).
-- OVERWRITE option<bool> : autorise NONE (cas signup où la case n'est pas
-- envoyée). Évite "Expected bool but found NONE" au prochain UPDATE.
DEFINE FIELD OVERWRITE marketing_consent ON user TYPE option<bool>;
DEFINE FIELD IF NOT EXISTS marketing_consent_at ON user TYPE option<datetime>;
-- Intention de plan captée au signup via ?plan=… sur l'URL.
-- SIGNAL MARKETING — utilisé uniquement pour analytics et relances commerciales.
-- NE PAS UTILISER pour gérer les droits d'accès, les quotas ou le paywall :
-- c'est user.plan qui pilote le comportement business.
DEFINE FIELD IF NOT EXISTS intended_plan ON user TYPE option<string>
  ASSERT $value = NONE OR $value INSIDE ["demarrage", "activite", "croisiere"];
DEFINE FIELD IF NOT EXISTS intended_plan_at ON user TYPE option<datetime>;
-- Essai 14 jours — captés au signup, pilotent l'accès en mode lecture seule
-- + popup bloquant via le middleware requireActiveSubscription.
DEFINE FIELD IF NOT EXISTS trial_started_at ON user TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS trial_ends_at ON user TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS trial_status ON user TYPE option<string>
  ASSERT $value = NONE OR $value INSIDE ["active", "expired", "converted"];

-- Stripe — souscription payante.
DEFINE FIELD IF NOT EXISTS stripe_customer_id ON user TYPE option<string>;
DEFINE FIELD IF NOT EXISTS stripe_subscription_id ON user TYPE option<string>;
DEFINE FIELD IF NOT EXISTS subscription_status ON user TYPE option<string>
  ASSERT $value = NONE OR $value INSIDE ["trialing", "active", "past_due", "canceled", "unpaid", "incomplete"];
DEFINE FIELD IF NOT EXISTS current_period_end ON user TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS plan_billing_cycle ON user TYPE option<string>
  ASSERT $value = NONE OR $value INSIDE ["monthly", "annual"];
DEFINE FIELD IF NOT EXISTS billing_address ON user TYPE option<object>;

-- ── privacy_export_log ──
-- Trace des téléchargements RGPD article 20. Sert au rate limit (5 / 24h / user).
DEFINE TABLE IF NOT EXISTS privacy_export_log SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS user_id ON privacy_export_log TYPE record<user>;
DEFINE FIELD IF NOT EXISTS exported_at ON privacy_export_log TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS bytes_size ON privacy_export_log TYPE option<number>;
DEFINE INDEX IF NOT EXISTS idx_privacy_export_user ON privacy_export_log FIELDS user_id;
DEFINE INDEX IF NOT EXISTS idx_privacy_export_user_date ON privacy_export_log FIELDS user_id, exported_at;

-- ── stripe_events_processed ──
-- Idempotence webhooks Stripe (event_id unique).
DEFINE TABLE IF NOT EXISTS stripe_events_processed SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS event_id ON stripe_events_processed TYPE string;
DEFINE FIELD IF NOT EXISTS event_type ON stripe_events_processed TYPE string;
DEFINE FIELD IF NOT EXISTS processed_at ON stripe_events_processed TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS stripe_events_event_id_unique ON stripe_events_processed FIELDS event_id UNIQUE;
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
-- OVERWRITE FLEXIBLE : metadata contient des sous-clés dynamiques
-- (geo_city, geo_country, intended_plan, prenom, etc.) qu'on ne déclare
-- pas une à une. Évite "Found field metadata.geo_city" en SCHEMAFULL.
DEFINE FIELD OVERWRITE metadata ON audit_log TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS created_at ON audit_log TYPE datetime DEFAULT time::now();
