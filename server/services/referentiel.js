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
    'DEFINE FIELD IF NOT EXISTS dirigeant_nom ON referentiel_societes TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS dirigeant_prenom ON referentiel_societes TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS dirigeant_fonction ON referentiel_societes TYPE option<string>',
    "DEFINE FIELD IF NOT EXISTS source ON referentiel_societes TYPE string DEFAULT 'etalab_referentiel'",
    'DEFINE FIELD IF NOT EXISTS cached_at ON referentiel_societes TYPE datetime DEFAULT time::now()',
    'DEFINE FIELD IF NOT EXISTS refreshed_at ON referentiel_societes TYPE datetime DEFAULT time::now()',
    // SIRET clé naturelle → UNIQUE : garantit l'idempotence de l'UPSERT (un établissement = un record).
    'DEFINE INDEX IF NOT EXISTS idx_ref_siret ON referentiel_societes FIELDS siret UNIQUE',
    'DEFINE INDEX IF NOT EXISTS idx_ref_siren ON referentiel_societes FIELDS siren',
    'DEFINE INDEX IF NOT EXISTS idx_ref_naf ON referentiel_societes FIELDS naf',
    'DEFINE INDEX IF NOT EXISTS idx_ref_dept ON referentiel_societes FIELDS departement',
    'DEFINE INDEX IF NOT EXISTS idx_ref_commune ON referentiel_societes FIELDS commune',
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
async function upsertRecordRef(db, table, cleanId, body) {
  const params = { id: cleanId }
  const assigns = []
  for (const [k, v] of Object.entries(body)) {
    assigns.push(`${k} = $${k}`)
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
    for (const fiche of fiches) {
      try {
        // Établissement servi à l'abonné : matching_etablissements[0], fallback siège.
        const matching = Array.isArray(fiche?.matching_etablissements) ? fiche.matching_etablissements : []
        const etab = matching[0] || fiche?.siege || null
        if (!etab) continue
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
        // source : laissée au DEFAULT DB ('etalab_referentiel'). cached_at /
        // refreshed_at : posés en SurrealQL (time::now()) par upsertRecordRef.
        await upsertRecordRef(db, 'referentiel_societes', id, body)
      } catch (e) {
        console.warn('[referentiel-upsert]', String(e?.message || e).slice(0, 80))
      }
    }
  } catch (e) {
    console.warn('[referentiel-upsert]', String(e?.message || e).slice(0, 80))
  }
}
