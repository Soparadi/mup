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

// Filtre d'activité : on ne SERT et ne COMPTE que les établissements ACTIFS.
// Égalité STRICTE 'A' — la mesure l'a établi : aucune ligne du stock ne porte
// d'état absent (NONE/'' inexistant sur referentiel_societes), donc `= 'A'` ne
// laisse échapper aucune fiche active. etat_administratif porte l'ÉTAT DE
// L'ÉTABLISSEMENT servi (upsert stocke l'étab d'abord, cf. referentiel.js:403).
// Les fiches fermées RESTENT en base (mémoire négative — évite de les redemander
// à la source) mais sont écartées à la lecture. Comme cette clause vit dans
// buildWhere, elle alimente d'un seul geste readReferentiel ET countReferentielFresh :
// recherche en cache, comptage/total, démo publique et porte de complétude (fiches_count).
const ACTIVE_CLAUSE = "etat_administratif = 'A'"

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
// EXPORTÉ (et non dupliqué ailleurs) : markGisementComplete compose la clé du
// marqueur de gisement avec ce NAF pointé. Deux implémentations divergentes
// produiraient "4778Z:35" et "47.78Z:35" pour le même gisement — une seule
// source de vérité pour la normalisation.
export function normalizeNaf(naf) {
  const n = str(naf)
  if (n.length >= 4 && n.indexOf('.') === -1) return n.substring(0, 2) + '.' + n.substring(2)
  return n
}

