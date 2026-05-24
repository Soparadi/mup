// Wrapper Resend pour les emails transactionnels d'auth Phase 1.
// Trois fonctions : sendWelcomeVerify, sendPasswordReset, sendRelanceJ12.
// Templates HTML chargés depuis server/templates/, substitution {{var}} simple.

import { Resend } from 'resend'
import { readFile } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMPLATES_DIR = join(__dirname, '..', 'templates')

let resendClient = null
function getResendClient() {
  if (resendClient) return resendClient
  const key = process.env.RESEND_API_KEY
  if (!key) throw new Error('RESEND_API_KEY non configurée')
  resendClient = new Resend(key)
  return resendClient
}

const FROM = process.env.RESEND_FROM_EMAIL || 'bonjour@movup.io'
const FROM_HEADER = `MovUP <${FROM}>`

// Salutation "Bonjour {prenom} {nom}" avec fallback :
// - prenom+nom → "Bonjour Jean Dupont"
// - prenom seul → "Bonjour Jean" ; nom seul → "Bonjour Dupont"
// - aucun mais name renseigné → "Bonjour {name}"
// - rien → "Bonjour" (sans nom). Jamais "undefined" ni espace vide.
function buildSalutation(user) {
  const p = (user?.prenom || '').trim()
  const n = (user?.nom || '').trim()
  if (p && n) return `Bonjour ${p} ${n}`
  if (p) return `Bonjour ${p}`
  if (n) return `Bonjour ${n}`
  const name = (user?.name || '').trim()
  if (name) return `Bonjour ${name}`
  return 'Bonjour'
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function applyVars(template, vars) {
  if (!template) return template
  return String(template).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key) => {
    const v = vars && vars[key]
    if (v === undefined || v === null) return ''
    return escapeHtml(v)
  })
}

const tplCache = new Map()
async function loadTemplate(name) {
  if (tplCache.has(name)) return tplCache.get(name)
  const content = await readFile(join(TEMPLATES_DIR, name), 'utf8')
  tplCache.set(name, content)
  return content
}

function appUrl() {
  return (process.env.APP_URL || 'https://movup.io').replace(/\/+$/, '')
}

// ── sendWelcomeVerify ──
// user : { email, prenom, nom, name }
// token : verification token brut (URL safe)
export async function sendWelcomeVerify(user, token) {
  if (!user?.email) throw new Error('user.email requis')
  if (!token) throw new Error('token requis')
  const verifyUrl = `${appUrl()}/api/auth/verify?token=${encodeURIComponent(token)}`
  const salutation = buildSalutation(user)
  const tpl = await loadTemplate('email-verify.html')
  const html = applyVars(tpl, { salutation, verify_url: verifyUrl })
  const text = [
    `${salutation},`,
    '',
    'MovUP est heureux de vous offrir, pendant 14 jours, dans la limite de 30 fiches qualifiées, l’expérience qui va transformer votre façon de prospecter.',
    '',
    'Confirmez votre adresse email pour activer votre compte et commencer à trouver vos clients.',
    '',
    `Activer mon compte et commencer : ${verifyUrl}`,
    '',
    'Ce lien est valable 24 heures.',
    '',
    'Bien à vous,',
    'L’équipe MovUP'
  ].join('\n')

  const r = getResendClient()
  const result = await r.emails.send({
    from: FROM_HEADER,
    to: [user.email],
    replyTo: FROM,
    subject: 'Bienvenue chez MovUP — activez votre accès',
    html,
    text,
    tags: [{ name: 'kind', value: 'email_verify' }]
  })
  if (result.error) throw new Error(result.error.message || 'Resend send failed')
  return { id: result.data?.id || null }
}

