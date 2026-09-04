// Référentiel entreprises mutualisé — table partagée (AUCUN userId).
//
// referentiel_societes : cache/référentiel des établissements issus des
//                        sources publiques (Etalab / SIRENE / RCS).
//                        Mutualisée entre tous les utilisateurs — clé
//                        naturelle SIRET (un établissement = un record).
//                        Alimentée par UPSERT idempotent dans une passe
//                        ultérieure (aucun flux d'écriture ni de lecture
//                        dans ce commit — la table reste vide au boot).
//
// Les champs dirigeant_* (personne physique, source publique SIRENE/RCS)
// sont déclarés mais NON alimentés par ce commit.
//
// Schéma défini ci-dessous (runReferentielMigration), joué au boot du
// serveur de manière idempotente (DEFINE … IF NOT EXISTS). Calque strict
// du pattern server/services/optout.js (runOptoutMigration).

import { getDb } from '../../lib/surreal.js'
import { cleanRecordId } from '../../lib/db.js'
// Écriture → lecture : acyclique (referentiel-read.js n'importe que surreal.js
// et optout.js, jamais ce module). Ce module importe lui aussi optout.js (garde
// blocklist RGPD ci-dessous) ; optout.js n'importe que surreal.js/crypto, donc
// toujours aucun cycle. normalizeNaf est la SEULE source de vérité du format de
// clé ; countReferentielFresh fournit le compteur informatif.
import { countReferentielFresh, normalizeNaf } from './referentiel-read.js'
import { checkBlocklistOne, checkBlocklistBatch } from './optout.js'
// Liste noire des hôtes : module FEUILLE, sans aucune dépendance. C'est la raison
// même de son existence, cf. hotes-exclus.js. La lire depuis recherche-web.js,
// son adresse historique, refermerait un cycle par mentions-legales.js.
import { hostBlacklisted, hoteDeSite, champReseauPourHote } from './hotes-exclus.js'

