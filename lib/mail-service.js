// Service unifié mail — Track 1 (1:1) + Track 2 (campagnes Resend).
// Track 1 : sendOne, listInbox, listGoogleMessages, getMailStatus
//   → provider imap (session 1), google (session 2, gmail.users.messages.send/list), microsoft (session 3 stub)
// Track 2 : ensureResendClient, verifyDomain, getDomainStatus, sendCampaign, verifyResendSignature, handleResendEvent

import nodemailer from 'nodemailer'
import { Resend } from 'resend'
import { google } from 'googleapis'
import { createHmac, timingSafeEqual } from 'crypto'
import { decrypt, encryptMailToken, decryptMailToken } from './crypto.js'

// ── RESEND ──
let resendClient = null
function getResendClient() {
  if (resendClient) return resendClient
  const key = process.env.RESEND_API_KEY
  if (!key) throw new Error('RESEND_API_KEY non configurée — voir README-mail.md')
  resendClient = new Resend(key)
  return resendClient
}
export function isResendReady() {
  return Boolean(process.env.RESEND_API_KEY)
}

// Création / récupération d'un domaine Resend.
// Si Resend retourne 409/422 (déjà existant — message variable), liste les domaines pour retrouver l'id.
function isAlreadyRegistered(msg) {
  return /already exists|already registered|registered already|has been registered/i.test(String(msg || ''))
}

export async function verifyResendDomain(domainName) {
  const r = getResendClient()
  async function lookupExisting() {
    const list = await r.domains.list()
    const arr = list.data?.data || list.data || []
    const found = arr.find(d => d.name === domainName)
    if (!found) return null
    // Pour avoir les DNS records détaillés il faut souvent appeler get(id)
    try {
      const full = await r.domains.get(found.id)
      const fd = full.data || found
      return { id: fd.id, name: fd.name, status: fd.status, records: fd.records || [], existing: true }
    } catch (e) {
      return { id: found.id, name: found.name, status: found.status, records: found.records || [], existing: true }
    }
  }
  try {
    // Région figée eu-west-1 (Frankfurt) — par défaut Resend crée en us-east-1.
    // Évite les doublons et garde les données EU pour la conformité RGPD.
    const created = await r.domains.create({ name: domainName, region: 'eu-west-1' })
    if (created.error) {
      const msg = created.error.message || ''
      const status = created.error.statusCode
      if (status === 409 || status === 422 || isAlreadyRegistered(msg)) {
        const existing = await lookupExisting()
        if (existing) return existing
        throw new Error(msg || 'Domaine déjà existant mais introuvable via list')
      }
      throw new Error(msg || 'Resend create domain failed')
    }
    const data = created.data || {}
    return { id: data.id, name: data.name, status: data.status, records: data.records || [], existing: false }
  } catch (e) {
    if (isAlreadyRegistered(e?.message)) {
      const existing = await lookupExisting()
      if (existing) return existing
    }
    throw e
  }
}

export async function getResendDomainStatus(resendDomainId) {
  const r = getResendClient()
  const result = await r.domains.get(resendDomainId)
  if (result.error) throw new Error(result.error.message || 'Resend get domain failed')
  const d = result.data || {}
  return { id: d.id, name: d.name, status: d.status, records: d.records || [] }
}

// ── Footer RGPD art. 14 (Phase 6 Étape 14) ──
// Footer légal injecté côté serveur sur chaque cold mail (campagne), PAR
// destinataire (lien opt-out personnalisé). Identité responsable de traitement
// = l'abonné (raison_sociale + siret). Throw err.code='siret_missing' si
// l'identité est incomplète — le caller (route /send) renvoie alors 400 et le
// front déclenche le popup setup.
function escapeFooterHtml(s) {
  return String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]))
}

