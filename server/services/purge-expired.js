// Cron quotidien — purge automatique 30 j post-grace_expired (décision 9.16
// Option A + Option β audit_log, actée 22 mai 2026).
//
// SÉLECTION : users dont subscription_status='canceled' ET
// current_period_end + 37d < now (7 j grâce H3 + 30 j fenêtre réactivation
// = 37 j post-current_period_end). L'état grace_expired n'est pas stocké
// en base — il est dérivé par lib/derive-app-state.js. La condition
// équivalente côté SurrealDB est la formule ci-dessus.
//
// BRANCHEMENT : ajoutée à server/services/cron.js dans runTrialJobs() en
// dernière étape après grace_j1. Wrap automatique try/catch + timing +
// audit_log via le helper runStep — chaque exécution écrit un audit_log
// event 'cron:trial:purge' avec metadata du retour de purgeExpiredUsers
// (purgedCount, skippedCount, totalRecordsDeleted, errors, details).
//
// PRÉSERVATION COMPTABLE (Code commerce art. L123-22, conservation 10 ans) :
//   - facture          → NON purgée
//   - counter          → NON purgée (continuité numérotation)
//   - frais            → NON purgée
//   - frais_recurrents → NON purgée
//   - devis filtrés    → seuls les devis NON convertis en facture sont
//                        purgés (préserve devis_id pointé par les factures)
//   - stripe_events_processed → NON purgée (anti-replay webhooks Stripe)
//
// EXCLUSION RGPD OPT-OUT (Phase 9.16 cron purge + Phase 6 Étape 4 tables) :
//   - optout_request   → NON purgée. Conservation 5 ans (prescription
//                        action RGPD art. 12.3, droit de la personne
//                        concernée à exercer un recours après opt-out).
//   - optout_blocklist → NON purgée. Persistante par construction
//                        (anti-réveil : un tiers opt-out le reste même
//                        après suppression du compte qui l'a inscrit ;
//                        la blocklist sert TOUS les abonnés MovUP).
//   Les 2 tables n'ont ni champ userId (SCHEMALESS) ni user_id
//   record<user> (SCHEMAFULL) → hors périmètre des deux boucles par
//   construction. Exclusion figée ici, opposable au sens art. 5-2
//   RGPD (accountability). NE JAMAIS les ajouter à TABLES_SCHEMAFULL
//   ni à TABLES_SCHEMALESS.
//
// ANONYMISATION audit_log (Option β) : avant DELETE user, on SET user_id
// = NONE sur tous les audit_log de ce user. Le type field est option<
// record<user>> (cf. migration 001 l.101) qui accepte NONE. Traçabilité
// technique conservée (event, ip, user_agent, metadata, created_at) pour
// analyse incident ultérieure ; identité nominative supprimée pour RGPD.
//
// RACE WEBHOOK STRIPE : entre le SELECT initial et le DELETE par user,
// un webhook customer.subscription.updated peut réactiver l'abonnement.
// purgeOneUser refait une re-vérification atomique de subscription_status
// + current_period_end juste avant la cascade DELETE. Si l'état a basculé,
// le user est skipé avec log warning et compté dans skippedCount.

import { getDb } from '../../lib/surreal.js'

// Strip le préfixe 'user:' et les guillemets ⟨⟩ du Record ID SurrealDB
// pour obtenir la string brute utilisée comme userId par les tables
// SCHEMALESS (pipeline, contacts, devis, mail, visio*, user_settings,
// user_plan, etc.). Pattern aligné sur cleanUserId de server/routes/stripe.js.
function cleanUserId(raw) {
  return String(raw || '').replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')
}

// 4 tables SCHEMAFULL avec FK record<user> — DELETE pattern :
//   DELETE <table> WHERE user_id = type::record('user', $uid)
// Aucune FK croisée entre elles → ordre indifférent ici.
const TABLES_SCHEMAFULL = [
  'session',
  'verification_token',
  'privacy_export_log',
  'lead_search'
]

