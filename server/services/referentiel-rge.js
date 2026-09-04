// Référentiel RGE — entreprises « Reconnu Garant de l'Environnement » (162 259
// lignes). Table SÉPARÉE de referentiel_societes, en LECTURE SEULE une fois
// chargée, sur le modèle de referentiel_atout_france.
//
// Source : ADEME, jeu data-fair `liste-des-entreprises-rge-2`, Licence Ouverte,
// finalisé chaque nuit (~03 h 01). Le jeu est VIRTUEL — une vue de
// `historique-rge` filtrée sur `traitement_termine = false` — donc SANS fichier
// d'origine : aucune route de bloc n'existe (ni /raw, ni /full, ni /data-files,
// ni compatibilité ODS ; toutes sondées, toutes en 404). La seule voie est la
// pagination CSV au curseur sur /lines, plafonnée à 10 000 lignes par requête.
// C'est le chargeur (server/services/rge.js) qui s'en charge ; cette table ne
// fait que le stockage — aucun rapprochement ici.
//
// Quatre écarts au patron referentiel_atout_france, tous dictés par la source :
//
//  1. IDENTIFIANT FOURNI. Là où le fichier Atout France n'a AUCUN identifiant et
//     oblige à composer une clé naturelle nom+CP+adresse, la source RGE porte un
//     `_id` propre (forme « S214148-4671513-2-2022-02-18 »). C'est lui, et lui
//     seul, qui va dans `cle` : la clé métier, elle, N'EST PAS UNIQUE — 1 doublon
//     sur 200 lignes sur l'échantillon mesuré, une même entreprise pouvant porter
//     deux fois le même triplet (siret, url_qualification, lien_date_debut).
//     L'idempotence de l'UPSERT repose donc entièrement sur la stabilité de `_id`
//     d'une republication à l'autre.
//
//  2. SIREN, PAS SIRET, COMME CLÉ DE JOINTURE. Le SIRET est présent et complet
//     (14 chiffres sur 100 % de l'échantillon), mais un quart des entreprises est
//     enregistré chez l'ADEME sous un établissement autre que celui de
//     referentiel_societes. `siren` — les 9 premiers chiffres — est donc dérivé au
//     chargement et INDEXÉ à ce titre : c'est lui qui portera le rapprochement.
//     `siret` reste indexé aussi, mais NON UNIQUE : une entreprise porte 1 à 3
//     lignes, une par qualification.
//
//  3. `domaine` DE LA SOURCE DEVIENT `domaine_travaux`. Dans le jeu de l'ADEME,
//     `domaine` désigne le DOMAINE DE TRAVAUX (« Chaudière bois », « Isolation
//     des murs »…), jamais un domaine internet. Or referentiel_atout_france
//     nomme `domaine` l'hôte du site, et c'est ce sens-là qui circule ailleurs
//     dans la maison. Garder le nom de la source ici ferait cohabiter deux
//     `domaine` de sens opposés dans deux tables jumelles : la première requête
//     écrite de mémoire serait fausse, et elle serait fausse silencieusement.
//     D'où le RENOMMAGE : la colonne source `domaine` est stockée sous
//     `domaine_travaux`, et l'hôte du site — même geste que normaliserSite — sous
//     `domaine_web`. Aucun des deux noms n'est ambigu, et aucun des deux n'est
//     celui de la source : c'est délibéré, un nom à moitié changé induirait plus
//     en erreur qu'un nom franchement changé.
//
//  4. AUCUNE COORDONNÉE OBLIGATOIRE, mais des coordonnées quand même. La source
//     donne latitude/longitude, vides sur ~0,3 % des lignes. Elles sont stockées
//     en option<number> mais NON INDEXÉES : la borne de chargement n'est pas
//     géographique — c'est le curseur de pagination — et le rapprochement passera
//     par le SIREN, pas par la géométrie. Un index sur latitude serait payé à
//     chaque écriture pour un usage qui n'existe pas.
//
// CE QUI EST STOCKÉ TEL QUEL, et pourquoi. `telephone` (87 % au format
// « 0X XX XX XX XX », 13 % vide), `email`, `site_internet` (44 % http://, 19 %
// https://, 37 % vide) et `lien_date_fin` sont conservés dans leur forme
// d'origine. Normaliser au chargement, ce serait figer aujourd'hui une décision
// de rapprochement qu'on prendra demain, et perdre l'original pour la rejouer.
// Seul `domaine_web` est dérivé, parce que reparser 162 k URL à chaque lecture
// n'a pas de sens.
//
// LES QUALIFICATIONS ÉCHUES SONT CHARGÉES. 353 lignes sur 162 259 (0,22 %)
// portent un `lien_date_fin` déjà passé. Elles entrent en table : la date est
// stockée, la décision de les écarter se prendra À LA LECTURE. Une table qui ne
// reproduit pas le compte de la source n'est pas vérifiable — et c'est cette
// vérifiabilité qui dira si le chargement est complet.
//
// Schéma défini ci-dessous (runReferentielRgeMigration), joué au boot du serveur
// de manière idempotente (DEFINE … IF NOT EXISTS). Calque strict du patron
// runReferentielAtoutFranceMigration.

