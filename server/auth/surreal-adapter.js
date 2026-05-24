// Adapter SurrealDB pour la couche auth Phase 1.
// Toutes les opérations sont scopées au namespace soparadi / database movup
// déjà ouvert par lib/surreal.js — on partage la même connexion.

import { randomBytes, createHash } from 'crypto'
import { getDb } from '../../lib/surreal.js'

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000      // 30 jours
const VERIFY_TTL_MS = 24 * 3600 * 1000            // 24h pour email_verify
const RESET_TTL_MS = 60 * 60 * 1000               // 1h pour password_reset

// ── Cache mémoire LRU pour getSession ─────────────────────────────────
// Évite les rafales 100+ queries SurrealDB lors d'une recherche /leads.
// Cache process-local (Map JS) → isolé par instance Railway. Si scale
// horizontal >1 replica un jour, chaque réplique aura son cache propre,
// divergence acceptable car TTL court (30s).
// Trade-off acceptable MVP : si user.plan ou user.subscription_status
// change pendant la fenêtre 30s (ex: webhook Stripe upgrade), l'utilisateur
// continuera à voir l'ancien plan jusqu'à expiration cache.
const SESSION_CACHE = new Map()       // token → { session, expiresAt }
const SESSION_CACHE_TTL = 30_000      // 30s
const SESSION_CACHE_MAX = 1000        // garde-fou mémoire

function cacheGet(token) {
  const entry = SESSION_CACHE.get(token)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    SESSION_CACHE.delete(token)
    return null
  }
  return entry.session
}

function cacheSet(token, session) {
  if (SESSION_CACHE.size >= SESSION_CACHE_MAX) {
    // Éviction simple : drop la plus ancienne (Map JS préserve l'ordre d'insertion)
    const firstKey = SESSION_CACHE.keys().next().value
    SESSION_CACHE.delete(firstKey)
  }
  SESSION_CACHE.set(token, { session, expiresAt: Date.now() + SESSION_CACHE_TTL })
}

export function invalidateSessionCache(token) {
  if (token) SESSION_CACHE.delete(token)
}

// Invalidation par user_id : itère le cache et supprime les entries du user.
// Appelée par deleteAllSessionsForUser pour préserver la cohérence post-logout
// global / password reset (sinon attaquant garde 30s de validité avec ancien token).
// Exportée pour permettre l'invalidation depuis les routes Stripe après UPDATE
// user (fraîcheur immédiate de stripe_customer_id, subscription_status, plan,
// plan_billing_cycle, billing_address, etc. lus par billing.html/upgrade.html).
export function invalidateSessionCacheByUserId(userId) {
  if (!userId) return
  const target = String(userId).replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')
  for (const [token, entry] of SESSION_CACHE) {
    const sessUid = String(entry?.session?.user_id || '')
      .replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')
    if (sessUid === target) SESSION_CACHE.delete(token)
  }
}

// ── helpers ──
function normalizeId(prefix, raw) {
  if (!raw) return null
  const s = String(raw)
  if (s.startsWith(prefix + ':')) return s.slice(prefix.length + 1).replace(/^⟨+|⟩+$/g, '')
  return s.replace(/^⟨+|⟩+$/g, '')
}

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

function generateToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

// ── user ──

// Signup accepte :
//   { email, prenom, nom, name, telephone, password_hash, email_verified, plan }
// siret + raison_sociale + billing_address sont peuplés plus tard à
// /account/upgrade (pré-Stripe Checkout). Les champs adresse/code_postal/
// ville/code_naf/lat/lng restent déclarés option<...> mais non peuplés
// par le parcours actuel (réservés enrichissement INSEE/BAN futur éventuel).
export async function createUser(fields) {
  const db = await getDb()
  const result = await db.query('CREATE user CONTENT $body', { body: fields })
  return result[0]?.[0] || result[0] || null
}

export async function getUserByEmail(email) {
  if (!email) return null
  const db = await getDb()
  const result = await db.query(
    'SELECT * FROM user WHERE email = $email LIMIT 1',
    { email: String(email).toLowerCase().trim() }
  )
  return result[0]?.[0] || null
}

