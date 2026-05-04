// Service unifié d'envoi mail — Track 1 (1:1).
// Switch sur le provider stocké dans mail_settings du user.
// Session 1 : seule la branche imap est implémentée. google/microsoft → throw explicite.
//
// sendOne(db, userId, { to, subject, body, attachments? }) → { messageId, accepted, ... }
// listInbox(db, userId, { limit, offset }) → array d'enveloppes (à brancher session ultérieure)

import nodemailer from 'nodemailer'
import { decrypt } from './crypto.js'

// Récupère la config mail d'un user. Renvoie null si non configurée.
async function loadMailConfig(db, userId) {
  const result = await db.query('SELECT * FROM type::record("mail_settings", $id)', { id: userId })
  return result[0]?.[0] || null
}

// Construit un transport nodemailer SMTP à partir des champs IMAP/SMTP du record.
// Le password déchiffré n'est tenu en mémoire que le temps de la requête.
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
