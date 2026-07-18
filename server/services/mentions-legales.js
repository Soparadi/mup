// Service Mentions Légales — crawl ciblé du site d'une entreprise pour compléter
// le référentiel mutualisé (website / societe_email / societe_tel) en fill-if-empty.
//
// NON branché au démarrage : aucun appel au boot. Déclenché à la demande via la
// route /api/mentions-legales (setTimeout différé, modèle /api/amorce).
//
// Chaîne en 4 maillons (doctrine du brief) :
//   1.a  URL depuis le champ website déjà en base (faisceau).
//   1.b  URL par recherche web (module recherche-web.js) si rien en base.
//   2.   Page légale : liens footer (mentions/legal/cgv/contact) puis chemins
//        conventionnels (/mentions-legales, /mentions, /legal, /cgv, /contact).
//   3.   Extraction : SIRET/SIREN, tél FR (hors surtaxés 08), email, adresse.
//   4.   Recoupement scoré contre le faisceau + écriture additive.
//
// Robustesse : jamais de throw remontant. Échec réseau/timeout → « rien ». Tous
// les appels sortants passent par une file séquentielle mono-verrou (patron
// overpass.js) + AbortController : un appel à la fois, délai entre chaque, une
// seule IP → politesse stricte. politeFetchText est exportée : le module de
// recherche web réutilise LE MÊME verrou (une seule file pour tout le sortant).

import { getDb } from '../../lib/surreal.js'
import { cleanRecordId } from '../../lib/db.js'
import { enrichReferentielActionnable } from './referentiel.js'
import { getReferentielFaisceauBySiret } from './referentiel-read.js'
import { normText, corroborerSiret } from './overpass.js'
import { rechercherUrlSociete } from './recherche-web.js'

// Overpass/serveurs tiers refusent souvent les requêtes sans User-Agent explicite.
const USER_AGENT = 'MovUP/1.0 (+https://movup.fr)'

// Bornes réseau. Le [timeout] Overpass QL ne s'applique PAS aux sites tiers :
// c'est l'AbortController qui borne CHAQUE appel HTTP.
const FETCH_TIMEOUT_MS = 8000
const MAX_BYTES = 1_500_000          // cap taille réponse (évite les pages géantes)
const MIN_INTERVAL_MS = 1500         // délai minimal entre deux appels sortants
const MAX_RETRIES = 1                // un retry avec backoff sur 429/5xx/réseau

// Bornes crawl.
const MAX_LEGAL_PAGES = 4            // pages légales fetchées par site (au-delà du home)
const MAX_CANDIDATS = 5             // candidats web vérifiés par SIRET (maillon 1.b)

// Idempotence : TTL 30 j (aligné referentiel-read REFERENTIEL_TTL_DAYS).
const TTL_DAYS = 30

// Maillon 2 — mots-clés d'un lien vers une page légale + chemins conventionnels.
const LEGAL_KEYWORDS = [
  'mentions legales', 'mentions-legales', 'mentions', 'legal', 'cgv', 'cgu',
  'contact', 'qui sommes nous', 'informations legales'
]
const CONVENTIONAL_PATHS = ['/mentions-legales', '/mentions', '/legal', '/cgv', '/contact']

// ---------------------------------------------------------------------------
// File séquentielle mono-verrou (patron overpass.js). Un seul verrou (chaîne de
// promesses) + espacement minimal entre deux appels réseau. Partagée avec le
// module de recherche web via l'export de politeFetchText : jamais de rafale,
// une seule IP sortante.
// ---------------------------------------------------------------------------

let queueTail = Promise.resolve()
let lastCallAt = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function schedule(task) {
  const run = async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastCallAt)
    if (wait > 0) await sleep(wait)
    lastCallAt = Date.now()
    return task()
  }
  const p = queueTail.then(run, run)
  queueTail = p.then(() => {}, () => {})
  return p
}

