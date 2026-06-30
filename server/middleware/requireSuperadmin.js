// Middleware Express : verrou superadmin LECTURE SEULE.
//
// Réutilise req.authUser posé par requireAuth (gate global /api/* en amont,
// server.js:592-598) — aucun champ DB, aucun rôle en base. Compare l'email de
// la session, NORMALISÉ (lowercase + trim), à la constante ci-dessous.
//
// POINT DE CHANGEMENT UNIQUE : l'email superadmin. Pour transférer l'accès,
// modifier cette seule constante.
const SUPERADMIN_EMAIL = 'dev@soparadi.com'

export function requireSuperadmin(req, res, next) {
  const email = req.authUser?.email?.toLowerCase().trim()
  if (email === SUPERADMIN_EMAIL) return next()
  return res.status(403).json({ error: 'forbidden' })
}