// ── sendWelcome ──
// Email 2 (post-vérification email). 3 récits A/B/C selon user.intended_plan :
//   - 'activite'  → récit B (rythme régulier, plan Activité envisagé)
//   - 'croisiere' → récit C (rythme intensif, plan Croisière envisagé)
//   - tout autre cas (null, undefined, 'demarrage', valeur inconnue) → récit A (cas nominal)
// Subject identique aux 3 : 'Votre accès MovUP est ouvert'. CTA → /leads.
// Le conditionnel "porterait" (B) et "ouvrirait" (C) est intentionnel : ne pas
// passer au présent (engagement commercial implicite à éviter avant abonnement).
// Idempotence (anti-double-envoi) gérée par le caller via user.welcome_email_sent_at.
const WELCOME_RECITS = {
  A: {
    intro: 'Votre compte est activé. Vous disposez de 14 jours, dans la limite de 30 fiches qualifiées, pour découvrir MovUP : recherche d’entreprises, pipeline, carte, visio, devis et factures — le cycle commercial complet.',
    body: 'Première étape : lancez une recherche sur votre secteur et votre zone. Vous ne cherchez plus, vous appelez.\n\nAu terme des 14 jours ou des 30 fiches qualifiées — selon la première limite atteinte — vous choisirez librement de continuer avec l’abonnement qui vous convient.'
  },
  B: {
    intro: 'Votre compte est activé. Votre essai se déroule sur le plan Démarrage : 14 jours, dans la limite de 30 fiches qualifiées, pour valider l’outil sur un premier portefeuille.',
    body: 'Vu votre rythme de prospection, le plan Activité que vous envisagez porterait ce débit à 120 fiches qualifiées par mois. Commençons par l’essentiel : faire tourner le cycle complet sur vos 30 premières.\n\nAu terme des 14 jours ou des 30 fiches qualifiées — selon la première limite atteinte — vous choisirez librement l’abonnement qui vous convient.'
  },
  C: {
    intro: 'Votre compte est activé. Votre essai se déroule sur le plan Démarrage : 14 jours, dans la limite de 30 fiches qualifiées. C’est l’étape de prise en main — le temps de valider que l’outil tient ses promesses.',
    body: 'Vu l’intensité de prospection que vous avez indiquée, le plan Croisière que vous envisagez ouvrirait 300 fiches qualifiées par mois. Vous atteindrez sans doute vite la limite des 30 — c’est attendu.\n\nAu terme des 14 jours ou des 30 fiches qualifiées — selon la première limite atteinte — vous choisirez librement l’abonnement qui vous convient.'
  }
}

export async function sendWelcome(user) {
  if (!user?.email) throw new Error('user.email requis')
  const recitKey = user?.intended_plan === 'activite' ? 'B'
                 : user?.intended_plan === 'croisiere' ? 'C'
                 : 'A'
  const recit = WELCOME_RECITS[recitKey]
  const salutation = buildSalutation(user)
  const ctaUrl = `${appUrl()}/leads`
  const tpl = await loadTemplate('email-welcome.html')
  const html = applyVars(tpl, {
    salutation,
    intro: recit.intro,
    body: recit.body,
    cta_url: ctaUrl
  })
  const text = [
    `${salutation},`,
    '',
    recit.intro,
    '',
    recit.body,
    '',
    `Commencer ma première recherche : ${ctaUrl}`,
    '',
    'Bien à vous,',
    'L’équipe MovUP'
  ].join('\n')

  const client = getResendClient()
  const result = await client.emails.send({
    from: FROM_HEADER,
    to: [user.email],
    replyTo: FROM,
    subject: 'Votre accès MovUP est ouvert',
    html,
    text,
    tags: [{ name: 'kind', value: 'welcome' }]
  })
  if (result.error) throw new Error(result.error.message || 'Resend send failed')
  return { id: result.data?.id || null }
}

