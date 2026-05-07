// Emails de prévention essai 14 jours — J-2 et J-0.
//
// ⚠️ FONCTIONS PRÊTES MAIS NON CÂBLÉES À UN CRON.
// Pour les activer, il faut un déclencheur récurrent (Railway cron, GitHub
// Action scheduled, ou node-cron en process serveur). Décision reportée à une
// passe séparée.
//
// Une fois câblé, lancer toutes les heures (idempotent — chaque user reçoit
// au plus un email J-2 et un email J-0) :
//   await sendTrialEndingSoonEmails()   // J-2
//   await sendTrialEndingTodayEmails()  // J-0
//   await expireTrialAutomatically()    // bascule active → expired pour les inactifs

import { Resend } from 'resend'
import { getDb } from '../../lib/surreal.js'

const FROM = process.env.RESEND_FROM_EMAIL || 'bonjour@movup.io'
const FROM_HEADER = `Movup <${FROM}>`
const APP_URL = (process.env.APP_URL || 'https://movup.io').replace(/\/+$/, '')

let resendClient = null
function getResendClient() {
  if (resendClient) return resendClient
  const key = process.env.RESEND_API_KEY
  if (!key) throw new Error('RESEND_API_KEY non configurée')
  resendClient = new Resend(key)
  return resendClient
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// Template HTML cohérent DA MovUP (Geist, dark header, CTA noir).
function htmlTemplate({ subject, intro, ctaLabel, ctaUrl, body }) {
  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#F5F5F7;font-family:Geist,Inter,-apple-system,sans-serif;color:#1D1D1F;-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F5F5F7;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#FFFFFF;border:1px solid #E8E8ED;border-radius:14px;overflow:hidden;">
      <tr><td style="padding:32px 36px 0;">
        <svg width="86" height="22" viewBox="0 0 86 22" xmlns="http://www.w3.org/2000/svg" aria-label="Movup">
          <text x="0" y="17" font-family="Geist,Inter,Helvetica,sans-serif" font-size="20" font-weight="800" letter-spacing="-0.6" fill="#1D1D1F">Movup</text>
        </svg>
      </td></tr>
      <tr><td style="padding:24px 36px 0;">
        <h1 style="margin:0;font-size:22px;font-weight:800;letter-spacing:-0.5px;color:#1D1D1F;">${escapeHtml(subject)}</h1>
      </td></tr>
      <tr><td style="padding:14px 36px 0;font-size:14px;line-height:1.65;color:#1D1D1F;">
        <p style="margin:0;">${intro}</p>
        ${body || ''}
      </td></tr>
      <tr><td style="padding:24px 36px 0;" align="center">
        <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:#1D1D1F;color:#FFFFFF;text-decoration:none;padding:14px 28px;border-radius:10px;font-size:14px;font-weight:600;letter-spacing:-0.2px;">${escapeHtml(ctaLabel)}</a>
      </td></tr>
      <tr><td style="padding:24px 36px 32px;font-size:12px;color:#6E6E73;line-height:1.6;">
        <div style="border-top:1px solid #E8E8ED;padding-top:18px;">
          <span style="font-weight:700;color:#1D1D1F;">Movup</span> · <a href="${escapeHtml(APP_URL)}" style="color:#6E6E73;text-decoration:none;">movup.io</a>
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`
}

// Sélection des users dont trial_ends_at tombe dans une fenêtre [from, to].
async function findUsersInWindow(from, to) {
  const db = await getDb()
  try {
    const r = await db.query(
      `SELECT id, email, prenom, nom, trial_ends_at FROM user
       WHERE trial_status = 'active' AND trial_ends_at >= $from AND trial_ends_at < $to`,
      { from: from.toISOString(), to: to.toISOString() }
    )
    return r?.[0] || []
  } catch (e) {
    console.warn('[trial-emails] findUsersInWindow échoué :', e.message)
    return []
  }
}

// Envoi unique J-2 (fenêtre 24h autour de NOW + 2j).
export async function sendTrialEndingSoonEmails() {
  const now = new Date()
  const from = new Date(now.getTime() + 47 * 3600 * 1000)
  const to = new Date(now.getTime() + 49 * 3600 * 1000)
  const users = await findUsersInWindow(from, to)
  if (!users.length) return { sent: 0 }
  const r = getResendClient()
  let sent = 0
  for (const u of users) {
    try {
      const subject = 'Votre essai MovUP expire dans 2 jours'
      const html = htmlTemplate({
        subject,
        intro: `Bonjour ${escapeHtml(u.prenom || '')}, votre essai gratuit de 14 jours touche à sa fin. Dans deux jours, l'application passera en mode lecture seule jusqu'à votre abonnement.`,
        body: '<p style="margin:14px 0 0;">Pour continuer sans interruption, choisissez votre plan dès maintenant. Tarifs : Démarrage 19 €, Activité 29 €, Croisière 39 € par mois. Sans engagement.</p>',
        ctaLabel: 'Choisir mon plan',
        ctaUrl: APP_URL + '/tarifs'
      })
      await r.emails.send({
        from: FROM_HEADER,
        to: [u.email],
        replyTo: FROM,
        subject,
        html,
        tags: [{ name: 'kind', value: 'trial_j_minus_2' }]
      })
      sent++
    } catch (e) { console.warn('[trial-emails] J-2 envoi échec :', u.email, e.message) }
  }
  return { sent, total: users.length }
}

// Envoi unique J-0 (fenêtre 24h autour de NOW).
export async function sendTrialEndingTodayEmails() {
  const now = new Date()
  const from = new Date(now.getTime() - 1 * 3600 * 1000)
  const to = new Date(now.getTime() + 1 * 3600 * 1000)
  const users = await findUsersInWindow(from, to)
  if (!users.length) return { sent: 0 }
  const r = getResendClient()
  let sent = 0
  for (const u of users) {
    try {
      const subject = 'Votre essai MovUP expire aujourd\'hui'
      const html = htmlTemplate({
        subject,
        intro: `Bonjour ${escapeHtml(u.prenom || '')}, c'est aujourd'hui que votre essai gratuit prend fin. Choisissez votre abonnement pour conserver l'accès complet à votre pipeline.`,
        body: '<p style="margin:14px 0 0;">Vos données restent accessibles en lecture après la bascule. Pour continuer à ajouter des contacts, créer des devis et envoyer des emails, il vous suffit d\'activer un plan.</p>',
        ctaLabel: 'Activer mon abonnement',
        ctaUrl: APP_URL + '/tarifs'
      })
      await r.emails.send({
        from: FROM_HEADER,
        to: [u.email],
        replyTo: FROM,
        subject,
        html,
        tags: [{ name: 'kind', value: 'trial_j_zero' }]
      })
      sent++
    } catch (e) { console.warn('[trial-emails] J-0 envoi échec :', u.email, e.message) }
  }
  return { sent, total: users.length }
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
