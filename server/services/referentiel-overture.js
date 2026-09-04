// Référentiel Overture Places : lieux de la base Overture Maps (2 164 599 lignes
// pour la France métropolitaine, plus 41 623 outre-mer). Table SÉPARÉE, sur le
// patron de referentiel_rge et referentiel_atout_france : elle stocke, elle ne
// rapproche rien, et elle n'écrit JAMAIS dans referentiel_societes.
//
// ── POURQUOI UNE TABLE À PART, ET PAS UN AJOUT À referentiel_osm ────────────
// Les deux sources décrivent le même genre d'objet (un lieu, un nom, une
// position), et c'est précisément pourquoi il ne faut pas les confondre. Elles
// n'ont pas la même licence : referentiel_osm vient d'OpenStreetMap, sous ODbL,
// qui impose le partage à l'identique de toute base dérivée. Overture Places,
// lui, ne porte AUCUNE ligne ODbL sur la France : le relevé des 4 329 198
// enregistrements source de la métropole donne CDLA-Permissive-2.0 3 961 461,
// Apache-2.0 288 681, CC0-1.0 79 056, et zéro ODbL. Verser Overture dans la
// table OSM ferait de l'ensemble une base dérivée d'une base ODbL. Deux tables
// distinctes maintiennent la séparation que la licence suppose ; c'est un choix
// juridique avant d'être un choix technique.
//
// ── LA PROVENANCE EST UN CHAMP, PAS UN COMMENTAIRE ──────────────────────────
// Les trois licences exigent l'attribution. Elle est portée à deux endroits :
// dans le dépôt (NOTICE.txt de Foursquare, conservé intégralement comme la
// licence Apache 2.0 l'impose ; attribution des trois licences sur la page
// /mentions-legales), et LIGNE PAR LIGNE ici, par source_dataset, source_licence,
// source_maj et source_release. Une ligne isolée doit pouvoir dire d'où elle
// vient : sans cela, l'attribution ne survit pas au premier export.
// Un enregistrement porte souvent plusieurs sources (4,33 M sources pour 2,16 M
// lignes) : les deux champs les joignent par virgule plutôt que d'en élire une.
//
// ── CE QUI EST DÉRIVÉ AU CHARGEMENT, ET CE QUI RESTE BRUT ───────────────────
//  · `departement` vient du code postal par departementDepuisCp (atout-france),
//    et il est INDEXÉ. C'est la borne de lecture par territoire, comme sur RGE
//    et Atout France, et sur 2,16 M lignes ce n'est plus un confort : une
//    lecture non bornée sur cette table est le mode de défaillance silencieuse
//    de l'instance (socket lâché, sortie sans donnée). Le champ vaut '' quand le
//    code postal n'est pas fait de cinq chiffres : la ligne est conservée,
//    seule la borne est perdue.
//  · `lat` est INDEXÉ seul, comme sur referentiel_osm : c'est ce qui permet de
//    lire une bande de latitude sans balayer la table. `lng` ne l'est pas, la
//    bande de longitude se filtre après.
//  · `domaine` est l'hôte de `site`, par normaliserSite. Reparser 2,16 M URL à
//    chaque lecture n'aurait pas de sens.
//  · `numero_voie` et `libelle_voie` viennent de l'adresse libre par
//    parserAdresseAgregee, la fonction déjà en service. `libelle_voie` garde la
//    forme BRUTE du libellé, comme referentiel_osm.street et comme
//    referentiel_societes.libelle_voie : c'est normaliserVoie qui canonise, au
//    moment de la comparaison, jamais le stockage. L'adresse libre d'origine
//    reste dans `adresse` : une découpe se rejoue, une source perdue non.
//  · les réseaux sociaux sont éclatés par hôte en facebook / instagram /
//    linkedin / social_autre, calqué sur referentiel_osm. Le gisement est massif
//    mais monocorde : 1 842 533 Facebook contre 39 502 lignes portant autre
//    chose.
//  · téléphone, courriel et site gardent la forme de la source. 350 lignes
//    portent deux téléphones et 1 260 deux sites : on prend la première valeur,
//    la seconde n'a jamais désigné un autre établissement sur l'échantillon.
//
// ── CE QUI EST ÉCARTÉ, ET POURQUOI ──────────────────────────────────────────
//  · `region` : rempli sur 15 % des lignes et hétérogène (« Paris »,
//    « Île-de-France », « OCC », vide, dans la même colonne). Le département
//    dérivé du code postal fait le travail proprement.
//  · `taxonomy.hierarchy` : 53 octets par ligne pour un chemin entièrement
//    dérivable de `taxonomie`.
//  · `categories.alternate` : un troisième axe de catégorie à côté de deux déjà
//    retenus, 26 octets sur 1,47 M lignes.
//  · `geometry` : redondant avec lat/lng, la géométrie étant ponctuelle
//    (bbox.xmin = bbox.xmax).
//  · `names.common` et `names.rules` (multilingue), `brand.wikidata`,
//    `sources[].property` (provenance champ par champ), `sources[].record_id`,
//    `theme` et `type` (constantes), `addresses[2..]` (aucune ligne française
//    n'a plus d'une adresse).
//
// ── DEUX CHAMPS RENOMMÉS PAR PRUDENCE ───────────────────────────────────────
// La source nomme `release` l'édition du jeu et `version` le numéro de révision
// de l'enregistrement. Les deux mots ont un sens en SurrealQL. Ils sont stockés
// sous `source_release` et `source_version`, ce qui les range en outre avec les
// autres champs de provenance, où ils appartiennent.
//
// `operating_status` (ici `statut`) est chargé mais ne sert de filtre à RIEN :
// il est nul sur 2 152 610 lignes, vaut `open` sur 9 504, et `closed` sur ZÉRO.
// Ce champ ne signale aucune fermeture, il ne dira jamais qu'un lieu a fermé.
//
// AUCUN FILTRE DE CONFIANCE au chargement. La médiane est à 0,77 et 214 536
// lignes (9,9 %) sont sous 0,3 ; elles entrent quand même, la valeur est
// stockée, et la décision de les écarter se prendra À LA LECTURE. Une table qui
// ne reproduit pas le compte de la source n'est pas vérifiable.
//
// Le chargement est fait par scripts/charger-overture-tranche.mjs, hors serveur :
// la source est un fichier Parquet de 294 Mo lu par DuckDB, que le conteneur de
// production n'a ni la mémoire ni l'outillage pour traiter.
//
// Migration idempotente (DEFINE … IF NOT EXISTS), jouée au boot comme ses
// jumelles.

