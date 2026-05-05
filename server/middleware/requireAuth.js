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
