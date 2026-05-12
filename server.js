if(process.env.NODE_ENV !== 'production'){
  await import('dotenv/config')
}
import express from 'express'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { readFile } from 'fs/promises'
import { createHash } from 'crypto'
import nodemailer from 'nodemailer'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { getDb } from './lib/surreal.js'
import { encrypt, decrypt, isCryptoReady } from './lib/crypto.js'
import { getUserId, requireUserId } from './lib/auth.js'
import { cleanRecordId } from './lib/db.js'
import { router as authRouter } from './server/auth/routes.js'
import { router as stripeRouter, webhookHandler as stripeWebhookHandler } from './server/routes/stripe.js'
import { requireAuth, requireAuthHtml } from './server/middleware/requireAuth.js'
import { requireActiveSubscription } from './server/middleware/subscription.js'
import { runAuthMigration } from './server/auth/surreal-adapter.js'
import { runLeadSearchMigration, trackLeadSearch, getSearchHistory } from './server/services/search-tracker.js'
import {
  sendOne as mailServiceSendOne,
  getMailStatus as mailServiceStatus,
  isResendReady,
  verifyResendDomain,
  getResendDomainStatus,
  sendCampaign as mailServiceSendCampaign,
  verifyResendSignature,
  listMailboxCredentials,
  listGoogleMessages,
  sendWelcomeEmail
} from './lib/mail-service.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()

// ── Webhook Stripe — DOIT être enregistré AVANT express.json() global ──
// Stripe envoie le payload brut, la signature est calculée sur ce buffer.
// Si express.json() avait déjà tourné, le body serait parsé et la signature
// invalidée. Cette route consomme uniquement le raw body.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler)

// `verify` capture le rawBody pour la validation HMAC des webhooks Resend (Svix).
// Ne change rien à `req.body` parsé — ajoute juste `req.rawBody` (string).
app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8') }
}))

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

// ── Réinitialisation totale du compte utilisateur ──
// Purge toutes les tables scopées sur le userId courant. Appelé depuis le bouton
// "Réinitialiser MovUP" en bas de sidebar (double confirmation côté front).
// NE supprime PAS : mailbox_credentials (OAuth tokens — exige révocation Google séparée),
// domains_resend (configuration domaine partagée), campaigns, campaign_events.
app.delete('/api/reset-all', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  const tables = [
    'pipeline', 'agenda', 'contacts', 'devis', 'facture',
    'frais', 'frais_recurrents', 'mail', 'mail_settings',
    'visio_settings', 'visio_log', 'visio_draft',
    'visio_bg_custom', 'visio_doc', 'visio_doc_open',
    'user_plan', 'user_plan_history', 'user_settings',
    'counter'
  ]
  const deleted = {}
  try {
    const db = await getDb()
    for (const table of tables) {
      try {
        const r = await db.query(`DELETE ${table} WHERE userId = $userId RETURN BEFORE`, { userId })
        deleted[table] = (r?.[0] || []).length
      } catch (e) {
        deleted[table] = `error: ${e.message}`
      }
    }
    res.json({ ok: true, userId, deleted })
  } catch (err) {
    console.error('[reset-all]', err.message)
    res.status(500).json({ error: 'reset_failed', message: err.message })
  }
})

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

// ── Auth Phase 1 — routes publiques /api/auth/* ──
app.use('/api/auth', authRouter)

// ── Stripe (Checkout + Portal) — exempté de la gate auth + subscription ──
// Le webhook est déjà mounté avant express.json (raw body). Ces 2 routes
// utilisent JSON normal et exigent l'auth via requireAuth en route-level.
app.use('/api/stripe', stripeRouter)

// ── Démo publique landing — proxy /api/search anonymisé ──
// Mounté AVANT la gate auth. Retourne :
//   { total, totalCapped, preview[5], markers[<=500] }
//
// Filtrage région : recherche-entreprises.api.gouv.fr ignore `code_region`
// (renvoie le siège social, souvent IDF pour les chaînes nationales).
// On utilise `departement=CSV` : pour Bretagne (code 53) → "22,29,35,56".
//
// Sélection lat/lng : pour chaque résultat on pioche dans matching_etablissements
// le premier établissement physiquement dans la région (CP commençant par
// l'un des départements). Le `siege` n'est utilisé qu'en dernier recours
// (et seulement si son CP appartient bien à la région).
//
// recherche-entreprises plafonne `total_results` à 10 000 — au-delà on retourne
// `totalCapped: true` pour que le front affiche "10 000+".

// ── Filtre qualité fiches ──
// Une fiche est "prospectable" si :
//   1. au moins un dirigeant identifié (personne physique avec nom/prenoms,
//      ou personne morale avec denomination)
//   2. etat_administratif === 'A' (entreprise active — exclut les liquidations
//      finalisées et les radiations)
//   3. nature_juridique pas dans la liste exclue (54xx SCI patrimoniales,
//      71/72/73 organismes publics, 74 droit étranger)
//
// Limite connue : l'API gouv recherche-entreprises N'EXPOSE PAS de champ
// procedures_collectives / en_redressement / en_liquidation. Le filtre
// etat_administratif === 'A' capture seulement les liquidations CLÔTURÉES,
// pas les redressements en cours. Pour ces derniers il faudrait enrichir
// via Pappers ou BODACC en Phase 2.5.
// Préfixes nature juridique exclus de la prospection :
//   71 = administration publique · 72 = collectivités territoriales
//   73 = établissements administratifs · 74 = entreprises étrangères
// Les SARL/EURL (préfixe 54) sont la majorité des PME/TPE françaises,
// cible commerciale légitime → NE PAS exclure.
const EXCLUDED_NATURE_JURIDIQUE_PREFIXES = ['71', '72', '73', '74']

function hasNamedDirigeant(item) {
  const dirs = item && item.dirigeants
  if (!Array.isArray(dirs) || dirs.length === 0) return false
  for (const d of dirs) {
    if (!d || typeof d !== 'object') continue
    const nom = typeof d.nom === 'string' ? d.nom.trim() : ''
    const prenoms = typeof d.prenoms === 'string' ? d.prenoms.trim() : ''
    const denom = typeof d.denomination === 'string' ? d.denomination.trim() : ''
    if (nom || prenoms || denom) return true
  }
  return false
}

function isProspectable(item) {
  if (!item) return false
  if (item.etat_administratif !== 'A') return false
  const nat = typeof item.nature_juridique === 'string' ? item.nature_juridique : ''
  if (nat && EXCLUDED_NATURE_JURIDIQUE_PREFIXES.some(p => nat.startsWith(p))) return false
  return hasNamedDirigeant(item)
}

const REGION_DEPTS = {
  '11': ['75','77','78','91','92','93','94','95'],
  '24': ['18','28','36','37','41','45'],
  '27': ['21','25','39','58','70','71','89','90'],
  '28': ['14','27','50','61','76'],
  '32': ['02','59','60','62','80'],
  '44': ['08','10','51','52','54','55','57','67','68','88'],
  '52': ['44','49','53','72','85'],
  '53': ['22','29','35','56'],
  '75': ['16','17','19','23','24','33','40','47','64','79','86','87'],
  '76': ['09','11','12','30','31','32','34','46','48','65','66','81','82'],
  '84': ['01','03','07','15','26','38','42','43','63','69','73','74'],
  '93': ['04','05','06','13','83','84'],
  '94': ['2A','2B','20']
}

app.get('/api/public/search-demo', async (req, res) => {
  const naf = String(req.query.naf || '').trim()
  const region = String(req.query.region || '').trim()
  if (!naf) return res.status(400).json({ error: 'naf requis' })
  if (!region) return res.status(400).json({ error: 'region requise' })

  const depts = REGION_DEPTS[region]
  if (!depts) return res.status(400).json({ error: 'region inconnue' })

  let nafDotted = naf
  if (naf.length >= 4 && naf.indexOf('.') === -1) {
    nafDotted = naf.substring(0, 2) + '.' + naf.substring(2)
  }

  const PAGE_SIZE = 25
  const MAX_PAGES = 5
  const MAX_MARKERS = 500
  const deptCsv = depts.join(',')

  function buildUrl(page) {
    const p = new URLSearchParams()
    p.set('activite_principale', nafDotted)
    p.set('departement', deptCsv)
    p.set('per_page', String(PAGE_SIZE))
    p.set('page', String(page))
    return 'https://recherche-entreprises.api.gouv.fr/search?' + p.toString()
  }

  // Pour chaque résultat, choisir un établissement physique en région.
  // Priorité : matching_etablissements (le plus pertinent), fallback siège
  // si son CP est aussi dans la région.
  function pickLocalEtab(item) {
    const matching = Array.isArray(item.matching_etablissements) ? item.matching_etablissements : []
    for (let i = 0; i < matching.length; i++) {
      const cp = String(matching[i].code_postal || '')
      const dept = cp.length >= 2 ? cp.slice(0, 2) : ''
      if (depts.indexOf(dept) !== -1) return matching[i]
    }
    const siege = item.siege || {}
    const cp = String(siege.code_postal || '')
    const dept = cp.length >= 2 ? cp.slice(0, 2) : ''
    if (depts.indexOf(dept) !== -1) return siege
    return null
  }

  function mapItem(item) {
    const etab = pickLocalEtab(item)
    if (!etab) return null
    const lat = etab.latitude != null ? Number(etab.latitude) : null
    const lng = etab.longitude != null ? Number(etab.longitude) : null
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    if (lat === 0 && lng === 0) return null   // garde-fou (0,0) → dézoome
    return {
      nom_entreprise: item.nom_complet || item.nom_raison_sociale || '',
      ville: etab.libelle_commune || '',
      code_naf: nafDotted,
      libelle_naf: item.activite_principale_libelle || etab.activite_principale_libelle || '',
      lat,
      lng
    }
  }

  try {
    const r1 = await fetch(buildUrl(1))
    if (!r1.ok) return res.status(r1.status).json({ error: 'Recherche indisponible' })
    const data1 = await r1.json()
    const totalRaw = Number(data1.total_results || 0)
    const totalCapped = totalRaw >= 10000
    let raw = Array.isArray(data1.results) ? data1.results.slice() : []

    const pagesAvailable = Math.min(Math.ceil(totalRaw / PAGE_SIZE) || 1, MAX_PAGES)
    if (pagesAvailable > 1) {
      const promises = []
      for (let p = 2; p <= pagesAvailable; p++) {
        promises.push(fetch(buildUrl(p)).then(r => r.ok ? r.json() : null).catch(() => null))
      }
      const more = await Promise.all(promises)
      more.forEach(d => { if (d && Array.isArray(d.results)) raw = raw.concat(d.results) })
    }

    // Filtre qualité : on ne garde que les fiches "prospectables" (dirigeant
    // nommé + état actif + nature juridique pertinente). Le ratio observé sur
    // l'échantillon filtered/fetched sert à extrapoler le total estimé sur la
    // totalité de la région — l'API gouv ne donne pas le compte filtré exact
    // sans tout pager, extrapolation = compromis acceptable.
    const fetchedCount = raw.length
    const filteredRaw = raw.filter(isProspectable)
    const ratio = fetchedCount > 0 ? (filteredRaw.length / fetchedCount) : 1
    const totalEstimated = Math.round(totalRaw * ratio)

    const mapped = filteredRaw.map(mapItem).filter(Boolean)
    const preview = mapped.slice(0, 5)
    const markers = mapped.slice(5, 5 + (MAX_MARKERS - preview.length))
                          .map(m => ({ lat: m.lat, lng: m.lng }))

    res.json({ total: totalEstimated, totalCapped, preview, markers })
  } catch (e) {
    console.error('[public:search-demo]', e.message)
    res.status(502).json({ error: 'Service temporairement indisponible' })
  }
})