// ── sendPasswordReset ──
export async function sendPasswordReset(user, token) {
  if (!user?.email) throw new Error('user.email requis')
  if (!token) throw new Error('token requis')
  const resetUrl = `${appUrl()}/reset-password?token=${encodeURIComponent(token)}`
  const tpl = await loadTemplate('password-reset.html')
  const html = applyVars(tpl, { email: user.email, reset_url: resetUrl })
  const text = [
    'Réinitialisation de votre mot de passe MovUP.',
    '',
    `Une demande a été reçue pour le compte ${user.email}.`,
    'Ouvrez ce lien pour choisir un nouveau mot de passe :',
    resetUrl,
    '',
    'Ce lien est valable 1 heure. Si vous n\'êtes pas à l\'origine de cette demande, ignorez ce message.',
    '',
    '— MovUP'
  ].join('\n')

  const r = getResendClient()
  const result = await r.emails.send({
    from: FROM_HEADER,
    to: [user.email],
    replyTo: FROM,
    subject: 'Réinitialisation de votre mot de passe — MovUP',
    html,
    text,
    tags: [{ name: 'kind', value: 'password_reset' }]
  })
  if (result.error) throw new Error(result.error.message || 'Resend send failed')
  return { id: result.data?.id || null }
}

// ── Emails Stripe (souscription) ──
// Tous suivent le même pattern : load template, applyVars, r.emails.send.

function formatDateFR(input) {
  if (!input) return '—'
  try {
    const d = new Date(input)
    if (isNaN(d.getTime())) return '—'
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' })
  } catch (e) { return '—' }
}

const CYCLE_LABELS = { monthly: 'mensuel', annual: 'annuel' }

async function sendStripeTransactional(template, vars, { to, subject, kind }) {
  if (!to) throw new Error('to requis')
  const tpl = await loadTemplate(template)
  const html = applyVars(tpl, vars)
  const r = getResendClient()
  const result = await r.emails.send({
    from: FROM_HEADER,
    to: [to],
    replyTo: FROM,
    subject,
    html,
    tags: [{ name: 'kind', value: kind }]
  })
  if (result.error) throw new Error(result.error.message || 'Resend send failed')
  return { id: result.data?.id || null }
}

export async function sendSubscriptionActivated({ email, prenom, plan_label, cycle, price_display, current_period_end }) {
  return sendStripeTransactional('subscription-activated.html', {
    prenom: prenom || '',
    plan_label,
    cycle_label: CYCLE_LABELS[cycle] || cycle,
    price_display,
    next_billing_date: formatDateFR(current_period_end),
    billing_url: appUrl() + '/account/billing'
  }, {
    to: email,
    subject: `Votre abonnement MovUP ${plan_label} est actif`,
    kind: 'subscription_activated'
  })
}

export async function sendSubscriptionChanged({ email, prenom, old_plan_label, new_plan_label, cycle, price_display }) {
  return sendStripeTransactional('subscription-changed.html', {
    prenom: prenom || '',
    old_plan_label,
    new_plan_label,
    cycle_label: CYCLE_LABELS[cycle] || cycle,
    price_display,
    billing_url: appUrl() + '/account/billing'
  }, {
    to: email,
    subject: `Votre plan MovUP a été mis à jour : ${new_plan_label}`,
    kind: 'subscription_changed'
  })
}

export async function sendSubscriptionCanceled({ email, prenom, plan_label, period_end }) {
  return sendStripeTransactional('subscription-canceled.html', {
    prenom: prenom || '',
    plan_label,
    period_end: formatDateFR(period_end),
    billing_url: appUrl() + '/account/billing',
    privacy_url: appUrl() + '/account/privacy'
  }, {
    to: email,
    subject: 'Confirmation de résiliation MovUP',
    kind: 'subscription_canceled'
  })
}

// Email 2 du cycle de résiliation — déclenché à customer.subscription.deleted
// (entrée en grâce 7j) par le webhook stripe.js (H2b). H2a expose juste le
// helper et le template ; aucun caller dans le code à ce stade.
export async function sendSubscriptionGraceStart({ email, prenom, plan_label, grace_until_date, privacy_url }) {
  return sendStripeTransactional('subscription-grace-start.html', {
    prenom: prenom || '',
    plan_label,
    grace_until_date: formatDateFR(grace_until_date),
    privacy_url: privacy_url || (appUrl() + '/account/privacy')
  }, {
    to: email,
    subject: 'Votre abonnement MovUP a pris fin',
    kind: 'subscription_grace_start'
  })
}

