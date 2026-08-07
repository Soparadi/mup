// Service unifié mail — Track 1 (1:1) + Track 2 (campagnes Resend).
// Track 1 : sendOne, listInbox, listGoogleMessages, getMailStatus
//   → provider imap (session 1), google (session 2, gmail.users.messages.send/list), microsoft (session 3 stub)
// Track 2 : ensureResendClient, verifyDomain, getDomainStatus, sendCampaign, verifyResendSignature, handleResendEvent

import nodemailer from 'nodemailer'
import { Resend } from 'resend'
import { google } from 'googleapis'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { createHmac, timingSafeEqual } from 'crypto'
import { decrypt, encryptMailToken, decryptMailToken } from './crypto.js'
import { sendMailboxConnected } from '../server/services/email.js'

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

// ── Identifiant d'un record mailbox_credentials ──
// SOURCE UNIQUE de la clé : « ownerId__provider__email assaini ». Les callbacks
// OAuth l'écrivent, les routes de déconnexion et sendWelcomeEmail la relisent —
// tous par ici. La formule ne doit exister qu'à cet endroit : un fournisseur en
// dur recopié dans un appelant a déjà rendu les boîtes Microsoft introuvables.
// L'assainissement (tout ce qui n'est ni alphanumérique ni . _ - devient _) est
// contractuel : le modifier orpheline les credentials déjà en base.
// Seul le fournisseur est contrôlé — l'omettre donnerait une clé silencieusement
// introuvable. ownerId et email ne le sont pas : les appelants les valident déjà
// (session vérifiée, 400 si email absent), et un contrôle de plus ici changerait
// leurs réponses.
export function mailboxCredentialId(ownerId, provider, email) {
  if (!provider) throw new Error('provider requis')
  return `${ownerId}__${provider}__${String(email).replace(/[^a-zA-Z0-9._-]/g, '_')}`
}

