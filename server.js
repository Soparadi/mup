if(process.env.NODE_ENV !== 'production'){
  await import('dotenv/config')
}
import express from 'express'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'
import nodemailer from 'nodemailer'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { getDb } from './lib/surreal.js'
import { encrypt, decrypt, isCryptoReady } from './lib/crypto.js'
import { getUserId } from './lib/auth.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json({ limit: '10mb' }))

const DEFAULT_USER_ID = process.env.MUP_DEFAULT_USER_ID || 'default'

// Derive IMAP host/port from SMTP config when IMAP fields are absent (V1 onboarding).
function deriveImapFromSmtp(host) {
  if (!host || typeof host !== 'string') return null
  return host.replace(/^smtp\./i, 'imap.')
}

// Strip secrets from a record before returning to client.
function stripSettingsSecrets(rec) {
  if (!rec) return rec
  const { smtp_pass_encrypted, imap_pass_encrypted, ...safe } = rec
  return {
    ...safe,
    configured: Boolean(smtp_pass_encrypted),
    has_imap: Boolean(imap_pass_encrypted)
  }
}

function requireCrypto(res) {
  if (!isCryptoReady()) {
    res.status(503).json({ error: 'Mail non configuré sur le serveur — SECRET_KEY absente' })
    return false
  }
  return true
}

function hashMessageId(messageId) {
  return createHash('sha256').update(String(messageId)).digest('hex').slice(0, 24)
}

// Idempotent upsert: CREATE if absent, UPDATE if AlreadyExists.
// Caller passes a hardcoded table name (never user input) and a clean id.
async function upsertRecord(db, table, cleanId, body) {
  const cleanBody = { ...body }
  delete cleanBody.id
  const createSql = `CREATE type::record("${table}", $id) CONTENT $body`
  const updateSql = `UPDATE type::record("${table}", $id) CONTENT $body`
  try {
    const result = await db.query(createSql, { id: cleanId, body: cleanBody })
    return { record: result[0]?.[0] || result[0] || null, status: 201, action: 'created' }
  } catch (e) {
    const isAlreadyExists =
      e?.name === 'AlreadyExistsError' ||
      e?.kind === 'AlreadyExists' ||
      String(e?.message || '').includes('already exists')
    if (!isAlreadyExists) throw e
    const result = await db.query(updateSql, { id: cleanId, body: cleanBody })
    return { record: result[0]?.[0] || result[0] || null, status: 200, action: 'updated' }
  }
}

app.get('/api/health', async (req, res) => {
  const status = {
    server: 'ok',
    timestamp: new Date().toISOString(),
    surreal: 'unknown'
  }
  try {
    const db = await getDb()
    await db.query('INFO FOR DB;')
    status.surreal = 'ok'
    status.surreal_namespace = process.env.SURREAL_NAMESPACE
    status.surreal_database = process.env.SURREAL_DATABASE
  } catch(err){
    status.surreal = 'error'
    status.surreal_error = err.message
    return res.status(503).json(status)
  }
  res.json(status)
})

app.use(express.static(join(__dirname, 'public')))

app.get('/api/pipeline', async (req, res) => {
  try {
    const db = await getDb()
    const result = await db.query('SELECT * FROM pipeline')
    res.json(result[0] || [])
  } catch (err) {
    console.error('[pipeline]', err)
    res.status(500).json({ error: 'Impossible de lire les cartes pipeline' })
  }
})

app.post('/api/pipeline', async (req, res) => {
  try {
    const body = req.body
    const db = await getDb()
    let cleanId = null
    if (body?.id && typeof body.id === 'string') {
      cleanId = body.id.replace(/^pipeline:/, '').replace(/^⟨+/, '').replace(/\\?⟩+$/, '').replace(/\\/g, '')
      if (/^\d/.test(cleanId)) cleanId = 'c' + cleanId
    }
    if (cleanId) {
      const { record, status, action } = await upsertRecord(db, 'pipeline', cleanId, body)
      if (action === 'updated') console.log(`[pipeline] upsert pipeline:${cleanId}`)
      return res.status(status).json(record)
    }
    const result = await db.query('CREATE pipeline CONTENT $body', { body })
    res.status(201).json(result[0]?.[0] || result[0] || null)
  } catch (err) {
    console.error('[pipeline]', err)
    res.status(500).json({ error: 'Impossible de créer la carte pipeline' })
  }
})

app.put('/api/pipeline/:id', async (req, res) => {
  try {
    const { id } = req.params
    const body = req.body
    const db = await getDb()
    
    // 1. Vérifier l'existence
    const existing = await db.query('SELECT * FROM type::record("pipeline", $id)', { id })
    if (!existing[0] || existing[0].length === 0) {
      return res.status(404).json({ error: 'Carte introuvable' })
    }
    
    // 2. UPDATE — strip body.id to avoid conflict with type::record target
    const cleanBody = { ...body }
    delete cleanBody.id
    const result = await db.query('UPDATE type::record("pipeline", $id) CONTENT $body', { id, body: cleanBody })
    res.json(result[0]?.[0] || result[0] || {})
  } catch (err) {
    console.error('[pipeline]', err)
    res.status(500).json({ error: 'Impossible de mettre à jour la carte pipeline' })
  }
})

