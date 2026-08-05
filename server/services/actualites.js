// Actualités — ramassage périodique du flux RSS France 24 pour le bandeau du
// tableau de bord. Table SÉPARÉE : actualites, clé naturelle guid (UNIQUE).
//
// Pourquoi côté serveur : le bandeau interrogeait jusqu'ici un flux tiers depuis
// le navigateur, via un relais CORS public. Une manchette qui s'affiche chez
// l'abonné dépendait donc de deux services que nous ne tenons pas. Ici, le flux
// est ramassé une fois toutes les quinze minutes par le serveur, rangé en base,
// et servi depuis chez nous : le navigateur ne sort plus.
//
// Sortie réseau : politeFetchText (mentions-legales.js) — MÊME file mono-verrou,
// MÊME portillon robots.txt, MÊME timeout que tout le reste du sortant. Le flux
// est servi en text/xml, d'où les deux options (accept, contentTypeRe).
//
// Analyse SANS dépendance : le flux est du RSS 2.0 plat, on découpe les blocs
// <item> et on lit cinq champs. Ce n'est pas un analyseur XML — c'est un lecteur
// de CE flux, tolérant à ce que celui-ci pourrait devenir (CDATA, entités).
//
// Jamais de throw : un échec rend un compte à zéro et journalise. La base garde
// ce qu'elle avait — un bandeau qui affiche les manchettes d'il y a une heure
// vaut mieux qu'un bandeau vide.

import { getDb } from '../../lib/surreal.js'
import { politeFetchText } from './mentions-legales.js'

const FLUX_URL = 'https://feeds.feedburner.com/france24/UKYbC7wOMbe'
const SOURCE = 'France 24'

// Le flux est servi en `text/xml; charset=utf-8`. Le filtre par défaut de
// politeFetchText (HTML/texte) le rejetterait : on le remplace, sans l'ouvrir à
// tout — un content-type qui n'est pas du XML n'est pas ce flux.
const ACCEPT_XML = 'application/rss+xml,application/xml;q=0.9,text/xml;q=0.9,*/*;q=0.5'
const CONTENT_TYPE_XML_RE = /application\/(rss\+)?xml|text\/xml/i

// Bornes. MAX_ITEMS_LUS borne l'analyse (un flux anormalement gros ne doit pas
// tourner en boucle) ; MAX_CONSERVEES borne le stock (au-delà, purge).
const MAX_ITEMS_LUS = 100
const MAX_CONSERVEES = 40

// Longueur maximale de la partie id d'un record. Le guid de France 24 est un
// UUID (36 caractères) ; d'autres flux y mettent l'URL de l'article. On borne
// pour ne pas fabriquer d'identifiant démesuré à partir d'une entrée tierce.
const MAX_ID_LEN = 200

// ── migration idempotente ──
// Calque du patron runReferentielOsmMigration : DEFINE … IF NOT EXISTS, une
// requête par ligne, échec d'une ligne journalisé sans interrompre les suivantes.
export async function runActualitesMigration() {
  const db = await getDb()
  const queries = [
    'DEFINE TABLE IF NOT EXISTS actualites SCHEMAFULL',
    'DEFINE FIELD IF NOT EXISTS guid ON actualites TYPE string',
    'DEFINE FIELD IF NOT EXISTS title ON actualites TYPE string',
    'DEFINE FIELD IF NOT EXISTS link ON actualites TYPE string',
    // Une description vide est un cas RÉEL du flux (brèves, vidéos sans chapô) :
    // le champ est optionnel, jamais une condition de rejet.
    'DEFINE FIELD IF NOT EXISTS description ON actualites TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS published_at ON actualites TYPE datetime',
    "DEFINE FIELD IF NOT EXISTS source ON actualites TYPE string DEFAULT 'France 24'",
    'DEFINE FIELD IF NOT EXISTS collected_at ON actualites TYPE datetime DEFAULT time::now()',
    // guid clé naturelle → UNIQUE : garantit l'idempotence de l'UPSERT (un article
    // = un record, quel que soit le nombre de passages du cron dessus).
    'DEFINE INDEX IF NOT EXISTS idx_actualites_guid ON actualites FIELDS guid UNIQUE',
    // Tri et purge se font tous deux sur published_at DESC — l'index les sert.
    'DEFINE INDEX IF NOT EXISTS idx_actualites_published ON actualites FIELDS published_at'
  ]
  for (const q of queries) {
    try { await db.query(q) } catch (e) { console.warn('[actualites-migration]', q.slice(0, 80), '→', e.message) }
  }
}

