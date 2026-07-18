// Module de LECTURE référentiel-first — reconstruit des fiches au format Etalab
// depuis referentiel_societes, applique l'opt-out, et rend { results, raw_count }.
//
// NON CÂBLÉ dans ce commit : aucun autre fichier ne l'importe. Le branchement de
// la gate référentiel-first dans /api/search se fera dans un commit séparé. Ce
// module est volontairement autonome et testable en isolation.
//
// Doctrine (décisions actées, cf. brief lecture référentiel-first) :
//  • D1 : on NE repasse PAS keepLead (les fiches ont déjà passé keepLead à
//    l'écriture — upsertReferentiel appelé après le filtre server.js:2009). On
//    applique UNIQUEMENT l'opt-out (checkBlocklistBatch), réplique server.js:457-461.
//    La dédup pipeline sera gérée au futur branchement.
//  • D2/D4 : HIT si COUNT de fiches FRAÎCHES (refreshed_at > now - TTL) > 0.
//  • D3 : le NAF de recherche est normalisé au FORMAT STOCKÉ (pointé, ex. 47.78Z).
//  • D5 : capital / date_creation laissés vides (rendu dégradé accepté).
//  • TTL = REFERENTIEL_TTL_DAYS jours.
//
// referentiel.js (écriture) reste strictement inchangé et n'importe pas ce module.

import { getDb } from '../../lib/surreal.js'
import { checkBlocklistBatch } from './optout.js'

// TTL de fraîcheur du référentiel. Au-delà, une fiche n'est plus considérée
// « fraîche » (MISS → Etalab ré-alimente). Exprimé en SurrealQL par un littéral
// de durée `<TTL>d` — forme confirmée en 2.6.5 (cf. server.js:2336 `time::now() - 24h`).
export const REFERENTIEL_TTL_DAYS = 30
const FRESH_CLAUSE = `refreshed_at > time::now() - ${REFERENTIEL_TTL_DAYS}d`

// Coercition string sûre (calque referentiel.js) : jamais null/undefined, toujours trimée.
const str = v => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()))

// Réplique locale de PLM_ARRONDISSEMENTS (server.js:1925) — importer server.js
// créerait un cycle server.js ⇄ referentiel-read.js. Une commune PLM (code ville)
// est détendue vers la liste de ses arrondissements INSEE, tels que STOCKÉS dans
// referentiel_societes (Etalab renvoie l'arrondissement, pas le code ville).
const PLM_ARRONDISSEMENTS = {
  '75056': Array.from({ length: 20 }, (_, i) => String(75101 + i)), // Paris     75101–75120
  '69123': Array.from({ length: 9 },  (_, i) => String(69381 + i)), // Lyon      69381–69389
  '13055': Array.from({ length: 16 }, (_, i) => String(13201 + i)), // Marseille 13201–13216
}

// Détente PLM d'une commune → array de codes commune pour `commune IN $communes`.
// Commune vide → [] (l'appelant omet la clause). Non-PLM → [code] tel quel.
function communesFor(commune) {
  const c = str(commune)
  if (!c) return []
  return PLM_ARRONDISSEMENTS[c] || [c]
}

// Normalise le NAF au FORMAT STOCKÉ (pointé, ex. 47.78Z). Mirroir strict de
// server.js:493-496 : insère le point après les 2 premiers caractères si absent.
function normalizeNaf(naf) {
  const n = str(naf)
  if (n.length >= 4 && n.indexOf('.') === -1) return n.substring(0, 2) + '.' + n.substring(2)
  return n
}

// Construit la clause WHERE partagée (lecture + count) + ses params bindés.
// Retourne { clause: '', params: {} } si departement ou naf manquant → l'appelant
// rend vide (fail-safe MISS, aucune requête tous-azimuts).
function buildWhere({ departement, naf, commune }) {
  const d = str(departement)
  const n = normalizeNaf(naf)
  if (!d || !n) return { clause: '', params: {} }
  const params = { d, n }
  const parts = ['departement = $d', 'naf = $n']
  const communes = communesFor(commune)
  if (communes.length) { parts.push('commune IN $communes'); params.communes = communes }
  parts.push(FRESH_CLAUSE)
  return { clause: parts.join(' AND '), params }
}

