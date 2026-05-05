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
const FROM_HEADER = `Movup <${FROM}>`

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
// user : { email, raison_sociale }
// token : verification token brut (URL safe)
export async function sendWelcomeVerify(user, token) {
  if (!user?.email) throw new Error('user.email requis')
  if (!token) throw new Error('token requis')
  const verifyUrl = `${appUrl()}/api/auth/verify?token=${encodeURIComponent(token)}`
  const tpl = await loadTemplate('email-verify.html')
  const html = applyVars(tpl, { email: user.email, verify_url: verifyUrl })
  const text = [
    'Bienvenue sur Movup.',
    '',
    `Confirmez votre adresse email (${user.email}) en ouvrant ce lien :`,
    verifyUrl,
    '',
    'Ce lien est valable 24 heures.',
    '',
    '— Movup'
  ].join('\n')

  const r = getResendClient()
  const result = await r.emails.send({
    from: FROM_HEADER,
    to: [user.email],
    replyTo: FROM,
    subject: 'Confirmez votre adresse email — Movup',
    html,
    text,
    tags: [{ name: 'kind', value: 'email_verify' }]
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
    'Réinitialisation de votre mot de passe Movup.',
    '',
    `Une demande a été reçue pour le compte ${user.email}.`,
    'Ouvrez ce lien pour choisir un nouveau mot de passe :',
    resetUrl,
    '',
    'Ce lien est valable 1 heure. Si vous n\'êtes pas à l\'origine de cette demande, ignorez ce message.',
    '',
    '— Movup'
  ].join('\n')

  const r = getResendClient()
  const result = await r.emails.send({
    from: FROM_HEADER,
    to: [user.email],
    replyTo: FROM,
    subject: 'Réinitialisation de votre mot de passe — Movup',
    html,
    text,
    tags: [{ name: 'kind', value: 'password_reset' }]
  })
  if (result.error) throw new Error(result.error.message || 'Resend send failed')
  return { id: result.data?.id || null }
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
    'Cela fait douze jours que vous avez créé votre compte Movup.',
    'Si quelque chose vous a bloqué, répondez à cet email — on lit tout.',
    '',
    `Reprendre dans Movup : ${appUrl()}`,
    '',
    '— Movup'
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
