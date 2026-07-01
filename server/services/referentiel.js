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
