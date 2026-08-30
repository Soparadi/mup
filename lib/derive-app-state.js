// Dérivation pure de l'état d'abonnement applicatif (app_state) à partir
// d'un objet user. Source unique de vérité partagée par :
//   - server/middleware/subscription.js (décide 402 vs next() en fonction
//     du label retourné ici)
//   - server.js endpoint /api/user/me (expose le champ au front via JSON)
//   - server.js injection window.__USER__ (expose le champ aux pages app)
//
// Logique alignée 1-à-1 sur les branches historiques du middleware (état
// pré-H5a). Aucun changement de comportement applicatif : H5a nomme l'état
// existant et le rend lisible côté front, sans le modifier.
//
// Spec : fonction pure. AUCUN I/O, AUCUN accès req/res, AUCUN effet de
// bord, AUCUNE écriture DB. `now` injecté en paramètre pour testabilité
// et déterminisme.
//
// Un seul paramètre lit l'environnement, et par défaut seulement : `enAttente`
// (approbation manuelle des inscriptions, lib/approbation.js), qui ajoute un
// label 'pending_approval' aux six déjà rendus. Le passer explicitement rend
// la fonction déterministe à nouveau. Sans la variable INSCRIPTION_APPROBATION,
// il vaut false et cette fonction se comporte exactement comme avant son ajout.

import { isVip } from './vip.js'
import { estEnAttente } from './approbation.js'

const GRACE_DAYS = 7
const GRACE_MS = GRACE_DAYS * 24 * 3600 * 1000

// Impayé : délai avant coupure lecture seule, aligné sur les CGV art. 6
// (14 j de tentatives Stripe avant suspension).
const PAST_DUE_DAYS = 14
const PAST_DUE_MS = PAST_DUE_DAYS * 24 * 3600 * 1000

export function deriveAppState(user, now = Date.now(), enAttente = estEnAttente(user)) {
  if (!user) throw new Error('deriveAppState: user requis')

  // Déblocage VIP — court-circuit au point le plus haut, avant toute branche
  // d'abonnement. Règle et constante : lib/vip.js (partagées avec le calcul
  // du plafond de leads, server/config/plan-quotas.js).
  // Retourne 'active' → le compte ne touche jamais 'trial_expired' ni la
  // bascule DB associée. N'ouvre PAS le superadmin (statut disjoint, verrou
  // email seul côté requireSuperadmin — aucune lecture croisée).
  if (isVip(user)) return 'active'

  // Inscription non encore approuvée (lib/approbation.js). Placée JUSTE APRÈS
  // le court-circuit VIP et AVANT toute branche d'abonnement : un compte en
  // attente n'a ni essai ni souscription, aucune des branches suivantes ne le
  // décrirait. Sans cette branche il tomberait sur le défaut 'trial_active'
  // (absence de trial_status), c'est-à-dire l'accès complet.
  //
  // Le troisième paramètre porte la lecture de la variable d'environnement.
  // Variable absente : `enAttente` vaut false, cette ligne est un no-op, et la
  // fonction retrouve mot pour mot le comportement qu'elle avait.
  if (enAttente) return 'pending_approval'

  // Branche grâce post-résiliation — évaluée AVANT 'converted' car un
  // user résilié garde trial_status='converted' résiduel (H2b a retiré
  // le swap vers 'expired' du handler customer.subscription.deleted).
  // Option β : fenêtre non calculable (current_period_end absent ou
  // non-parsable) → grace_active. Ne jamais couper sur incertitude —
  // protège le droit d'export RGPD à vie.
  if (user.subscription_status === 'canceled') {
    const periodEndMs = new Date(user.current_period_end).getTime()
    const graceEndMs = periodEndMs + GRACE_MS
    const isGraceActive = !Number.isFinite(graceEndMs) || now < graceEndMs
    return isGraceActive ? 'grace_active' : 'grace_expired'
  }

  // Impayé durable — évalué APRÈS la branche grâce (un impayé qui résilie
  // reste gouverné par subscription_status='canceled' ci-dessus, il garde
  // sa fenêtre de grâce et d'export) et AVANT 'converted' (un impayé porte
  // trial_status='converted' résiduel du checkout). La coupure ne tombe
  // qu'au-delà de 14 j depuis past_due_since. En-deçà, ou si l'horodatage
  // est absent/non-parsable, on ne coupe pas : on retombe sur 'active' via
  // la branche 'converted' — ne jamais couper sur incertitude.
  if (user.subscription_status === 'past_due' && user.past_due_since) {
    const pastDueMs = new Date(user.past_due_since).getTime()
    if (Number.isFinite(pastDueMs) && now >= pastDueMs + PAST_DUE_MS) {
      return 'past_due_locked'
    }
  }

  // Abonné Stripe payant (passe 2, post-checkout).
  if (user.trial_status === 'converted') return 'active'

  // Trial déjà marqué expiré en base.
  if (user.trial_status === 'expired') return 'trial_expired'

  // Trial actif mais date d'expiration dépassée. La fonction retourne
  // 'trial_expired' mais ne fait PAS la bascule DB — c'est au middleware
  // de persister 'expired' (effet de bord local conservé pré/post-H5a).
  if (user.trial_status === 'active' && user.trial_ends_at) {
    const endsAt = new Date(user.trial_ends_at).getTime()
    if (Number.isFinite(endsAt) && endsAt < now) return 'trial_expired'
  }

  // Default : trial_status='active' encore en cours, OU trial_status absent
  // (user pre-migration null) — accès complet en mode essai.
  return 'trial_active'
}
