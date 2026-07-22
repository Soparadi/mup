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
// Source : france-geojson (contours IGN ADMIN EXPRESS), bbox calculée en local.
export const DEPT_BBOX = {
  '01': [45.61, 4.72, 46.52, 6.18],
  '02': [48.83, 2.95, 50.07, 4.26],
  '03': [45.93, 2.27, 46.81, 4.01],
  '04': [43.66, 5.49, 44.66, 6.97],
  '05': [44.18, 5.41, 45.13, 7.08],
  '06': [43.48, 6.63, 44.37, 7.72],
  '07': [44.26, 3.86, 45.37, 4.89],
  '08': [49.22, 4.02, 50.17, 5.4],
  '09': [42.57, 0.82, 43.32, 2.18],
  '10': [47.92, 3.38, 48.72, 4.87],
  '11': [42.64, 1.68, 43.47, 3.25],
  '12': [43.69, 1.83, 44.95, 3.46],
  '13': [43.15, 4.23, 43.93, 5.82],
  '14': [48.75, -1.16, 49.43, 0.45],
  '15': [44.61, 2.06, 45.49, 3.38],
  '16': [45.19, -0.47, 46.15, 0.95],
  '17': [45.08, -1.57, 46.38, 0.01],
  '18': [46.42, 1.77, 47.63, 3.08],
  '19': [44.92, 1.22, 45.77, 2.53],
  '2A': [41.33, 8.53, 42.39, 9.41],
  '2B': [41.83, 8.57, 43.03, 9.56],
  '21': [46.9, 4.06, 48.04, 5.52],
  '22': [48.03, -3.67, 48.91, -1.9],
  '23': [45.66, 1.37, 46.46, 2.62],
  '24': [44.57, -0.05, 45.72, 1.45],
  '25': [46.55, 5.69, 47.58, 7.07],
  '26': [44.11, 4.64, 45.35, 5.84],
  '27': [48.66, 0.29, 49.49, 1.81],
  '28': [47.95, 0.75, 48.95, 2],
  '29': [47.7, -5.15, 48.76, -3.38],
  '30': [43.46, 3.26, 44.46, 4.85],
  '31': [42.68, 0.44, 43.93, 2.05],
  '32': [43.31, -0.29, 44.08, 1.21],
  '33': [44.19, -1.27, 45.58, 0.32],
  '34': [43.21, 2.54, 43.98, 4.2],
  '35': [47.63, -2.29, 48.72, -1.01],
  '36': [46.34, 0.86, 47.28, 2.21],
  '37': [46.73, 0.05, 47.71, 1.37],
  '38': [44.69, 4.74, 45.89, 6.36],
  '39': [46.26, 5.25, 47.31, 6.21],
  '40': [43.48, -1.53, 44.54, 0.14],
  '41': [47.18, 0.58, 48.14, 2.25],
  '42': [45.23, 3.68, 46.28, 4.77],
  '43': [44.74, 3.08, 45.43, 4.5],
  '44': [46.86, -2.63, 47.84, -0.94],
  '45': [47.48, 1.51, 48.35, 3.13],
  '46': [44.2, 0.98, 45.05, 2.22],
  '47': [43.97, -0.15, 44.77, 1.08],
  '48': [44.1, 2.98, 44.98, 4],
  '49': [46.96, -1.36, 47.82, 0.24],
  '50': [48.45, -1.95, 49.73, -0.73],
  '51': [48.51, 3.39, 49.41, 5.04],
  '52': [47.57, 4.62, 48.69, 5.9],
  '53': [47.73, -1.24, 48.57, -0.04],
  '54': [48.34, 5.42, 49.57, 7.13],
  '55': [48.4, 4.88, 49.62, 5.86],
  '56': [47.27, -3.74, 48.22, -2.03],
  '57': [48.52, 5.89, 49.52, 7.65],
  '58': [46.65, 2.84, 47.59, 4.24],
  '59': [49.96, 2.06, 51.09, 4.24],
  '60': [49.06, 1.68, 49.77, 3.17],
  '61': [48.17, -0.87, 48.98, 0.98],
  '62': [50.01, 1.55, 51.01, 3.19],
  '63': [45.28, 2.38, 46.26, 3.99],
  '64': [42.77, -1.8, 43.6, 0.03],
  '65': [42.67, -0.33, 43.62, 0.65],
  '66': [42.33, 1.72, 42.92, 3.18],
  '67': [48.12, 6.94, 49.08, 8.24],
  '68': [47.42, 6.84, 48.32, 7.63],
  '69': [45.45, 4.24, 46.31, 5.17],
  '70': [47.25, 5.36, 48.03, 6.83],
  '71': [46.15, 3.62, 47.16, 5.47],
  '72': [47.56, -0.45, 48.49, 0.92],
  '73': [45.05, 5.62, 45.94, 7.19],
  '74': [45.68, 5.8, 46.41, 7.05],
  '75': [48.81, 2.22, 48.91, 2.47],
  '76': [49.25, 0.06, 50.08, 1.8],
  '77': [48.12, 2.39, 49.12, 3.56],
  '78': [48.43, 1.44, 49.09, 2.23],
  '79': [45.96, -0.91, 47.11, 0.23],
  '80': [49.57, 1.38, 50.37, 3.21],
  '81': [43.38, 1.53, 44.21, 2.94],
  '82': [43.76, 0.73, 44.4, 2.01],
  '83': [42.98, 5.65, 43.81, 6.94],
  '84': [43.65, 4.64, 44.44, 5.76],
  '85': [46.26, -2.41, 47.09, -0.53],
  '86': [46.04, -0.11, 47.18, 1.22],
  '87': [45.43, 0.62, 46.41, 1.92],
  '88': [47.81, 5.39, 48.52, 7.2],
  '89': [47.31, 2.84, 48.4, 4.35],
  '90': [47.43, 6.75, 47.83, 7.15],
  '91': [48.28, 1.91, 48.78, 2.59],
  '92': [48.72, 2.14, 48.96, 2.34],
  '93': [48.8, 2.28, 49.02, 2.61],
  '94': [48.68, 2.3, 48.87, 2.62],
  '95': [48.9, 1.6, 49.25, 2.6]
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