app.delete('/api/pipeline/:id', async (req, res) => {
  try {
    const db = await getDb()
    await db.query('DELETE type::record("pipeline", $id)', { id: req.params.id })
    res.json({ ok: true })
  } catch (err) {
    console.error('[pipeline]', err)
    res.status(500).json({ error: 'Impossible de supprimer la carte pipeline' })
  }
})

app.get('/api/contacts', async (req, res) => {
  try {
    const db = await getDb()
    const result = await db.query('SELECT * FROM contacts')
    res.json(result[0] || [])
  } catch (err) {
    console.error('[contacts]', err)
    res.status(500).json({ error: 'Impossible de lire les contacts' })
  }
})

app.post('/api/contacts', async (req, res) => {
  try {
    const body = req.body
    const db = await getDb()
    let cleanId = null
    if (body?.id && typeof body.id === 'string') {
      cleanId = body.id.replace(/^contacts:/, '').replace(/^⟨+/, '').replace(/\\?⟩+$/, '').replace(/\\/g, '')
      if (/^\d/.test(cleanId)) cleanId = 'c' + cleanId
    }
    if (cleanId) {
      const { record, status, action } = await upsertRecord(db, 'contacts', cleanId, body)
      if (action === 'updated') console.log(`[contacts] upsert contacts:${cleanId}`)
      return res.status(status).json(record)
    }
    const result = await db.query('CREATE contacts CONTENT $body', { body })
    res.status(201).json(result[0]?.[0] || result[0] || null)
  } catch (err) {
    console.error('[contacts]', err)
    res.status(500).json({ error: 'Impossible de créer le contact' })
  }
})

app.put('/api/contacts/:id', async (req, res) => {
  try {
    const { id } = req.params
    const body = req.body
    const db = await getDb()
    
    // 1. Vérifier l'existence
    const existing = await db.query('SELECT * FROM type::record("contacts", $id)', { id })
    if (!existing[0] || existing[0].length === 0) {
      return res.status(404).json({ error: 'Contact introuvable' })
    }
    
    // 2. UPDATE — strip body.id to avoid conflict with type::record target
    const cleanBody = { ...body }
    delete cleanBody.id
    const result = await db.query('UPDATE type::record("contacts", $id) CONTENT $body', { id, body: cleanBody })
    res.json(result[0]?.[0] || result[0] || {})
  } catch (err) {
    console.error('[contacts]', err)
    res.status(500).json({ error: 'Impossible de mettre à jour le contact' })
  }
})

app.delete('/api/contacts/:id', async (req, res) => {
  try {
    const db = await getDb()
    await db.query('DELETE type::record("contacts", $id)', { id: req.params.id })
    res.json({ ok: true })
  } catch (err) {
    console.error('[contacts]', err)
    res.status(500).json({ error: 'Impossible de supprimer le contact' })
  }
})

app.get('/api/agenda', async (req, res) => {
  try {
    const db = await getDb()
    const result = await db.query('SELECT * FROM agenda')
    res.json(result[0] || [])
  } catch (err) {
    console.error('[agenda]', err)
    res.status(500).json({ error: 'Impossible de lire les évènements agenda' })
  }
})
app.post('/api/agenda', async (req, res) => {
  try {
    const body = req.body
    const db = await getDb()
    let cleanId = null
    if (body?.id && typeof body.id === 'string') {
      cleanId = body.id.replace(/^agenda:/, '').replace(/^⟨+/, '').replace(/\\?⟩+$/, '').replace(/\\/g, '')
      if (/^\d/.test(cleanId)) cleanId = 'c' + cleanId
    }
    if (cleanId) {
      const { record, status, action } = await upsertRecord(db, 'agenda', cleanId, body)
      if (action === 'updated') console.log(`[agenda] upsert agenda:${cleanId}`)
      return res.status(status).json(record)
    }
    const result = await db.query('CREATE agenda CONTENT $body', { body })
    res.status(201).json(result[0]?.[0] || result[0] || null)
  } catch (err) {
    console.error('[agenda]', err)
    res.status(500).json({ error: 'Impossible de créer l\'évènement agenda' })
  }
})
app.put('/api/agenda/:id', async (req, res) => {
  try {
    const { id } = req.params
    const body = req.body
    const db = await getDb()
    const existing = await db.query('SELECT * FROM type::record("agenda", $id)', { id })
    if (!existing[0] || existing[0].length === 0) {
      return res.status(404).json({ error: 'Évènement introuvable' })
    }
    const cleanBody = { ...body }
    delete cleanBody.id
    const result = await db.query('UPDATE type::record("agenda", $id) CONTENT $body', { id, body: cleanBody })
    res.json(result[0]?.[0] || result[0] || {})
  } catch (err) {
    console.error('[agenda]', err)
    res.status(500).json({ error: 'Impossible de mettre à jour l\'évènement agenda' })
  }
})
app.delete('/api/agenda/:id', async (req, res) => {
  try {
    const db = await getDb()
    await db.query('DELETE type::record("agenda", $id)', { id: req.params.id })
    res.json({ ok: true })
  } catch (err) {
    console.error('[agenda]', err)
    res.status(500).json({ error: 'Impossible de supprimer l\'évènement agenda' })
  }
})

