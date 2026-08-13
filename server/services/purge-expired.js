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
import { decryptMailToken } from '../../lib/crypto.js'
import { revokeRefreshToken } from '../../lib/oauth-google.js'
import { isVip } from '../../lib/vip.js'

// Strip le préfixe 'user:' et les guillemets ⟨⟩ du Record ID SurrealDB
// pour obtenir la string brute utilisée comme userId par les tables
// SCHEMALESS (pipeline, contacts, societes, devis, mail, visio*, user_settings,
// user_plan, etc.). Pattern aligné sur cleanUserId de server/routes/stripe.js.
function cleanUserId(raw) {
  return String(raw || '').replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')
}

// Strip le préfixe 'campaigns:' et les guillemets ⟨⟩ d'un Record ID de campagne.
// ALIGNÉ SUR LE WEBHOOK RESEND (server.js ~5278) qui écrit campaign_events.
// campaign_id comme string BRUTE via exactement ce nettoyage. La suppression
// des events (deleteUserCascade) DOIT comparer avec le même format, sinon la
// clause ne matche rien et reproduit le défaut d'events orphelins qu'on corrige.
function cleanCampaignId(raw) {
  return String(raw || '').replace(/^campaigns:/, '').replace(/^⟨+|⟩+$/g, '')
}

// 6 tables SCHEMAFULL avec FK record<user> — DELETE pattern :
//   DELETE <table> WHERE user_id = type::record('user', $uid)
// Aucune FK croisée entre elles → ordre indifférent ici.
// lead_contact_edit et lead_enrichment sont des traces d'usage que l'abonnée ne
// voit jamais : raison de plus pour qu'elles partent avec son compte.
const TABLES_SCHEMAFULL = [
  'session',
  'verification_token',
  'privacy_export_log',
  'lead_search',
  'lead_contact_edit',
  'lead_enrichment'
]

