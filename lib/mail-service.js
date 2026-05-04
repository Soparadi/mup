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

// Envoi campagne via batch API. Découpe en lots de 100, applique substitution {{variable}}
// par destinataire. Retourne { sent_count, failed_count, batch_ids[] }.
export async function sendCampaign(userId, { from, fromName, recipients, subject, html, text, replyTo }) {
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
      const renderedHtml = html ? applyVariables(html, vars) : undefined
      const renderedText = text ? applyVariables(text, vars) : undefined
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
