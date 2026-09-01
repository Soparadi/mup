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
//   3.   Extraction : SIRET/SIREN, tél FR (hors surtaxés 08), email, adresse, et
//        liens de réseaux sociaux lus sur les pages déjà téléchargées (jamais visités).
//   4.   Recoupement scoré contre le faisceau + écriture additive.
//
// Robustesse : jamais de throw remontant. Échec réseau/timeout → « rien ». Tous
// les appels sortants passent par une file PAR HÔTE (patron overpass.js décliné par
// serveur) + AbortController : un appel à la fois vers un hôte donné, délai entre
// chaque, et un sémaphore global qui borne le nombre d'hôtes avançant de front
// (CRAWL_PARALLELISME, défaut 3). Chaque serveur visité voit exactement le rythme
// d'avant : c'est le plafond global qui a disparu, jamais l'espacement.
// politeFetchText est exportée : le module de recherche web et le flux d'actualités
// passent par le MÊME dispositif, chacun sur la file de son hôte.

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
const USER_AGENT = 'MovUP/1.0 (+https://movup.io)'

// Bornes réseau. Le [timeout] Overpass QL ne s'applique PAS aux sites tiers :
// c'est l'AbortController qui borne CHAQUE appel HTTP.
const FETCH_TIMEOUT_MS = 8000
const MAX_BYTES = 1_500_000          // cap taille réponse (évite les pages géantes)
const MIN_INTERVAL_MS = 1500         // délai minimal entre deux appels sortants
const MAX_RETRIES = 1                // un retry avec backoff sur 429/5xx/réseau

// Bornes robots.txt (RFC 9309). Fetch DÉDIÉ, distinct de doFetch : même délai que les
// pages, plafond de taille propre, AUCUNE reprise.
//
// Le délai fut plus court (3 s contre 8 s) au nom de la file unique : un hôte lent ne
// devait pas pénaliser les autres. Cette raison ne tient plus — le moteur travaille en
// passe de fond, aucun abonné n'attend devant l'écran, et le délai plus court refusait
// des hôtes qui résolvaient (deux pistes perdues sur neuf à l'essai inversé). Un site
// qui répond en 5 s mérite d'être lu, pas d'être écarté pour la lenteur de son seul
// fichier d'exclusion. Le coût est borné : un hôte entièrement mort passe de 3 s + 8 s
// à 8 s + 8 s dans la file, une fois, le résultat étant ensuite en cache.
//
// Ce qui reste PROPRE au robots.txt, et pour d'autres raisons que la file : aucune
// reprise (reprendre un fichier d'exclusion doublerait le coût d'un hôte mort sans
// rien apprendre), le plafond de 500 Ko (imposé par la RFC) et l'en-tête Accept
// text/plain (c'est le type du fichier).
const ROBOTS_TIMEOUT_MS = FETCH_TIMEOUT_MS   // même délai que les pages, délibérément
const ROBOTS_MAX_BYTES = 500_000     // 500 Ko, plafond RFC 9309 §2.5
const ROBOTS_TTL_MS = 24 * 3600 * 1000   // TTL cache par hôte : 24 h
// TTL propre à l'INJOIGNABLE. Un incident réseau ne mérite pas la mémoire d'une
// décision : garder un hôte hors d'atteinte 24 h parce que son fichier d'exclusion
// n'a pas répondu une fois, c'est faire dire à un délai dépassé ce que seul un
// Disallow a le droit de dire. Quinze minutes suffisent à ne pas marteler un hôte
// en panne, et la fiche redevient candidate dans la journée.
const ROBOTS_INJOIGNABLE_TTL_MS = 15 * 60 * 1000
const ROBOTS_CACHE_MAX = 500         // plafond d'entrées, éviction de la plus ancienne
const ROBOTS_UA_TOKEN = 'MovUP'      // product token seul (jamais l'User-Agent réseau complet)
// Plafond de crawl-delay honoré. La file est PAR HÔTE : honorer un délai ne ralentit
// plus que l'hôte qui le réclame, jamais le reste du sortant, et le complément est dormi
// HORS du sémaphore, si bien qu'un site lent n'occupe pas non plus un jeton à ne rien
// faire. Donc, délai ≤ MIN_INTERVAL_MS : sans effet (l'espacement courant suffit) ;
// entre MIN_INTERVAL_MS et ce plafond : honoré, en dormant le complément avant l'appel
// vers cet hôte ; au-delà : l'hôte est REFUSÉ (pas ralenti), refus mis en cache comme
// les autres.
//
// La valeur reste à 5 s. L'argument qui la bornait a changé de nature (ce n'est plus
// tout le sortant qui paie, c'est le seul hôte concerné), mais la relever serait une
// décision de politesse à prendre pour elle-même, pas un effet de bord du passage par
// hôte.
const ROBOTS_CRAWL_DELAY_MAX_MS = 5000

// Bornes crawl.
const MAX_LEGAL_PAGES = 4            // pages légales fetchées par site (au-delà du home)
// Candidats web vérifiés par SIRET (maillon 1.b). Dix, et non cinq : la mesure du
// 31 août a trouvé le site propre au rang 6 de la liste retenue sur une fiche où
// cinq ne rendaient rien. Chaque candidat coûte de la file, mais aucun n'est
// visité sans raison : la boucle s'arrête au PREMIER qui recoupe, et la liste est
// déjà purgée des annuaires par BLACKLIST_HOSTS avant d'arriver ici.
const MAX_CANDIDATS = 10

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
// Files PAR HÔTE + sémaphore global (patron overpass.js, décliné par serveur).
//
// UNE FILE PAR HÔTE. Chaque serveur visité a sa propre chaîne de promesses et son
// propre horodatage de dernier départ : ses pages se suivent une à une, espacées de
// MIN_INTERVAL_MS, exactement comme du temps de la file unique. De SON point de vue,
// rien n'a changé. Ce qui a disparu, c'est le plafond global : deux hôtes DIFFÉRENTS
// n'ont plus à s'attendre, et un hôte muet n'immobilise plus que lui-même.
//
// UN SÉMAPHORE GLOBAL borne le nombre d'hôtes avançant de front (CRAWL_PARALLELISME).
// Il n'est pris QUE pour l'appel réseau lui-même : l'espacement et le complément de
// crawl-delay sont dormis AVANT, hors jeton, pour qu'un site lent n'occupe pas une
// part du parallélisme à ne rien faire.
//
// LA CLÉ EST L'HÔTE, PAS L'ORIGINE. Le cache robots, lui, est par origine (RFC 9309,
// et c'est correct) : ce sont deux choses différentes. La politesse s'adresse à un
// serveur, et http://exemple.fr comme https://exemple.fr sont la même machine. Cléter
// par origine ferait partir le repli http sans le moindre espacement, juste après
// l'échec https, sur ce même serveur.
//
// LE PARALLÉLISME 1 EST LE REPLI EXACT vers le comportement d'avant : à cette valeur,
// et à elle seule, l'espacement redevient GLOBAL (cf. referenceEspacement), donc une
// seule sortie toutes les MIN_INTERVAL_MS pour tout le processus, une seule IP, un
// seul appel en vol. C'est ce qui en fait un vrai levier de repli, et non une
// approximation qui y ressemblerait.
// ---------------------------------------------------------------------------

