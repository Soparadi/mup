// Emails de prévention essai 14 jours — J-2 et J-0.
//
// Câblées au cron quotidien via cron.js (runTrialJobs). Idempotent — chaque
// user reçoit au plus un email J-2 et un email J-0, l'unicité étant garantie
// par les flags DB trial_email_j*_sent_at posés après chaque envoi réussi :
//   await sendTrialEndingSoonEmails()   // J-2
//   await sendTrialEndingTodayEmails()  // J-0
//   await expireTrialAutomatically()    // bascule active → expired pour les inactifs

import { getDb } from '../../lib/surreal.js'
import { compterEcheances } from '../../lib/echeances.js'
import { sendSubscriptionGraceEndingTomorrow, sendTrialDataDeletionWarning, sendTrialEndingSoon, sendTrialEndingToday } from './email.js'
import { PLAN_LABELS } from '../../lib/stripe-config.js'
import { isVip } from '../../lib/vip.js'

const APP_URL = (process.env.APP_URL || 'https://movup.io').replace(/\/+$/, '')

// ─── Clauses d'échéance ──────────────────────────────────────────────────────
// Une par étape, posée à côté de la sélection qu'elle garde. Chacune compte les
// comptes dont LA DATE D'ACTION DE L'ÉTAPE — pas le champ brut — tombe dans les
// sept jours à venir. Arithmétique native exclusivement : c'est la condition
// pour que le garde ne prenne pas le chemin qu'il garde (voir lib/echeances.js,
// qui porte aussi la réserve de lecture de ces chiffres).
//
// J-2 : la date d'action est trial_ends_at - 2d.
const ECHEANCES_J2 = `trial_status = 'active'
   AND trial_email_j2_sent_at IS NONE
   AND trial_ends_at IS NOT NONE
   AND trial_ends_at - 2d >  time::now()
   AND trial_ends_at - 2d <= time::now() + 7d`

// J-0 : la date d'action est trial_ends_at lui-même.
const ECHEANCES_J0 = `trial_status = 'active'
   AND trial_email_j0_sent_at IS NONE
   AND trial_ends_at IS NOT NONE
   AND trial_ends_at >  time::now()
   AND trial_ends_at <= time::now() + 7d`

// Bascule automatique : même ancre que J-0, mais sur toute la population active
// (aucun drapeau d'envoi ne la borne). Ce compteur est donc normalement ≥ celui
// de J-0 — les deux ne s'égalent que si aucun J-0 n'est encore parti.
const ECHEANCES_EXPIRE = `trial_status = 'active'
   AND trial_ends_at IS NOT NONE
   AND trial_ends_at >  time::now()
   AND trial_ends_at <= time::now() + 7d`

// Grâce J-1 : la date d'action est current_period_end + 6d.
const ECHEANCES_GRACE_J1 = `subscription_status = 'canceled'
   AND grace_j_minus_1_sent_at IS NONE
   AND current_period_end IS NOT NONE
   AND current_period_end + 6d >  time::now()
   AND current_period_end + 6d <= time::now() + 7d`

// Avertissement de purge : la date d'action est trial_ends_at + 23d.
const ECHEANCES_PURGE_WARN = `subscription_status IS NONE
   AND (trial_status = 'active' OR trial_status = 'expired')
   AND trial_ends_at IS NOT NONE
   AND trial_purge_warning_sent_at IS NONE
   AND bypass != true
   AND trial_ends_at + 23d >  time::now()
   AND trial_ends_at + 23d <= time::now() + 7d`

