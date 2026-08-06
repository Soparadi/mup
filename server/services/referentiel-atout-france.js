// Référentiel Atout France — hébergements touristiques classés (21 368 lignes,
// dont 21 183 avec un site : 99,1 %). Table SÉPARÉE de referentiel_societes,
// en LECTURE SEULE une fois chargée, sur le modèle de referentiel_osm.
//
// Source : data.classement.atout-france.fr, Licence Ouverte, mise à jour
// quotidienne, téléchargeable en bloc. Le fichier n'a NI SIRET, NI téléphone,
// NI courriel : il sert de source de `website` et de qualification, et sera
// rapproché par NAF + adresse + nom dans une passe ULTÉRIEURE. Cette table ne
// fait que le stockage — aucun rapprochement ici.
//
// Trois écarts assumés au patron referentiel_osm :
//
//  1. AUCUNE COORDONNÉE dans le fichier. Le patron « index sur lat seul, borné
//     par bbox » ne se transpose donc pas : la borne de chargement est le
//     DÉPARTEMENT, déduit du code postal et INDEXÉ à ce titre.
//
//  2. AUCUN IDENTIFIANT dans le fichier — pas de SIRET, pas de numéro de
//     classement stable. La clé naturelle est donc COMPOSÉE : nom commercial +
//     code postal + adresse brute, chacun normalisé (cf. atout-france.js,
//     composerCle). C'est la seule idempotence possible : deux téléchargements
//     du même établissement produisent la même clé, donc le même record.
//
//  3. ADRESSE ÉCLATÉE DÈS LA NAISSANCE. sonderAdresse (rapprochement-osm.js:213)
//     compare sur QUATRE champs séparés — postcode, street, housenumber, city —
//     jamais sur un agrégat. Une table jumelle qui naîtrait avec l'adresse en
//     une chaîne obligerait à la ré-éclater à chaque lecture. `adresse_brute`
//     conserve tout de même la chaîne d'origine : un éclatement amélioré pourra
//     être rejoué sans retélécharger.
//
// Schéma défini ci-dessous (runReferentielAtoutFranceMigration), joué au boot du
// serveur de manière idempotente (DEFINE … IF NOT EXISTS). Calque strict du
// patron runReferentielOsmMigration (server/services/referentiel-osm.js).

import { getDb } from '../../lib/surreal.js'