// Un GET poli et borné. Rend { text, finalUrl } ou null (jamais de throw).
// finalUrl = URL après redirections (pour host / bonus même-domaine).
async function doFetch(url) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    try {
      const r = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: ctrl.signal,
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5'
        }
      })
      clearTimeout(timer)
      if (!r.ok) {
        if ((r.status === 429 || r.status >= 500) && attempt < MAX_RETRIES) {
          await sleep(MIN_INTERVAL_MS * Math.pow(2, attempt + 1))
          continue
        }
        return null
      }
      const ct = r.headers.get('content-type') || ''
      if (ct && !/text\/html|application\/xhtml|text\/plain/i.test(ct)) return null
      let text = await r.text()
      if (text.length > MAX_BYTES) text = text.slice(0, MAX_BYTES)
      return { text, finalUrl: r.url || url }
    } catch (e) {
      clearTimeout(timer)
      // Réseau / timeout / abort : silencieux. Retry borné, sinon « rien ».
      if (attempt < MAX_RETRIES) { await sleep(MIN_INTERVAL_MS * Math.pow(2, attempt + 1)); continue }
      return null
    }
  }
  return null
}

// Sérialise l'appel derrière la file mono-verrou. Exportée pour recherche-web.js.
export function politeFetchText(url) {
  const u = normalizeUrl(url)
  if (!u) return Promise.resolve(null)
  return schedule(() => doFetch(u))
}

// ---------------------------------------------------------------------------
// Helpers URL / HTML.
// ---------------------------------------------------------------------------

// Normalise une URL : ajoute https:// si le schéma manque, rejette non-http(s).
function normalizeUrl(raw) {
  let u = String(raw || '').trim()
  if (!u) return null
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u.replace(/^\/+/, '')
  try {
    const x = new URL(u)
    if (x.protocol !== 'http:' && x.protocol !== 'https:') return null
    return x.toString()
  } catch { return null }
}

function safeHost(url) {
  try { return new URL(url).host } catch { return '' }
}

function safeOrigin(url) {
  try { return new URL(url).origin } catch { return '' }
}

// Absolutise un href relatif contre baseUrl. Restreint AU MÊME HÔTE (évite de
// suivre les liens sortants footer — réseaux sociaux, prestataires).
function absolutize(href, baseUrl) {
  try {
    const u = new URL(href, baseUrl)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (u.host !== new URL(baseUrl).host) return null
    return u.toString()
  } catch { return null }
}

// Décodage minimal des entités (numériques + &nbsp;/&amp;) — capte les emails
// obfusqués « contact&#64;domaine ».
function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(Number(d)) } catch { return m } })
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)) } catch { return m } })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
}

// HTML → texte : retire script/style/balises, compacte les espaces.
function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Maillon 2 — liens footer vers une page légale. Scanne les <a href>… texte …</a>
// et retient ceux dont le libellé OU l'href évoque une page légale. Même hôte only.
function extractLegalLinks(html, baseUrl) {
  const out = new Set()
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  for (const m of html.matchAll(re)) {
    const href = m[1]
    const label = normText(stripTags(m[2]))
    let hrefN = ''
    try { hrefN = normText(decodeURIComponent(href)) } catch { hrefN = normText(href) }
    const hit = LEGAL_KEYWORDS.some(k => {
      const kc = k.replace(/\s+/g, '')
      return label.includes(k) || hrefN.includes(kc) || hrefN.includes(k)
    })
    if (!hit) continue
    const abs = absolutize(href, baseUrl)
    if (abs) out.add(abs)
  }
  return [...out]
}

// ---------------------------------------------------------------------------
// Maillon 3 — extraction. Fonctions pures sur le texte (déjà strippé/décodé).
// ---------------------------------------------------------------------------

// SIRET = 14 chiffres, souvent groupés 3-3-3-5 (séparateurs espace/point/nbsp).
function extractSirets(text) {
  const out = new Set()
  const re = /\b\d{3}[\s. ]?\d{3}[\s. ]?\d{3}[\s. ]?\d{5}\b/g
  for (const m of text.matchAll(re)) {
    const d = m[0].replace(/\D/g, '')
    if (d.length === 14) out.add(d)
  }
  return [...out]
}

// SIREN = 9 chiffres groupés 3-3-3. Les téléphones FR (paires 2-2-2-2-2) ne
// présentent jamais 3 chiffres consécutifs → aucun faux positif de ce côté.
function extractSirens(text) {
  const out = new Set()
  const re = /\b\d{3}[\s. ]?\d{3}[\s. ]?\d{3}\b/g
  for (const m of text.matchAll(re)) {
    const d = m[0].replace(/\D/g, '')
    if (d.length === 9) out.add(d)
  }
  return [...out]
}