// Hôtes traités de front. Lu comme CRAWL_ML_BATCH l'est déjà (server.js). Valeur non
// finie, ou inférieure à 1, ramenée au défaut ; plafond dur, pour qu'une faute de
// frappe dans le tableau de bord ne mette pas trois cents hôtes en vol.
const PARALLELISME_DEFAUT = 3
const PARALLELISME_MAX = 10
const PARALLELISME = (() => {
  const n = parseInt(process.env.CRAWL_PARALLELISME || String(PARALLELISME_DEFAUT), 10)
  if (!Number.isFinite(n) || n < 1) return PARALLELISME_DEFAUT
  return Math.min(n, PARALLELISME_MAX)
})()

// Plafond d'entrées de la Map, en CEINTURE seulement : l'élagage au point de sortie de
// chaque tâche suffit en régime normal, et ce plafond ne devrait jamais mordre. Patron
// de ROBOTS_CACHE_MAX, avec une règle de plus, qui n'est pas négociable : jamais
// d'éviction d'une entrée dont enCours est supérieur à zéro. Évincer une file active
// ferait repartir la tâche suivante du même hôte sur une file neuve, et deux appels
// vers le même serveur pourraient être en vol ensemble : c'est exactement la garantie
// que tout ce dispositif existe pour tenir.
const FILES_MAX = 500

// host -> { tail, lastCallAt, enCours }
//   • tail       : chaîne de promesses de CET hôte (sérialisation de ses appels).
//   • lastCallAt : dernier départ réseau vers CET hôte (espacement).
//   • enCours    : ses tâches en file ou en vol (élagage et éviction).
const files = new Map()
// Dernier départ, tous hôtes confondus. N'est LU qu'au parallélisme 1 (cf. l'en-tête) ;
// écrit toujours, pour n'avoir qu'un seul chemin d'écriture à relire.
let dernierDepartGlobal = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Jetons du sémaphore. File d'attente FIFO de résolveurs : rendre un jeton réveille le
// premier en attente plutôt que d'incrémenter le compteur, sinon un dormeur pourrait
// être doublé indéfiniment par des arrivants.
let jetonsLibres = PARALLELISME
const attenteJetons = []

function prendreJeton() {
  if (jetonsLibres > 0) { jetonsLibres--; return Promise.resolve() }
  return new Promise((r) => attenteJetons.push(r))
}

function rendreJeton() {
  const suivant = attenteJetons.shift()
  if (suivant) suivant()
  else jetonsLibres++
}

// Instant de référence pour l'espacement. Par hôte, sauf au parallélisme 1 où il
// redevient global : c'est ce qui fait de la valeur 1 le repli exact vers le verrou
// unique d'avant.
function referenceEspacement(f) {
  return PARALLELISME === 1 ? Math.max(f.lastCallAt, dernierDepartGlobal) : f.lastCallAt
}

// Ceinture d'entrées : n'évince QUE des files inactives (enCours à zéro) et refroidies
// (plus rien à espacer). Si aucune ne l'est, la Map dépasse le plafond, et c'est le bon
// choix : la sérialisation par serveur passe avant la borne.
function elaguerFiles() {
  if (files.size < FILES_MAX) return
  const now = Date.now()
  for (const [host, f] of files) {
    if (f.enCours > 0) continue
    if (now - f.lastCallAt < MIN_INTERVAL_MS) continue
    files.delete(host)
    if (files.size < FILES_MAX) return
  }
}

function fileDe(host) {
  const existante = files.get(host)
  if (existante) return existante
  elaguerFiles()
  const f = { tail: Promise.resolve(), lastCallAt: 0, enCours: 0 }
  files.set(host, f)
  return f
}

// Une file vide et refroidie ne retient plus rien : son lastCallAt ne peut plus
// retarder personne (le plancher est passé) et sa tail est déjà résolue. La supprimer
// ne change RIEN à la politesse, et c'est ce qui empêche la Map de croître sans fin.
// Tant que le plancher n'est pas écoulé, l'entrée est encore utile : on repasse à
// l'échéance, et on recontrôle, l'entrée ayant pu resservir entre-temps.
function libererSiInactive(host) {
  const f = files.get(host)
  if (!f || f.enCours > 0) return
  const restant = MIN_INTERVAL_MS - (Date.now() - f.lastCallAt)
  if (restant > 0) {
    const t = setTimeout(() => libererSiInactive(host), restant)
    if (typeof t.unref === 'function') t.unref()
    return
  }
  if (files.get(host) === f) files.delete(host)
}