export async function getUserBySiret(siret) {
  if (!siret) return null
  const db = await getDb()
  const result = await db.query(
    'SELECT * FROM user WHERE siret = $siret LIMIT 1',
    { siret: String(siret).replace(/\s+/g, '') }
  )
  return result[0]?.[0] || null
}

export async function getUserById(id) {
  if (!id) return null
  const db = await getDb()
  const cleanId = normalizeId('user', id)
  const result = await db.query('SELECT * FROM type::record("user", $id)', { id: cleanId })
  return result[0]?.[0] || null
}

export async function setEmailVerified(userId) {
  const db = await getDb()
  const cleanId = normalizeId('user', userId)
  await db.query(
    'UPDATE type::record("user", $id) MERGE { email_verified: true }',
    { id: cleanId }
  )
}

export async function updatePassword(userId, passwordHash) {
  const db = await getDb()
  const cleanId = normalizeId('user', userId)
  await db.query(
    'UPDATE type::record("user", $id) MERGE { password_hash: $h }',
    { id: cleanId, h: passwordHash }
  )
}

// ── session ──

export async function createSession(userId, { ip, userAgent } = {}) {
  const db = await getDb()
  const token = generateToken(32)
  const tokenHash = hashToken(token)
  const cleanUserId = normalizeId('user', userId)
  // expires_at calculé côté SurrealQL pour rester en datetime natif (SurrealDB v2
  // ne coerce pas une string ISO via $binding). On retourne la version JS pour
  // que le caller puisse poser le cookie avec la bonne date d'expiration.
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString()
  await db.query(
    'CREATE session SET user_id = type::record("user", $uid), token = $tok, expires_at = time::now() + 30d',
    { uid: cleanUserId, tok: tokenHash }
  )
  return { token, expiresAt }
}

export async function getSession(token) {
  if (!token) return null
  const cached = cacheGet(token)
  if (cached) return cached

  const db = await getDb()
  const tokenHash = hashToken(token)
  const result = await db.query(
    'SELECT *, user_id.* AS user FROM session WHERE token = $tok LIMIT 1',
    { tok: tokenHash }
  )
  const row = result[0]?.[0]
  if (!row) return null
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await deleteSessionByToken(token).catch(() => {})
    return null
  }
  const session = {
    id: row.id,
    user_id: typeof row.user_id === 'object' ? String(row.user_id) : row.user_id,
    user: row.user,
    expires_at: row.expires_at
  }
  cacheSet(token, session)
  return session
}

export async function deleteSessionByToken(token) {
  if (!token) return
  invalidateSessionCache(token)
  const db = await getDb()
  const tokenHash = hashToken(token)
  await db.query('DELETE session WHERE token = $tok', { tok: tokenHash })
}

export async function deleteAllSessionsForUser(userId) {
  invalidateSessionCacheByUserId(userId)
  const db = await getDb()
  const cleanId = normalizeId('user', userId)
  await db.query(
    'DELETE session WHERE user_id = type::record("user", $uid)',
    { uid: cleanId }
  )
}

// ── verification_token ──

export async function createVerificationToken(userId, type) {
  if (!['email_verify', 'password_reset'].includes(type)) {
    throw new Error('verification token type invalide')
  }
  const db = await getDb()
  const token = generateToken(32)
  const tokenHash = hashToken(token)
  const cleanUserId = normalizeId('user', userId)
  // Durée fixe par type — inlinée côté SurrealQL pour rester en datetime natif.
  const ttl = type === 'email_verify' ? VERIFY_TTL_MS : RESET_TTL_MS
  const durationLit = type === 'email_verify' ? '24h' : '1h'
  const expiresAt = new Date(Date.now() + ttl).toISOString()
  await db.query(
    `CREATE verification_token SET user_id = type::record("user", $uid), token = $tok, type = $type, expires_at = time::now() + ${durationLit}`,
    { uid: cleanUserId, tok: tokenHash, type }
  )
  return { token, expiresAt }
}

export async function getVerificationToken(token, type) {
  if (!token) return null
  const db = await getDb()
  const tokenHash = hashToken(token)
  const result = await db.query(
    'SELECT * FROM verification_token WHERE token = $tok AND type = $type LIMIT 1',
    { tok: tokenHash, type }
  )
  const row = result[0]?.[0]
  if (!row) return null
  if (row.used) return null
  if (new Date(row.expires_at).getTime() < Date.now()) return null
  return {
    id: row.id,
    user_id: typeof row.user_id === 'object' ? String(row.user_id) : row.user_id,
    type: row.type,
    expires_at: row.expires_at
  }
}