// ── migration idempotente ──
export async function runReferentielMigration() {
  const db = await getDb()
  const queries = [
    // ── referentiel_societes — référentiel entreprises mutualisé (clé SIRET) ──
    'DEFINE TABLE IF NOT EXISTS referentiel_societes SCHEMAFULL',
    'DEFINE FIELD IF NOT EXISTS siren ON referentiel_societes TYPE string',
    'DEFINE FIELD IF NOT EXISTS siret ON referentiel_societes TYPE string',
    'DEFINE FIELD IF NOT EXISTS raison_sociale ON referentiel_societes TYPE string',
    'DEFINE FIELD IF NOT EXISTS naf ON referentiel_societes TYPE string',
    'DEFINE FIELD IF NOT EXISTS naf_libelle ON referentiel_societes TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS forme_juridique_code ON referentiel_societes TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS adresse ON referentiel_societes TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS code_postal ON referentiel_societes TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS ville ON referentiel_societes TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS commune ON referentiel_societes TYPE string',
    'DEFINE FIELD IF NOT EXISTS departement ON referentiel_societes TYPE string',
    'DEFINE FIELD IF NOT EXISTS lat ON referentiel_societes TYPE option<number>',
    'DEFINE FIELD IF NOT EXISTS lng ON referentiel_societes TYPE option<number>',
    'DEFINE FIELD IF NOT EXISTS etat_administratif ON referentiel_societes TYPE option<string>',
    // ── Complétude établissement (Phase 2) — capte les champs recherche-entreprises
    // aujourd'hui jetés par la chaîne. Additifs, jamais existé → IF NOT EXISTS.
    // SOCLE ADMINISTRATIF, pas de la saisie abonné : alimentés en SET direct et
    // rafraîchis à chaque upsert (comme raison_sociale / naf / adresse). Aucun de ces
    // champs n'est jamais écrit par un abonné (ce chemin est enrichReferentielActionnable,
    // séparé), donc rien à protéger d'un écrasement ; les figer en fill-if-empty ne
    // ferait que geler la 1re valeur (une entreprise qui change d'enseigne resterait
    // périmée). L'écrasement par du vide est déjà exclu en amont : upsertReferentiel
    // ne pose ces clés dans body que si non vides. numero/type/libelle_voie DOIVENT
    // suivre adresse (SET direct) sous peine d'incohérence composé/décomposés.
    // NAF 2025 exclu volontairement (catalogue en NAF 2008, contamination). tva :
    // défini mais non alimenté (non renvoyé par recherche-entreprises ; reste NONE).
    'DEFINE FIELD IF NOT EXISTS enseigne ON referentiel_societes TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS enseignes ON referentiel_societes TYPE option<array<string>>',
    'DEFINE FIELD IF NOT EXISTS enseignes.* ON referentiel_societes TYPE string',
    'DEFINE FIELD IF NOT EXISTS nom_commercial ON referentiel_societes TYPE option<string>',
    // ── Clé de nom normalisée pour l'appariement du gisement OSM sans SIRET
    // (nom + ville). Dérivée en normaliserSociete(enseigne || raison_sociale) —
    // enseigne prioritaire (le tag `name` OSM porte l'enseigne), repli raison
    // sociale INSEE. INERTE dans ce commit : DEFINE seul, aucune écriture ni
    // backfill (étapes 2 et 3 cadrées séparément) → NONE sur toutes les lignes
    // existantes. Additif, jamais existé → IF NOT EXISTS.
    'DEFINE FIELD IF NOT EXISTS cle_nom ON referentiel_societes TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS date_fermeture ON referentiel_societes TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS tranche_effectif_salarie ON referentiel_societes TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS nature_juridique ON referentiel_societes TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS tva ON referentiel_societes TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS date_creation ON referentiel_societes TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS numero_voie ON referentiel_societes TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS type_voie ON referentiel_societes TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS libelle_voie ON referentiel_societes TYPE option<string>',
    // ── Champs actionnables personne morale mutualisés (saisie abonné, additive). ──
    // Alimentés en remplissage-si-vide depuis la saisie/import (jamais d'écrasement) ;
    // aucun champ personne physique. Jamais existé → IF NOT EXISTS (pas d'OVERWRITE).
    'DEFINE FIELD IF NOT EXISTS website ON referentiel_societes TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS societe_email ON referentiel_societes TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS societe_tel ON referentiel_societes TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS societe_linkedin ON referentiel_societes TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS societe_facebook ON referentiel_societes TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS societe_instagram ON referentiel_societes TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS dirigeant_nom ON referentiel_societes TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS dirigeant_prenom ON referentiel_societes TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS dirigeant_fonction ON referentiel_societes TYPE option<string>',
    // ── Enrichissement additif : listes complètes (dirigeants PP + établissements) + compteur. ──
    // En 2.6.5, FLEXIBLE sur option<array<object>> NE se propage PAS aux objets
    // contenus dans le tableau : chaque sous-clé (dirigeants[N].fonction,
    // etablissements[N].adresse) est vue comme un champ non déclaré en SCHEMAFULL
    // et REJETÉE à l'écriture. Il faut poser FLEXIBLE sur l'ÉLÉMENT du tableau via
    // le wildcard .* — même mécanisme object FLEXIBLE que geo_data/metadata en prod
    // (cf. surreal-adapter.js:471-473). OVERWRITE : les champs existent déjà avec le
    // mauvais type (option<array<object>> FLEXIBLE), IF NOT EXISTS ne les corrigerait pas.
    'DEFINE FIELD OVERWRITE dirigeants ON referentiel_societes TYPE option<array<object>>',
    'DEFINE FIELD OVERWRITE dirigeants.* ON referentiel_societes TYPE object FLEXIBLE',
    'DEFINE FIELD OVERWRITE etablissements ON referentiel_societes TYPE option<array<object>>',
    'DEFINE FIELD OVERWRITE etablissements.* ON referentiel_societes TYPE object FLEXIBLE',
    'DEFINE FIELD IF NOT EXISTS nombre_etablissements ON referentiel_societes TYPE option<number>',
    "DEFINE FIELD IF NOT EXISTS source ON referentiel_societes TYPE string DEFAULT 'etalab_referentiel'",
    'DEFINE FIELD IF NOT EXISTS cached_at ON referentiel_societes TYPE datetime DEFAULT time::now()',
    'DEFINE FIELD IF NOT EXISTS refreshed_at ON referentiel_societes TYPE datetime DEFAULT time::now()',
    // ── Idempotence crawl mentions légales — horodatage du dernier passage du job
    // mentions-legales.js (maillons URL→page légale→extraction→recoupement). Écrit à
    // CHAQUE passage (trouvé ou non) ; le job saute tout SIRET vérifié il y a moins de
    // 30 j (TTL). option<datetime> sans DEFAULT : NONE tant qu'aucun passage. Jamais
    // alimenté par l'abonné ni par le socle Etalab (bookkeeping interne du job).
    'DEFINE FIELD IF NOT EXISTS mentions_legales_checked_at ON referentiel_societes TYPE option<datetime>',
    // ── Traçabilité de l'appariement Overture, INTERNE ──
    // Quatre champs posés par la passe d'appariement Overture, et par elle seule :
    // l'origine du contact, le score de nom retenu, la distance en mètres entre la
    // fiche et la ligne appariée, et le résultat du recoupement par le site quand
    // il a eu lieu. Ils disent D'OÙ vient une coordonnée et à quel prix, ce qu'aucun
    // des six champs actionnables ne porte.
    //
    // ILS NE REMONTENT JAMAIS À L'ÉCRAN, et c'est vérifiable route par route. Les cinq
    // chemins par lesquels le référentiel atteint le navigateur projettent tous une
    // liste blanche : referentielRowToFiche (referentiel-read.js) reconstruit un
    // objet littéral champ par champ, projeterReferentiel n'expose que ses six champs,
    // getReferentielContactBySiret et sa forme en lot sélectionnent leurs colonnes,
    // le tri de service de /api/search en lit cinq sans rien sérialiser. Le seul
    // SELECT * de la table (referentiel-read.js) passe par ce constructeur littéral.
    // Aucun de ces chemins ne nomme ces quatre champs, et aucun ne peut les ramasser
    // par élargissement.
    //
    // contact_origine nomme LA SOURCE ET LE CHEMIN QUI A TRANCHÉ, en un seul jeton
    // `source` ou `source_chemin` : deux appariements de la même source n'ont pas
    // le même prix, et c'est le chemin qui le dit. Vocabulaire fermé, un producteur
    // par valeur :
    //   overture                                   passe-overture-*.mjs
    //   atout_france_a | _a2 | _b                  rapprochement-atout-france.js
    //   mentions_legales_certain | _presume        mentions-legales.js
    //   saisie_carte | saisie_fiche                server.js, saisie abonné
    //   import_abonne                              server.js, import de fichier
    //   dataforseo_adresse                         server.js, sous corroboration
    // Le préfixe avant le premier `_` reste la source, si bien qu'un comptage par
    // source se fait sans énumérer les chemins.
    //
    // AUCUNE VALEUR osm_* NI overpass_*, ET IL NE FAUT PAS EN RÉINTRODUIRE.
    // OpenStreetMap a été retiré des sources du référentiel le 4 septembre :
    // c'était la seule source sous ODbL, dont la clause de partage à l'identique
    // se propage à toute base qui incorpore ses données. Le moteur de
    // rapprochement OSM et le connecteur Overpass ne sont plus appelés, donc plus
    // aucune de ces valeurs n'est produite. Aucune fiche n'en portait : zéro sur
    // les 66 446 fiches au comptage du 4 septembre, la traçabilité n'ayant été
    // posée qu'après le dernier passage du moteur.
    //
    // Ce que le retrait ne dit PAS : les coordonnées qu'OSM avait écrites avant
    // la traçabilité sont toujours en base, sans contact_origine, indiscernables
    // de celles des autres sources. Débrancher une source n'efface pas ce qu'elle
    // a écrit ; ce stock est une question de licence à trancher à part.
    //
    // contact_site_recoupe est une TRACE, jamais une condition d'écriture : le
    // remplissage-si-vide ne la lit pas. Valeurs : 'tel_et_nom', 'tel_seul',
    // 'nom_seul', 'aucun', 'muet' ; NONE quand la visite n'a pas eu lieu.
    //
    // option<…> sans DEFAULT : NONE sur tout le stock existant, la migration ne
    // réécrit aucune ligne. Additifs, jamais existé → IF NOT EXISTS.
    'DEFINE FIELD IF NOT EXISTS contact_origine ON referentiel_societes TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS contact_nom_score ON referentiel_societes TYPE option<number>',
    'DEFINE FIELD IF NOT EXISTS contact_distance_m ON referentiel_societes TYPE option<number>',
    'DEFINE FIELD IF NOT EXISTS contact_site_recoupe ON referentiel_societes TYPE option<string>',
    // SIRET clé naturelle → UNIQUE : garantit l'idempotence de l'UPSERT (un établissement = un record).
    'DEFINE INDEX IF NOT EXISTS idx_ref_siret ON referentiel_societes FIELDS siret UNIQUE',
    'DEFINE INDEX IF NOT EXISTS idx_ref_siren ON referentiel_societes FIELDS siren',
    'DEFINE INDEX IF NOT EXISTS idx_ref_naf ON referentiel_societes FIELDS naf',
    'DEFINE INDEX IF NOT EXISTS idx_ref_dept ON referentiel_societes FIELDS departement',
    'DEFINE INDEX IF NOT EXISTS idx_ref_commune ON referentiel_societes FIELDS commune',
    // Appariement OSM nom + ville : commune (TYPE string obligatoire, jamais NONE)
    // en tête → borne le scan par commune INSEE avant le match sur cle_nom.
    'DEFINE INDEX IF NOT EXISTS idx_ref_commune_clenom ON referentiel_societes FIELDS commune, cle_nom',
    // Composite (requête type : ciblage sectoriel par département).
    'DEFINE INDEX IF NOT EXISTS idx_ref_dept_naf ON referentiel_societes FIELDS departement, naf'
  ]
  for (const q of queries) {
    try { await db.query(q) } catch (e) { console.warn('[referentiel-migration]', q.slice(0, 80), '→', e.message) }
  }
}