export function buildColdMailFooter(user, recipientEmail) {
  const raisonSociale = user && typeof user.raison_sociale === 'string' ? user.raison_sociale.trim() : ''
  const siret = user && user.siret ? String(user.siret).replace(/\s/g, '') : ''
  if (!raisonSociale || !/^\d{14}$/.test(siret)) {
    const err = new Error('Identité commerciale incomplète (raison_sociale + siret requis)')
    err.code = 'siret_missing'
    throw err
  }
  const optoutUrl = `https://movup.io/optout?from=${encodeURIComponent(raisonSociale)}&email=${encodeURIComponent(String(recipientEmail || ''))}`
  const rsHtml = escapeFooterHtml(raisonSociale)

  const html = `<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 12px;">
<div style="font-size:12px;color:#6b7280;line-height:1.55;font-family:Geist,Inter,Arial,sans-serif;">
  Cet email vous a été adressé par <strong style="color:#1D1D1F;">${rsHtml}</strong> (SIRET ${siret}) dans le cadre d'une prospection commerciale fondée sur l'intérêt légitime (article 6.1.f RGPD). Les données utilisées proviennent de la base publique INSEE/SIRENE.
  <br><br>
  Pour vous opposer à ces communications, exercer vos droits d'accès, de rectification ou d'effacement, ou contacter le DPO : <a href="${optoutUrl}" style="color:#1D1D1F;text-decoration:underline;">https://movup.io/optout</a>
</div>`

  const text = `\n---\nCet email vous a été adressé par ${raisonSociale} (SIRET ${siret}) dans le cadre d'une prospection commerciale fondée sur l'intérêt légitime (article 6.1.f RGPD). Les données utilisées proviennent de la base publique INSEE/SIRENE.\n\nPour vous opposer à ces communications, exercer vos droits d'accès, de rectification ou d'effacement, ou contacter le DPO :\n${optoutUrl}`

  return { html, text }
}

// Envoi campagne via batch API. Découpe en lots de 100, applique substitution {{variable}}
// par destinataire. Retourne { sent_count, failed_count, batch_ids[] }.
// user (Phase 6 Étape 14) : { raison_sociale, siret } pour le footer RGPD art. 14.
export async function sendCampaign(userId, { from, fromName, recipients, subject, html, text, replyTo, user }) {
  if (!Array.isArray(recipients) || recipients.length === 0) throw new Error('Aucun destinataire')
  const r = getResendClient()
  const BATCH_SIZE = 100
  const fromHeader = fromName ? `${fromName} <${from}>` : from
  const batchIds = []
  let sentCount = 0
  let failedCount = 0
  let lastError = null

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const slice = recipients.slice(i, i + BATCH_SIZE)
    const messages = slice.map(rec => {
      const vars = rec.variables || rec  // permet { email, prenom, ... } direct
      const renderedSubject = applyVariables(subject, vars)
      let renderedHtml = html ? applyVariables(html, vars) : undefined
      let renderedText = text ? applyVariables(text, vars) : undefined
      // Footer RGPD art. 14 par destinataire (lien opt-out personnalisé). Le
      // pré-check de la route garantit un user complet ; double-garde ici
      // (buildColdMailFooter throw siret_missing si incomplet).
      const footer = buildColdMailFooter(user, rec.email)
      if (renderedHtml !== undefined) renderedHtml += footer.html
      if (renderedText !== undefined) renderedText += footer.text
      if (renderedHtml === undefined && renderedText === undefined) renderedText = footer.text
      const headers = {}
      // Tracking : on tagge avec userId + campaign à mettre par caller via tags si besoin
      return {
        from: fromHeader,
        to: [rec.email],
        subject: renderedSubject,
        html: renderedHtml,
        text: renderedText,
        replyTo: replyTo || undefined,
        headers,
        tags: [
          { name: 'user', value: String(userId).slice(0, 50) }
        ]
      }
    })
    let batchFailed = false
    let batchError = null
    try {
      const result = await r.batch.send(messages)
      if (result.error) {
        batchFailed = true
        batchError = result.error.message || 'Resend batch.send error'
      } else {
        const data = result.data || {}
        const ids = Array.isArray(data.data) ? data.data.map(x => x.id) : []
        batchIds.push(...ids)
        sentCount += slice.length
      }
    } catch (e) {
      batchFailed = true
      batchError = e.message
    }
    if (batchFailed) {
      failedCount += slice.length
      lastError = batchError
      console.error('[sendCampaign] batch error', batchError)
    }
  }
  return { sent_count: sentCount, failed_count: failedCount, batch_ids: batchIds, total: recipients.length, last_error: lastError }
}

function applyVariables(template, vars) {
  if (!template) return template
  return String(template).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key) => {
    const v = vars && vars[key]
    return v === undefined || v === null ? '' : String(v)
  })
}