// ── A. referentielRowToFiche(row) — PURE, aucun IO ──
// Reconstruit une fiche au format Etalab consommable par le front SANS distinction
// entre une fiche référentiel et une fiche Etalab live. Gardes défensives : les
// listes dirigeants / etablissements peuvent être absentes (fiches anciennes,
// pré-enrichissement) → traitées comme []. capital / date_creation laissés vides (D5).
export function referentielRowToFiche(row) {
  const r = row || {}
  const naf = str(r.naf)

  const dirigeantsRaw = Array.isArray(r.dirigeants) ? r.dirigeants : []
  const etabsRaw = Array.isArray(r.etablissements) ? r.etablissements : []

  // Un établissement stocké → une entrée matching_etablissements[] au format Etalab.
  // activite_principale de l'étab = naf de la fiche (le NAF n'est pas stocké par étab).
  const mapEtab = e => ({
    siret: str(e.siret),
    adresse: str(e.adresse),
    code_postal: str(e.code_postal),
    commune: str(e.commune),
    libelle_commune: str(e.ville),
    latitude: e.lat,
    longitude: e.lng,
    est_siege: e.est_siege === true,
    etat_administratif: str(e.etat_administratif),
    activite_principale: naf
  })

  const matching_etablissements = etabsRaw
    .filter(e => e && typeof e === 'object')
    .map(mapEtab)

  const dirigeants = dirigeantsRaw
    .filter(d => d && typeof d === 'object')
    .map(d => ({
      nom: str(d.nom),
      prenom: str(d.prenom),
      prenoms: str(d.prenom),
      qualite: str(d.fonction),
      type_dirigeant: 'personne physique'
    }))

  const raison = str(r.raison_sociale)
  const nb = Number(r.nombre_etablissements)

  const fiche = {
    siren: str(r.siren),
    nom_raison_sociale: raison,
    nom_complet: raison,
    raison_sociale: raison,
    // REMAP : forme_juridique_code stocke la nature_juridique Etalab telle quelle
    // (cf. referentiel.js:244-245) → on la restitue sur nature_juridique.
    nature_juridique: str(r.forme_juridique_code),
    activite_principale: naf,                     // racine (fallback front)
    activite_principale_libelle: str(r.naf_libelle),
    etat_administratif: str(r.etat_administratif),
    nombre_etablissements: Number.isFinite(nb) ? nb : matching_etablissements.length,
    date_creation: '',                            // D5 : dégradé
    capital: '',                                  // D5 : dégradé
    dirigeants,
    matching_etablissements
  }

  // siege = l'étab est_siege === true, mappé idem ; omis si aucun (fallbacks front).
  const siegeEtab = etabsRaw.find(e => e && typeof e === 'object' && e.est_siege === true)
  if (siegeEtab) fiche.siege = mapEtab(siegeEtab)

  return fiche
}

// ── B. readReferentiel(...) — async, fail-safe ──
// Lit une page de referentiel_societes (fiches FRAÎCHES uniquement), reconstruit
// les fiches, applique l'opt-out en un seul batch, et rend { results, raw_count }.
// Tout échec → { results: [], raw_count: 0 } (fail-safe vers MISS, jamais de throw).
export async function readReferentiel({ departement, naf, commune, page = 1, perPage = 25 } = {}) {
  try {
    const { clause, params } = buildWhere({ departement, naf, commune })
    if (!clause) return { results: [], raw_count: 0 }

    const size = Math.max(1, Math.floor(Number(perPage) || 25))
    const p = Math.max(1, Math.floor(Number(page) || 1))
    const offset = (p - 1) * size

    // index idx_ref_dept_naf (departement, naf) ; ORDER BY siret → pagination stable.
    const sql = `SELECT * FROM referentiel_societes WHERE ${clause} ORDER BY siret LIMIT ${size} START ${offset}`
    const db = await getDb()
    const r = await db.query(sql, params)
    const rows = r[0] || []

    // On garde le couple (row, fiche) : l'opt-out doit voir le SIRET racine du row
    // (row.siret), pas seulement les SIRET des établissements reconstruits.
    const built = rows.map(row => ({ row, fiche: referentielRowToFiche(row) }))

    // Opt-out : collecter TOUS les SIRET (racine + etablissements[] + siège), un
    // seul checkBlocklistBatch, dropper toute fiche dont un quelconque SIRET est
    // bloqué (réplique keepLead server.js:457-461).
    const allSirets = []
    for (const { row, fiche } of built) {
      const rootSiret = str(row.siret)
      if (rootSiret) allSirets.push(rootSiret)
      for (const e of fiche.matching_etablissements) if (e.siret) allSirets.push(e.siret)
      if (fiche.siege && fiche.siege.siret) allSirets.push(fiche.siege.siret)
    }
    const blocked = await checkBlocklistBatch(allSirets)

    const results = built
      .filter(({ row, fiche }) => {
        if (!blocked.size) return true
        if (str(row.siret) && blocked.has(str(row.siret))) return false
        if (fiche.matching_etablissements.some(e => e.siret && blocked.has(e.siret))) return false
        if (fiche.siege && fiche.siege.siret && blocked.has(fiche.siege.siret)) return false
        return true
      })
      .map(({ fiche }) => fiche)

    return { results, raw_count: results.length }
  } catch (e) {
    console.warn('[referentiel-read]', String(e?.message || e).slice(0, 80))
    return { results: [], raw_count: 0 }
  }
}

