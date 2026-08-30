// Routes Express pour la couche auth Phase 1.
// Toutes ces routes sont publiques (pas de requireAuth) sauf /api/auth/me et /api/auth/logout
// qui acceptent un cookie session valide.
//
// Endpoints :
//   POST /api/auth/signup          body { prenom, nom, email, telephone, password }
//   POST /api/auth/login           body { email, password }
//   GET  /api/auth/verify          query token=xxx → pose la session et part dans l'app
//                                  (/prospection au 1er clic, /dashboard au re-clic) ;
//                                  en cas d'erreur → /verify?status=error&reason=xxx
//   POST /api/auth/forgot-password body { email }
//   POST /api/auth/reset-password  body { token, new_password }
//   POST /api/auth/logout          (cookie)
//   GET  /api/auth/me              (cookie) → { user }
//
// Le SIRET et la raison sociale sont collectés à /account/upgrade
// (juste-à-temps, avant Stripe Checkout — voir server/routes/stripe.js).

import express from 'express'
import argon2 from 'argon2'
import {
  createUser, getUserByEmail, getUserById,
  createSession, deleteSessionByToken, deleteAllSessionsForUser,
  createVerificationToken, getVerificationToken, getVerificationTokenAny,
  deleteVerificationTokens, markTokenUsed,
  setEmailVerified, updatePassword, logAuditEvent,
  invalidateSessionCacheByUserId
} from './surreal-adapter.js'
import { sendWelcomeVerify, sendWelcome, sendPasswordReset, sendEmailChangeVerify, sendEmailChangeNotice } from '../services/email.js'
import { getLocationFromIp } from '../services/geolocation.js'
import { readSessionToken, SESSION_COOKIE, setSessionCookie, requireAuth } from '../middleware/requireAuth.js'
import { approbationRequise, estEnAttente } from '../../lib/approbation.js'

export const router = express.Router()

// ── Version des conditions acceptées à l'inscription ──
// Reprend le numéro de version porté par les pages /cgu et /cgv
// (public/cgu.html, public/cgv.html : « Version 1.0 »). À incrémenter
// à chaque révision des conditions pour tracer quelle version chaque
// abonné a acceptée.
const CGU_VERSION = '1.0'

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
  const ip = getClientIp(req) || 'unknown'
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

// ── Accord step-up : ré-confirmation par mot de passe (15 min) ────────
// Une action sensible (changement d'adresse à venir) exige qu'un utilisateur
// DÉJÀ connecté reprouve son mot de passe. Le succès pose un accord de courte
// durée, RÉUTILISABLE dans la fenêtre (pas à usage unique), porté par le token
// de session — même clé que le SESSION_CACHE de l'adaptateur.
//
// Mécanisme retenu : marque en mémoire process (Map token→échéance), PAS un
// verification_token. Raisons :
//   - Un verification_token exigerait d'élargir la liste fermée des types (3
//     endroits) juste pour un accord éphémère jamais envoyé par email — le
//     commit 2 réserve cet élargissement au seul type email_change.
//   - L'accord suit la session : à la rotation (login/reset) le nouveau token
//     n'a pas d'accord, l'ancien est purgé. Rien à révoquer à la main.
//   - Process-local, comme rateBuckets et SESSION_CACHE : un redémarrage
//     l'efface, l'utilisateur ressaisit son mot de passe — coût acceptable,
//     jamais bloquant. Cohérent avec l'instance unique Railway.
const REAUTH_TTL_MS = 15 * 60 * 1000
const reauthGrants = new Map()     // sessionToken → expiresAt (ms epoch)

function grantReauth(sessionToken) {
  if (!sessionToken) return
  reauthGrants.set(sessionToken, Date.now() + REAUTH_TTL_MS)
}

// Lecture seule : une action sensible vérifie la fraîcheur de l'accord sans le
// consommer (fenêtre 15 min réutilisable). Exportée pour les commits suivants ;
// aucune action ne l'appelle encore.
export function hasFreshReauth(req) {
  const token = readSessionToken(req)
  if (!token) return false
  const exp = reauthGrants.get(token)
  if (!exp) return false
  if (Date.now() > exp) {
    reauthGrants.delete(token)
    return false
  }
  return true
}