// ── alimentation référentiel (couche 1 : socle Etalab, fire-and-forget) ──

// Coercition string sûre pour les champs TYPE string obligatoires du schéma
// SCHEMAFULL : jamais null/undefined (rejet strict), toujours une chaîne trimée.
const str = v => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()))

// Nettoie un array<string> Etalab (ex. liste_enseignes) : rejette les non-strings,
// trime, retire les vides. Entrée non-tableau → []. Préserve l'ordre et les doublons.
const cleanStrArray = v =>
  (Array.isArray(v) ? v.map(x => (typeof x === 'string' ? x.trim() : '')).filter(Boolean) : [])

// Complétude établissement : VIDE à dessein. Ces 10 champs (enseigne, enseignes,
// nom_commercial, date_fermeture, tranche_effectif_salarie, nature_juridique,
// date_creation, numero/type/libelle_voie) sont du SOCLE Etalab, pas de la saisie
// abonné → SET direct dans upsertReferentiel, rafraîchis à chaque upsert. Le
// remplissage-si-vide ne protégerait aucune saisie (les 4 champs abonné passent par
// enrichReferentielActionnable, séparé) et ne ferait que figer la 1re valeur captée.
// Le paramètre fillIfEmpty d'upsertRecordRef reste par généricité, non alimenté ici.
const FILL_IF_EMPTY = []

// Dérive le code département à partir du code commune INSEE (champ Etalab
// 'commune'). GARDE-FOU : une commune non résolue retourne '' — jamais un
// département faux. L'appelant SKIP la fiche si le retour est vide.
//   • Corse : '2A…' / '2B…' → '2A' / '2B' (préserver les lettres, ne JAMAIS
//     convertir en nombre).
//   • Arrondissements PLM (751xx / 6938x / 132xx) → 75 / 69 / 13 naturellement
//     par les 2 premiers caractères, AUCUN traitement spécial.
//   • DOM-TOM ('97…' / '98…') → '' : HORS PÉRIMÈTRE pour l'instant.
//   • Métropole : 2 premiers caractères (01–95).
//   • Tout format inattendu (commune vide, non numérique hors Corse) → ''.
export function communeToDepartement(commune) {
  const c = String(commune || '').trim()
  if (c.length < 2) return ''
  if (c.startsWith('2A') || c.startsWith('2B')) return c.slice(0, 2)
  const d2 = c.slice(0, 2)
  if (d2 === '97' || d2 === '98') return ''   // DOM-TOM hors périmètre
  if (/^[0-9]{2}$/.test(d2)) return d2         // métropole (PLM inclus naturellement)
  return ''                                     // format inattendu → jamais de dept faux
}