// Les bornes sont liées en chaîne ISO : comparer un champ `datetime` à une
// `string` ne compare pas des instants — `>=` rend toujours true et `<` toujours
// false, donc la fenêtre ne rendait personne ; `type::datetime()` reconvertit la
// borne côté serveur et la comparaison redevient temporelle.
//
// Sélection des users dont trial_ends_at tombe dans une fenêtre [from, to]
// ET qui n'ont pas déjà reçu l'email de la fenêtre concernée (flag DB).
// La fenêtre temporelle reste un filtre primaire ; le flag DB garantit
// l'idempotence stricte (cron qui retourne 2× le même jour, redémarrage
// Railway dans la fenêtre, etc.).
//
// REND SON ÉCHEC. `{ users, error }` et non un tableau nu : une sélection qui
// échouait rendait `[]`, l'appelant sortait par son retour anticipé et l'audit
// affichait une journée creuse — indiscernable d'une journée sans échéance.
// C'est la cécité du 16 août. La connexion est prise DANS le try pour que même
// une base injoignable sorte en bande, jamais en exception.
async function findUsersInWindow(from, to, sentFlag) {
  try {
    const db = await getDb()
    const r = await db.query(
      `SELECT id, email, prenom, nom, trial_ends_at FROM user
       WHERE trial_status = 'active'
         AND trial_ends_at >= type::datetime($from) AND trial_ends_at < type::datetime($to)
         AND ${sentFlag} IS NONE`,
      { from: from.toISOString(), to: to.toISOString() }
    )
    return { users: r?.[0] || [], error: null }
  } catch (e) {
    console.warn('[trial-emails] findUsersInWindow échoué :', e.message)
    return { users: [], error: e.message }
  }
}

// Sélection des users résiliés (subscription_status='canceled') dont la fin
// de grâce 7j tombe demain — c'est-à-dire dont current_period_end est passé
// il y a 6j, donc current_period_end + 7j = demain. Calque strict de
// findUsersInWindow mais sur le scope canceled (requête disjointe des jobs
// trial : un canceled a trial_status='converted' résiduel mais ne sera
// jamais sélectionné par findUsersInWindow qui filtre trial_status='active').
// Rend son échec sur le même motif que findUsersInWindow.
async function findCanceledUsersInWindow(from, to) {
  try {
    const db = await getDb()
    const r = await db.query(
      `SELECT id, email, prenom, nom, plan, current_period_end FROM user
       WHERE subscription_status = 'canceled'
         AND current_period_end >= type::datetime($from) AND current_period_end < type::datetime($to)
         AND grace_j_minus_1_sent_at IS NONE`,
      { from: from.toISOString(), to: to.toISOString() }
    )
    return { users: r?.[0] || [], error: null }
  } catch (e) {
    console.warn('[trial-emails] findCanceledUsersInWindow échoué :', e.message)
    return { users: [], error: e.message }
  }
}

// Marque un user comme ayant reçu l'email <sentFlag>. Rend TRUE si le drapeau
// est réellement posé, FALSE sinon — l'appelant a besoin de la différence : un
// email parti dont le drapeau n'est pas posé ressort du SELECT au passage
// suivant et serait renvoyé.
//
// Contre quoi ce drapeau protège : DEUX PASSAGES DANS LA MÊME BANDE DE 24 H
// (relance manuelle, redémarrage Railway, cron rejoué). Les fenêtres
// successives pavent le temps sans se recouvrir — d'un tour à l'autre, un user
// déjà traité est de toute façon sorti de la fenêtre ; ce n'est donc jamais du
// tour suivant que vient le double envoi, mais du tour REJOUÉ.
//
// Deux façons d'échouer, toutes deux rendues false :
//   — la requête lève (socket coupée, permission refusée) → catch ;
//   — la requête passe mais ne touche AUCUN enregistrement, sans erreur :
//     UPDATE n'upserte pas, un identifiant disparu entre le SELECT et l'envoi
//     (compte supprimé, purgé) rend un tableau VIDE. Mesuré le 19/08/2026
//     contre movup-prod (surrealdb 3.2.4) : [] sur identifiant inexistant.
//
// La connexion est prise DANS le try : cette fonction est appelée hors du try
// de la boucle appelante, une base injoignable y lèverait et emporterait les
// envois restants au lieu de coûter un seul drapeau.
async function markEmailSent(userId, sentFlag) {
  try {
    const db = await getDb()
    const r = await db.query(
      `UPDATE $id SET ${sentFlag} = time::now()`,
      { id: userId }
    )
    if (!(r?.[0] || []).length) {
      console.warn(`[trial-emails] markEmailSent ${sentFlag} : aucun enregistrement touché pour`, String(userId))
      return false
    }
    return true
  } catch (e) {
    console.warn(`[trial-emails] markEmailSent ${sentFlag} échoué pour`, String(userId), ':', e.message)
    return false
  }
}