// ── INSEE OAuth2 token cache ──
let inseeToken = null
let inseeTokenExpires = 0

async function getInseeToken() {
  if(inseeToken && Date.now() < inseeTokenExpires) return inseeToken
  const id = process.env.INSEE_CLIENT_ID
  const secret = process.env.INSEE_CLIENT_SECRET
  console.log('[INSEE] ID present:', !!id, 'Secret present:', !!secret, 'ID:', id ? id.substring(0,8)+'...' : 'MISSING')
  if(!id || !secret) { console.error('[INSEE] Missing credentials'); return null }
  try {
    const creds = Buffer.from(id + ':' + secret).toString('base64')
    const r = await fetch('https://auth.insee.net/auth/realms/apim-gravitee/protocol/openid-connect/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + creds },
      body: 'grant_type=client_credentials'
    })
    if(!r.ok) { const body = await r.text(); console.error('[INSEE] Token error:', r.status, body.substring(0,200)); return null }
    const data = await r.json()
    inseeToken = data.access_token
    inseeTokenExpires = Date.now() + (data.expires_in - 60) * 1000
    console.log('[INSEE] Token obtained, expires in', data.expires_in, 's')
    return inseeToken
  } catch(e) { console.error('[INSEE] Token fetch failed:', e.message); return null }
}

// ── API proxies ──
app.get('/api/search', async (req, res) => {
  const params = new URLSearchParams()
  if(req.query.q) params.set('q', req.query.q)
  if(req.query.region) params.set('region', req.query.region)
  if(req.query.code_naf) params.set('activite_principale', req.query.code_naf)
  if(req.query.activite_principale) params.set('activite_principale', req.query.activite_principale)
  if(req.query.per_page) params.set('per_page', Math.min(parseInt(req.query.per_page)||10, 25))
  if(req.query.page) params.set('page', req.query.page)
  try {
    const r = await fetch('https://recherche-entreprises.api.gouv.fr/search?' + params.toString())
    const data = await r.json()
    res.json(data)
  } catch(e) {
    res.status(502).json({ error: 'Service temporairement indisponible' })
  }
})

// ── INSEE SIRENE search (must be before :siret route) ──
app.get('/api/sirene/search', async (req, res) => {
  const token = await getInseeToken()
  console.log('[INSEE] token:', token ? 'OK ('+token.substring(0,20)+'...)' : 'NULL')
  if(!token) {
    console.error('[INSEE] No token — CLIENT_ID:', process.env.INSEE_CLIENT_ID ? 'present' : 'MISSING', 'SECRET:', process.env.INSEE_CLIENT_SECRET ? 'present' : 'MISSING')
    return res.status(503).json({ error: 'INSEE auth indisponible' })
  }
  let q = req.query.q || ''
  // Convert NAF codes without dots: 8230Z → 82.30Z in the query
  q = q.replace(/activitePrincipaleEtablissement:(\d{2})(\d{2}[A-Z])/g, 'activitePrincipaleEtablissement:$1.$2')
  const nombre = Math.min(parseInt(req.query.nombre) || 20, 100)
  const debut = parseInt(req.query.debut) || 0
  const inseeUrl = 'https://api.insee.fr/api-sirene/3.11/siret?q=' + encodeURIComponent(q) + '&nombre=' + nombre + '&debut=' + debut
  try {
    console.log('[INSEE] Calling:', inseeUrl.substring(0, 200))
    const hdrs = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }
    if(process.env.INSEE_API_KEY) hdrs['X-Gravitee-Api-Key'] = process.env.INSEE_API_KEY
    const r = await fetch(inseeUrl, { headers: hdrs })
    console.log('[INSEE] Response:', r.status, r.headers.get('content-type'))
    if(!r.ok) { const body = await r.text(); console.error('[INSEE] Search error:', r.status, body.substring(0,300)); return res.status(r.status).json({ error: 'Recherche INSEE échouée' }) }
    const data = await r.json()
    console.log('[INSEE] Success: total=', data.header?.total, 'etablissements=', data.etablissements?.length)
    res.json(data)
  } catch(e) {
    console.error('[INSEE] Fetch crash:', e.message)
    res.status(502).json({ error: 'INSEE indisponible' })
  }
})

// ── INSEE SIRENE enrichment by SIRET ──
app.get('/api/sirene/:siret', async (req, res) => {
  const token = await getInseeToken()
  if(!token) return res.status(503).json({ error: 'INSEE auth indisponible' })
  try {
    const hdrs2 = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }
    if(process.env.INSEE_API_KEY) hdrs2['X-Gravitee-Api-Key'] = process.env.INSEE_API_KEY
    const r = await fetch('https://api.insee.fr/api-sirene/3.11/siret/' + encodeURIComponent(req.params.siret), { headers: hdrs2 })
    if(!r.ok) return res.status(r.status).json({ error: 'SIRET non trouvé' })
    const data = await r.json()
    res.json(data)
  } catch(e) {
    res.status(502).json({ error: 'INSEE indisponible' })
  }
})