// ── Confirmation de connexion de boîte (déclenchée après OAuth réussi) ──
// Idempotence : ne renvoie pas si mailbox_credentials.welcomeEmailSentAt existe déjà.
// Toujours via Resend (PAS via Gmail API) — on envoie depuis bonjour@movup.io.
// Le rendu et l'envoi sont délégués à sendMailboxConnected (server/services/
// email.js) : ce courriel suit le gabarit commun aux transactionnels MovUP.
export async function sendWelcomeEmail(db, { ownerId, userEmail, userName, companyId, provider }) {
  if (!userEmail) throw new Error('userEmail requis')
  if (!provider) throw new Error('provider requis')
  if (!isResendReady()) throw new Error('RESEND_API_KEY non configurée')

  // 1. Trouver le record mailbox_credentials correspondant pour idempotence + persistence.
  // Clé bâtie par mailboxCredentialId, avec le fournisseur reçu de l'appelant :
  // une valeur en dur ici ne retrouverait jamais les credentials de l'autre.
  const recordId = mailboxCredentialId(ownerId, provider, userEmail)
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

  // 2. Salutation : prénom (et nom) du COMPTE MovUP, comme les autres
  // transactionnels. Le nom fourni par le provider OAuth ne sert que de
  // repli si le compte est introuvable — jamais la partie gauche de l'adresse.
  let account = null
  try {
    const u = await db.query('SELECT prenom, nom FROM type::record("user", $id)', { id: ownerId })
    account = u[0]?.[0] || null
  } catch (e) {
    console.warn('[welcome] lecture user échouée, repli sur le nom OAuth :', e.message)
  }
  const recipient = { prenom: account?.prenom || '', nom: account?.nom || '', name: userName || '' }

  // 3. Envoyer via Resend, au gabarit transactionnel
  let result
  try {
    result = await sendMailboxConnected(recipient, userEmail)
  } catch (e) {
    console.error('[welcome] envoi Resend échec :', e.message)
    return { skipped: false, sent: false, error: e.message }
  }

  // 4. Persister welcomeEmailSentAt (idempotence)
  const now = new Date().toISOString()
  await db.query('UPDATE type::record("mailbox_credentials", $id) MERGE $body', {
    id: recordId,
    body: { welcomeEmailSentAt: now, updatedAt: now }
  })
  console.log('[welcome] envoyé à', userEmail, 'resendId=', result.id)
  return { skipped: false, sent: true, resendId: result.id, sentAt: now }
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

// Bornes de l'envoi, aux valeurs de la lecture IMAP (IMAP_CONNECTION_TIMEOUT et
// suivants) : un envoi ne doit pas pendre plus longtemps qu'une lecture. Sans
// elles, nodemailer laisse courir deux minutes sur la connexion et dix sur la
// socket — l'abonné lit « Envoi… » sans fin et rien ne s'écrit dans les logs.
const SMTP_CONNECTION_TIMEOUT = 15_000
const SMTP_GREETING_TIMEOUT = 10_000
const SMTP_SOCKET_TIMEOUT = 30_000
const SMTP_DNS_TIMEOUT = 10_000

// Les journaux nomment le compte sans jamais l'écrire en clair : de quoi suivre
// une tentative en production, rien de quoi rejouer une connexion.
function maskEmail(value) {
  const s = String(value || '')
  const at = s.indexOf('@')
  if (at < 1) return s ? '***' : '(inconnu)'
  return s[0] + '***' + s.slice(at)
}

// Le mot de passe d'envoi porte trois noms de champ selon la génération du
// record. L'ordre met smtp_pass_encrypted en tête — c'est celui de l'envoi —
// puis les deux noms IMAP, exactement ceux que lit imapPasswordOf. L'envoi
// n'est pas moins tolérant que la lecture.
function smtpPasswordOf(config) {
  const encrypted = config.smtp_pass_encrypted || config.imap_password_encrypted || config.imap_pass_encrypted
  if (!encrypted) return null
  return decrypt(encrypted)
}

// L'hôte d'envoi ne se devine pas. Reprendre imap_host faute de smtp_host
// faisait parler SMTP à un serveur IMAP : la connexion pendait sans réponse.
// Une boîte sans serveur d'envoi renseigné se reconnecte, elle ne s'invente pas.
function buildSmtpTransport(config) {
  const host = config.smtp_host
  if (!host) {
    throw mailError('Serveur d\'envoi (SMTP) non renseigné pour cette boîte — reconnectez-la depuis les Paramètres', 'reconnect_required')
  }
  const port = Number(config.smtp_port || 465)
  const secure = config.smtp_secure !== false && port === 465
  const user = config.imap_user || config.email
  let pass
  try {
    pass = smtpPasswordOf(config)
  } catch (e) {
    throw mailError('Mot de passe d\'envoi illisible — reconnexion nécessaire', 'reconnect_required')
  }
  if (!pass) throw mailError('Mot de passe d\'envoi absent — reconnexion nécessaire', 'reconnect_required')

  const transport = nodemailer.createTransport({
    host, port, secure,
    auth: { user, pass },
    requireTLS: !secure,
    tls: { rejectUnauthorized: true },
    connectionTimeout: SMTP_CONNECTION_TIMEOUT,
    greetingTimeout: SMTP_GREETING_TIMEOUT,
    socketTimeout: SMTP_SOCKET_TIMEOUT,
    dnsTimeout: SMTP_DNS_TIMEOUT
  })
  return { transport, host, port, secure }
}

// ── Domaine vérifié : le transport, pas l'adresse ──
// Un domaine que l'abonné a fait vérifier chez Resend porte ses propres SPF,
// DKIM et DMARC. Une adresse de ce domaine part donc par Resend, y compris
// quand une boîte du même nom est connectée par ailleurs : l'adresse écrite
// dans le message ne change pas, seul le chemin qu'elle emprunte change.

export function domainOf(email) {
  const at = String(email || '').lastIndexOf('@')
  return at < 0 ? '' : String(email).slice(at + 1).trim().toLowerCase()
}

// Les domaines vérifiés de CET abonné, en minuscules. La table est définie au
// démarrage ; sur une instance qui n'a jamais servi les campagnes, une absence
// vaut liste vide et non erreur d'envoi.
export async function listVerifiedResendDomains(db, userId) {
  try {
    const r = await db.query(
      'SELECT domain_name FROM domains_resend WHERE userId = $userId AND status = "verified"',
      { userId }
    )
    return (r[0] || []).map(d => String(d.domain_name || '').trim().toLowerCase()).filter(Boolean)
  } catch (e) {
    if (String(e?.message || '').includes('does not exist')) return []
    throw e
  }
}

export async function isVerifiedResendSender(db, userId, email) {
  const domaine = domainOf(email)
  if (!domaine) return false
  return (await listVerifiedResendDomains(db, userId)).includes(domaine)
}

// Une valeur de tag Resend n'accepte que lettres, chiffres, tiret et souligné.
function tagValue(v) {
  return String(v || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50)
}

async function sendViaResend(userId, from, { to, subject, body, html, attachments }) {
  const r = getResendClient()
  const destinataires = Array.isArray(to)
    ? to
    : String(to).split(',').map(s => s.trim()).filter(Boolean)
  const pieces = Array.isArray(attachments) && attachments.length
    ? attachments.map(a => ({
        filename: a.filename || 'piece-jointe',
        content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : a.content
      }))
    : undefined
  // Resend exige au moins une partie de contenu : un message sans corps ni
  // HTML part avec un texte vide plutôt que d'être refusé pour champ manquant.
  const texte = body || (html ? undefined : '')
  let result
  try {
    result = await r.emails.send({
      from,
      to: destinataires,
      subject,
      text: texte,
      html: html || undefined,
      attachments: pieces,
      tags: [{ name: 'kind', value: 'direct' }, { name: 'user', value: tagValue(userId) }]
    })
  } catch (e) {
    console.error('[mail:send] échec via Resend —', e.message)
    throw mailError('Votre message n\'a pas pu partir par votre domaine vérifié : ' + e.message, 'resend_failed')
  }
  if (result.error) {
    const motif = result.error.message || 'Resend a refusé l\'envoi'
    console.error('[mail:send] échec via Resend —', motif)
    throw mailError('Votre message n\'a pas pu partir par votre domaine vérifié : ' + motif, 'resend_failed')
  }
  const id = result.data?.id || null
  console.log('[mail:send] remis par Resend —', destinataires.length, 'destinataire(s), id', id)
  return {
    messageId: id,
    accepted: destinataires,
    rejected: [],
    response: 'Accepté par Resend',
    provider: 'resend',
    from,
    to: destinataires
  }
}

export async function sendOne(db, userId, { to, subject, body, html, from_email, attachments }) {
  // 0. Adresse relevant d'un domaine vérifié : Resend l'achemine, même si une
  //    boîte du même nom est connectée. Sans clé Resend, l'envoi retombe sur
  //    les chemins ci-dessous plutôt que d'échouer.
  if (from_email && isResendReady() && await isVerifiedResendSender(db, userId, from_email)) {
    console.log('[mail:send] compte', maskEmail(from_email), '— transport resend (domaine vérifié)')
    return sendViaResend(userId, from_email, { to, subject, body, html, attachments })
  }
  // 1. Si from_email fourni, prioriser une mailbox_credentials matching (OAuth Google/Microsoft)
  if (from_email) {
    const cred = await loadMailboxCredential(db, userId, from_email)
    if (cred) {
      console.log('[mail:send] compte', maskEmail(cred.email), '— transport', cred.provider, '(expéditeur choisi)')
      return sendViaCredential(db, cred, { to, subject, body, html, attachments })
    }
  }
  // 2. Sinon, première mailbox_credentials du user (sélection auto si 1 seul compte connecté)
  const anyCred = await loadFirstMailboxCredential(db, userId)
  if (anyCred && !from_email) {
    console.log('[mail:send] compte', maskEmail(anyCred.email), '— transport', anyCred.provider, '(choix automatique)')
    return sendViaCredential(db, anyCred, { to, subject, body, html, attachments })
  }

  // 3. Fallback IMAP via mail_settings (session 1)
  const config = await loadMailConfig(db, userId)
  if (!config) throw new Error('Aucune boîte mail configurée pour cet utilisateur')
  const provider = config.provider || (config.smtp_pass_encrypted ? 'imap' : null)
  if (provider !== 'imap') throw new Error('Provider mail inconnu : ' + provider)

  const { transport, host, port, secure } = buildSmtpTransport(config)
  const cible = host + ':' + port
  console.log('[mail:send] compte', maskEmail(config.email), '— transport smtp', cible, secure ? 'TLS implicite' : 'STARTTLS')
  const from = config.email
  try {
    const info = await transport.sendMail({
      from, to, subject,
      text: body || undefined,
      html: html || undefined,
      attachments: Array.isArray(attachments) ? attachments : undefined
    })
    console.log('[mail:send] remis par', cible, '—', (info.accepted || []).length, 'accepté(s),', (info.rejected || []).length, 'refusé(s)')
    return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected, response: info.response, provider: 'imap' }
  } catch (err) {
    // Identifiant refusé : on pose needs_reconnect comme le fait la lecture. Une
    // panne réseau ou un délai dépassé ne le pose pas — la boîte reste valide.
    const kind = classifyMailError(err)
    console.error('[mail:send] échec via', cible, '—', kind, '—', err.message)
    if (kind === 'auth') {
      await markNeedsReconnect(db, userId)
      throw mailError('Identifiants d\'envoi refusés — reconnectez votre boîte depuis les Paramètres', 'reconnect_required')
    }
    throw err
  } finally {
    transport.close()
  }
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
  if (cred.provider === 'microsoft') return sendViaMicrosoft(db, cred, opts)
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

// ── Microsoft Graph : refresh + sendMail ──

// Retourne un access_token frais (refresh via l'endpoint token Microsoft si <60s
// de la péremption). Persiste le nouvel access_token/expiry — et le refresh_token
// si Microsoft en émet un nouveau (rotation). Miroir de ensureFreshGoogleClient.
async function ensureFreshMicrosoftToken(db, cred) {
  const expiryMs = cred.tokenExpiresAt ? new Date(cred.tokenExpiresAt).getTime() : 0
  const needsRefresh = !cred.accessToken || (expiryMs - Date.now() < 60_000)
  if (!needsRefresh) return decryptMailToken(cred.accessToken)

  const { refreshAccessToken } = await import('./oauth-microsoft.js')
  const refreshToken = decryptMailToken(cred.refreshToken)
  const credentials = await refreshAccessToken(refreshToken)
  const newAccess = credentials.access_token
  if (!newAccess) throw new Error('Refresh Microsoft : access_token absent')
  const newExpiry = credentials.expiry_date ? new Date(credentials.expiry_date).toISOString() : null
  const recordId = String(cred.id).replace(/^mailbox_credentials:/, '').replace(/^⟨+|⟩+$/g, '')
  const patch = {
    accessToken: encryptMailToken(newAccess),
    tokenExpiresAt: newExpiry,
    updatedAt: new Date().toISOString()
  }
  if (credentials.refresh_token) patch.refreshToken = encryptMailToken(credentials.refresh_token)
  await db.query('UPDATE type::record("mailbox_credentials", $id) MERGE $body', { id: recordId, body: patch })
  return newAccess
}

async function sendViaMicrosoft(db, cred, { to, subject, body, html }) {
  const accessToken = await ensureFreshMicrosoftToken(db, cred)
  const recipients = String(to || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(addr => ({ emailAddress: { address: addr } }))
  const message = {
    subject: subject || '',
    body: {
      contentType: html ? 'HTML' : 'Text',
      content: html || body || ''
    },
    toRecipients: recipients
  }
  const resp = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message, saveToSentItems: true })
  })
  // Graph sendMail répond 202 Accepted sans corps ni id de message.
  if (resp.status !== 202) {
    let detail = resp.status
    try { const err = await resp.json(); detail = err.error?.message || detail } catch (e) { /* pas de corps JSON */ }
    throw new Error('Envoi Microsoft Graph échoué : ' + detail)
  }
  return { messageId: null, provider: 'microsoft' }
}