// Sérialise `task` derrière la file de `host`, espacée de MIN_INTERVAL_MS, sous le
// sémaphore global. `attente` est le complément de crawl-delay, dormi HORS jeton.
//
// L'ORDRE EST DÉLIBÉRÉ : file de l'hôte, puis espacement, puis crawl-delay, puis le
// jeton, puis l'appel, puis le jeton rendu. Un sommeil ne consomme jamais de jeton.
function schedule(host, task, attente = 0) {
  const f = fileDe(host)
  f.enCours++
  const run = async () => {
    try {
      const wait = MIN_INTERVAL_MS - (Date.now() - referenceEspacement(f))
      if (wait > 0) await sleep(wait)
      if (attente > 0) await sleep(attente)
      await prendreJeton()
      try {
        // Recontrôle, jeton en main. L'attente d'un jeton ne peut qu'ALLONGER le
        // délai, sauf à un seul jeton, où deux hôtes réveillés ensemble se suivent
        // sur lui : le second partirait alors sans espacement. Le résidu est dormi
        // jeton en main, ce qui est sans conséquence puisque, à un seul jeton, rien
        // d'autre ne pouvait avancer de toute façon.
        const reste = MIN_INTERVAL_MS - (Date.now() - referenceEspacement(f))
        if (reste > 0) await sleep(reste)
        f.lastCallAt = Date.now()
        dernierDepartGlobal = f.lastCallAt
        return await task()
      } finally {
        rendreJeton()
      }
    } finally {
      f.enCours--
      libererSiInactive(host)
    }
  }
  // .then(run, run) : l'échec d'une tâche ne casse pas la chaîne de son hôte. La
  // dérivée est neutralisée en rejet, aucune promesse dérivée ne devant pouvoir
  // rejeter sans gestionnaire.
  const p = f.tail.then(run, run)
  f.tail = p.then(() => {}, () => {})
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
// Portillon robots.txt (RFC 9309). Cache par hôte, fetch dédié passant par la file de
// CET hôte (jamais en dehors, sous peine de rafale). Aucun throw, aucun marquage en
// base.
//
// DEUX FAÇONS DE NE PAS PASSER, et elles ne disent pas la même chose :
//   • REFUS       — l'éditeur a parlé. Un Disallow lu, ou un crawl-delay réclamé
//     au-delà de ce que nous acceptons de payer. Décision, définitive, honorée sans
//     réserve, gardée 24 h.
//   • INJOIGNABLE — nous n'avons pas pu lire le fichier (délai dépassé, 5xx, DNS,
//     réseau). Incident, qui ne dit RIEN de la volonté de l'éditeur, gardé 15 min.
//
// Les deux valent NON : `autorise` est faux dans les deux cas, et pas une requête de
// page ne part. La distinction ne relâche aucune prudence, elle sépare seulement ce
// qui est acquis de ce qui est à retenter. Un fichier d'exclusion en panne n'est
// JAMAIS une autorisation : le seul état qui autorise sans lire est TOUT_PERMIS,
// réservé au 4xx, où le serveur affirme que le fichier n'existe pas.
// ---------------------------------------------------------------------------

// Cache par hôte. Clé = origin (schéma://hôte:port). Valeur =
//   { etat: 'REGLES' | 'TOUT_PERMIS' | 'REFUS' | 'INJOIGNABLE', parsed, crawlDelaySec,
//     expiresAt }.
// Les échecs sont cachés eux aussi : sinon chaque URL d'un hôte re-taperait robots.txt.
// Mais pas pour la même durée que les décisions (cf. ROBOTS_INJOIGNABLE_TTL_MS).
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

// Fetch robots.txt DÉDIÉ, distinct de doFetch : même timeout que les pages, plafond de
// taille propre, AUCUN retry, même USER_AGENT. Rend { status, text } ; status 0 = réseau/timeout/DNS.
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

// Réponse HTTP → entrée de cache. Statuts :
//   • 2xx              → parserRobots, l'éditeur s'exprime (REGLES).
//   • 4xx (404/410…)   → TOUT_PERMIS : le serveur affirme qu'il n'y a pas de fichier.
//   • crawl-delay au-delà du plafond → REFUS. Le fichier a été LU et l'éditeur a posé
//     une règle ; refuser de la payer est NOTRE décision sur la sienne, pas un
//     incident. C'est donc un refus, avec la mémoire d'un refus.
//   • 5xx, timeout, réseau, DNS (status 0) → INJOIGNABLE. Fail-closed comme avant :
//     ne passe pas. Mais l'éditeur n'a rien dit, et c'est à retenter bientôt.
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
  return {
    etat: 'INJOIGNABLE',
    parsed: null,
    crawlDelaySec: null,
    expiresAt: Date.now() + ROBOTS_INJOIGNABLE_TTL_MS
  }
}

// Charge (ou récupère en vol) le robots d'un hôte, met en cache, journalise. Le fetch
// passe OBLIGATOIREMENT par schedule(...), sur la FILE DE SON HÔTE : le fichier
// d'exclusion est une requête vers ce serveur comme une autre, il est espacé comme les
// pages et compte dans le sémaphore. Jamais en dehors, sous peine de rafale.
//
// La clé de cache reste l'origine (RFC 9309), la clé de file est l'hôte : le même
// serveur peut porter deux origines, il n'a pas à être visité deux fois de front.
function chargerRobots(origin) {
  const enCours = robotsInflight.get(origin)
  if (enCours) return enCours
  const p = (async () => {
    const res = await schedule(safeHost(origin) || origin, () => fetchRobots(origin + '/robots.txt'))
    const entry = entryDepuisReponse(res)
    robotsCacheSet(origin, entry)
    console.log('[robots]', 'hôte résolu', origin, entry.etat,
      entry.crawlDelaySec != null ? `crawl-delay=${entry.crawlDelaySec}s` : '')
    return entry
  })()
  robotsInflight.set(origin, p)
  // Dérivée du finally neutralisée en rejet (même patron que la tail des files par
  // hôte) : aucune promesse dérivée ne doit pouvoir rejeter sans gestionnaire.
  p.finally(() => { if (robotsInflight.get(origin) === p) robotsInflight.delete(origin) })
    .then(() => {}, () => {})
  return p
}

// Chemin (pathname + query) mis en correspondance par robots.txt.
function cheminDe(url) {
  try { const u = new URL(url); return (u.pathname || '/') + (u.search || '') } catch { return '/' }
}

// Décision par état de cache. Product token seul (ROBOTS_UA_TOKEN).
//
// `injoignable` accompagne `autorise` sans jamais le contredire : il ne vaut vrai que
// lorsque `autorise` est faux, et n'existe que pour dire POURQUOI on ne passe pas.
// Quiconque lit cette sortie doit tester `autorise` et lui seul pour décider de partir.
function deciderDepuisEntry(entry, chemin) {
  if (entry.etat === 'TOUT_PERMIS') return { autorise: true, injoignable: false, crawlDelaySec: null }
  if (entry.etat === 'INJOIGNABLE') return { autorise: false, injoignable: true, crawlDelaySec: null }
  if (entry.etat === 'REFUS') return { autorise: false, injoignable: false, crawlDelaySec: entry.crawlDelaySec }
  const { autorise } = evaluerRobots(entry.parsed, chemin, ROBOTS_UA_TOKEN)
  return { autorise, injoignable: false, crawlDelaySec: entry.crawlDelaySec }
}

// Portillon : { autorise, injoignable, crawlDelaySec } pour une URL. Résout via cache/hôte.
async function resolveRobots(url) {
  const origin = safeOrigin(url)
  // origin inexploitable → refus (fail-closed). Inatteignable en pratique (normalizeUrl
  // a déjà validé le schéma en amont) ; la garde existe pour que le code dise partout
  // la même chose : ignorer les règles se résout toujours par le refus. REFUS et non
  // INJOIGNABLE : rien n'est à retenter sur une URL qui n'a pas d'origine, le défaut
  // est dans l'adresse, pas sur le réseau.
  if (!origin) return { autorise: false, injoignable: false, crawlDelaySec: null }
  const entry = robotsCacheGet(origin) || await chargerRobots(origin)
  return deciderDepuisEntry(entry, cheminDe(url))
}