// 1er dirigeant PERSONNE PHYSIQUE d'une fiche Etalab (données publiques
// SIRENE/RCS). Les personnes morales (type_dirigeant !== 'personne physique')
// sont ignorées. Prénom = 1er mot seulement (Etalab empile l'état civil complet).
function firstDirigeantPP(fiche) {
  const dirs = Array.isArray(fiche?.dirigeants) ? fiche.dirigeants : []
  for (const d of dirs) {
    if (!d || d.type_dirigeant !== 'personne physique') continue
    const nom = typeof d.nom === 'string' ? d.nom.trim() : ''
    const prenoms = typeof d.prenoms === 'string' ? d.prenoms.trim() : ''
    if (!nom && !prenoms) continue
    return {
      nom,
      prenom: prenoms ? (prenoms.split(/\s+/)[0] || '') : '',
      fonction: typeof d.qualite === 'string' ? d.qualite.trim() : ''
    }
  }
  return null
}

// TOUS les dirigeants PERSONNE PHYSIQUE d'une fiche (enrichissement additif —
// firstDirigeantPP reste le 1er servi sur les champs plats). Rejoue exactement
// le même filtre (type_dirigeant === 'personne physique', nom OU prenoms non
// vide) et le même mapping { nom, prenom (1er mot), fonction (qualite) } sur
// toute la liste. Liste vide → [] (l'appelant omet le champ → NONE).
function allDirigeantsPP(fiche) {
  const dirs = Array.isArray(fiche?.dirigeants) ? fiche.dirigeants : []
  const out = []
  for (const d of dirs) {
    if (!d || d.type_dirigeant !== 'personne physique') continue
    const nom = typeof d.nom === 'string' ? d.nom.trim() : ''
    const prenoms = typeof d.prenoms === 'string' ? d.prenoms.trim() : ''
    if (!nom && !prenoms) continue
    out.push({
      nom,
      prenom: prenoms ? (prenoms.split(/\s+/)[0] || '') : '',
      fonction: typeof d.qualite === 'string' ? d.qualite.trim() : ''
    })
  }
  return out
}

// TOUS les établissements d'une fiche (matching_etablissements[], fallback
// [siege] si matching absent). Enrichissement additif — l'établissement servi
// sur les champs plats (matching[0]/siege) reste inchangé. Chaque entrée mappée
// avec gardes str() ; lat/lng en Number seulement si finis (jamais NaN).
// Liste vide → [] (l'appelant omet le champ → NONE).
function allEtablissements(fiche) {
  let list = Array.isArray(fiche?.matching_etablissements) ? fiche.matching_etablissements : []
  if (list.length === 0 && fiche?.siege) list = [fiche.siege]
  const out = []
  for (const e of list) {
    if (!e || typeof e !== 'object') continue
    const etab = {
      siret: str(e.siret),
      adresse: str(e.adresse),
      code_postal: str(e.code_postal),
      commune: str(e.commune),
      ville: str(e.libelle_commune),
      est_siege: e.est_siege === true,
      etat_administratif: str(e.etat_administratif)
    }
    const lat = Number(e.latitude)
    const lng = Number(e.longitude)
    if (Number.isFinite(lat)) etab.lat = lat
    if (Number.isFinite(lng)) etab.lng = lng
    out.push(etab)
  }
  return out
}

// UPSERT idempotent par record id. S'inspire de upsertRecord (server.js:250) —
// non exportable (fonction interne de server.js ; l'importer créerait un cycle
// server.js ⇄ referentiel.js). CREATE si absent, UPDATE ... SET si le record
// existe déjà.
//
// Mode SET à liste dynamique (et NON CONTENT $body) : les datetimes cached_at /
// refreshed_at sont calculés côté SurrealQL via time::now(), jamais posés dans
// $body ni en string ISO — c'est exactement la cause du bug b219bf7 (le DEFAULT
// time::now() en CONTENT échoue sous 2.6.5). Les assignations "champ = $param"
// ne portent QUE les clés réellement présentes dans body : l'omission d'un champ
// optionnel absent est préservée (→ NONE), aucun champ vide n'est forcé.
// fillIfEmpty : liste de clés écrites en remplissage-si-vide STRICT — jamais
// d'écrasement d'une valeur déjà présente (NONE/'' pour les strings, NONE/[] pour
// les arrays). Guard porté PAR CHAMP en SurrealQL, valide en CREATE (champ = NONE
// → posé) comme en UPDATE (existant non vide → conservé, no-op réel), même
// mécanisme que enrichReferentielActionnable. Les clés hors liste gardent le SET
// direct (le socle Etalab, rafraîchi à chaque upsert — dette connue cached_at).
// Paramètre GÉNÉRIQUE, ACTUELLEMENT NON ALIMENTÉ par upsertReferentiel (FILL_IF_EMPTY
// est vide) : les 10 champs de complétude sont du socle et passent en SET direct.
// La saisie abonné (website / societe_email / …) ne transite PAS par ici mais par
// enrichReferentielActionnable ; ce paramètre reste pour un futur appelant éventuel.
async function upsertRecordRef(db, table, cleanId, body, fillIfEmpty = []) {
  const params = { id: cleanId }
  const fillSet = new Set(fillIfEmpty)
  const assigns = []
  for (const [k, v] of Object.entries(body)) {
    if (fillSet.has(k)) {
      const emptyLit = Array.isArray(v) ? '[]' : "''"
      assigns.push(`${k} = IF ${k} = NONE OR ${k} = ${emptyLit} THEN $${k} ELSE ${k} END`)
    } else {
      assigns.push(`${k} = $${k}`)
    }
    params[k] = v
  }
  // Datetimes calculés en SurrealQL (jamais dans $body — cf. b219bf7).
  assigns.push('cached_at = time::now()', 'refreshed_at = time::now()')
  const setClause = assigns.join(', ')
  const createSql = `CREATE type::record("${table}", $id) SET ${setClause}`
  const updateSql = `UPDATE type::record("${table}", $id) SET ${setClause}`
  try {
    await db.query(createSql, params)
  } catch (e) {
    const isAlreadyExists =
      e?.name === 'AlreadyExistsError' ||
      e?.kind === 'AlreadyExists' ||
      String(e?.message || '').includes('already exists')
    if (!isAlreadyExists) throw e
    await db.query(updateSql, params)
  }
}

