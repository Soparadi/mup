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

export function isVip(user) {
  if (!user) return false
  return user.email?.toLowerCase().trim() === BYPASS_EMAIL || user.bypass === true
}