app.get('/api/geocode', async (req, res) => {
  const q = req.query.q || ''
  const type = req.query.type || ''
  try {
    // Try with type filter first (municipality for cities)
    let url = 'https://api-adresse.data.gouv.fr/search/?q=' + encodeURIComponent(q) + '&limit=1'
    if(type) url += '&type=' + type
    let r = await fetch(url)
    let data = await r.json()
    // If no result with type filter, retry without
    if(type && (!data.features || !data.features.length)) {
      r = await fetch('https://api-adresse.data.gouv.fr/search/?q=' + encodeURIComponent(q) + '&limit=1')
      data = await r.json()
    }
    res.json(data)
  } catch(e) {
    res.status(502).json({ error: 'Géocodage indisponible' })
  }
})

// ── MAIL ──────────────────────────────────────────────────────────────
// V1: mono-utilisateur via MUP_DEFAULT_USER_ID. Multi-tenant à brancher
// quand l'auth arrive. Aucun quota MUP — limite déléguée au SMTP utilisateur.

app.get('/api/mail/settings/:userId', async (req, res) => {
  if (!requireCrypto(res)) return
  try {
    const db = await getDb()
    const userId = String(req.params.userId || DEFAULT_USER_ID)
    const result = await db.query('SELECT * FROM type::record("mail_settings", $id)', { id: userId })
    const rec = result[0]?.[0]
    if (!rec) return res.status(404).json({ error: 'Configuration mail introuvable' })
    res.json(stripSettingsSecrets(rec))
  } catch (err) {
    console.error('[mail/settings:get]', err.message)
    res.status(500).json({ error: 'Lecture configuration mail impossible' })
  }
})

app.post('/api/mail/settings', async (req, res) => {
  if (!requireCrypto(res)) return
  try {
    const body = req.body || {}
    const userId = String(body.userId || DEFAULT_USER_ID)
    const db = await getDb()
    const payload = {
      userId,
      smtp_host: body.smtp_host || '',
      smtp_port: Number(body.smtp_port) || 587,
      smtp_secure: body.smtp_secure ?? (Number(body.smtp_port) === 465),
      smtp_user: body.smtp_user || body.from_email || '',
      imap_host: body.imap_host || deriveImapFromSmtp(body.smtp_host) || '',
      imap_port: Number(body.imap_port) || 993,
      imap_secure: body.imap_secure ?? true,
      imap_user: body.imap_user || body.smtp_user || body.from_email || '',
      from_name: body.from_name || '',
      from_email: body.from_email || '',
      signature_html: body.signature_html || '',
      signature_text: body.signature_text || '',
      onboarded_at: new Date().toISOString()
    }
    if (body.smtp_pass) payload.smtp_pass_encrypted = encrypt(String(body.smtp_pass))
    if (body.imap_pass) {
      payload.imap_pass_encrypted = encrypt(String(body.imap_pass))
    } else if (body.smtp_pass) {
      payload.imap_pass_encrypted = encrypt(String(body.smtp_pass))
    }
    const { record, status } = await upsertRecord(db, 'mail_settings', userId, payload)
    res.status(status).json(stripSettingsSecrets(record))
  } catch (err) {
    console.error('[mail/settings:post]', err.message)
    res.status(500).json({ error: 'Enregistrement configuration mail impossible' })
  }
})

app.delete('/api/mail/settings/:userId', async (req, res) => {
  if (!requireCrypto(res)) return
  try {
    const db = await getDb()
    const userId = String(req.params.userId || DEFAULT_USER_ID)
    await db.query('DELETE type::record("mail_settings", $id)', { id: userId })
    res.json({ ok: true })
  } catch (err) {
    console.error('[mail/settings:delete]', err.message)
    res.status(500).json({ error: 'Suppression configuration mail impossible' })
  }
})

app.post('/api/mail/test-smtp', async (req, res) => {
  if (!requireCrypto(res)) return
  const body = req.body || {}
  if (!body.smtp_host || !body.smtp_user || !body.smtp_pass) {
    return res.status(400).json({ error: 'Paramètres SMTP incomplets' })
  }
  try {
    const transporter = nodemailer.createTransport({
      host: body.smtp_host,
      port: Number(body.smtp_port) || 587,
      secure: body.smtp_secure ?? (Number(body.smtp_port) === 465),
      auth: { user: body.smtp_user, pass: body.smtp_pass }
    })
    await transporter.verify()
    res.json({ ok: true })
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message })
  }
})