// Envoi unique J-2 (fenêtre 24h autour de NOW + 2j).
export async function sendTrialEndingSoonEmails() {
  const TWO_J = 2 * 24 * 3600 * 1000
  const HALF = 12 * 3600 * 1000
  const now = Date.now()
  const from = new Date(now + TWO_J - HALF)
  const to = new Date(now + TWO_J + HALF)
  const { users, error: selectError } = await findUsersInWindow(from, to, 'trial_email_j2_sent_at')
  // Compté À CHAQUE PASSAGE, y compris quand la sélection est vide ou cassée :
  // c'est précisément là qu'il informe. Posé avant les retours anticipés pour
  // que la forme des clés ne dépende pas du chemin pris.
  const echeances_7j = await compterEcheances('j2', ECHEANCES_J2)
  if (selectError) {
    return { sent: 0, flag_failed: 0, total: 0, echeances_7j, errors: [{ stage: 'select', error: selectError }] }
  }
  if (!users.length) return { sent: 0, flag_failed: 0, total: 0, echeances_7j, errors: [] }
  let sent = 0
  let flagFailed = 0
  const errors = []
  for (const u of users) {
    try {
      await sendTrialEndingSoon({ prenom: u.prenom, nom: u.nom, email: u.email })
    } catch (e) {
      console.warn('[trial-emails] J-2 envoi échec :', u.email, e.message)
      errors.push({ email: u.email, stage: 'send', error: e.message })
      continue
    }
    // L'email est PARTI : il compte comme envoyé, quel que soit le sort du
    // drapeau. Le compteur qui suit dit l'autre chose — le drapeau manquant
    // laisse l'user éligible au prochain SELECT, donc renvoyable.
    sent++
    if (!await markEmailSent(u.id, 'trial_email_j2_sent_at')) {
      flagFailed++
      errors.push({ email: u.email, stage: 'flag', error: 'trial_email_j2_sent_at non posé' })
    }
  }
  return { sent, flag_failed: flagFailed, total: users.length, echeances_7j, errors }
}

// Envoi unique J-0 (fenêtre 24h autour de NOW).
export async function sendTrialEndingTodayEmails() {
  const HALF = 12 * 3600 * 1000
  const now = Date.now()
  const from = new Date(now - HALF)
  const to = new Date(now + HALF)
  const { users, error: selectError } = await findUsersInWindow(from, to, 'trial_email_j0_sent_at')
  const echeances_7j = await compterEcheances('j0', ECHEANCES_J0)
  if (selectError) {
    return { sent: 0, flag_failed: 0, total: 0, echeances_7j, errors: [{ stage: 'select', error: selectError }] }
  }
  if (!users.length) return { sent: 0, flag_failed: 0, total: 0, echeances_7j, errors: [] }
  let sent = 0
  let flagFailed = 0
  const errors = []
  for (const u of users) {
    try {
      await sendTrialEndingToday({ prenom: u.prenom, nom: u.nom, email: u.email })
    } catch (e) {
      console.warn('[trial-emails] J-0 envoi échec :', u.email, e.message)
      errors.push({ email: u.email, stage: 'send', error: e.message })
      continue
    }
    sent++
    if (!await markEmailSent(u.id, 'trial_email_j0_sent_at')) {
      flagFailed++
      errors.push({ email: u.email, stage: 'flag', error: 'trial_email_j0_sent_at non posé' })
    }
  }
  return { sent, flag_failed: flagFailed, total: users.length, echeances_7j, errors }
}

// Bascule active → expired pour les utilisateurs inactifs (qui ne se
// connectent pas et ne déclenchent donc pas la bascule du middleware).
// Doublon défensif du middleware — idempotent.
//
// REND SON ÉCHEC : le catch rendait `{ flipped: 0 }` nu, exactement la forme
// d'une journée sans bascule. Une panne d'UPDATE s'affichait donc saine.
export async function expireTrialAutomatically() {
  const echeances_7j = await compterEcheances('expire', ECHEANCES_EXPIRE)
  try {
    const db = await getDb()
    const r = await db.query(
      `UPDATE user SET trial_status = 'expired'
       WHERE trial_status = 'active' AND trial_ends_at < time::now()
       RETURN BEFORE`
    )
    const flipped = (r?.[0] || []).length
    return { flipped, echeances_7j, errors: [] }
  } catch (e) {
    console.warn('[trial-emails] expireTrialAutomatically échoué :', e.message)
    return { flipped: 0, echeances_7j, errors: [{ stage: 'update', error: e.message }] }
  }
}