// Liste les messages récents du compte Google connecté. folder : 'inbox' | 'sent'.
export async function listGoogleMessages(db, ownerId, email, { limit = 25, query = 'newer_than:7d', folder = 'inbox' } = {}) {
  const cred = await loadMailboxCredential(db, ownerId, email)
  if (!cred || cred.provider !== 'google') throw new Error('Compte Google introuvable pour cet utilisateur')
  const auth = await ensureFreshGoogleClient(db, cred)
  const gmail = google.gmail({ version: 'v1', auth })
  const list = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: Math.min(Math.max(Number(limit) || 25, 1), 50),
    labelIds: [folder === 'sent' ? 'SENT' : 'INBOX']
  })
  const messages = list.data.messages || []
  const enveloppes = []
  for (const m of messages) {
    try {
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: m.id,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date']
      })
      const headers = detail.data.payload?.headers || []
      const h = (name) => (headers.find(x => x.name === name) || {}).value || ''
      enveloppes.push({
        id: detail.data.id,
        threadId: detail.data.threadId,
        from: h('From'),
        to: h('To'),
        subject: h('Subject'),
        snippet: detail.data.snippet || '',
        date: h('Date'),
        unread: (detail.data.labelIds || []).includes('UNREAD'),
        folder: folder === 'sent' ? 'sent' : 'inbox'
      })
    } catch (e) { /* skip message inaccessible */ }
  }
  return enveloppes
}