import { getDb } from '../../lib/surreal.js'

// ── migration idempotente ──
export async function runReferentielRgeMigration() {
  const db = await getDb()
  const queries = [
    // ── referentiel_rge — qualifications RGE (une ligne = une qualification) ──
    'DEFINE TABLE IF NOT EXISTS referentiel_rge SCHEMAFULL',
    // `_id` de la source, seul identifiant stable du jeu. La clé métier n'est pas
    // unique : c'est ce champ, et pas elle, qui porte l'idempotence.
    'DEFINE FIELD IF NOT EXISTS cle ON referentiel_rge TYPE string',
    // ── identité de l'entreprise ──
    // SIRET à 14 chiffres, garanti par le chargeur (une ligne sans SIRET valide
    // est ignorée, jamais écrite). Indexé, NON unique.
    'DEFINE FIELD IF NOT EXISTS siret ON referentiel_rge TYPE string',
    // SIREN dérivé des 9 premiers chiffres du SIRET — clé de jointure principale.
    'DEFINE FIELD IF NOT EXISTS siren ON referentiel_rge TYPE string',
    'DEFINE FIELD IF NOT EXISTS nom_entreprise ON referentiel_rge TYPE option<string>',
    // ── localisation ──
    // Adresse en UNE chaîne, telle que la source la donne : contrairement à Atout
    // France, aucun éclatement ici. Le rapprochement passera par le SIREN, qui
    // n'a besoin d'aucun champ d'adresse ; éclater maintenant serait travailler
    // pour un usage qu'on ne s'est pas encore donné.
    'DEFINE FIELD IF NOT EXISTS adresse ON referentiel_rge TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS code_postal ON referentiel_rge TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS commune ON referentiel_rge TYPE option<string>',
    // Déduit du code postal par departementDepuisCp (atout-france.js) : même
    // traitement de la Corse (2A/2B au seuil 20200) et de l'outre-mer (3 chiffres
    // pour 97x/98x). Obligatoire et INDEXÉ — c'est la borne de lecture par
    // territoire, comme pour referentiel_atout_france. Vaut '' si le code postal
    // n'est pas fait de 5 chiffres : la ligne est conservée, seule la borne est
    // perdue.
    'DEFINE FIELD IF NOT EXISTS departement ON referentiel_rge TYPE string',
    // Coordonnées de la source, vides sur ~0,3 % des lignes. NON INDEXÉES (cf. en-tête).
    'DEFINE FIELD IF NOT EXISTS latitude ON referentiel_rge TYPE option<number>',
    'DEFINE FIELD IF NOT EXISTS longitude ON referentiel_rge TYPE option<number>',
    // ── contact, conservé BRUT (cf. en-tête) ──
    'DEFINE FIELD IF NOT EXISTS telephone ON referentiel_rge TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS email ON referentiel_rge TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS site_internet ON referentiel_rge TYPE option<string>',
    // ── qualification ──
    'DEFINE FIELD IF NOT EXISTS code_qualification ON referentiel_rge TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS nom_qualification ON referentiel_rge TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS url_qualification ON referentiel_rge TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS nom_certificat ON referentiel_rge TYPE option<string>',
    // RENOMMÉE : colonne source `domaine`, qui désigne le DOMAINE DE TRAVAUX.
    // Voir l'écart n° 3 en tête de fichier — le renommage n'est pas cosmétique.
    'DEFINE FIELD IF NOT EXISTS domaine_travaux ON referentiel_rge TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS meta_domaine ON referentiel_rge TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS organisme ON referentiel_rge TYPE option<string>',
    // Le schéma de la source déclare `particulier` en `boolean` ; c'est la
    // sérialisation CSV qui l'aplatit en 1/0. On rétablit le type d'origine
    // plutôt que de stocker un énuméré de circonstance (à la différence de
    // classement_proroge d'Atout France, qui est « oui »/« non » dans la source
    // elle-même). Une valeur qui ne serait ni 1 ni 0 laisse le champ ABSENT.
    'DEFINE FIELD IF NOT EXISTS particulier ON referentiel_rge TYPE option<bool>',
    // Dates de validité de la qualification, ISO AAAA-MM-JJ, conservées en
    // chaîne : la source utilise 2099-01-01 comme sentinelle « sans échéance »
    // (7 838 lignes, 4,8 %), et convertir en datetime donnerait à cette
    // convention l'apparence d'une date réelle.
    'DEFINE FIELD IF NOT EXISTS lien_date_debut ON referentiel_rge TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS lien_date_fin ON referentiel_rge TYPE option<string>',
    // Hôte de site_internet, minuscule, www. retiré — même geste que
    // normaliserSite (atout-france.js), dont c'est l'appel direct. Nommé
    // `domaine_web` et non `domaine` pour qu'aucune confusion avec
    // `domaine_travaux` ne soit possible (écart n° 3).
    'DEFINE FIELD IF NOT EXISTS domaine_web ON referentiel_rge TYPE option<string>',
    // Licence Ouverte : citer producteur ET date de dernière mise à jour. Ces deux
    // champs sont la contrepartie de la réutilisation, pas un ornement — source_maj
    // vient du Last-Modified de la réponse /lines, concordant avec le dataUpdatedAt
    // du jeu, c'est la date que le producteur affiche.
    "DEFINE FIELD IF NOT EXISTS source ON referentiel_rge TYPE string DEFAULT 'ademe_rge'",
    'DEFINE FIELD IF NOT EXISTS source_maj ON referentiel_rge TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS cached_at ON referentiel_rge TYPE datetime DEFAULT time::now()',
    'DEFINE FIELD IF NOT EXISTS refreshed_at ON referentiel_rge TYPE datetime DEFAULT time::now()',
    // cle (= `_id` de la source) → UNIQUE : garantit l'idempotence de l'UPSERT
    // (une qualification = un record, quel que soit le nombre de chargements).
    'DEFINE INDEX IF NOT EXISTS idx_rge_cle ON referentiel_rge FIELDS cle UNIQUE',
    // siren : clé de jointure principale du rapprochement à venir → INDEXÉ.
    'DEFINE INDEX IF NOT EXISTS idx_rge_siren ON referentiel_rge FIELDS siren',
    // siret NON unique : une entreprise porte 1 à 3 lignes, une par qualification.
    'DEFINE INDEX IF NOT EXISTS idx_rge_siret ON referentiel_rge FIELDS siret',
    // departement : borne de lecture par territoire, comme pour idx_af_departement.
    'DEFINE INDEX IF NOT EXISTS idx_rge_departement ON referentiel_rge FIELDS departement'
  ]
  for (const q of queries) {
    try { await db.query(q) } catch (e) { console.warn('[referentiel-rge-migration]', q.slice(0, 80), '→', e.message) }
  }
}