// ── C. countReferentielFresh(...) — async, fail-safe ──
// COUNT des fiches FRAÎCHES sur le même WHERE (hors opt-out). Sert total_results ET
// la décision HIT/MISS (> 0 ⇒ HIT). Tout échec → 0 (fail-safe vers MISS).
export async function countReferentielFresh({ departement, naf, commune } = {}) {
  try {
    const { clause, params } = buildWhere({ departement, naf, commune })
    if (!clause) return 0
    const sql = `SELECT count() FROM referentiel_societes WHERE ${clause} GROUP ALL`
    const db = await getDb()
    const r = await db.query(sql, params)
    const rows = r[0] || []
    return Number(rows[0]?.count) || 0
  } catch (e) {
    console.warn('[referentiel-read]', String(e?.message || e).slice(0, 80))
    return 0
  }
}

// ── D. getReferentielContactBySiret(siret) — async, fail-safe ──
// Lecture unitaire des champs contact société (website / societe_email /
// societe_tel) pour un SIRET donné, tels qu'alimentés par l'amorçage Overpass.
// Clé SIRET UNIQUE (idx_ref_siret) → LIMIT 1. SIRET normalisé (espaces retirés)
// comme partout ailleurs. Rend { website, societe_email, societe_tel } ou null
// si absent. Tout échec → null (fail-safe, jamais de throw remontant).
export async function getReferentielContactBySiret(siret) {
  try {
    const s = str(siret).replace(/\s+/g, '')
    if (!s) return null
    const sql = 'SELECT website, societe_email, societe_tel FROM referentiel_societes WHERE siret = $siret LIMIT 1'
    const db = await getDb()
    const r = await db.query(sql, { siret: s })
    const row = (r[0] || [])[0]
    if (!row) return null
    return {
      website: str(row.website),
      societe_email: str(row.societe_email),
      societe_tel: str(row.societe_tel)
    }
  } catch (e) {
    console.warn('[referentiel-read]', String(e?.message || e).slice(0, 80))
    return null
  }
}

// ── E. getReferentielFaisceauBySiret(siret) — async, fail-safe ──
// FAISCEAU COMPLET d'un SIRET pour le crawl mentions légales (mentions-legales.js) :
// identité (siren/siret/raison_sociale), adresse décomposée (voie + CP + ville) pour
// la concordance, website déjà en base (maillon 1.a), dirigeant_nom (VALIDATEUR de
// concordance UNIQUEMENT — jamais réécrit ni exposé), et l'horodatage d'idempotence
// mentions_legales_checked_at. Clé SIRET UNIQUE (idx_ref_siret) → LIMIT 1. SIRET
// normalisé (espaces retirés). Rend l'objet faisceau ou null (absent / tout échec —
// fail-safe, jamais de throw remontant).
export async function getReferentielFaisceauBySiret(siret) {
  try {
    const s = str(siret).replace(/\s+/g, '')
    if (!s) return null
    const sql =
      'SELECT siren, siret, raison_sociale, adresse, code_postal, ville, ' +
      'numero_voie, type_voie, libelle_voie, website, dirigeant_nom, ' +
      'mentions_legales_checked_at ' +
      'FROM referentiel_societes WHERE siret = $siret LIMIT 1'
    const db = await getDb()
    const r = await db.query(sql, { siret: s })
    const row = (r[0] || [])[0]
    if (!row) return null
    return {
      siren: str(row.siren),
      siret: str(row.siret),
      raison_sociale: str(row.raison_sociale),
      adresse: str(row.adresse),
      code_postal: str(row.code_postal),
      ville: str(row.ville),
      numero_voie: str(row.numero_voie),
      type_voie: str(row.type_voie),
      libelle_voie: str(row.libelle_voie),
      website: str(row.website),
      dirigeant_nom: str(row.dirigeant_nom),
      // Horodatage brut (datetime SurrealDB) — l'appelant décide du TTL. null si NONE.
      mentions_legales_checked_at: row.mentions_legales_checked_at ?? null
    }
  } catch (e) {
    console.warn('[referentiel-read]', String(e?.message || e).slice(0, 80))
    return null
  }
}