// ── Lecture IMAP (Reçus / Envoyés) ──
// Enveloppes seulement : aucun corps n'est rapatrié par la liste, aucun message
// n'est écrit en base. Une connexion par requête, fermée dans tous les cas.

const IMAP_CONNECTION_TIMEOUT = 15_000
const IMAP_GREETING_TIMEOUT = 10_000
const IMAP_SOCKET_TIMEOUT = 30_000
const IMAP_MAX_MESSAGES = 50

// Noms du dossier d'envoi chez les serveurs qui n'annoncent pas l'attribut
// d'usage spécial \Sent. Comparaison sans casse ni accents (voir foldKey).
const SENT_FOLDER_NAMES = [
  'sent', 'sent items', 'sent mail', 'sent messages', 'sentmail',
  'elements envoyes', 'messages envoyes', 'courrier envoye', 'envoyes',
  'gesendet', 'gesendete elemente', 'gesendete objekte',
  'enviados', 'elementos enviados', 'posta inviata', 'verzonden items'
].map(foldKey)

function foldKey(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

function mailError(message, code) {
  const err = new Error(message)
  err.code = code
  return err
}

// Sépare l'identifiant refusé de la panne réseau : seul le premier cas doit
// poser needs_reconnect et inviter l'abonné à reconnecter sa boîte.
//
// Le consentement trop étroit forme un troisième cas, à ne confondre avec aucun
// des deux : la boîte répond, l'identifiant est bon, c'est l'AUTORISATION qui
// manque. Classé en réseau, il invitait à « réessayer dans un instant » — un
// conseil qui ne pouvait jamais aboutir. Testé avant le cas 'auth' pour que
// l'ordre des motifs ne décide de rien.
export function classifyMailError(err) {
  const msg = String(err?.message || '')
  if (/insufficient authentication scopes|insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient_scope|Request had insufficient/i.test(msg)) {
    return 'scope'
  }
  if (err && err.authenticationFailed) return 'auth'
  if (/AUTHENTICATIONFAILED|AUTHORIZATIONFAILED|Invalid credentials|Authentication failed|LOGIN failed|invalid_grant|invalid_client|Username and Password not accepted/i.test(msg)) {
    return 'auth'
  }
  return 'network'
}

async function markNeedsReconnect(db, userId) {
  try {
    await db.query('UPDATE type::record("mail_settings", $id) MERGE $body', {
      id: userId,
      body: { needs_reconnect: true, updated_at: new Date().toISOString() }
    })
  } catch (e) {
    console.error('[imap] pose de needs_reconnect impossible :', e.message)
  }
}

// Le mot de passe a deux noms de champ selon la génération du record :
// imap_password_encrypted (route v2) et imap_pass_encrypted (route legacy).
function imapPasswordOf(config) {
  const encrypted = config.imap_password_encrypted || config.imap_pass_encrypted || config.smtp_pass_encrypted
  if (!encrypted) return null
  return decrypt(encrypted)
}

// Renvoie la boîte IMAP de l'abonné, ou null. Sert à l'aiguillage par
// fournisseur : le compte se déduit toujours de la session, jamais du client.
export async function getImapAccount(db, userId) {
  const config = await loadMailConfig(db, userId)
  if (!config || !config.imap_host) return null
  if (!config.imap_password_encrypted && !config.imap_pass_encrypted && !config.smtp_pass_encrypted) return null
  return {
    email: config.email || config.imap_user || null,
    host: config.imap_host,
    needs_reconnect: Boolean(config.needs_reconnect)
  }
}

// Ouvre une connexion, exécute fn, ferme dans tous les cas — y compris en
// erreur. Pas de mise en réserve de connexions dans cette passe.
async function withImapClient(db, userId, fn) {
  const config = await loadMailConfig(db, userId)
  if (!config || !config.imap_host) throw mailError('Aucune boîte mail configurée pour cet utilisateur', 'no_account')
  let password
  try {
    password = imapPasswordOf(config)
  } catch (e) {
    throw mailError('Mot de passe IMAP illisible — reconnexion nécessaire', 'reconnect_required')
  }
  if (!password) throw mailError('Mot de passe IMAP absent — reconnexion nécessaire', 'reconnect_required')

  const client = new ImapFlow({
    host: config.imap_host,
    port: Number(config.imap_port || 993),
    secure: config.imap_secure !== false,
    auth: { user: config.imap_user || config.email, pass: password },
    connectionTimeout: IMAP_CONNECTION_TIMEOUT,
    greetingTimeout: IMAP_GREETING_TIMEOUT,
    socketTimeout: IMAP_SOCKET_TIMEOUT,
    logger: false
  })
  let connected = false
  try {
    await client.connect()
    connected = true
    return await fn(client)
  } catch (err) {
    if (err.code === 'reconnect_required' || classifyMailError(err) === 'auth') {
      err.mailKind = 'auth'
      await markNeedsReconnect(db, userId)
    } else if (!err.code) {
      err.mailKind = 'network'
    }
    throw err
  } finally {
    try {
      if (connected) await client.logout()
      else client.close()
    } catch (e) {
      try { client.close() } catch (e2) { /* socket déjà tombé */ }
    }
  }
}

// Chemin du dossier demandé. 'sent' : attribut \Sent annoncé par le serveur en
// priorité, liste de noms connus en repli, erreur explicite si rien ne matche.
async function resolveFolderPath(client, folder) {
  if (folder !== 'sent') return 'INBOX'
  const boxes = await client.list()
  const special = boxes.find(b => b.specialUse === '\\Sent')
  if (special) return special.path
  const named = boxes.find(b => SENT_FOLDER_NAMES.includes(foldKey(b.path)) || SENT_FOLDER_NAMES.includes(foldKey(b.name)))
  if (named) return named.path
  throw mailError('Votre fournisseur n\'annonce aucun dossier « Envoyés » sous un nom reconnu.', 'no_sent_folder')
}

function formatImapAddress(list) {
  if (!Array.isArray(list) || !list.length) return ''
  return list.slice(0, 3).map(a => {
    const address = a.address || ''
    return a.name ? `${a.name} <${address}>` : address
  }).join(', ') + (list.length > 3 ? `, +${list.length - 3}` : '')
}

function hasFlag(flags, flag) {
  if (!flags) return false
  if (typeof flags.has === 'function') return flags.has(flag)
  return Array.isArray(flags) && flags.includes(flag)
}

// Cinquante messages les plus récents du dossier, enveloppes seules.
export async function listImapMessages(db, userId, { folder = 'inbox', limit = IMAP_MAX_MESSAGES } = {}) {
  const wanted = folder === 'sent' ? 'sent' : 'inbox'
  const count = Math.min(Math.max(Number(limit) || IMAP_MAX_MESSAGES, 1), IMAP_MAX_MESSAGES)
  return withImapClient(db, userId, async (client) => {
    const path = await resolveFolderPath(client, wanted)
    const lock = await client.getMailboxLock(path)
    try {
      const exists = client.mailbox?.exists || 0
      if (!exists) return []
      const range = `${Math.max(1, exists - count + 1)}:${exists}`
      const enveloppes = []
      for await (const msg of client.fetch(range, { uid: true, envelope: true, flags: true })) {
        const env = msg.envelope || {}
        enveloppes.push({
          id: String(msg.uid),
          from: formatImapAddress(env.from),
          to: formatImapAddress(env.to),
          subject: env.subject || '',
          snippet: '',
          date: env.date ? new Date(env.date).toISOString() : null,
          unread: !hasFlag(msg.flags, '\\Seen'),
          folder: wanted
        })
      }
      return enveloppes.reverse()
    } finally {
      lock.release()
    }
  })
}

// ── Corps d'un message (chargé au clic, jamais par la liste) ──
// Le corps d'un courriel est du contenu hostile par défaut. Deux champs
// partent donc ensemble, et ils ne servent pas à la même chose :
//   text — la partie text/plain, ou à défaut le texte EXTRAIT du HTML, balises
//          comprises. Repli d'affichage et matière des extraits de la liste.
//   html — la partie text/html TELLE QUELLE, non retouchée, non assainie.
// Ce html n'est jamais sûr à insérer dans une page : la page le rend dans un
// cadre isolé (iframe sandbox, sans script ni accès à la session), et c'est ce
// confinement — pas un filtrage ici — qui tient la sécurité.

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  agrave: 'à', acirc: 'â', ccedil: 'ç', ugrave: 'ù', ucirc: 'û',
  ocirc: 'ô', icirc: 'î', iuml: 'ï', oelig: 'œ', aelig: 'æ',
  laquo: '«', raquo: '»', hellip: '…', mdash: '—', ndash: '–',
  rsquo: '’', lsquo: '‘', ldquo: '"', rdquo: '"',
  euro: '€', pound: '£', deg: '°', middot: '·', bull: '•', times: '×'
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => {
      const v = NAMED_ENTITIES[name.toLowerCase()]
      return v === undefined ? m : v
    })
}