// Les quatre champs de traçabilité, avec le type que le schéma leur donne. LISTE
// BLANCHE : un appelant ne peut poser ni un champ hors de cette liste, ni une
// valeur d'un autre type. La table est SCHEMAFULL et cette fonction avale ses
// échecs, donc un champ inconnu ou mal typé ferait échouer l'UPDATE ENTIER, en
// silence, emportant l'enrichissement avec lui. Le filtre est ici pour que ce
// mode de défaillance ne dépende pas de la rigueur de l'appelant.
const CHAMPS_TRACE = {
  contact_origine: 'string',
  contact_nom_score: 'number',
  contact_distance_m: 'number',
  contact_site_recoupe: 'string'
}

// ── enrichissement additif du référentiel depuis la saisie abonné ──
// ENRICHIR-SI-EXISTE : remplit les 6 champs actionnables personne morale du
// référentiel mutualisé (website / societe_email / societe_tel / societe_linkedin
// / societe_facebook / societe_instagram) UNIQUEMENT s'ils y sont vides (NONE ou
// ''), à partir de la saisie/import de l'abonné. ADDITIF STRICT — jamais
// d'écrasement d'une valeur déjà présente : la
// règle est portée PAR CHAMP côté SurrealQL
//   website = IF website = NONE OR website = '' THEN $website ELSE website END
// si bien qu'une valeur non vide existante est réécrite à l'identique (no-op réel).
//
// UPDATE CIBLÉ, JAMAIS UPSERT : on ne crée aucun record. Le record est ciblé par
// SIRET via cleanRecordId('referentiel_societes', siret) ; s'il n'existe pas dans
// le référentiel, l'UPDATE ne touche 0 ligne → no-op silencieux (aucune création,
// ne pas réutiliser upsertRecordRef qui, lui, CREATE si absent).
//
// Champs vides EN ENTRÉE ignorés : ils ne sont pas posés dans le SET, donc le
// champ existant reste tel quel (on n'écrase jamais avec du vide).
//
// FIRE-AND-FORGET : appelée sans await, ne doit JAMAIS throw. Échec avalé + loggé.
//
// TROISIÈME PARAMÈTRE, OPTIONNEL : la traçabilité de la passe qui écrit (origine,
// score de nom, distance, recoupement par le site). Posée en SET direct dans le
// MÊME UPDATE, et seulement si au moins un canal est dispatché. Champs INTERNES :
// aucune route ne les sert, cf. runReferentielMigration. Les huit appelants
// existants ne le passent pas et leur UPDATE ne change pas d'un caractère.
//
// FILTRE D'HÔTE SUR LE SITE, posé ici et nulle part ailleurs. Les six portes par
// lesquelles un `website` entre au référentiel (Étalab n'en est pas : son socle ne
// porte pas ce champ) passent TOUTES par cette fonction : Atout France, le crawl
// mentions légales, DataForSEO sous corroboration d'adresse, les deux saisies
// d'abonné et l'import. Un seul test ici les couvre toutes, et aucune porte
// future ne pourra le contourner sans contourner l'écriture elle-même.
//
// Ce qu'il ferme : une page Facebook, un profil Planity ou une fiche Tchip stockée
// comme site d'entreprise. Ces hôtes passent le sélecteur du crawl
// (selectSiretsACrawler, referentiel-read.js), occupent une place dans le lot, se
// font refuser par le fichier d'exclusion des robots, et ne sont PAS horodatés
// (mentions-legales.js ne pose markChecked qu'aux fiches abouties) : ils reviennent
// donc à chaque passage. Mesuré avant ce commit : 32 fiches sur les 65 du vivier.
export async function enrichReferentielActionnable(siret, fields = {}, trace = null) {
  try {
    // SIRET normalisé (espaces retirés) avant cleanRecordId — aligne la clé sur les
    // SIRET du référentiel, déjà 14 chiffres sans espace (cf. server.js:962/1343).
    const cleanSiret = String(siret || '').replace(/\s+/g, '')
    const id = cleanRecordId('referentiel_societes', cleanSiret)
    if (!id) return
    if (await checkBlocklistOne(cleanSiret)) {
      console.log(`[optout] enrich ignoré ${cleanSiret}`)
      return
    }
    // ── Filtre d'hôte, AVANT la boucle des champs ──
    // Copie locale : l'objet de l'appelant n'est jamais muté. Plusieurs le
    // construisent à la volée, d'autres passent un objet qu'ils gardent sous la main
    // pour leurs propres comptes.
    const entrants = { ...(fields || {}) }
    const siteEntrant = str(entrants.website)
    if (siteEntrant) {
      const hote = hoteDeSite(siteEntrant)
      // hostBlacklisted('') vaut true : un website illisible (schéma cassé, valeur
      // qui n'est pas une URL) tombe par la même porte, fail-closed. Mesuré : aucun
      // des 833 websites en base n'est dans ce cas, la branche est une garde.
      if (hostBlacklisted(hote)) {
        delete entrants.website   // le champ site n'est PAS écrit, dans les deux cas
        const champ = champReseauPourHote(hote)
        if (champ) {
          // Réorientation vers le champ de réseau social correspondant. Si l'appelant
          // fournit DÉJÀ ce champ, le sien prime : il l'a lu à la source (OSM, page
          // de mentions légales), là où l'URL de site n'est qu'un rabattement.
          // Champ déjà rempli EN BASE : abandon silencieux, tranché par le
          // remplissage-si-vide SurrealQL ci-dessous, comme partout ailleurs.
          if (!str(entrants[champ])) entrants[champ] = siteEntrant
          console.log(`[referentiel-enrich] site réorienté ${cleanSiret} ${hote} -> ${champ}`)
        } else {
          // Pas de champ d'accueil, et c'est un arbitrage : planity, tchip, orpi,
          // business.site décrivent un réseau, pas l'établissement. Rien n'est créé
          // pour les recueillir.
          console.log(`[referentiel-enrich] site écarté ${cleanSiret} ${hote || '(illisible)'}`)
        }
      }
    }
    const params = { id }
    const assigns = []
    for (const k of ['website', 'societe_email', 'societe_tel', 'societe_linkedin', 'societe_facebook', 'societe_instagram']) {
      const v = str(entrants[k])
      if (!v) continue   // champ vide en entrée → non posé (jamais d'écrasement par du vide)
      // Additif par champ : n'écrit que si l'existant est vide (NONE ou '').
      assigns.push(`${k} = IF ${k} = NONE OR ${k} = '' THEN $${k} ELSE ${k} END`)
      params[k] = v
    }
    if (assigns.length === 0) return   // rien à enrichir
    // ── Traçabilité, SET direct, APRÈS le garde ci-dessus ──
    // Posée seulement quand au moins un canal est dispatché : une fiche dont tout
    // est déjà pourvu ne reçoit pas de provenance, il n'y aurait rien à tracer. SET
    // direct et non remplissage-si-vide, parce que ces champs décrivent la passe qui
    // écrit, pas une valeur qu'un autre aurait pu poser avant elle.
    // Un appelant qui ne passe RIEN laisse trace à null : la boucle ne tourne pas et
    // l'UPDATE est celui d'avant. Ce n'est plus le cas d'aucun chemin d'écriture du
    // serveur ni des passes, tous instrumentés ; seuls les scripts d'essai s'en
    // dispensent encore.
    if (trace && typeof trace === 'object') {
      for (const [k, type] of Object.entries(CHAMPS_TRACE)) {
        const v = trace[k]
        if (v === undefined || v === null || v === '') continue
        if (typeof v !== type) continue
        assigns.push(`${k} = $${k}`)
        params[k] = v
      }
    }
    const db = await getDb()
    // UPDATE ciblé (jamais UPSERT) : record absent → 0 ligne modifiée, no-op.
    await db.query(
      `UPDATE type::record("referentiel_societes", $id) SET ${assigns.join(', ')}`,
      params
    )
  } catch (e) {
    console.warn('[referentiel-enrich]', String(e?.message || e).slice(0, 80))
  }
}