// ── Welcome email auto (déclenché après OAuth réussi) ──
// Idempotence : ne renvoie pas si mailbox_credentials.welcomeEmailSentAt existe déjà.
// Toujours via Resend (PAS via Gmail API) — on envoie depuis bonjour@movup.io.
export async function sendWelcomeEmail(db, { ownerId, userEmail, userName, companyId }) {
  if (!userEmail) throw new Error('userEmail requis')
  if (!isResendReady()) throw new Error('RESEND_API_KEY non configurée')

  // 1. Trouver le record mailbox_credentials correspondant pour idempotence + persistence
  const recordId = `${ownerId}__google__${String(userEmail).replace(/[^a-zA-Z0-9._-]/g, '_')}`
  const sel = await db.query('SELECT * FROM type::record("mailbox_credentials", $id)', { id: recordId })
  const cred = sel[0]?.[0]
  if (!cred) {
    // Pas de record : connexion non finalisée. On n'envoie pas (cas d'erreur en amont).
    console.warn('[welcome] mailbox_credentials introuvable pour', recordId)
    return { skipped: true, reason: 'no-credential' }
  }
  if (cred.welcomeEmailSentAt) {
    return { skipped: true, reason: 'already-sent', sentAt: cred.welcomeEmailSentAt }
  }

  // 2. Construire le contenu personnalisé
  const firstName = (userName && String(userName).trim().split(/\s+/)[0]) || (String(userEmail).split('@')[0] || '')
  const subject = `Bienvenue sur Movup, ${firstName}`
  const text = renderWelcomeText(firstName, userEmail)
  const html = renderWelcomeHtml(firstName, userEmail)

  // 3. Envoyer via Resend
  const r = getResendClient()
  let result
  try {
    result = await r.emails.send({
      from: 'Movup <bonjour@movup.io>',
      to: [userEmail],
      replyTo: 'bonjour@movup.io',
      subject,
      html,
      text,
      tags: [
        { name: 'kind', value: 'welcome' },
        { name: 'owner', value: String(ownerId).slice(0, 50) }
      ]
    })
  } catch (e) {
    console.error('[welcome] envoi Resend échec :', e.message)
    return { skipped: false, sent: false, error: e.message }
  }
  if (result.error) {
    console.error('[welcome] Resend error :', result.error.message)
    return { skipped: false, sent: false, error: result.error.message }
  }

  // 4. Persister welcomeEmailSentAt (idempotence)
  const now = new Date().toISOString()
  await db.query('UPDATE type::record("mailbox_credentials", $id) MERGE $body', {
    id: recordId,
    body: { welcomeEmailSentAt: now, updatedAt: now }
  })
  console.log('[welcome] envoyé à', userEmail, 'resendId=', result.data?.id)
  return { skipped: false, sent: true, resendId: result.data?.id, sentAt: now }
}

function renderWelcomeText(firstName, userEmail) {
  return [
    `Bienvenue sur Movup, ${firstName}.`,
    '',
    `Votre compte ${userEmail} est maintenant connecté.`,
    'Vous pouvez envoyer et recevoir vos emails de prospection directement depuis MUP.',
    '',
    'Trois prochaines étapes pour démarrer :',
    '  - Importer vos premiers prospects',
    '  - Connecter votre signature email',
    '  - Lancer votre première campagne',
    '',
    '— L\'équipe Movup',
    'movup.io',
    '',
    'Pour ne plus recevoir cet email : répondez avec "STOP".'
  ].join('\n')
}

