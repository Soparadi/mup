// Tables RGPD optout — opt-out tiers prospects via /optout (art. 12 RGPD).
//
// optout_request   : file des demandes opt-out, conservation 5 ans
//                    (prescription action RGPD art. 12.3). EXCLUE de la
//                    purge utilisateur 9.16 (cf. server/services/purge-
//                    expired.js — modification ciblée en Étape 6 du brief
//                    Phase 6 pour figer cette exclusion en commentaire).
//
// optout_blocklist : liste persistante des emails/SIRET opt-out (hash
//                    SHA-256), consultée à chaque scraping INSEE pour
//                    exclure silencieusement les tiers déjà opt-out.
//                    EXCLUE de la purge — persistante par construction.
//
// Schéma défini ci-dessous (runOptoutMigration), joué au boot du serveur
// de manière idempotente (DEFINE … IF NOT EXISTS). Calque strict du
// pattern server/services/search-tracker.js (runLeadSearchMigration).
//
// Les helpers métier (insert demande, check blocklist, verify token,
// process admin) seront ajoutés dans des passes ultérieures du brief
// Phase 6 (Étapes 5, 7, 8).

import { getDb } from '../../lib/surreal.js'

// ── migration idempotente ──
export async function runOptoutMigration() {
  const db = await getDb()
  const queries = [
    // ── optout_request — file des demandes opt-out tiers ──
    'DEFINE TABLE IF NOT EXISTS optout_request SCHEMAFULL',
    'DEFINE FIELD IF NOT EXISTS email ON optout_request TYPE string',
    'DEFINE FIELD IF NOT EXISTS email_hash ON optout_request TYPE string',
    'DEFINE FIELD IF NOT EXISTS siret ON optout_request TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS siret_hash ON optout_request TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS raison ON optout_request TYPE option<string>',
    "DEFINE FIELD IF NOT EXISTS status ON optout_request TYPE string ASSERT $value INSIDE ['pending_verification', 'verified', 'processed', 'rejected', 'expired_unverified']",
    'DEFINE FIELD IF NOT EXISTS verify_token ON optout_request TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS verify_expires_at ON optout_request TYPE option<datetime>',
    'DEFINE FIELD IF NOT EXISTS ip_address ON optout_request TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS user_agent ON optout_request TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS created_at ON optout_request TYPE datetime DEFAULT time::now()',
    'DEFINE FIELD IF NOT EXISTS verified_at ON optout_request TYPE option<datetime>',
    'DEFINE FIELD IF NOT EXISTS processed_at ON optout_request TYPE option<datetime>',
    'DEFINE FIELD IF NOT EXISTS processed_by ON optout_request TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS notes ON optout_request TYPE option<string>',
    'DEFINE INDEX IF NOT EXISTS idx_optout_request_email_hash ON optout_request FIELDS email_hash',
    'DEFINE INDEX IF NOT EXISTS idx_optout_request_siret_hash ON optout_request FIELDS siret_hash',
    'DEFINE INDEX IF NOT EXISTS idx_optout_request_verify_token ON optout_request FIELDS verify_token UNIQUE',
    'DEFINE INDEX IF NOT EXISTS idx_optout_request_status ON optout_request FIELDS status',
    'DEFINE INDEX IF NOT EXISTS idx_optout_request_created_at ON optout_request FIELDS created_at',
    // ── optout_blocklist — liste persistante hash SHA-256, consultée scraping ──
    'DEFINE TABLE IF NOT EXISTS optout_blocklist SCHEMAFULL',
    'DEFINE FIELD IF NOT EXISTS email_hash ON optout_blocklist TYPE string',
    'DEFINE FIELD IF NOT EXISTS siret_hash ON optout_blocklist TYPE option<string>',
    "DEFINE FIELD IF NOT EXISTS source ON optout_blocklist TYPE string ASSERT $value INSIDE ['user_request', 'admin_manual', 'legal_order']",
    'DEFINE FIELD IF NOT EXISTS request_id ON optout_blocklist TYPE option<record<optout_request>>',
    'DEFINE FIELD IF NOT EXISTS blocked_at ON optout_blocklist TYPE datetime DEFAULT time::now()',
    'DEFINE FIELD IF NOT EXISTS notes ON optout_blocklist TYPE option<string>',
    'DEFINE INDEX IF NOT EXISTS idx_optout_blocklist_email_hash ON optout_blocklist FIELDS email_hash',
    'DEFINE INDEX IF NOT EXISTS idx_optout_blocklist_siret_hash ON optout_blocklist FIELDS siret_hash',
    'DEFINE INDEX IF NOT EXISTS idx_optout_blocklist_source ON optout_blocklist FIELDS source',
    'DEFINE INDEX IF NOT EXISTS idx_optout_blocklist_blocked_at ON optout_blocklist FIELDS blocked_at'
  ]
  for (const q of queries) {
    try { await db.query(q) } catch (e) { console.warn('[optout-migration]', q.slice(0, 80), '→', e.message) }
  }
}