// Email 3 du cycle de résiliation — relance J-1 grâce, envoyée la veille de
// la coupure définitive (= la veille de current_period_end + 7j). Calque
// strict du pattern J-0 : findCanceledUsersInWindow + boucle séquentielle
// + flag posé APRÈS envoi réussi (échec d'envoi → flag non posé → retry
// au prochain run, tant que l'user est encore dans une fenêtre).
//
// Fenêtre ±12h (vs ±1h pour J-0/J-2) : le cron tourne 1×/jour (0 8 * * *
// Europe/Paris), il faut couvrir les 24h entre 2 runs sans rater un user
// dont current_period_end tomberait hors d'une fenêtre étroite. Les fenêtres
// de deux runs consécutifs ne se recouvrent pas — elles PAVENT le temps, un
// user vu à un run est hors fenêtre au suivant. Ce dont le flag
// grace_j_minus_1_sent_at IS NONE protège, c'est du DOUBLE PASSAGE DANS LA
// MÊME BANDE DE 24 H (relance manuelle, redémarrage Railway, cron rejoué) :
// l'user reçoit l'email au premier passage, le flag l'exclut du SELECT au
// second.
//
// Le helper d'envoi vient d'email.js (sendSubscriptionGraceEndingTomorrow,
// H4a) et utilise le wrapper sendStripeTransactional + template
// subscription-grace-ending-tomorrow.html (DA unifiée avec grace-start H2a).
export async function sendGraceEndingTomorrowEmails() {
  const SIX_J = 6 * 24 * 3600 * 1000
  const HALF = 12 * 3600 * 1000
  const now = Date.now()
  const from = new Date(now - SIX_J - HALF)
  const to = new Date(now - SIX_J + HALF)
  const { users, error: selectError } = await findCanceledUsersInWindow(from, to)
  const echeances_7j = await compterEcheances('grace_j1', ECHEANCES_GRACE_J1)
  if (selectError) {
    return { sent: 0, flag_failed: 0, total: 0, echeances_7j, errors: [{ stage: 'select', error: selectError }] }
  }
  if (!users.length) return { sent: 0, flag_failed: 0, total: 0, echeances_7j, errors: [] }
  let sent = 0
  let flagFailed = 0
  const errors = []
  for (const u of users) {
    try {
      // grace_until_date = current_period_end + 7j (date de coupure
      // définitive H3/H2b, AFFICHÉE dans l'email). Formule IDENTIQUE
      // H2b stripe.js (gracePlus7d) et H3 subscription.js (graceEndMs).
      // Passée non formatée — le helper applique formatDateFR.
      const graceUntilIso = new Date(
        new Date(u.current_period_end).getTime() + 7 * 24 * 3600 * 1000
      ).toISOString()
      await sendSubscriptionGraceEndingTomorrow({
        email: u.email,
        prenom: u.prenom,
        nom: u.nom,
        plan_label: PLAN_LABELS[u.plan] || u.plan || 'Essentiel',
        grace_until_date: graceUntilIso,
        privacy_url: APP_URL + '/account/privacy'
      })
    } catch (e) {
      console.warn('[trial-emails] grace J-1 envoi échec :', u.email, e.message)
      errors.push({ email: u.email, stage: 'send', error: e.message })
      continue
    }
    sent++
    if (!await markEmailSent(u.id, 'grace_j_minus_1_sent_at')) {
      flagFailed++
      errors.push({ email: u.email, stage: 'flag', error: 'grace_j_minus_1_sent_at non posé' })
    }
  }
  return { sent, flag_failed: flagFailed, total: users.length, echeances_7j, errors }
}