// ── Gate auth pour toutes les autres routes /api/* ──
// Exceptions : /api/auth/* (déjà mounté ci-dessus), /api/health (déjà déclaré
// ci-dessus, donc terminé avant ce middleware), webhook Resend (signature HMAC
// fait office d'auth), /api/public/* (démo landing déjà mountée ci-dessus).
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/') || req.path === '/auth' || req.path === '/health') return next()
  if (req.path.startsWith('/v2/webhooks/')) return next()
  if (req.path.startsWith('/public/')) return next()
  return requireAuth(req, res, next)
})

// ── Gate subscription : essai 14j expiré → 402 sur les écritures ──
// Tourne APRÈS requireAuth (req.authUser disponible). Routes exemptées :
//   - /api/stripe/*               : paiement (passe 2)
//   - /api/user/me                : état trial pour le popup
//   - /api/account/privacy/export : RGPD à vie
// Les méthodes GET passent toujours (lecture seule autorisée même expiré).
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/') || req.path === '/auth' || req.path === '/health') return next()
  if (req.path.startsWith('/v2/webhooks/')) return next()
  if (req.path.startsWith('/public/')) return next()
  if (req.path.startsWith('/stripe/')) return next()
  if (req.path === '/user/me') return next()
  if (req.path === '/account/privacy/export') return next()
  return requireActiveSubscription(req, res, next)
})

// ── Gate HTML pages app — protège les 15 routes app par requireAuthHtml ──
// 12 routes principales (APP_HTML_ROUTES) + 3 sous /account/ (billing, privacy,
// upgrade) couvertes par le préfixe APP_HTML_PREFIXES. Le préfixe /onboarding/
// est conservé pour compat future (dossier inexistant aujourd'hui).
// Insérée AVANT express.static pour empêcher le service direct des pages
// HTML protégées sans cookie session valide. Toute autre URL (landing,
// login, légales, assets) tombe en next() vers express.static.
const APP_HTML_ROUTES = new Set([
  '/dashboard', '/leads', '/pipeline', '/agenda', '/mail', '/visio',
  '/carte', '/contacts', '/devis', '/factures', '/frais', '/statistiques'
])
const APP_HTML_PREFIXES = ['/account', '/onboarding']

function isProtectedHtmlRoute(rawPath) {
  let p = String(rawPath || '/').replace(/\/+$/, '') || '/'
  p = p.replace(/\.html$/i, '')
  if (APP_HTML_ROUTES.has(p)) return true
  for (const prefix of APP_HTML_PREFIXES) {
    if (p === prefix || p.startsWith(prefix + '/')) return true
  }
  return false
}

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next()
  if (req.path.startsWith('/api/')) return next()
  if (!isProtectedHtmlRoute(req.path)) return next()
  return requireAuthHtml(req, res, next)
})

// ── Injection serveur-side window.__USER__ sur les routes app HTML ──
// Pattern Stripe/Linear : sidebar.js + scripts UI lisent window.__USER__ au load,
// zéro fetch supplémentaire au boot. Sécurité : sérialisation JSON + escape de
// </ en <\/ pour éviter une rupture de balise <script> via prenom/nom hostiles.
function escapeForScriptTag(json) {
  // Empêche `</script>`, `<!--`, `<![CDATA[` injectés via les champs user de
  // casser la balise <script> qui contient le JSON inline.
  return String(json)
    .replace(/<\/(script)/gi, '<\\/$1')
    .replace(/<!--/g, '<\\!--')
}

async function resolveAppHtmlFile(rawPath) {
  // Map URL → fichier disque, gérant extensions:['html'] et sous-dossiers.
  let p = String(rawPath || '/').replace(/\/+$/, '') || '/'
  // Pour /dashboard → public/dashboard.html
  // Pour /account/billing → public/account/billing.html
  // Pour /agenda.html → public/agenda.html (URL directe avec .html)
  const cleanPath = p.replace(/^\/+/, '')
  const candidates = cleanPath.endsWith('.html')
    ? [cleanPath]
    : [cleanPath + '.html']
  for (const rel of candidates) {
    try {
      const full = join(__dirname, 'public', rel)
      const html = await readFile(full, 'utf8')
      return html
    } catch (e) { /* try next */ }
  }
  return null
}

app.use(async (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next()
  if (req.path.startsWith('/api/')) return next()
  if (!isProtectedHtmlRoute(req.path)) return next()
  // Si pas d'authUser, requireAuthHtml a déjà 302'd → ce middleware ne s'exécute pas
  if (!req.authUser) return next()
  try {
    const html = await resolveAppHtmlFile(req.path)
    if (html === null) return next()
    const u = req.authUser
    const userIdStr = String(u.id || '').replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')
    const payload = {
      id: userIdStr,
      email: u.email || null,
      prenom: u.prenom || null,
      nom: u.nom || null,
      name: u.name || null,
      plan: u.plan || 'gratuit',
      trial_status: u.trial_status || null,
      trial_started_at: u.trial_started_at || null,
      trial_ends_at: u.trial_ends_at || null,
      subscription_status: u.subscription_status || null,
      current_period_end: u.current_period_end || null
    }
    const json = escapeForScriptTag(JSON.stringify(payload))
    const tag = '<script>window.__USER__=' + json + ';</script>'
    let injected
    if (html.indexOf('</head>') !== -1) {
      injected = html.replace('</head>', tag + '</head>')
    } else if (html.indexOf('<body') !== -1) {
      injected = html.replace('<body', tag + '<body')
    } else {
      injected = tag + html
    }
    res.set('Content-Type', 'text/html; charset=utf-8')
    res.set('Cache-Control', 'no-store')
    return res.send(injected)
  } catch (e) {
    console.error('[user-inject]', e.message)
    return next()
  }
})

app.use(express.static(join(__dirname, 'public'), { extensions: ['html'] }))

// ── /api/leads/engaged ──
// Retourne l'union des SIRET et SIREN déjà engagés (Pipeline ∪ Contacts) pour
// le userId courant. Sert au KPI "Déjà engagés" sur /leads pour signaler les
// fiches déjà prospectées et éviter le doublon.
app.get('/api/leads/engaged', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const [pip, ctx] = await Promise.all([
      db.query('SELECT siret, siren FROM pipeline WHERE userId = $userId', { userId }),
      db.query('SELECT siret, siren FROM contacts WHERE userId = $userId', { userId })
    ])
    const sirets = new Set()
    const sirens = new Set()
    const collect = (rows) => {
      (rows?.[0] || []).forEach(r => {
        if (r?.siret) sirets.add(String(r.siret))
        if (r?.siren) sirens.add(String(r.siren))
      })
    }
    collect(pip)
    collect(ctx)
    res.json({ sirets: Array.from(sirets), sirens: Array.from(sirens) })
  } catch (err) {
    console.error('[leads/engaged]', err.message)
    res.status(500).json({ error: 'Lecture engagés impossible' })
  }
})

app.get('/api/pipeline', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const result = await db.query('SELECT * FROM pipeline WHERE userId = $userId', { userId })
    res.json(result[0] || [])
  } catch (err) {
    console.error('[pipeline]', err)
    res.status(500).json({ error: 'Impossible de lire les cartes pipeline' })
  }
})

app.post('/api/pipeline', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const body = { ...(req.body || {}), userId } // userId forcé, body.userId écrasé
    const db = await getDb()
    const cleanId = cleanRecordId('pipeline', body?.id)
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
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const { id } = req.params
    const db = await getDb()

    // Ownership check : 404 si record absent OU appartient à un autre user
    const existing = await db.query('SELECT * FROM type::record("pipeline", $id)', { id })
    const rec = existing[0]?.[0]
    if (!rec || rec.userId !== userId) {
      return res.status(404).json({ error: 'Carte introuvable' })
    }

    // UPDATE — strip body.id et préserve userId initial
    const cleanBody = { ...(req.body || {}) }
    delete cleanBody.id
    cleanBody.userId = userId
    const result = await db.query('UPDATE type::record("pipeline", $id) CONTENT $body', { id, body: cleanBody })
    res.json(result[0]?.[0] || result[0] || {})
  } catch (err) {
    console.error('[pipeline]', err)
    res.status(500).json({ error: 'Impossible de mettre à jour la carte pipeline' })
  }
})

app.delete('/api/pipeline/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    // Tolère les 2 formes : "abc123" (id nu) ou "pipeline:abc123" (forme SurrealDB
    // complète). Tolère aussi "contacts:abc123" → strip le préfixe table.
    const id = cleanRecordId('pipeline', req.params.id) || String(req.params.id || '').replace(/^[a-z_]+:/i, '')
    const existing = await db.query('SELECT * FROM type::record("pipeline", $id)', { id })
    const rec = existing[0]?.[0]
    if (!rec || rec.userId !== userId) {
      return res.status(404).json({ error: 'Carte introuvable' })
    }
    await db.query('DELETE type::record("pipeline", $id)', { id })
    res.json({ ok: true })
  } catch (err) {
    console.error('[pipeline]', err)
    res.status(500).json({ error: 'Impossible de supprimer la carte pipeline' })
  }
})

app.get('/api/contacts', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const result = await db.query('SELECT * FROM contacts WHERE userId = $userId', { userId })
    res.json(result[0] || [])
  } catch (err) {
    console.error('[contacts]', err)
    res.status(500).json({ error: 'Impossible de lire les contacts' })
  }
})

app.post('/api/contacts', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const body = { ...(req.body || {}), userId }
    const db = await getDb()
    const cleanId = cleanRecordId('contacts', body?.id)
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
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const { id } = req.params
    const db = await getDb()

    // Ownership check
    const existing = await db.query('SELECT * FROM type::record("contacts", $id)', { id })
    const rec = existing[0]?.[0]
    if (!rec || rec.userId !== userId) {
      return res.status(404).json({ error: 'Contact introuvable' })
    }

    const cleanBody = { ...(req.body || {}) }
    delete cleanBody.id
    cleanBody.userId = userId
    const result = await db.query('UPDATE type::record("contacts", $id) CONTENT $body', { id, body: cleanBody })
    res.json(result[0]?.[0] || result[0] || {})
  } catch (err) {
    console.error('[contacts]', err)
    res.status(500).json({ error: 'Impossible de mettre à jour le contact' })
  }
})

app.delete('/api/contacts/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    // Tolère "abc123" (id nu) ou "contacts:abc123" / "pipeline:abc123"
    // (forme préfixée transmise verbatim par le client).
    const id = cleanRecordId('contacts', req.params.id) || String(req.params.id || '').replace(/^[a-z_]+:/i, '')
    const existing = await db.query('SELECT * FROM type::record("contacts", $id)', { id })
    const rec = existing[0]?.[0]
    if (!rec || rec.userId !== userId) {
      return res.status(404).json({ error: 'Contact introuvable' })
    }
    await db.query('DELETE type::record("contacts", $id)', { id })
    res.json({ ok: true })
  } catch (err) {
    console.error('[contacts]', err)
    res.status(500).json({ error: 'Impossible de supprimer le contact' })
  }
})