import { getDb } from '../../lib/surreal.js'

// ── migration idempotente ──
export async function runReferentielOvertureMigration() {
  const db = await getDb()
  const queries = [
    'DEFINE TABLE IF NOT EXISTS referentiel_overture SCHEMAFULL',
    // Identifiant GERS de la source (36 octets, forme « 08f2c0a2… »). Stable
    // d'une édition à l'autre : c'est lui qui porte l'idempotence de l'UPSERT.
    'DEFINE FIELD IF NOT EXISTS cle ON referentiel_overture TYPE string',
    // ── identité ──
    // Nom principal, rempli sur 100 % des lignes : le chargeur refuse une ligne
    // sans nom, elle ne désignerait rien.
    'DEFINE FIELD IF NOT EXISTS nom ON referentiel_overture TYPE string',
    // Enseigne de réseau quand la source la connaît. 13,9 octets en moyenne,
    // c'est ce qui distingue un point de vente d'une marque d'un indépendant.
    'DEFINE FIELD IF NOT EXISTS marque ON referentiel_overture TYPE option<string>',
    // ── activité : les trois axes primaires de la source (1 143 / 1 143 / 252
    // valeurs distinctes). Aucun n'est indexé : le rapprochement par activité
    // appartient au lot d'appariement, un index se paierait dès maintenant à
    // chaque écriture pour un usage qui n'existe pas encore.
    'DEFINE FIELD IF NOT EXISTS categorie ON referentiel_overture TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS taxonomie ON referentiel_overture TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS categorie_base ON referentiel_overture TYPE option<string>',
    // Confiance de la source, 0 à 1. Stockée, jamais filtrée au chargement.
    'DEFINE FIELD IF NOT EXISTS confiance ON referentiel_overture TYPE option<number>',
    // operating_status. NONE sur 99,4 % des lignes, et jamais 'closed' : ce
    // champ ne vaut aucune fraîcheur (cf. en-tête).
    'DEFINE FIELD IF NOT EXISTS statut ON referentiel_overture TYPE option<string>',
    // ── contact, forme de la source ──
    'DEFINE FIELD IF NOT EXISTS site ON referentiel_overture TYPE option<string>',
    // Hôte de `site`, minuscule, www. retiré : même geste que domaine_web sur RGE.
    'DEFINE FIELD IF NOT EXISTS domaine ON referentiel_overture TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS telephone ON referentiel_overture TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS email ON referentiel_overture TYPE option<string>',
    // Réseaux sociaux éclatés par hôte, patron referentiel_osm.
    'DEFINE FIELD IF NOT EXISTS facebook ON referentiel_overture TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS instagram ON referentiel_overture TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS linkedin ON referentiel_overture TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS social_autre ON referentiel_overture TYPE option<string>',
    // ── localisation ──
    // Adresse libre BRUTE, telle que la source la donne. La découpe ci-dessous
    // en est dérivée et ne la remplace pas.
    'DEFINE FIELD IF NOT EXISTS adresse ON referentiel_overture TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS numero_voie ON referentiel_overture TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS libelle_voie ON referentiel_overture TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS code_postal ON referentiel_overture TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS ville ON referentiel_overture TYPE option<string>',
    // Dérivé du code postal, INDEXÉ : la borne de lecture par territoire.
    'DEFINE FIELD IF NOT EXISTS departement ON referentiel_overture TYPE string',
    // Position ponctuelle, depuis bbox.ymin / bbox.xmin.
    'DEFINE FIELD IF NOT EXISTS lat ON referentiel_overture TYPE option<number>',
    'DEFINE FIELD IF NOT EXISTS lng ON referentiel_overture TYPE option<number>',
    // ── provenance, exigée par les trois licences (cf. en-tête) ──
    "DEFINE FIELD IF NOT EXISTS source ON referentiel_overture TYPE string DEFAULT 'overture'",
    // Jeux d'origine de l'enregistrement, joints par virgule (meta, Foursquare,
    // AllThePlaces, PinMeTo, DAC, Overture).
    'DEFINE FIELD IF NOT EXISTS source_dataset ON referentiel_overture TYPE option<string>',
    // Licences correspondantes, dans le même ordre : CDLA-Permissive-2.0,
    // Apache-2.0, CC0-1.0.
    'DEFINE FIELD IF NOT EXISTS source_licence ON referentiel_overture TYPE option<string>',
    // Dernière mise à jour déclarée par la source la plus fraîche de la ligne.
    'DEFINE FIELD IF NOT EXISTS source_maj ON referentiel_overture TYPE option<string>',
    // Édition Overture d'où vient la ligne, ex. « 2026-08-19.0 ». Renommé depuis
    // `release` (cf. en-tête).
    'DEFINE FIELD IF NOT EXISTS source_release ON referentiel_overture TYPE option<string>',
    // Révision de l'enregistrement chez Overture. Renommé depuis `version`.
    'DEFINE FIELD IF NOT EXISTS source_version ON referentiel_overture TYPE option<number>',
    'DEFINE FIELD IF NOT EXISTS cached_at ON referentiel_overture TYPE datetime DEFAULT time::now()',
    'DEFINE FIELD IF NOT EXISTS refreshed_at ON referentiel_overture TYPE datetime DEFAULT time::now()',
    // ── Marquage des lignes consommées par l'appariement, INTERNE ──
    // Une ligne qui a pourvu une fiche du référentiel est DATÉE et rattachée au
    // SIRET qu'elle a pourvu. Elle n'est pas supprimée : une erreur d'appariement
    // doit pouvoir se reprendre, et c'est consomme_siret qui dit laquelle reprendre.
    //
    // CE QU'IL ÉVITE : la livraison mensuelle relance la passe sur le même couple.
    // Sans marque, elle réapparie des lignes qui ont déjà donné ce qu'elles avaient,
    // pour un remplissage-si-vide qui n'écrira rien. Le tirage ajoute donc
    // `AND consomme_le = NONE` à sa clause de bande, et ces lignes ne montent plus
    // sur le fil.
    //
    // LA LIVRAISON MENSUELLE NE LES EFFACE PAS, et c'est ce qui rend le marquage
    // durable : le chargeur écrit en UPSERT … SET à liste énumérée (cle, nom,
    // departement, les champs optionnels, source, cached_at, refreshed_at). Un champ
    // hors de cette liste n'est pas touché par le SET, donc la marque survit au
    // rechargement d'une édition.
    //
    // AUCUN INDEX, conformément à la règle de cette table : le filtre se paie sur des
    // lignes déjà matérialisées par idx_overture_lat, là où un index sur un champ NONE
    // presque partout se paierait à chaque ligne rechargée.
    //
    // consomme_siret est SINGULIER, et il le peut : la passe exige le survivant unique
    // des DEUX côtés, une ligne réclamée par plusieurs fiches est écartée pour toutes.
    // Sans cette symétrie, la marque ne porterait que la dernière des fiches servies.
    'DEFINE FIELD IF NOT EXISTS consomme_le ON referentiel_overture TYPE option<datetime>',
    'DEFINE FIELD IF NOT EXISTS consomme_siret ON referentiel_overture TYPE option<string>',
    // ── trois index, pas un de plus ──
    // cle UNIQUE : un lieu = un record, quel que soit le nombre de rechargements.
    'DEFINE INDEX IF NOT EXISTS idx_overture_cle ON referentiel_overture FIELDS cle UNIQUE',
    // departement : la borne de lecture par territoire.
    'DEFINE INDEX IF NOT EXISTS idx_overture_departement ON referentiel_overture FIELDS departement',
    // lat : la borne de lecture par bande géographique, patron referentiel_osm.
    'DEFINE INDEX IF NOT EXISTS idx_overture_lat ON referentiel_overture FIELDS lat'
  ]
  for (const q of queries) {
    try { await db.query(q) } catch (e) { console.warn('[referentiel-overture-migration]', q.slice(0, 80), '→', e.message) }
  }
}