// ---------------------------------------------------------------------------
// Analyse du flux. Fonctions PURES : aucun réseau, aucune base.
// ---------------------------------------------------------------------------

// Entités XML — les cinq prédéfinies, &nbsp;, et les formes numériques. &amp; est
// traitée EN DERNIER : la décoder d'abord transformerait « &amp;lt; » en « < ».
function decoderEntites(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(Number(d)) } catch { return m } })
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)) } catch { return m } })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
}

// Contenu d'un élément → texte exploitable. CDATA déballé, balises résiduelles
// retirées (le flux du jour n'en porte pas dans les champs lus ; d'autres en
// mettent dans description), entités décodées, blancs compactés.
function texteDe(brut) {
  return decoderEntites(
    String(brut || '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim()
}

// Premier <nom …>…</nom> d'un bloc. `\b` après le nom : <link> ne doit pas être
// capté par une recherche de <li>, et <media:thumbnail> ne répond pas à « link »
// (l'ancre « < » colle le nom au chevron, un préfixe de namespace ne matche pas).
function champ(bloc, nom) {
  const re = new RegExp('<' + nom + '\\b[^>]*>([\\s\\S]*?)<\\/' + nom + '>', 'i')
  const m = bloc.match(re)
  return m ? texteDe(m[1]) : ''
}

// Lien retenu seulement s'il est http(s) : c'est ce lien qui finira en href dans
// le navigateur de l'abonné. Un javascript: ou data: venu d'un flux tiers n'a
// rien à y faire — on le refuse ici, à l'entrée, pas à l'affichage.
function lienValide(raw) {
  try {
    const u = new URL(String(raw || '').trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    return u.toString()
  } catch { return '' }
}

// pubDate RFC 822 (« Wed, 05 Aug 2026 12:50:53 GMT ») → ISO, ou '' si illisible.
function dateIso(raw) {
  const t = new Date(String(raw || '').trim()).getTime()
  if (!Number.isFinite(t)) return ''
  return new Date(t).toISOString()
}

// Flux → liste d'items exploitables. Un item sans titre ou sans lien valide est
// REJETÉ (rien à afficher, ou rien à ouvrir). Une description vide, elle, passe.
export function analyserFlux(xml) {
  const out = []
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi
  for (const m of String(xml || '').matchAll(re)) {
    if (out.length >= MAX_ITEMS_LUS) break
    const bloc = m[1]
    const title = champ(bloc, 'title')
    const link = lienValide(champ(bloc, 'link'))
    if (!title || !link) continue
    // guid absent → le lien fait clé. Déterministe dans les deux cas : c'est ce
    // qui rend l'UPSERT idempotent d'un passage de cron à l'autre.
    const guid = (champ(bloc, 'guid') || link).slice(0, MAX_ID_LEN)
    out.push({
      guid,
      title,
      link,
      description: champ(bloc, 'description'),
      published_at: dateIso(champ(bloc, 'pubDate'))
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Écriture.
// ---------------------------------------------------------------------------

// UPSERT … SET par guid. Le record id EST le guid : re-ramasser le même article
// réécrit le même record, jamais un doublon (l'index UNIQUE le garantit en plus).
//
// published_at passe par type::datetime($iso) : une chaîne ISO en $binding n'est
// PAS coercée en datetime par SurrealDB v2 (cf. createSession, surreal-adapter).
// pubDate illisible → on ne devine pas : la date de PREMIER ramassage fait date,
// et les passages suivants la conservent (sinon l'article remonterait en tête du
// bandeau toutes les quinze minutes, éternellement).
async function ecrireActualite(db, item) {
  const params = {
    id: item.guid,
    guid: item.guid,
    title: item.title,
    link: item.link,
    description: item.description,
    source: SOURCE
  }
  let published = 'published_at = IF published_at = NONE THEN time::now() ELSE published_at END'
  if (item.published_at) {
    published = 'published_at = type::datetime($published_at)'
    params.published_at = item.published_at
  }
  await db.query(
    `UPSERT type::record("actualites", $id) SET
       guid = $guid,
       title = $title,
       link = $link,
       description = $description,
       source = $source,
       ${published},
       collected_at = time::now()`,
    params
  )
}

// Purge : on ne garde que les MAX_CONSERVEES plus récentes. Le sous-ensemble à
// conserver est calculé UNE fois (LET), pas par ligne. Table de quelques dizaines
// de lignes — aucune agrégation, aucun tri de masse.
async function purger(db) {
  await db.query(
    `LET $garder = (SELECT VALUE id FROM actualites ORDER BY published_at DESC LIMIT ${MAX_CONSERVEES});
     DELETE actualites WHERE id NOT INSIDE $garder;`
  )
}

// ---------------------------------------------------------------------------
// ramasserActualites() — un passage complet. JAMAIS de throw : rend un compte.
// ---------------------------------------------------------------------------

export async function ramasserActualites() {
  const resultat = { lus: 0, ecrits: 0, erreurs: 0 }
  try {
    const res = await politeFetchText(FLUX_URL, { accept: ACCEPT_XML, contentTypeRe: CONTENT_TYPE_XML_RE })
    if (!res) {
      // Réseau, timeout, content-type inattendu ou refus robots — politeFetchText
      // ne distingue pas, et il n'y a rien à distinguer ici : on n'écrit rien.
      console.warn('[actualites] flux injoignable —', FLUX_URL)
      return resultat
    }

    const items = analyserFlux(res.text)
    resultat.lus = items.length
    if (items.length === 0) {
      console.warn('[actualites] flux joignable mais aucun item exploitable')
      return resultat
    }

    const db = await getDb()
    for (const item of items) {
      try {
        await ecrireActualite(db, item)
        resultat.ecrits++
      } catch (e) {
        resultat.erreurs++
        console.warn('[actualites]', String(e?.message || e).slice(0, 80))
      }
    }

    // Purge APRÈS écriture : le stock est au maximum de MAX_CONSERVEES + le lot
    // du jour pendant l'intervalle, jamais durablement.
    if (resultat.ecrits > 0) await purger(db)

    console.log(`[actualites] lus=${resultat.lus} écrits=${resultat.ecrits} erreurs=${resultat.erreurs}`)
  } catch (e) {
    console.error('[actualites]', String(e?.message || e).slice(0, 120))
  }
  return resultat
}

// ---------------------------------------------------------------------------
// lireActualites(n) — les n plus récentes par published_at. Contrairement au
// ramassage, cette fonction LAISSE REMONTER une erreur de base : elle sert une
// requête d'abonné, et c'est à la route de décider du code HTTP. n est borné des
// deux côtés — la limite d'une requête ne se prend jamais telle quelle.
// ---------------------------------------------------------------------------

export async function lireActualites(n = 12) {
  const limite = Math.min(Math.max(Math.floor(Number(n) || 0), 1), MAX_CONSERVEES)
  const db = await getDb()
  const r = await db.query(
    `SELECT title, link, published_at, source FROM actualites ORDER BY published_at DESC LIMIT ${limite}`
  )
  return Array.isArray(r?.[0]) ? r[0] : []
}