app.get('/api/agenda', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const ficheId = typeof req.query?.ficheId === 'string' ? req.query.ficheId.trim() : ''
    const result = ficheId
      ? await db.query(
          'SELECT * FROM agenda WHERE userId = $userId AND ficheId = $ficheId',
          { userId, ficheId }
        )
      : await db.query('SELECT * FROM agenda WHERE userId = $userId', { userId })
    res.json(result[0] || [])
  } catch (err) {
    console.error('[agenda]', err)
    res.status(500).json({ error: 'Impossible de lire les évènements agenda' })
  }
})
app.post('/api/agenda', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const body = { ...(req.body || {}), userId }
    const db = await getDb()
    const cleanId = cleanRecordId('agenda', body?.id)
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
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const { id } = req.params
    const db = await getDb()
    const existing = await db.query('SELECT * FROM type::record("agenda", $id)', { id })
    const rec = existing[0]?.[0]
    if (!rec || rec.userId !== userId) {
      return res.status(404).json({ error: 'Évènement introuvable' })
    }
    const cleanBody = { ...(req.body || {}) }
    delete cleanBody.id
    cleanBody.userId = userId
    const result = await db.query('UPDATE type::record("agenda", $id) CONTENT $body', { id, body: cleanBody })
    res.json(result[0]?.[0] || result[0] || {})
  } catch (err) {
    console.error('[agenda]', err)
    res.status(500).json({ error: 'Impossible de mettre à jour l\'évènement agenda' })
  }
})
app.delete('/api/agenda/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const { id } = req.params
    const existing = await db.query('SELECT * FROM type::record("agenda", $id)', { id })
    const rec = existing[0]?.[0]
    if (!rec || rec.userId !== userId) {
      return res.status(404).json({ error: 'Évènement introuvable' })
    }
    await db.query('DELETE type::record("agenda", $id)', { id })
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
  // Filtres geo natifs recherche-entreprises — pousse en upstream pour réduire
  // le drop client-side (avant : 96% des résultats jetés par pickLocalEtab).
  if(req.query.departement) params.set('departement', req.query.departement)
  if(req.query.code_postal) params.set('code_postal', req.query.code_postal)
  if(req.query.code_commune) params.set('code_commune', req.query.code_commune)
  // per_page hardcoded à 10 = PAGE_SIZE client. Élimine la pagination fantôme
  // (mismatch client 10 / upstream 25 → pages vides au-delà du dataset).
  params.set('per_page', '10')
  if(req.query.page) params.set('page', req.query.page)
  try {
    const r = await fetch('https://recherche-entreprises.api.gouv.fr/search?' + params.toString())
    const data = await r.json()
    // Filtre qualité : on retire les fiches non-prospectables (sans dirigeant,
    // cessées, ou nature juridique exclue — SCI/organismes publics/droit
    // étranger). total_results est ré-estimé via le ratio observé sur la page
    // courante — extrapolation acceptable car l'API ne donne pas le compte
    // exact filtré.
    if (Array.isArray(data.results)) {
      const fetched = data.results.length
      const kept = data.results.filter(isProspectable)
      data.results = kept
      if (fetched > 0 && typeof data.total_results === 'number') {
        const ratio = kept.length / fetched
        data.total_results = Math.round(data.total_results * ratio)
      }
    }
    res.json(data)
    // Fire-and-forget : tracking historique recherches. Lancé APRÈS res.json
    // pour ne jamais bloquer la réponse au front. Échec silencieux côté
    // search-tracker, .catch final pour neutraliser toute promesse rejetée.
    if (req.userId) {
      trackLeadSearch({
        userId: req.userId,
        nafCode: req.query.activite_principale || req.query.code_naf || req.query.q || '',
        nafLabel: req.query.naf_label || null,
        regionCode: req.query.code_region || req.query.region || null,
        regionName: req.query.region_name || null,
        departmentCode: req.query.code_departement || req.query.departement || null,
        departmentName: req.query.department_name || null,
        cityName: req.query.code_commune || req.query.ville || null,
        resultsCount: typeof data.total_results === 'number' ? data.total_results : (Array.isArray(data.results) ? data.results.length : 0),
        fichesCompletesFilter: req.query.fiches_completes === 'true' || req.query.fiches_completes === '1'
      }).catch(() => {})
    }
  } catch(e) {
    res.status(502).json({ error: 'Service temporairement indisponible' })
  }
})

// ── Historique des recherches Leads pour l'utilisateur authentifié ──
// Protégé automatiquement par la gate auth /api/* (req.userId déjà rempli).
app.get('/api/user/search-history', async (req, res) => {
  try {
    const result = await getSearchHistory(req.userId, {
      limit: req.query.limit,
      offset: req.query.offset
    })
    res.json(result)
  } catch (err) {
    console.error('[search-history]', err.message)
    res.status(500).json({ error: 'Impossible de lire l\'historique' })
  }
})

// ── État courant utilisateur — utilisé par le popup trial-expired-modal.js ──
// Exempté de la gate subscription (le popup l'appelle à chaque page load,
// même expiré, pour décider d'afficher l'overlay).
app.get('/api/user/me', async (req, res) => {
  try {
    const u = req.authUser
    if (!u) return res.status(401).json({ error: 'unauthorized' })
    res.json({
      id: String(u.id || '').replace(/^user:/, '').replace(/^⟨+|⟩+$/g, ''),
      email: u.email || null,
      prenom: u.prenom || null,
      nom: u.nom || null,
      name: u.name || null,
      plan: u.plan || 'gratuit',
      trial_status: u.trial_status || null,
      trial_started_at: u.trial_started_at || null,
      trial_ends_at: u.trial_ends_at || null,
      subscription_status: u.subscription_status || null,
      current_period_end: u.current_period_end || null
    })
  } catch (err) {
    console.error('[user:me]', err.message)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ── Export RGPD article 20 — JSON dump de toutes les données du user ──
// Exempté de la gate subscription (accessible à vie, même après résiliation).
// Rate limit 5 / 24h via la table privacy_export_log.
app.get('/api/account/privacy/export', async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'unauthorized' })
    const db = await getDb()
    const cleanUserId = String(req.userId).replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')

    // Rate limit 5 exports / 24h
    try {
      const recent = await db.query(
        `SELECT count() AS total FROM privacy_export_log
         WHERE user_id = type::record('user', $uid)
         AND exported_at > time::now() - 24h
         GROUP ALL`,
        { uid: cleanUserId }
      )
      const total = recent?.[0]?.[0]?.total || 0
      if (total >= 5) {
        return res.status(429).json({
          error: 'rate_limit_exceeded',
          message: 'Limite de 5 exports par 24h atteinte. Réessayez plus tard.'
        })
      }
    } catch (e) { /* rate limit best-effort, on ne bloque pas */ }

    // Récupération scopée userId — toutes les tables data du user.
    // Tokens OAuth (mailbox_credentials.accessToken/refreshToken) chiffrés
    // sont retirés du dump pour ne pas exposer même chiffrés.
    async function dump(table) {
      try {
        const r = await db.query(`SELECT * FROM ${table} WHERE userId = $uid`, { uid: cleanUserId })
        return r?.[0] || []
      } catch (e) { return [] }
    }
    async function dumpUserDirect() {
      try {
        const r = await db.query(`SELECT * FROM type::record('user', $id)`, { id: cleanUserId })
        const u = r?.[0]?.[0] || {}
        const { password_hash, ...safe } = u
        return safe
      } catch (e) { return null }
    }
    async function dumpMailboxCreds() {
      try {
        const r = await db.query(
          `SELECT id, ownerId, provider, email, scope, tokenExpiresAt, createdAt, updatedAt
           FROM mailbox_credentials WHERE ownerId = $uid`,
          { uid: cleanUserId }
        )
        return r?.[0] || []
      } catch (e) { return [] }
    }
    async function dumpSearchHistory() {
      try {
        const r = await db.query(
          `SELECT * FROM lead_search WHERE user_id = type::record('user', $uid)`,
          { uid: cleanUserId }
        )
        return r?.[0] || []
      } catch (e) { return [] }
    }

    const payload = {
      exported_at: new Date().toISOString(),
      export_version: 1,
      user: await dumpUserDirect(),
      contacts: await dump('contacts'),
      pipeline: await dump('pipeline'),
      agenda: await dump('agenda'),
      devis: await dump('devis'),
      facture: await dump('facture'),
      frais: await dump('frais'),
      frais_recurrents: await dump('frais_recurrents'),
      user_settings: await dump('user_settings'),
      mailbox_credentials: await dumpMailboxCreds(),
      search_history: await dumpSearchHistory(),
      // Note : exclus volontairement — leads INSEE (données publiques),
      // mailbox tokens en clair, password_hash, sessions, verification_token.
    }

    const json = JSON.stringify(payload, null, 2)
    const dateSlug = new Date().toISOString().slice(0, 10)
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="movup-export-${cleanUserId}-${dateSlug}.json"`)

    // Log l'export pour le rate limit + traçabilité (best-effort, pas bloquant).
    db.query(
      `CREATE privacy_export_log SET
        user_id = type::record('user', $uid),
        exported_at = time::now(),
        bytes_size = $size`,
      { uid: cleanUserId, size: Buffer.byteLength(json, 'utf8') }
    ).catch(e => console.warn('[privacy:export] log échec :', e.message))

    res.send(json)
  } catch (err) {
    console.error('[privacy:export]', err.message)
    res.status(500).json({ error: 'Export impossible' })
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
    if(!r.ok) { const body = await r.text(); console.error('[INSEE] Search error:', r.status, body.substring(0,300)); return res.status(502).json({ error: 'Recherche INSEE échouée', upstream_status: r.status }) }
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
    if(!r.ok) return res.status(502).json({ error: 'Lookup INSEE échoué', upstream_status: r.status })
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
    const userId = String(req.userId)
    if (String(req.params.userId) !== userId) return res.status(403).json({ error: 'forbidden' })
    const db = await getDb()
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
    const userId = String(req.userId)
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
    const userId = String(req.userId)
    if (String(req.params.userId) !== userId) return res.status(403).json({ error: 'forbidden' })
    const db = await getDb()
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
    const userId = String(req.userId)
    const db = await getDb()
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
    const userId = String(req.userId)
    const db = await getDb()
    const result = await db.query('SELECT * FROM type::record("mail", $id)', { id: req.params.id })
    const rec = result[0]?.[0]
    if (!rec || String(rec.userId) !== userId) return res.status(404).json({ error: 'Mail introuvable' })
    res.json(rec)
  } catch (err) {
    console.error('[mail:get]', err.message)
    res.status(500).json({ error: 'Lecture mail impossible' })
  }
})

app.delete('/api/mail/:id', async (req, res) => {
  try {
    const userId = String(req.userId)
    const db = await getDb()
    const existing = await db.query('SELECT userId FROM type::record("mail", $id)', { id: req.params.id })
    const rec = existing[0]?.[0]
    if (!rec || String(rec.userId) !== userId) return res.status(404).json({ error: 'Mail introuvable' })
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
    const userId = String(req.userId)
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
  const userId = String(req.userId)
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
    const cleanId = cleanRecordId('visio_log', body.id) || `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const { record, status } = await upsertRecord(db, 'visio_log', cleanId, payload)
    res.status(status).json(record)
  } catch (err) {
    console.error('[visio/logs:post]', err.message)
    res.status(500).json({ error: 'Enregistrement log visio impossible' })
  }
})