// Email 3 du cycle de résiliation — relance J-1 grâce, déclenchée par le cron
// (H4b) la veille de la fermeture définitive du compte. Calque strict de
// sendSubscriptionGraceStart : mêmes args, même wrapper, même mécanisme
// formatDateFR/fallback privacy_url. Seuls diffèrent template, subject, kind.
// H4a expose juste le helper et le template ; aucun caller à ce stade.
export async function sendSubscriptionGraceEndingTomorrow({ email, prenom, plan_label, grace_until_date, privacy_url }) {
  return sendStripeTransactional('subscription-grace-ending-tomorrow.html', {
    prenom: prenom || '',
    plan_label,
    grace_until_date: formatDateFR(grace_until_date),
    privacy_url: privacy_url || (appUrl() + '/account/privacy')
  }, {
    to: email,
    subject: 'Dernier rappel : votre compte MovUP sera fermé demain',
    kind: 'subscription_grace_ending_tomorrow'
  })
}

export async function sendPaymentFailed({ email, prenom, plan_label, portal_url }) {
  return sendStripeTransactional('payment-failed.html', {
    prenom: prenom || '',
    plan_label,
    portal_url: portal_url || (appUrl() + '/account/billing')
  }, {
    to: email,
    subject: 'Action requise — paiement MovUP en échec',
    kind: 'payment_failed'
  })
}

// ── sendRelanceJ12 ──
// Email de relance 12 jours après inscription. Idempotence à gérer côté caller.
export async function sendRelanceJ12(user) {
  if (!user?.email) throw new Error('user.email requis')
  const tpl = await loadTemplate('relance-j12.html')
  const html = applyVars(tpl, {
    raison_sociale: user.raison_sociale || 'Bonjour',
    app_url: appUrl()
  })
  const text = [
    `${user.raison_sociale || 'Bonjour'}, on reprend ?`,
    '',
    'Cela fait douze jours que vous avez créé votre compte MovUP.',
    'Si quelque chose vous a bloqué, répondez à cet email — on lit tout.',
    '',
    `Reprendre dans MovUP : ${appUrl()}`,
    '',
    '— MovUP'
  ].join('\n')

  const r = getResendClient()
  const result = await r.emails.send({
    from: FROM_HEADER,
    to: [user.email],
    replyTo: FROM,
    subject: 'Vous reprenez où vous en étiez ?',
    html,
    text,
    tags: [{ name: 'kind', value: 'relance_j12' }]
  })
  if (result.error) throw new Error(result.error.message || 'Resend send failed')
  return { id: result.data?.id || null }
}

