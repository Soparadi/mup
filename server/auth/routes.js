// Routes Express pour la couche auth Phase 1.
// Toutes ces routes sont publiques (pas de requireAuth) sauf /api/auth/me et /api/auth/logout
// qui acceptent un cookie session valide.
//
// Endpoints :
//   POST /api/auth/lookup-siret    body { siret } → { raison_sociale, adresse, code_postal, ville, code_naf, lat, lng }
//   POST /api/auth/signup          body { email, password, siret }
//   POST /api/auth/login           body { email, password }
//   GET  /api/auth/verify          query token=xxx → redirect /login?verified=1 ou /verify?error=xxx
//   POST /api/auth/forgot-password body { email }
//   POST /api/auth/reset-password  body { token, new_password }
//   POST /api/auth/logout          (cookie)
//   GET  /api/auth/me              (cookie) → { user }

import express from 'express'
import argon2 from 'argon2'
import {
  createUser, getUserByEmail, getUserBySiret, getUserById,
  createSession, deleteSessionByToken, deleteAllSessionsForUser,
  createVerificationToken, getVerificationToken, markTokenUsed,
  setEmailVerified, updatePassword, logAuditEvent
} from './surreal-adapter.js'
import { lookupSiret } from '../services/insee.js'
import { geocode } from '../services/ban.js'
import { sendWelcomeVerify, sendPasswordReset } from '../services/email.js'
import { readSessionToken, SESSION_COOKIE } from '../middleware/requireAuth.js'

export const router = express.Router()

// ── argon2id paramètres OWASP 2024 ──
const ARGON_OPTS = {
  type: argon2.argon2id,
  memoryCost: 19456,   // 19 MiB
  timeCost: 2,
  parallelism: 1
}

// ── Rate limiting in-memory (5 / 15 min par IP+route) ──
const rateBuckets = new Map()
const RATE_WINDOW_MS = 15 * 60 * 1000
const RATE_LIMIT = 5

function rateKey(req, route) {
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .toString().split(',')[0].trim()
  return `${route}:${ip}`
}

function checkRate(req, res, route) {
  const key = rateKey(req, route)
  const now = Date.now()
  const bucket = rateBuckets.get(key) || []
  const fresh = bucket.filter(t => now - t < RATE_WINDOW_MS)
  if (fresh.length >= RATE_LIMIT) {
    res.status(429).json({ error: 'Trop de tentatives. Réessayez dans 15 minutes.' })
    return false
  }
  fresh.push(now)
  rateBuckets.set(key, fresh)
  return true
}

// Garbage collection légère du bucket (évite croissance illimitée).
setInterval(() => {
  const now = Date.now()
  for (const [k, arr] of rateBuckets.entries()) {
    const fresh = arr.filter(t => now - t < RATE_WINDOW_MS)
    if (fresh.length === 0) rateBuckets.delete(k)
    else rateBuckets.set(k, fresh)
  }
}, 5 * 60 * 1000).unref()

// ── helpers ──

function clientMeta(req) {
  return {
    ip: (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim() || null,
    userAgent: req.headers['user-agent'] || null
  }
}

function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}

function isStrongPassword(pw) {
  return typeof pw === 'string' && pw.length >= 10 && pw.length <= 256
}

function isValidSiret(siret) {
  return typeof siret === 'string' && /^\d{14}$/.test(siret.replace(/\s+/g, ''))
}

function setSessionCookie(res, token, expiresAt) {
  const isProd = process.env.NODE_ENV === 'production'
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Expires=${new Date(expiresAt).toUTCString()}`
  ]
  if (isProd) parts.push('Secure')
  res.setHeader('Set-Cookie', parts.join('; '))
}

function clearSessionCookie(res) {
  const isProd = process.env.NODE_ENV === 'production'
  const parts = [
    `${SESSION_COOKIE}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT'
  ]
  if (isProd) parts.push('Secure')
  res.setHeader('Set-Cookie', parts.join('; '))
}

function publicUser(u) {
  if (!u) return null
  const id = String(u.id || '').replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')
  return {
    id,
    email: u.email,
    raison_sociale: u.raison_sociale,
    siret: u.siret,
    code_naf: u.code_naf || null,
    adresse: u.adresse,
    code_postal: u.code_postal,
    ville: u.ville,
    lat: u.lat ?? null,
    lng: u.lng ?? null,
    plan: u.plan || 'gratuit',
    email_verified: Boolean(u.email_verified)
  }
}

