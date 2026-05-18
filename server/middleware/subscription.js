// Middleware requireActiveSubscription — bloque les écritures pour les
// utilisateurs dont l'essai 14 jours a expiré OU la grâce 7j post-
// résiliation est terminée.
//
// Logique de dérivation d'état : factorisée dans lib/derive-app-state.js
// (deriveAppState) — source unique partagée avec /api/user/me et
// window.__USER__ (server.js). Le middleware se borne à : appeler la
// fonction, persister la bascule active→expired en DB si nécessaire
// (effet de bord local conservé du middleware pré-H5a), et dispatcher
// la réponse HTTP (402 ou next()).
//
// Routes EXEMPTÉES (filtrage en amont via la gate /api dans server.js — ce
// middleware ne reçoit que les requêtes qui doivent être contrôlées) :
//   - /api/auth/*                       → flux d'authentification de base
//   - /api/health                       → check serveur public
//   - /api/v2/webhooks/*                → webhooks externes (Resend HMAC)
//   - /api/public/*                     → démo publique landing
//   - /api/stripe/*                     → paiement accessible même expiré
//   - /api/user/me                      → état d'abonnement accessible
//                                         (popup + window.__USER__ l'utilisent)
//   - /api/account/privacy/export       → RGPD article 20 à vie
//   - GET (toute méthode non mutative)  → lecture seule autorisée même expiré

import { getDb } from '../../lib/surreal.js'
import { deriveAppState } from '../../lib/derive-app-state.js'

const MUTATIVE_METHODS = ['POST', 'PUT', 'DELETE', 'PATCH']

export async function requireActiveSubscription(req, res, next) {
  // Méthodes lecture seule : passent toujours (même pour user 'expired')
  if (!MUTATIVE_METHODS.includes(req.method)) return next()

  // req.authUser est posé par requireAuth (session JOIN sur user_id.*) — il
  // contient les champs frais (incluant trial_status, trial_ends_at, plan).
  const user = req.authUser
  if (!user) return res.status(401).json({ error: 'unauthorized' })

  // Source unique de vérité (H5a) : lib/derive-app-state.js. La fonction
  // pure retourne uniquement un label parmi 'trial_active' | 'trial_expired'
  // | 'grace_active' | 'grace_expired' | 'active'.
  const label = deriveAppState(user)

  // Bascule DB best-effort (effet de bord local conservé pré/post-H5a) :
  // si la fonction pure dit 'trial_expired' alors que la base porte encore
  // 'active', on persiste l'expiration — fraîcheur garantie pour le
  // prochain appel + cohérence avec expireTrialAutomatically (cron H4).
  // Échec silencieux : le user passe pour cette requête, sera bloqué au
  // prochain appel.
  if (label === 'trial_expired' && user.trial_status === 'active') {
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

  // Dispatch HTTP — bodies 402 STRICTEMENT IDENTIQUES à l'existant pré-H5a
  // (mêmes champs error/message/period_end/grace_until/trial_ends_at, même
  // texte). grace_until est recalculé localement (1 ligne) car la fonction
  // pure retourne uniquement le label string (cf décision H5a #3).
  switch (label) {
    case 'grace_active': {
      const periodEndMs = new Date(user.current_period_end).getTime()
      const graceEndMs = periodEndMs + 7 * 24 * 3600 * 1000
      const graceEndIso = Number.isFinite(graceEndMs)
        ? new Date(graceEndMs).toISOString() : null
      return res.status(402).json({
        error: 'grace_active',
        message: 'Votre abonnement a pris fin. Vous pouvez exporter vos données jusqu\'au terme de la période de récupération.',
        period_end: user.current_period_end || null,
        grace_until: graceEndIso
      })
    }
    case 'grace_expired':
      return res.status(402).json({
        error: 'grace_expired',
        message: 'Votre période de récupération est terminée. Réabonnez-vous pour retrouver l\'accès à votre compte.',
        period_end: user.current_period_end || null
      })
    case 'trial_expired':
      return res.status(402).json({
        error: 'trial_expired',
        message: 'Votre essai gratuit est terminé. Choisissez un abonnement pour continuer.',
        trial_ends_at: user.trial_ends_at || null
      })
    case 'active':
    case 'trial_active':
    default:
      return next()
  }
}
