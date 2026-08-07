// Wrapper Resend pour les emails transactionnels d'auth Phase 1.
// Trois fonctions : sendWelcomeVerify, sendPasswordReset, sendRelanceJ12.
// Templates HTML chargés depuis server/templates/, substitution {{var}} simple.

import { Resend } from 'resend'
import { readFile } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { PLAN_PRICES_DISPLAY } from '../../lib/stripe-config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMPLATES_DIR = join(__dirname, '..', 'templates')

// ── Logo embarqué ──
// Les gabarits pointent le logo en `cid:` et non en https://movup.io/... :
// la plupart des clients mail bloquent les images distantes tant que le
// destinataire n'a pas cliqué « afficher les images », et l'en-tête arrivait
// donc vide. Une pièce jointe en ligne s'affiche sans autorisation.
// Le fichier 1× suffit : le logo est rendu à 90 px de large.
const LOGO_CID = 'movup-logo'
const LOGO_FILENAME = 'movup-email-logo.png'
const LOGO_PATH = join(__dirname, '..', '..', 'public', LOGO_FILENAME)

let logoAttachment = null
async function inlineLogo() {
  if (!logoAttachment) {
    const bytes = await readFile(LOGO_PATH)
    logoAttachment = {
      filename: LOGO_FILENAME,
      content: bytes.toString('base64'),
      contentType: 'image/png',
      // Sans chevrons : le SDK Resend pose lui-même les < > de l'en-tête
      // Content-ID. En ajouter ici casserait la correspondance avec le
      // `src="cid:movup-logo"` du gabarit.
      contentId: LOGO_CID
    }
  }
  return logoAttachment
}

let resendClient = null
let sender = null
// N'expose pas le client Resend nu mais un enrobage réduit à `emails.send`,
// seule méthode utilisée ici. C'est le point unique par lequel part tout
// transactionnel : la pièce jointe du logo y est ajoutée une fois pour
// toutes, plutôt qu'aux quinze appels — dont un futur seizième, écrit sur le
// même modèle, hériterait sans que personne ait à y penser.
// Le rattachement est piloté par le gabarit lui-même : seul un HTML qui
// référence `cid:movup-logo` reçoit la pièce jointe, si bien que le seul
// gabarit sans logo (optout-internal-notification) ne la transporte pas.
function getResendClient() {
  if (sender) return sender
  const key = process.env.RESEND_API_KEY
  if (!key) throw new Error('RESEND_API_KEY non configurée')
  resendClient = new Resend(key)
  sender = {
    emails: {
      send: async (payload) => {
        if (!payload?.html || !payload.html.includes(`cid:${LOGO_CID}`)) {
          return resendClient.emails.send(payload)
        }
        return resendClient.emails.send({
          ...payload,
          attachments: [...(payload.attachments || []), await inlineLogo()]
        })
      }
    }
  }
  return sender
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
    'Bienvenue chez MovUP. Votre compte est créé. Confirmez votre adresse email pour ouvrir votre accès.',
    '',
    `Activer mon compte : ${verifyUrl}`,
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
    subject: 'Bienvenue chez MovUP : activez votre compte',
    html,
    text,
    tags: [{ name: 'kind', value: 'email_verify' }]
  })
  if (result.error) throw new Error(result.error.message || 'Resend send failed')
  return { id: result.data?.id || null }
}

// ── sendWelcome ──
// Email 2 (post-vérification email). Corps unique, identique pour tous.
// Subject : 'Votre accès MovUP est ouvert'. CTA → /prospection.
// Idempotence (anti-double-envoi) gérée par le caller via user.welcome_email_sent_at.

