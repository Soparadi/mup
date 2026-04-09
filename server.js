import express from 'express'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()

app.use(express.static(join(__dirname, 'public')))

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