app.post('/api/mail/test-imap', async (req, res) => {
  if (!requireCrypto(res)) return
  const body = req.body || {}
  const host = body.imap_host || deriveImapFromSmtp(body.smtp_host)
  const user = body.imap_user || body.smtp_user
  const pass = body.imap_pass || body.smtp_pass
  if (!host || !user || !pass) {
    return res.status(400).json({ error: 'Paramètres IMAP incomplets' })
  }
  const client = new ImapFlow({
    host,
    port: Number(body.imap_port) || 993,
    secure: body.imap_secure ?? true,
    auth: { user, pass },
    logger: false
  })
  try {
    await client.connect()
    await client.logout()
    res.json({ ok: true })
  } catch (err) {
    try { await client.logout() } catch (e) {}
    res.status(502).json({ ok: false, error: err.message })
  }
})

app.get('/api/mail', async (req, res) => {
  try {
    const db = await getDb()
    const userId = String(req.query.userId || DEFAULT_USER_ID)
    const prospectId = req.query.prospectId ? String(req.query.prospectId) : null
    let result
    if (prospectId) {
      result = await db.query(
        'SELECT * FROM mail WHERE userId = $userId AND prospectId = $prospectId ORDER BY date DESC',
        { userId, prospectId }
      )
    } else {
      result = await db.query('SELECT * FROM mail WHERE userId = $userId ORDER BY date DESC', { userId })
    }
    res.json(result[0] || [])
  } catch (err) {
    console.error('[mail:list]', err.message)
    res.status(500).json({ error: 'Lecture mails impossible' })
  }
})

app.get('/api/mail/:id', async (req, res) => {
  try {
    const db = await getDb()
    const result = await db.query('SELECT * FROM type::record("mail", $id)', { id: req.params.id })
    const rec = result[0]?.[0]
    if (!rec) return res.status(404).json({ error: 'Mail introuvable' })
    res.json(rec)
  } catch (err) {
    console.error('[mail:get]', err.message)
    res.status(500).json({ error: 'Lecture mail impossible' })
  }
})

app.delete('/api/mail/:id', async (req, res) => {
  try {
    const db = await getDb()
    await db.query('DELETE type::record("mail", $id)', { id: req.params.id })
    res.json({ ok: true })
  } catch (err) {
    console.error('[mail:delete]', err.message)
    res.status(500).json({ error: 'Suppression mail impossible' })
  }
})

