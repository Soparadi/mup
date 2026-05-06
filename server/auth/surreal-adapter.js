// Adapter SurrealDB pour la couche auth Phase 1.
// Toutes les opérations sont scopées au namespace soparadi / database movup
// déjà ouvert par lib/surreal.js — on partage la même connexion.

import { randomBytes, createHash } from 'crypto'
import { getDb } from '../../lib/surreal.js'

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000      // 30 jours
const VERIFY_TTL_MS = 24 * 3600 * 1000            // 24h pour email_verify
const RESET_TTL_MS = 60 * 60 * 1000               // 1h pour password_reset

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

// Phase 1 (signup) accepte :
//   { email, prenom, nom, name, telephone, password_hash, email_verified, plan }
// Phase 1.5 (onboarding entreprise) viendra ajouter via UPDATE :
//   siret, raison_sociale, adresse, code_postal, ville, code_naf, lat, lng
// Le SCHEMAFULL côté SurrealDB autorise désormais ces champs en option<...>.
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
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString()
  await db.query(
    'CREATE session CONTENT { user_id: type::record("user", $uid), token: $token, expires_at: $exp }',
    { uid: cleanUserId, token: tokenHash, exp: expiresAt }
  )
  return { token, expiresAt }
}

export async function getSession(token) {
  if (!token) return null
  const db = await getDb()
  const tokenHash = hashToken(token)
  const result = await db.query(
    'SELECT *, user_id.* AS user FROM session WHERE token = $token LIMIT 1',
    { token: tokenHash }
  )
  const row = result[0]?.[0]
  if (!row) return null
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await deleteSessionByToken(token).catch(() => {})
    return null
  }
  return {
    id: row.id,
    user_id: typeof row.user_id === 'object' ? String(row.user_id) : row.user_id,
    user: row.user,
    expires_at: row.expires_at
  }
}

export async function deleteSessionByToken(token) {
  if (!token) return
  const db = await getDb()
  const tokenHash = hashToken(token)
  await db.query('DELETE session WHERE token = $token', { token: tokenHash })
}

export async function deleteAllSessionsForUser(userId) {
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
  const ttl = type === 'email_verify' ? VERIFY_TTL_MS : RESET_TTL_MS
  const expiresAt = new Date(Date.now() + ttl).toISOString()
  await db.query(
    'CREATE verification_token CONTENT { user_id: type::record("user", $uid), token: $token, type: $type, expires_at: $exp }',
    { uid: cleanUserId, token: tokenHash, type, exp: expiresAt }
  )
  return { token, expiresAt }
}

export async function getVerificationToken(token, type) {
  if (!token) return null
  const db = await getDb()
  const tokenHash = hashToken(token)
  const result = await db.query(
    'SELECT * FROM verification_token WHERE token = $token AND type = $type LIMIT 1',
    { token: tokenHash, type }
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
    // Champs entreprise — capturés à l'onboarding (Phase 1.5). Optionnels au signup.
    // OVERWRITE pour rétrograder les définitions précédentes (string requis → option<string>).
    'DEFINE FIELD OVERWRITE siret ON user TYPE option<string> ASSERT $value = NONE OR string::len($value) = 14',
    'DEFINE FIELD OVERWRITE raison_sociale ON user TYPE option<string>',
    'DEFINE FIELD OVERWRITE adresse ON user TYPE option<string>',
    'DEFINE FIELD OVERWRITE code_postal ON user TYPE option<string>',
    'DEFINE FIELD OVERWRITE ville ON user TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS code_naf ON user TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS lat ON user TYPE option<float>',
    'DEFINE FIELD IF NOT EXISTS lng ON user TYPE option<float>',
    'DEFINE FIELD IF NOT EXISTS plan ON user TYPE string DEFAULT "gratuit"',
    'DEFINE INDEX IF NOT EXISTS user_email_unique ON user FIELDS email UNIQUE',
    // SIRET unique mais maintenant optionnel : plusieurs users peuvent rester sans siret
    // tant qu'ils n'ont pas franchi l'étape onboarding.
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
    'DEFINE FIELD IF NOT EXISTS metadata ON audit_log TYPE option<object>',
    'DEFINE FIELD IF NOT EXISTS created_at ON audit_log TYPE datetime DEFAULT time::now()'
  ]
  for (const q of queries) {
    try { await db.query(q) } catch (e) { console.warn('[auth-migration]', q.slice(0, 80), '→', e.message) }
  }
}