// Construit la clause WHERE partagée (lecture + count) + ses params bindés.
// Retourne { clause: '', params: {} } si departement ou naf manquant → l'appelant
// rend vide (fail-safe MISS, aucune requête tous-azimuts).
function buildWhere({ departement, naf, commune, codePostal }) {
  const d = str(departement)
  const n = normalizeNaf(naf)
  if (!d || !n) return { clause: '', params: {} }
  const params = { d, n }
  const parts = ['departement = $d', 'naf = $n', ACTIVE_CLAUSE]
  const communes = communesFor(commune)
  if (communes.length) { parts.push('commune IN $communes'); params.communes = communes }
  // Code postal : colonne `code_postal` distincte du code INSEE `commune`. Le walker
  // multi-CP envoie un CP par tranche (code_commune vide) → égalité stricte, un seul
  // CP à la fois. commune et codePostal sont mutuellement exclusifs en pratique, mais
  // si les deux arrivent les deux clauses s'ajoutent (AND).
  const cp = str(codePostal)
  if (cp) { parts.push('code_postal = $cp'); params.cp = cp }
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
export async function readReferentiel({ departement, naf, commune, codePostal, page = 1, perPage = 25 } = {}) {
  try {
    const { clause, params } = buildWhere({ departement, naf, commune, codePostal })
    if (!clause) return { results: [], raw_count: 0 }

    const size = Math.max(1, Math.floor(Number(perPage) || 25))
    const p = Math.max(1, Math.floor(Number(page) || 1))
    const offset = (p - 1) * size

    // WITH INDEX N'EST PAS UNE PRECAUTION GRATUITE, NE PAS LE RETIRER : laisse libre,
    // le planificateur retient idx_ref_naf (le NAF SEUL) et materialise 8 539 lignes de
    // tous les departements pour n'en garder que 2 387, mesure a 711 ms contre 190 ms
    // en forcant (departement, naf). ORDER BY siret → pagination stable (tri a 4 ms).
    const sql = `SELECT * FROM referentiel_societes WITH INDEX idx_ref_dept_naf WHERE ${clause} ORDER BY siret LIMIT ${size} START ${offset}`
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
export async function countReferentielFresh({ departement, naf, commune, codePostal } = {}) {
  try {
    const { clause, params } = buildWhere({ departement, naf, commune, codePostal })
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

// ── C-bis. countGisementPagine(...) ── async, fail-safe ──
// Le MEME total que countReferentielFresh, mais calcule UNE FOIS PAR RECHERCHE
// au lieu d'une fois par page. Le gisement est invariant le temps d'un
// deroulement : recompter 2 387 lignes a chaque page pour rendre le meme nombre
// est le poste de depense principal de la lecture en cache.
//
// LE SIGNAL, ET POURQUOI IL EST FIABLE. Ce qui arrive au serveur porte deja de
// quoi separer la premiere page des suivantes : le parametre `page` de
// /api/search. Le front l'envoie sur CHAQUE appel (prospection.html, fetchLeads,
// '&page=' + page). Il vaut 1 au lancement (startSearch appelle loadPage(1)) et
// REPART A 1 quand le walker multi-CP enchaine sur la tranche suivante
// (S.upstreamPage remis a 0, loadMore). C'est donc la premiere page DE CE
// GISEMENT-LA, pas la premiere page de la session : exactement la borne
// cherchee, et elle vaut aussi pour le walker, dont chaque tranche a son propre
// total (code postal different, donc filtre different).
//
// LA CLE DU MEMO, C'EST LE FILTRE LUI-MEME, PAS LA RECHERCHE. search_id
// identifie le deroulement, mais un meme search_id change de code postal en
// cours de route (walker multi-CP) : memoriser sous search_id rendrait le total
// de la tranche precedente. On memorise donc sous la clause WHERE et ses
// parametres bindes, c'est-a-dire sous le gisement effectivement interroge. Deux
// abonnees sur le meme gisement partagent le meme compte, ce qui est exact
// puisque le compte ne depend pas d'elles.
//
// LE TOTAL RESTE EXACT. Page 1 compte toujours, et rafraichit le memo. Page > 1
// ne se sert du memo que s'il est present et non perime ; sinon elle recompte,
// exactement comme avant. Un redemarrage, une entree expiree ou une page profonde
// demandee a froid retombent donc sur le comportement d'origine, jamais sur un
// total approche. La fenetre de 10 minutes borne la derive theorique : le chemin
// cache n'ecrit rien, et le gisement est marque complet et frais, donc rien ne
// modifie le compte pendant un deroulement, qui dure des secondes.
const COMPTE_TTL_MS = 10 * 60 * 1000
// Bornes memoire du memo : entrees minuscules (une chaine, un nombre), purge des
// expirees a l'ecriture, et plafond dur en jetant les plus anciennes inserees
// (Map conserve l'ordre d'insertion). Aucune croissance non bornee possible.
const COMPTE_MAX = 500
const comptesGisement = new Map()

export async function countGisementPagine({ departement, naf, commune, codePostal, page } = {}) {
  const { clause, params } = buildWhere({ departement, naf, commune, codePostal })
  if (!clause) return 0
  const cle = clause + '|' + JSON.stringify(params)
  const maintenant = Date.now()

  // Page > 1 : le total a deja ete etabli au debut de ce deroulement.
  if ((Math.floor(Number(page)) || 1) > 1) {
    const garde = comptesGisement.get(cle)
    if (garde && garde.expire > maintenant) return garde.total
  }

  const total = await countReferentielFresh({ departement, naf, commune, codePostal })
  for (const [k, v] of comptesGisement) if (v.expire <= maintenant) comptesGisement.delete(k)
  comptesGisement.delete(cle)
  comptesGisement.set(cle, { total, expire: maintenant + COMPTE_TTL_MS })
  while (comptesGisement.size > COMPTE_MAX) comptesGisement.delete(comptesGisement.keys().next().value)
  return total
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

// ── D-lot. getReferentielContactsBySirets(sirets) — async, fail-open ──
// Forme EN LOT de D, pour la projection des listes privées (/api/contacts,
// /api/pipeline) : une liste porte des dizaines de SIRET, un point-lookup par
// ligne serait des dizaines d'allers-retours. UNE requête par tranche de 100
// (même découpage défensif que checkBlocklistBatch — la liste n'est pas paginée,
// c'est ce découpage qui borne le lot), sur l'index UNIQUE idx_ref_siret.
//
// Rend une Map siret → { website, societe_email, societe_tel, societe_facebook,
// societe_instagram, societe_linkedin }, clés canoniques telles que passées par
// l'appelant (SIRET nettoyés de leurs espaces, comme partout ailleurs). Un SIRET
// absent du référentiel n'a simplement pas d'entrée.
//
// FAIL-OPEN, et c'est la différence de régime avec les lectures ci-dessus : une
// projection est un agrément, pas le contenu de la page. Un échec rend ce qui a
// pu être lu (Map vide au premier échec) — l'appelant sert alors sa liste NON
// PROJETÉE, jamais une erreur.
export async function getReferentielContactsBySirets(sirets) {
  const out = new Map()
  if (!Array.isArray(sirets) || !sirets.length) return out
  const cles = [...new Set(sirets.map(s => str(s).replace(/\s+/g, '')).filter(Boolean))]
  if (!cles.length) return out
  try {
    const db = await getDb()
    const sql =
      'SELECT siret, website, societe_email, societe_tel, ' +
      'societe_facebook, societe_instagram, societe_linkedin ' +
      'FROM referentiel_societes WHERE siret IN $sirets'
    for (let i = 0; i < cles.length; i += 100) {
      const r = await db.query(sql, { sirets: cles.slice(i, i + 100) })
      for (const row of (r[0] || [])) {
        const s = str(row?.siret).replace(/\s+/g, '')
        if (!s) continue
        out.set(s, {
          website: str(row.website),
          societe_email: str(row.societe_email),
          societe_tel: str(row.societe_tel),
          societe_facebook: str(row.societe_facebook),
          societe_instagram: str(row.societe_instagram),
          societe_linkedin: str(row.societe_linkedin)
        })
      }
    }
  } catch (e) {
    console.warn('[referentiel-read]', String(e?.message || e).slice(0, 80))
  }
  return out
}

// ── D-bis. getOsmContactBySiret(siret) — async, fail-safe ──
// Lecture unitaire des contacts OSM (réserve nationale referentiel_osm) pour un
// SIRET donné. Index idx_osm_siret NON unique → PLUSIEURS lignes possibles pour un
// même SIRET (un même établissement peut porter plusieurs objets OSM). On NE fait
// donc PAS de LIMIT 1 : on fusionne champ par champ en retenant la PREMIÈRE VALEUR
// NON VIDE inter-lignes. REMAP vers le contrat societe_* (phone→societe_tel,
// email→societe_email, website→website, facebook→societe_facebook,
// instagram→societe_instagram, linkedin→societe_linkedin). Rend l'objet fusionné
// ou null si aucune ligne. Tout échec → null (fail-safe, jamais de throw remontant).
export async function getOsmContactBySiret(siret) {
  try {
    const s = str(siret).replace(/\s+/g, '')
    if (!s) return null
    const sql = 'SELECT phone, email, website, facebook, instagram, linkedin FROM referentiel_osm WHERE siret = $siret'
    const db = await getDb()
    const r = await db.query(sql, { siret: s })
    const rows = r[0] || []
    if (!rows.length) return null
    // Première valeur non vide inter-lignes pour un champ source donné.
    const firstNonEmpty = key => {
      for (const row of rows) {
        const v = str(row?.[key])
        if (v) return v
      }
      return ''
    }
    return {
      website: firstNonEmpty('website'),
      societe_email: firstNonEmpty('email'),
      societe_tel: firstNonEmpty('phone'),
      societe_facebook: firstNonEmpty('facebook'),
      societe_instagram: firstNonEmpty('instagram'),
      societe_linkedin: firstNonEmpty('linkedin')
    }
  } catch (e) {
    console.warn('[referentiel-read]', String(e?.message || e).slice(0, 80))
    return null
  }
}

// ── D-ter. getOsmSitesBySiret(siret) — async, fail-safe ──
// Les URL que la réserve OSM porte POUR CE SIRET, brutes et TOUTES (pas de fusion :
// l'appelant compare un domaine, il lui faut l'ensemble des candidats, pas seulement
// le premier non vide). Sert au moteur mentions légales à savoir si l'URL qu'il
// s'apprête à lire est ATTESTÉE PAR IDENTIFIANT — même SIRET des deux côtés — ou
// simplement supposée.
//
// UNE requête, sur l'index idx_osm_siret (égalité stricte, jamais de scan) : un
// point-lookup rendant en pratique 0 à 2 lignes, un seul champ projeté. La jointure
// par SIREN n'est PAS tentée : referentiel_osm n'a pas d'index sur siren, un
// `OR siren = $siren` dégraderait la requête en scan des ~685 k lignes de la réserve.
// Rend [] si rien / tout échec (fail-safe, jamais de throw remontant).
export async function getOsmSitesBySiret(siret) {
  try {
    const s = str(siret).replace(/\s+/g, '')
    if (!s) return []
    const sql = 'SELECT website FROM referentiel_osm WHERE siret = $siret'
    const db = await getDb()
    const r = await db.query(sql, { siret: s })
    return (r[0] || []).map(row => str(row?.website)).filter(Boolean)
  } catch (e) {
    console.warn('[referentiel-read]', String(e?.message || e).slice(0, 80))
    return []
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
      'SELECT siren, siret, raison_sociale, enseigne, adresse, code_postal, ville, ' +
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
      enseigne: str(row.enseigne),
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

// ── F. selectSiretsACrawler(dept, limit, naf), async, fail-safe ──
// Sélectionne les SIRET d'un département ET D'UN CODE NAF À CRAWLER par le moteur
// mentions légales (2e source) : fiches qui ONT un website (écrit par le
// rapprochement OSM) mais PAS encore de contact société (tél OU email manquant), et
// dont l'idempotence mentions_legales_checked_at est absente ou périmée (> 30 j).
// Colonne `departement` (jamais `dept`). Params bindés. Rend un tableau de SIRET
// (strings) ou [] (aucun candidat / tout échec, fail-safe, ne casse jamais
// l'enchaînement /api/amorce).
//
// LE NAF EST NORMALISÉ, ET CE N'EST PAS FACULTATIF : la page envoie le code SANS
// POINT (`7311Z`, les option value de prospection.html), referentiel_societes le
// stocke POINTÉ (`73.11Z`). Comparés tels quels, l'égalité ne matcherait jamais et
// le crawl s'éteindrait en silence.
//
// L'INDEX DU COUPLE EST FORCÉ, ET CE N'EST PAS UNE PRÉCAUTION DÉCORATIVE.
// idx_ref_dept_naf (referentiel.js) existe et couvre (departement, naf), mais le
// planificateur ne le choisit PAS de lui-même : laissé libre, il prend idx_ref_naf,
// le code NAF seul, donc le gisement NATIONAL, et post-filtre le département.
// Mesure du 2 septembre sur movup-prod, couple (06, 96.02A) : 8 539 lignes lues en
// 774 ms sans WITH INDEX, 2 387 lignes en 180 ms avec. Le rapport tient de la
// géographie, pas du hasard : un code NAF compte autant de fois qu'il y a de
// départements chargés, et la fenêtre LIMIT ne se remplissant presque jamais, le
// balayage va jusqu'au bout de l'index.
export async function selectSiretsACrawler(dept, limit, naf) {
  try {
    const d = str(dept)
    if (!d) return []
    // NAF absent : on rend vide, jamais une requête tous azimuts. Même doctrine que
    // buildWhere, isGisementComplete et la garde Atout France de /api/amorce.
    const codeNaf = normalizeNaf(naf)
    if (!codeNaf) return []
    const n = Math.max(1, Math.floor(Number(limit) || 50))
    const sql =
      'SELECT siret FROM referentiel_societes WITH INDEX idx_ref_dept_naf ' +
      'WHERE departement = $dept AND naf = $naf ' +
      "AND website != NONE AND website != '' " +
      "AND (societe_tel = NONE OR societe_tel = '' OR societe_email = NONE OR societe_email = '') " +
      'AND (mentions_legales_checked_at = NONE OR mentions_legales_checked_at < time::now() - 30d) ' +
      `LIMIT ${n}`
    const db = await getDb()
    const r = await db.query(sql, { dept: d, naf: codeNaf })
    const rows = r[0] || []
    return rows.map(row => str(row?.siret)).filter(Boolean)
  } catch (e) {
    console.warn('[referentiel-read]', String(e?.message || e).slice(0, 80))
    return []
  }
}

// ── G. isGisementComplete(naf, departement) — async, fail-safe ──
// Interroge le marqueur de gisement complet (referentiel_gisements) posé par
// markGisementComplete au signal de fin de recherche. La clé du record est
// `${nafPointé}:${dept}` — la normalisation NAF est INDISPENSABLE parce que la base
// stocke la forme POINTÉE (86.90E) et le front envoie la forme SANS point (8690E) ;
// sans elle la clé ne correspondrait jamais et le marqueur serait toujours manquant.
// Rend le record UNIQUEMENT s'il est marqué complet ET frais (refreshed_at postérieur
// à now - 30d) ; sinon null. Toute erreur → null : la dégradation sûre est de taper
// Etalab, jamais de servir un cache douteux comme s'il faisait autorité.
export async function isGisementComplete(naf, departement) {
  try {
    const n = normalizeNaf(naf)
    if (!n) return null
    const d = str(departement)
    if (!d || d.indexOf(',') !== -1) return null
    const sql =
      'SELECT * FROM type::record("referentiel_gisements", $key) ' +
      `WHERE complete = true AND refreshed_at > time::now() - ${REFERENTIEL_TTL_DAYS}d`
    const db = await getDb()
    const r = await db.query(sql, { key: `${n}:${d}` })
    const row = (r[0] || [])[0]
    return row || null
  } catch (e) {
    console.warn('[referentiel-read]', String(e?.message || e).slice(0, 80))
    return null
  }
}
