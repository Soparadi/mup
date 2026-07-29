// Statut VIP — source unique du déblocage « ambassadrice ».
//
// Deux sources disjointes, historiquement inline dans deriveAppState :
//   - email en dur = compte dev garanti libre MÊME si la base déconne ;
//   - user.bypass === true = comptes VIP marqués en base (toggle superadmin
//     via POST /api/admin/comptes/bypass).
//
// Extrait ici parce que deux appelants doivent appliquer LA MÊME règle :
// lib/derive-app-state.js (état d'abonnement) et server/config/plan-quotas.js
// (plafond de leads). Constante partagée, jamais recopiée.
//
// N'ouvre PAS le superadmin : server/middleware/requireSuperadmin.js garde sa
// propre constante, statut disjoint, aucune lecture croisée.
//
// Spec : fonction pure. Aucun I/O, aucun effet de bord.
export const BYPASS_EMAIL = 'dev@soparadi.com'

// Compte propriétaire — l'ADRESSE en dur, distincte du drapeau bypass. Seul le
// propriétaire ouvre le plafond infini (getLeadLimit) ; le drapeau bypass, lui,
// ouvre le plan croisiere offert (plafond chiffré à 120/mois, cf getEffectivePlan).
// Les deux populations étaient confondues sous isVip — elles ne le sont plus côté
// quota. Comparaison en minuscules et détourée : une adresse posée en base peut
// varier de casse ou porter des espaces.
export function isOwner(user) {
  return user?.email?.toLowerCase().trim() === BYPASS_EMAIL
}

// Accès libre (état d'abonnement) : propriétaire OU drapeau bypass. Reste la
// source unique de deriveAppState — les deux populations gardent 'active', pas
// d'expiration d'essai. Le plafond de leads, lui, les sépare (cf getLeadLimit).
export function isVip(user) {
  if (!user) return false
  return isOwner(user) || user.bypass === true
}