// Variante de getVerificationToken qui n'écarte PAS les tokens utilisés.
// Retourne le row complet (avec .used et .expires_at) ou null si physiquement
// introuvable OU expiré. Utilisée par /verify pour distinguer "premier clic"
// (used=false → marquer used + envoyer email bienvenue) du "re-clic après
// vérification déjà faite" (used=true → laisser entrer sans rejouer l'email).
// L'helper original getVerificationToken garde son contrat (filtre used) pour
// les autres usages — notamment /forgot-password qui doit refuser un token reset
// déjà consommé.
export async function getVerificationTokenAny(token, type) {
  if (!token) return null
  const db = await getDb()
  const tokenHash = hashToken(token)
  const result = await db.query(
    'SELECT * FROM verification_token WHERE token = $tok AND type = $type LIMIT 1',
    { tok: tokenHash, type }
  )
  const row = result[0]?.[0]
  if (!row) return null
  if (new Date(row.expires_at).getTime() < Date.now()) return null
  return {
    id: row.id,
    user_id: typeof row.user_id === 'object' ? String(row.user_id) : row.user_id,
    type: row.type,
    used: row.used === true,
    expires_at: row.expires_at
  }
}

// Purge tous les verification_token d'un user pour un type donné.
// Réutilisable : appelée par /api/auth/resend-verification AVANT de créer un
// nouveau token (sinon createVerificationToken empile, plusieurs liens
// valides simultanément, n'importe lequel active le compte).
// Garde même contrat de validation que createVerificationToken.
export async function deleteVerificationTokens(userId, type) {
  if (!['email_verify', 'password_reset'].includes(type)) {
    throw new Error('verification token type invalide')
  }
  if (!userId) return
  const db = await getDb()
  const cleanUserId = normalizeId('user', userId)
  await db.query(
    'DELETE verification_token WHERE user_id = type::record("user", $uid) AND type = $type',
    { uid: cleanUserId, type }
  )
}

export async function markTokenUsed(tokenRecordId) {
  const db = await getDb()
  const cleanId = normalizeId('verification_token', tokenRecordId)
  await db.query(
    'UPDATE type::record("verification_token", $id) MERGE { used: true }',
    { id: cleanId }
  )
}

// ── audit_log ──

export async function logAuditEvent({ userId, event, ip, userAgent, metadata }) {
  try {
    const db = await getDb()
    const body = { event }
    if (userId) {
      const cleanId = normalizeId('user', userId)
      body.user_id = `user:${cleanId}`
    }
    if (ip) body.ip = String(ip).slice(0, 64)
    if (userAgent) body.user_agent = String(userAgent).slice(0, 256)
    if (metadata && typeof metadata === 'object') body.metadata = metadata
    if (body.user_id) {
      await db.query(
        'CREATE audit_log CONTENT { event: $event, user_id: type::record("user", $uid), ip: $ip, user_agent: $ua, metadata: $meta }',
        {
          event: body.event,
          uid: normalizeId('user', userId),
          ip: body.ip || null,
          ua: body.user_agent || null,
          meta: body.metadata || null
        }
      )
    } else {
      await db.query(
        'CREATE audit_log CONTENT { event: $event, ip: $ip, user_agent: $ua, metadata: $meta }',
        {
          event: body.event,
          ip: body.ip || null,
          ua: body.user_agent || null,
          meta: body.metadata || null
        }
      )
    }
  } catch (e) {
    console.warn('[audit_log]', e.message)
  }
}

// ── bootstrap : applique migrations/001_auth_tables.surql au démarrage ──