// ── sendOptoutVerify ──
// Email de confirmation magic-link d'une demande d'opposition RGPD (art. 21).
// N'affiche NI l'IP, NI l'email, NI le SIRET du demandeur (minimisation —
// il vient de les saisir, ils ne lui apportent rien). Lien valable 24h.
//   to : email du tiers ; token : token de vérification BRUT (jamais loggé) ;
//   shortRef : référence courte MUP-OPT-XXXXXX.
// Lève sur erreur Resend, comme les autres senders : le caller (route
// POST /api/optout) gère le best-effort — log + jamais d'exposition au client.
export async function sendOptoutVerify({ to, token, shortRef }) {
  if (!to) throw new Error('to requis')
  if (!token) throw new Error('token requis')
  const verifyUrl = `${appUrl()}/api/optout/verify/${token}`
  const tpl = await loadTemplate('optout-verify.html')
  const html = applyVars(tpl, { verify_url: verifyUrl, short_ref: shortRef || '' })
  const text = [
    'Bonjour,',
    '',
    'Nous avons bien reçu une demande d\'opposition au traitement de vos données, formulée via la page d\'opposition du service MovUP.',
    '',
    'Pour confirmer cette demande, ouvrez ce lien dans les 24 heures :',
    verifyUrl,
    '',
    `Référence de votre demande : ${shortRef || ''}`,
    '',
    'Si vous n\'êtes pas à l\'origine de cette demande, ignorez ce message : aucune action ne sera prise sans votre confirmation.',
    '',
    'L\'équipe MovUP — bonjour@movup.io',
    'Délégué à la protection des données : dpo@movup.io · Réclamation CNIL : www.cnil.fr'
  ].join('\n')

  const r = getResendClient()
  const result = await r.emails.send({
    from: FROM_HEADER,
    to: [to],
    replyTo: FROM,
    subject: 'Confirmez votre demande d\'opposition MovUP',
    html,
    text,
    tags: [{ name: 'type', value: 'optout-verify' }]
  })
  if (result.error) throw new Error(result.error.message || 'Resend send failed')
  return { id: result.data?.id || null }
}

// Format ISO → "JJ/MM/AAAA à HH:mm" en heure de Paris, pour les emails opt-out.
function formatDateTimeFR(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const opts = { timeZone: 'Europe/Paris' }
  const date = d.toLocaleDateString('fr-FR', { ...opts, day: '2-digit', month: '2-digit', year: 'numeric' })
  const time = d.toLocaleTimeString('fr-FR', { ...opts, hour: '2-digit', minute: '2-digit' })
  return `${date} à ${time}`
}

// ── sendOptoutAcknowledged ──
// Accusé de réception RGPD au tiers, post-vérification (art. 12.3 : délai
// 1 mois extensible à 3 mois). N'affiche ni IP, ni email, ni SIRET du tiers.
// processingDeadline arrive déjà formaté FR depuis la route ; verifiedAt est
// un ISO formaté ici. Lève sur erreur Resend (le caller route gère le
// best-effort).
export async function sendOptoutAcknowledged({ to, shortRef, verifiedAt, processingDeadline }) {
  if (!to) throw new Error('to requis')
  const tpl = await loadTemplate('optout-acknowledged.html')
  const html = applyVars(tpl, {
    short_ref: shortRef || '',
    verified_at: formatDateTimeFR(verifiedAt),
    processing_deadline: processingDeadline || ''
  })
  const r = getResendClient()
  const result = await r.emails.send({
    from: FROM_HEADER,
    to: [to],
    replyTo: FROM,
    subject: 'Votre demande d\'opposition est enregistrée — ' + (shortRef || ''),
    html,
    tags: [{ name: 'type', value: 'optout-acknowledged' }]
  })
  if (result.error) throw new Error(result.error.message || 'Resend send failed')
  return { id: result.data?.id || null }
}

// ── sendOptoutInternalNotification ──
// Notification interne à bonjour@movup.io : une demande opt-out vérifiée
// attend un traitement manuel sous J+30. Sobre, sans mentions CNIL (interne).
// Lève sur erreur Resend (le caller route gère le best-effort).
export async function sendOptoutInternalNotification({ shortRef, verifiedAt, processingDeadline }) {
  const tpl = await loadTemplate('optout-internal-notification.html')
  const html = applyVars(tpl, {
    short_ref: shortRef || '',
    verified_at: formatDateTimeFR(verifiedAt),
    processing_deadline: processingDeadline || ''
  })
  const r = getResendClient()
  const result = await r.emails.send({
    from: FROM_HEADER,
    to: ['bonjour@movup.io'],
    replyTo: FROM,
    subject: '[MovUP RGPD] Nouvelle demande opposition vérifiée — ' + (shortRef || ''),
    html,
    tags: [{ name: 'type', value: 'optout-internal' }]
  })
  if (result.error) throw new Error(result.error.message || 'Resend send failed')
  return { id: result.data?.id || null }
}
