import express from 'express'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()

app.use(express.static(join(__dirname, 'public')))

// ── API proxies ──
app.get('/api/search', async (req, res) => {
  const params = new URLSearchParams()
  if(req.query.q) params.set('q', req.query.q)
  if(req.query.region) params.set('region', req.query.region)
  if(req.query.code_naf) params.set('activite_principale', req.query.code_naf)
  if(req.query.activite_principale) params.set('activite_principale', req.query.activite_principale)
  if(req.query.per_page) params.set('per_page', req.query.per_page)
  if(req.query.page) params.set('page', req.query.page)
  try {
    const r = await fetch('https://recherche-entreprises.api.gouv.fr/search?' + params.toString())
    const data = await r.json()
    res.json(data)
  } catch(e) {
    res.status(502).json({ error: 'Service temporairement indisponible' })
  }
})

app.get('/api/geocode', async (req, res) => {
  const q = req.query.q || ''
  try {
    const r = await fetch('https://api-adresse.data.gouv.fr/search/?q=' + encodeURIComponent(q) + '&limit=1')
    const data = await r.json()
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