// ── migration idempotente ──
export async function runReferentielAtoutFranceMigration() {
  const db = await getDb()
  const queries = [
    // ── referentiel_atout_france — hébergements classés (clé composée) ──
    'DEFINE TABLE IF NOT EXISTS referentiel_atout_france SCHEMAFULL',
    // Clé naturelle composée nom+CP+adresse (le fichier n'a aucun identifiant).
    'DEFINE FIELD IF NOT EXISTS cle ON referentiel_atout_france TYPE string',
    // NOM COMMERCIAL du fichier, conservé tel quel : c'est lui que byNomVille
    // consommera au rapprochement, via normaliserSociete — pas la raison sociale,
    // que le fichier ne porte pas.
    'DEFINE FIELD IF NOT EXISTS nom ON referentiel_atout_france TYPE string',
    'DEFINE FIELD IF NOT EXISTS website ON referentiel_atout_france TYPE option<string>',
    // ── adresse ÉCLATÉE (jamais l'agrégat) ──
    'DEFINE FIELD IF NOT EXISTS housenumber ON referentiel_atout_france TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS street ON referentiel_atout_france TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS postcode ON referentiel_atout_france TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS city ON referentiel_atout_france TYPE option<string>',
    // La chaîne d'origine, pour rejouer un éclatement amélioré sans retélécharger.
    'DEFINE FIELD IF NOT EXISTS adresse_brute ON referentiel_atout_france TYPE option<string>',
    // Borne de chargement (le fichier n'ayant pas de coordonnées) → INDEXÉ.
    'DEFINE FIELD IF NOT EXISTS departement ON referentiel_atout_france TYPE string',
    // NAF déduit de la typologie, au format NN.NNL de referentiel_societes → INDEXÉ.
    'DEFINE FIELD IF NOT EXISTS naf ON referentiel_atout_france TYPE option<string>',
    // ── champs métier, conservés tels quels ──
    'DEFINE FIELD IF NOT EXISTS typologie ON referentiel_atout_france TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS classement ON referentiel_atout_france TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS categorie ON referentiel_atout_france TYPE option<string>',
    // MENTION (villages de vacances) — troisième facette du classement, aux côtés
    // de classement et categorie, renseignée pour les seuls villages de vacances.
    // Même règle que les autres : « - » vaut vide, vide vaut NONE.
    'DEFINE FIELD IF NOT EXISTS mention ON referentiel_atout_france TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS type_sejour ON referentiel_atout_france TYPE option<string>',
    // Les cinq dénombrements sont purement numériques dans le fichier (vérifié sur
    // les 21 368 lignes : chiffres ou « - »). Typés number pour rester comparables
    // au rapprochement ; une valeur non entière laisse le champ ABSENT, jamais une
    // erreur (cf. atout-france.js, nombre()).
    'DEFINE FIELD IF NOT EXISTS capacite ON referentiel_atout_france TYPE option<number>',
    'DEFINE FIELD IF NOT EXISTS chambres ON referentiel_atout_france TYPE option<number>',
    'DEFINE FIELD IF NOT EXISTS emplacements ON referentiel_atout_france TYPE option<number>',
    'DEFINE FIELD IF NOT EXISTS unites_habitation ON referentiel_atout_france TYPE option<number>',
    'DEFINE FIELD IF NOT EXISTS logements ON referentiel_atout_france TYPE option<number>',
    // Date de classement conservée TELLE QUELLE (jj/mm/aaaa) : la convertir serait
    // une réinterprétation, et rien n'en trie ni n'en filtre à ce stade.
    'DEFINE FIELD IF NOT EXISTS date_classement ON referentiel_atout_france TYPE option<string>',
    // « oui » / « non » dans le fichier — un énuméré, pas un booléen : tel quel.
    'DEFINE FIELD IF NOT EXISTS classement_proroge ON referentiel_atout_france TYPE option<string>',
    // Hôte du site, minuscule, www. retiré — la forme sur laquelle un rapprochement
    // par domaine se fera, sans reparser 21 k URL à chaque lecture.
    'DEFINE FIELD IF NOT EXISTS domaine ON referentiel_atout_france TYPE option<string>',
    // Licence Ouverte : citer producteur ET date de dernière mise à jour. Ces deux
    // champs sont la contrepartie de la réutilisation, pas un ornement — source_maj
    // vient du Last-Modified de la réponse, c'est la date que le producteur affiche.
    "DEFINE FIELD IF NOT EXISTS source ON referentiel_atout_france TYPE string DEFAULT 'atout_france'",
    'DEFINE FIELD IF NOT EXISTS source_maj ON referentiel_atout_france TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS cached_at ON referentiel_atout_france TYPE datetime DEFAULT time::now()',
    'DEFINE FIELD IF NOT EXISTS refreshed_at ON referentiel_atout_france TYPE datetime DEFAULT time::now()',
    // cle clé naturelle → UNIQUE : garantit l'idempotence de l'UPSERT (un
    // établissement = un record, quel que soit le nombre de chargements).
    'DEFINE INDEX IF NOT EXISTS idx_af_cle ON referentiel_atout_france FIELDS cle UNIQUE',
    // departement : borne de chargement, l'équivalent fonctionnel de idx_osm_lat.
    'DEFINE INDEX IF NOT EXISTS idx_af_departement ON referentiel_atout_france FIELDS departement',
    // naf NON unique : filtre de rapprochement (55.10Z / 55.20Z / 55.30Z, trois
    // valeurs pour 21 k lignes — l'index sert le filtre, pas la sélectivité).
    'DEFINE INDEX IF NOT EXISTS idx_af_naf ON referentiel_atout_france FIELDS naf'
  ]
  for (const q of queries) {
    try { await db.query(q) } catch (e) { console.warn('[referentiel-atout-france-migration]', q.slice(0, 80), '→', e.message) }
  }
}