function renderWelcomeHtml(firstName, userEmail) {
  // Logo Movup SVG inline monochrome noir (anti-spam : aucune image externe).
  // Width max 600px. Geist fallback Inter/Helvetica.
  const safeFirst = String(firstName).replace(/[<>&"]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;' }[c]))
  const safeEmail = String(userEmail).replace(/[<>&"]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;' }[c]))
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bienvenue sur Movup</title>
</head>
<body style="margin:0;padding:0;background:#F5F5F7;font-family:Geist,Inter,-apple-system,'Helvetica Neue',sans-serif;color:#1D1D1F;-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F5F5F7;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#FFFFFF;border:1px solid #E8E8ED;border-radius:14px;overflow:hidden;">
      <tr><td style="padding:32px 36px 0;">
        <svg width="86" height="22" viewBox="0 0 86 22" xmlns="http://www.w3.org/2000/svg" aria-label="Movup">
          <text x="0" y="17" font-family="Geist,Inter,Helvetica,sans-serif" font-size="20" font-weight="800" letter-spacing="-0.6" fill="#1D1D1F">Movup</text>
        </svg>
      </td></tr>
      <tr><td style="padding:24px 36px 0;">
        <h1 style="margin:0;font-size:22px;font-weight:800;letter-spacing:-0.5px;color:#1D1D1F;">Bienvenue sur Movup, ${safeFirst}</h1>
      </td></tr>
      <tr><td style="padding:14px 36px 0;font-size:14px;line-height:1.65;color:#1D1D1F;">
        <p style="margin:0;">Votre compte <strong style="color:#1D1D1F;">${safeEmail}</strong> est maintenant connecté. Vous pouvez envoyer et recevoir vos emails de prospection directement depuis MUP.</p>
      </td></tr>
      <tr><td style="padding:22px 36px 0;">
        <div style="font-size:10px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:#6E6E73;margin-bottom:10px;">Trois prochaines étapes</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td style="padding:10px 0;border-top:1px solid #E8E8ED;font-size:13.5px;color:#1D1D1F;">Importer vos premiers prospects</td></tr>
          <tr><td style="padding:10px 0;border-top:1px solid #E8E8ED;font-size:13.5px;color:#1D1D1F;">Connecter votre signature email</td></tr>
          <tr><td style="padding:10px 0;border-top:1px solid #E8E8ED;border-bottom:1px solid #E8E8ED;font-size:13.5px;color:#1D1D1F;">Lancer votre première campagne</td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:24px 36px 32px;font-size:12px;color:#6E6E73;line-height:1.6;">
        <div style="border-top:1px solid #E8E8ED;padding-top:18px;">
          <span style="font-weight:700;color:#1D1D1F;">Movup</span> · <a href="https://movup.io" style="color:#6E6E73;text-decoration:none;">movup.io</a> · <a href="mailto:bonjour@movup.io?subject=STOP" style="color:#6E6E73;text-decoration:underline;">Désinscription</a>
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`
}

// Validation signature webhook Resend (format Svix).
// Headers attendus : svix-id, svix-timestamp, svix-signature (ou resend-* en alias).
// signature header : "v1,base64sig v2,base64sig" — on accepte si AU MOINS une match.
export function verifyResendSignature(rawBody, headers) {
  const secret = process.env.RESEND_WEBHOOK_SECRET
  if (!secret) return { ok: false, reason: 'RESEND_WEBHOOK_SECRET not configured' }
  const id = headers['svix-id'] || headers['resend-id']
  const timestamp = headers['svix-timestamp'] || headers['resend-timestamp']
  const sigHeader = headers['svix-signature'] || headers['resend-signature']
  if (!id || !timestamp || !sigHeader) return { ok: false, reason: 'Headers Svix manquants' }
  if (!rawBody) return { ok: false, reason: 'rawBody absent' }

  // Anti-replay : refus si timestamp > 5 min écart
  const ts = Number(timestamp)
  const now = Math.floor(Date.now() / 1000)
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 300) {
    return { ok: false, reason: 'timestamp hors fenêtre (5 min)' }
  }

  const payload = `${id}.${timestamp}.${rawBody}`
  let secretBuf
  try {
    const stripped = secret.replace(/^whsec_/, '')
    secretBuf = Buffer.from(stripped, 'base64')
  } catch (e) {
    return { ok: false, reason: 'secret invalide' }
  }
  const expected = createHmac('sha256', secretBuf).update(payload).digest('base64')
  const sigs = String(sigHeader).split(' ').map(s => s.replace(/^v\d+,/, '')).filter(Boolean)
  for (const sig of sigs) {
    try {
      const a = Buffer.from(expected, 'base64')
      const b = Buffer.from(sig, 'base64')
      if (a.length === b.length && timingSafeEqual(a, b)) return { ok: true }
    } catch (e) {/* skip */}
  }
  return { ok: false, reason: 'signature invalide' }
}

// ── TRACK 1 : sendOne / listInbox / getMailStatus (inchangés depuis session 1) ──

async function loadMailConfig(db, userId) {
  const result = await db.query('SELECT * FROM type::record("mail_settings", $id)', { id: userId })
  return result[0]?.[0] || null
}

function buildSmtpTransport(config) {
  const host = config.smtp_host || config.imap_host
  const port = Number(config.smtp_port || 465)
  const secure = config.smtp_secure !== false && port === 465
  const user = config.imap_user || config.email
  let pass
  if (config.smtp_pass_encrypted) {
    pass = decrypt(config.smtp_pass_encrypted)
  } else if (config.imap_password_encrypted) {
    pass = decrypt(config.imap_password_encrypted)
  } else {
    throw new Error('IMAP password not stored — reconnect required')
  }
  return nodemailer.createTransport({
    host, port, secure,
    auth: { user, pass },
    requireTLS: !secure,
    tls: { rejectUnauthorized: true }
  })
}

export async function sendOne(db, userId, { to, subject, body, html, from_email, attachments }) {
  // 1. Si from_email fourni, prioriser une mailbox_credentials matching (OAuth Google/Microsoft)
  if (from_email) {
    const cred = await loadMailboxCredential(db, userId, from_email)
    if (cred) return sendViaCredential(db, cred, { to, subject, body, html, attachments })
  }
  // 2. Sinon, première mailbox_credentials du user (sélection auto si 1 seul compte connecté)
  const anyCred = await loadFirstMailboxCredential(db, userId)
  if (anyCred && !from_email) return sendViaCredential(db, anyCred, { to, subject, body, html, attachments })

  // 3. Fallback IMAP via mail_settings (session 1)
  const config = await loadMailConfig(db, userId)
  if (!config) throw new Error('Aucune boîte mail configurée pour cet utilisateur')
  const provider = config.provider || (config.smtp_pass_encrypted ? 'imap' : null)
  if (provider !== 'imap') throw new Error('Provider mail inconnu : ' + provider)

  const transport = buildSmtpTransport(config)
  const from = config.email
  const info = await transport.sendMail({
    from, to, subject,
    text: body || undefined,
    html: html || undefined,
    attachments: Array.isArray(attachments) ? attachments : undefined
  })
  return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected, response: info.response, provider: 'imap' }
}

// ── Mailbox credentials helpers ──

async function loadMailboxCredential(db, ownerId, email) {
  const r = await db.query(
    'SELECT * FROM mailbox_credentials WHERE ownerId = $owner AND email = $email LIMIT 1',
    { owner: ownerId, email }
  )
  return r[0]?.[0] || null
}

async function loadFirstMailboxCredential(db, ownerId) {
  const r = await db.query(
    'SELECT * FROM mailbox_credentials WHERE ownerId = $owner ORDER BY createdAt DESC LIMIT 1',
    { owner: ownerId }
  )
  return r[0]?.[0] || null
}

export async function listMailboxCredentials(db, ownerId) {
  const r = await db.query(
    'SELECT id, ownerId, provider, email, scope, tokenExpiresAt, createdAt, updatedAt FROM mailbox_credentials WHERE ownerId = $owner ORDER BY createdAt DESC',
    { owner: ownerId }
  )
  return r[0] || []
}

async function sendViaCredential(db, cred, opts) {
  if (cred.provider === 'google') return sendViaGoogle(db, cred, opts)
  if (cred.provider === 'microsoft') throw new Error('OAuth Microsoft non implémenté — voir session 3')
  throw new Error('Provider mailbox_credentials inconnu : ' + cred.provider)
}

// ── Gmail API : refresh + send + list ──

// Retourne un OAuth2Client prêt à l'emploi avec un access_token frais (refresh si <60s).
// Met à jour mailbox_credentials si refresh effectif.
async function ensureFreshGoogleClient(db, cred) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  )
  const refreshToken = decryptMailToken(cred.refreshToken)
  const expiryMs = cred.tokenExpiresAt ? new Date(cred.tokenExpiresAt).getTime() : 0
  const needsRefresh = !cred.accessToken || (expiryMs - Date.now() < 60_000)

  if (needsRefresh) {
    oauth2Client.setCredentials({ refresh_token: refreshToken })
    const { credentials } = await oauth2Client.refreshAccessToken()
    const newAccess = credentials.access_token
    const newExpiry = credentials.expiry_date ? new Date(credentials.expiry_date).toISOString() : null
    // Persist new access token + expiry. Refresh token reste le même sauf si Google en renvoie un (rare).
    const recordId = String(cred.id).replace(/^mailbox_credentials:/, '').replace(/^⟨+|⟩+$/g, '')
    const patch = {
      accessToken: encryptMailToken(newAccess),
      tokenExpiresAt: newExpiry,
      updatedAt: new Date().toISOString()
    }
    if (credentials.refresh_token) patch.refreshToken = encryptMailToken(credentials.refresh_token)
    await db.query('UPDATE type::record("mailbox_credentials", $id) MERGE $body', { id: recordId, body: patch })
    oauth2Client.setCredentials({ access_token: newAccess, refresh_token: credentials.refresh_token || refreshToken })
    return oauth2Client
  }

  oauth2Client.setCredentials({
    access_token: decryptMailToken(cred.accessToken),
    refresh_token: refreshToken
  })
  return oauth2Client
}

// Encode RFC 2822 → base64url pour gmail.users.messages.send
function buildRfc2822({ from, to, subject, body, html }) {
  const headers = []
  headers.push(`From: ${from}`)
  headers.push(`To: ${to}`)
  headers.push(`Subject: ${encodeRfc2047(subject || '')}`)
  headers.push('MIME-Version: 1.0')

  let raw
  if (html) {
    const boundary = 'mup_' + Math.random().toString(36).slice(2, 12)
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`)
    const parts = []
    if (body) {
      parts.push(`--${boundary}`)
      parts.push('Content-Type: text/plain; charset="UTF-8"')
      parts.push('Content-Transfer-Encoding: 8bit')
      parts.push('')
      parts.push(body)
    }
    parts.push(`--${boundary}`)
    parts.push('Content-Type: text/html; charset="UTF-8"')
    parts.push('Content-Transfer-Encoding: 8bit')
    parts.push('')
    parts.push(html)
    parts.push(`--${boundary}--`)
    raw = headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n')
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"')
    headers.push('Content-Transfer-Encoding: 8bit')
    raw = headers.join('\r\n') + '\r\n\r\n' + (body || '')
  }
  return Buffer.from(raw, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function encodeRfc2047(s) {
  // Si la chaîne contient des caractères non-ASCII, l'encoder en base64 avec wrappers RFC 2047
  if (/^[\x00-\x7F]*$/.test(s)) return s
  return '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?='
}

async function sendViaGoogle(db, cred, { to, subject, body, html }) {
  const auth = await ensureFreshGoogleClient(db, cred)
  const gmail = google.gmail({ version: 'v1', auth })
  const raw = buildRfc2822({ from: cred.email, to, subject, body, html })
  const { data } = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw }
  })
  return { messageId: data.id, threadId: data.threadId, provider: 'google' }
}

// Liste les messages reçus récents du compte Google connecté.
export async function listGoogleMessages(db, ownerId, email, { limit = 25, query = 'newer_than:7d' } = {}) {
  const cred = await loadMailboxCredential(db, ownerId, email)
  if (!cred || cred.provider !== 'google') throw new Error('Compte Google introuvable pour cet utilisateur')
  const auth = await ensureFreshGoogleClient(db, cred)
  const gmail = google.gmail({ version: 'v1', auth })
  const list = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: Math.min(Math.max(Number(limit) || 25, 1), 50),
    labelIds: ['INBOX']
  })
  const messages = list.data.messages || []
  const enveloppes = []
  for (const m of messages) {
    try {
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: m.id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date']
      })
      const headers = detail.data.payload?.headers || []
      const h = (name) => (headers.find(x => x.name === name) || {}).value || ''
      enveloppes.push({
        id: detail.data.id,
        threadId: detail.data.threadId,
        from: h('From'),
        subject: h('Subject'),
        snippet: detail.data.snippet || '',
        date: h('Date'),
        unread: (detail.data.labelIds || []).includes('UNREAD')
      })
    } catch (e) { /* skip message inaccessible */ }
  }
  return enveloppes
}

// Stub pour l'inbox listing — session 4+ implémente imapflow / Gmail API / Graph
export async function listInbox(db, userId, { limit = 25, offset = 0 } = {}) {
  const config = await loadMailConfig(db, userId)
  if (!config) return []
  const provider = config.provider || (config.smtp_pass_encrypted ? 'imap' : null)
  if (provider === 'google' || provider === 'microsoft') {
    throw new Error('listInbox via OAuth non implémenté en session 1')
  }
  // imap : déjà partiellement supporté par les anciennes routes /api/mail/sync.
  // Branche complète à venir en session ultérieure.
  return []
}

export async function getMailStatus(db, userId) {
  const config = await loadMailConfig(db, userId)
  if (!config) return { connected: false, provider: null, email: null }
  const provider = config.provider || (config.smtp_pass_encrypted ? 'imap' : null)
  return {
    connected: Boolean(provider),
    provider,
    email: config.email || null,
    needs_reconnect: Boolean(config.needs_reconnect)
  }
}