// Alimente referentiel_societes à partir des fiches Etalab servies à l'abonné.
// FIRE-AND-FORGET : appelée sans await APRÈS res.json — ne doit JAMAIS throw ni
// affecter la réponse déjà servie. Tout échec est avalé + loggé [referentiel-upsert].
//
// ATTENTION — cached_at réinitialisé : upsertRecordRef réassigne cached_at =
// time::now() à CHAQUE UPDATE (le passage CONTENT→SET ne change pas ce point ; le
// SET porte le socle Etalab servi à l'abonné + les 2 datetimes). Dette connue :
// préservation via VALUE $before.cached_at OR time::now() traitée au prompt
// enrichissement, PAS ici.
export async function upsertReferentiel(fiches) {
  try {
    if (!Array.isArray(fiches) || fiches.length === 0) return
    const db = await getDb()
    // ── Garde RGPD blocklist : UN seul lookup batch pour tout le lot. Passe 1,
    // collecte des SIRET via la MÊME sélection d'établissement que la boucle
    // d'écriture (matching[0] || siège). L'expression `.trim()` s'aligne sur le
    // Set trimmé rendu par checkBlocklistBatch — la comparaison passe 2 réutilise
    // la valeur identique, jamais une variante re-dérivée. ──
    const sirets = []
    for (const fiche of fiches) {
      const matching = Array.isArray(fiche?.matching_etablissements) ? fiche.matching_etablissements : []
      const etab = matching[0] || fiche?.siege || null
      if (!etab) continue
      const s = (typeof etab.siret === 'string' ? etab.siret : '').trim()
      if (s) sirets.push(s)
    }
    const bloques = sirets.length ? await checkBlocklistBatch(sirets) : new Set()
    let optoutSkipped = 0
    let fermeSkipped = 0
    for (const fiche of fiches) {
      try {
        // Établissement servi à l'abonné : matching_etablissements[0], fallback siège.
        const matching = Array.isArray(fiche?.matching_etablissements) ? fiche.matching_etablissements : []
        const etab = matching[0] || fiche?.siege || null
        if (!etab) continue
        // Garde RGPD : établissement opt-out → écarté du lot (même expression qu'en passe 1).
        if (bloques.has((typeof etab.siret === 'string' ? etab.siret : '').trim())) { optoutSkipped++; continue }
        // ID de record = SIRET nettoyé → idempotence par établissement. Sinon SKIP.
        const id = cleanRecordId('referentiel_societes', typeof etab.siret === 'string' ? etab.siret : '')
        if (!id) continue
        // Département dérivé de la commune INSEE. Vide (DOM / non résolu) → SKIP :
        // jamais de fiche stockée avec un département faux.
        const commune = str(etab.commune)
        const departement = communeToDepartement(commune)
        if (!departement) continue
        // ── Socle Etalab. Les 6 champs TYPE string sont TOUJOURS des strings ('' si absent). ──
        const body = {
          siren: str(fiche?.siren),
          siret: str(etab.siret),
          raison_sociale: str(fiche?.nom_complet) || str(fiche?.nom_raison_sociale),
          naf: str(etab.activite_principale) || str(fiche?.activite_principale),
          commune,
          departement
        }
        // Champs option<string> : posés seulement si présents (sinon NONE).
        const nafLib = str(fiche?.activite_principale_libelle) || str(etab.activite_principale_libelle)
        if (nafLib) body.naf_libelle = nafLib
        const forme = str(fiche?.nature_juridique)
        if (forme) body.forme_juridique_code = forme
        if (str(etab.adresse)) body.adresse = str(etab.adresse)
        if (str(etab.code_postal)) body.code_postal = str(etab.code_postal)
        if (str(etab.libelle_commune)) body.ville = str(etab.libelle_commune)
        const etatAdm = str(etab.etat_administratif) || str(fiche?.etat_administratif)
        if (etatAdm) body.etat_administratif = etatAdm
        // Filtre d'activité à l'ÉCRITURE — miroir strict de la clause de lecture
        // (buildWhere, égalité stricte 'A') : on ne fait JAMAIS entrer un établissement
        // fermé au référentiel. On teste l'état de l'établissement SERVI (etatAdm ci-dessus,
        // celui-là même qui serait stocké). L'état servi est toujours présent (mesuré : aucune
        // ligne à état absent), le skip ne perd donc aucune fiche active ; et une fiche non-'A'
        // écrite ne serait de toute façon jamais relue (la gate de lecture ne sert que 'A').
        // Le filtre de lecture protège l'existant, celui-ci ferme la source pour l'avenir.
        if (etatAdm !== 'A') { fermeSkipped++; continue }
        // lat/lng option<number> : Number + garde Number.isFinite, sinon OMIS (jamais NaN).
        const lat = Number(etab.latitude)
        const lng = Number(etab.longitude)
        if (Number.isFinite(lat)) body.lat = lat
        if (Number.isFinite(lng)) body.lng = lng
        // Dirigeant personne physique (1er) — public. Champs à NONE si aucun.
        const dir = firstDirigeantPP(fiche)
        if (dir) {
          if (dir.nom) body.dirigeant_nom = dir.nom
          if (dir.prenom) body.dirigeant_prenom = dir.prenom
          if (dir.fonction) body.dirigeant_fonction = dir.fonction
        }
        // ── Enrichissement additif : listes complètes + compteur (posés seulement
        // si non vides → NONE sinon, cohérent avec l'omission des champs optionnels).
        // Tableaux/objets passés en paramètre bindé natif par upsertRecordRef (le
        // driver SurrealDB sérialise en CBOR — AUCUN JSON.stringify manuel). ──
        const dirigeants = allDirigeantsPP(fiche)
        if (dirigeants.length) body.dirigeants = dirigeants
        const etablissements = allEtablissements(fiche)
        if (etablissements.length) body.etablissements = etablissements
        const nbEtab = Number(fiche?.nombre_etablissements)
        if (Number.isFinite(nbEtab)) body.nombre_etablissements = nbEtab
        // ── Complétude établissement (Phase 2). SOCLE en SET direct (FILL_IF_EMPTY vide),
        // rafraîchi à chaque upsert comme raison_sociale/naf/adresse — jamais une saisie
        // abonné (celle-ci passe par enrichReferentielActionnable). Source : l'établissement
        // servi (etab) d'abord, repli fiche / siège. Posés seulement si non vides → NONE
        // sinon (le body omet les vides : aucun risque d'écraser une valeur par du vide).
        // tva : NON alimenté (non renvoyé par l'API — champ défini, laissé NONE).
        const siege = fiche?.siege && typeof fiche.siege === 'object' ? fiche.siege : null
        const enseignes = cleanStrArray(etab.liste_enseignes)
        if (enseignes.length) {
          body.enseigne = enseignes[0]
          body.enseignes = enseignes
        }
        const nomCommercial = str(etab.nom_commercial) || (siege ? str(siege.nom_commercial) : '')
        if (nomCommercial) body.nom_commercial = nomCommercial
        const dateFermeture = str(etab.date_fermeture) || str(fiche?.date_fermeture)
        if (dateFermeture) body.date_fermeture = dateFermeture
        const tranche = str(etab.tranche_effectif_salarie) || str(fiche?.tranche_effectif_salarie)
        if (tranche) body.tranche_effectif_salarie = tranche
        const natureJur = str(fiche?.nature_juridique)
        if (natureJur) body.nature_juridique = natureJur
        const dateCreation = str(etab.date_creation) || str(fiche?.date_creation)
        if (dateCreation) body.date_creation = dateCreation
        if (str(etab.numero_voie)) body.numero_voie = str(etab.numero_voie)
        if (str(etab.type_voie)) body.type_voie = str(etab.type_voie)
        if (str(etab.libelle_voie)) body.libelle_voie = str(etab.libelle_voie)
        // source : laissée au DEFAULT DB ('etalab_referentiel'). cached_at /
        // refreshed_at : posés en SurrealQL (time::now()) par upsertRecordRef.
        await upsertRecordRef(db, 'referentiel_societes', id, body, FILL_IF_EMPTY)
      } catch (e) {
        console.warn('[referentiel-upsert]', String(e?.message || e).slice(0, 80))
      }
    }
    if (optoutSkipped) console.log(`[optout] ${optoutSkipped} fiche(s) écartée(s) du lot referentiel`)
    if (fermeSkipped) console.log(`[referentiel-upsert] ${fermeSkipped} établissement(s) fermé(s) écarté(s) à l'écriture`)
  } catch (e) {
    console.warn('[referentiel-upsert]', String(e?.message || e).slice(0, 80))
  }
}

