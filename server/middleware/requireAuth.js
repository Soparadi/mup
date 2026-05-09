// Middleware Express : vérifie le cookie de session, INSERT req.userId,
// sinon répond 401. Utilisé pour protéger toutes les routes /api/* hors
// /api/auth/* et /api/health.

import { getSession } from '../auth/surreal-adapter.js'

export const SESSION_COOKIE = 'mup_session'

// Parse minimaliste de l'en-tête Cookie (évite la dépendance cookie-parser).
function parseCookies(header) {
  const out = {}
  if (!header) return out
  const parts = String(header).split(';')
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (!k) continue
    out[k] = decodeURIComponent(v)
  }
  return out
}

export function readSessionToken(req) {
  const cookies = parseCookies(req.headers?.cookie)
  return cookies[SESSION_COOKIE] || null
}

// Middleware bloquant : 401 si pas de session valide.
export async function requireAuth(req, res, next) {
  try {
    const token = readSessionToken(req)
    if (!token) return res.status(401).json({ error: 'Authentification requise' })
    const session = await getSession(token)
    if (!session) return res.status(401).json({ error: 'Session invalide ou expirée' })
    const userIdStr = String(session.user_id).replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')
    req.userId = userIdStr
    // Compat avec lib/auth.js getUserId() qui lit req.session?.userId en priorité
    req.session = { userId: userIdStr }
    req.authUser = session.user || null
    next()
  } catch (e) {
    console.error('[requireAuth]', e.message)
    res.status(500).json({ error: 'Erreur d\'authentification' })
  }
}

// Variante HTML : même check session que requireAuth, mais en cas d'absence
// de session redirect 302 vers /login?redirect=<url_courante> au lieu de
// répondre 401 JSON. Utilisée pour protéger les pages HTML app (ne sert
// jamais le HTML protégé sans cookie session valide).
export async function requireAuthHtml(req, res, next) {
  try {
    const token = readSessionToken(req)
    let session = null
    if (token) session = await getSession(token)
    if (!token || !session) {
      const dest = '/login?redirect=' + encodeURIComponent(req.originalUrl || req.url || '/')
      return res.redirect(302, dest)
    }
    const userIdStr = String(session.user_id).replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')
    req.userId = userIdStr
    req.session = { userId: userIdStr }
    req.authUser = session.user || null
    next()
  } catch (e) {
    console.error('[requireAuthHtml]', e.message)
    // En cas d'erreur serveur on redirige aussi vers /login (fail-closed côté HTML).
    return res.redirect(302, '/login')
  }
}

// Variante non bloquante : injecte req.userId si session valide, ne renvoie jamais 401.
// Utile pour des endpoints lus en mode public + privé.
export async function attachAuth(req, _res, next) {
  try {
    const token = readSessionToken(req)
    if (token) {
      const session = await getSession(token)
      if (session) {
        const userIdStr = String(session.user_id).replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')
        req.userId = userIdStr
        req.session = { userId: userIdStr }
        req.authUser = session.user || null
      }
    }
  } catch (e) { /* ignore */ }
  next()
}