function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  try { return String.fromCodePoint(code) } catch (e) { return '' }
}

// Extraction de texte : les balises ne sont pas assainies, elles sont
// SUPPRIMÉES. Ce qui sort est une chaîne sans balisage.
export function htmlToText(html) {
  let s = String(html || '')
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  s = s.replace(/<(script|style|head|title|noscript)\b[\s\S]*?(<\/\1\s*>|$)/gi, ' ')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table|section|article)\s*>/gi, '\n')
  s = s.replace(/<(hr|p|div|tr|li|h[1-6]|blockquote)\b[^>]*>/gi, '\n')
  s = s.replace(/<[^>]*>/g, '')
  s = decodeEntities(s)
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// mailparser a déjà fait le décodage MIME : quoted-printable, base64 et jeux
// de caractères autres qu'UTF-8 sont résolus avant d'arriver ici.
function bodyTextOf(parsed) {
  if (parsed.text && parsed.text.trim()) return parsed.text
  if (parsed.html) return htmlToText(parsed.html)
  return ''
}

// La partie text/html d'origine, ou rien. mailparser met `html` à false quand
// le message n'en a pas ; son `textAsHtml`, fabriqué à partir du texte, n'est
// pas une partie HTML du message et n'a donc rien à faire ici : sans vraie
// partie HTML, la page doit retomber sur le texte.
function bodyHtmlOf(parsed) {
  return typeof parsed.html === 'string' ? parsed.html : ''
}