// 17 tables SCHEMALESS avec FK string brute userId — DELETE pattern :
//   DELETE <table> WHERE userId = $uid
// ORDRE OBLIGATOIRE : campaign_events AVANT campaigns (FK campaign_id sur
// events, purger campaigns en premier laisserait events orphelins).
// La table devis est traitée séparément ci-dessous (filtre comptable).
const TABLES_SCHEMALESS = [
  'pipeline',
  'contacts',
  'agenda',
  'mail',
  'mail_settings',
  'mailbox_credentials',
  'visio_settings',
  'visio_log',
  'visio_draft',
  'visio_bg_custom',
  'visio_doc',
  'visio_doc_open',
  'user_settings',
  'user_plan',
  'user_plan_history',
  'domains_resend',
  'campaign_events',
  'campaigns'
]

// Cascade de suppression d'un user — factorisée (Phase 6 Étape 13) pour être
// réutilisée par le cron trial purge (purgeOneUser) ET le cron suppression
// compte art. 17 (deletion_scheduled_at). Préserve facture / counter / frais /
// frais_recurrents / stripe_events_processed (Code commerce L123-22, art. 17
// RGPD admet la conservation pour obligation légale) ; anonymise audit_log ;
// DELETE user en dernier. Le uid est nettoyé en interne (accepte 'user:xxx'
// brut ou la string nue). Erreur par table loggée mais non bloquante ; échec
// du DELETE user final retourné dans { userDeleted:false, error }.
export async function deleteUserCascade(rawUid) {
  const uid = String(rawUid || '').replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')
  const db = await getDb()
  const tablesPurgees = []
  let recordCount = 0

  // SCHEMAFULL — FK record<user>
  for (const t of TABLES_SCHEMAFULL) {
    try {
      const r = await db.query(
        `DELETE ${t} WHERE user_id = type::record('user', $uid) RETURN BEFORE`,
        { uid }
      )
      const n = (r?.[0] || []).length
      if (n > 0) { tablesPurgees.push(`${t}:${n}`); recordCount += n }
    } catch (e) {
      console.warn(`[purge] ${t} échec uid=${uid} :`, e.message)
    }
  }

  // SCHEMALESS — FK string brute userId
  for (const t of TABLES_SCHEMALESS) {
    try {
      const r = await db.query(
        `DELETE ${t} WHERE userId = $uid RETURN BEFORE`,
        { uid }
      )
      const n = (r?.[0] || []).length
      if (n > 0) { tablesPurgees.push(`${t}:${n}`); recordCount += n }
    } catch (e) {
      console.warn(`[purge] ${t} échec uid=${uid} :`, e.message)
    }
  }

  // devis filtrés — préserve les devis acceptés convertis en facture
  // (obligation comptable : la facture émise référence devis_id).
  try {
    const r = await db.query(
      `DELETE devis WHERE userId = $uid AND (facture_id IS NONE OR statut != 'accepte') RETURN BEFORE`,
      { uid }
    )
    const n = (r?.[0] || []).length
    if (n > 0) { tablesPurgees.push(`devis:${n}`); recordCount += n }
  } catch (e) {
    console.warn(`[purge] devis filtrés échec uid=${uid} :`, e.message)
  }

  // Anonymisation audit_log (Option β) — UPDATE … SET user_id = NONE.
  let anonymized = 0
  try {
    const r = await db.query(
      `UPDATE audit_log SET user_id = NONE WHERE user_id = type::record('user', $uid) RETURN BEFORE`,
      { uid }
    )
    anonymized = (r?.[0] || []).length
    if (anonymized > 0) tablesPurgees.push(`audit_log_anonymized:${anonymized}`)
  } catch (e) {
    console.warn(`[purge] audit_log anonymisation échec uid=${uid} :`, e.message)
  }

  // DELETE user record final. Échec → { userDeleted:false } (le user "vidé"
  // sera retenté au prochain run du cron).
  let userDeleted = false
  let error = null
  try {
    await db.query(`DELETE type::record('user', $uid)`, { uid })
    tablesPurgees.push('user:1')
    recordCount += 1
    userDeleted = true
  } catch (e) {
    error = 'user_delete_failed: ' + e.message
  }

  return {
    userDeleted,
    error,
    tablesPurgees,
    recordCount,
    tables_preserved: ['facture', 'counter', 'frais', 'frais_recurrents', 'stripe_events_processed', 'devis(accepté→facture)'],
    anonymized
  }
}

