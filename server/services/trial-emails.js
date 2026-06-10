// Emails de prévention essai 14 jours — J-2 et J-0.
//
// Câblées au cron quotidien via cron.js (runTrialJobs). Idempotent — chaque
// user reçoit au plus un email J-2 et un email J-0, l'unicité étant garantie
// par les flags DB trial_email_j*_sent_at posés après chaque envoi réussi :
//   await sendTrialEndingSoonEmails()   // J-2
//   await sendTrialEndingTodayEmails()  // J-0
//   await expireTrialAutomatically()    // bascule active → expired pour les inactifs

import { getDb } from '../../lib/surreal.js'
import { sendSubscriptionGraceEndingTomorrow, sendTrialEndingSoon, sendTrialEndingToday } from './email.js'
import { PLAN_LABELS } from '../../lib/stripe-config.js'

const APP_URL = (process.env.APP_URL || 'https://movup.io').replace(/\/+$/, '')

// Sélection des users dont trial_ends_at tombe dans une fenêtre [from, to]
// ET qui n'ont pas déjà reçu l'email de la fenêtre concernée (flag DB).
// La fenêtre temporelle reste un filtre primaire ; le flag DB garantit
// l'idempotence stricte (cron qui retourne 2× le même jour, redémarrage
// Railway dans la fenêtre, etc.).
async function findUsersInWindow(from, to, sentFlag) {
  const db = await getDb()
  try {
    const r = await db.query(
      `SELECT id, email, prenom, nom, trial_ends_at FROM user
       WHERE trial_status = 'active'
         AND trial_ends_at >= $from AND trial_ends_at < $to
         AND ${sentFlag} IS NONE`,
      { from: from.toISOString(), to: to.toISOString() }
    )
    return r?.[0] || []
  } catch (e) {
    console.warn('[trial-emails] findUsersInWindow échoué :', e.message)
    return []
  }
}

// Sélection des users résiliés (subscription_status='canceled') dont la fin
// de grâce 7j tombe demain — c'est-à-dire dont current_period_end est passé
// il y a 6j, donc current_period_end + 7j = demain. Calque strict de
// findUsersInWindow mais sur le scope canceled (requête disjointe des jobs
// trial : un canceled a trial_status='converted' résiduel mais ne sera
// jamais sélectionné par findUsersInWindow qui filtre trial_status='active').
async function findCanceledUsersInWindow(from, to) {
  const db = await getDb()
  try {
    const r = await db.query(
      `SELECT id, email, prenom, plan, current_period_end FROM user
       WHERE subscription_status = 'canceled'
         AND current_period_end >= $from AND current_period_end < $to
         AND grace_j_minus_1_sent_at IS NONE`,
      { from: from.toISOString(), to: to.toISOString() }
    )
    return r?.[0] || []
  } catch (e) {
    console.warn('[trial-emails] findCanceledUsersInWindow échoué :', e.message)
    return []
  }
}

// Marque un user comme ayant reçu l'email <sentFlag>. Idempotent : si l'envoi
// est ré-tenté plus tard pour ce même user, le SELECT préalable filtre déjà.
async function markEmailSent(userId, sentFlag) {
  const db = await getDb()
  try {
    await db.query(
      `UPDATE $id SET ${sentFlag} = time::now()`,
      { id: userId }
    )
  } catch (e) {
    console.warn(`[trial-emails] markEmailSent ${sentFlag} échoué pour`, String(userId), ':', e.message)
  }
}

// Envoi unique J-2 (fenêtre 24h autour de NOW + 2j).
export async function sendTrialEndingSoonEmails() {
  const now = new Date()
  const from = new Date(now.getTime() + 47 * 3600 * 1000)
  const to = new Date(now.getTime() + 49 * 3600 * 1000)
  const users = await findUsersInWindow(from, to, 'trial_email_j2_sent_at')
  if (!users.length) return { sent: 0, total: 0 }
  let sent = 0
  const errors = []
  for (const u of users) {
    try {
      await sendTrialEndingSoon({ prenom: u.prenom, nom: u.nom, email: u.email })
      await markEmailSent(u.id, 'trial_email_j2_sent_at')
      sent++
    } catch (e) {
      console.warn('[trial-emails] J-2 envoi échec :', u.email, e.message)
      errors.push({ email: u.email, error: e.message })
    }
  }
  return { sent, total: users.length, errors }
}

// Envoi unique J-0 (fenêtre 24h autour de NOW).
export async function sendTrialEndingTodayEmails() {
  const now = new Date()
  const from = new Date(now.getTime() - 1 * 3600 * 1000)
  const to = new Date(now.getTime() + 1 * 3600 * 1000)
  const users = await findUsersInWindow(from, to, 'trial_email_j0_sent_at')
  if (!users.length) return { sent: 0, total: 0 }
  let sent = 0
  const errors = []
  for (const u of users) {
    try {
      await sendTrialEndingToday({ prenom: u.prenom, nom: u.nom, email: u.email })
      await markEmailSent(u.id, 'trial_email_j0_sent_at')
      sent++
    } catch (e) {
      console.warn('[trial-emails] J-0 envoi échec :', u.email, e.message)
      errors.push({ email: u.email, error: e.message })
    }
  }
  return { sent, total: users.length, errors }
}

// Bascule active → expired pour les utilisateurs inactifs (qui ne se
// connectent pas et ne déclenchent donc pas la bascule du middleware).
// Doublon défensif du middleware — idempotent.
export async function expireTrialAutomatically() {
  const db = await getDb()
  try {
    const r = await db.query(
      `UPDATE user SET trial_status = 'expired'
       WHERE trial_status = 'active' AND trial_ends_at < time::now()
       RETURN BEFORE`
    )
    const flipped = (r?.[0] || []).length
    return { flipped }
  } catch (e) {
    console.warn('[trial-emails] expireTrialAutomatically échoué :', e.message)
    return { flipped: 0 }
  }
}

// Email 3 du cycle de résiliation — relance J-1 grâce, envoyée la veille de
// la coupure définitive (= la veille de current_period_end + 7j). Calque
// strict du pattern J-0 : findCanceledUsersInWindow + boucle séquentielle
// + flag posé APRÈS envoi réussi (échec d'envoi → flag non posé → retry
// au prochain run tant que l'user reste dans la fenêtre).
//
// Fenêtre ±12h (vs ±1h pour J-0/J-2) : le cron tourne 1×/jour (0 8 * * *
// Europe/Paris), il faut couvrir les 24h entre 2 runs sans rater un user
// dont current_period_end tomberait hors d'une fenêtre étroite. La fenêtre
// large + le flag grace_j_minus_1_sent_at IS NONE protège du double-envoi
// si chevauchement entre 2 runs (l'user reçoit l'email au premier passage,
// le flag exclut du SELECT au deuxième).
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
  const users = await findCanceledUsersInWindow(from, to)
  if (!users.length) return { sent: 0, total: 0 }
  let sent = 0
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
        plan_label: PLAN_LABELS[u.plan] || u.plan || 'Démarrage',
        grace_until_date: graceUntilIso,
        privacy_url: APP_URL + '/account/privacy'
      })
      await markEmailSent(u.id, 'grace_j_minus_1_sent_at')
      sent++
    } catch (e) {
      console.warn('[trial-emails] grace J-1 envoi échec :', u.email, e.message)
      errors.push({ email: u.email, error: e.message })
    }
  }
  return { sent, total: users.length, errors }
}