// ── POST /api/auth/lookup-siret ──
router.post('/lookup-siret', async (req, res) => {
  const siret = String(req.body?.siret || '').replace(/\s+/g, '')
  if (!isValidSiret(siret)) return res.status(400).json({ error: 'SIRET invalide (14 chiffres requis)' })
  try {
    const data = await lookupSiret(siret)
    if (!data) return res.status(404).json({ error: 'SIRET introuvable dans la base SIRENE' })
    let geo = null
    try {
      geo = await geocode({
        adresse: data.adresse_complete,
        code_postal: data.code_postal,
        ville: data.ville
      })
    } catch (e) { /* géocodage best-effort */ }
    res.json({
      raison_sociale: data.raison_sociale,
      adresse: data.adresse_complete,
      code_postal: data.code_postal,
      ville: data.ville,
      code_naf: data.code_naf || null,
      lat: geo?.lat ?? null,
      lng: geo?.lng ?? null
    })
  } catch (e) {
    console.error('[auth:lookup-siret]', e.message)
    res.status(502).json({ error: 'Service SIRENE indisponible' })
  }
})

// ── POST /api/auth/signup ──
router.post('/signup', async (req, res) => {
  if (!checkRate(req, res, 'signup')) return
  const meta = clientMeta(req)
  const email = String(req.body?.email || '').toLowerCase().trim()
  const password = req.body?.password
  const siret = String(req.body?.siret || '').replace(/\s+/g, '')

  if (!isValidEmail(email)) return res.status(400).json({ error: 'Email invalide' })
  if (!isStrongPassword(password)) return res.status(400).json({ error: 'Mot de passe trop court (10 caractères minimum)' })
  if (!isValidSiret(siret)) return res.status(400).json({ error: 'SIRET invalide (14 chiffres requis)' })

  try {
    if (await getUserByEmail(email)) {
      return res.status(409).json({ error: 'Cet email est déjà utilisé' })
    }
    if (await getUserBySiret(siret)) {
      return res.status(409).json({ error: 'Ce SIRET est déjà associé à un compte' })
    }

    const insee = await lookupSiret(siret)
    if (!insee) return res.status(400).json({ error: 'SIRET introuvable dans la base SIRENE' })

    let geo = null
    try {
      geo = await geocode({
        adresse: insee.adresse_complete,
        code_postal: insee.code_postal,
        ville: insee.ville
      })
    } catch (e) { /* best-effort */ }

    const passwordHash = await argon2.hash(password, ARGON_OPTS)

    const userBody = {
      email,
      password_hash: passwordHash,
      email_verified: false,
      siret,
      raison_sociale: insee.raison_sociale,
      adresse: insee.adresse_complete || '',
      code_postal: insee.code_postal || '',
      ville: insee.ville || '',
      plan: 'gratuit'
    }
    if (insee.code_naf) userBody.code_naf = insee.code_naf
    if (geo?.lat != null) userBody.lat = geo.lat
    if (geo?.lng != null) userBody.lng = geo.lng

    const user = await createUser(userBody)
    if (!user) return res.status(500).json({ error: 'Création du compte impossible' })

    const userIdStr = String(user.id).replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')
    const { token } = await createVerificationToken(userIdStr, 'email_verify')

    try {
      await sendWelcomeVerify({ email, raison_sociale: insee.raison_sociale }, token)
    } catch (e) {
      console.error('[signup] envoi email vérification échoué', e.message)
    }

    await logAuditEvent({ userId: userIdStr, event: 'signup', ip: meta.ip, userAgent: meta.userAgent, metadata: { siret } })

    res.status(201).json({
      ok: true,
      message: 'Compte créé. Vérifiez votre boîte mail pour activer votre accès.',
      user: publicUser({ ...user, ...userBody })
    })
  } catch (e) {
    console.error('[auth:signup]', e.message)
    res.status(500).json({ error: 'Création du compte impossible' })
  }
})

// ── POST /api/auth/login ──
router.post('/login', async (req, res) => {
  if (!checkRate(req, res, 'login')) return
  const meta = clientMeta(req)
  const email = String(req.body?.email || '').toLowerCase().trim()
  const password = req.body?.password

  if (!isValidEmail(email) || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis' })
  }

  try {
    const user = await getUserByEmail(email)
    if (!user) {
      await logAuditEvent({ event: 'login_failed', ip: meta.ip, userAgent: meta.userAgent, metadata: { reason: 'no_user', email } })
      return res.status(401).json({ error: 'Identifiants incorrects' })
    }

    const ok = await argon2.verify(user.password_hash, password).catch(() => false)
    if (!ok) {
      const userIdStr = String(user.id).replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')
      await logAuditEvent({ userId: userIdStr, event: 'login_failed', ip: meta.ip, userAgent: meta.userAgent, metadata: { reason: 'bad_password' } })
      return res.status(401).json({ error: 'Identifiants incorrects' })
    }

    if (!user.email_verified) {
      const userIdStr = String(user.id).replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')
      await logAuditEvent({ userId: userIdStr, event: 'login_failed', ip: meta.ip, userAgent: meta.userAgent, metadata: { reason: 'not_verified' } })
      return res.status(403).json({ error: 'Email non vérifié. Consultez votre boîte mail.', code: 'email_not_verified' })
    }

    const userIdStr = String(user.id).replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')

    // Rotation : invalide les sessions précédentes pour cet utilisateur, puis crée la nouvelle.
    await deleteAllSessionsForUser(userIdStr)
    const { token, expiresAt } = await createSession(userIdStr, meta)
    setSessionCookie(res, token, expiresAt)

    await logAuditEvent({ userId: userIdStr, event: 'login_success', ip: meta.ip, userAgent: meta.userAgent })

    res.json({ ok: true, user: publicUser(user) })
  } catch (e) {
    console.error('[auth:login]', e.message)
    res.status(500).json({ error: 'Connexion impossible' })
  }
})

