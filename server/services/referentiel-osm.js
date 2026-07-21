// Référentiel OSM — réserve nationale de contacts issus du gisement
// OpenStreetMap (~685 k lignes, osm-entreprises-propre.ndjson). Table
// SÉPARÉE de referentiel_societes : clé naturelle osm_id (UNIQUE), SIRET
// en index secondaire NON unique pour la jointure à la recherche.
//
// Mapping 1:1 avec le NDJSON — tous les champs sont conservés. Seul lon
// est renommé lng à l'import, pour cohérence avec referentiel_societes.
// Migration additive pure : nouvelle table, zéro impact sur l'existant.
// Vide au boot : alimentation par UPSERT dans une passe ultérieure.
//
// Schéma défini ci-dessous (runReferentielOsmMigration), joué au boot du
// serveur de manière idempotente (DEFINE … IF NOT EXISTS). Calque strict
// du pattern runReferentielMigration (server/services/referentiel.js).

import { getDb } from '../../lib/surreal.js'

// ── migration idempotente ──
export async function runReferentielOsmMigration() {
  const db = await getDb()
  const queries = [
    // ── referentiel_osm — réserve nationale de contacts OSM (clé osm_id) ──
    'DEFINE TABLE IF NOT EXISTS referentiel_osm SCHEMAFULL',
    'DEFINE FIELD IF NOT EXISTS osm_id ON referentiel_osm TYPE number',
    'DEFINE FIELD IF NOT EXISTS osm_type ON referentiel_osm TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS nom ON referentiel_osm TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS siret ON referentiel_osm TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS siren ON referentiel_osm TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS phone ON referentiel_osm TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS email ON referentiel_osm TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS website ON referentiel_osm TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS facebook ON referentiel_osm TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS instagram ON referentiel_osm TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS linkedin ON referentiel_osm TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS housenumber ON referentiel_osm TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS street ON referentiel_osm TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS postcode ON referentiel_osm TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS city ON referentiel_osm TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS shop ON referentiel_osm TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS craft ON referentiel_osm TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS office ON referentiel_osm TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS amenity ON referentiel_osm TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS healthcare ON referentiel_osm TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS tourism ON referentiel_osm TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS lat ON referentiel_osm TYPE option<number>',
    // lng : mappé depuis lon à l'import (cohérence referentiel_societes).
    'DEFINE FIELD IF NOT EXISTS lng ON referentiel_osm TYPE option<number>',
    "DEFINE FIELD IF NOT EXISTS source ON referentiel_osm TYPE string DEFAULT 'osm'",
    'DEFINE FIELD IF NOT EXISTS cached_at ON referentiel_osm TYPE datetime DEFAULT time::now()',
    'DEFINE FIELD IF NOT EXISTS refreshed_at ON referentiel_osm TYPE datetime DEFAULT time::now()',
    // osm_id clé naturelle → UNIQUE : garantit l'idempotence de l'UPSERT (un objet OSM = un record).
    'DEFINE INDEX IF NOT EXISTS idx_osm_id ON referentiel_osm FIELDS osm_id UNIQUE',
    // SIRET NON unique : jointure à la recherche (plusieurs objets OSM peuvent porter le même SIRET).
    'DEFINE INDEX IF NOT EXISTS idx_osm_siret ON referentiel_osm FIELDS siret'
  ]
  for (const q of queries) {
    try { await db.query(q) } catch (e) { console.warn('[referentiel-osm-migration]', q.slice(0, 80), '→', e.message) }
  }
}
