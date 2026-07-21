// Service Overpass — connecteur isolé vers l'API OpenStreetMap Overpass.
// NON branché : aucun import dans server.js, aucun appel au démarrage.
// Objectif : récupérer des POI (points d'intérêt) par département + sélecteur OSM,
// les normaliser, et pouvoir corroborer un SIRET/SIREN.
//
// Robustesse : jamais de throw non maîtrisé côté caller — fetchOverpass rend
// un tableau (vide si l'API est indisponible). Rate-limit interne séquentiel
// pour ne jamais saturer les slots publics d'Overpass.

import { enrichReferentielActionnable, communeToDepartement } from './referentiel.js'
import { getDb } from '../../lib/surreal.js'

const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter'

// Overpass refuse (HTTP 406) les requêtes sans User-Agent explicite.
const USER_AGENT = 'MovUP/1.0 (+https://movup.fr)'

// Couple pilote unique NAF → sélecteur OSM.
export const NAF_TO_OSM = {
  '4778A': 'shop=optician'
}

// Bbox départementales : [latMin, lonMin, latMax, lonMax] (sud, ouest, nord, est).
// Structure extensible — ajouter un département = ajouter une ligne.
export const DEPT_BBOX = {
  '22': [48.02, -3.63, 48.90, -1.99], // Côtes-d'Armor
  '29': [47.72, -5.15, 48.76, -3.38], // Finistère
  '35': [47.63, -2.31, 48.70, -1.16], // Ille-et-Vilaine
  '56': [47.28, -3.57, 48.20, -2.03]  // Morbihan
  // Table à compléter (96 depts métropolitains) avant prospection nationale.
}

// ---------------------------------------------------------------------------
// Rate-limit : file séquentielle interne. Un seul verrou (chaîne de promesses)
// + délai minimal entre deux appels réseau. On reste volontairement sous le
// plafond des deux slots publics Overpass en sérialisant les requêtes.
// ---------------------------------------------------------------------------

const MIN_INTERVAL_MS = 1100
const MAX_RETRIES_429 = 2

let queueTail = Promise.resolve()
let lastCallAt = 0

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Sérialise `task` derrière la file et respecte l'espacement minimal.
function schedule(task) {
  const run = async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastCallAt)
    if (wait > 0) await sleep(wait)
    lastCallAt = Date.now()
    return task()
  }
  const p = queueTail.then(run, run)
  // La file survit quel que soit le résultat de la tâche.
  queueTail = p.then(() => {}, () => {})
  return p
}

// ---------------------------------------------------------------------------
// Construction de la requête Overpass QL.
// ---------------------------------------------------------------------------

// Transforme un sélecteur "key=value" en filtre Overpass ["key"="value"].
function selectorToFilter(osmSelector) {
  const raw = String(osmSelector || '').trim()
  const eq = raw.indexOf('=')
  if (eq === -1) return null
  const key = raw.slice(0, eq).trim()
  const value = raw.slice(eq + 1).trim()
  if (!key || !value) return null
  return `["${key}"="${value}"]`
}

function buildQuery(bbox, filter) {
  const [latMin, lonMin, latMax, lonMax] = bbox
  const box = `${latMin},${lonMin},${latMax},${lonMax}`
  return [
    '[out:json][timeout:60];',
    '(',
    `  node${filter}(${box});`,
    `  way${filter}(${box});`,
    `  relation${filter}(${box});`,
    ');',
    'out center tags;'
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Normalisation d'un élément Overpass en POI.
// ---------------------------------------------------------------------------

function normalizePoi(el) {
  const t = el.tags || {}

  const phone = t['phone'] || t['contact:phone'] || null
  const website = t['website'] || t['contact:website'] || t['url'] || null

  // Email — extrait tel quel : un email taggé sur le POI d'un commerce est par
  // construction le contact professionnel de l'établissement (la provenance
  // qualifie la donnée). Le rejet des formes nominatives relève de la couche
  // crawl mentions légales, pas ici.
  const email = t['email'] || t['contact:email'] || null

  const siret = t['ref:FR:SIRET']
    ? String(t['ref:FR:SIRET']).replace(/\s+/g, '')
    : null
  const siren = t['ref:FR:SIREN']
    ? String(t['ref:FR:SIREN']).replace(/\s+/g, '')
    : (siret ? siret.slice(0, 9) : null)

  return {
    name: t['name'] || null,
    siret,
    siren,
    website,
    phone,
    email,
    housenumber: t['addr:housenumber'] || t['contact:housenumber'] || null,
    street: t['addr:street'] || t['contact:street'] || null,
    postcode: t['addr:postcode'] || t['contact:postcode'] || null,
    city: t['addr:city'] || t['contact:city'] || null,
    brand: t['brand'] || null
  }
}

// ---------------------------------------------------------------------------
// fetchOverpass(dept, osmSelector) → tableau de POI normalisés.
// Rend [] si département/sélecteur inconnu ou API indisponible (jamais de throw).
// ---------------------------------------------------------------------------

export async function fetchOverpass(dept, osmSelector) {
  const bbox = DEPT_BBOX[String(dept)]
  if (!bbox) {
    console.error('[overpass] bbox manquante pour le département', dept)
    return []
  }
  const filter = selectorToFilter(osmSelector)
  if (!filter) {
    console.error('[overpass] sélecteur OSM invalide', osmSelector)
    return []
  }

  const query = buildQuery(bbox, filter)

  return schedule(async () => {
    for (let attempt = 0; attempt <= MAX_RETRIES_429; attempt++) {
      try {
        const r = await fetch(OVERPASS_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
            'User-Agent': USER_AGENT
          },
          body: 'data=' + encodeURIComponent(query)
        })

        if (r.status === 429) {
          if (attempt < MAX_RETRIES_429) {
            const backoff = MIN_INTERVAL_MS * Math.pow(2, attempt + 1)
            console.error(`[overpass] 429 — backoff ${backoff}ms (tentative ${attempt + 1})`)
            await sleep(backoff)
            continue
          }
          console.error('[overpass] 429 — abandon après retries')
          return []
        }

        if (!r.ok) {
          console.error('[overpass] HTTP', r.status)
          return []
        }

        const data = await r.json()
        const elements = Array.isArray(data?.elements) ? data.elements : []
        return elements.map(normalizePoi)
      } catch (e) {
        console.error('[overpass] fetch crash', e.message)
        return []
      }
    }
    return []
  })
}