// Téléphone FR : 0X XX XX XX XX ou +33 X XX XX XX XX. Exclut les surtaxés 08.
function extractPhones(text) {
  const out = new Set()
  const re = /(?:\+33|0)\s?[1-9](?:[\s.\- ]?\d{2}){4}\b/g
  for (const m of text.matchAll(re)) {
    let d = m[0].replace(/[^\d+]/g, '')
    if (d.startsWith('+33')) d = '0' + d.slice(3)
    d = d.replace(/\D/g, '')
    if (d.length !== 10) continue
    if (d.startsWith('08')) continue       // surtaxé → écarté
    out.add(d)
  }
  return [...out]
}

const EMAIL_RE = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g

// Formes nominatives de service à écarter d'office (jamais des contacts utiles).
const EMAIL_LOCAL_BLACKLIST =
  /^(no-?reply|ne-?pas-?repondre|nepasrepondre|postmaster|webmaster|mailer-daemon|daemon|abuse|hostmaster)$/i

// Domaines d'hébergeurs / prestataires cités en mentions légales : leurs emails
// ne sont PAS le contact de l'entreprise → écartés (suffixe strict).
const HOSTER_DOMAINS = [
  'solocal.com', 'wix.com', 'wixsite.com', 'sitew.com', 'e-monsite.com',
  'pagesjaunes.fr', 'godaddy.com', 'ionos.fr', 'ionos.com', 'ovh.com', 'ovh.net',
  'gandi.net', 'squarespace.com', 'shopify.com', 'wordpress.com', 'jimdo.com',
  '1and1.fr', 'sentry.io', 'sentry-next.wixpress.com'
]

// Email : garde les génériques d'entreprise MÊME hors domaine du site (atelierXX@
// gmail.com sur une page contact TPE = valide). « Même domaine » = bonus (tri),
// pas filtre. Écarte noreply/webmaster/… et les domaines hébergeur/prestataire.
function extractEmails(text) {
  const out = new Set()
  for (const m of text.matchAll(EMAIL_RE)) {
    const email = m[0].toLowerCase()
    const at = email.indexOf('@')
    if (at < 1) continue
    const local = email.slice(0, at)
    const domain = email.slice(at + 1).replace(/^www\./, '')
    if (EMAIL_LOCAL_BLACKLIST.test(local)) continue
    if (/(^|\.)example\.(com|org|net)$/.test(domain)) continue
    if (/\.(png|jpg|jpeg|gif|webp|svg)$/.test(domain)) continue   // faux positifs d'assets
    if (HOSTER_DOMAINS.some(h => domain === h || domain.endsWith('.' + h))) continue
    out.add(email)
  }
  return [...out]
}

// Bonus de confiance : emails du domaine du site en tête (pas un filtre).
function sortEmailsBySiteDomain(emails, siteHost) {
  const host = String(siteHost || '').replace(/^www\./, '')
  if (!host) return emails
  return [...emails].sort((a, b) => {
    const da = a.slice(a.indexOf('@') + 1) === host ? 0 : 1
    const db = b.slice(b.indexOf('@') + 1) === host ? 0 : 1
    return da - db
  })
}

// ---------------------------------------------------------------------------
// Maillon 4 — recoupement scoré contre le faisceau.
//   • SIRET/SIREN trouvé = certain (réutilise corroborerSiret d'overpass.js).
//   • ≥ 2 signaux indépendants parmi {raison_sociale, adresse, dirigeant_nom} = présumé.
//   • 1 seul signal = insuffisant → confidence null (silence, on n'écrit rien).
//   • dirigeant_nom = VALIDATEUR de concordance uniquement (jamais écrit ni exposé).
// ---------------------------------------------------------------------------

// Présence d'un libellé (normalisé) dans le corpus normalisé, longueur minimale
// pour éviter les collisions sur des jetons trop courts/communs.
function presentNorm(corpusNorm, needle, minLen) {
  const n = normText(needle)
  if (n.length < minLen) return false
  return corpusNorm.includes(n)
}

// adresse concorde si (ville ET code postal présents) OU (libellé de voie présent).
function adresseConcorde(f, ex) {
  const villeN = normText(f.ville)
  const villeOk = villeN.length >= 3 && ex.corpusNorm.includes(villeN)
  const cp = String(f.code_postal || '').replace(/\D/g, '')
  const cpOk = cp.length === 5 && new RegExp('\\b' + cp + '\\b').test(ex.corpusRaw)
  const voieN = normText(f.libelle_voie)
  const voieOk = voieN.length >= 4 && ex.corpusNorm.includes(voieN)
  return (villeOk && cpOk) || voieOk
}

