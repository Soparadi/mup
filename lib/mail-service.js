// Service unifié mail — Track 1 (1:1) + Track 2 (campagnes Resend).
// Track 1 : sendOne, listInbox, getMailStatus (provider imap fonctionnel, oauth en sessions ultérieures)
// Track 2 : ensureResendClient, verifyDomain, getDomainStatus, sendCampaign, verifyResendSignature, handleResendEvent

import nodemailer from 'nodemailer'
import { Resend } from 'resend'
import { createHmac, timingSafeEqual } from 'crypto'
import { decrypt } from './crypto.js'

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
// Si Resend retourne 409 (déjà existant), liste les domaines pour retrouver l'id.
export async function verifyResendDomain(domainName) {
  const r = getResendClient()
  try {
    const created = await r.domains.create({ name: domainName })
    if (created.error) {
      const msg = created.error.message || ''
      if (created.error.statusCode === 422 || /already exists/i.test(msg)) {
        // Lookup
        const list = await r.domains.list()
        const found = (list.data?.data || list.data || []).find(d => d.name === domainName)
        if (found) return { id: found.id, name: found.name, status: found.status, records: found.records || [], existing: true }
        throw new Error(msg || 'Domaine déjà existant mais introuvable via list')
      }
      throw new Error(msg || 'Resend create domain failed')
    }
    const data = created.data || {}
    return { id: data.id, name: data.name, status: data.status, records: data.records || [], existing: false }
  } catch (e) {
    // Filet de sécurité supplémentaire pour les libs qui throw au lieu de retourner error
    if (e && /already exists/i.test(String(e.message || ''))) {
      const list = await r.domains.list()
      const found = (list.data?.data || list.data || []).find(d => d.name === domainName)
      if (found) return { id: found.id, name: found.name, status: found.status, records: found.records || [], existing: true }
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
    try {
      const result = await r.batch.send(messages)
      if (result.error) {
        failedCount += slice.length
        throw new Error(result.error.message || 'Resend batch.send error')
      }
      const data = result.data || {}
      const ids = Array.isArray(data.data) ? data.data.map(x => x.id) : []
      batchIds.push(...ids)
      sentCount += slice.length
    } catch (e) {
      failedCount += slice.length
      // On ne propage pas l'erreur : on capture pour que les autres batches continuent.
      // Le caller récupère sent_count/failed_count pour le log.
      console.error('[sendCampaign] batch error', e.message)
    }
  }
  return { sent_count: sentCount, failed_count: failedCount, batch_ids: batchIds, total: recipients.length }
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

export async function sendOne(db, userId, { to, subject, body, html, attachments }) {
  const config = await loadMailConfig(db, userId)
  if (!config) throw new Error('Aucune boîte mail configurée pour cet utilisateur')

  const provider = config.provider || (config.smtp_pass_encrypted ? 'imap' : null)
  if (!provider) throw new Error('Provider mail inconnu — reconnexion requise')

  if (provider === 'google') {
    throw new Error('OAuth Google non configuré — voir session 2 (README-mail.md)')
  }
  if (provider === 'microsoft') {
    throw new Error('OAuth Microsoft non configuré — voir session 3 (README-mail.md)')
  }
  if (provider !== 'imap') {
    throw new Error('Provider mail inconnu : ' + provider)
  }

  const transport = buildSmtpTransport(config)
  const from = config.email
  const info = await transport.sendMail({
    from, to, subject,
    text: body || undefined,
    html: html || undefined,
    attachments: Array.isArray(attachments) ? attachments : undefined
  })
  return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected, response: info.response }
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