// Complément de crawl-delay à dormir AVANT l'appel vers l'hôte, en sus de l'espacement
// déjà garanti sur la file de CET hôte (MIN_INTERVAL_MS). En deçà du plancher : 0 (sans
// effet). Le dépassement du plafond est déjà traité en amont (REFUS), donc borné ici de
// fait.
//
// Il est remis à schedule, qui le dort dans la file de l'hôte mais HORS du sémaphore.
// Deux conséquences, et ce sont les deux qu'on voulait : le site lent est réellement
// espacé comme il le demande, et il ne retient ni les autres hôtes ni un jeton pendant
// qu'il attend.
function complementCrawl(crawlDelaySec) {
  const cdMs = (crawlDelaySec != null) ? crawlDelaySec * 1000 : 0
  return cdMs > MIN_INTERVAL_MS ? cdMs - MIN_INTERVAL_MS : 0
}

// Sérialise l'appel derrière la file de SON HÔTE, sous le sémaphore global. Exportée
// pour recherche-web.js et actualites.js. Passe d'abord le portillon robots.txt de
// l'hôte (résolution + cache par hôte). Refus robots → null, exactement comme un échec
// réseau.
//
// Ce que le passage par hôte change pour un appelant qui ne visite qu'un seul hôte, le
// flux d'actualités notamment : il ne prend plus rang derrière le crawl. Sa file lui
// est propre et vide, il part dès qu'un jeton se libère.
//
// options (toutes facultatives, défauts = comportement historique à l'identique) :
//   • accept        — valeur de l'en-tête Accept (défaut : ACCEPT_DEFAUT).
//   • contentTypeRe — filtre appliqué au content-type de la réponse (défaut :
//     CONTENT_TYPE_RE_DEFAUT). RegExp SANS drapeau /g : .test sur une regex globale
//     est apatride entre appels seulement si lastIndex n'est jamais avancé.
//
// Ce qui n'est PAS paramétrable, et reste donc commun à tous les appelants : la file de
// l'hôte, le sémaphore, le portillon robots, le timeout, le plafond de taille et les
// reprises. Un appelant ne peut ni doubler la file de l'hôte qu'il vise, ni s'exonérer
// du robots.txt.
export async function politeFetchText(url, options = {}) {
  const { res } = await lireAvecMotif(url, options)
  return res
}