app.post('/api/mail/send', async (req, res) => {
  if (!requireCrypto(res)) return
  try {
    const body = req.body || {}
    const userId = String(body.userId || DEFAULT_USER_ID)
    if (!body.to || !body.subject) {
      return res.status(400).json({ error: 'Destinataire et objet requis' })
    }
    const db = await getDb()
    const settingsResult = await db.query('SELECT * FROM type::record("mail_settings", $id)', { id: userId })
    const settings = settingsResult[0]?.[0]
    if (!settings || !settings.smtp_pass_encrypted) {
      return res.status(503).json({ error: 'Configuration SMTP absente — terminez l\'onboarding' })
    }

    const smtpPass = decrypt(settings.smtp_pass_encrypted)
    const transporter = nodemailer.createTransport({
      host: settings.smtp_host,
      port: settings.smtp_port,
      secure: settings.smtp_secure,
      auth: { user: settings.smtp_user, pass: smtpPass }
    })

    const bodyHtml = body.body_html || (body.body_text || '').replace(/\n/g, '<br>')
    const finalHtml = settings.signature_html
      ? `${bodyHtml}<br><br>${settings.signature_html}`
      : bodyHtml
    const finalText = settings.signature_text
      ? `${body.body_text || ''}\n\n${settings.signature_text}`
      : (body.body_text || '')

    const mailOptions = {
      from: settings.from_name ? `"${settings.from_name}" <${settings.from_email}>` : settings.from_email,
      to: body.to,
      cc: body.cc || undefined,
      subject: body.subject,
      text: finalText,
      html: finalHtml
    }

    let sendInfo
    try {
      sendInfo = await transporter.sendMail(mailOptions)
    } catch (smtpErr) {
      const failedRecord = {
        userId,
        direction: 'sent',
        prospectId: body.prospectId || null,
        from: settings.from_email,
        to: body.to,
        cc: body.cc || '',
        subject: body.subject,
        body_html: finalHtml,
        body_text: finalText,
        date: new Date().toISOString(),
        messageId: '',
        status: 'failed',
        error: smtpErr.message,
        attachments: []
      }
      const rid = `failed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      await upsertRecord(db, 'mail', rid, failedRecord)
      return res.status(502).json({ error: smtpErr.message })
    }

    const messageId = sendInfo.messageId || `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const recordId = hashMessageId(messageId)
    const sentRecord = {
      userId,
      direction: 'sent',
      prospectId: body.prospectId || null,
      from: settings.from_email,
      to: body.to,
      cc: body.cc || '',
      subject: body.subject,
      body_html: finalHtml,
      body_text: finalText,
      date: new Date().toISOString(),
      messageId,
      status: 'sent',
      attachments: []
    }
    const { record, status } = await upsertRecord(db, 'mail', recordId, sentRecord)
    res.status(status).json(record)
  } catch (err) {
    console.error('[mail/send]', err.message)
    res.status(500).json({ error: 'Envoi mail impossible' })
  }
})

app.post('/api/mail/sync', async (req, res) => {
  if (!requireCrypto(res)) return
  const body = req.body || {}
  const userId = String(body.userId || DEFAULT_USER_ID)
  const onlyProspectId = body.prospectId ? String(body.prospectId) : null
  try {
    const db = await getDb()
    const settingsResult = await db.query('SELECT * FROM type::record("mail_settings", $id)', { id: userId })
    const settings = settingsResult[0]?.[0]
    if (!settings || !settings.imap_pass_encrypted) {
      return res.status(503).json({ error: 'Configuration IMAP absente' })
    }

    const pipelineResult = await db.query('SELECT id, email, co, name FROM pipeline')
    let cards = pipelineResult[0] || []
    if (onlyProspectId) cards = cards.filter(c => String(c.id) === onlyProspectId)
    const targets = cards.filter(c => c.email && /@/.test(c.email))
    if (!targets.length) return res.json({ synced: 0, errors: [] })

    const imapPass = decrypt(settings.imap_pass_encrypted)
    const client = new ImapFlow({
      host: settings.imap_host,
      port: settings.imap_port,
      secure: settings.imap_secure,
      auth: { user: settings.imap_user, pass: imapPass },
      logger: false
    })

    let synced = 0
    const errors = []
    try {
      await client.connect()
      const lock = await client.getMailboxLock('INBOX')
      try {
        for (const card of targets) {
          try {
            const uids = await client.search({ from: card.email })
            if (!uids || !uids.length) continue
            for await (const msg of client.fetch(uids, { source: true })) {
              const parsed = await simpleParser(msg.source)
              const messageId = parsed.messageId || `${card.email}_${parsed.date?.toISOString() || Date.now()}`
              const recordId = hashMessageId(messageId)
              const existing = await db.query('SELECT id FROM type::record("mail", $id)', { id: recordId })
              if (existing[0]?.[0]) continue
              await upsertRecord(db, 'mail', recordId, {
                userId,
                direction: 'received',
                prospectId: String(card.id),
                from: parsed.from?.text || card.email,
                to: parsed.to?.text || settings.from_email,
                cc: parsed.cc?.text || '',
                subject: parsed.subject || '',
                body_html: parsed.html || '',
                body_text: parsed.text || '',
                date: parsed.date ? parsed.date.toISOString() : new Date().toISOString(),
                messageId,
                status: 'received',
                attachments: (parsed.attachments || []).map(a => ({
                  filename: a.filename,
                  contentType: a.contentType,
                  size: a.size
                }))
              })
              synced++
            }
          } catch (cardErr) {
            errors.push({ prospectId: String(card.id), error: cardErr.message })
          }
        }
      } finally {
        lock.release()
      }
      await client.logout()
    } catch (imapErr) {
      try { await client.logout() } catch (e) {}
      return res.status(502).json({ error: imapErr.message })
    }
    res.json({ synced, errors })
  } catch (err) {
    console.error('[mail/sync]', err.message)
    res.status(500).json({ error: 'Synchronisation IMAP impossible' })
  }
})

// ── VISIO ─────────────────────────────────────────────────────────────
// V1: scoping par userId via getUserId() (env MUP_DEFAULT_USER_ID en mono-user).
// IndexedDB des blobs documents reste local (V2 = stockage cloud).

const visioBgJson = express.json({ limit: '20mb' })

app.get('/api/visio/settings', async (req, res) => {
  try {
    const db = await getDb()
    const userId = String(getUserId(req))
    const result = await db.query('SELECT * FROM type::record("visio_settings", $id)', { id: userId })
    res.json(result[0]?.[0] || { userId })
  } catch (err) {
    console.error('[visio/settings:get]', err.message)
    res.status(500).json({ error: 'Lecture configuration visio impossible' })
  }
})

async function visioSettingsUpsertHandler(req, res) {
  try {
    const db = await getDb()
    const userId = String(getUserId(req))
    const body = req.body || {}
    const payload = { ...body, userId, updated_at: new Date().toISOString() }
    const { record, status } = await upsertRecord(db, 'visio_settings', userId, payload)
    res.status(status).json(record)
  } catch (err) {
    console.error('[visio/settings:upsert]', err.message)
    res.status(500).json({ error: 'Enregistrement configuration visio impossible' })
  }
}
app.put('/api/visio/settings', visioSettingsUpsertHandler)
// POST alias pour sendBeacon (beforeunload flush) — sendBeacon ne supporte que POST
app.post('/api/visio/settings', visioSettingsUpsertHandler)

app.get('/api/visio/logs', async (req, res) => {
  try {
    const db = await getDb()
    const userId = String(getUserId(req))
    const prospectId = req.query.prospectId ? String(req.query.prospectId) : null
    let result
    if (prospectId) {
      result = await db.query(
        'SELECT * FROM visio_log WHERE userId = $userId AND prospectId = $prospectId ORDER BY started_at DESC',
        { userId, prospectId }
      )
    } else {
      result = await db.query('SELECT * FROM visio_log WHERE userId = $userId ORDER BY started_at DESC', { userId })
    }
    res.json(result[0] || [])
  } catch (err) {
    console.error('[visio/logs:list]', err.message)
    res.status(500).json({ error: 'Lecture logs visio impossible' })
  }
})

app.post('/api/visio/logs', async (req, res) => {
  try {
    const db = await getDb()
    const userId = String(getUserId(req))
    const body = req.body || {}
    const payload = {
      userId,
      prospectId: body.prospectId || null,
      rdvId: body.rdvId || null,
      provider: body.provider || 'custom',
      link: body.link || '',
      started_at: body.started_at || new Date().toISOString(),
      ended_at: body.ended_at || null,
      duration_seconds: body.duration_seconds || 0,
      notes: body.notes || ''
    }
    const recordId = body.id ? String(body.id).replace(/^visio_log:/, '') : `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const cleanId = /^\d/.test(recordId) ? 'c' + recordId : recordId
    const { record, status } = await upsertRecord(db, 'visio_log', cleanId, payload)
    res.status(status).json(record)
  } catch (err) {
    console.error('[visio/logs:post]', err.message)
    res.status(500).json({ error: 'Enregistrement log visio impossible' })
  }
})

app.delete('/api/visio/logs/:id', async (req, res) => {
  try {
    const db = await getDb()
    await db.query('DELETE type::record("visio_log", $id)', { id: req.params.id })
    res.json({ ok: true })
  } catch (err) {
    console.error('[visio/logs:delete]', err.message)
    res.status(500).json({ error: 'Suppression log visio impossible' })
  }
})

function draftId(userId, prospectId) {
  return `${String(userId).replace(/[^a-zA-Z0-9_]/g, '_')}_${String(prospectId).replace(/[^a-zA-Z0-9_]/g, '_')}`
}

app.get('/api/visio/drafts/:prospectId', async (req, res) => {
  try {
    const db = await getDb()
    const userId = String(getUserId(req))
    const id = draftId(userId, req.params.prospectId)
    const result = await db.query('SELECT * FROM type::record("visio_draft", $id)', { id })
    const rec = result[0]?.[0]
    if (!rec) return res.status(404).json({ error: 'Draft introuvable' })
    res.json(rec)
  } catch (err) {
    console.error('[visio/drafts:get]', err.message)
    res.status(500).json({ error: 'Lecture draft impossible' })
  }
})

app.put('/api/visio/drafts/:prospectId', async (req, res) => {
  try {
    const db = await getDb()
    const userId = String(getUserId(req))
    const prospectId = String(req.params.prospectId)
    const id = draftId(userId, prospectId)
    const payload = {
      userId,
      prospectId,
      content: (req.body && req.body.content) || '',
      updated_at: new Date().toISOString()
    }
    const { record, status } = await upsertRecord(db, 'visio_draft', id, payload)
    res.status(status).json(record)
  } catch (err) {
    console.error('[visio/drafts:put]', err.message)
    res.status(500).json({ error: 'Enregistrement draft impossible' })
  }
})

app.delete('/api/visio/drafts/:prospectId', async (req, res) => {
  try {
    const db = await getDb()
    const userId = String(getUserId(req))
    const id = draftId(userId, req.params.prospectId)
    await db.query('DELETE type::record("visio_draft", $id)', { id })
    res.json({ ok: true })
  } catch (err) {
    console.error('[visio/drafts:delete]', err.message)
    res.status(500).json({ error: 'Suppression draft impossible' })
  }
})

app.get('/api/visio/bg-custom', async (req, res) => {
  try {
    const db = await getDb()
    const userId = String(getUserId(req))
    const result = await db.query('SELECT * FROM type::record("visio_bg_custom", $id)', { id: userId })
    const rec = result[0]?.[0]
    if (!rec) return res.status(404).json({ error: 'Fond personnalisé absent' })
    res.json(rec)
  } catch (err) {
    console.error('[visio/bg:get]', err.message)
    res.status(500).json({ error: 'Lecture fond personnalisé impossible' })
  }
})

app.put('/api/visio/bg-custom', visioBgJson, async (req, res) => {
  try {
    const db = await getDb()
    const userId = String(getUserId(req))
    const body = req.body || {}
    const payload = {
      userId,
      data_base64: body.data_base64 || '',
      mime: body.mime || 'image/jpeg',
      size: Number(body.size) || (body.data_base64 ? body.data_base64.length : 0),
      updated_at: new Date().toISOString()
    }
    const { record, status } = await upsertRecord(db, 'visio_bg_custom', userId, payload)
    res.status(status).json(record)
  } catch (err) {
    console.error('[visio/bg:put]', err.message)
    res.status(500).json({ error: 'Enregistrement fond personnalisé impossible' })
  }
})

app.delete('/api/visio/bg-custom', async (req, res) => {
  try {
    const db = await getDb()
    const userId = String(getUserId(req))
    await db.query('DELETE type::record("visio_bg_custom", $id)', { id: userId })
    res.json({ ok: true })
  } catch (err) {
    console.error('[visio/bg:delete]', err.message)
    res.status(500).json({ error: 'Suppression fond personnalisé impossible' })
  }
})

app.get('/api/visio/docs', async (req, res) => {
  try {
    const db = await getDb()
    const userId = String(getUserId(req))
    const result = await db.query('SELECT * FROM visio_doc WHERE userId = $userId ORDER BY addedAt DESC', { userId })
    res.json(result[0] || [])
  } catch (err) {
    console.error('[visio/docs:list]', err.message)
    res.status(500).json({ error: 'Lecture documents impossible' })
  }
})

app.post('/api/visio/docs', async (req, res) => {
  try {
    const db = await getDb()
    const userId = String(getUserId(req))
    const body = req.body || {}
    const payload = {
      userId,
      name: body.name || '',
      tag: body.tag || 'custom',
      mime: body.mime || '',
      size: Number(body.size) || 0,
      pinned: Boolean(body.pinned),
      indexedDb_local_id: body.indexedDb_local_id || body.id || null,
      addedAt: body.addedAt || new Date().toISOString()
    }
    const recordId = body.id ? String(body.id).replace(/^visio_doc:/, '') : `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const cleanId = /^\d/.test(recordId) ? 'c' + recordId : recordId
    const { record, status } = await upsertRecord(db, 'visio_doc', cleanId, payload)
    res.status(status).json(record)
  } catch (err) {
    console.error('[visio/docs:post]', err.message)
    res.status(500).json({ error: 'Enregistrement document impossible' })
  }
})

app.put('/api/visio/docs/:id', async (req, res) => {
  try {
    const db = await getDb()
    const id = req.params.id
    const existing = await db.query('SELECT * FROM type::record("visio_doc", $id)', { id })
    if (!existing[0] || existing[0].length === 0) return res.status(404).json({ error: 'Document introuvable' })
    const cleanBody = { ...(req.body || {}) }
    delete cleanBody.id
    const result = await db.query('UPDATE type::record("visio_doc", $id) CONTENT $body', { id, body: cleanBody })
    res.json(result[0]?.[0] || result[0] || {})
  } catch (err) {
    console.error('[visio/docs:put]', err.message)
    res.status(500).json({ error: 'Mise à jour document impossible' })
  }
})

app.delete('/api/visio/docs/:id', async (req, res) => {
  try {
    const db = await getDb()
    await db.query('DELETE type::record("visio_doc", $id)', { id: req.params.id })
    res.json({ ok: true })
  } catch (err) {
    console.error('[visio/docs:delete]', err.message)
    res.status(500).json({ error: 'Suppression document impossible' })
  }
})

app.post('/api/visio/docs/:id/open', async (req, res) => {
  try {
    const db = await getDb()
    const userId = String(getUserId(req))
    const docId = req.params.id
    const body = req.body || {}
    const payload = {
      userId,
      docId,
      prospectId: body.prospectId || null,
      societe: body.societe || '',
      openedAt: body.openedAt || new Date().toISOString()
    }
    const recordId = `open_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const { record, status } = await upsertRecord(db, 'visio_doc_open', recordId, payload)
    res.status(status).json(record)
  } catch (err) {
    console.error('[visio/docs:open]', err.message)
    res.status(500).json({ error: 'Enregistrement ouverture impossible' })
  }
})

app.get('/api/visio/doc-opens', async (req, res) => {
  try {
    const db = await getDb()
    const userId = String(getUserId(req))
    const result = await db.query(
      'SELECT * FROM visio_doc_open WHERE userId = $userId ORDER BY openedAt DESC',
      { userId }
    )
    res.json(result[0] || [])
  } catch (err) {
    console.error('[visio/doc-opens:list]', err.message)
    res.status(500).json({ error: 'Lecture historique global ouvertures impossible' })
  }
})

app.get('/api/visio/docs/:id/opens', async (req, res) => {
  try {
    const db = await getDb()
    const userId = String(getUserId(req))
    const docId = req.params.id
    const result = await db.query(
      'SELECT * FROM visio_doc_open WHERE userId = $userId AND docId = $docId ORDER BY openedAt DESC',
      { userId, docId }
    )
    res.json(result[0] || [])
  } catch (err) {
    console.error('[visio/docs:opens]', err.message)
    res.status(500).json({ error: 'Lecture historique ouvertures impossible' })
  }
})

app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'dashboard.html'))
})

app.get('/:page', (req, res) => {
  const file = join(__dirname, 'public', req.params.page + '.html')
  res.sendFile(file, err => {
    if(err) res.sendFile(join(__dirname, 'public', 'dashboard.html'))
  })
})

// Initialise tables on boot (idempotent: IF NOT EXISTS keeps redeploys quiet)
;(async () => {
  try {
    const db = await getDb()
    await db.query('DEFINE TABLE IF NOT EXISTS mail_settings SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS mail SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS visio_settings SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS visio_log SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS visio_draft SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS visio_bg_custom SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS visio_doc SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS visio_doc_open SCHEMALESS')
    console.log('[boot] tables ready (mail x2, visio x6)')
  } catch (e) {
    console.error('[boot] table init failed:', e.message)
  }
})()

app.listen(process.env.PORT || 3000, () => console.log('✓ mup running'))