// GC légère (miroir de celle des rateBuckets) : purge les accords expirés.
setInterval(() => {
  const now = Date.now()
  for (const [token, exp] of reauthGrants.entries()) {
    if (now > exp) reauthGrants.delete(token)
  }
}, 5 * 60 * 1000).unref()

// ── helpers ──

// Extraction IP client robuste : Cloudflare → Railway/proxy → direct.
// Utilisée à la fois pour le rate-limiting, l'audit log et la géolocalisation.
function getClientIp(req) {
  const cf = req.headers['cf-connecting-ip']
  if (cf) return String(cf).trim()
  const fwd = req.headers['x-forwarded-for']
  if (fwd) return String(fwd).split(',')[0].trim()
  const real = req.headers['x-real-ip']
  if (real) return String(real).trim()
  return req.socket?.remoteAddress || null
}

function clientMeta(req) {
  return {
    ip: getClientIp(req),
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

// Téléphone FR : +33 suivi de 9 chiffres OU 0 suivi de 9 chiffres.
// Espaces, points, tirets, parenthèses tolérés et nettoyés. Retourne la
// version normalisée (sans séparateurs) ou null si invalide.
function normalizePhoneFR(raw) {
  if (typeof raw !== 'string') return null
  const cleaned = raw.replace(/[\s.\-()]/g, '')
  if (/^\+33[1-9]\d{8}$/.test(cleaned)) return cleaned
  if (/^0[1-9]\d{8}$/.test(cleaned)) return cleaned
  return null
}

function trimToMax(s, max) {
  return String(s == null ? '' : s).trim().slice(0, max)
}

// setSessionCookie vient de middleware/requireAuth.js : les portillons de
// session reposent eux aussi ce cookie (prolongation glissante), les attributs
// n'ont donc qu'un seul lieu de définition.

// ── Marqueur d'attente de vérification ──
// Posé au signup (cookie HttpOnly, PAS une session : Doctrine A). Seule la
// route de sondage /verify-status le lit, pour répondre vrai/faux à la page
// d'attente. Échéance calée sur celle du jeton de vérification qu'il
// accompagne (24h) ; effacé plus tôt dès la vérification faite (cf. /verify).
const PENDING_COOKIE = 'mup_pending'
const PENDING_MAX_AGE = 24 * 60 * 60   // 24h, comme le jeton email_verify

function setPendingCookie(res, userIdStr) {
  const isProd = process.env.NODE_ENV === 'production'
  const parts = [
    `${PENDING_COOKIE}=${encodeURIComponent(userIdStr)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${PENDING_MAX_AGE}`
  ]
  if (isProd) parts.push('Secure')
  res.setHeader('Set-Cookie', parts.join('; '))
}

// Efface le marqueur d'attente. res.append (et non setHeader) : la vérification
// pose AUSSI le cookie de session au même moment — les deux Set-Cookie doivent
// coexister sur la réponse.
function clearPendingCookie(res) {
  const isProd = process.env.NODE_ENV === 'production'
  const parts = [
    `${PENDING_COOKIE}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT'
  ]
  if (isProd) parts.push('Secure')
  res.append('Set-Cookie', parts.join('; '))
}

// Parse minimaliste de l'en-tête Cookie (miroir de requireAuth.js, évite la
// dépendance cookie-parser). Utilisé par la route de sondage.
function parseCookieHeader(header) {
  const out = {}
  if (!header) return out
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const k = part.slice(0, eq).trim()
    if (!k) continue
    out[k] = decodeURIComponent(part.slice(eq + 1).trim())
  }
  return out
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
    prenom: u.prenom || null,
    nom: u.nom || null,
    name: u.name || null,
    telephone: u.telephone || null,
    // siret + raison_sociale : remplis à /account/upgrade pré-Stripe Checkout.
    // code_naf / adresse / code_postal / ville / lat / lng : déclarés en base
    // mais non peuplés par le parcours actuel (réservés enrichissement futur).
    siret: u.siret || null,
    raison_sociale: u.raison_sociale || null,
    code_naf: u.code_naf || null,
    adresse: u.adresse || null,
    code_postal: u.code_postal || null,
    ville: u.ville || null,
    lat: u.lat ?? null,
    lng: u.lng ?? null,
    plan: u.plan || 'gratuit',
    email_verified: Boolean(u.email_verified),
    // Alignement sur le payload /api/user/me + window.__USER__ (server.js).
    // Consommateurs : login.html (auth/me), réponses signup/login.
    intended_plan: u.intended_plan || null,
    billing_address: u.billing_address || null,
    stripe_customer_id: u.stripe_customer_id || null,
    plan_billing_cycle: u.plan_billing_cycle || null
  }
}

// ── POST /api/auth/signup ──
// Body : { prenom, nom, email, telephone, password, marketing_consent? }
// SIRET et raison sociale collectés à /account/upgrade (pré-Stripe Checkout).
// La géolocalisation IP est récupérée silencieusement depuis ipapi.co (best effort,
// timeout 2s, fail silencieux). Le consentement marketing est strictement optionnel
// (case non pré-cochée côté front), recueilli pour conformité RGPD si l'utilisateur
// souhaite recevoir nos communications.
router.post('/signup', async (req, res) => {
  if (!checkRate(req, res, 'signup')) return
  const meta = clientMeta(req)

  const prenom = trimToMax(req.body?.prenom, 80)
  const nom = trimToMax(req.body?.nom, 80)
  const email = String(req.body?.email || '').toLowerCase().trim()
  const telephoneRaw = String(req.body?.telephone || '').trim()
  const password = req.body?.password
  // Consentement marketing : strictement opt-in. On accepte true/'true'/1/'1'.
  const rawConsent = req.body?.marketing_consent
  const marketingConsent = rawConsent === true || rawConsent === 'true' || rawConsent === 1 || rawConsent === '1'

  // Acceptation CGU/CGV + confidentialité : OBLIGATOIRE. Case non pré-cochée
  // côté front. On accepte true/'true'/1/'1'. Preuve contractuelle tracée en base.
  const rawCgu = req.body?.cgu_accepted
  const cguAccepted = rawCgu === true || rawCgu === 'true' || rawCgu === 1 || rawCgu === '1'

  // Intention de plan captée au signup (?plan=… sur l'URL, transmis via input
  // caché). SIGNAL MARKETING uniquement — ne contrôle ni quotas ni accès.
  // Validation stricte case-sensitive : seules les 3 valeurs autorisées passent,
  // tout le reste devient null sans bloquer le signup.
  const VALID_INTENDED_PLANS = ['demarrage', 'activite', 'croisiere']
  const rawIntendedPlan = req.body?.intended_plan
  const intendedPlan = (typeof rawIntendedPlan === 'string' && VALID_INTENDED_PLANS.includes(rawIntendedPlan))
    ? rawIntendedPlan
    : null

  if (!prenom) return res.status(400).json({ error: 'Prénom requis', field: 'prenom' })
  if (!nom) return res.status(400).json({ error: 'Nom requis', field: 'nom' })
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Email invalide', field: 'email' })
  const telephone = normalizePhoneFR(telephoneRaw)
  if (!telephone) return res.status(400).json({ error: 'Téléphone invalide', field: 'telephone' })
  if (!isStrongPassword(password)) return res.status(400).json({ error: 'Mot de passe trop court (10 caractères minimum)', field: 'password' })
  // Garde serveur, pas simple formalité front : un appel direct sans la case échoue.
  if (!cguAccepted) return res.status(400).json({ error: 'Vous devez accepter les conditions générales pour créer un compte', field: 'cgu_accepted' })

  try {
    if (await getUserByEmail(email)) {
      return res.status(409).json({ error: 'Cet email est déjà utilisé', field: 'email' })
    }

    // argon2 hash (~200ms) et géolocalisation IP (jusqu'à 2s) en parallèle —
    // Promise.all garde le max des deux, pas la somme. Garantit < 500ms ajoutés.
    const [passwordHash, geoData] = await Promise.all([
      argon2.hash(password, ARGON_OPTS),
      getLocationFromIp(meta.ip)
    ])
    const name = `${prenom} ${nom}`.trim()

    // SurrealDB SCHEMAFULL avec option<...> traite `null` JS comme un VALUE
    // explicite qui ne match pas `none | string`. On OMET les champs absents
    // au lieu de poser null. Les option<...> deviendront NONE par défaut.
    const userBody = {
      email,
      prenom,
      nom,
      name,
      telephone,
      password_hash: passwordHash,
      email_verified: false,
      plan: 'demarrage',                        // Décision 1.2 — essai = niveau Essentiel ; trial_status distingue essai/payant
      marketing_consent: marketingConsent,      // false par défaut (RGPD)
      cgu_accepted: cguAccepted,                 // toujours true ici (garde 400 ci-dessus)
      cgu_version: CGU_VERSION                    // version des conditions acceptées
      // trial_status et les datetimes d'essai sont posés plus bas, et SEULEMENT
      // si l'approbation manuelle n'est pas armée (cf. ci-dessous).
    }
    // Approbation manuelle des inscriptions (lib/approbation.js). Variable
    // absente : `enAttente` vaut false, les deux blocs conditionnels ci-dessous
    // s'exécutent, et le signup est mot pour mot celui d'avant.
    //
    // Armée : le compte se crée et l'adresse se vérifiera normalement, mais
    // l'essai NE DÉMARRE PAS. Ne rien poser suffit à le tenir hors de TOUTES
    // les boucles du cron : relances J-2 et J-0, bascule automatique en
    // 'expired', avertissement de purge et purge sélectionnent toutes sur
    // trial_status = 'active' ou sur trial_ends_at IS NOT NONE. Un compte sans
    // ces champs n'entre dans aucune, y compris dans les compteurs
    // d'échéances. C'est l'approbation qui posera ces dates, et le décompte
    // des quatorze jours partira de cet instant-là.
    const enAttente = approbationRequise()
    if (!enAttente) userBody.trial_status = 'active'
    if (geoData && typeof geoData === 'object') userBody.geo_data = geoData
    if (intendedPlan) userBody.intended_plan = intendedPlan

    const user = await createUser(userBody)
    if (!user) return res.status(500).json({ error: 'Création du compte impossible' })

    const userIdStr = String(user.id).replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')

    // Datetimes calculées côté SurrealQL pour rester en datetime natif : sur
    // CREATE ... CONTENT l'API binding ne coerce PAS une string ISO vers
    // datetime (le CREATE échoue en entier). Même correctif que les dates
    // trial ci-dessous. La sémantique est identique pour les trois horodatages
    // de consentement : l'instant de l'acceptation = l'instant de la création,
    // donc time::now() est exact.
    //   - cgu_accepted_at    : toujours posé (acceptation OBLIGATOIRE, garde 400)
    //   - trial_started_at / trial_ends_at : seulement si l'approbation
    //     manuelle n'est pas armée ; sinon l'essai attend l'approbation
    //   - marketing_consent_at : seulement si la case opt-in est cochée
    //   - intended_plan_at   : seulement si un ?plan=… valide a été capté
    // Échec silencieux : si l'UPDATE plante, l'utilisateur est créé sans ces
    // dates mais peut quand même utiliser l'app (le middleware traite trial_status
    // === undefined comme passant).
    try {
      const { getDb } = await import('../../lib/surreal.js')
      const dbInst = await getDb()
      const setClauses = []
      if (!enAttente) {
        setClauses.push('trial_started_at = time::now()', 'trial_ends_at = time::now() + 14d')
      }
      setClauses.push('cgu_accepted_at = time::now()')
      if (marketingConsent) setClauses.push('marketing_consent_at = time::now()')
      if (intendedPlan) setClauses.push('intended_plan_at = time::now()')
      await dbInst.query(
        `UPDATE type::record('user', $id) SET ${setClauses.join(', ')}`,
        { id: userIdStr }
      )
    } catch (e) {
      console.warn('[signup] datetimes UPDATE échoué :', e.message)
    }

    const { token } = await createVerificationToken(userIdStr, 'email_verify')

    try {
      await sendWelcomeVerify({ email, prenom, nom, name }, token)
    } catch (e) {
      console.error('[signup] envoi email vérification échoué', e.message)
    }

    await logAuditEvent({
      userId: userIdStr, event: 'signup', ip: meta.ip, userAgent: meta.userAgent,
      metadata: {
        prenom, nom, telephone,
        marketing_consent: marketingConsent,
        cgu_accepted: cguAccepted,
        cgu_version: CGU_VERSION,
        intended_plan: intendedPlan,
        geo_country: geoData?.country_code || null,
        geo_city: geoData?.city || null
      }
    })

    if (intendedPlan) {
      // Trace debug — pas de PII, juste le signal d'intention.
      console.log('[signup] intended_plan capté :', intendedPlan)
    }

    // Marqueur d'attente : permet à /verify-pending de savoir quand la
    // vérification a eu lieu, sans session (Doctrine A) et sans interroger par
    // adresse. Voir GET /verify-status.
    setPendingCookie(res, userIdStr)

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

    // La session s'AJOUTE aux précédentes : se connecter sur un second appareil
    // ne déconnecte pas le premier. Seul le plafond par compte (dans
    // createSession) écarte les plus anciennes. La coupure de toutes les
    // sessions reste attachée à la réinitialisation de mot de passe.
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
    // Helper "Any" : retourne le token même si used=true, pour distinguer
    // "premier clic" (used=false) du "re-clic après vérification déjà faite"
    // (used=true → on laisse entrer la session sans rejouer l'email bienvenue).
    // Filtre toujours sur expiration physique.
    const vt = await getVerificationTokenAny(token, 'email_verify')
    if (!vt) {
      return res.redirect('/verify?status=error&reason=invalid_or_expired')
    }

    // Cas re-clic : token déjà consommé → on récupère le user, on pose la
    // session (l'email est prouvé depuis la première fois), et on redirige.
    // L'email de bienvenue n'est PAS rejoué (idempotence garantie en plus
    // par le flag welcome_email_sent_at, mais on évite l'aller-retour DB).
    if (vt.used === true) {
      const user = await getUserById(vt.user_id)
      if (!user) return res.redirect('/verify?status=error&reason=server_error')
      const userIdStr = String(user.id).replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')
      // Session ajoutée aux existantes, comme à la connexion : ouvrir le lien
      // depuis un autre appareil ne chasse pas les sessions déjà ouvertes.
      const { token: sessionToken, expiresAt } = await createSession(userIdStr, meta)
      setSessionCookie(res, sessionToken, expiresAt)
      clearPendingCookie(res)   // marqueur d'attente devenu inutile
      // Inscription pas encore approuvée : la session est posée quand même,
      // c'est elle qui permet à l'écran d'attente de sonder /api/user/me et de
      // s'ouvrir tout seul à l'approbation. Variable absente : /dashboard.
      if (estEnAttente(user)) return res.redirect('/attente')
      return res.redirect('/dashboard')
    }

    // Premier clic — séquence nominale.
    await markTokenUsed(vt.id)
    await setEmailVerified(vt.user_id)
    const user = await getUserById(vt.user_id)
    if (!user) return res.redirect('/verify?status=error&reason=server_error')
    const userIdStr = String(user.id).replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')

    // Email 2 (bienvenue narratif 3 récits) — idempotent via flag DB.
    // Si l'envoi ou le UPDATE plante : log et continuer (l'accès n'est pas bloqué
    // par un échec d'email).
    //
    // PAS DE BIENVENUE À UN COMPTE EN ATTENTE : il n'a pas d'accès à souhaiter
    // encore. C'est l'approbation qui l'enverra (POST /api/admin/comptes/
    // approbation), et le drapeau welcome_email_sent_at garantit qu'un seul des
    // deux chemins l'envoie. Variable absente : `enAttente` vaut false et ce
    // bloc redevient celui d'avant.
    const enAttente = estEnAttente(user)
    if (!enAttente && !user.welcome_email_sent_at) {
      try {
        await sendWelcome(user)
        const { getDb } = await import('../../lib/surreal.js')
        const dbInst = await getDb()
        await dbInst.query(
          'UPDATE type::record("user", $id) SET welcome_email_sent_at = time::now()',
          { id: userIdStr }
        )
      } catch (e) {
        console.error('[verify] email bienvenue échoué', e.message)
      }
    }

    // Session immédiate — email vérifié = identité prouvée. Ajoutée aux
    // existantes, jamais en remplacement.
    const { token: sessionToken, expiresAt } = await createSession(userIdStr, meta)
    setSessionCookie(res, sessionToken, expiresAt)
    clearPendingCookie(res)   // marqueur d'attente devenu inutile

    await logAuditEvent({ userId: userIdStr, event: 'email_verified', ip: meta.ip, userAgent: meta.userAgent })
    // Premier clic : entrée directe dans l'action (recherche). Le dashboard
    // est vide pour un nouveau compte — la doctrine 'valeur perçue d'abord'
    // impose l'écran d'action. Le re-clic (l.380), profil retour, garde /dashboard.
    // En attente d'approbation, l'écran d'attente prend la place : l'adresse
    // est bien vérifiée, c'est l'accès qui n'est pas encore ouvert.
    if (enAttente) return res.redirect('/attente')
    res.redirect('/prospection')
  } catch (e) {
    console.error('[auth:verify]', e.message)
    res.redirect('/verify?status=error&reason=server_error')
  }
})

// ── GET /api/auth/verify-status ──
// Sondage du parcours d'attente (public/verify-pending.html). Lit UNIQUEMENT
// le marqueur mup_pending posé au signup (cookie HttpOnly, pas une session) et
// rend { verified: true|false }. Ne prend AUCUNE adresse en paramètre :
// interroger par email permettrait de tester l'existence d'un compte. Sans
// marqueur — ou marqueur inconnu — rend false. Ne révèle rien d'autre.
router.get('/verify-status', async (req, res) => {
  try {
    const pending = parseCookieHeader(req.headers?.cookie)[PENDING_COOKIE]
    if (!pending) return res.json({ verified: false })
    const user = await getUserById(pending)
    if (!user) return res.json({ verified: false })
    return res.json({ verified: user.email_verified === true })
  } catch (e) {
    console.error('[auth:verify-status]', e.message)
    return res.json({ verified: false })
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

// ── POST /api/auth/resend-verification ──
// Renvoie l'email de vérification pour un compte non vérifié. Structure
// calquée LITTÉRALEMENT sur /forgot-password (anti-énumération stricte) :
// réponse générique unique dans les 3 cas (inexistant / déjà vérifié /
// envoyé). Seul cas non-générique : email format invalide → 400.
// logAuditEvent UNIQUEMENT dans la branche envoi réel — sinon les logs
// serveur leak l'existence de comptes par observation différentielle.
router.post('/resend-verification', async (req, res) => {
  if (!checkRate(req, res, 'resend-verification')) return
  const meta = clientMeta(req)
  const email = String(req.body?.email || '').toLowerCase().trim()
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Email invalide' })

  const genericResponse = { ok: true, message: 'Si un compte non vérifié existe pour cette adresse, un email vient d\'être renvoyé.' }

  try {
    const user = await getUserByEmail(email)
    if (!user) return res.json(genericResponse)                       // inexistant : générique, AUCUN envoi, AUCUN log
    if (user.email_verified === true) return res.json(genericResponse) // déjà vérifié : générique, AUCUN envoi, AUCUN log
    const userIdStr = String(user.id).replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')
    // Purge anciens tokens email_verify de ce user AVANT de créer un nouveau
    // (createVerificationToken empile sinon, plusieurs liens valides simultanément
    // — un seul lien actif à la fois respecte la sécurité).
    await deleteVerificationTokens(userIdStr, 'email_verify')
    const { token } = await createVerificationToken(userIdStr, 'email_verify')
    try {
      await sendWelcomeVerify({ email: user.email, prenom: user.prenom, nom: user.nom, name: user.name }, token)
    } catch (e) {
      console.error('[resend-verification] envoi échec', e.message)
    }
    await logAuditEvent({ userId: userIdStr, event: 'verification_resent', ip: meta.ip, userAgent: meta.userAgent })
    res.json(genericResponse)
  } catch (e) {
    console.error('[auth:resend-verification]', e.message)
    res.json(genericResponse)
  }
})

// ── POST /api/auth/reset-password ──
router.post('/reset-password', async (req, res) => {
  if (!checkRate(req, res, 'reset-password')) return
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

// ── POST /api/auth/reconfirm-password ──
// Ré-authentification "step-up" : un utilisateur DÉJÀ connecté (requireAuth)
// reprouve son mot de passe et obtient l'accord court (15 min) réutilisable par
// les actions sensibles. Débit limité comme /login (5 / 15 min / IP). Un échec
// écrit un événement d'audit.
// Cette brique n'est branchée sur AUCUNE action : elle existe et est testable,
// rien ne l'appelle encore.
router.post('/reconfirm-password', requireAuth, async (req, res) => {
  if (!checkRate(req, res, 'reconfirm-password')) return
  const meta = clientMeta(req)
  const password = req.body?.password
  const user = req.authUser
  if (!user || !user.password_hash) {
    return res.status(401).json({ error: 'Non authentifié' })
  }
  if (typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'Mot de passe requis' })
  }
  try {
    const ok = await argon2.verify(user.password_hash, password).catch(() => false)
    if (!ok) {
      await logAuditEvent({ userId: req.userId, event: 'reauth_failed', ip: meta.ip, userAgent: meta.userAgent })
      return res.status(401).json({ error: 'Mot de passe incorrect' })
    }
    grantReauth(readSessionToken(req))
    await logAuditEvent({ userId: req.userId, event: 'reauth_success', ip: meta.ip, userAgent: meta.userAgent })
    res.json({ ok: true, expires_in: REAUTH_TTL_MS / 1000 })
  } catch (e) {
    console.error('[auth:reconfirm-password]', e.message)
    res.status(500).json({ error: 'Vérification impossible' })
  }
})

// ── POST /api/auth/request-email-change ──
// Demande de changement d'adresse par un utilisateur connecté. Exige l'accord
// step-up du commit 1 (mot de passe reconfirmé < 15 min) : sans accord frais,
// 403 code 'reauth_required' que la page reconnaît pour redemander le mot de
// passe. N'ÉCRIT RIEN sur le compte — pose seulement un jeton email_change (1h)
// portant l'adresse visée et envoie deux courriels. Débit limité (5 / 15 min).
router.post('/request-email-change', requireAuth, async (req, res) => {
  if (!checkRate(req, res, 'request-email-change')) return
  if (!hasFreshReauth(req)) {
    return res.status(403).json({ error: 'Confirmation du mot de passe requise', code: 'reauth_required' })
  }
  const meta = clientMeta(req)
  const user = req.authUser
  if (!user) return res.status(401).json({ error: 'Non authentifié' })

  // Même normalisation que l'inscription (minuscule + trim), plus le retrait de
  // tous les espaces, puis la MÊME règle de format qu'à l'inscription.
  const newEmail = String(req.body?.new_email || '').toLowerCase().replace(/\s+/g, '')
  if (!isValidEmail(newEmail)) {
    return res.status(400).json({ error: 'Adresse invalide', field: 'new_email' })
  }
  const currentEmail = String(user.email || '').toLowerCase().trim()
  if (newEmail === currentEmail) {
    return res.status(400).json({ error: 'Cette adresse est déjà celle de votre compte', field: 'new_email' })
  }

  // Réponse identique que l'adresse soit libre ou déjà prise — anti-énumération.
  const genericResponse = {
    ok: true,
    message: 'Si cette adresse est disponible, un lien de confirmation vient de lui être envoyé. Votre adresse actuelle reste inchangée jusqu\'à confirmation.'
  }

  try {
    const userIdStr = req.userId
    // Adresse déjà portée par un compte : MÊME réponse que le succès, sans créer
    // de jeton, sans envoi, sans audit (l'audit dans cette seule branche leak
    // par observation différentielle). Jamais révéler l'existence d'un compte.
    const taken = await getUserByEmail(newEmail)
    if (taken) return res.json(genericResponse)

    // Une seule demande vivante à la fois : purge les jetons email_change en
    // attente de cet utilisateur avant d'en poser un nouveau.
    await deleteVerificationTokens(userIdStr, 'email_change')
    const { token } = await createVerificationToken(userIdStr, 'email_change', { newEmail })

    // Deux envois au mieux — un échec est journalisé et ne fait pas échouer la
    // demande, comme les autres envois du dépôt.
    try {
      await sendEmailChangeVerify({ email: newEmail, prenom: user.prenom, nom: user.nom, name: user.name }, token)
    } catch (e) {
      console.error('[request-email-change] envoi nouvelle adresse échoué', e.message)
    }
    try {
      await sendEmailChangeNotice({ email: currentEmail, prenom: user.prenom, nom: user.nom, name: user.name })
    } catch (e) {
      console.error('[request-email-change] avertissement ancienne adresse échoué', e.message)
    }

    await logAuditEvent({ userId: userIdStr, event: 'email_change_requested', ip: meta.ip, userAgent: meta.userAgent })
    res.json(genericResponse)
  } catch (e) {
    console.error('[auth:request-email-change]', e.message)
    res.status(500).json({ error: 'Demande impossible' })
  }
})

// ── GET /api/auth/confirm-email-change ──
// Confirmation du changement d'adresse depuis le lien reçu à la NOUVELLE adresse.
// PAS de requireAuth : ce lien s'ouvre depuis la boîte de la nouvelle adresse,
// souvent sur un autre appareil où personne n'est connecté. Le jeton porte
// l'identité — c'est lui la preuve, il suffit seul.
//   - Lit le jeton email_change ; getVerificationToken écarte déjà le jeton
//     expiré, employé, ou d'un autre type (→ null) : dans tous ces cas, message
//     « lien expiré ou déjà employé ».
//   - REVÉRIFIE l'unicité de l'adresse au moment de la bascule : quelqu'un a pu
//     la prendre pendant l'heure écoulée → message « adresse prise ». L'index
//     UNIQUE sert de dernier filet (bascule concurrente → server_error propre).
//   - Bascule le compte, marque le jeton employé, VIDE LE CACHE de session de
//     l'utilisateur pour que l'affichage suive dans les 30 s.
//   - NE CRÉE AUCUNE SESSION et n'en casse aucune : une session en cours porte
//     l'identifiant, pas l'adresse, elle reste valide ; sinon la personne se
//     connectera avec sa nouvelle adresse. Un lien de courriel ne vaut pas
//     connexion.
//   - Événement d'audit à la bascule, puis propagation best-effort au client
//     Stripe (n'échoue jamais le changement, déjà acté).
router.get('/confirm-email-change', async (req, res) => {
  const meta = clientMeta(req)
  const token = String(req.query?.token || '')
  if (!token) {
    return res.redirect('/email-change?status=error&reason=invalid_or_expired')
  }
  try {
    // Filtre used + expiré + type email_change → null si l'un ou l'autre.
    const vt = await getVerificationToken(token, 'email_change')
    if (!vt) {
      return res.redirect('/email-change?status=error&reason=invalid_or_expired')
    }

    // Adresse visée portée par le jeton. Un jeton sans adresse exploitable est
    // corrompu : échec serveur propre plutôt que d'écrire une adresse vide.
    const newEmail = String(vt.new_email || '').toLowerCase().trim()
    if (!isValidEmail(newEmail)) {
      console.error('[confirm-email-change] jeton sans adresse valide', vt.id)
      return res.redirect('/email-change?status=error&reason=server_error')
    }

    const userIdStr = String(vt.user_id).replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')

    // Revérif d'unicité AU MOMENT de la bascule : l'adresse a pu être prise par
    // un autre compte pendant l'heure de validité du lien. Échec propre.
    const taken = await getUserByEmail(newEmail)
    if (taken) {
      return res.redirect('/email-change?status=error&reason=address_taken')
    }

    // Identifiant Stripe lu AVANT la bascule (pour la propagation en fin de
    // parcours). Sert aussi à confirmer que le compte existe toujours.
    const user = await getUserById(userIdStr)
    if (!user) {
      return res.redirect('/email-change?status=error&reason=server_error')
    }
    const stripeCustomerId = user.stripe_customer_id || null

    // Bascule : écrit la nouvelle adresse. L'index UNIQUE sur email est le
    // dernier filet si une prise concurrente s'est glissée après la revérif —
    // l'UPDATE échoue alors, on tombe dans le catch (server_error propre).
    const { getDb } = await import('../../lib/surreal.js')
    const dbInst = await getDb()
    await dbInst.query(
      'UPDATE type::record("user", $id) MERGE { email: $email }',
      { id: userIdStr, email: newEmail }
    )

    // Jeton employé (usage unique) puis cache de session vidé : l'affichage de
    // toute session ouverte suit la nouvelle adresse dans les 30 s.
    await markTokenUsed(vt.id)
    invalidateSessionCacheByUserId(userIdStr)

    await logAuditEvent({
      userId: userIdStr, event: 'email_change_confirmed',
      ip: meta.ip, userAgent: meta.userAgent,
      metadata: { new_email: newEmail }
    })

    // Propagation Stripe, AU MIEUX : seulement si le compte porte un identifiant
    // client. Le compte est DÉJÀ basculé — un échec est journalisé (dans la
    // fonction) et ne fait pas échouer le changement.
    if (stripeCustomerId) {
      try {
        const { updateStripeCustomerEmail } = await import('../routes/stripe.js')
        await updateStripeCustomerEmail(stripeCustomerId, newEmail)
      } catch (e) {
        console.error('[confirm-email-change] propagation Stripe échouée', e.message)
      }
    }

    // AUCUNE session créée ni posée : un lien de courriel ne vaut pas connexion.
    return res.redirect('/email-change?status=success')
  } catch (e) {
    console.error('[auth:confirm-email-change]', e.message)
    return res.redirect('/email-change?status=error&reason=server_error')
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