// ── GET /api/auth/verify ──
router.get('/verify', async (req, res) => {
  const meta = clientMeta(req)
  const token = String(req.query?.token || '')
  if (!token) {
    return res.redirect('/verify?status=error&reason=missing_token')
  }
  try {
    const vt = await getVerificationToken(token, 'email_verify')
    if (!vt) {
      return res.redirect('/verify?status=error&reason=invalid_or_expired')
    }
    await markTokenUsed(vt.id)
    await setEmailVerified(vt.user_id)
    await logAuditEvent({ userId: vt.user_id, event: 'email_verified', ip: meta.ip, userAgent: meta.userAgent })
    res.redirect('/login?verified=1')
  } catch (e) {
    console.error('[auth:verify]', e.message)
    res.redirect('/verify?status=error&reason=server_error')
  }
})

// ── POST /api/auth/forgot-password ──
router.post('/forgot-password', async (req, res) => {
  if (!checkRate(req, res, 'forgot-password')) return
  const meta = clientMeta(req)
  const email = String(req.body?.email || '').toLowerCase().trim()
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Email invalide' })

  // Réponse identique que l'email existe ou non — anti-énumération.
  const genericResponse = { ok: true, message: 'Si ce compte existe, un email vient d\'être envoyé.' }

  try {
    const user = await getUserByEmail(email)
    if (!user) return res.json(genericResponse)
    const userIdStr = String(user.id).replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')
    const { token } = await createVerificationToken(userIdStr, 'password_reset')
    try {
      await sendPasswordReset({ email }, token)
    } catch (e) {
      console.error('[forgot-password] envoi échec', e.message)
    }
    await logAuditEvent({ userId: userIdStr, event: 'password_reset_requested', ip: meta.ip, userAgent: meta.userAgent })
    res.json(genericResponse)
  } catch (e) {
    console.error('[auth:forgot-password]', e.message)
    res.json(genericResponse)
  }
})

// ── POST /api/auth/reset-password ──
router.post('/reset-password', async (req, res) => {
  const meta = clientMeta(req)
  const token = String(req.body?.token || '')
  const newPassword = req.body?.new_password
  if (!token) return res.status(400).json({ error: 'Token manquant' })
  if (!isStrongPassword(newPassword)) return res.status(400).json({ error: 'Mot de passe trop court (10 caractères minimum)' })

  try {
    const vt = await getVerificationToken(token, 'password_reset')
    if (!vt) return res.status(400).json({ error: 'Lien invalide ou expiré' })
    const passwordHash = await argon2.hash(newPassword, ARGON_OPTS)
    await updatePassword(vt.user_id, passwordHash)
    await markTokenUsed(vt.id)
    // Invalidation forcée de toutes les sessions existantes — sécurité post-reset
    await deleteAllSessionsForUser(vt.user_id).catch(() => {})
    await logAuditEvent({ userId: vt.user_id, event: 'password_reset_completed', ip: meta.ip, userAgent: meta.userAgent })
    res.json({ ok: true, message: 'Mot de passe réinitialisé. Vous pouvez vous connecter.' })
  } catch (e) {
    console.error('[auth:reset-password]', e.message)
    res.status(500).json({ error: 'Réinitialisation impossible' })
  }
})

// ── POST /api/auth/logout ──
router.post('/logout', async (req, res) => {
  const meta = clientMeta(req)
  const token = readSessionToken(req)
  let userIdStr = null
  if (token) {
    try {
      const { getSession } = await import('./surreal-adapter.js')
      const sess = await getSession(token)
      if (sess) userIdStr = String(sess.user_id).replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')
      await deleteSessionByToken(token)
    } catch (e) { /* ignore */ }
  }
  clearSessionCookie(res)
  if (userIdStr) {
    await logAuditEvent({ userId: userIdStr, event: 'logout', ip: meta.ip, userAgent: meta.userAgent })
  }
  res.json({ ok: true })
})

// ── GET /api/auth/me ──
router.get('/me', async (req, res) => {
  const token = readSessionToken(req)
  if (!token) return res.status(401).json({ error: 'Non authentifié' })
  try {
    const { getSession } = await import('./surreal-adapter.js')
    const sess = await getSession(token)
    if (!sess) return res.status(401).json({ error: 'Session expirée' })
    const userIdStr = String(sess.user_id).replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')
    const user = sess.user || await getUserById(userIdStr)
    if (!user) return res.status(401).json({ error: 'Utilisateur introuvable' })
    res.json({ user: publicUser(user) })
  } catch (e) {
    console.error('[auth:me]', e.message)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})