function recouper(faisceau, ex) {
  const sirenCible = faisceau.siren || (faisceau.siret ? faisceau.siret.slice(0, 9) : '')
  const siretTrouve =
    (!!sirenCible && ex.sirets.some(s => corroborerSiret({ siret: s }, sirenCible))) ||
    (!!sirenCible && ex.sirens.includes(sirenCible))

  const sig = {
    siret: siretTrouve,
    raison_sociale: presentNorm(ex.corpusNorm, faisceau.raison_sociale, 4),
    adresse: adresseConcorde(faisceau, ex),
    dirigeant_nom: presentNorm(ex.corpusNorm, faisceau.dirigeant_nom, 3)
  }

  let confidence = null
  if (sig.siret) {
    confidence = 'certain'
  } else {
    const n = ['raison_sociale', 'adresse', 'dirigeant_nom'].filter(k => sig[k]).length
    if (n >= 2) confidence = 'presume'
  }
  // signals : liste des CLÉS concordantes (jamais la valeur du dirigeant → RGPD).
  const signals = Object.keys(sig).filter(k => sig[k])
  return { confidence, signals }
}

// ---------------------------------------------------------------------------
// analyserSite(homeUrl, faisceau) — maillons 2→4 sur un site.
// Rend { confidence, signals, emails, phones } (confidence possiblement null si
// le site est joignable mais ne recoupe pas), ou null si le home est injoignable.
// ---------------------------------------------------------------------------

async function analyserSite(homeUrlRaw, faisceau) {
  const homeUrl = normalizeUrl(homeUrlRaw)
  if (!homeUrl) return null

  const home = await politeFetchText(homeUrl)
  if (!home) return null

  const base = home.finalUrl || homeUrl
  const homeHtml = decodeEntities(home.text)

  // Maillon 2 — pages légales : liens footer d'abord, puis chemins conventionnels.
  const legalLinks = extractLegalLinks(homeHtml, base)
  const origin = safeOrigin(base)
  const conventional = origin ? CONVENTIONAL_PATHS.map(p => origin + p) : []
  const pages = [...new Set([...legalLinks, ...conventional])]
    .filter(u => normalizeUrl(u) !== normalizeUrl(base))
    .slice(0, MAX_LEGAL_PAGES)

  // Corpus = home + pages légales (texte strippé/décodé).
  const texts = [stripTags(homeHtml)]
  for (const p of pages) {
    const r = await politeFetchText(p)
    if (r) texts.push(stripTags(decodeEntities(r.text)))
  }
  const corpusRaw = texts.join('  \n  ')
  const corpusNorm = normText(corpusRaw)

  // Maillon 3 — extraction.
  const ex = {
    corpusRaw,
    corpusNorm,
    sirets: extractSirets(corpusRaw),
    sirens: extractSirens(corpusRaw)
  }
  const phones = extractPhones(corpusRaw)
  const emails = sortEmailsBySiteDomain(extractEmails(corpusRaw), safeHost(base))

  // Maillon 4 — recoupement.
  const { confidence, signals } = recouper(faisceau, ex)
  return { confidence, signals, emails, phones }
}

// ---------------------------------------------------------------------------
// Idempotence : lecture du TTL (via faisceau) + marquage à chaque passage.
// ---------------------------------------------------------------------------

function isFresh(ts, days) {
  if (!ts) return false
  const t = new Date(ts).getTime()
  if (!Number.isFinite(t)) return false
  return (Date.now() - t) < days * 24 * 3600 * 1000
}

// UPDATE ciblé (jamais UPSERT) : mentions_legales_checked_at = time::now(). Record
// absent → 0 ligne, no-op. Datetime calculé en SurrealQL (jamais en $body, cf.
// b219bf7). Fire-and-forget, ne throw pas.
async function markChecked(siret) {
  try {
    const id = cleanRecordId('referentiel_societes', String(siret || '').replace(/\s+/g, ''))
    if (!id) return
    const db = await getDb()
    await db.query(
      'UPDATE type::record("referentiel_societes", $id) SET mentions_legales_checked_at = time::now()',
      { id }
    )
  } catch (e) {
    console.warn('[mentions-legales]', String(e?.message || e).slice(0, 80))
  }
}

// ---------------------------------------------------------------------------
// enrichirMentionsLegales(siret) — orchestration d'un SIRET (maillons 1→4).
// Aucun throw remontant. Journalise un audit RGPD par SIRET.
// ---------------------------------------------------------------------------