// Sélection des essais jamais convertis à avertir — 7 j avant la purge J+30,
// soit une fin d'essai (trial_ends_at) vieille de 23 j ou plus. Scope « jamais
// abonné », fenêtre RATTRAPANTE (borne basse ouverte) :
//   subscription_status IS NONE          → n'a jamais payé (écarte résiliés,
//                                           impayés, actifs).
//   trial_status active OU expired       → le cron bascule les inactifs en
//                                           'expired' à l'échéance (expireTrial
//                                           Automatically) ; ne viser que l'un
//                                           en manquerait la moitié.
//   trial_ends_at + 23d <= now           → éligible dès J+23, SANS borne haute :
//                                           un compte manqué par un cron sauté
//                                           reste éligible les jours suivants,
//                                           jusqu'à être enfin prévenu (le drapeau
//                                           IS NONE ci-dessous garantit l'unicité).
//   trial_purge_warning_sent_at IS NONE  → idempotence (flag posé après envoi) —
//                                           borne l'ouverture : un averti sort.
//   bypass != true                       → écarte le contournement (drapeau
//                                           superadmin ; isVip couvre en plus le
//                                           propriétaire par email côté boucle).
async function findUnconvertedTrialsToWarn() {
  try {
    const db = await getDb()
    const r = await db.query(
      `SELECT id, email, prenom, nom, bypass, trial_ends_at FROM user
       WHERE subscription_status IS NONE
         AND (trial_status = 'active' OR trial_status = 'expired')
         AND trial_ends_at IS NOT NONE
         AND trial_ends_at + 23d <= time::now()
         AND trial_purge_warning_sent_at IS NONE
         AND bypass != true`
    )
    return { users: r?.[0] || [], error: null }
  } catch (e) {
    console.warn('[trial-emails] findUnconvertedTrialsToWarn échoué :', e.message)
    return { users: [], error: e.message }
  }
}

// Avertissement de suppression J-7 pour les essais jamais convertis (chantier D,
// Sujet 2). Flag posé APRÈS envoi réussi, échec d'envoi → flag non posé → retry
// au prochain run. La sélection est RATTRAPANTE (borne basse ouverte) : plus de
// fenêtre de 24 h à traverser — un compte manqué par un cron sauté est repris
// le lendemain, jusqu'à envoi. C'est la date de CET envoi qui ancre ensuite la
// suppression (purgeExpiredTrials, warning + 7d), garantissant 7 j pleins même
// à un averti tardif.
//
// CONTOURNEMENT : isVip(u) écarte les comptes VIP (propriétaire par email OU
// drapeau bypass) — la boucle de purge ne les supprime jamais, les avertir
// serait mentir. Même helper que purgeExpiredTrials / deriveAppState.
export async function sendTrialDataDeletionWarningEmails() {
  const { users, error: selectError } = await findUnconvertedTrialsToWarn()
  const echeances_7j = await compterEcheances('trial_purge_warn', ECHEANCES_PURGE_WARN)
  if (selectError) {
    return { sent: 0, skipped: 0, flag_failed: 0, total: 0, echeances_7j, errors: [{ stage: 'select', error: selectError }] }
  }
  if (!users.length) return { sent: 0, skipped: 0, flag_failed: 0, total: 0, echeances_7j, errors: [] }
  let sent = 0
  let skipped = 0
  let flagFailed = 0
  const errors = []
  for (const u of users) {
    // Garde de sûreté : le filtre SQL bypass != true ne capte pas le
    // propriétaire par email. isVip tranche les deux populations.
    if (isVip(u)) { skipped++; continue }
    try {
      await sendTrialDataDeletionWarning({ prenom: u.prenom, nom: u.nom, email: u.email })
    } catch (e) {
      console.warn('[trial-emails] avertissement purge envoi échec :', u.email, e.message)
      errors.push({ email: u.email, stage: 'send', error: e.message })
      continue
    }
    // Drapeau CRITIQUE ici : c'est lui qui ancre la suppression 7 j plus tard
    // (purgeExpiredTrials lit trial_purge_warning_sent_at). Non posé, l'user
    // est réaverti au prochain run — jamais supprimé sans préavis, mais
    // possiblement prévenu deux fois.
    sent++
    if (!await markEmailSent(u.id, 'trial_purge_warning_sent_at')) {
      flagFailed++
      errors.push({ email: u.email, stage: 'flag', error: 'trial_purge_warning_sent_at non posé' })
    }
  }
  return { sent, skipped, flag_failed: flagFailed, total: users.length, echeances_7j, errors }
}