// ---------------------------------------------------------------------------
// corroborerSiret(poi, sirenCible) — fonction pure.
// true si le POI porte le SIREN cible, soit directement, soit via son SIRET.
// ---------------------------------------------------------------------------

export function corroborerSiret(poi, sirenCible) {
  const cible = String(sirenCible || '').replace(/\s+/g, '')
  if (!cible) return false
  const sirenPoi = poi?.siren || poi?.siret?.slice(0, 9) || null
  return sirenPoi === cible
}

// ---------------------------------------------------------------------------
// amorcerOverpass(leads) — orchestration isolée (NON branchée dans server.js).
// Reçoit data.results de /api/search (fiches Etalab recherche-entreprises),
// interroge Overpass sur le département + le NAF du premier lead, apparie les
// POI aux leads (doctrine dédup du 18 juin), et enrichit le référentiel
// mutualisé en fill-if-empty. Aucun throw remontant.
// ---------------------------------------------------------------------------

// Normalisation texte pour l'appariement nom/ville :
// minuscule, sans accents, ponctuation → espace, espaces compactés.
// Exportée : réutilisée par le crawl mentions légales (concordance de faisceau).
export function normText(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// Établissement servi à l'abonné : matching_etablissements[0], repli siège.
// Aligné sur upsertReferentiel (referentiel.js) — même établissement, même clé.
function pickEtab(fiche) {
  const matching = Array.isArray(fiche?.matching_etablissements) ? fiche.matching_etablissements : []
  return matching[0] || fiche?.siege || null
}

// Réduit une fiche Etalab aux seuls champs utiles à l'appariement + à la clé
// d'écriture (SIRET de l'établissement local).
function leadHandle(fiche) {
  const etab = pickEtab(fiche)
  return {
    siren: String(fiche?.siren || '').replace(/\s+/g, ''),
    siret: etab ? String(etab.siret || '').replace(/\s+/g, '') : '',
    raison_sociale: String(fiche?.nom_complet || fiche?.nom_raison_sociale || ''),
    ville: etab ? String(etab.libelle_commune || '') : ''
  }
}

export async function amorcerOverpass(leads) {
  try {
    if (!Array.isArray(leads) || leads.length === 0) return

    // 1. Département + NAF déduits du premier lead. NAF hors table → silencieux.
    const firstEtab = pickEtab(leads[0])
    const naf = String(leads[0]?.activite_principale || firstEtab?.activite_principale || '')
      .replace(/\./g, '')
    const osmSelector = NAF_TO_OSM[naf]
    if (!osmSelector) return
    const departement = communeToDepartement(firstEtab?.commune)
    if (!departement) return

    // 2. POI Overpass normalisés.
    const pois = await fetchOverpass(departement, osmSelector)

    // Handles de leads — seuls ceux dotés d'un SIRET (clé d'écriture indispensable).
    const handles = leads.map(leadHandle).filter(h => h.siret)

    let matchedSiret = 0
    let matchedNomVille = 0
    let written = 0

    for (const poi of pois) {
      // 3.a — SIRET : match certain.
      let lead = handles.find(h => corroborerSiret(poi, h.siren))
      let viaSiret = !!lead

      // 3.b — sinon raison sociale normalisée + ville (les deux concordent).
      //       Le nom seul n'est jamais décisif.
      if (!lead) {
        const pn = normText(poi.name)
        const pc = normText(poi.city)
        if (pn && pc) {
          lead = handles.find(h => normText(h.raison_sociale) === pn && normText(h.ville) === pc)
        }
      }

      if (!lead) continue   // POI non apparié → ignoré (pas d'écriture orpheline).

      if (viaSiret) matchedSiret++
      else matchedNomVille++

      // 4. Enrichissement fill-if-empty, clé = SIRET du lead.
      const fields = {}
      if (poi.website) fields.website = poi.website
      if (poi.email) fields.societe_email = poi.email
      if (poi.phone) fields.societe_tel = poi.phone
      if (Object.keys(fields).length === 0) continue

      await enrichReferentielActionnable(lead.siret, fields)
      written++
    }

    console.log(
      `[overpass-amorce] reçus=${pois.length} appariés_siret=${matchedSiret} ` +
      `appariés_nom_ville=${matchedNomVille} écrits=${written}`
    )
  } catch (e) {
    console.error('[overpass-amorce]', String(e?.message || e).slice(0, 120))
  }
}

// ---------------------------------------------------------------------------
// amorcerOverpassDeptNaf(dept, naf) — variante lisant le référentiel en base.
// NON branchée. Contrairement à amorcerOverpass (qui reçoit des leads Etalab),
// dept + naf sont fournis explicitement et les cibles d'appariement sont lues
// dans referentiel_societes via l'index idx_ref_dept_naf. Même doctrine dédup
// (18 juin) : SIRET certain, sinon nom + ville concordants (nom seul jamais
// décisif). Écriture fill-if-empty via enrichReferentielActionnable. Aucun throw
// remontant.
// ---------------------------------------------------------------------------

export async function amorcerOverpassDeptNaf(dept, naf) {
  console.log(`[overpass-amorce-deptnaf] ENTER dept=${dept} naf=${naf}`)
  try {
    const departement = String(dept || '')
    const nafCode = String(naf || '').replace(/\./g, '')

    // 1. Sélecteur OSM résolu via la table NAF. Absent → silencieux.
    const osmSelector = NAF_TO_OSM[nafCode]
    if (!osmSelector) return

    // 2. Cibles d'appariement lues dans le référentiel. Le filtre porte sur le
    //    département seul (indexé) ; l'appariement NAF se fait en JS pour rester
    //    insensible au point (base : "47.78A", nafCode strippé : "4778A").
    const db = await getDb()
    const res = await db.query(
      'SELECT siret, siren, raison_sociale, ville, naf FROM referentiel_societes ' +
      'WHERE departement = $dept',
      { dept: departement }
    )
    const rows = (Array.isArray(res?.[0]) ? res[0] : [])
      .filter(r => String(r?.naf || '').replace(/\./g, '') === nafCode)

    // Seuls les records dotés d'un SIRET (clé d'écriture indispensable).
    const handles = rows
      .map(r => ({
        siren: String(r?.siren || '').replace(/\s+/g, ''),
        siret: String(r?.siret || '').replace(/\s+/g, ''),
        raison_sociale: String(r?.raison_sociale || ''),
        ville: String(r?.ville || '')
      }))
      .filter(h => h.siret)

    // 3. POI Overpass normalisés.
    const pois = await fetchOverpass(departement, osmSelector)

    let matchedSiret = 0
    let matchedNomVille = 0
    let written = 0

    for (const poi of pois) {
      // 5.a — SIRET : match certain.
      let record = handles.find(h => corroborerSiret(poi, h.siren))
      let viaSiret = !!record

      // 5.b — sinon raison sociale normalisée + ville (les deux concordent).
      //       Le nom seul n'est jamais décisif.
      if (!record) {
        const pn = normText(poi.name)
        const pc = normText(poi.city)
        if (pn && pc) {
          record = handles.find(h => normText(h.raison_sociale) === pn && normText(h.ville) === pc)
        }
      }

      if (!record) continue   // POI non apparié → ignoré (pas d'écriture orpheline).

      if (viaSiret) matchedSiret++
      else matchedNomVille++

      // 6. Enrichissement fill-if-empty, clé = SIRET du record.
      const fields = {}
      if (poi.website) fields.website = poi.website
      if (poi.email) fields.societe_email = poi.email
      if (poi.phone) fields.societe_tel = poi.phone
      if (Object.keys(fields).length === 0) continue

      await enrichReferentielActionnable(record.siret, fields)
      written++
    }

    console.log(
      `[overpass-amorce-deptnaf] reçus=${pois.length} appariés_siret=${matchedSiret} ` +
      `appariés_nom_ville=${matchedNomVille} écrits=${written}`
    )
  } catch (e) {
    console.error('[overpass-amorce-deptnaf]', String(e?.message || e).slice(0, 120))
  }
}