export async function sendWelcome(user) {
  if (!user?.email) throw new Error('user.email requis')
  const salutation = buildSalutation(user)
  const ctaUrl = `${appUrl()}/prospection`
  const tpl = await loadTemplate('email-welcome.html')
  const html = applyVars(tpl, {
    salutation,
    cta_url: ctaUrl
  })
  const text = [
    `${salutation},`,
    '',
    'Votre espace MovUP est prêt. Tout est réuni au même endroit : recherche de clients, suivi, carte, agenda, rendez-vous, mail, visio, devis et factures. Un seul espace, une seule logique. De la première recherche au client signé.',
    '',
    'L\'essai gratuit vous permet de disposer de 14 jours, dans la limite de 30 contacts enrichis.',
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

// ── sendMailboxConnected ──
// Confirmation de connexion d'une boîte mail (OAuth Google ou Microsoft réussi).
// Courriel de SERVICE, déclenché par l'abonné lui-même : aucune mention de
// désinscription (elle ne vaut que pour la prospection commerciale).
// Idempotence gérée par le caller (mail-service.js) via mailbox_credentials
// .welcomeEmailSentAt.
//   user : { email: adresse du COMPTE MovUP, prenom, nom, name } — sert la
//   salutation ; mailboxEmail : l'adresse de la boîte connectée, destinataire.
export async function sendMailboxConnected(user, mailboxEmail) {
  if (!mailboxEmail) throw new Error('mailboxEmail requis')
  const salutation = buildSalutation(user)
  const ctaUrl = `${appUrl()}/prospection`
  const tpl = await loadTemplate('mailbox-connected.html')
  const html = applyVars(tpl, { salutation, mailbox_email: mailboxEmail, cta_url: ctaUrl })
  const text = [
    `${salutation},`,
    '',
    `L'adresse ${mailboxEmail} est reliée à votre espace MovUP. Vous lisez et vous écrivez vos messages sans quitter l'application.`,
    '',
    '1. Lancer une recherche de prospects',
    '2. Les envoyer dans votre pipeline',
    '3. Leur écrire depuis MovUP',
    '',
    `Lancer une recherche : ${ctaUrl}`,
    '',
    'Bien à vous,',
    'L\'équipe MovUP'
  ].join('\n')

  const r = getResendClient()
  const result = await r.emails.send({
    from: FROM_HEADER,
    to: [mailboxEmail],
    replyTo: FROM,
    subject: 'Votre boîte mail est connectée à MovUP',
    html,
    text,
    tags: [{ name: 'kind', value: 'mailbox_connected' }]
  })
  if (result.error) throw new Error(result.error.message || 'Resend send failed')
  return { id: result.data?.id || null }
}

// ── sendPasswordReset ──
export async function sendPasswordReset(user, token) {
  if (!user?.email) throw new Error('user.email requis')
  if (!token) throw new Error('token requis')
  const resetUrl = `${appUrl()}/reset-password?token=${encodeURIComponent(token)}`
  const salutation = buildSalutation(user)
  const tpl = await loadTemplate('password-reset.html')
  const html = applyVars(tpl, { salutation, email: user.email, reset_url: resetUrl })
  const text = [
    `${salutation},`,
    '',
    `Une demande de réinitialisation a été reçue pour le compte ${user.email}.`,
    '',
    'Cliquez ci-dessous pour choisir un nouveau mot de passe. Ce lien est valable une heure :',
    resetUrl,
    '',
    'Si vous n\'êtes pas à l\'origine de cette demande, ignorez ce message : votre mot de passe restera inchangé.',
    '',
    'Bien à vous,',
    'L\'équipe MovUP'
  ].join('\n')

  const r = getResendClient()
  const result = await r.emails.send({
    from: FROM_HEADER,
    to: [user.email],
    replyTo: FROM,
    subject: 'Réinitialisation de votre mot de passe MovUP',
    html,
    text,
    tags: [{ name: 'kind', value: 'password_reset' }]
  })
  if (result.error) throw new Error(result.error.message || 'Resend send failed')
  return { id: result.data?.id || null }
}

// ── sendEmailChangeVerify ──
// Envoyé à la NOUVELLE adresse. Porte le lien de confirmation : cliquer prouve
// que l'adresse appartient bien au demandeur, et déclenche la bascule. Calqué
// sur sendPasswordReset (même charte, lien valable 1h).
//   user : { email: NOUVELLE adresse, prenom, nom, name } ; token : brut.
export async function sendEmailChangeVerify(user, token) {
  if (!user?.email) throw new Error('user.email requis')
  if (!token) throw new Error('token requis')
  const confirmUrl = `${appUrl()}/api/auth/confirm-email-change?token=${encodeURIComponent(token)}`
  const salutation = buildSalutation(user)
  const tpl = await loadTemplate('email-change-verify.html')
  const html = applyVars(tpl, { salutation, confirm_url: confirmUrl })
  const text = [
    `${salutation},`,
    '',
    'Une demande de changement d\'adresse a été reçue pour votre compte MovUP. Cliquez ci-dessous pour confirmer que cette adresse est bien la vôtre : elle deviendra alors votre identifiant de connexion. Ce lien est valable une heure.',
    confirmUrl,
    '',
    'Tant que vous n\'avez pas confirmé, votre adresse actuelle reste inchangée.',
    '',
    'Bien à vous,',
    'L\'équipe MovUP'
  ].join('\n')

  const r = getResendClient()
  const result = await r.emails.send({
    from: FROM_HEADER,
    to: [user.email],
    replyTo: FROM,
    subject: 'Confirmez votre nouvelle adresse MovUP',
    html,
    text,
    tags: [{ name: 'kind', value: 'email_change_verify' }]
  })
  if (result.error) throw new Error(result.error.message || 'Resend send failed')
  return { id: result.data?.id || null }
}

// ── sendEmailChangeNotice ──
// Envoyé à l'ANCIENNE adresse pour l'avertir. Purement informatif : aucun lien
// de bascule, et la NOUVELLE adresse n'y figure JAMAIS (minimisation + on ne
// révèle pas la cible à un éventuel session-hijacker). Le bouton mène à la page
// de mot de passe oublié, geste correctif si la demande n'émane pas du titulaire.
//   user : { email: ANCIENNE adresse, prenom, nom, name }.
export async function sendEmailChangeNotice(user) {
  if (!user?.email) throw new Error('user.email requis')
  const salutation = buildSalutation(user)
  const resetUrl = `${appUrl()}/forgot-password`
  const tpl = await loadTemplate('email-change-notice.html')
  const html = applyVars(tpl, { salutation, reset_url: resetUrl })
  const text = [
    `${salutation},`,
    '',
    'Une demande a été reçue pour remplacer l\'adresse de votre compte MovUP par une autre. Le changement ne prendra effet qu\'après confirmation depuis cette nouvelle adresse.',
    '',
    'Si vous n\'êtes pas à l\'origine de cette demande, modifiez votre mot de passe sans attendre : quelqu\'un dispose peut-être d\'un accès à votre session.',
    resetUrl,
    '',
    'Bien à vous,',
    'L\'équipe MovUP'
  ].join('\n')

  const r = getResendClient()
  const result = await r.emails.send({
    from: FROM_HEADER,
    to: [user.email],
    replyTo: FROM,
    subject: 'Un changement d\'adresse a été demandé sur votre compte MovUP',
    html,
    text,
    tags: [{ name: 'kind', value: 'email_change_notice' }]
  })
  if (result.error) throw new Error(result.error.message || 'Resend send failed')
  return { id: result.data?.id || null }
}

// ── Emails Stripe (souscription) ──
// Tous suivent le même pattern : load template, applyVars, r.emails.send.

function formatDateFR(input) {
  if (!input) return '-'
  try {
    const d = new Date(input)
    if (isNaN(d.getTime())) return '-'
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' })
  } catch (e) { return '-' }
}

const CYCLE_LABELS = { monthly: '/ mois', annual: '/ an' }

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

export async function sendSubscriptionActivated({ email, prenom, nom, plan_label, cycle, price_display, current_period_end }) {
  return sendStripeTransactional('subscription-activated.html', {
    salutation: buildSalutation({ prenom, nom }),
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

export async function sendSubscriptionChanged({ email, prenom, nom, old_plan_label, new_plan_label, cycle, price_display }) {
  return sendStripeTransactional('subscription-changed.html', {
    salutation: buildSalutation({ prenom, nom }),
    old_plan_label,
    new_plan_label,
    cycle_label: CYCLE_LABELS[cycle] || cycle,
    price_display,
    billing_url: appUrl() + '/account/billing'
  }, {
    to: email,
    subject: 'Votre plan MovUP a été mis à jour',
    kind: 'subscription_changed'
  })
}

export async function sendSubscriptionCanceled({ email, prenom, nom, plan_label, period_end }) {
  return sendStripeTransactional('subscription-canceled.html', {
    salutation: buildSalutation({ prenom, nom }),
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
export async function sendSubscriptionGraceStart({ email, prenom, nom, plan_label, grace_until_date, privacy_url }) {
  return sendStripeTransactional('subscription-grace-start.html', {
    salutation: buildSalutation({ prenom, nom }),
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
export async function sendSubscriptionGraceEndingTomorrow({ email, prenom, nom, plan_label, grace_until_date, privacy_url }) {
  return sendStripeTransactional('subscription-grace-ending-tomorrow.html', {
    salutation: buildSalutation({ prenom, nom }),
    plan_label,
    grace_until_date: formatDateFR(grace_until_date),
    privacy_url: privacy_url || (appUrl() + '/account/privacy')
  }, {
    to: email,
    subject: 'Votre compte MovUP ferme demain : pensez à exporter vos données',
    kind: 'subscription_grace_ending_tomorrow'
  })
}

// Avertissement de suppression d'un essai jamais converti — déclenché par le
// cron (trial-emails.js) à J+23 (7 j avant la purge J+30, purgeExpiredTrials).
// Calque de sendSubscriptionGraceEndingTomorrow : même wrapper, même mécanique.
// Aucune date à formater (le délai « sept jours » est fixe dans le gabarit).
export async function sendTrialDataDeletionWarning({ email, prenom, nom }) {
  return sendStripeTransactional('trial-data-deletion-warning.html', {
    salutation: buildSalutation({ prenom, nom }),
    billing_url: appUrl() + '/account/billing'
  }, {
    to: email,
    subject: 'Vos données MovUP seront supprimées dans sept jours',
    kind: 'trial_data_deletion_warning'
  })
}

export async function sendPaymentFailed({ email, prenom, nom, plan_label, portal_url }) {
  return sendStripeTransactional('payment-failed.html', {
    salutation: buildSalutation({ prenom, nom }),
    plan_label,
    portal_url: portal_url || (appUrl() + '/account/billing')
  }, {
    to: email,
    subject: 'Action requise : paiement MovUP en échec',
    kind: 'payment_failed'
  })
}

// ── sendRelanceJ12 ──
// Email de relance 12 jours après inscription. Idempotence à gérer côté caller.
export async function sendRelanceJ12(user) {
  if (!user?.email) throw new Error('user.email requis')
  const salutation = buildSalutation(user)
  const ctaUrl = appUrl()
  const tpl = await loadTemplate('relance-j12.html')
  const html = applyVars(tpl, {
    salutation,
    cta_url: ctaUrl
  })
  const text = [
    `${salutation},`,
    '',
    '15 minutes en visioconférence peuvent vous faire gagner des semaines. Nous vous montrons comment MovUP travaille pour vous : trouver les bons prospects, organiser vos relances, et signer plus vite.',
    '',
    `Voir les créneaux disponibles : ${ctaUrl}`,
    '',
    'Bien à vous,',
    'L\'équipe MovUP'
  ].join('\n')

  const r = getResendClient()
  const result = await r.emails.send({
    from: FROM_HEADER,
    to: [user.email],
    replyTo: FROM,
    subject: '15 minutes pour démarrer ensemble',
    html,
    text,
    tags: [{ name: 'kind', value: 'relance_j12' }]
  })
  if (result.error) throw new Error(result.error.message || 'Resend send failed')
  return { id: result.data?.id || null }
}

// ── sendTrialEndingSoon ──
// Email J-2 de l'essai 14 jours : prévient que l'espace bascule en lecture
// seule dans 2 jours et invite à choisir un plan. Idempotence (un J-2 par
// user) gérée côté caller via le flag DB trial_email_j2_sent_at. Les prix
// viennent de PLAN_PRICES_DISPLAY (incluent déjà « € » → « 24 € »).
export async function sendTrialEndingSoon(user) {
  if (!user?.email) throw new Error('user.email requis')
  const salutation = buildSalutation(user)
  const ctaUrl = appUrl() + '/account/billing'
  const tpl = await loadTemplate('trial-ending-soon.html')
  const html = applyVars(tpl, {
    salutation,
    cta_url: ctaUrl,
    prix_demarrage: PLAN_PRICES_DISPLAY.demarrage.monthly,
    prix_activite: PLAN_PRICES_DISPLAY.activite.monthly,
    prix_croisiere: PLAN_PRICES_DISPLAY.croisiere.monthly
  })
  const text = [
    `${salutation},`,
    '',
    'Votre essai gratuit de 14 jours touche à sa fin. Dans deux jours, votre espace MovUP passera en lecture seule, jusqu\'à l\'activation de votre abonnement.',
    '',
    `Pour continuer sans interruption, choisissez votre plan dès maintenant. Tarifs : Essentiel ${PLAN_PRICES_DISPLAY.demarrage.monthly}, Régulier ${PLAN_PRICES_DISPLAY.activite.monthly}, Intensif ${PLAN_PRICES_DISPLAY.croisiere.monthly} par mois. Sans engagement.`,
    '',
    `Choisir mon plan : ${ctaUrl}`,
    '',
    'Bien à vous,',
    'L\'équipe MovUP'
  ].join('\n')

  const r = getResendClient()
  const result = await r.emails.send({
    from: FROM_HEADER,
    to: [user.email],
    replyTo: FROM,
    subject: 'Votre essai MovUP expire dans 2 jours',
    html,
    text,
    tags: [{ name: 'kind', value: 'trial_j_minus_2' }]
  })
  if (result.error) throw new Error(result.error.message || 'Resend send failed')
  return { id: result.data?.id || null }
}

// ── sendTrialEndingToday ──
// Email J-0 de l'essai 14 jours : prévient que l'essai prend fin aujourd'hui
// et invite à activer un plan. Sans prix (contrairement au J-2) : à J-0 le
// message est l'urgence de la bascule, pas la comparaison tarifaire.
// Idempotence (un J-0 par user) gérée côté caller via le flag DB
// trial_email_j0_sent_at.
export async function sendTrialEndingToday(user) {
  if (!user?.email) throw new Error('user.email requis')
  const salutation = buildSalutation(user)
  const ctaUrl = appUrl() + '/account/billing'
  const tpl = await loadTemplate('trial-ending-today.html')
  const html = applyVars(tpl, {
    salutation,
    cta_url: ctaUrl
  })
  const text = [
    `${salutation},`,
    '',
    'C\'est aujourd\'hui que votre essai gratuit prend fin. Vos données restent accessibles en lecture après la bascule.',
    '',
    'Pour continuer à ajouter des contacts, créer des devis et envoyer des emails, il vous suffit d\'activer un plan.',
    '',
    `Activer mon abonnement : ${ctaUrl}`,
    '',
    'Bien à vous,',
    'L\'équipe MovUP'
  ].join('\n')

  const r = getResendClient()
  const result = await r.emails.send({
    from: FROM_HEADER,
    to: [user.email],
    replyTo: FROM,
    subject: 'Votre essai MovUP expire aujourd\'hui',
    html,
    text,
    tags: [{ name: 'kind', value: 'trial_j_zero' }]
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
    'Nous avons reçu une demande d\'opposition au traitement de vos données, formulée via la page d\'opposition de MovUP.',
    '',
    `Pour la confirmer, ouvrez ce lien dans les 24 heures. Référence de votre demande : ${shortRef || ''}.`,
    verifyUrl,
    '',
    'Si vous n\'êtes pas à l\'origine de cette demande, ignorez ce message.',
    '',
    'Bien à vous,',
    'L\'équipe MovUP',
    '',
    'Responsable de traitement : So Paradi (EI), Dinan. DPO : dpo@movup.io. Réclamation possible auprès de la CNIL.'
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
  const verifiedAtFr = formatDateTimeFR(verifiedAt)
  const tpl = await loadTemplate('optout-acknowledged.html')
  const html = applyVars(tpl, {
    short_ref: shortRef || '',
    verified_at: verifiedAtFr,
    processing_deadline: processingDeadline || ''
  })
  const text = [
    'Bonjour,',
    '',
    `Votre demande d'opposition (référence ${shortRef || ''}) a été enregistrée et vérifiée le ${verifiedAtFr}.`,
    '',
    `Conformément à l'article 12.3 du RGPD, elle sera traitée sous un mois maximum, soit jusqu'au ${processingDeadline || ''}. En cas de prolongation (deux mois maximum), vous serez informé par email.`,
    '',
    'Bien à vous,',
    'L\'équipe MovUP',
    '',
    'Responsable de traitement : So Paradi (EI), Dinan. DPO : dpo@movup.io. Réclamation possible auprès de la CNIL.'
  ].join('\n')
  const r = getResendClient()
  const result = await r.emails.send({
    from: FROM_HEADER,
    to: [to],
    replyTo: FROM,
    subject: 'Votre demande d\'opposition est enregistrée : ' + (shortRef || ''),
    html,
    text,
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
    subject: '[MovUP RGPD] Nouvelle demande opposition vérifiée : ' + (shortRef || ''),
    html,
    tags: [{ name: 'type', value: 'optout-internal' }]
  })
  if (result.error) throw new Error(result.error.message || 'Resend send failed')
  return { id: result.data?.id || null }
}

// Format ISO/datetime → "JJ/MM/AAAA" (heure de Paris), pour les emails compte.
function formatDateFRNumeric(input) {
  if (!input) return ''
  const d = new Date(input)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric' })
}

// ── sendAccountDeletionScheduled ──
// Envoyé à la demande de suppression de compte (art. 17) : confirme
// l'enregistrement + l'échéance J+7 + la possibilité d'annuler. Lève sur
// erreur Resend (le caller route gère le best-effort).
export async function sendAccountDeletionScheduled({ to, prenom, nom, scheduled_at }) {
  if (!to) throw new Error('to requis')
  const salutation = buildSalutation({ prenom, nom })
  const scheduledAtFr = formatDateFRNumeric(scheduled_at)
  const tpl = await loadTemplate('account-deletion-scheduled.html')
  const html = applyVars(tpl, {
    salutation,
    scheduled_at_fr: scheduledAtFr
  })
  const text = [
    `${salutation},`,
    '',
    `Votre demande de suppression est bien prise en compte. Votre compte et vos données seront définitivement supprimés le ${scheduledAtFr}.`,
    '',
    'Vous pouvez annuler cette suppression à tout moment avant cette date : connectez-vous et rendez-vous sur la page Confidentialité de votre compte.',
    '',
    'Bien à vous,',
    'L\'équipe MovUP',
    '',
    'Conservation des factures 10 ans sous forme anonymisée (art. L123-22 du Code de commerce). Responsable de traitement : So Paradi (EI), Dinan, SIRET 453 388 456 00031. DPO : dpo@movup.io. Réclamation possible auprès de la CNIL.'
  ].join('\n')
  const r = getResendClient()
  const result = await r.emails.send({
    from: FROM_HEADER,
    to: [to],
    replyTo: FROM,
    subject: 'Votre demande de suppression de compte est enregistrée',
    html,
    text,
    tags: [{ name: 'type', value: 'account-deletion-scheduled' }]
  })
  if (result.error) throw new Error(result.error.message || 'Resend send failed')
  return { id: result.data?.id || null }
}

// ── sendAccountDeletionConfirmed ──
// Envoyé après suppression effective par le cron (art. 17). Pas de CTA (le
// compte n'existe plus). Lève sur erreur Resend (le caller cron gère le
// best-effort).
export async function sendAccountDeletionConfirmed({ to, prenom, nom, requested_at }) {
  if (!to) throw new Error('to requis')
  const salutation = buildSalutation({ prenom, nom })
  const requestedAtFr = formatDateFRNumeric(requested_at)
  const tpl = await loadTemplate('account-deletion-confirmed.html')
  const html = applyVars(tpl, {
    salutation,
    requested_at_fr: requestedAtFr
  })
  const text = [
    `${salutation},`,
    '',
    `Votre compte MovUP a été supprimé conformément à votre demande du ${requestedAtFr}, en application de l'article 17 du RGPD (droit à l'effacement).`,
    '',
    'L\'ensemble de vos données personnelles et professionnelles a été effacé de nos systèmes.',
    '',
    'Nous vous remercions d\'avoir utilisé MovUP.',
    '',
    'Bien à vous,',
    'L\'équipe MovUP',
    '',
    'Conservation des factures 10 ans sous forme anonymisée (art. L123-22 du Code de commerce). Responsable de traitement : So Paradi (EI), Dinan, SIRET 453 388 456 00031. DPO : dpo@movup.io. Réclamation possible auprès de la CNIL.'
  ].join('\n')
  const r = getResendClient()
  const result = await r.emails.send({
    from: FROM_HEADER,
    to: [to],
    replyTo: FROM,
    subject: 'Votre compte MovUP a été supprimé',
    html,
    text,
    tags: [{ name: 'type', value: 'account-deletion-confirmed' }]
  })
  if (result.error) throw new Error(result.error.message || 'Resend send failed')
  return { id: result.data?.id || null }
}