// Purge d'un seul user — re-vérifie l'état au DELETE pour le cas où un
// webhook Stripe aurait réactivé l'abonnement entre le SELECT initial
// et l'exécution effective ici. Délègue la cascade à deleteUserCascade.
async function purgeOneUser(db, user) {
  const uid = cleanUserId(user.id)

  // Re-vérification atomique pré-DELETE (anti-race webhook Stripe).
  let recheck
  try {
    const r = await db.query(
      `SELECT subscription_status, current_period_end FROM type::record('user', $uid)`,
      { uid }
    )
    recheck = r?.[0]?.[0]
  } catch (e) {
    return { userId: uid, email: user.email, skipped: true, reason: 'recheck_failed: ' + e.message }
  }
  if (!recheck) {
    return { userId: uid, email: user.email, skipped: true, reason: 'user_not_found_at_recheck' }
  }
  if (recheck.subscription_status !== 'canceled') {
    console.warn('[purge] user', uid, 'réactivé entre SELECT et DELETE (status=' + recheck.subscription_status + '), skip')
    return { userId: uid, email: user.email, skipped: true, reason: 'subscription_status_changed:' + recheck.subscription_status }
  }
  const periodEndMs = new Date(recheck.current_period_end).getTime()
  if (!Number.isFinite(periodEndMs) || (periodEndMs + 37 * 24 * 3600 * 1000) >= Date.now()) {
    console.warn('[purge] user', uid, 'current_period_end recalculé hors fenêtre, skip')
    return { userId: uid, email: user.email, skipped: true, reason: 'period_end_changed' }
  }

  // Cascade factorisée (Phase 6 Étape 13) — réutilisée par le cron suppression
  // compte art. 17. Préservation comptable + anonymisation audit_log internes.
  const cascade = await deleteUserCascade(uid)
  if (!cascade.userDeleted) {
    return { userId: uid, email: user.email, error: cascade.error, tablesPurgees: cascade.tablesPurgees, recordCount: cascade.recordCount }
  }
  return { userId: uid, email: user.email, tablesPurgees: cascade.tablesPurgees, recordCount: cascade.recordCount }
}

// Job principal — sélectionne tous les candidats puis cascade purgeOneUser
// par user en séquentiel (pas de parallel, on ne hammer pas la DB cloud).
// Erreur sur un user n'interrompt pas la boucle : le user en échec est
// loggé et compté dans errors[], les autres continuent.
export async function purgeExpiredUsers() {
  const db = await getDb()

  // Sélection candidats — formule native SurrealDB : current_period_end
  // + 37d < time::now(). Cohérent avec la durée 37 j = 7 j grâce + 30 j
  // fenêtre. Filtre current_period_end IS NOT NONE par sécurité (un user
  // canceled sans period_end est ambigu, on ne le purge pas par défaut).
  let candidates = []
  try {
    const r = await db.query(
      `SELECT id, email, current_period_end FROM user
       WHERE subscription_status = 'canceled'
         AND current_period_end IS NOT NONE
         AND current_period_end + 37d < time::now()`
    )
    candidates = r?.[0] || []
  } catch (e) {
    console.warn('[purge] SELECT candidates échoué :', e.message)
    return {
      purgedCount: 0,
      skippedCount: 0,
      totalRecordsDeleted: 0,
      candidates: 0,
      errors: [{ stage: 'select', message: e.message }]
    }
  }

  if (!candidates.length) {
    return {
      purgedCount: 0,
      skippedCount: 0,
      totalRecordsDeleted: 0,
      candidates: 0
    }
  }

  // Boucle séquentielle
  let purgedCount = 0
  let skippedCount = 0
  let totalRecordsDeleted = 0
  const errors = []
  const details = []

  for (const user of candidates) {
    try {
      const res = await purgeOneUser(db, user)
      if (res.skipped) {
        skippedCount++
      } else if (res.error) {
        errors.push({ userId: res.userId, email: res.email, error: res.error })
      } else {
        purgedCount++
        totalRecordsDeleted += res.recordCount || 0
      }
      details.push(res)
    } catch (e) {
      console.warn('[purge] user purgeOne échec :', user.email, e.message)
      errors.push({ userId: cleanUserId(user.id), email: user.email, error: e.message })
    }
  }

  return {
    purgedCount,
    skippedCount,
    totalRecordsDeleted,
    candidates: candidates.length,
    errors,
    details
  }
}