// ── Parties en ligne (cid:) ──
// Un courriel soigné ne pointe pas son logo sur le web : il le transporte, en
// pièce en ligne, et son HTML l'appelle par src="cid:...". Ces octets-là sont
// déjà dans le message téléchargé — les afficher ne demande aucune requête et
// n'apprend donc rien à l'expéditeur. C'est ce qui les sépare des images
// distantes, dont le blocage ne bouge pas d'un pouce.
//
// Le message reste hostile par défaut, donc ce qui remonte est borné :
//   — types : une liste blanche d'images matricielles, tout le reste est
//     refusé. image/svg+xml en est exclu à dessein : c'est un document, pas une
//     image, et un logo ne vaut pas qu'on en transporte un.
//   — taille : chaque partie est plafonnée, et le cumul aussi, pour qu'un
//     message ne puisse pas faire enfler la réponse ni le document affiché.
const TYPES_IMAGE_EN_LIGNE = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif',
  'image/webp', 'image/bmp', 'image/avif', 'image/x-icon', 'image/vnd.microsoft.icon'
])
const IMAGE_EN_LIGNE_MAX = 512 * 1024
const IMAGES_EN_LIGNE_CUMUL_MAX = 2 * 1024 * 1024
const IMAGES_EN_LIGNE_NOMBRE_MAX = 20

