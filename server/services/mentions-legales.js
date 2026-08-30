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
import { getReferentielFaisceauBySiret, getOsmSitesBySiret } from './referentiel-read.js'
import { normaliserDomaine } from './rapprochement-osm.js'
import { normText, corroborerSiret } from './overpass.js'
import { normaliserVoie, parserAdresseAgregee, canoniserTexteVoie } from '../../lib/societes.js'
import { rechercherUrlSociete } from './recherche-web.js'
import { parserRobots, evaluerRobots } from './robots-txt.js'

// Overpass/serveurs tiers refusent souvent les requêtes sans User-Agent explicite.
const USER_AGENT = 'MovUP/1.0 (+https://movup.fr)'

// Bornes réseau. Le [timeout] Overpass QL ne s'applique PAS aux sites tiers :
// c'est l'AbortController qui borne CHAQUE appel HTTP.
const FETCH_TIMEOUT_MS = 8000
const MAX_BYTES = 1_500_000          // cap taille réponse (évite les pages géantes)
const MIN_INTERVAL_MS = 1500         // délai minimal entre deux appels sortants
const MAX_RETRIES = 1                // un retry avec backoff sur 429/5xx/réseau

// Bornes robots.txt (RFC 9309). Fetch DÉDIÉ, distinct de doFetch : court, plafonné,
// sans retry — un robots.txt injoignable ne doit pas monopoliser la file.
const ROBOTS_TIMEOUT_MS = 3000       // timeout court propre au robots.txt
const ROBOTS_MAX_BYTES = 500_000     // 500 Ko, plafond RFC 9309 §2.5
const ROBOTS_TTL_MS = 24 * 3600 * 1000   // TTL cache par hôte : 24 h
const ROBOTS_CACHE_MAX = 500         // plafond d'entrées, éviction de la plus ancienne
const ROBOTS_UA_TOKEN = 'MovUP'      // product token seul (jamais l'User-Agent réseau complet)
// Plafond de crawl-delay honoré. La file est GLOBALE (une seule pour tout le sortant),
// pas par hôte : honorer un délai ralentit TOUT le sortant, pas seulement l'hôte qui le
// réclame. Donc — délai ≤ MIN_INTERVAL_MS : sans effet (l'espacement courant suffit) ;
// entre MIN_INTERVAL_MS et ce plafond : honoré, en dormant le complément avant l'appel
// vers cet hôte ; au-delà : l'hôte est REFUSÉ (pas ralenti), refus mis en cache comme
// les autres. On ne paie jamais plus de ce plafond au nom d'un seul site.
const ROBOTS_CRAWL_DELAY_MAX_MS = 5000

// Bornes crawl.
const MAX_LEGAL_PAGES = 4            // pages légales fetchées par site (au-delà du home)
const MAX_CANDIDATS = 5             // candidats web vérifiés par SIRET (maillon 1.b)

// Idempotence : TTL 30 j (aligné referentiel-read REFERENTIEL_TTL_DAYS).
const TTL_DAYS = 30

// Maillon 2 — mots-clés d'un lien vers une page utile + chemins conventionnels.
// Les zones lues sont l'accueil (pied de page compris : stripTags prend la page
// entière), la page de contact, la page « à propos » et les pages légales. Le
// courriel se lit plus souvent sur la page de contact que sur les mentions légales,
// d'où l'ordre : /contact vient en tête des chemins devinés.
const LEGAL_KEYWORDS = [
  'contact', 'nous contacter', 'contactez nous',
  'a propos', 'about', 'qui sommes nous',
  'mentions legales', 'mentions-legales', 'mentions', 'legal', 'cgv', 'cgu',
  'informations legales'
]
const CONVENTIONAL_PATHS = [
  '/contact', '/nous-contacter', '/a-propos',
  '/mentions-legales', '/mentions', '/legal', '/cgv'
]

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

// Valeurs par défaut du GET poli — CELLES DE TOUJOURS. Tout appelant qui ne passe
// pas d'option retrouve exactement le comportement d'avant l'ajout des options :
// en-tête Accept orienté page web, et filtre de content-type qui n'accepte que du
// HTML/texte. Un appelant qui vise un autre type (flux XML) les remplace toutes deux.
const ACCEPT_DEFAUT = 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5'
const CONTENT_TYPE_RE_DEFAUT = /text\/html|application\/xhtml|text\/plain/i