app.delete('/api/visio/logs/:id', async (req, res) => {
  try {
    const userId = String(req.userId)
    const db = await getDb()
    const existing = await db.query('SELECT userId FROM type::record("visio_log", $id)', { id: req.params.id })
    const rec = existing[0]?.[0]
    if (!rec || String(rec.userId) !== userId) return res.status(404).json({ error: 'Log visio introuvable' })
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
    const cleanId = cleanRecordId('visio_doc', body.id) || `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const { record, status } = await upsertRecord(db, 'visio_doc', cleanId, payload)
    res.status(status).json(record)
  } catch (err) {
    console.error('[visio/docs:post]', err.message)
    res.status(500).json({ error: 'Enregistrement document impossible' })
  }
})

app.put('/api/visio/docs/:id', async (req, res) => {
  try {
    const userId = String(req.userId)
    const db = await getDb()
    const id = req.params.id
    const existing = await db.query('SELECT * FROM type::record("visio_doc", $id)', { id })
    const rec = existing[0]?.[0]
    if (!rec || String(rec.userId) !== userId) return res.status(404).json({ error: 'Document introuvable' })
    const cleanBody = { ...(req.body || {}) }
    delete cleanBody.id
    cleanBody.userId = userId
    const result = await db.query('UPDATE type::record("visio_doc", $id) CONTENT $body', { id, body: cleanBody })
    res.json(result[0]?.[0] || result[0] || {})
  } catch (err) {
    console.error('[visio/docs:put]', err.message)
    res.status(500).json({ error: 'Mise à jour document impossible' })
  }
})

app.delete('/api/visio/docs/:id', async (req, res) => {
  try {
    const userId = String(req.userId)
    const db = await getDb()
    const existing = await db.query('SELECT userId FROM type::record("visio_doc", $id)', { id: req.params.id })
    const rec = existing[0]?.[0]
    if (!rec || String(rec.userId) !== userId) return res.status(404).json({ error: 'Document introuvable' })
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

// ── DEVIS / FACTURES ──────────────────────────────────────────────────
// V1: numérotation séquentielle protégée par mutex in-process per-(userId,type).
// Test race condition (5 POST simultanés) sur UPDATE+fallback CREATE a échoué :
// UPDATE sur record absent retourne [] et la branche CREATE n'est pas atomique
// → bascule sur sérialisation node.js. Marche tant qu'un seul replica Railway
// gère les requêtes. À revoir si scale-out > 1 replica (passer à un lock
// distribué ou à une séquence SurrealDB native si proposée).

const _counterMutex = new Map() // key: `${userId}_${type}` → pending promise

async function nextSequenceNumber(db, userId, type) {
  const key = `${userId}_${type}`
  const prev = _counterMutex.get(key) || Promise.resolve()
  let release
  const wait = new Promise(r => { release = r })
  _counterMutex.set(key, wait)
  try {
    await prev
    return await _generateSequenceUnsafe(db, userId, type)
  } finally {
    release()
    if (_counterMutex.get(key) === wait) _counterMutex.delete(key)
  }
}

async function _generateSequenceUnsafe(db, userId, type) {
  const year = new Date().getFullYear()
  const counterId = `${String(userId).replace(/[^a-zA-Z0-9_]/g, '_')}_${type}_${year}`
  // À l'intérieur du mutex : SELECT actuel → calcule nextSeq → UPDATE/CREATE.
  // Pas de race possible : un seul caller à la fois pour ce (userId,type).
  const sel = await db.query('SELECT seq FROM type::record("counter", $id)', { id: counterId })
  const current = sel[0]?.[0]
  const nextSeq = current ? Number(current.seq || 0) + 1 : 1
  if (current) {
    await db.query(
      'UPDATE type::record("counter", $id) SET seq = $seq, updated_at = time::now()',
      { id: counterId, seq: nextSeq }
    )
  } else {
    await db.query(
      'CREATE type::record("counter", $id) CONTENT { userId: $userId, type: $type, year: $year, seq: $seq, updated_at: time::now() }',
      { id: counterId, userId, type, year, seq: nextSeq }
    )
  }
  const prefix = type === 'facture' ? 'FAC' : 'DEV'
  const padded = String(nextSeq).padStart(4, '0')
  return { numero: `${prefix}-${year}-${padded}`, seq: nextSeq, year }
}

// ── DEVIS ──
app.get('/api/devis', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const result = await db.query('SELECT * FROM devis WHERE userId = $userId ORDER BY date_emission DESC, created_at DESC', { userId })
    res.json(result[0] || [])
  } catch (err) {
    console.error('[devis:list]', err.message)
    res.status(500).json({ error: 'Lecture devis impossible' })
  }
})

app.get('/api/devis/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const id = cleanRecordId('devis', req.params.id) || req.params.id
    const result = await db.query('SELECT * FROM type::record("devis", $id)', { id })
    const rec = result[0]?.[0]
    if (!rec || rec.userId !== userId) return res.status(404).json({ error: 'Devis introuvable' })
    res.json(rec)
  } catch (err) {
    console.error('[devis:get]', err.message)
    res.status(500).json({ error: 'Lecture devis impossible' })
  }
})

app.post('/api/devis', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const body = { ...(req.body || {}), userId }
    // Numéro auto si absent et pas de fourniture explicite
    if (!body.numero && !body.num) {
      const { numero, seq, year } = await nextSequenceNumber(db, userId, 'devis')
      body.numero = numero
      body.numero_seq = seq
      body.numero_year = year
    }
    const now = new Date().toISOString()
    if (!body.created_at) body.created_at = now
    body.updated_at = now

    const cleanId = cleanRecordId('devis', body.id)
    if (cleanId) {
      const { record, status } = await upsertRecord(db, 'devis', cleanId, body)
      return res.status(status).json(record)
    }
    const result = await db.query('CREATE devis CONTENT $body', { body })
    res.status(201).json(result[0]?.[0] || result[0] || null)
  } catch (err) {
    console.error('[devis:post]', err.message)
    res.status(500).json({ error: 'Enregistrement devis impossible' })
  }
})

app.put('/api/devis/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const id = cleanRecordId('devis', req.params.id) || req.params.id
    const existing = await db.query('SELECT * FROM type::record("devis", $id)', { id })
    const rec = existing[0]?.[0]
    if (!rec || rec.userId !== userId) return res.status(404).json({ error: 'Devis introuvable' })
    const cleanBody = { ...(req.body || {}) }
    delete cleanBody.id
    cleanBody.userId = userId
    cleanBody.updated_at = new Date().toISOString()
    // Préserve numero/numero_seq/numero_year initial (non-rewritable)
    if (rec.numero) cleanBody.numero = rec.numero
    if (rec.numero_seq) cleanBody.numero_seq = rec.numero_seq
    if (rec.numero_year) cleanBody.numero_year = rec.numero_year
    const result = await db.query('UPDATE type::record("devis", $id) CONTENT $body', { id, body: cleanBody })
    res.json(result[0]?.[0] || result[0] || {})
  } catch (err) {
    console.error('[devis:put]', err.message)
    res.status(500).json({ error: 'Mise à jour devis impossible' })
  }
})

app.delete('/api/devis/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const id = cleanRecordId('devis', req.params.id) || req.params.id
    const existing = await db.query('SELECT * FROM type::record("devis", $id)', { id })
    const rec = existing[0]?.[0]
    if (!rec || rec.userId !== userId) return res.status(404).json({ error: 'Devis introuvable' })
    await db.query('DELETE type::record("devis", $id)', { id })
    res.json({ ok: true })
  } catch (err) {
    console.error('[devis:delete]', err.message)
    res.status(500).json({ error: 'Suppression devis impossible' })
  }
})

// ── FACTURES ──
app.get('/api/factures', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const result = await db.query('SELECT * FROM facture WHERE userId = $userId ORDER BY date_emission DESC, created_at DESC', { userId })
    res.json(result[0] || [])
  } catch (err) {
    console.error('[factures:list]', err.message)
    res.status(500).json({ error: 'Lecture factures impossible' })
  }
})

app.get('/api/factures/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const id = cleanRecordId('facture', req.params.id) || req.params.id
    const result = await db.query('SELECT * FROM type::record("facture", $id)', { id })
    const rec = result[0]?.[0]
    if (!rec || rec.userId !== userId) return res.status(404).json({ error: 'Facture introuvable' })
    res.json(rec)
  } catch (err) {
    console.error('[factures:get]', err.message)
    res.status(500).json({ error: 'Lecture facture impossible' })
  }
})

app.post('/api/factures', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const body = { ...(req.body || {}), userId }
    if (!body.numero && !body.numero_seq) {
      const { numero, seq, year } = await nextSequenceNumber(db, userId, 'facture')
      body.numero = numero
      body.numero_seq = seq
      body.numero_year = year
    }
    const now = new Date().toISOString()
    if (!body.created_at) body.created_at = now
    body.updated_at = now

    const cleanId = cleanRecordId('facture', body.id)
    if (cleanId) {
      const { record, status } = await upsertRecord(db, 'facture', cleanId, body)
      return res.status(status).json(record)
    }
    const result = await db.query('CREATE facture CONTENT $body', { body })
    res.status(201).json(result[0]?.[0] || result[0] || null)
  } catch (err) {
    console.error('[factures:post]', err.message)
    res.status(500).json({ error: 'Enregistrement facture impossible' })
  }
})

app.put('/api/factures/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const id = cleanRecordId('facture', req.params.id) || req.params.id
    const existing = await db.query('SELECT * FROM type::record("facture", $id)', { id })
    const rec = existing[0]?.[0]
    if (!rec || rec.userId !== userId) return res.status(404).json({ error: 'Facture introuvable' })
    const cleanBody = { ...(req.body || {}) }
    delete cleanBody.id
    cleanBody.userId = userId
    cleanBody.updated_at = new Date().toISOString()
    // Numéro séquentiel verrouillé après création (exigence facturation 2027)
    if (rec.numero) cleanBody.numero = rec.numero
    if (rec.numero_seq) cleanBody.numero_seq = rec.numero_seq
    if (rec.numero_year) cleanBody.numero_year = rec.numero_year
    const result = await db.query('UPDATE type::record("facture", $id) CONTENT $body', { id, body: cleanBody })
    res.json(result[0]?.[0] || result[0] || {})
  } catch (err) {
    console.error('[factures:put]', err.message)
    res.status(500).json({ error: 'Mise à jour facture impossible' })
  }
})

app.delete('/api/factures/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const id = cleanRecordId('facture', req.params.id) || req.params.id
    const existing = await db.query('SELECT * FROM type::record("facture", $id)', { id })
    const rec = existing[0]?.[0]
    if (!rec || rec.userId !== userId) return res.status(404).json({ error: 'Facture introuvable' })
    await db.query('DELETE type::record("facture", $id)', { id })
    res.json({ ok: true })
  } catch (err) {
    console.error('[factures:delete]', err.message)
    res.status(500).json({ error: 'Suppression facture impossible' })
  }
})

// Conversion devis accepté → facture
app.post('/api/factures/from-devis/:devisId', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const { devisId } = req.params
    const dResult = await db.query('SELECT * FROM type::record("devis", $id)', { id: devisId })
    const devis = dResult[0]?.[0]
    if (!devis || devis.userId !== userId) return res.status(404).json({ error: 'Devis introuvable' })
    if (devis.statut && devis.statut !== 'accepte' && devis.status !== 'accepted') {
      return res.status(412).json({ error: 'Le devis doit être accepté avant conversion' })
    }

    // Génère le numéro de facture séquentiel
    const { numero, seq, year } = await nextSequenceNumber(db, userId, 'facture')
    const now = new Date().toISOString()
    const facturePayload = {
      ...devis,
      userId,
      id: undefined,
      numero, numero_seq: seq, numero_year: year,
      devis_id: devis.id,
      devis_origine_id: devis.id,
      statut: 'en_attente',
      date_emission: now.slice(0, 10),
      created_at: now,
      updated_at: now
    }
    delete facturePayload.id
    const result = await db.query('CREATE facture CONTENT $body', { body: facturePayload })
    const created = result[0]?.[0] || result[0] || null

    // Marque le devis transformé
    const devisIdRaw = String(devis.id).replace(/^devis:/, '')
    await db.query('UPDATE type::record("devis", $id) SET statut = "accepte", facture_id = $fid, updated_at = $now',
      { id: devisIdRaw, fid: created?.numero || numero, now })

    res.status(201).json(created)
  } catch (err) {
    console.error('[factures:from-devis]', err.message)
    res.status(500).json({ error: 'Conversion devis → facture impossible' })
  }
})

// ── FRAIS ──
app.get('/api/frais', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const result = await db.query('SELECT * FROM frais WHERE userId = $userId ORDER BY date DESC, createdAt DESC', { userId })
    res.json(result[0] || [])
  } catch (err) {
    console.error('[frais:list]', err.message)
    res.status(500).json({ error: 'Lecture frais impossible' })
  }
})

app.get('/api/frais/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const id = cleanRecordId('frais', req.params.id) || req.params.id
    const result = await db.query('SELECT * FROM type::record("frais", $id)', { id })
    const rec = result[0]?.[0]
    if (!rec || rec.userId !== userId) return res.status(404).json({ error: 'Frais introuvable' })
    res.json(rec)
  } catch (err) {
    console.error('[frais:get]', err.message)
    res.status(500).json({ error: 'Lecture frais impossible' })
  }
})

app.post('/api/frais', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const body = { ...(req.body || {}), userId }
    const now = new Date().toISOString()
    if (!body.createdAt) body.createdAt = now
    body.updatedAt = now
    const cleanId = cleanRecordId('frais', body.id)
    if (cleanId) {
      const { record, status } = await upsertRecord(db, 'frais', cleanId, body)
      return res.status(status).json(record)
    }
    const result = await db.query('CREATE frais CONTENT $body', { body })
    res.status(201).json(result[0]?.[0] || result[0] || null)
  } catch (err) {
    console.error('[frais:post]', err.message)
    res.status(500).json({ error: 'Enregistrement frais impossible' })
  }
})

app.put('/api/frais/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const id = cleanRecordId('frais', req.params.id) || req.params.id
    const existing = await db.query('SELECT * FROM type::record("frais", $id)', { id })
    const rec = existing[0]?.[0]
    if (!rec || rec.userId !== userId) return res.status(404).json({ error: 'Frais introuvable' })
    const cleanBody = { ...(req.body || {}) }
    delete cleanBody.id
    cleanBody.userId = userId
    cleanBody.updatedAt = new Date().toISOString()
    const result = await db.query('UPDATE type::record("frais", $id) CONTENT $body', { id, body: cleanBody })
    res.json(result[0]?.[0] || result[0] || {})
  } catch (err) {
    console.error('[frais:put]', err.message)
    res.status(500).json({ error: 'Mise à jour frais impossible' })
  }
})

app.delete('/api/frais/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const id = cleanRecordId('frais', req.params.id) || req.params.id
    const existing = await db.query('SELECT * FROM type::record("frais", $id)', { id })
    const rec = existing[0]?.[0]
    if (!rec || rec.userId !== userId) return res.status(404).json({ error: 'Frais introuvable' })
    await db.query('DELETE type::record("frais", $id)', { id })
    res.json({ ok: true })
  } catch (err) {
    console.error('[frais:delete]', err.message)
    res.status(500).json({ error: 'Suppression frais impossible' })
  }
})

// ── FRAIS RÉCURRENTS ──
app.get('/api/frais-recurrents', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const result = await db.query('SELECT * FROM frais_recurrents WHERE userId = $userId ORDER BY createdAt DESC', { userId })
    res.json(result[0] || [])
  } catch (err) {
    console.error('[frais-recurrents:list]', err.message)
    res.status(500).json({ error: 'Lecture frais récurrents impossible' })
  }
})

app.get('/api/frais-recurrents/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const id = cleanRecordId('frais_recurrents', req.params.id) || req.params.id
    const result = await db.query('SELECT * FROM type::record("frais_recurrents", $id)', { id })
    const rec = result[0]?.[0]
    if (!rec || rec.userId !== userId) return res.status(404).json({ error: 'Frais récurrent introuvable' })
    res.json(rec)
  } catch (err) {
    console.error('[frais-recurrents:get]', err.message)
    res.status(500).json({ error: 'Lecture frais récurrent impossible' })
  }
})

app.post('/api/frais-recurrents', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const body = { ...(req.body || {}), userId }
    const now = new Date().toISOString()
    if (!body.createdAt) body.createdAt = now
    body.updatedAt = now
    const cleanId = cleanRecordId('frais_recurrents', body.id)
    if (cleanId) {
      const { record, status } = await upsertRecord(db, 'frais_recurrents', cleanId, body)
      return res.status(status).json(record)
    }
    const result = await db.query('CREATE frais_recurrents CONTENT $body', { body })
    res.status(201).json(result[0]?.[0] || result[0] || null)
  } catch (err) {
    console.error('[frais-recurrents:post]', err.message)
    res.status(500).json({ error: 'Enregistrement frais récurrent impossible' })
  }
})

app.put('/api/frais-recurrents/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const id = cleanRecordId('frais_recurrents', req.params.id) || req.params.id
    const existing = await db.query('SELECT * FROM type::record("frais_recurrents", $id)', { id })
    const rec = existing[0]?.[0]
    if (!rec || rec.userId !== userId) return res.status(404).json({ error: 'Frais récurrent introuvable' })
    const cleanBody = { ...(req.body || {}) }
    delete cleanBody.id
    cleanBody.userId = userId
    cleanBody.updatedAt = new Date().toISOString()
    const result = await db.query('UPDATE type::record("frais_recurrents", $id) CONTENT $body', { id, body: cleanBody })
    res.json(result[0]?.[0] || result[0] || {})
  } catch (err) {
    console.error('[frais-recurrents:put]', err.message)
    res.status(500).json({ error: 'Mise à jour frais récurrent impossible' })
  }
})

app.delete('/api/frais-recurrents/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const id = cleanRecordId('frais_recurrents', req.params.id) || req.params.id
    const existing = await db.query('SELECT * FROM type::record("frais_recurrents", $id)', { id })
    const rec = existing[0]?.[0]
    if (!rec || rec.userId !== userId) return res.status(404).json({ error: 'Frais récurrent introuvable' })
    await db.query('DELETE type::record("frais_recurrents", $id)', { id })
    res.json({ ok: true })
  } catch (err) {
    console.error('[frais-recurrents:delete]', err.message)
    res.status(500).json({ error: 'Suppression frais récurrent impossible' })
  }
})

// ── USER SETTINGS ── (1 record par user, partagé Frais/Statistiques)
// PUT en MERGE pour que Frais et Statistiques cohabitent sans s'écraser.
app.get('/api/user-settings', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const result = await db.query('SELECT * FROM type::record("user_settings", $id)', { id: userId })
    const rec = result[0]?.[0]
    if (!rec) return res.json({ tvaAssujetti: false, formeJuridique: '', siret: '' })
    res.json(rec)
  } catch (err) {
    console.error('[user-settings:get]', err.message)
    res.status(500).json({ error: 'Lecture user settings impossible' })
  }
})

app.put('/api/user-settings', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const cleanBody = { ...(req.body || {}) }
    delete cleanBody.id
    cleanBody.userId = userId
    cleanBody.updatedAt = new Date().toISOString()
    const sel = await db.query('SELECT * FROM type::record("user_settings", $id)', { id: userId })
    const exists = sel[0]?.[0]
    if (exists) {
      const r = await db.query('UPDATE type::record("user_settings", $id) MERGE $body', { id: userId, body: cleanBody })
      return res.status(200).json(r[0]?.[0] || r[0] || null)
    }
    const r = await db.query('CREATE type::record("user_settings", $id) CONTENT $body', { id: userId, body: cleanBody })
    res.status(201).json(r[0]?.[0] || r[0] || null)
  } catch (err) {
    console.error('[user-settings:put]', err.message)
    res.status(500).json({ error: 'Mise à jour user settings impossible' })
  }
})

// ── USER PLAN ── (1 record par user, défaut "gratuit" si absent)
// PUT en MERGE pour cohabitation Stripe (payment_method écrit séparément du plan choisi)
// et cohérence cross-pages (Statistiques + leads.html).

// ISO date-only "YYYY-MM-DD" du 1er du mois courant en UTC.
function firstOfMonthIsoUTC() {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10)
}

// Reset lazy : si lastResetDate < 1er du mois courant, on remet à zéro le compteur mensuel
// et on persiste. Idempotent (no-op si déjà reset).
async function applyMonthlyReset(db, userId, rec) {
  const firstIso = firstOfMonthIsoUTC()
  if (rec.lastResetDate && new Date(rec.lastResetDate) >= new Date(firstIso)) return rec
  const updatedAt = new Date().toISOString()
  await db.query(
    'UPDATE type::record("user_plan", $id) MERGE $body',
    { id: userId, body: { leadsConsumedThisMonth: 0, lastResetDate: firstIso, updatedAt } }
  )
  return { ...rec, leadsConsumedThisMonth: 0, lastResetDate: firstIso, updatedAt }
}

app.get('/api/user-plan', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const result = await db.query('SELECT * FROM type::record("user_plan", $id)', { id: userId })
    const rec = result[0]?.[0]
    if (!rec) return res.json({ userId, plan: 'gratuit', leadsConsumed: 0, leadsConsumedThisMonth: 0, lastResetDate: null })
    const fresh = await applyMonthlyReset(db, userId, rec)
    res.json(fresh)
  } catch (err) {
    console.error('[user-plan:get]', err.message)
    res.status(500).json({ error: 'Lecture user plan impossible' })
  }
})

app.put('/api/user-plan', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const cleanBody = { ...(req.body || {}) }
    delete cleanBody.id
    cleanBody.userId = userId
    cleanBody.updatedAt = new Date().toISOString()
    const sel = await db.query('SELECT * FROM type::record("user_plan", $id)', { id: userId })
    const exists = sel[0]?.[0]
    // Logging changement de plan (uniquement si plan_to fourni ET différent du plan_from)
    const prevPlan = exists?.plan || null
    const nextPlan = cleanBody.plan
    if (nextPlan && prevPlan && nextPlan !== prevPlan) {
      const reason = (cleanBody.history_reason && typeof cleanBody.history_reason === 'string') ? cleanBody.history_reason : 'user_action'
      delete cleanBody.history_reason
      await db.query(
        'CREATE user_plan_history CONTENT { userId: $userId, plan_from: $from, plan_to: $to, changed_at: $now, reason: $reason }',
        { userId, from: prevPlan, to: nextPlan, now: cleanBody.updatedAt, reason }
      )
    } else {
      delete cleanBody.history_reason
    }
    if (exists) {
      const r = await db.query('UPDATE type::record("user_plan", $id) MERGE $body', { id: userId, body: cleanBody })
      return res.status(200).json(r[0]?.[0] || r[0] || null)
    }
    const r = await db.query('CREATE type::record("user_plan", $id) CONTENT $body', { id: userId, body: cleanBody })
    res.status(201).json(r[0]?.[0] || r[0] || null)
  } catch (err) {
    console.error('[user-plan:put]', err.message)
    res.status(500).json({ error: 'Mise à jour user plan impossible' })
  }
})

// Squelette V1 : retourne toujours allowed:true tant que les paliers ne sont pas validés.
// Quand PLAN_QUOTAS sera rempli, activer la logique allowed = quotaUsed < quotaLimit ici.
app.post('/api/user-plan/check-quota', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const result = await db.query('SELECT * FROM type::record("user_plan", $id)', { id: userId })
    let rec = result[0]?.[0]
    if (!rec) {
      rec = { userId, plan: 'gratuit', leadsConsumed: 0, leadsConsumedThisMonth: 0, lastResetDate: null }
    } else {
      rec = await applyMonthlyReset(db, userId, rec)
    }
    res.json({
      allowed: true,
      plan: rec.plan || 'gratuit',
      quotaUsed: rec.leadsConsumedThisMonth || 0,
      quotaLimit: null,
      quotaPeriod: 'monthly',
      upgradeUrl: '/statistiques.html#plan'
    })
  } catch (err) {
    console.error('[user-plan:check-quota]', err.message)
    res.status(500).json({ error: 'Vérification quota impossible' })
  }
})

app.get('/api/user-plan-history', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 50)
    const result = await db.query(
      'SELECT * FROM user_plan_history WHERE userId = $userId ORDER BY changed_at DESC LIMIT $limit',
      { userId, limit }
    )
    res.json(result[0] || [])
  } catch (err) {
    console.error('[user-plan-history:list]', err.message)
    res.status(500).json({ error: 'Lecture historique plan impossible' })
  }
})

// ── /api/v2/mail/* ── (refonte mail double track : Track 1 OAuth/IMAP, Track 2 Resend)
// Session 1 : seules les routes IMAP fallback sont implémentées.
// OAuth Google/Microsoft = sessions 2/3, Resend = sessions 6-8.

// Status général de la boîte mail du user (UI mail.html consomme).
app.get('/api/v2/mail/status', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const status = await mailServiceStatus(db, userId)
    res.json(status)
  } catch (err) {
    console.error('[v2/mail:status]', err.message)
    res.status(500).json({ error: 'Lecture statut mail impossible' })
  }
})

// Test la connexion IMAP+SMTP avant sauvegarde. Body : { email, password, imap_host, imap_port,
// imap_secure, smtp_host, smtp_port, smtp_secure }. Renvoie { imap_ok, smtp_ok, errors }.
app.post('/api/v2/mail/imap/test', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  if (!isCryptoReady()) return res.status(503).json({ error: 'Mail non configuré sur le serveur — SECRET_KEY absente' })
  const { email, password, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure } = req.body || {}
  if (!email || !password || !imap_host || !smtp_host) {
    return res.status(400).json({ error: 'Champs requis : email, password, imap_host, smtp_host' })
  }
  const errors = {}
  let imap_ok = false, smtp_ok = false
  try {
    const client = new ImapFlow({
      host: imap_host,
      port: Number(imap_port || 993),
      secure: imap_secure !== false,
      auth: { user: email, pass: password },
      logger: false
    })
    await client.connect()
    await client.logout()
    imap_ok = true
  } catch (e) {
    errors.imap = e.message
  }
  try {
    const port = Number(smtp_port || 465)
    const transport = nodemailer.createTransport({
      host: smtp_host,
      port,
      secure: smtp_secure !== false && port === 465,
      auth: { user: email, pass: password },
      tls: { rejectUnauthorized: true }
    })
    await transport.verify()
    smtp_ok = true
  } catch (e) {
    errors.smtp = e.message
  }
  res.json({ imap_ok, smtp_ok, errors })
})

// Sauvegarde la config IMAP du user (chiffrement password). Body identique à imap/test.
// Stockage dans mail_settings:userId (réutilise la table existante, schéma SCHEMALESS).
app.post('/api/v2/mail/imap/connect', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  if (!isCryptoReady()) return res.status(503).json({ error: 'Mail non configuré sur le serveur — SECRET_KEY absente' })
  const { email, password, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, provider_hint } = req.body || {}
  if (!email || !password || !imap_host || !smtp_host) {
    return res.status(400).json({ error: 'Champs requis : email, password, imap_host, smtp_host' })
  }
  try {
    const db = await getDb()
    const payload = {
      userId,
      email,
      provider: 'imap',
      provider_hint: provider_hint || null,
      imap_host,
      imap_port: Number(imap_port || 993),
      imap_secure: imap_secure !== false,
      imap_user: email,
      imap_password_encrypted: encrypt(password),
      smtp_host,
      smtp_port: Number(smtp_port || 465),
      smtp_secure: smtp_secure !== false,
      smtp_pass_encrypted: encrypt(password),
      needs_reconnect: false,
      updated_at: new Date().toISOString()
    }
    const sel = await db.query('SELECT * FROM type::record("mail_settings", $id)', { id: userId })
    if (sel[0]?.[0]) {
      const r = await db.query('UPDATE type::record("mail_settings", $id) MERGE $body', { id: userId, body: payload })
      return res.status(200).json({ ok: true, provider: 'imap', email, record: r[0]?.[0] || null })
    }
    payload.created_at = new Date().toISOString()
    const r = await db.query('CREATE type::record("mail_settings", $id) CONTENT $body', { id: userId, body: payload })
    res.status(201).json({ ok: true, provider: 'imap', email, record: r[0]?.[0] || null })
  } catch (err) {
    console.error('[v2/mail:imap-connect]', err.message)
    res.status(500).json({ error: 'Sauvegarde config IMAP impossible' })
  }
})

// Déconnecte la boîte mail du user — supprime le record mail_settings.
app.post('/api/v2/mail/disconnect', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    await db.query('DELETE type::record("mail_settings", $id)', { id: userId })
    res.json({ ok: true })
  } catch (err) {
    console.error('[v2/mail:disconnect]', err.message)
    res.status(500).json({ error: 'Déconnexion impossible' })
  }
})

// Envoi 1:1 — utilise mail-service.js (route sur le bon provider).
// Session 1 : seul provider:'imap' fonctionne.
app.post('/api/v2/mail/send', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  const { to, subject, body, html, attachments } = req.body || {}
  if (!to || !subject) return res.status(400).json({ error: 'Champs requis : to, subject' })
  try {
    const db = await getDb()
    const result = await mailServiceSendOne(db, userId, { to, subject, body, html, attachments })
    res.json(result)
  } catch (err) {
    console.error('[v2/mail:send]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── OAuth Google (Track 1 — boîte personnelle Gmail) ──

import('./lib/oauth-google.js').then(() => {})  // pre-warm import (no-op)

app.get('/auth/google', async (req, res) => {
  const ownerId = requireUserId(req, res)
  if (!ownerId) return
  try {
    const { isGoogleReady, signState, generateAuthUrl } = await import('./lib/oauth-google.js')
    if (!isGoogleReady()) return res.status(503).json({ error: 'OAuth Google non configuré (variables GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI manquantes)' })
    const state = signState({ ownerId, companyId: req.query.companyId || null })
    const url = generateAuthUrl(state)
    res.redirect(302, url)
  } catch (err) {
    console.error('[oauth-google:start]', err.message)
    res.status(500).json({ error: 'Démarrage OAuth Google impossible' })
  }
})

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { isGoogleReady, verifyState, exchangeCode, fetchUserInfo } = await import('./lib/oauth-google.js')
    const { encryptMailToken, isMailCryptoReady } = await import('./lib/crypto.js')
    if (!isGoogleReady()) return res.status(503).send('OAuth Google non configuré')
    if (!isMailCryptoReady()) return res.status(503).send('MAIL_ENCRYPTION_KEY/SECRET_KEY manquante')

    const { code, state, error: googleErr } = req.query
    if (googleErr) return res.redirect(302, '/mail.html?google_error=' + encodeURIComponent(String(googleErr)))
    if (!code || !state) return res.status(400).send('code/state manquants')
    const claims = verifyState(String(state))
    if (!claims) return res.status(401).send('state JWT invalide ou expiré (>10 min)')

    const tokens = await exchangeCode(String(code))
    if (!tokens.refresh_token) {
      return res.redirect(302, '/mail.html?google_error=' + encodeURIComponent('Aucun refresh_token reçu — révoquer l\'app dans les paramètres Google et réessayer'))
    }
    const userInfo = await fetchUserInfo(tokens)
    if (!userInfo?.email) return res.status(502).send('Email utilisateur introuvable via Google API')
    const email = userInfo.email

    const db = await getDb()
    const recordId = `${claims.ownerId}__google__${email.replace(/[^a-zA-Z0-9._-]/g, '_')}`
    const now = new Date().toISOString()
    const payload = {
      ownerId: claims.ownerId,
      companyId: claims.companyId || null,
      provider: 'google',
      email,
      userName: userInfo.name || null,
      givenName: userInfo.given_name || null,
      accessToken: encryptMailToken(tokens.access_token),
      refreshToken: encryptMailToken(tokens.refresh_token),
      tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      scope: tokens.scope || null,
      updatedAt: now
    }
    const sel = await db.query('SELECT * FROM type::record("mailbox_credentials", $id)', { id: recordId })
    if (sel[0]?.[0]) {
      await db.query('UPDATE type::record("mailbox_credentials", $id) MERGE $body', { id: recordId, body: payload })
    } else {
      payload.createdAt = now
      await db.query('CREATE type::record("mailbox_credentials", $id) CONTENT $body', { id: recordId, body: payload })
    }

    // Welcome email auto via Resend (idempotent — skip si welcomeEmailSentAt déjà set).
    // try/catch — un échec d'envoi ne casse pas le flow OAuth.
    try {
      if (isResendReady()) {
        const result = await sendWelcomeEmail(db, {
          ownerId: claims.ownerId,
          companyId: claims.companyId || null,
          userEmail: email,
          userName: userInfo.given_name || userInfo.name || null
        })
        if (result.sent) console.log('[oauth-google:welcome] envoyé pour', email)
        else if (result.skipped) console.log('[oauth-google:welcome] skip (' + result.reason + ') pour', email)
      } else {
        console.warn('[oauth-google:welcome] RESEND_API_KEY absente, welcome non envoyé')
      }
    } catch (e) {
      console.warn('[oauth-google:welcome] erreur (non bloquante) :', e.message)
    }

    res.redirect(302, '/mail.html?google_connected=1&email=' + encodeURIComponent(email))
  } catch (err) {
    console.error('[oauth-google:callback]', err.message)
    res.redirect(302, '/mail.html?google_error=' + encodeURIComponent(err.message || 'Erreur OAuth Google'))
  }
})

app.post('/auth/google/disconnect', async (req, res) => {
  const ownerId = requireUserId(req, res)
  if (!ownerId) return
  const { email } = req.body || {}
  if (!email) return res.status(400).json({ error: 'email requis' })
  try {
    const db = await getDb()
    const recordId = `${ownerId}__google__${String(email).replace(/[^a-zA-Z0-9._-]/g, '_')}`
    const sel = await db.query('SELECT * FROM type::record("mailbox_credentials", $id)', { id: recordId })
    const cred = sel[0]?.[0]
    if (!cred || cred.ownerId !== ownerId) return res.status(404).json({ error: 'Compte introuvable' })

    // Révocation côté Google (best effort)
    try {
      const { decryptMailToken } = await import('./lib/crypto.js')
      const { revokeRefreshToken, isGoogleReady } = await import('./lib/oauth-google.js')
      if (isGoogleReady() && cred.refreshToken) {
        const refreshToken = decryptMailToken(cred.refreshToken)
        await revokeRefreshToken(refreshToken)
      }
    } catch (e) {
      console.warn('[oauth-google:revoke] échec révocation côté Google :', e.message)
    }

    await db.query('DELETE type::record("mailbox_credentials", $id)', { id: recordId })
    res.status(204).end()
  } catch (err) {
    console.error('[oauth-google:disconnect]', err.message)
    res.status(500).json({ error: 'Déconnexion impossible' })
  }
})

// Stub OAuth Microsoft — session 3.
app.get('/auth/microsoft', (req, res) => {
  res.status(501).json({ error: 'OAuth Microsoft non configuré — voir session 3 (README-mail.md)' })
})
app.get('/auth/microsoft/callback', (req, res) => {
  res.status(501).json({ error: 'OAuth Microsoft non configuré — voir session 3 (README-mail.md)' })
})

// ── Liste tous les comptes mail connectés du user (mailbox_credentials + mail_settings IMAP)
app.get('/api/v2/mail/accounts', async (req, res) => {
  const ownerId = requireUserId(req, res)
  if (!ownerId) return
  try {
    const db = await getDb()
    const oauth = await listMailboxCredentials(db, ownerId)
    // Aplatit (jamais de token retourné — listMailboxCredentials ne sélectionne pas access/refresh)
    const accounts = oauth.map(c => ({
      id: c.id,
      provider: c.provider,
      email: c.email,
      scope: c.scope,
      tokenExpiresAt: c.tokenExpiresAt,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt
    }))
    // Inclut aussi la config IMAP legacy si existe
    const imapStatus = await mailServiceStatus(db, ownerId)
    if (imapStatus.connected && imapStatus.provider === 'imap' && imapStatus.email) {
      accounts.push({ id: `mail_settings:${ownerId}`, provider: 'imap', email: imapStatus.email, legacy: true })
    }
    res.json(accounts)
  } catch (err) {
    console.error('[v2/mail:accounts]', err.message)
    res.status(500).json({ error: 'Lecture comptes impossible' })
  }
})

// Preview inbox d'un compte Google connecté (Track 1 OAuth).
app.get('/api/v2/mail/inbox-preview', async (req, res) => {
  const ownerId = requireUserId(req, res)
  if (!ownerId) return
  const { email, limit, query } = req.query
  if (!email) return res.status(400).json({ error: 'email requis (du compte Google connecté)' })
  try {
    const db = await getDb()
    const messages = await listGoogleMessages(db, ownerId, String(email), {
      limit: limit ? Number(limit) : 25,
      query: query ? String(query) : 'newer_than:7d'
    })
    res.json(messages)
  } catch (err) {
    console.error('[v2/mail:inbox-preview]', err.message)
    res.status(500).json({ error: err.message || 'Lecture inbox impossible' })
  }
})

// ────────────────────────────────────────────────────────────────────────────
// TRACK 2 — RESEND COLD MAILING CAMPAGNES
// ────────────────────────────────────────────────────────────────────────────

function ensureResendOrFail(res) {
  if (!isResendReady()) {
    res.status(503).json({ error: 'RESEND_API_KEY non configurée — voir README-mail.md' })
    return false
  }
  return true
}

// Sanitize une chaîne pour l'utiliser comme id SurrealDB (alphanum + underscore + hyphen).
function safeId(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 80)
}

// ── DOMAINS RESEND ──

// POST /api/v2/campaigns/domain/verify
// Body : { domain_name }
// Crée le domaine sur Resend (ou récupère l'existant si 409), retourne records DNS.
app.post('/api/v2/campaigns/domain/verify', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  if (!ensureResendOrFail(res)) return
  const { domain_name } = req.body || {}
  if (!domain_name || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain_name)) {
    return res.status(400).json({ error: 'domain_name invalide' })
  }
  try {
    const result = await verifyResendDomain(domain_name)
    const db = await getDb()
    const recordId = `${userId}__${safeId(domain_name)}`
    const payload = {
      userId,
      domain_name,
      resend_domain_id: result.id,
      status: result.status || 'pending',
      dns_records: result.records || [],
      verified_at: result.status === 'verified' ? new Date().toISOString() : null,
      updated_at: new Date().toISOString()
    }
    const sel = await db.query('SELECT * FROM type::record("domains_resend", $id)', { id: recordId })
    if (sel[0]?.[0]) {
      await db.query('UPDATE type::record("domains_resend", $id) MERGE $body', { id: recordId, body: payload })
    } else {
      payload.created_at = new Date().toISOString()
      await db.query('CREATE type::record("domains_resend", $id) CONTENT $body', { id: recordId, body: payload })
    }
    res.json({
      record_id: recordId,
      resend_domain_id: result.id,
      domain_name,
      status: result.status || 'pending',
      dns_records: result.records || [],
      existing: Boolean(result.existing)
    })
  } catch (err) {
    console.error('[campaigns:domain-verify]', err.message)
    if (/rate limit|429/i.test(err.message)) return res.status(503).json({ error: 'Resend rate limit, réessayez dans quelques secondes' })
    res.status(500).json({ error: err.message || 'Vérification domaine impossible' })
  }
})

// GET /api/v2/campaigns/domain/status?domain_id=xxx
// Resync l'état Resend → table domains_resend, retourne le statut courant.
app.get('/api/v2/campaigns/domain/status', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  if (!ensureResendOrFail(res)) return
  const { domain_id } = req.query
  if (!domain_id) return res.status(400).json({ error: 'domain_id requis (id Resend)' })
  try {
    const live = await getResendDomainStatus(domain_id)
    const db = await getDb()
    // Update dans notre table le record matchant resend_domain_id pour ce userId
    const all = await db.query('SELECT * FROM domains_resend WHERE userId = $userId AND resend_domain_id = $rid', { userId, rid: domain_id })
    const local = all[0]?.[0]
    if (local) {
      const recordId = String(local.id).replace(/^domains_resend:/, '').replace(/^⟨+|⟩+$/g, '')
      const patch = {
        status: live.status,
        dns_records: live.records,
        updated_at: new Date().toISOString()
      }
      if (live.status === 'verified' && !local.verified_at) {
        patch.verified_at = new Date().toISOString()
      }
      await db.query('UPDATE type::record("domains_resend", $id) MERGE $body', { id: recordId, body: patch })
    }
    res.json({ resend_domain_id: live.id, domain_name: live.name, status: live.status, dns_records: live.records })
  } catch (err) {
    console.error('[campaigns:domain-status]', err.message)
    res.status(500).json({ error: err.message || 'Lecture statut domaine impossible' })
  }
})

// GET /api/v2/campaigns/domain/list — domaines du user en base locale
app.get('/api/v2/campaigns/domain/list', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const result = await db.query('SELECT * FROM domains_resend WHERE userId = $userId ORDER BY created_at DESC', { userId })
    res.json(result[0] || [])
  } catch (err) {
    console.error('[campaigns:domain-list]', err.message)
    res.status(500).json({ error: 'Lecture domaines impossible' })
  }
})

// ── CAMPAIGNS ──

// POST /api/v2/campaigns/create
// Body : { name, template_subject, template_html, template_text?, recipients[], from_email, from_name?, reply_to?, scheduled_at? }
app.post('/api/v2/campaigns/create', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  const { name, template_subject, template_html, template_text, recipients, from_email, from_name, reply_to, scheduled_at } = req.body || {}
  if (!name || !template_subject || !from_email) {
    return res.status(400).json({ error: 'Champs requis : name, template_subject, from_email' })
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: 'recipients requis (array non vide)' })
  }
  if (!template_html && !template_text) {
    return res.status(400).json({ error: 'template_html ou template_text requis' })
  }
  try {
    const db = await getDb()
    const id = 'camp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
    const now = new Date().toISOString()
    const status = scheduled_at ? 'scheduled' : 'draft'
    const body = {
      userId,
      name,
      template_subject,
      template_html: template_html || null,
      template_text: template_text || null,
      recipients,
      recipients_count: recipients.length,
      from_email,
      from_name: from_name || null,
      reply_to: reply_to || null,
      scheduled_at: scheduled_at || null,
      status,
      stats: { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unsubscribed: 0 },
      created_at: now,
      updated_at: now
    }
    const result = await db.query('CREATE type::record("campaigns", $id) CONTENT $body', { id, body })
    res.status(201).json(result[0]?.[0] || result[0] || null)
  } catch (err) {
    console.error('[campaigns:create]', err.message)
    res.status(500).json({ error: 'Création campagne impossible' })
  }
})

// POST /api/v2/campaigns/:id/send
app.post('/api/v2/campaigns/:id/send', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  if (!ensureResendOrFail(res)) return
  const id = cleanRecordId('campaigns', req.params.id) || req.params.id
  try {
    const db = await getDb()
    const sel = await db.query('SELECT * FROM type::record("campaigns", $id)', { id })
    const campaign = sel[0]?.[0]
    if (!campaign || campaign.userId !== userId) return res.status(404).json({ error: 'Campagne introuvable' })
    if (campaign.status === 'sending' || campaign.status === 'completed') {
      return res.status(409).json({ error: `Campagne déjà ${campaign.status} — envoi refusé (idempotence)` })
    }

    // Vérifie qu'au moins un domaine vérifié existe pour ce user (cohérence with from_email)
    const domains = await db.query('SELECT * FROM domains_resend WHERE userId = $userId AND status = "verified"', { userId })
    const verified = (domains[0] || []).map(d => d.domain_name)
    const fromDomain = String(campaign.from_email).split('@')[1]
    const movupShared = fromDomain === 'movup.io'  // domaine partagé MUP, toujours autorisé
    if (!verified.includes(fromDomain) && !movupShared) {
      return res.status(412).json({ error: `Domaine ${fromDomain} non vérifié. Vérifier dans l'onglet Paramètres avant l'envoi.` })
    }

    // Mark as sending immediately for idempotence guard
    await db.query('UPDATE type::record("campaigns", $id) MERGE $body', { id, body: { status: 'sending', send_started_at: new Date().toISOString(), updated_at: new Date().toISOString() } })

    const result = await mailServiceSendCampaign(userId, {
      from: campaign.from_email,
      fromName: campaign.from_name,
      replyTo: campaign.reply_to,
      recipients: campaign.recipients,
      subject: campaign.template_subject,
      html: campaign.template_html,
      text: campaign.template_text
    })

    const stats = campaign.stats || { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unsubscribed: 0 }
    stats.sent = (stats.sent || 0) + result.sent_count
    await db.query('UPDATE type::record("campaigns", $id) MERGE $body', {
      id,
      body: {
        status: result.failed_count > 0 && result.sent_count === 0 ? 'failed' : 'completed',
        sent_at: new Date().toISOString(),
        stats,
        batch_ids: result.batch_ids,
        sent_count: result.sent_count,
        failed_count: result.failed_count,
        updated_at: new Date().toISOString()
      }
    })
    const responseStatus = result.failed_count > 0 && result.sent_count === 0 ? 502 : 200
    res.status(responseStatus).json({
      id,
      sent_count: result.sent_count,
      failed_count: result.failed_count,
      batch_ids: result.batch_ids,
      total: result.total,
      last_error: result.last_error || undefined
    })
  } catch (err) {
    console.error('[campaigns:send]', err.message)
    // Reset le status si on a marqué sending mais que l'envoi a totalement échoué avant batch
    try {
      const db = await getDb()
      await db.query('UPDATE type::record("campaigns", $id) MERGE $body', { id, body: { status: 'failed', last_error: err.message, updated_at: new Date().toISOString() } })
    } catch (e) {/* swallow */}
    if (/rate limit|429/i.test(err.message)) return res.status(503).json({ error: 'Resend rate limit — réessayez dans quelques secondes' })
    res.status(500).json({ error: err.message || 'Envoi campagne impossible' })
  }
})

// GET /api/v2/campaigns — liste des campagnes du user
app.get('/api/v2/campaigns', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const result = await db.query('SELECT id, name, status, recipients_count, from_email, scheduled_at, sent_at, stats, created_at FROM campaigns WHERE userId = $userId AND (status != "deleted" OR status IS NONE) ORDER BY created_at DESC', { userId })
    res.json(result[0] || [])
  } catch (err) {
    console.error('[campaigns:list]', err.message)
    res.status(500).json({ error: 'Lecture campagnes impossible' })
  }
})

// GET /api/v2/campaigns/:id — détail
app.get('/api/v2/campaigns/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const id = cleanRecordId('campaigns', req.params.id) || req.params.id
    const sel = await db.query('SELECT * FROM type::record("campaigns", $id)', { id })
    const campaign = sel[0]?.[0]
    if (!campaign || campaign.userId !== userId) return res.status(404).json({ error: 'Campagne introuvable' })
    res.json(campaign)
  } catch (err) {
    console.error('[campaigns:get]', err.message)
    res.status(500).json({ error: 'Lecture campagne impossible' })
  }
})

// GET /api/v2/campaigns/:id/stats — agrégats + liste recipients avec dernier event
app.get('/api/v2/campaigns/:id/stats', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const id = cleanRecordId('campaigns', req.params.id) || req.params.id
    const sel = await db.query('SELECT * FROM type::record("campaigns", $id)', { id })
    const campaign = sel[0]?.[0]
    if (!campaign || campaign.userId !== userId) return res.status(404).json({ error: 'Campagne introuvable' })

    // Liste des events de cette campagne
    const evRes = await db.query('SELECT * FROM campaign_events WHERE campaign_id = $cid ORDER BY timestamp DESC', { cid: String(campaign.id).replace(/^campaigns:/, '').replace(/^⟨+|⟩+$/g, '') })
    const events = evRes[0] || []

    // Agrégats par destinataire (dernier event par recipient_email)
    const lastByRecipient = new Map()
    for (const e of events) {
      if (!lastByRecipient.has(e.recipient_email)) {
        lastByRecipient.set(e.recipient_email, e)
      }
    }
    const recipientsStatus = (campaign.recipients || []).map(r => {
      const last = lastByRecipient.get(r.email) || null
      return { email: r.email, last_event: last ? last.event_type : null, last_timestamp: last ? last.timestamp : null }
    })

    res.json({
      id: campaign.id,
      stats: campaign.stats || {},
      status: campaign.status,
      recipients_count: campaign.recipients_count,
      recipients_status: recipientsStatus,
      events_total: events.length
    })
  } catch (err) {
    console.error('[campaigns:stats]', err.message)
    res.status(500).json({ error: 'Lecture stats campagne impossible' })
  }
})

// DELETE /api/v2/campaigns/:id — soft delete
app.delete('/api/v2/campaigns/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const id = cleanRecordId('campaigns', req.params.id) || req.params.id
    const sel = await db.query('SELECT * FROM type::record("campaigns", $id)', { id })
    const campaign = sel[0]?.[0]
    if (!campaign || campaign.userId !== userId) return res.status(404).json({ error: 'Campagne introuvable' })
    await db.query('UPDATE type::record("campaigns", $id) MERGE $body', { id, body: { status: 'deleted', deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() } })
    res.json({ ok: true })
  } catch (err) {
    console.error('[campaigns:delete]', err.message)
    res.status(500).json({ error: 'Suppression campagne impossible' })
  }
})

// ── WEBHOOK RESEND ──
// Validation HMAC Svix obligatoire. Refus 401 si invalide.
app.post('/api/v2/webhooks/resend', async (req, res) => {
  const verification = verifyResendSignature(req.rawBody, req.headers)
  if (!verification.ok) {
    console.warn('[webhook:resend] signature invalide :', verification.reason)
    return res.status(401).json({ error: 'signature invalide', reason: verification.reason })
  }
  // Réponse 200 immédiate (Resend re-tente si > 5s ou non 2xx)
  res.status(200).json({ ok: true })

  // Traitement asynchrone — n'affecte pas le 200 déjà envoyé
  ;(async () => {
    try {
      const event = req.body
      const type = event?.type || ''
      const data = event?.data || {}
      const recipient = Array.isArray(data.to) ? data.to[0] : data.email_id || data.to || null

      // Map event type → notre nomenclature interne
      const map = {
        'email.delivered': 'delivered',
        'email.opened': 'opened',
        'email.clicked': 'clicked',
        'email.bounced': 'bounced',
        'email.complained': 'complained',
        'email.unsubscribed': 'unsubscribed'
      }
      const eventType = map[type]
      if (!eventType) {
        console.log('[webhook:resend] event type non géré :', type)
        return
      }

      const db = await getDb()
      // Lookup campagne via batch_ids match. Les batch_ids étant uniques globalement,
      // un match suffit à identifier la campagne (pas de dépendance aux tags Resend).
      // Race condition : Resend envoie le webhook ~500ms après batch.send(), mais l'écriture
      // batch_ids côté SurrealDB Cloud peut prendre 700-1000ms (round-trip).
      // → retry court (4 tentatives, 500ms entre chaque, 1.5s max) couvre la fenêtre.
      let campaignId = null
      const emailId = data.email_id
      if (emailId) {
        const lookup = async () => {
          try {
            const found = await db.query('SELECT id FROM campaigns WHERE batch_ids CONTAINS $eid LIMIT 1', { eid: emailId })
            return found[0]?.[0] || null
          } catch (e) {
            try {
              const found2 = await db.query('SELECT id FROM campaigns WHERE $eid IN batch_ids LIMIT 1', { eid: emailId })
              return found2[0]?.[0] || null
            } catch (e2) {
              console.error('[webhook:resend] lookup query error :', e2.message)
              return null
            }
          }
        }
        let c = await lookup()
        let retries = 0
        while (!c && retries < 3) {
          await new Promise(res => setTimeout(res, 500))
          retries++
          c = await lookup()
        }
        if (c) campaignId = String(c.id).replace(/^campaigns:/, '').replace(/^⟨+|⟩+$/g, '')
        else console.warn('[webhook:resend] campaign_id introuvable après retries pour email_id', emailId)
      }

      // Insert event
      const eventDoc = {
        campaign_id: campaignId,
        recipient_email: recipient,
        event_type: eventType,
        timestamp: data.created_at || new Date().toISOString(),
        metadata: { resend_email_id: emailId, raw_type: type, click_url: data.click?.link || null, bounce_reason: data.bounce?.message || null }
      }
      await db.query('CREATE campaign_events CONTENT $body', { body: eventDoc })

      // Update agrégats si campagne identifiée
      if (campaignId) {
        const camp = await db.query('SELECT stats FROM type::record("campaigns", $id)', { id: campaignId })
        const stats = camp[0]?.[0]?.stats || { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unsubscribed: 0 }
        stats[eventType] = (stats[eventType] || 0) + 1
        await db.query('UPDATE type::record("campaigns", $id) MERGE $body', { id: campaignId, body: { stats, updated_at: new Date().toISOString() } })
      }
    } catch (e) {
      console.error('[webhook:resend:async]', e.message)
    }
  })()
})

// Handler 404 final — toute route GET non matchée par express.static, l'API
// ou les middlewares ci-dessus tombe ici. Plus de fallback silencieux sur
// dashboard.html (qui exposait le HTML protégé sans auth).
// Note : `/` est servie par express.static qui sert public/index.html via
// l'option default index — pas besoin de handler explicite.
app.use((req, res) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return res.status(404).sendFile(join(__dirname, 'public', '404.html'), err => {
      if (err) res.status(404).type('text/plain').send('404 — Page introuvable')
    })
  }
  res.status(404).json({ error: 'not_found' })
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
    await db.query('DEFINE TABLE IF NOT EXISTS devis SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS facture SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS counter SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS frais SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS frais_recurrents SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS user_settings SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS user_plan SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS user_plan_history SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS domains_resend SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS campaigns SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS campaign_events SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS mailbox_credentials SCHEMALESS')
    // Indexes pour les requêtes scoping userId et lookups par campagne/destinataire
    await db.query('DEFINE INDEX IF NOT EXISTS campaigns_user ON TABLE campaigns COLUMNS userId')
    await db.query('DEFINE INDEX IF NOT EXISTS domains_user ON TABLE domains_resend COLUMNS userId')
    await db.query('DEFINE INDEX IF NOT EXISTS events_campaign ON TABLE campaign_events COLUMNS campaign_id')
    await db.query('DEFINE INDEX IF NOT EXISTS events_recipient ON TABLE campaign_events COLUMNS recipient_email')
    // Unicité (ownerId, email, provider) — un user ne peut connecter 2x la même boîte sur le même provider
    await db.query('DEFINE INDEX IF NOT EXISTS mailbox_creds_unique ON TABLE mailbox_credentials COLUMNS ownerId, email, provider UNIQUE')
    await db.query('DEFINE INDEX IF NOT EXISTS mailbox_creds_owner ON TABLE mailbox_credentials COLUMNS ownerId')
    console.log('[boot] tables ready (mail x2, visio x6, devis, facture, counter, frais x2, user_settings, user_plan x2, mail_v2 x3, mailbox_credentials + 6 indexes)')
  } catch (e) {
    console.error('[boot] table init failed:', e.message)
  }
  // Auth Phase 1 — applique migration tables user/session/verification_token/audit_log.
  try {
    await runAuthMigration()
    console.log('[boot] auth tables ready (user, session, verification_token, audit_log)')
  } catch (e) {
    console.error('[boot] auth migration failed:', e.message)
  }
  // Tracking historique recherches Leads — table lead_search + 3 index.
  try {
    await runLeadSearchMigration()
    console.log('[boot] lead_search table ready (+ 3 indexes)')
  } catch (e) {
    console.error('[boot] lead_search migration failed:', e.message)
  }
})()

app.listen(process.env.PORT || 3000, () => console.log('✓ mup running'))