// skipImageLinks coupe une incorporation que mailparser fait de lui-même :
// laissé libre, il remplace les cid: du HTML par des data: SANS AUCUNE BORNE
// DE TAILLE — une pièce de vingt mégaoctets entrait telle quelle dans la
// réponse puis dans le document. La substitution passe donc désormais par
// imagesEnLigneOf, qui plafonne, et le html rendu redevient ce que le
// commentaire d'en-tête promet : la partie du message, non retouchée.
const OPTIONS_PARSEUR = { skipImageLinks: true }

function imagesEnLigneOf(parsed) {
  const sorties = []
  let cumul = 0
  for (const partie of parsed?.attachments || []) {
    if (sorties.length >= IMAGES_EN_LIGNE_NOMBRE_MAX) break
    // Sans identifiant de contenu, la partie n'est référençable par aucun
    // cid: — c'est une pièce jointe ordinaire, elle ne nous regarde pas.
    const cid = String(partie?.cid || '').replace(/^<+|>+$/g, '').trim()
    if (!cid) continue
    const type = String(partie.contentType || '').toLowerCase().split(';')[0].trim()
    if (!TYPES_IMAGE_EN_LIGNE.has(type)) continue
    const octets = partie.content
    if (!Buffer.isBuffer(octets) || octets.length === 0) continue
    if (octets.length > IMAGE_EN_LIGNE_MAX) continue
    if (cumul + octets.length > IMAGES_EN_LIGNE_CUMUL_MAX) break
    cumul += octets.length
    sorties.push({ cid, contentType: type, content: octets.toString('base64') })
  }
  return sorties
}

export async function getImapMessageBody(db, userId, { folder = 'inbox', uid } = {}) {
  const wanted = folder === 'sent' ? 'sent' : 'inbox'
  const wantedUid = String(uid || '').trim()
  if (!/^\d+$/.test(wantedUid)) throw mailError('Identifiant de message invalide', 'not_found')
  return withImapClient(db, userId, async (client) => {
    const path = await resolveFolderPath(client, wanted)
    const lock = await client.getMailboxLock(path)
    try {
      const msg = await client.fetchOne(wantedUid, { source: true }, { uid: true })
      if (!msg || !msg.source) throw mailError('Message introuvable dans ce dossier', 'not_found')
      const parsed = await simpleParser(msg.source, OPTIONS_PARSEUR)
      return {
        id: wantedUid,
        folder: wanted,
        from: parsed.from?.text || '',
        to: parsed.to?.text || '',
        subject: parsed.subject || '',
        date: parsed.date ? parsed.date.toISOString() : null,
        text: bodyTextOf(parsed),
        html: bodyHtmlOf(parsed),
        attachments: (parsed.attachments || []).map(a => ({
          filename: a.filename || '',
          size: a.size || 0
        })),
        inlineImages: imagesEnLigneOf(parsed)
      }
    } finally {
      lock.release()
    }
  })
}