// Voie interne de politeFetchText, INTERNE AU MODULE (jamais exportée) : même travail,
// mais le motif du non-résultat est conservé. Rend { res, motif } :
//   • { res: {text, finalUrl}, motif: null }  — lecture faite.
//   • { res: null, motif: 'url' }             — URL inexploitable, aucun appel émis.
//   • { res: null, motif: 'portillon' }       — robots.txt a REFUSÉ (avant ou après
//     redirection). Une DÉCISION du site : rien ne doit permettre de la contourner.
//   • { res: null, motif: 'portillon_injoignable' } — le robots.txt n'a pas pu être LU
//     (délai dépassé, 5xx, DNS, réseau, ou levée pendant la résolution). L'éditeur n'a
//     rien dit. Ne vaut pas autorisation, et n'a rien à honorer non plus.
//   • { res: null, motif: 'fetch' }           — l'appel a eu lieu et n'a rien rendu
//     (délai dépassé, hôte mort, statut d'erreur, content-type inattendu).
//
// LES QUATRE MOTIFS VALENT NON, sans exception : cette fonction ne rend un `res` que
// lorsque le portillon a dit oui. 'portillon_injoignable' n'ouvre rien ; il permet
// seulement à l'appelant de savoir qu'il y a lieu de retenter plus tard, là où le
// refus, lui, est acquis.
//
// Cette distinction ne remonte PAS jusqu'aux appelants externes (actualites.js,
// recherche-web.js, scripts de diagnostic) : politeFetchText garde son contrat, deux
// sorties, { text, finalUrl } ou null.
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
    // Une levée = nous n'avons pas su lire le fichier. C'est un incident, pas une
    // parole de l'éditeur : injoignable, et toujours pas de passage.
    console.log('[robots]', 'injoignable (exception résolution)', u, String(e?.message || e).slice(0, 80))
    return { res: null, motif: 'portillon_injoignable' }
  }
  if (!gate.autorise) {
    const motif = gate.injoignable ? 'portillon_injoignable' : 'portillon'
    console.log('[robots]', gate.injoignable ? 'injoignable' : 'refus', u)
    return { res: null, motif }
  }

  // Fetch principal, sur la file de SON hôte. Le complément de crawl-delay est remis à
  // schedule, qui le dort dans cette file et hors du sémaphore (cf. complementCrawl).
  const complement = complementCrawl(gate.crawlDelaySec)
  const res = await schedule(safeHost(u) || u, () => doFetch(u, accept, contentTypeRe), complement)
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
      console.log('[robots]', 'injoignable après redirection (exception résolution)', res.finalUrl, String(e?.message || e).slice(0, 80))
      return { res: null, motif: 'portillon_injoignable' }
    }
    if (!gate2.autorise) {
      const motif2 = gate2.injoignable ? 'portillon_injoignable' : 'portillon'
      console.log('[robots]', gate2.injoignable ? 'injoignable après redirection' : 'refus après redirection', res.finalUrl)
      return { res: null, motif: motif2 }
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

// Clé de déduplication d'une page à lire : origine + chemin, sans chaîne de requête
// ni fragment, slash final ignoré. Quatre variantes d'une même page de contact
// (?utm=, #ancre, slash final) sont UNE page, et n'ont à consommer qu'un créneau
// du budget.
//
// Elle sert à ÉCARTER un doublon, JAMAIS à remplacer l'URL retenue : celle-ci reste
// l'URL entière de la première occurrence, query comprise, parce que naturePage lit
// la query (pathname + search) pour classer contact / mentions. Réduire l'URL à sa
// clé déclasserait en mentions une page servie par ?page=contact.
//
// URL illisible : rendue telle quelle. Deux illisibles identiques se dédupliquent,
// une illisible n'écarte jamais une URL valide.
function clePage(url) {
  try {
    const u = new URL(url)
    return u.origin + u.pathname.replace(/\/+$/, '')
  } catch { return String(url || '') }
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
// Maillon 3 bis — réseaux sociaux. Le pied de page est DÉJÀ téléchargé (accueil et
// pages légales) ; il n'était simplement pas regardé : extractLegalLinks écarte tout
// lien sortant, et stripTags efface ensuite les attributs href, si bien qu'aucune URL
// de réseau n'existait passé la ligne du corpus.
//
// La doctrine place le réseau social AVANT le téléphone dans l'ordre des canaux, et
// des fiches n'ont que cela : une page Facebook, un profil LinkedIn, aucun numéro.
// Sans ce maillon, elles restent vides définitivement.
//
// DEUX INVARIANTS, tous deux structurels :
//   • AUCUN APPEL SORTANT NOUVEAU. Ces fonctions sont pures, sans réseau ni base : on
//     relit du HTML déjà en mémoire. Le budget MAX_LEGAL_PAGES ne bouge pas.
//   • LE RÉSEAU N'EST JAMAIS VISITÉ. Leurs conditions d'utilisation l'interdisent. Les
//     URL extraites ne rejoignent JAMAIS la liste des pages à lire d'analyserSite :
//     elles vont de l'extraction au champ du référentiel, sans passer par la file.
// ---------------------------------------------------------------------------

// Réseaux reconnus, et le champ que chacun alimente. Rien d'autre n'est retenu : un
// hôte hors de cette table est ignoré, y compris les services de partage tiers.
const RESEAUX = [
  {
    champ: 'societe_facebook',
    domaines: ['facebook.com', 'fb.com', 'fb.me'],
    // /pages/<nom>/<id> et /p/<nom>-<id> sont des pages d'entreprise ; profile.php
    // ne porte qu'un identifiant numérique, donc aucun fragment nommant l'entreprise.
    fragment: (seg) => ((seg[0] === 'pages' || seg[0] === 'p') ? (seg[1] || '') : (/^profile\.php$/i.test(seg[0]) ? '' : seg[0]))
  },
  {
    champ: 'societe_instagram',
    domaines: ['instagram.com'],
    fragment: (seg) => seg[0]
  },
  {
    champ: 'societe_linkedin',
    domaines: ['linkedin.com'],
    fragment: (seg) => (['company', 'in', 'school', 'showcase', 'pub'].includes(seg[0]) ? (seg[1] || '') : seg[0])
  }
]

// Chemins qui ne désignent le profil de personne : partage, connexion, greffons, pages
// de service du réseau lui-même. Un bouton « partager sur Facebook » n'est pas un
// compte d'entreprise.
const RESEAU_CHEMIN_REJETE =
  /^\/(?:sharer|share|dialog|plugin|plugins|intent|login|signup|help|policies|privacy|terms|explore|search|feed|sharearticle|sharing|home|hashtag|groups|events|watch|marketplace|accounts|directory)(?:[\/.]|$)/i

// Formes d'attribution d'auteur, cherchées dans le HTML qui PRÉCÈDE le lien et dans
// son libellé : le réseau d'un prestataire se signale presque toujours par elles.
// Le mot « agence » en est VOLONTAIREMENT absent : la population visée compte des
// agences de publicité, chez qui il désigne l'entreprise elle-même, pas son
// prestataire. Comparaison sur texte passé à normText (accents et ponctuation retirés).
const RESEAU_CREDIT_RE =
  /\b(realis[a-z]* par|realisation du site|creation du site|creation site|cree par|creee par|concu par|conception du site|conception et realisation|propulse par|powered by|developpe par|developpement du site|design by|designed by|site by|made by|webmaster|credit|credits)\b/

const RESEAU_FENETRE_CREDIT = 220    // caractères de HTML lus AVANT le <a> (contexte)
const RESEAU_ZONE_BASSE = 0.75       // dernier quart du document : pied de page approché
const RESEAU_MIN_CONCORDANCE = 5     // longueur minimale d'un fragment comparable

// Normalisation de comparaison : normText puis espaces retirés. « ACTI'ANIM » et
// « acti-anim » deviennent tous deux « actianim ».
function normCollapse(s) {
  return normText(s).replace(/ /g, '')
}

// Base d'un nom d'hôte : www retiré, tout ce qui précède le premier point.
// « www.alveo-breizh.fr » → « alveo-breizh ».
function baseDomaine(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '')
  return h.split('.')[0] || ''
}

// Deux fragments concordent si l'un contient l'autre, les deux étant assez longs pour
// que la rencontre veuille dire quelque chose.
function fragmentsConcordent(a, b) {
  if (a.length < RESEAU_MIN_CONCORDANCE || b.length < RESEAU_MIN_CONCORDANCE) return false
  return a.includes(b) || b.includes(a)
}

// Un href est-il un profil de réseau reconnu ? Rend { champ, url, fragment } ou null.
// L'URL rendue est débarrassée de sa requête et de son ancre (paramètres de suivi), à
// LA seule exception de profile.php, dont l'identifiant vit dans la requête.
function reseauCible(href, baseUrl) {
  let u
  try { u = new URL(href, baseUrl) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  const host = u.hostname.toLowerCase()
  const reseau = RESEAUX.find(r => r.domaines.some(d => host === d || host.endsWith('.' + d)))
  if (!reseau) return null

  let chemin = u.pathname || '/'
  try { chemin = decodeURIComponent(chemin) } catch { /* garde brut */ }
  if (chemin === '' || chemin === '/') return null            // l'accueil du réseau
  if (RESEAU_CHEMIN_REJETE.test(chemin)) return null

  const seg = chemin.split('/').filter(Boolean)
  if (seg.length === 0) return null
  const profilPhp = /^profile\.php$/i.test(seg[0])
  if (profilPhp && !u.searchParams.get('id')) return null      // ni nom ni identifiant
  const url = u.origin + '/' + seg.join('/') + (profilPhp ? '?id=' + u.searchParams.get('id') : '')
  return { champ: reseau.champ, url, fragment: reseau.fragment(seg) || '' }
}

// Liens de réseaux d'UNE page. Fonction PURE. Rend des candidats, jamais une décision :
//   { champ, url, fragment, credit, basPage }
// credit — le lien est entouré d'une formule d'attribution d'auteur.
// basPage — le lien se trouve dans le dernier quart du document. Approximation assumée
//   du pied de page : sans construction d'un DOM, c'est le meilleur signal disponible,
//   et il écarte les liens cités en plein corps d'article.
export function extractReseaux(html, baseUrl) {
  const src = String(html || '')
  const seuilBas = src.length * RESEAU_ZONE_BASSE
  const out = []
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  for (const m of src.matchAll(re)) {
    const cible = reseauCible(m[1], baseUrl)
    if (!cible) continue
    const avant = src.slice(Math.max(0, m.index - RESEAU_FENETRE_CREDIT), m.index)
    const contexte = normText(avant + ' ' + stripTags(m[2]))
    out.push({
      champ: cible.champ,
      url: cible.url,
      fragment: cible.fragment,
      credit: RESEAU_CREDIT_RE.test(contexte),
      basPage: m.index >= seuilBas
    })
  }
  return out
}

// Arbitrage : parmi les candidats de TOUTES les pages lues, lequel est le réseau DE
// L'ENTREPRISE, et non celui d'un prestataire ou d'un partenaire ? Un par réseau, ou
// aucun. Fonction PURE, exportée pour vérification hors-base comme repartirPages.
//
// Deux épreuves, dans cet ordre :
//
//   1. CONCORDANCE DU FRAGMENT — l'adresse du profil nomme l'entreprise, ou nomme le
//      domaine de son propre site. C'est la même logique de corroboration que le reste
//      du maillon 4, appliquée au lien. Un prestataire ne la passe pas : son profil
//      porte SON nom.
//
//   2. REPLI, à défaut — le lien est le SEUL de son réseau sur tout ce qui a été lu, il
//      se trouve en pied de page, et aucune de ses occurrences n'est entourée d'une
//      formule d'attribution d'auteur. Sans ce repli on raterait les pages dont
//      l'adresse est un identifiant numérique (profile.php?id=…), forme très fréquente
//      chez les TPE — c'est-à-dire exactement la population qui n'a QUE ce canal.
//      Le faux positif de partenaire qu'il laisse passer est borné par ce qui l'entoure :
//      rien n'est écrit sans corroboration de la fiche, et rien n'écrase une valeur déjà
//      présente.
export function retenirReseaux(candidats, faisceau = {}, siteHost = '') {
  const liste = Array.isArray(candidats) ? candidats : []
  const out = {}
  const attendus = [normCollapse(faisceau?.raison_sociale), normCollapse(baseDomaine(siteHost))]
    .filter(x => x.length >= RESEAU_MIN_CONCORDANCE)

  for (const { champ } of RESEAUX) {
    const duReseau = liste.filter(c => c && c.champ === champ)
    if (duReseau.length === 0) continue

    // Épreuve 1.
    const concordant = duReseau.find(c =>
      attendus.some(a => fragmentsConcordent(normCollapse(c.fragment), a)))
    if (concordant) { out[champ] = concordant.url; continue }

    // Épreuve 2. Plusieurs profils distincts pour un même réseau = ambiguïté : on ne
    // tranche pas au hasard, on n'écrit rien.
    const urls = new Set(duReseau.map(c => c.url))
    if (urls.size !== 1) continue
    if (duReseau.some(c => c.credit)) continue
    const enPied = duReseau.find(c => c.basPage)
    if (!enPied) continue
    out[champ] = enPied.url
  }
  return out
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
//
// CE N'EST PLUS LA REGLE DU RECOUPEMENT. recouper ne l'appelle plus : il exige la
// voie citee (cf. son commentaire). Cette fonction demeure telle quelle parce que
// les scripts de diagnostic s'en servent comme etat de reference, l'un d'eux
// appelant chacune de ses deux branches pour les opposer. Elle repond donc a la
// question « l'adresse figure-t-elle sur la page », qui est plus large que celle
// que le recoupement se pose.
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
    // DURCISSEMENT AU POINT D'USAGE, et non dans adresseConcorde. Ce que le
    // recoupement accepte de compter comme signal d'adresse, c'est la VOIE CITEE,
    // jamais la conjonction ville plus code postal : sur la page d'enseigne qui
    // liste neuf cents salons, « BORDEAUX 33200 » ne dit rien de CET
    // etablissement, il dit que l'enseigne couvre la ville.
    //
    // adresseConcorde garde ses DEUX branches et n'est pas touchee. Elle est
    // exportee, neuf scripts de diagnostic l'importent, et deux d'entre eux
    // appellent chaque branche separement pour les comparer : durcir la fonction
    // leur retirerait leur terme de comparaison. Ce qui se resserre ici est la
    // regle du recoupement, pas ce que la fonction sait dire.
    //
    // Corollaire, et c'est pourquoi la paire adresse plus dirigeant_nom reste
    // suffisante : une fois l'adresse reduite a la voie citee, cette paire n'est
    // plus un signal faible. Un etablissement nomme a une rue citee avec son
    // numero, dirigeant nomme sur la meme page, c'est le meilleur faisceau que ce
    // module produise hors SIRET.
    adresse: voieCitee(faisceau, ex),
    // Plancher du patronyme a 5 caracteres. Celui de la raison sociale reste a 4 :
    // ce sont deux aiguilles de nature differente, un nom de famille court happe
    // des pages entieres sans rien prouver, et le dirigeant n'est ici qu'un
    // VALIDATEUR de concordance, jamais une donnee ecrite.
    dirigeant_nom: presentNorm(ex.corpusNorm, faisceau.dirigeant_nom, 5)
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
// Rend { confidence, signals, emails, phones, reseaux, urlLue } (confidence possiblement
// null si le site est joignable mais ne recoupe pas), ou null si le home est injoignable.
//
// reseaux — objet { societe_facebook?, societe_instagram?, societe_linkedin? }, lu sur
// les pages DÉJÀ téléchargées. Aucun appel sortant de plus, et aucune visite du réseau.
//
// urlLue — l'adresse qui a EFFECTIVEMENT répondu, http compris quand le repli a joué.
// C'est elle que le référentiel doit enregistrer : inscrire une adresse sécurisée pour
// un site qui ne répond qu'en clair, c'est inscrire une adresse qui ne répond pas.
// Champ ajouté, jamais retiré : les appelants qui ne lisent que confidence, signals,
// emails et phones ne voient aucune différence.
// Exportée pour diagnostic : elle ne touche JAMAIS la base (crawl + extraction +
// recoupement en mémoire), l'écriture reste le seul fait d'enrichirMentionsLegales.
//
// options.attestee — l'URL est attestée par identifiant (cf. SEUIL_PRESUME_ATTESTE) :
// un seul signal de page suffit alors pour « présumé ». ABSENTE PAR DÉFAUT : sans
// options, le seuil reste à deux, à l'identique d'avant.
//
// options.trace — objet fourni par l'appelant, RENSEIGNÉ EN SORTIE : trace.motif reçoit
// le motif du non-résultat de l'accueil ('url', 'portillon', 'portillon_injoignable',
// 'fetch') ou null si la page a été lue. Le type de retour ne change pas : cette
// fonction rend toujours un objet ou null, et l'appelant qui n'a que faire du motif ne
// passe pas de trace. C'est le seul chemin par lequel la distinction refus/injoignable
// sort du module sans toucher au contrat de politeFetchText ni à celui d'analyserSite.
// ---------------------------------------------------------------------------

export async function analyserSite(homeUrlRaw, faisceau, options = {}) {
  const attestee = options.attestee === true
  const trace = (options.trace && typeof options.trace === 'object') ? options.trace : null
  const noter = (motif) => { if (trace) trace.motif = motif }
  const homeUrl = normalizeUrl(homeUrlRaw)
  if (!homeUrl) { noter('url'); return null }

  // Accueil, avec repli sur le protocole non sécurisé. normalizeUrl ajoute https quand
  // le schéma manque ; une part des sites ne répond qu'en http et restait donc muette.
  // DEUX conditions, cumulatives :
  //   • c'est nous qui avons ajouté https — une URL qui portait https explicitement est
  //     lue telle qu'elle est écrite, jamais dégradée dans notre dos ;
  //   • l'échec ne vient JAMAIS d'un refus du portillon — retenter en http un hôte dont
  //     le robots.txt a refusé serait contourner ce refus par changement de schéma.
  // Le repli vaut donc pour 'fetch' ET pour 'portillon_injoignable' : quand le fichier
  //     d'exclusion n'a pas pu être lu en https, aucune décision n'a été rendue, il n'y
  //     a donc rien à contourner. Et ce n'est pas une porte dérobée : http:// et https://
  //     sont deux origines distinctes au sens du portillon, le fichier de l'origine http
  //     est re-demandé à neuf, et s'il refuse, le refus s'applique.
  // La seconde tentative passe par le même portillon et par la MÊME FILE, l'hôte étant
  // le même des deux côtés (c'est pourquoi les files sont clétées par hôte et non par
  // origine) : elle est donc espacée de l'échec https comme n'importe quel autre appel
  // vers ce serveur, et comptée dans les plafonds comme lui.
  const REPLI_HTTP_MOTIFS = new Set(['fetch', 'portillon_injoignable'])
  let lecture = await lireAvecMotif(homeUrl)
  let urlLue = homeUrl
  if (!lecture.res && REPLI_HTTP_MOTIFS.has(lecture.motif) && schemaAjoute(homeUrlRaw)) {
    urlLue = homeUrl.replace(/^https:\/\//i, 'http://')
    lecture = await lireAvecMotif(urlLue)
  }
  const home = lecture.res
  if (!home) { noter(lecture.motif); return null }
  noter(null)

  const base = home.finalUrl || urlLue
  const homeHtml = decodeEntities(home.text)

  // Maillon 2 — pages à lire au-delà de l'accueil : liens du site d'abord, puis
  // chemins conventionnels. Contact, à propos et pages légales, plafond inchangé.
  const legalLinks = extractLegalLinks(homeHtml, base)
  const origin = safeOrigin(base)
  const conventional = origin ? CONVENTIONAL_PATHS.map(p => origin + p) : []
  // Déduplication sur origine + chemin (clePage), et non sur l'URL entière : la
  // chaîne de requête et le fragment ne distinguent pas deux pages à lire. L'accueil
  // est écarté par la MÊME clé, sinon https://site.fr/?utm=x survit face à
  // https://site.fr/ et prend un créneau pour une page déjà lue. Ordre d'origine
  // préservé (liens du site, puis chemins devinés) : repartirPages en dépend.
  const vus = new Set([clePage(base)])
  const candidats = []
  for (const u of [...legalLinks, ...conventional]) {
    const c = clePage(u)
    if (vus.has(c)) continue
    vus.add(c)
    candidats.push(u)
  }
  // Budget inchangé, répartition garantie : au moins une page de chaque nature.
  const pages = repartirPages(candidats, MAX_LEGAL_PAGES)

  // Corpus = home + pages légales (texte strippé/décodé). Les liens de réseaux sont
  // relevés sur le HTML AVANT strippage — stripTags efface les attributs href, et une
  // fois le corpus constitué il n'y a plus une seule URL de réseau à lire.
  const texts = [stripTags(homeHtml)]
  const reseauxCandidats = [...extractReseaux(homeHtml, base)]
  for (const p of pages) {
    const r = await politeFetchText(p)
    if (!r) continue
    const pageHtml = decodeEntities(r.text)
    texts.push(stripTags(pageHtml))
    reseauxCandidats.push(...extractReseaux(pageHtml, r.finalUrl || p))
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

  // Maillon 3 bis — arbitrage des réseaux sur l'ensemble de ce qui a été lu.
  const reseaux = retenirReseaux(reseauxCandidats, faisceau, safeHost(base))

  // Maillon 4 — recoupement.
  const { confidence, signals } = recouper(faisceau, ex, attestee)
  return { confidence, signals, emails, phones, reseaux, urlLue }
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
  // DEUX FRONTIÈRES DE PASSAGE, lues par le finally, et le passage vaut L'UNE OU
  // L'AUTRE. analyserSite les alimente par son type de retour : null = on n'a pas pu
  // visiter (refus du portillon, délai dépassé, hôte mort) ; objet = le site a
  // répondu, corroboration ou non.
  //   • visiteBaseAboutie    — l'adresse INSCRITE EN BASE a répondu. Le site est
  //     celui que la fiche déclare : qu'il corrobore ou non, on a frappé à SA porte,
  //     et l'absence de recoupement y est un vrai résultat négatif.
  //   • corroborationAboutie — un site a corroboré, quel que soit le maillon qui a
  //     fourni l'adresse. La corroboration EST la preuve qu'on était à la bonne
  //     porte : elle vaut passage par elle-même, sans rien devoir à la provenance.
  //
  // Ce que ces deux frontières laissent dehors, et c'est tout leur objet : une
  // adresse DEVINÉE — recherche web aujourd'hui, composition demain — qui répond
  // sans rien corroborer. Le nom ressemble, l'hôte est vivant, et rien ne dit que la
  // maison soit la bonne : le parking de domaine et l'homonyme étranger répondent
  // aussi bien que le vrai site. Horodater là-dessus rendrait la fiche inerte trente
  // jours sur une ressemblance. Voir porte_incertaine, dans le finally.
  //
  // visiteAboutie demeure mais ne décide plus du passage : elle ne sert qu'à séparer
  // « personne n'a répondu » de « quelqu'un a répondu, mais qui ? ».
  let urlsTentees = 0
  let visiteAboutie = false          // une URL, quelle qu'elle soit, a répondu
  // Une URL au moins s'est vu opposer un REFUS EXPLICITE du fichier d'exclusion, par
  // opposition à un fichier qu'on n'a pas pu lire. Ne change ni le passage ni
  // l'horodatage : sert à nommer le non-passage dans l'audit, pour que l'exploitant
  // distingue « l'éditeur nous ferme sa porte » de « le réseau a lâché ».
  let refusExplicite = false
  let visiteBaseAboutie = false      // frontière 1
  let corroborationAboutie = false   // frontière 2
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
      const trace = {}
      const a = await analyserSite(faisceau.website, faisceau, { attestee, trace })
      if (trace.motif === 'portillon') refusExplicite = true
      // Frontière 1 : l'adresse venait de la base et elle a répondu. Le passage est
      // acquis ici, avant même de savoir si le site recoupe quoi que ce soit.
      if (a) { visiteAboutie = true; visiteBaseAboutie = true }
      if (a && a.confidence) {
        analyse = a
        corroborationAboutie = true
        // L'adresse qui a répondu, pas la forme normalisée : le repli http l'a
        // peut-être dégradée, et c'est celle-là qui est joignable.
        sourceUrl = a.urlLue || normalizeUrl(faisceau.website)
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
        const trace = {}
        const a = await analyserSite(url, faisceau, { attestee, trace })
        if (trace.motif === 'portillon') refusExplicite = true
        // Un candidat qui répond NE SUFFIT PAS à établir le passage : l'adresse a
        // été devinée, et un hôte vivant ne dit pas qu'il est le bon. Seule la
        // corroboration tranche ici — frontière 2. Sans elle, le compteur ci-dessous
        // ne sert plus qu'à distinguer l'injoignable de la porte incertaine.
        if (a) visiteAboutie = true
        if (a && a.confidence) {
          analyse = a
          corroborationAboutie = true
          sourceUrl = a.urlLue || normalizeUrl(url)
          result.source = 'web'
          result.attestee = attestee
          break
        }
      }
    }

    // Écriture additive (fill-if-empty, liste blanche des six champs actionnables :
    // website, societe_email, societe_tel et les trois réseaux). Un seul champ
    // corroboré suffit. La règle est la même pour tous : posé seulement si le champ
    // est vide en base, seulement si la corroboration de la fiche est établie — d'où
    // la garde analyse.confidence qui commande tout le bloc.
    if (analyse && analyse.confidence) {
      result.confidence = analyse.confidence
      result.signals = analyse.signals
      const fields = {}
      if (sourceUrl) fields.website = sourceUrl
      if (analyse.emails.length) fields.societe_email = analyse.emails[0]
      if (analyse.phones.length) fields.societe_tel = analyse.phones[0]
      // Réseaux déjà arbitrés par retenirReseaux : au plus un par réseau, ou aucun.
      for (const [champ, url] of Object.entries(analyse.reseaux || {})) fields[champ] = url
      if (Object.keys(fields).length) {
        await enrichReferentielActionnable(s, fields)
        result.written = true
      }
    }
  } catch (e) {
    console.warn('[mentions-legales]', String(e?.message || e).slice(0, 100))
  } finally {
    // Non-passage AVAL, symétrique des trois gardes amont : ni visite de base, ni
    // corroboration. Quatre motifs, du plus vide au plus ambigu :
    //   • sans_url         — pas une seule URL à tenter (ni base, ni recherche web).
    //   • refus_robots     — des URL tentées, aucune n'a répondu, et l'une au moins
    //     s'est vu opposer un Disallow lu. L'éditeur a parlé : le non-passage est
    //     acquis tant que son fichier dit cela. Le refus explicite prime dans le
    //     libellé, même si d'autres URL ont échoué autrement : c'est le seul fait
    //     établi du lot, les autres ne sont que des absences.
    //   • injoignable      — des URL tentées, aucune n'a répondu, sans qu'aucun refus
    //     n'ait été lu (délai dépassé, hôte mort, fichier d'exclusion illisible). Rien
    //     n'est acquis : à retenter.
    //   • porte_incertaine — un hôte a répondu, mais l'adresse était devinée et rien
    //     n'a corroboré. Ni sans_url ni injoignable : il y avait bien une porte et
    //     elle s'est ouverte, rien ne dit que ce soit la bonne. Pas d'horodatage, la
    //     fiche reste candidate — une adresse mieux composée la retrouvera.
    // Un site DE LA BASE qui ne corrobore pas n'est dans aucun des quatre : c'est un
    // vrai résultat négatif, et il mérite ses 30 jours.
    if (result.skipped == null && !visiteBaseAboutie && !corroborationAboutie) {
      result.skipped = urlsTentees === 0
        ? 'sans_url'
        : (visiteAboutie ? 'porte_incertaine' : (refusExplicite ? 'refus_robots' : 'injoignable'))
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
// runMentionsLegalesJob(sirets) : traitement d'un lot, CRAWL_PARALLELISME SIRET en vol.
//
// POURQUOI CE N'EST PLUS SÉQUENTIEL. La file étant désormais par hôte, un lot qui
// avance fiche à fiche n'a jamais qu'UN hôte en vol : le sémaphore ne se remplirait
// pas, et le débit resterait celui de la file unique. Le verrou par hôte ne rend rien
// sans quelqu'un pour lui donner plusieurs hôtes à la fois. C'est ici.
//
// LE TRAITEMENT D'UN SITE, LUI, RESTE SÉQUENTIEL : les pages d'un même serveur se
// suivent dans sa propre file, à son rythme, et deux appels vers lui ne peuvent pas
// être en vol ensemble. C'est entre SIRET, donc entre hôtes, que le lot avance de
// front. Aucun serveur ne voit une rafale.
//
// Ouvriers tirant d'un curseur partagé, plutôt qu'un découpage en tranches : les fiches
// n'ont pas le même coût (une fiche sautée au TTL ne coûte rien, un hôte muet coûte des
// secondes), et une tranche lente ferait attendre les autres pour rien. L'incrément du
// curseur n'a pas à être protégé : rien ne préempte entre la lecture et l'écriture.
//
// Aucun throw remontant.
// ---------------------------------------------------------------------------

export async function runMentionsLegalesJob(sirets) {
  try {
    const list = Array.isArray(sirets)
      ? sirets.map(x => String(x || '').replace(/\s+/g, '')).filter(Boolean)
      : []
    if (list.length === 0) return

    let traites = 0, sautes = 0, certains = 0, presumes = 0, ecrits = 0
    let curseur = 0
    const ouvrier = async () => {
      for (;;) {
        const i = curseur++
        if (i >= list.length) return
        const r = await enrichirMentionsLegales(list[i])
        if (r?.skipped != null) { sautes++; continue }
        traites++
        if (r?.confidence === 'certain') certains++
        else if (r?.confidence === 'presume') presumes++
        if (r?.written) ecrits++
      }
    }
    const enVol = Math.min(PARALLELISME, list.length)
    await Promise.all(Array.from({ length: enVol }, () => ouvrier()))

    console.log(
      `[mentions-legales] lot=${list.length} en_vol=${enVol} traités=${traites} ` +
      `sautés=${sautes} certains=${certains} présumés=${presumes} écrits=${ecrits}`
    )
  } catch (e) {
    console.error('[mentions-legales]', String(e?.message || e).slice(0, 120))
  }
}
