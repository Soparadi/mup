// Middleware requireActiveSubscription — bloque les écritures pour les
// utilisateurs dont l'essai 14 jours a expiré.
//
// Logique :
//   - 'converted'  : abonné Stripe (passe 2), tout passe
//   - 'active'     : essai en cours, tout passe (et bascule auto en 'expired'
//                    si trial_ends_at < now)
//   - 'expired'    : retourne 402 Payment Required avec details JSON pour
//                    déclencher le popup côté front
//   - undefined / null : pas de trial_status (utilisateur antérieur à la
//                    migration), passe par défaut — sera capté par le script
//                    one-shot scripts/migrate-trial-status.js
//
// Routes EXEMPTÉES (filtrage en amont via la gate /api dans server.js — ce
// middleware ne reçoit que les requêtes qui doivent être contrôlées) :
//   - /api/auth/*                       → flux d'authentification de base
//   - /api/health                       → check serveur public
//   - /api/v2/webhooks/*                → webhooks externes (Resend HMAC)
//   - /api/public/*                     → démo publique landing
//   - /api/stripe/*                     → paiement (passe 2) accessible même
//                                         si trial expiré
//   - /api/user/me                      → état trial accessible (popup l'utilise)
//   - /api/account/privacy/export       → RGPD article 20 à vie
//   - GET (toute méthode non mutative)  → lecture seule autorisée même expiré

import { getDb } from '../../lib/surreal.js'

const MUTATIVE_METHODS = ['POST', 'PUT', 'DELETE', 'PATCH']

export async function requireActiveSubscription(req, res, next) {
  // Méthodes lecture seule : passent toujours (même pour user 'expired')
  if (!MUTATIVE_METHODS.includes(req.method)) return next()

  // req.authUser est posé par requireAuth (session JOIN sur user_id.*) — il
  // contient les champs frais (incluant trial_status, trial_ends_at, plan).
  const user = req.authUser
  if (!user) return res.status(401).json({ error: 'unauthorized' })

  // GRÂCE 7j post-résiliation — DOIT être évalué AVANT la branche
  // 'converted' ci-dessous : un user résilié garde trial_status=
  // 'converted' résiduel (H2b a retiré le swap vers 'expired' du
  // handler customer.subscription.deleted), donc le return next()
  // de converted lui rendrait un accès complet. Condition
  // d'activation : subscription_status === 'canceled' UNIQUEMENT
  // (jamais trial_status, résiduel et trompeur sur les résiliés).
  // La l.32 a déjà court-circuité GET/HEAD : seules les mutations
  // arrivent ici, donc grace_active comme grace_expired ne bloquent
  // de fait que les mutations (option A — calque trial_expired).
  if (user.subscription_status === 'canceled') {
    const periodEndMs = new Date(user.current_period_end).getTime()
    const graceEndMs = periodEndMs + 7 * 24 * 3600 * 1000
    const graceEndIso = Number.isFinite(graceEndMs)
      ? new Date(graceEndMs).toISOString() : null
    // Option β : fenêtre non calculable (current_period_end absent
    // ou non-parsable) → grace_active. Ne jamais couper sur une
    // incertitude — protège le droit d'export RGPD à vie.
    const isGraceActive = !Number.isFinite(graceEndMs) || Date.now() < graceEndMs
    if (isGraceActive) {
      return res.status(402).json({
        error: 'grace_active',
        message: 'Votre abonnement a pris fin. Vous pouvez exporter vos données jusqu\'au terme de la période de récupération.',
        period_end: user.current_period_end || null,
        grace_until: graceEndIso
      })
    }
    return res.status(402).json({
      error: 'grace_expired',
      message: 'Votre période de récupération est terminée. Réabonnez-vous pour retrouver l\'accès à votre compte.',
      period_end: user.current_period_end || null
    })
  }

  // Abonné Stripe (passe 2) — tout passe sans contrôle.
  if (user.trial_status === 'converted') return next()

  // Bascule auto active → expired si trial_ends_at est passé.
  // Best effort : si l'UPDATE échoue, on continue avec la valeur en mémoire
  // (le user passe pour cette requête, sera bloqué au prochain appel).
  if (user.trial_status === 'active' && user.trial_ends_at) {
    const endsAt = new Date(user.trial_ends_at).getTime()
    if (Number.isFinite(endsAt) && endsAt < Date.now()) {
      try {
        const db = await getDb()
        const cleanId = String(user.id).replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')
        await db.query(
          `UPDATE type::record('user', $id) SET trial_status = 'expired'`,
          { id: cleanId }
        )
        user.trial_status = 'expired'
      } catch (e) {
        console.warn('[subscription] flip active→expired échoué :', e.message)
      }
    }
  }

  if (user.trial_status === 'expired') {
    return res.status(402).json({
      error: 'trial_expired',
      message: 'Votre essai gratuit est terminé. Choisissez un abonnement pour continuer.',
      trial_ends_at: user.trial_ends_at || null
    })
  }

  // 'active' encore en cours, ou trial_status absent (user pre-migration) :
  // on passe.
  next()
}