// Pose \Seen sur un message du dossier. ImapFlow ne lit qu'en BODY.PEEK[] :
// afficher un corps ne marque jamais rien côté serveur, le drapeau doit être
// posé explicitement. Aucun scope, aucun consentement en jeu — la connexion
// IMAP qui lit peut écrire ce drapeau.
export async function markImapMessageSeen(db, userId, { folder = 'inbox', uid } = {}) {
  const wanted = folder === 'sent' ? 'sent' : 'inbox'
  const wantedUid = String(uid || '').trim()
  if (!/^\d+$/.test(wantedUid)) throw mailError('Identifiant de message invalide', 'not_found')
  return withImapClient(db, userId, async (client) => {
    const path = await resolveFolderPath(client, wanted)
    const lock = await client.getMailboxLock(path)
    try {
      const pose = await client.messageFlagsAdd(wantedUid, ['\\Seen'], { uid: true })
      if (!pose) throw mailError('Message introuvable dans ce dossier', 'not_found')
      return { id: wantedUid, folder: wanted, unread: false }
    } finally {
      lock.release()
    }
  })
}

// Le format 'metadata' de la liste interdit le corps : la récupération
// complète n'a lieu qu'ici, au clic sur un message.
export async function getGoogleMessageBody(db, ownerId, email, messageId) {
  const cred = await loadMailboxCredential(db, ownerId, email)
  if (!cred || cred.provider !== 'google') throw mailError('Compte Google introuvable pour cet utilisateur', 'no_account')
  const auth = await ensureFreshGoogleClient(db, cred)
  const gmail = google.gmail({ version: 'v1', auth })
  let detail
  try {
    // 'raw' et non 'full' : 'full' ne rend PAS les octets des parties en ligne
    // — pour elles il ne donne qu'un attachmentId, qu'il faudrait aller
    // chercher par une requête de plus, et une par image. Le message brut
    // arrive entier en une seule fois, et simpleParser en tire les mêmes
    // parties que la voie IMAP : une seule mécanique pour les deux voies.
    detail = await gmail.users.messages.get({ userId: 'me', id: String(messageId), format: 'raw' })
  } catch (err) {
    if (err?.code === 404 || err?.response?.status === 404) throw mailError('Message introuvable', 'not_found')
    throw err
  }
  const data = detail.data || {}
  const parsed = await simpleParser(Buffer.from(String(data.raw || ''), 'base64url'), OPTIONS_PARSEUR)
  return {
    id: data.id,
    folder: (data.labelIds || []).includes('SENT') ? 'sent' : 'inbox',
    from: parsed.from?.text || '',
    to: parsed.to?.text || '',
    subject: parsed.subject || '',
    date: parsed.date ? parsed.date.toISOString() : null,
    text: bodyTextOf(parsed),
    html: bodyHtmlOf(parsed),
    attachments: [],
    inlineImages: imagesEnLigneOf(parsed)
  }
}

// ── Marquer comme lu chez le fournisseur ──

// Gmail n'a pas de scope qui n'accorderait que l'étiquette : modifier UNREAD
// demande gmail.modify. Le consentement est enregistré tel que Google l'a rendu
// au callback (champ scope de mailbox_credentials) : on le LIT plutôt que de
// tenter l'appel pour voir. mail.google.com, plus large, ferait aussi l'affaire
// si un abonné l'avait accordé.
const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify'
const GMAIL_FULL_SCOPE = 'https://mail.google.com/'

function credentialCanModify(cred) {
  const accordes = String(cred?.scope || '').split(/\s+/).filter(Boolean)
  return accordes.includes(GMAIL_MODIFY_SCOPE) || accordes.includes(GMAIL_FULL_SCOPE)
}

// Retire l'étiquette UNREAD. Une étiquette, rien d'autre : ni corbeille, ni
// archivage, ni aucune autre modification. Tant que le consentement enregistré
// ne porte que la lecture, rien n'est tenté : le refus est immédiat et explicite
// (code 'scope_insuffisant'), la pastille reste allumée et elle dit vrai.
export async function markGoogleMessageRead(db, ownerId, email, messageId) {
  const cred = await loadMailboxCredential(db, ownerId, email)
  if (!cred || cred.provider !== 'google') throw mailError('Compte Google introuvable pour cet utilisateur', 'no_account')
  if (!credentialCanModify(cred)) {
    throw mailError('Le consentement enregistré pour cette boîte Gmail ne couvre que la lecture', 'scope_insuffisant')
  }
  const auth = await ensureFreshGoogleClient(db, cred)
  const gmail = google.gmail({ version: 'v1', auth })
  try {
    await gmail.users.messages.modify({
      userId: 'me',
      id: String(messageId),
      requestBody: { removeLabelIds: ['UNREAD'] }
    })
  } catch (err) {
    if (err?.code === 404 || err?.response?.status === 404) throw mailError('Message introuvable', 'not_found')
    throw err
  }
  return { id: String(messageId), folder: 'inbox', unread: false }
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