// Un GET poli et borné. Rend { text, finalUrl } ou null (jamais de throw).
// finalUrl = URL après redirections (pour host / bonus même-domaine).
async function doFetch(url, accept, contentTypeRe) {
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
          'Accept': accept
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
      if (ct && !contentTypeRe.test(ct)) return null
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

// ---------------------------------------------------------------------------
// Portillon robots.txt (RFC 9309). Cache par hôte, fetch dédié passant par la MÊME
// file mono-verrou (jamais en dehors, sous peine de rafale). Un refus = return null,
// signal identique aux échecs réseau existants — aucun throw, aucun marquage en base.
// ---------------------------------------------------------------------------

// Cache par hôte. Clé = origin (schéma://hôte:port). Valeur =
//   { etat: 'REGLES' | 'TOUT_PERMIS' | 'REFUS', parsed, crawlDelaySec, expiresAt }.
// Les échecs sont cachés eux aussi : sinon chaque URL d'un hôte re-taperait robots.txt.
const robotsCache = new Map()
const robotsInflight = new Map()     // dédup des résolutions concurrentes d'un même hôte

function robotsCacheGet(origin) {
  const e = robotsCache.get(origin)
  if (!e) return null
  if (e.expiresAt <= Date.now()) { robotsCache.delete(origin); return null }
  return e
}

function robotsCacheSet(origin, entry) {
  // Ré-insertion en queue (Map = ordre d'insertion) puis éviction de la plus ancienne.
  if (robotsCache.has(origin)) robotsCache.delete(origin)
  else if (robotsCache.size >= ROBOTS_CACHE_MAX) {
    const oldest = robotsCache.keys().next().value
    if (oldest !== undefined) robotsCache.delete(oldest)
  }
  robotsCache.set(origin, entry)
}

// Fetch robots.txt DÉDIÉ, distinct de doFetch : timeout court, plafond de taille propre,
// AUCUN retry, même USER_AGENT. Rend { status, text } ; status 0 = réseau/timeout/DNS.
async function fetchRobots(robotsUrl) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ROBOTS_TIMEOUT_MS)
  try {
    const r = await fetch(robotsUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/plain,*/*;q=0.5' }
    })
    clearTimeout(timer)
    if (r.status >= 200 && r.status < 300) {
      let text = await r.text()
      if (text.length > ROBOTS_MAX_BYTES) text = text.slice(0, ROBOTS_MAX_BYTES)
      return { status: r.status, text }
    }
    return { status: r.status, text: '' }
  } catch {
    clearTimeout(timer)
    return { status: 0, text: '' }   // réseau / timeout / abort / DNS → FAIL-CLOSED
  }
}

// Réponse HTTP → entrée de cache. Statuts (brief) :
//   2xx → parserRobots ; 4xx (dont 404/410) → TOUT_PERMIS ; 5xx, timeout, réseau, DNS
//   (status 0) → FAIL-CLOSED = REFUS. Crawl-delay réclamé au-delà du plafond → REFUS.
function entryDepuisReponse(res) {
  const expiresAt = Date.now() + ROBOTS_TTL_MS
  const st = res.status
  if (st >= 200 && st < 300) {
    const parsed = parserRobots(res.text)
    // crawl-delay indépendant du chemin (propre au groupe UA) → évalué une fois.
    const { crawlDelaySec } = evaluerRobots(parsed, '/', ROBOTS_UA_TOKEN)
    if (crawlDelaySec != null && crawlDelaySec * 1000 > ROBOTS_CRAWL_DELAY_MAX_MS) {
      return { etat: 'REFUS', parsed: null, crawlDelaySec, expiresAt }
    }
    return { etat: 'REGLES', parsed, crawlDelaySec, expiresAt }
  }
  if (st >= 400 && st < 500) {
    return { etat: 'TOUT_PERMIS', parsed: null, crawlDelaySec: null, expiresAt }
  }
  return { etat: 'REFUS', parsed: null, crawlDelaySec: null, expiresAt }
}

// Charge (ou récupère en vol) le robots d'un hôte, met en cache, journalise. Le fetch
// passe OBLIGATOIREMENT par schedule(...) : même verrou mono-file que tout le sortant.
function chargerRobots(origin) {
  const enCours = robotsInflight.get(origin)
  if (enCours) return enCours
  const p = (async () => {
    const res = await schedule(() => fetchRobots(origin + '/robots.txt'))
    const entry = entryDepuisReponse(res)
    robotsCacheSet(origin, entry)
    console.log('[robots]', 'hôte résolu', origin, entry.etat,
      entry.crawlDelaySec != null ? `crawl-delay=${entry.crawlDelaySec}s` : '')
    return entry
  })()
  robotsInflight.set(origin, p)
  // Dérivée du finally neutralisée en rejet (patron de queueTail ligne ~87) : aucune
  // promesse dérivée ne doit pouvoir rejeter sans gestionnaire.
  p.finally(() => { if (robotsInflight.get(origin) === p) robotsInflight.delete(origin) })
    .then(() => {}, () => {})
  return p
}

// Chemin (pathname + query) mis en correspondance par robots.txt.
function cheminDe(url) {
  try { const u = new URL(url); return (u.pathname || '/') + (u.search || '') } catch { return '/' }
}

// Décision par état de cache. Product token seul (ROBOTS_UA_TOKEN).
function deciderDepuisEntry(entry, chemin) {
  if (entry.etat === 'TOUT_PERMIS') return { autorise: true, crawlDelaySec: null }
  if (entry.etat === 'REFUS') return { autorise: false, crawlDelaySec: entry.crawlDelaySec }
  const { autorise } = evaluerRobots(entry.parsed, chemin, ROBOTS_UA_TOKEN)
  return { autorise, crawlDelaySec: entry.crawlDelaySec }
}

// Portillon : { autorise, crawlDelaySec } pour une URL. Résout via cache/hôte.
async function resolveRobots(url) {
  const origin = safeOrigin(url)
  // origin inexploitable → refus (fail-closed). Inatteignable en pratique (normalizeUrl
  // a déjà validé le schéma en amont) ; la garde existe pour que le code dise partout
  // la même chose : ignorer les règles se résout toujours par le refus.
  if (!origin) return { autorise: false, crawlDelaySec: null }
  const entry = robotsCacheGet(origin) || await chargerRobots(origin)
  return deciderDepuisEntry(entry, cheminDe(url))
}

// Complément de crawl-delay à dormir AVANT l'appel vers l'hôte, en sus de l'espacement
// mono-file déjà garanti (MIN_INTERVAL_MS). En deçà du plancher : 0 (sans effet). Le
// dépassement du plafond est déjà traité en amont (REFUS), donc borné ici de fait.
function complementCrawl(crawlDelaySec) {
  const cdMs = (crawlDelaySec != null) ? crawlDelaySec * 1000 : 0
  return cdMs > MIN_INTERVAL_MS ? cdMs - MIN_INTERVAL_MS : 0
}

// Sérialise l'appel derrière la file mono-verrou. Exportée pour recherche-web.js et
// actualites.js. Passe d'abord le portillon robots.txt de l'hôte (résolution + cache
// par hôte). Refus robots → null, exactement comme un échec réseau.
//
// options (toutes facultatives, défauts = comportement historique à l'identique) :
//   • accept        — valeur de l'en-tête Accept (défaut : ACCEPT_DEFAUT).
//   • contentTypeRe — filtre appliqué au content-type de la réponse (défaut :
//     CONTENT_TYPE_RE_DEFAUT). RegExp SANS drapeau /g : .test sur une regex globale
//     est apatride entre appels seulement si lastIndex n'est jamais avancé.
//
// Ce qui n'est PAS paramétrable, et reste donc commun à tous les appelants : le verrou
// mono-file, le portillon robots, le timeout, le plafond de taille et les reprises.
// Un appelant ne peut ni doubler la file ni s'exonérer du robots.txt.
export async function politeFetchText(url, options = {}) {
  const { res } = await lireAvecMotif(url, options)
  return res
}

// Voie interne de politeFetchText, INTERNE AU MODULE (jamais exportée) : même travail,
// mais le motif du non-résultat est conservé. Rend { res, motif } :
//   • { res: {text, finalUrl}, motif: null }  — lecture faite.
//   • { res: null, motif: 'url' }             — URL inexploitable, aucun appel émis.
//   • { res: null, motif: 'portillon' }       — robots.txt a refusé (avant ou après
//     redirection). Une DÉCISION du site : rien ne doit permettre de la contourner.
//   • { res: null, motif: 'fetch' }           — l'appel a eu lieu et n'a rien rendu
//     (délai dépassé, hôte mort, statut d'erreur, content-type inattendu).
//
// Cette distinction ne remonte PAS jusqu'aux appelants externes (actualites.js,
// recherche-web.js, scripts de diagnostic) : politeFetchText garde son contrat, deux
// sorties, { text, finalUrl } ou null. Séparer refus et injoignable jusqu'au portillon
// lui-même — quatre causes aujourd'hui confondues en 'REFUS' — est un autre chantier.
async function lireAvecMotif(url, options = {}) {
  const accept = options.accept || ACCEPT_DEFAUT
  const contentTypeRe = options.contentTypeRe || CONTENT_TYPE_RE_DEFAUT

  const u = normalizeUrl(url)
  if (!u) return { res: null, motif: 'url' }

  // Ceinture : la garantie « aucun throw » doit être structurelle. Une levée interne
  // = on ignore ce que dit le robots.txt → même issue qu'un 5xx/timeout : fail-closed.
  let gate
  try {
    gate = await resolveRobots(u)
  } catch (e) {
    console.log('[robots]', 'refus (exception résolution)', u, String(e?.message || e).slice(0, 80))
    return { res: null, motif: 'portillon' }
  }
  if (!gate.autorise) { console.log('[robots]', 'refus', u); return { res: null, motif: 'portillon' } }

  // Fetch principal. Le complément de crawl-delay est dormi DANS la tâche schedulée,
  // donc SOUS le verrou : il espace réellement l'appel vers cet hôte, sans le sortir
  // de la file mono-verrou.
  const complement = complementCrawl(gate.crawlDelaySec)
  const res = await schedule(async () => {
    if (complement > 0) await sleep(complement)
    return doFetch(u, accept, contentTypeRe)
  })
  if (!res) return { res: null, motif: 'fetch' }

  // Point (b) — redirection inter-hôtes. redirect:'follow' a pu mener vers un autre
  // hôte (example.com et www.example.com sont deux hôtes distincts au sens robots.txt,
  // cas fréquent). On re-vérifie le robots de l'hôte d'ARRIVÉE sur le chemin final.
  // LIMITE ASSUMÉE : la requête vers l'hôte d'arrivée a DÉJÀ eu lieu quand on découvre
  // son refus — on écarte le contenu, on n'annule pas l'appel. L'empêcher supposerait
  // redirect:'manual' et un contrôle à chaque saut, ce qui referait doFetch et son
  // backoff ; le rapport coût-bénéfice ne le justifie pas, l'appel étant unique par
  // hôte et jamais répété (refus ensuite en cache).
  if (safeHost(res.finalUrl) !== safeHost(u)) {
    let gate2
    try {
      gate2 = await resolveRobots(res.finalUrl)
    } catch (e) {
      console.log('[robots]', 'refus après redirection (exception résolution)', res.finalUrl, String(e?.message || e).slice(0, 80))
      return { res: null, motif: 'portillon' }
    }
    if (!gate2.autorise) {
      console.log('[robots]', 'refus après redirection', res.finalUrl)
      return { res: null, motif: 'portillon' }
    }
  }

  return { res, motif: null }
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

// Le schéma manquait-il ? Prédicat pur, jumeau de la première ligne de normalizeUrl :
// vrai quand c'est NOUS qui avons ajouté https, faux quand la donnée le portait déjà.
// Volontairement à côté de normalizeUrl et non dans son retour : celle-ci sert aussi à
// COMPARER des URL (candidats vs accueil, URL écrite au référentiel) — changer son type
// de retour toucherait ces trois usages sans rien leur apporter.
function schemaAjoute(raw) {
  const u = String(raw || '').trim()
  return u !== '' && !/^https?:\/\//i.test(u)
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

// Nature d'une page candidate : 'contact' ou 'mentions'. Décidée sur le CHEMIN
// (le libellé du lien n'est plus disponible ici) : « contact », « nous-contacter »,
// « contactez-nous » → contact ; tout le reste, page « à propos » comprise →
// mentions. normText réduit à [a-z0-9 ], donc la recherche de « contact » capte
// les trois formes. Deux natures suffisent : une troisième prendrait une place de
// plus dans un budget qui n'augmente pas.
function naturePage(url) {
  let chemin = ''
  try {
    const u = new URL(url)
    chemin = decodeURIComponent((u.pathname || '') + (u.search || ''))
  } catch { chemin = String(url || '') }
  return normText(chemin).includes('contact') ? 'contact' : 'mentions'
}

// Répartition du budget de pages légales, À BUDGET CONSTANT (MAX_LEGAL_PAGES : il
// coûte de la file — un appel sortant sérialisé chacun).
//
// Avant : liens de l'accueil PUIS chemins devinés, tronqué sec. Un accueil offrant
// quatre liens « mentions / legal / cgv / cgu » saturait le budget et /contact ne
// sortait JAMAIS. Or le courriel est tantôt sur la page de mentions légales, tantôt
// sur la page de contact — écarter l'une des deux natures, c'est rater la moitié
// des sites.
//
// Maintenant : une place est RÉSERVÉE par nature — au moins une page de contact et
// au moins une page de mentions légales —, le reste au premier arrivé dans l'ordre
// d'origine. La réserve décide QUI est retenu, jamais dans quel ordre : le parcours
// reste celui d'origine (liens du site d'abord, chemins devinés ensuite).
//
// Le contact est servi AVANT les mentions légales : à budget saturé, c'est lui qui
// rend le plus de courriels. Exportée (pure, sans effet de bord) pour vérification
// hors-base.
export function repartirPages(candidats, budget) {
  const liste = Array.isArray(candidats) ? candidats : []
  if (budget <= 0) return []
  if (liste.length <= budget) return [...liste]
  const retenus = new Set()
  for (const nature of ['contact', 'mentions']) {
    if (retenus.size >= budget) break
    const premier = liste.find(u => !retenus.has(u) && naturePage(u) === nature)
    if (premier) retenus.add(premier)
  }
  for (const u of liste) {
    if (retenus.size >= budget) break
    retenus.add(u)
  }
  return liste.filter(u => retenus.has(u))
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
//   • ≥ 2 signaux indépendants parmi {raison_sociale, adresse, dirigeant_nom} = présumé,
//     ramenés à 1 seul quand l'URL visitée est ATTESTÉE PAR IDENTIFIANT (cf. infra).
//   • en deçà du seuil = insuffisant → confidence null (silence, on n'écrit rien).
//   • dirigeant_nom = VALIDATEUR de concordance uniquement (jamais écrit ni exposé).
// ---------------------------------------------------------------------------

// Seuils de signaux de PAGE requis pour « présumé », selon la provenance de l'URL.
//
// URL SUPPOSÉE (composée, cherchée sur le web, ou héritée d'une étiquette dont rien
// ne garantit qu'elle vise CET établissement) : deux signaux, comme toujours.
//
// URL ATTESTÉE PAR IDENTIFIANT — une entité referentiel_osm portant le MÊME SIRET que
// la fiche ET le même domaine que l'URL visitée : un seul signal suffit. Ce n'est PAS
// compter le SIRET d'OpenStreetMap comme un signal de plus, ce qui serait circulaire
// puisque c'est lui qui a fait venir jusqu'à cette page. C'est reconnaître que la
// PRÉSOMPTION D'ARRIVÉE n'est pas la même selon que l'adresse a été DEVINÉE ou
// ATTESTÉE PAR DEUX SOURCES INDÉPENDANTES sur le même identifiant — OpenStreetMap et
// Etalab, appariées par le SIRET. Le doute résiduel ne porte plus sur « est-ce le bon
// site ? » mais sur « la page dit-elle quelque chose de l'entreprise ? ».
//
// LE PLANCHER EST FERME : JAMAIS ZÉRO. Zéro signal ne veut pas dire « lu et accepté »,
// il veut dire « rien n'a été lu » — page vide, page inatteignable, page qui ne parle
// de personne. Et il protège du site de GROUPE hérité d'une étiquette approximative
// (vincentcoiffure.fr, loeilenscene.fr) : le domaine y est bien celui de l'étiquette,
// mais la page ne nomme ni l'établissement, ni son adresse, ni son dirigeant — elle
// reste donc sans verdict.
const SEUIL_PRESUME = 2
const SEUIL_PRESUME_ATTESTE = 1

// Présence d'un libellé (normalisé) dans le corpus normalisé, longueur minimale
// pour éviter les collisions sur des jetons trop courts/communs.
function presentNorm(corpusNorm, needle, minLen) {
  const n = normText(needle)
  if (n.length < minLen) return false
  return corpusNorm.includes(n)
}

// Voie ATTENDUE d'une fiche : { numero, voie } sous forme canonique. D'abord les
// champs éclatés (numero_voie / type_voie / libelle_voie) ; s'ils sont vides — cas
// SYSTÉMATIQUE côté Etalab, qui ne les peuple jamais —, repli sur l'agrégat
// `adresse` parsé. Sans ce repli, la voie attendue restait vide et la branche
// « libellé de voie » d'adresseConcorde était MORTE : elle ne pouvait jamais
// concorder. Même repli, même parseur que sonderAdresse (rapprochement-osm.js).
function voieAttendue(f) {
  const voie = normaliserVoie(f.type_voie, f.libelle_voie)
  if (voie) return { numero: (String(f.numero_voie || '').match(/\d+/) || [''])[0], voie }
  return parserAdresseAgregee(f.adresse)
}

// La voie de la fiche est-elle CITÉE dans le corpus ? Comparaison de JETONS, pas de
// chaînes : les deux côtés passent par la MÊME canonisation (lib/societes.js), qui
// retire accents, ponctuation et articles, et ramène les types de voie abrégés à
// leur forme pleine — « 8 r. des Boucheries » et « 8 RUE DES BOUCHERIES » deviennent
// tous deux « 8 rue boucheries », « 3 RTE DE PARIS » et « 3 route de Paris » tous
// deux « 3 route paris ». Une page qui écrit l'adresse autrement que l'INSEE cesse
// donc de faire échouer la concordance pour une seule abréviation.
//
// Deux formes acceptées, dans cet ordre de force :
//   • « <numéro> <voie> » — la plus sûre : le numéro colle la citation à CETTE
//     adresse et non à la rue en général.
//   • « <voie> » seule, à condition d'au moins DEUX jetons (type + nom propre) —
//     les pieds de page qui omettent le numéro restent lisibles, mais un libellé
//     réduit à un seul jeton (« quai », « gare ») happerait n'importe quelle page.
// Corollaire assumé de la tolérance aux abréviations : une poignée de clés sont
// aussi des mots français courants (« pas » → passage, « car » → carrefour). Le
// risque de faux positif qu'elles ouvrent est borné par ces deux formes — il faut
// que le mot courant soit suivi EXACTEMENT du nom propre de la voie attendue.
function voieCitee(f, ex) {
  const { numero, voie } = voieAttendue(f)
  if (voie.length < 4) return false
  const jetons = voie.split(' ')
  if (!numero && jetons.length < 2) return false
  const corpus = ' ' + canoniserTexteVoie(ex.corpusRaw) + ' '
  if (numero && corpus.includes(' ' + numero + ' ' + voie + ' ')) return true
  return jetons.length >= 2 && corpus.includes(' ' + voie + ' ')
}

// adresse concorde si (ville ET code postal présents) OU (voie de la fiche citée).
// Exportée (pure, sans I/O ni base) pour vérification hors-base, comme repartirPages.
export function adresseConcorde(f, ex) {
  const villeN = normText(f.ville)
  const villeOk = villeN.length >= 3 && ex.corpusNorm.includes(villeN)
  const cp = String(f.code_postal || '').replace(/\D/g, '')
  const cpOk = cp.length === 5 && new RegExp('\\b' + cp + '\\b').test(ex.corpusRaw)
  return (villeOk && cpOk) || voieCitee(f, ex)
}

function recouper(faisceau, ex, attestee) {
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
    // Math.max(1, …) : le plancher est écrit ici, structurellement, et non déduit de
    // la valeur des constantes. Aucune provenance, jamais, ne descend à zéro signal.
    const seuil = Math.max(1, attestee ? SEUIL_PRESUME_ATTESTE : SEUIL_PRESUME)
    if (n >= seuil) confidence = 'presume'
  }
  // signals : liste des CLÉS concordantes (jamais la valeur du dirigeant → RGPD).
  const signals = Object.keys(sig).filter(k => sig[k])
  return { confidence, signals }
}

// ---------------------------------------------------------------------------
// analyserSite(homeUrl, faisceau, options) — maillons 2→4 sur un site.
// Rend { confidence, signals, emails, phones } (confidence possiblement null si
// le site est joignable mais ne recoupe pas), ou null si le home est injoignable.
// Exportée pour diagnostic : elle ne touche JAMAIS la base (crawl + extraction +
// recoupement en mémoire), l'écriture reste le seul fait d'enrichirMentionsLegales.
//
// options.attestee — l'URL est attestée par identifiant (cf. SEUIL_PRESUME_ATTESTE) :
// un seul signal de page suffit alors pour « présumé ». ABSENTE PAR DÉFAUT : sans
// options, le seuil reste à deux, à l'identique d'avant.
// ---------------------------------------------------------------------------

export async function analyserSite(homeUrlRaw, faisceau, options = {}) {
  const attestee = options.attestee === true
  const homeUrl = normalizeUrl(homeUrlRaw)
  if (!homeUrl) return null

  // Accueil, avec repli sur le protocole non sécurisé. normalizeUrl ajoute https quand
  // le schéma manque ; une part des sites ne répond qu'en http et restait donc muette.
  // DEUX conditions, cumulatives :
  //   • c'est nous qui avons ajouté https — une URL qui portait https explicitement est
  //     lue telle qu'elle est écrite, jamais dégradée dans notre dos ;
  //   • l'échec vient du FETCH, jamais du portillon — retenter en http un hôte dont le
  //     robots.txt a refusé serait contourner ce refus par changement de schéma.
  // La seconde tentative passe par la même file mono-verrou et le même portillon : elle
  // est comptée dans les plafonds comme n'importe quel autre appel sortant.
  let lecture = await lireAvecMotif(homeUrl)
  let urlLue = homeUrl
  if (!lecture.res && lecture.motif === 'fetch' && schemaAjoute(homeUrlRaw)) {
    urlLue = homeUrl.replace(/^https:\/\//i, 'http://')
    lecture = await lireAvecMotif(urlLue)
  }
  const home = lecture.res
  if (!home) return null

  const base = home.finalUrl || urlLue
  const homeHtml = decodeEntities(home.text)

  // Maillon 2 — pages à lire au-delà de l'accueil : liens du site d'abord, puis
  // chemins conventionnels. Contact, à propos et pages légales, plafond inchangé.
  const legalLinks = extractLegalLinks(homeHtml, base)
  const origin = safeOrigin(base)
  const conventional = origin ? CONVENTIONAL_PATHS.map(p => origin + p) : []
  const candidats = [...new Set([...legalLinks, ...conventional])]
    .filter(u => normalizeUrl(u) !== normalizeUrl(base))
  // Budget inchangé, répartition garantie : au moins une page de chaque nature.
  const pages = repartirPages(candidats, MAX_LEGAL_PAGES)

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
  const { confidence, signals } = recouper(faisceau, ex, attestee)
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
//
// Poser cet horodatage rend la fiche inerte trente jours : il ne se pose donc QUE
// si une visite a réellement eu lieu. L'appelant décide (cf. le finally de
// enrichirMentionsLegales) ; cette fonction, elle, ne connaît rien du résultat.
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
// enrichirMentionsLegales(siret, options) — orchestration d'un SIRET (maillons 1→4).
// Aucun throw remontant. Journalise un audit RGPD par SIRET.
//
// options (toutes facultatives ; SANS options = comportement historique à
// l'octet près, c'est ainsi que la passe de fond appelle) :
//   • forcerTtl       — contourne la garde d'idempotence des 30 jours. Pour un
//     appel à la demande, déclenché par un humain qui regarde une fiche : le TTL
//     protège la passe de fond du re-crawl en masse, il n'a pas à faire écran à
//     une demande unitaire.
//   • sansRechercheWeb — saute le maillon 1.b (recherche web). Inutile quand le
//     site est déjà en base : 1.a a déjà de quoi travailler, et 1.b coûterait
//     jusqu'à MAX_CANDIDATS sites de plus dans la file.
// ---------------------------------------------------------------------------

export async function enrichirMentionsLegales(siret, options = {}) {
  const forcerTtl = options.forcerTtl === true
  const sansRechercheWeb = options.sansRechercheWeb === true
  const s = String(siret || '').replace(/\s+/g, '')
  const result = { siret: s, source: null, confidence: null, signals: [], attestee: false, written: false, skipped: null }
  // Frontière de passage, lue par le finally. analyserSite la porte déjà dans son
  // type de retour : null = on n'a pas pu visiter (refus du portillon, délai
  // dépassé, hôte mort) ; objet = le site a répondu, corroboration ou non. On
  // compte donc les URL TENTÉES et les visites ABOUTIES, jamais les résultats.
  let urlsTentees = 0
  let visiteAboutie = false
  try {
    if (!s) { result.skipped = 'siret_vide'; return result }

    const faisceau = await getReferentielFaisceauBySiret(s)
    if (!faisceau || !faisceau.siret) { result.skipped = 'hors_referentiel'; return result }

    // Idempotence : SIRET vérifié il y a moins de TTL_DAYS → on saute (pas de marquage).
    // forcerTtl passe outre — appel unitaire à la demande, cf. en-tête.
    if (!forcerTtl && isFresh(faisceau.mentions_legales_checked_at, TTL_DAYS)) { result.skipped = 'ttl'; return result }

    let analyse = null
    let sourceUrl = null

    // Attestation par identifiant — UNE requête indexée par SIRET, et seulement si
    // une URL est effectivement visitée (mémoïsée : le Set, même vide, est vérité).
    // Le résultat vaut pour toutes les URL du SIRET : c'est le DOMAINE qui décide.
    let domainesOsm = null
    const estAttestee = async (url) => {
      const d = normaliserDomaine(url)
      if (!d) return false
      if (!domainesOsm) {
        const sites = await getOsmSitesBySiret(faisceau.siret)
        domainesOsm = new Set(sites.map(normaliserDomaine).filter(Boolean))
      }
      return domainesOsm.has(d)
    }

    // Maillon 1.a — URL déjà en base.
    if (faisceau.website) {
      const attestee = await estAttestee(faisceau.website)
      urlsTentees++
      const a = await analyserSite(faisceau.website, faisceau, { attestee })
      if (a) visiteAboutie = true
      if (a && a.confidence) {
        analyse = a
        sourceUrl = normalizeUrl(faisceau.website)
        result.source = 'base'
        result.attestee = attestee
      }
    }

    // Maillon 1.b — recherche web si rien de concluant en base. On vérifie CHAQUE
    // candidat au maillon 4 (jamais confiance au rang) ; 1er qui recoupe = retenu.
    // sansRechercheWeb saute le maillon entier : l'appelant sait déjà quel site lire.
    if (!analyse && !sansRechercheWeb) {
      const candidats = await rechercherUrlSociete({
        raison_sociale: faisceau.raison_sociale,
        ville: faisceau.ville,
        dirigeant_nom: faisceau.dirigeant_nom
      })
      const liste = Array.isArray(candidats) ? candidats.slice(0, MAX_CANDIDATS) : []
      for (const url of liste) {
        // Même test qu'en 1.a : ce qui atteste, c'est la CONCORDANCE DE DOMAINE avec
        // une entité OSM du même SIRET, jamais le maillon par lequel l'URL est venue.
        // Une URL devinée ou composée ne la rencontre pas, et reste à deux signaux.
        const attestee = await estAttestee(url)
        urlsTentees++
        const a = await analyserSite(url, faisceau, { attestee })
        // Un seul candidat qui répond suffit à établir le passage : on a bien visité
        // le SIRET, même si aucun des cinq ne corrobore. Le TTL est alors mérité.
        if (a) visiteAboutie = true
        if (a && a.confidence) {
          analyse = a
          sourceUrl = normalizeUrl(url)
          result.source = 'web'
          result.attestee = attestee
          break
        }
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
    // Non-passage AVAL, symétrique des trois gardes amont : aucune visite n'a abouti.
    //   • sans_url    — pas une seule URL à tenter (ni base, ni recherche web).
    //   • injoignable — des URL tentées, aucune n'a répondu (refus du portillon,
    //     délai dépassé, hôte mort). Un site joignable qui ne corrobore pas N'EST
    //     PAS ici : c'est un vrai résultat négatif, il mérite ses 30 jours.
    if (result.skipped == null && !visiteAboutie) {
      result.skipped = urlsTentees > 0 ? 'injoignable' : 'sans_url'
    }
    // Marqué à CHAQUE passage réel (trouvé ou non). Pas de marquage si skip amont
    // (siret vide / hors référentiel / déjà frais < TTL) ni si skip aval ci-dessus.
    if (result.skipped == null) await markChecked(s)
  }

  // Audit RGPD par SIRET : source, confidence, signaux (clés, jamais de valeur PII), horodatage.
  console.log('[mentions-legales-audit]', JSON.stringify({
    siret: s,
    source: result.source,
    confidence: result.confidence,
    signals: result.signals,
    // Provenance de l'URL retenue : le seuil appliqué se relit dans l'audit (un seul
    // signal + attestee:false serait une anomalie, pas un verdict).
    attestee: result.attestee,
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