export async function enrichirMentionsLegales(siret) {
  const s = String(siret || '').replace(/\s+/g, '')
  const result = { siret: s, source: null, confidence: null, signals: [], written: false, skipped: null }
  try {
    if (!s) { result.skipped = 'siret_vide'; return result }

    const faisceau = await getReferentielFaisceauBySiret(s)
    if (!faisceau || !faisceau.siret) { result.skipped = 'hors_referentiel'; return result }

    // Idempotence : SIRET vérifié il y a moins de TTL_DAYS → on saute (pas de marquage).
    if (isFresh(faisceau.mentions_legales_checked_at, TTL_DAYS)) { result.skipped = 'ttl'; return result }

    let analyse = null
    let sourceUrl = null

    // Maillon 1.a — URL déjà en base.
    if (faisceau.website) {
      const a = await analyserSite(faisceau.website, faisceau)
      if (a && a.confidence) { analyse = a; sourceUrl = normalizeUrl(faisceau.website); result.source = 'base' }
    }

    // Maillon 1.b — recherche web si rien de concluant en base. On vérifie CHAQUE
    // candidat au maillon 4 (jamais confiance au rang) ; 1er qui recoupe = retenu.
    if (!analyse) {
      const candidats = await rechercherUrlSociete({
        raison_sociale: faisceau.raison_sociale,
        ville: faisceau.ville,
        dirigeant_nom: faisceau.dirigeant_nom
      })
      const liste = Array.isArray(candidats) ? candidats.slice(0, MAX_CANDIDATS) : []
      for (const url of liste) {
        const a = await analyserSite(url, faisceau)
        if (a && a.confidence) { analyse = a; sourceUrl = normalizeUrl(url); result.source = 'web'; break }
      }
    }

    // Écriture additive (fill-if-empty, liste blanche website/societe_email/societe_tel).
    // Un seul champ corroboré suffit ; jamais societe_linkedin.
    if (analyse && analyse.confidence) {
      result.confidence = analyse.confidence
      result.signals = analyse.signals
      const fields = {}
      if (sourceUrl) fields.website = sourceUrl
      if (analyse.emails.length) fields.societe_email = analyse.emails[0]
      if (analyse.phones.length) fields.societe_tel = analyse.phones[0]
      if (Object.keys(fields).length) {
        await enrichReferentielActionnable(s, fields)
        result.written = true
      }
    }
  } catch (e) {
    console.warn('[mentions-legales]', String(e?.message || e).slice(0, 100))
  } finally {
    // Marqué à CHAQUE passage réel (trouvé ou non). Pas de marquage si skip amont
    // (siret vide / hors référentiel / déjà frais < TTL).
    if (result.skipped == null) await markChecked(s)
  }

  // Audit RGPD par SIRET : source, confidence, signaux (clés, jamais de valeur PII), horodatage.
  console.log('[mentions-legales-audit]', JSON.stringify({
    siret: s,
    source: result.source,
    confidence: result.confidence,
    signals: result.signals,
    written: result.written,
    skipped: result.skipped,
    at: new Date().toISOString()
  }))

  return result
}

// ---------------------------------------------------------------------------
// runMentionsLegalesJob(sirets) — traitement d'un lot, séquentiel (la file
// mono-verrou sérialise déjà le réseau). Aucun throw remontant.
// ---------------------------------------------------------------------------

export async function runMentionsLegalesJob(sirets) {
  try {
    const list = Array.isArray(sirets)
      ? sirets.map(x => String(x || '').replace(/\s+/g, '')).filter(Boolean)
      : []
    if (list.length === 0) return

    let traites = 0, sautes = 0, certains = 0, presumes = 0, ecrits = 0
    for (const siret of list) {
      const r = await enrichirMentionsLegales(siret)
      if (r?.skipped != null) { sautes++; continue }
      traites++
      if (r?.confidence === 'certain') certains++
      else if (r?.confidence === 'presume') presumes++
      if (r?.written) ecrits++
    }

    console.log(
      `[mentions-legales] lot=${list.length} traités=${traites} sautés=${sautes} ` +
      `certains=${certains} présumés=${presumes} écrits=${ecrits}`
    )
  } catch (e) {
    console.error('[mentions-legales]', String(e?.message || e).slice(0, 120))
  }
}