// ── marqueur de complétude d'un gisement (cache recherche mutualisé, étape 2) ──
// Pose « le gisement (naf, departement) a été ramené ENTIER » sur
// referentiel_gisements. Un record = un couple (naf pointé, département).
//
// QUAND l'appeler : UNIQUEMENT quand une page Etalab revient VIDE (raw_count === 0)
// sur une recherche portant le DÉPARTEMENT ENTIER. La garde géo est chez l'appelant
// (server.js /api/search) : ni code_commune ni code_postal, département unique. Une
// page vide sur une recherche commune-scopée ou sur une tranche du walker multi-CP
// ne signifie QUE « cette tranche est épuisée » — marquer le gisement à partir de là
// le déclarerait complet alors qu'on n'en a ramené qu'un morceau.
//
// CLÉ : `<naf pointé>:<departement>`, déterministe ⇒ l'UPSERT est idempotent (re-marquer
// écrase le même record). Le NAF passe par normalizeNaf : le format doit être celui du
// stock referentiel_societes, sans quoi "4778Z:35" et "47.78Z:35" marqueraient deux fois
// le même gisement (l'index UNIQUE (naf, departement) transformerait la divergence en
// erreur d'écriture, mais on ne compte pas dessus).
//
// refreshed_at = time::now() : c'est la NAISSANCE de la fenêtre de péremption (30 j),
// calculée en SurrealQL et jamais posée en chaîne ISO (doctrine b219bf7). Aucun autre
// chemin n'écrit sur referentiel_gisements — la date est posée une fois, au marquage.
//
// fiches_count — INFORMATIF, JAMAIS UN ORACLE. Ce n'est pas le nombre de fiches du
// gisement chez Etalab, et la décision HIT/MISS ne doit reposer que sur
// complete + refreshed_at. Trois écarts assumés :
//   • il compte les fiches PROSPECTABLES RETENUES : isProspectable puis keepLead
//     (server.js) écartent des fiches AVANT upsertReferentiel, elles ne sont pas au stock ;
//   • il ne compte que les fiches FRAÎCHES (fenêtre REFERENTIEL_TTL_DAYS), sémantique
//     alignée sur la gate de lecture — une fiche stockée il y a plus de 30 j et non
//     rafraîchie par cette passe n'y figure pas ;
//   • il peut être SOUS-ÉVALUÉ d'au plus une page (25) : l'upsertReferentiel de la
//     dernière page pleine est fire-and-forget et peut encore être en vol quand la page
//     vide déclenche ce marquage. complete et refreshed_at, eux, restent justes.
//
// FIRE-AND-FORGET : appelée sans await APRÈS res.json — ne doit JAMAIS throw ni affecter
// la réponse déjà servie. Tout échec est avalé + loggé [gisement-mark]. Un marquage raté
// = pas de marqueur = MISS au prochain coup (on re-ramène) : jamais un HIT sur un
// gisement partiel.
export async function markGisementComplete(naf, departement) {
  try {
    // Format de clé — NAF pointé, sinon on n'écrit rien (jamais de clé approximative).
    const nafPointe = normalizeNaf(naf)
    if (!nafPointe) return
    // Garde de dernier recours, doublon volontaire de celle de l'appelant : un
    // département vide ou en CSV (server.js:2354 traite le param en CSV) ne désigne
    // pas UN gisement → aucun marquage possible.
    const dept = str(departement)
    if (!dept || dept.includes(',')) return
    // Compteur informatif (cf. ci-dessus). countReferentielFresh est fail-safe (→ 0)
    // et applique lui-même normalizeNaf ; SANS `commune` : on compte le département entier.
    const n = Math.floor((await countReferentielFresh({ departement: dept, naf: nafPointe })) || 0)
    const db = await getDb()
    // UPSERT … SET (jamais CONTENT) : create-safe, et les datetimes restent calculés
    // en SurrealQL. type::record comme partout ailleurs dans le codebase. Le ':' interne
    // à $id ne pose pas de problème — la partie id est prise comme chaîne littérale.
    await db.query(
      `UPSERT type::record("referentiel_gisements", $id) SET
         naf = $naf,
         departement = $dept,
         complete = true,
         fiches_count = $n,
         refreshed_at = time::now()`,
      { id: `${nafPointe}:${dept}`, naf: nafPointe, dept, n }
    )
    console.log(`[gisement-mark] ${nafPointe}:${dept} complet — ${n} fiche(s) au stock`)
  } catch (e) {
    console.warn('[gisement-mark]', String(e?.message || e).slice(0, 80))
  }
}