// 17 tables SCHEMALESS avec FK string brute userId — DELETE pattern :
//   DELETE <table> WHERE userId = $uid
// TRAITÉES HORS BOUCLE (voir deleteUserCascade) :
//   - mailbox_credentials → révocation OAuth Google avant DELETE (par ownerId,
//     pas userId) ; extraite pour révoquer chaque refresh_token best effort.
//   - campaign_events → aucun champ user ; lien indirect campaign_id →
//     campaigns.userId. Extraite et supprimée AVANT campaigns (dont le DELETE
//     effacerait les ids nécessaires au rattachement des events).
// campaigns RESTE dans cette boucle (FK userId directe) et est supprimée après
// ses events. La table devis est traitée séparément ci-dessous (filtre comptable).
const TABLES_SCHEMALESS = [
  'pipeline',
  'contacts',
  // societes — manquait depuis l'origine de la table. Elle porte les raisons
  // sociales et les coordonnées des prospects, sous userId comme ses voisines :
  // un compte supprimé les laissait derrière lui.
  'societes',
  'agenda',
  'mail',
  'mail_settings',
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

  // mailbox_credentials — traitée HORS boucle générique. Deux raisons : la FK
  // est ownerId (pas userId), et un DELETE nu laisserait des refresh_token
  // Google actifs côté Google. On révoque donc AVANT de supprimer.
  // IMPÉRATIF RGPD (art. 17) : une révocation qui échoue ne doit JAMAIS empêcher
  // la suppression d'aboutir. Chaque échec (déchiffrement OU appel Google) est
  // attrapé INDIVIDUELLEMENT et journalisé, jamais bloquant : un credential en
  // échec n'interrompt pas le traitement des suivants, et l'utilisateur doit
  // pouvoir disparaître même si Google est indisponible.
  // Microsoft : PAS de révocation ici (no-op documenté — la révocation MS ne
  // prend pas le refresh_token en paramètre, l'app-consent se gère côté tenant),
  // mais les credentials MS sont supprimés comme les autres par le DELETE final,
  // qui couvre tous les providers via ownerId.
  try {
    const r = await db.query(
      `SELECT provider, refreshToken FROM mailbox_credentials WHERE ownerId = $uid`,
      { uid }
    )
    const creds = r?.[0] || []
    for (const cred of creds) {
      if (cred?.provider !== 'google' || !cred.refreshToken) continue
      try {
        const plain = decryptMailToken(cred.refreshToken)
        // revokeRefreshToken est non-throw et journalise son échec en interne
        // (motif compris) ; on n'interrompt jamais la cascade sur son retour.
        await revokeRefreshToken(plain)
      } catch (e) {
        console.warn(`[purge] révocation Google échec uid=${uid} :`, e.message)
      }
    }
  } catch (e) {
    console.warn(`[purge] mailbox_credentials SELECT échec uid=${uid} :`, e.message)
  }
  try {
    const r = await db.query(
      `DELETE mailbox_credentials WHERE ownerId = $uid RETURN BEFORE`,
      { uid }
    )
    const n = (r?.[0] || []).length
    if (n > 0) { tablesPurgees.push(`mailbox_credentials:${n}`); recordCount += n }
  } catch (e) {
    console.warn(`[purge] mailbox_credentials DELETE échec uid=${uid} :`, e.message)
  }

  // campaign_events — traitée HORS boucle générique et AVANT campaigns. La table
  // n'a AUCUN champ user : le seul lien est indirect via campaign_id →
  // campaigns.userId. On récupère donc d'abord les ids de campagne du user, puis
  // on supprime les events rattachés. L'ORDRE N'EST PLUS DÉCORATIF, IL EST
  // NÉCESSAIRE : le DELETE campaigns de la boucle générique ci-dessous efface
  // ces ids ; sans eux, les events ne seraient plus rattachables et resteraient
  // orphelins. FORMAT : campaign_id est stocké par le webhook Resend
  // (server.js ~5278) comme string BRUTE (préfixe `campaigns:` + chevrons ⟨⟩
  // retirés) ; cleanCampaignId aligne la clause sur ce même format.
  try {
    const r = await db.query(
      `SELECT id FROM campaigns WHERE userId = $uid`,
      { uid }
    )
    const camps = r?.[0] || []
    let evDeleted = 0
    for (const c of camps) {
      const cid = cleanCampaignId(c.id)
      try {
        const dr = await db.query(
          `DELETE campaign_events WHERE campaign_id = $cid RETURN BEFORE`,
          { cid }
        )
        evDeleted += (dr?.[0] || []).length
      } catch (e) {
        console.warn(`[purge] campaign_events DELETE échec uid=${uid} camp=${cid} :`, e.message)
      }
    }
    if (evDeleted > 0) { tablesPurgees.push(`campaign_events:${evDeleted}`); recordCount += evDeleted }
  } catch (e) {
    console.warn(`[purge] campaigns SELECT (pour events) échec uid=${uid} :`, e.message)
  }

  // SCHEMALESS — FK string brute userId (campaigns supprimée ici, après ses events)
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

// ─────────────────────────────────────────────────────────────────────────────
// SECONDE BOUCLE — essais jamais convertis (décision chantier D, Sujet 2).
//
// La boucle purgeExpiredUsers ci-dessus ne vise QUE les abonnements résiliés
// (subscription_status='canceled'), ancrée sur current_period_end + 37 j. Un
// compte dont l'essai s'achève sans souscription n'a ni statut d'abonnement ni
// période payée : il sortait de toute boucle et restait sans terme. Cette
// boucle-ci l'ancre sur trial_ends_at + 30 j.
//
// EXCLUSION CONTOURNEMENT : les comptes VIP (propriétaire par email OU drapeau
// bypass posé au tableau superadmin) portent souvent aucun abonnement + un
// essai expiré — ils entreraient donc dans la sélection. On les écarte avec le
// MÊME helper que deriveAppState : isVip (lib/vip.js). Le filtre SQL bypass !=
// true dégrossit ; la garde unitaire applique isVip sur le record complet, ce
// qui couvre AUSSI le propriétaire par email (bypass éventuellement non posé).
//
// RÉUTILISE la cascade deleteUserCascade telle quelle (agnostique de Stripe).
// NE RÉUTILISE PAS purgeOneUser : sa re-vérification exige subscription_status
// ='canceled' (l.298) et recalcule current_period_end + 37d (l.303) — elle
// écarterait systématiquement un essai. purgeOneTrialUser en est la jumelle.

const TRIAL_PURGE_DAYS = 30
const TRIAL_PURGE_MS = TRIAL_PURGE_DAYS * 24 * 3600 * 1000

// Délai plein garanti entre l'avertissement et la suppression. La suppression
// s'ancre sur DEUX dates à la fois — fin d'essai + 30 j ET avertissement + 7 j.
// Cette double ancre garantit, quel que soit le nombre de journées de cron
// manquées : AUCUN compte sans terme (la fenêtre d'avertissement est rattrapante,
// donc tout essai finit par être prévenu → le drapeau finit posé → la purge
// devient éligible) et AUCUN départ sans préavis (7 j pleins comptés depuis
// l'envoi effectif, même pour un averti tardif). Chemin nominal inchangé :
// averti à J+23, les deux échéances tombent ensemble à J+30.
const WARNING_LEAD_DAYS = 7
const WARNING_LEAD_MS = WARNING_LEAD_DAYS * 24 * 3600 * 1000

// Garde unitaire jumelle de purgeOneUser — re-vérifie juste avant le DELETE
// (anti-race : quelqu'un a pu s'abonner entre le SELECT et l'exécution ici).
// Revérifie : absence d'abonnement, essai non converti, échéance dépassée,
// absence de contournement. Puis délègue à deleteUserCascade.
async function purgeOneTrialUser(db, user) {
  const uid = cleanUserId(user.id)

  // Re-lecture du record complet (email + bypass nécessaires à isVip ;
  // trial_purge_warning_sent_at pour la garde « jamais sans avertissement »).
  let recheck
  try {
    const r = await db.query(
      `SELECT email, bypass, subscription_status, trial_status, trial_ends_at,
              trial_purge_warning_sent_at
       FROM type::record('user', $uid)`,
      { uid }
    )
    recheck = r?.[0]?.[0]
  } catch (e) {
    return { userId: uid, email: user.email, skipped: true, reason: 'recheck_failed: ' + e.message }
  }
  if (!recheck) {
    return { userId: uid, email: user.email, skipped: true, reason: 'user_not_found_at_recheck' }
  }
  // Contournement — MÊME règle que deriveAppState (propriétaire OU bypass).
  if (isVip(recheck)) {
    console.warn('[purge:trial] user', uid, 'en contournement (VIP), skip')
    return { userId: uid, email: user.email, skipped: true, reason: 'bypass' }
  }
  // JAMAIS de suppression sans avertissement préalable — deuxième couche,
  // jumelle du filtre SQL. La fenêtre d'avertissement (trial-emails.js) ne
  // dure que 24 h : un cron manqué la ferait traverser sans envoi, puis
  // supprimer en silence 7 j plus tard. On l'interdit ici.
  // CONSÉQUENCE ASSUMÉE : un compte que l'avertissement a manqué n'est PAS
  // supprimé à J+30 — il attend d'avoir été prévenu. (La fenêtre étant fixe
  // à J+23 ±12 h, elle ne le rattrape pas d'elle-même : voir rapport, geste
  // minimal proposé hors de ce commit.)
  if (!recheck.trial_purge_warning_sent_at) {
    console.warn('[purge:trial] user', uid, 'jamais averti, skip (attend l\'avertissement)')
    return { userId: uid, email: user.email, skipped: true, reason: 'not_warned' }
  }
  // Un abonnement a été souscrit entre SELECT et DELETE → plus un essai nu.
  if (recheck.subscription_status != null) {
    console.warn('[purge:trial] user', uid, 'a désormais un abonnement (status=' + recheck.subscription_status + '), skip')
    return { userId: uid, email: user.email, skipped: true, reason: 'subscription_status_changed:' + recheck.subscription_status }
  }
  // Converti entre-temps (checkout sans passage par subscription_status ?).
  if (recheck.trial_status === 'converted') {
    console.warn('[purge:trial] user', uid, 'converti entre SELECT et DELETE, skip')
    return { userId: uid, email: user.email, skipped: true, reason: 'trial_converted' }
  }
  // Double ancre — les deux échéances doivent être franchies (cf. WARNING_LEAD_MS).
  // (1) fin d'essai + 30 j.
  const endsAtMs = new Date(recheck.trial_ends_at).getTime()
  if (!Number.isFinite(endsAtMs) || (endsAtMs + TRIAL_PURGE_MS) >= Date.now()) {
    console.warn('[purge:trial] user', uid, 'trial_ends_at recalculé hors fenêtre, skip')
    return { userId: uid, email: user.email, skipped: true, reason: 'trial_ends_at_changed' }
  }
  // (2) avertissement + 7 j — garantit 7 j pleins depuis l'envoi effectif, même
  // à un averti tardif (fenêtre rattrapante). Jumelle du filtre SQL.
  const warnedAtMs = new Date(recheck.trial_purge_warning_sent_at).getTime()
  if (!Number.isFinite(warnedAtMs) || (warnedAtMs + WARNING_LEAD_MS) >= Date.now()) {
    console.warn('[purge:trial] user', uid, 'avertissement trop récent (< 7 j), skip')
    return { userId: uid, email: user.email, skipped: true, reason: 'warning_too_recent' }
  }

  // Cascade factorisée — identique à celle des résiliés (réemployable telle
  // quelle, elle ne suppose aucun abonnement Stripe).
  const cascade = await deleteUserCascade(uid)
  if (!cascade.userDeleted) {
    return { userId: uid, email: user.email, error: cascade.error, tablesPurgees: cascade.tablesPurgees, recordCount: cascade.recordCount }
  }
  return { userId: uid, email: user.email, tablesPurgees: cascade.tablesPurgees, recordCount: cascade.recordCount }
}

// Job principal — jumeau de purgeExpiredUsers, ancré sur la fin d'essai.
// Journalise purgedCount / skippedCount / totalRecordsDeleted sur le même motif.
export async function purgeExpiredTrials() {
  const db = await getDb()

  // Sélection candidats :
  //   subscription_status IS NONE      → jamais passé au paiement (écarte
  //                                       active/past_due/canceled/unpaid/…).
  //   trial_status != 'converted'      → écarte les convertis (double garde ;
  //                                       NONE et 'expired'/'active' passent).
  //   trial_ends_at IS NOT NONE        → exige l'ancre de calcul (sinon ambigu).
  //   trial_ends_at + 30d < time::now() → échéance : 30 j après la fin d'essai.
  //   bypass != true                   → écarte le contournement (drapeau
  //                                       superadmin). Complété par isVip côté
  //                                       garde unitaire (couvre le propriétaire).
  //   trial_purge_warning_sent_at IS NOT NONE → JAMAIS de suppression sans
  //                                       avertissement préalable. Redoublé par
  //                                       la garde unitaire.
  //   trial_purge_warning_sent_at + 7d < now  → DOUBLE ANCRE : la suppression
  //                                       exige AUSSI 7 j pleins depuis l'envoi
  //                                       de l'avertissement, pas seulement 30 j
  //                                       depuis la fin d'essai. Un averti tardif
  //                                       (cron manqué, fenêtre rattrapante)
  //                                       obtient toujours son préavis complet.
  let candidates = []
  try {
    const r = await db.query(
      `SELECT id, email, trial_ends_at FROM user
       WHERE subscription_status IS NONE
         AND trial_status != 'converted'
         AND trial_ends_at IS NOT NONE
         AND trial_ends_at + 30d < time::now()
         AND bypass != true
         AND trial_purge_warning_sent_at IS NOT NONE
         AND trial_purge_warning_sent_at + 7d < time::now()`
    )
    candidates = r?.[0] || []
  } catch (e) {
    console.warn('[purge:trial] SELECT candidates échoué :', e.message)
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

  // Boucle séquentielle (pas de parallel, on ne hammer pas la DB cloud).
  let purgedCount = 0
  let skippedCount = 0
  let totalRecordsDeleted = 0
  const errors = []
  const details = []

  for (const user of candidates) {
    try {
      const res = await purgeOneTrialUser(db, user)
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
      console.warn('[purge:trial] user purgeOne échec :', user.email, e.message)
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
