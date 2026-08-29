// Middleware Express : verrou superadmin LECTURE SEULE.
//
// Réutilise req.authUser posé par requireAuth (gate global /api/* en amont,
// server.js:592-598) — aucun champ DB, aucun rôle en base. Compare l'email de
// la session, NORMALISÉ (lowercase + trim), à la liste ci-dessous.
//
// POINT DE CHANGEMENT UNIQUE : la liste des adresses superadmin. Pour ouvrir ou
// fermer l'accès, ajouter ou retirer une adresse ici. Aucun lien avec
// lib/vip.js : statut disjoint, aucune lecture croisée.
const SUPERADMIN_EMAILS = ['dev@soparadi.com', 'bonjour@movup.io']

export function requireSuperadmin(req, res, next) {
  const email = req.authUser?.email?.toLowerCase().trim()
  if (SUPERADMIN_EMAILS.includes(email)) return next()
  return res.status(403).json({ error: 'forbidden' })
}
