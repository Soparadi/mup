if(process.env.NODE_ENV !== 'production'){
  await import('dotenv/config')
}
import express from 'express'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { getDb } from './lib/surreal.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json())

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

app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'dashboard.html'))
})

app.get('/:page', (req, res) => {
  const file = join(__dirname, 'public', req.params.page + '.html')
  res.sendFile(file, err => {
    if(err) res.sendFile(join(__dirname, 'public', 'dashboard.html'))
  })
})

app.listen(process.env.PORT || 3000, () => console.log('✓ mup running'))