export async function runAuthMigration() {
  const db = await getDb()
  const queries = [
    'DEFINE TABLE IF NOT EXISTS user SCHEMAFULL',
    'DEFINE FIELD IF NOT EXISTS email ON user TYPE string ASSERT string::is_email($value)',
    'DEFINE FIELD IF NOT EXISTS password_hash ON user TYPE string',
    'DEFINE FIELD IF NOT EXISTS email_verified ON user TYPE bool DEFAULT false',
    'DEFINE FIELD IF NOT EXISTS created_at ON user TYPE datetime DEFAULT time::now()',
    'DEFINE FIELD IF NOT EXISTS updated_at ON user TYPE option<datetime>',
    // Identité personne — capturée au signup (Phase 1).
    'DEFINE FIELD IF NOT EXISTS prenom ON user TYPE string',
    'DEFINE FIELD IF NOT EXISTS nom ON user TYPE string',
    'DEFINE FIELD IF NOT EXISTS name ON user TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS telephone ON user TYPE string',
    // Champs entreprise — siret + raison_sociale peuplés à /account/upgrade
    // (pré-Stripe Checkout) ; les autres restent option<...> réservés
    // enrichissement futur. OVERWRITE pour rétrograder les définitions
    // précédentes (string requis → option<string>).
    'DEFINE FIELD OVERWRITE siret ON user TYPE option<string> ASSERT $value = NONE OR string::len($value) = 14',
    'DEFINE FIELD OVERWRITE raison_sociale ON user TYPE option<string>',
    'DEFINE FIELD OVERWRITE adresse ON user TYPE option<string>',
    'DEFINE FIELD OVERWRITE code_postal ON user TYPE option<string>',
    'DEFINE FIELD OVERWRITE ville ON user TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS code_naf ON user TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS lat ON user TYPE option<float>',
    'DEFINE FIELD IF NOT EXISTS lng ON user TYPE option<float>',
    'DEFINE FIELD OVERWRITE plan ON user TYPE string DEFAULT "demarrage" ASSERT $value = NONE OR $value INSIDE ["demarrage", "activite", "croisiere"]',
    // Géolocalisation IP captée au signup (best effort, peut être null).
    // FLEXIBLE : sous-champs libres (city, region, country, country_code,
    // postal_code, latitude, longitude, ip_used, provider, detected_at) sans
    // avoir à les déclarer un par un. Évite l'erreur "Found field geo_data.X
    // but no such field exists" en SCHEMAFULL strict.
    // OVERWRITE car le champ avait déjà été défini sans FLEXIBLE en prod.
    'DEFINE FIELD OVERWRITE geo_data ON user TYPE option<object> FLEXIBLE',
    // Consentement marketing (case opt-in non pré-cochée au signup, RGPD).
    // OVERWRITE option<bool> : autorise NONE (cas signup où la case n'est
    // pas envoyée). Évite "Expected bool but found NONE" au prochain UPDATE.
    'DEFINE FIELD OVERWRITE marketing_consent ON user TYPE option<bool>',
    'DEFINE FIELD IF NOT EXISTS marketing_consent_at ON user TYPE option<datetime>',
    // Intention de plan captée au signup via ?plan=… sur l'URL.
    // SIGNAL MARKETING — utilisé uniquement pour analytics et relances commerciales.
    // NE PAS UTILISER pour gérer les droits d'accès, les quotas ou le paywall :
    // c'est user.plan qui pilote le comportement business.
    'DEFINE FIELD IF NOT EXISTS intended_plan ON user TYPE option<string> ASSERT $value = NONE OR $value INSIDE ["demarrage", "activite", "croisiere"]',
    'DEFINE FIELD IF NOT EXISTS intended_plan_at ON user TYPE option<datetime>',
    // Essai 14 jours — captés au signup, pilotent l'accès en mode lecture
    // seule + popup bloquant via le middleware requireActiveSubscription.
    // Valeurs : 'active' (J0-J14) | 'expired' (J+15+) | 'converted' (Stripe paid).
    'DEFINE FIELD IF NOT EXISTS trial_started_at ON user TYPE option<datetime>',
    'DEFINE FIELD IF NOT EXISTS trial_ends_at ON user TYPE option<datetime>',
    'DEFINE FIELD IF NOT EXISTS trial_status ON user TYPE option<string> ASSERT $value = NONE OR $value INSIDE ["active", "expired", "converted"]',
    // Flags d'idempotence pour le cron trial — set par les emails sent successfully.
    // J+12 (post-trial) déclaré pour préparer le terrain mais NON câblé dans le cron actuel
    // (stratégie commerciale du template relance-j12 à valider avant câblage).
    'DEFINE FIELD IF NOT EXISTS trial_email_j2_sent_at ON user TYPE option<datetime>',
    'DEFINE FIELD IF NOT EXISTS trial_email_j0_sent_at ON user TYPE option<datetime>',
    'DEFINE FIELD IF NOT EXISTS trial_email_j12_sent_at ON user TYPE option<datetime>',
    'DEFINE FIELD IF NOT EXISTS grace_j_minus_1_sent_at ON user TYPE option<datetime>',
    // Flag idempotence email bienvenue (post-vérification email). Posé une seule fois
    // à l'envoi réussi de sendWelcome, lu en amont pour bloquer tout double-envoi
    // (cas re-clic du lien verify : on laisse entrer la session mais on ne rejoue pas l'email).
    'DEFINE FIELD IF NOT EXISTS welcome_email_sent_at ON user TYPE option<datetime>',
    // Stripe — souscription payante (passe 2). billing_address est un objet
    // { line1, line2?, postal_code, city, country } persisté avant le Checkout.
    'DEFINE FIELD IF NOT EXISTS stripe_customer_id ON user TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS stripe_subscription_id ON user TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS subscription_status ON user TYPE option<string> ASSERT $value = NONE OR $value INSIDE ["trialing", "active", "past_due", "canceled", "unpaid", "incomplete"]',
    'DEFINE FIELD IF NOT EXISTS current_period_end ON user TYPE option<datetime>',
    'DEFINE FIELD IF NOT EXISTS cancel_at_period_end ON user TYPE option<bool>',
    'DEFINE FIELD IF NOT EXISTS plan_billing_cycle ON user TYPE option<string> ASSERT $value = NONE OR $value INSIDE ["monthly", "annual"]',
    'DEFINE FIELD IF NOT EXISTS billing_address ON user TYPE option<object>',
    // Suppression de compte RGPD art. 17 (Phase 6 Étape 13) — demande + échéance J+7.
    'DEFINE FIELD IF NOT EXISTS deletion_requested_at ON user TYPE option<datetime>',
    'DEFINE FIELD IF NOT EXISTS deletion_scheduled_at ON user TYPE option<datetime>',
    'DEFINE INDEX IF NOT EXISTS user_email_unique ON user FIELDS email UNIQUE',
    // SIRET unique mais optionnel : plusieurs users peuvent rester sans siret
    // tant qu'ils n'ont pas franchi /account/upgrade (pré-Stripe Checkout).
    'DEFINE INDEX IF NOT EXISTS user_siret_unique ON user FIELDS siret UNIQUE',
    'DEFINE TABLE IF NOT EXISTS session SCHEMAFULL',
    'DEFINE FIELD IF NOT EXISTS user_id ON session TYPE record<user>',
    'DEFINE FIELD IF NOT EXISTS token ON session TYPE string',
    'DEFINE FIELD IF NOT EXISTS expires_at ON session TYPE datetime',
    'DEFINE FIELD IF NOT EXISTS created_at ON session TYPE datetime DEFAULT time::now()',
    'DEFINE INDEX IF NOT EXISTS session_token_unique ON session FIELDS token UNIQUE',
    'DEFINE TABLE IF NOT EXISTS verification_token SCHEMAFULL',
    'DEFINE FIELD IF NOT EXISTS user_id ON verification_token TYPE record<user>',
    'DEFINE FIELD IF NOT EXISTS token ON verification_token TYPE string',
    'DEFINE FIELD IF NOT EXISTS type ON verification_token TYPE string ASSERT $value IN ["email_verify", "password_reset"]',
    'DEFINE FIELD IF NOT EXISTS expires_at ON verification_token TYPE datetime',
    'DEFINE FIELD IF NOT EXISTS used ON verification_token TYPE bool DEFAULT false',
    'DEFINE INDEX IF NOT EXISTS vtoken_unique ON verification_token FIELDS token UNIQUE',
    'DEFINE TABLE IF NOT EXISTS audit_log SCHEMAFULL',
    'DEFINE FIELD IF NOT EXISTS user_id ON audit_log TYPE option<record<user>>',
    'DEFINE FIELD IF NOT EXISTS event ON audit_log TYPE string',
    'DEFINE FIELD IF NOT EXISTS ip ON audit_log TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS user_agent ON audit_log TYPE option<string>',
    // OVERWRITE FLEXIBLE : metadata contient des sous-clés dynamiques
    // (geo_city, geo_country, intended_plan, prenom, etc.) qu'on ne déclare
    // pas une à une. Évite "Found field metadata.geo_city" en SCHEMAFULL.
    'DEFINE FIELD OVERWRITE metadata ON audit_log TYPE option<object> FLEXIBLE',
    'DEFINE FIELD IF NOT EXISTS created_at ON audit_log TYPE datetime DEFAULT time::now()',
    // ── privacy_export_log ──
    // Trace des téléchargements RGPD article 20 (export à vie). Sert au rate
    // limit (max 5 / 24h / user) qui survit aux redémarrages serveur.
    'DEFINE TABLE IF NOT EXISTS privacy_export_log SCHEMAFULL',
    'DEFINE FIELD IF NOT EXISTS user_id ON privacy_export_log TYPE record<user>',
    'DEFINE FIELD IF NOT EXISTS exported_at ON privacy_export_log TYPE datetime DEFAULT time::now()',
    'DEFINE FIELD IF NOT EXISTS bytes_size ON privacy_export_log TYPE option<number>',
    'DEFINE INDEX IF NOT EXISTS idx_privacy_export_user ON privacy_export_log FIELDS user_id',
    'DEFINE INDEX IF NOT EXISTS idx_privacy_export_user_date ON privacy_export_log FIELDS user_id, exported_at',
    // ── stripe_events_processed ──
    // Idempotence des webhooks Stripe : un event_id ne doit être traité
    // qu'une fois (Stripe renvoie en cas de doute, parfois 2-3x).
    'DEFINE TABLE IF NOT EXISTS stripe_events_processed SCHEMAFULL',
    'DEFINE FIELD IF NOT EXISTS event_id ON stripe_events_processed TYPE string',
    'DEFINE FIELD IF NOT EXISTS event_type ON stripe_events_processed TYPE string',
    'DEFINE FIELD IF NOT EXISTS processed_at ON stripe_events_processed TYPE datetime DEFAULT time::now()',
    'DEFINE INDEX IF NOT EXISTS stripe_events_event_id_unique ON stripe_events_processed FIELDS event_id UNIQUE',
    // ──────────────────────────────────────────────────────────────────
    // CORRECTIFS SCHÉMA — OVERWRITE consolidé (idempotent, dernière
    // DEFINE l'emporte). Patches des bugs SCHEMAFULL successifs :
    //   - sous-objets dynamiques (geo_data, billing_address, metadata) →
    //     FLEXIBLE pour autoriser les sous-clés sans les déclarer
    //   - bool / string posés à NONE → option<...> pour accepter NONE
    // Chaque OVERWRITE est sûr même si déjà appliqué.
    // ──────────────────────────────────────────────────────────────────
    'DEFINE FIELD OVERWRITE billing_address ON user TYPE option<object> FLEXIBLE',
    'DEFINE FIELD OVERWRITE geo_data ON user TYPE option<object> FLEXIBLE',
    'DEFINE FIELD OVERWRITE metadata ON audit_log TYPE option<object> FLEXIBLE',
    'DEFINE FIELD OVERWRITE marketing_consent ON user TYPE option<bool>',
    'DEFINE FIELD OVERWRITE intended_plan ON user TYPE option<string>',
    'DEFINE FIELD OVERWRITE stripe_customer_id ON user TYPE option<string>',
    'DEFINE FIELD OVERWRITE stripe_subscription_id ON user TYPE option<string>',
    'DEFINE FIELD OVERWRITE subscription_status ON user TYPE option<string>',
    'DEFINE FIELD OVERWRITE current_period_end ON user TYPE option<datetime>',
    'DEFINE FIELD OVERWRITE plan_billing_cycle ON user TYPE option<string>',
    'DEFINE FIELD OVERWRITE siret ON user TYPE option<string>',
    'DEFINE FIELD OVERWRITE raison_sociale ON user TYPE option<string>'
  ]
  for (const q of queries) {
    try { await db.query(q) } catch (e) { console.warn('[auth-migration]', q.slice(0, 80), '→', e.message) }
  }
}
