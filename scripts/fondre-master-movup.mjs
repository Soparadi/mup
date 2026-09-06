// MASTER MOVUP, LA FUSION. HORS LIGNE, LOCAL, AUCUN ACCES A LA BASE.
//
// Reconstruit master-movup-<date>.parquet et son manifeste a partir des seuls
// parquets de source. Rejouable : deux passages sur les memes entrees rendent le
// meme fichier. Le master ne se modifie jamais a la main.
//
// usage : node scripts/fondre-master-movup.mjs
//           [--socle <parquet>]   defaut data/sirene/sirene-propre-20260901.parquet
//           [--src <dir>]         defaut data/appariement-local
//           [--sortie <dir>]      defaut le bureau de l utilisateur
//           [--date <AAAAMMJJ>]   defaut le jour courant
//
// Une ligne par SIRET du socle sirene-propre, servie ou non. Remplissage si vide,
// canal par canal, dans l ordre arrete par canal. Une valeur deja ecrite n est
// jamais ecrasee.
//
// LA REGLE D HOTE N EST PAS RECOPIEE ICI. hoteDeSite, hostBlacklisted et
// champReseauPourHote sont importes de server/services/hotes-exclus.js, le module
// de production pose au commit 1e1825f. Le script demande a duckdb la liste des
// sites distincts, tranche chaque hote en JavaScript avec ce module, et rend le
// verdict a duckdb. Aucune divergence possible entre les deux lectures d hote.
//
// N OUVRE AUCUNE CONNEXION, N ECRIT RIEN EN BASE.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, statSync, createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hoteDeSite, hostBlacklisted, champReseauPourHote, BLACKLIST_HOSTS } from '../server/services/hotes-exclus.js'

// ── Les options, valeurs actuelles en defaut ────────────────────────────────
// Sans argument, le script fond ce qu il a toujours fondu. Quatre entrees s
// ouvrent, et elles seules : le socle, le dossier des parquets de source, le
// dossier de sortie, la date qui nomme le master.
//
// LES MILLESIMES DE SOURCES RESTENT EN DUR. Ils nomment les fichiers reellement
// fondus et le manifeste les recopie : les ouvrir a la ligne de commande viderait
// le manifeste de sa valeur de preuve.
const OPTIONS = { socle: null, src: null, sortie: null, date: null }
const USAGE = 'usage : node scripts/fondre-master-movup.mjs [--socle <parquet>] [--src <dir>] [--sortie <dir>] [--date <AAAAMMJJ>]'
const arguments_ = process.argv.slice(2)
for (let i = 0; i < arguments_.length; i += 2) {
  const nom = arguments_[i].startsWith('--') ? arguments_[i].slice(2) : null
  if (nom === null || !(nom in OPTIONS) || arguments_[i + 1] === undefined) {
    console.error(USAGE)
    process.exit(2)
  }
  OPTIONS[nom] = arguments_[i + 1]
}
if (OPTIONS.date !== null && !/^\d{8}$/.test(OPTIONS.date)) {
  console.error('--date attend huit chiffres, AAAAMMJJ')
  process.exit(2)
}

// Le jour courant se lit sur l horloge locale, non en UTC : passe minuit a Paris,
// UTC nomme encore la veille et le master porterait la mauvaise date.
const maintenant = new Date()
const AUJOURD_HUI = `${maintenant.getFullYear()}${String(maintenant.getMonth() + 1).padStart(2, '0')}${String(maintenant.getDate()).padStart(2, '0')}`

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = OPTIONS.src ? resolve(OPTIONS.src) : join(RACINE, 'data/appariement-local')
const SOCLE = OPTIONS.socle ? resolve(OPTIONS.socle) : join(RACINE, 'data/sirene/sirene-propre-20260901.parquet')
const TRAVAIL = join(SRC, 'fusion')
const SORTIE = OPTIONS.sortie ? resolve(OPTIONS.sortie) : join(homedir(), 'Desktop')
const DATE = OPTIONS.date || AUJOURD_HUI
const MASTER = join(SORTIE, `master-movup-${DATE}.parquet`)
const MANIFESTE = join(SORTIE, `master-movup-${DATE}.manifeste.json`)
const BASE = join(TRAVAIL, 'fusion.duckdb')

mkdirSync(TRAVAIL, { recursive: true })
mkdirSync(SORTIE, { recursive: true })

// ── Les sources, telles qu elles seront declarees au manifeste ───────────────
// Le millesime dit quand la ligne a pris sa forme, jamais quand on l a regardee.
const SOURCES = {
  overture: {
    fichier: 'overture.parquet',
    appariement: 'appariement-overture-50m-20260906.parquet',
    producteur: 'Overture Maps Foundation',
    licence: 'CDLA-Permissive-2.0 et suivantes',
    millesime: '2026-08-19.0',
    regle_jointure: 'appariement calcule par app_50g : 426 528 couples, rayon 50 m, score de nom >= 0,85, un SIRET par cle et une cle par SIRET',
    cle: 'referentiel_overture.cle'
  },
  finess: {
    fichier: 'finess-tel-202608.parquet',
    producteur: 'Ministere de la Sante',
    licence: 'Licence Ouverte',
    millesime: '202608',
    regle_jointure: 'SIRET exact, aucun appariement geographique ni sur le nom',
    cle: 'numero FINESS'
  },
  rna_waldec: {
    fichier: 'rna-waldec-20260901.parquet',
    producteur: 'Ministere de l Interieur',
    licence: 'Licence Ouverte 2.0',
    millesime: '2026-09-01',
    regle_jointure: 'double pont, du RNA vers le SIRET par le numero d association porte par Sirene',
    cle: 'numero RNA'
  },
  atout_france: {
    fichier: 'atout_france.parquet',
    appariement: 'appariement-atout-france-20260906.parquet',
    producteur: 'Atout France',
    licence: 'Licence Ouverte',
    millesime: '2026-08-06',
    regle_jointure: 'union de deux voies : concordance voie-adresse (4 371 couples) et proximite (612 couples)',
    cle: 'referentiel_atout_france.cle'
  },
  rge: {
    fichier: 'rge-complet-20260906.parquet',
    producteur: 'ADEME',
    licence: 'Licence Ouverte 2.0',
    millesime: '2026-09-05',
    regle_jointure: 'SIRET exact, aucun appariement geographique ni sur le nom',
    cle: 'referentiel_rge.cle, qui porte le SIRET'
  },
  rpps: {
    fichier: 'annuaire-sante-rpps-20260905.parquet',
    producteur: 'Agence du Numerique en Sante',
    licence: 'Licence Ouverte 2.0',
    millesime: '2026-09-05',
    regle_jointure: 'SIRET exact puis pont FINESS',
    cle: 'numeros RPPS du site, joints par barre verticale'
  },
  museofile: {
    fichier: 'museofile-20260831.parquet',
    producteur: 'Ministere de la Culture',
    licence: 'Licence Ouverte 2.0',
    millesime: '2026-08-31',
    regle_jointure: 'regle C+D, 82 SIRET retenus',
    cle: 'identifiant Museofile'
  },
  avocats: {
    fichier: 'appariement-avocats-20260717.parquet',
    producteur: 'Conseil national des barreaux',
    licence: 'non declaree par le producteur',
    millesime: '2026-07-17',
    regle_jointure: 'trois niveaux de cle. siret quand le SIRET reconstitue est au socle ; siren quand la source ne porte que le SIREN ; siren_repli quand le SIRET reconstitue est absent du socle mais que son SIREN y est, la ligne redescend alors au SIREN et peint tous ses etablissements.',
    cle: 'le niveau de cle lui-meme : siret, siren ou siren_repli'
  }
}

// Le fichier des qualifications ne porte aucun canal de contact. Il est declare
// au manifeste comme source du chantier, sans apport au master.
const QUALIFICATIONS = {
  fichier: 'annuaire-qualifications-20260904.parquet',
  producteur: 'data.gouv.fr',
  licence: 'Licence Ouverte 2.0',
  millesime: '2026-09-04',
  regle_jointure: 'ponts SIRET et SIREN'
}

// ── L ordre par canal, arrete ───────────────────────────────────────────────
const ORDRE = {
  tel: ['museofile', 'finess', 'rpps', 'overture', 'rge', 'avocats'],
  courriel: ['finess', 'overture', 'rge', 'rpps', 'avocats'],
  site: ['atout_france', 'museofile', 'overture', 'rna_waldec', 'rge']
}

// Les hotes d annuaire de certificateur RGE. Meme famille que le premier bloc de
// BLACKLIST_HOSTS, agregateurs et annuaires : la page decrit l entreprise mais l
// adresse publiee est celle du portail de la marque de qualification.
const ANNUAIRES_CERTIFICATEUR = ['qualit-enr.org', 'qualibat.com', 'qualibat.fr', 'qualibaies.fr']

const duck = (sql) => execFileSync('duckdb', [BASE], { input: sql, encoding: 'utf8', maxBuffer: 1 << 28 })
const p = (f) => join(SRC, f)
const litJson = (f) => JSON.parse(readFileSync(join(TRAVAIL, f), 'utf8'))
const etape = (t) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`)

// ═══════════════════════════════════════════════════════════════════════════
// 1. LES APPORTS, UN PAR SIRET, CANAL ET SOURCE
// ═══════════════════════════════════════════════════════════════════════════
etape('1  ·  LES APPORTS, DEPUIS LES PARQUETS DE SOURCE')

const sqlApports = `
INSTALL json; LOAD json;
SET preserve_insertion_order = false;

-- Nombre de chiffres d un telephone, seul test arrete sur ce canal.
CREATE OR REPLACE MACRO chiffres(raw) AS regexp_replace(coalesce(raw, ''), '[^0-9]', '', 'g');

-- Un courriel porte une arobase. Trois lignes Overture portent une URL dans la
-- colonne courriel : elles n ont pas leur place sur ce canal. Le test s arrete la.
-- Une adresse mal formee mais bien une adresse (plusieurs destinataires separes
-- par un point-virgule, point final surnumeraire) reste portee telle que livree :
-- la trier serait un arbitrage que personne n a rendu.
CREATE OR REPLACE MACRO courriel_forme(raw) AS
  raw IS NOT NULL AND contains(raw, '@')
  AND NOT regexp_matches(lower(trim(raw)), '^[a-z][a-z0-9+.-]*://');

CREATE OR REPLACE VIEW socle AS SELECT * FROM read_parquet('${SOCLE}');
CREATE OR REPLACE VIEW ov AS SELECT * FROM read_parquet('${p(SOURCES.overture.appariement)}');
CREATE OR REPLACE VIEW ovtout AS SELECT * FROM read_parquet('${p(SOURCES.overture.fichier)}');
CREATE OR REPLACE VIEW af AS SELECT * FROM read_parquet('${p(SOURCES.atout_france.appariement)}');
CREATE OR REPLACE VIEW fin AS SELECT * FROM read_parquet('${p(SOURCES.finess.fichier)}');
CREATE OR REPLACE VIEW rge AS SELECT * FROM read_parquet('${p(SOURCES.rge.fichier)}');
CREATE OR REPLACE VIEW rpps AS SELECT * FROM read_parquet('${p(SOURCES.rpps.fichier)}');
CREATE OR REPLACE VIEW museo AS SELECT * FROM read_parquet('${p(SOURCES.museofile.fichier)}');
CREATE OR REPLACE VIEW rna AS SELECT * FROM read_parquet('${p(SOURCES.rna_waldec.fichier)}');
CREATE OR REPLACE VIEW avo AS SELECT * FROM read_parquet('${p(SOURCES.avocats.fichier)}');

-- Les apports bruts, avant les corrections et avant le tri du canal site.
-- La valeur est portee TELLE QUE LA SOURCE LA LIVRE : aucun reformatage, la
-- colonne d origine dit sous quelle forme la lire.
CREATE OR REPLACE TABLE apport AS
  -- ── telephone ────────────────────────────────────────────────────────────
  SELECT siret, 'tel' AS canal, 'museofile' AS source, telephone AS valeur,
         museofile AS cle, '${SOURCES.museofile.millesime}' AS millesime,
         distance_m AS distance_m, score_nom AS score
    FROM museo WHERE telephone IS NOT NULL
  UNION ALL
  SELECT siret, 'tel', 'finess', telephone, finess, '${SOURCES.finess.millesime}', NULL, NULL
    FROM fin WHERE telephone IS NOT NULL
  UNION ALL
  SELECT siret, 'tel', 'rpps', telephone, array_to_string(rpps, '|'), '${SOURCES.rpps.millesime}', NULL, NULL
    FROM rpps WHERE telephone IS NOT NULL
  UNION ALL
  -- Correction arretee : les 33 telephones Overture sous 9 chiffres sont ecartes.
  SELECT siret, 'tel', 'overture', telephone, ov_cle, '${SOURCES.overture.millesime}', dm, score
    FROM ov WHERE telephone IS NOT NULL AND length(chiffres(telephone)) >= 9
  UNION ALL
  SELECT siret, 'tel', 'rge', telephone, siret, '${SOURCES.rge.millesime}', NULL, NULL
    FROM rge WHERE telephone IS NOT NULL
  -- ── courriel ─────────────────────────────────────────────────────────────
  UNION ALL
  SELECT siret, 'courriel', 'finess', courriel, finess, '${SOURCES.finess.millesime}', NULL, NULL
    FROM fin WHERE courriel_forme(courriel)
  UNION ALL
  SELECT siret, 'courriel', 'overture', courriel, ov_cle, '${SOURCES.overture.millesime}', dm, score
    FROM ov WHERE courriel_forme(courriel)
  UNION ALL
  SELECT siret, 'courriel', 'rge', courriel, siret, '${SOURCES.rge.millesime}', NULL, NULL
    FROM rge WHERE courriel_forme(courriel)
  UNION ALL
  SELECT siret, 'courriel', 'rpps', courriel, array_to_string(rpps, '|'), '${SOURCES.rpps.millesime}', NULL, NULL
    FROM rpps WHERE courriel_forme(courriel)
  -- ── site ─────────────────────────────────────────────────────────────────
  UNION ALL
  SELECT siret, 'site', 'atout_france', website, af_cle, '${SOURCES.atout_france.millesime}', dm, score
    FROM af WHERE website IS NOT NULL
  UNION ALL
  -- Correction arretee : deux lignes Museofile ecrivent le site avec une barre
  -- oblique de tete, l hote est recuperable.
  SELECT siret, 'site', 'museofile', regexp_replace(site, '^/+', ''), museofile,
         '${SOURCES.museofile.millesime}', distance_m, score_nom
    FROM museo WHERE site IS NOT NULL
  UNION ALL
  SELECT siret, 'site', 'overture', site, ov_cle, '${SOURCES.overture.millesime}', dm, score
    FROM ov WHERE site IS NOT NULL
  UNION ALL
  SELECT siret, 'site', 'rna_waldec', siteweb, rna, '${SOURCES.rna_waldec.millesime}', NULL, NULL
    FROM rna WHERE siteweb IS NOT NULL
  UNION ALL
  SELECT siret, 'site', 'rge', site_internet, siret, '${SOURCES.rge.millesime}', NULL, NULL
    FROM rge WHERE site_internet IS NOT NULL;

-- Les quatre colonnes sociales, Overture seule, aucun arbitrage.
CREATE OR REPLACE TABLE social AS
  SELECT siret, ov_cle AS cle, '${SOURCES.overture.millesime}' AS millesime, dm AS distance_m, score,
         facebook, instagram, linkedin, social_autre
    FROM ov WHERE coalesce(facebook, instagram, linkedin, social_autre) IS NOT NULL;

-- ── L annuaire des avocats, trois niveaux de cle ─────────────────────────────
-- La source est deja reduite a une ligne par cle, courriel elu par la variante A
-- (domaine propre, puis avocat.fr, puis generaliste ; a egalite la valeur la plus
-- frequente sur la cle). Rien n est reelu ici.
--
-- Le niveau se lit contre le socle, jamais contre la source :
--   siret        le SIRET reconstitue est au socle, la ligne peint ce seul etablissement ;
--   siren        la source ne portait que le SIREN, la ligne peint tous ses etablissements ;
--   siren_repli  le SIRET reconstitue est absent du socle mais son SIREN y est, la
--                ligne redescend au SIREN et peint tous ses etablissements.
-- Le SIREN inconnu du socle n a aucun rattrapage : la ligne est perdue.
CREATE OR REPLACE TABLE avo_cle AS
SELECT a.cle, a.niveau, a.siret AS siret_source, a.siren, a.lignes, a.tel, a.courriel_a,
  CASE WHEN a.niveau = 'siret' AND ss.siret IS NOT NULL THEN 'siret'
       WHEN a.niveau = 'siret' AND sn.siren IS NOT NULL THEN 'siren_repli'
       WHEN a.niveau = 'siren' AND sn.siren IS NOT NULL THEN 'siren'
  END AS niveau_cle
FROM avo a
LEFT JOIN (SELECT DISTINCT siret FROM socle) ss ON ss.siret = a.siret
LEFT JOIN (SELECT DISTINCT siren FROM socle) sn ON sn.siren = a.siren;

-- Vingt-deux SIREN recoivent plusieurs cles de niveau siret redescendues. Depart
-- arrete, celui de la source pour ses propres egalites : la cle la plus chargee en
-- lignes, puis la plus petite.
CREATE OR REPLACE TABLE avo_repli AS
SELECT * EXCLUDE (rn) FROM (
  SELECT *, row_number() OVER (PARTITION BY siren ORDER BY lignes DESC, cle) AS rn
  FROM avo_cle WHERE niveau_cle = 'siren_repli') WHERE rn = 1;

-- Les etablissements vises, un rang par niveau. siret l emporte toujours ; entre
-- siren et siren_repli, le niveau direct l emporte sur le repli.
CREATE OR REPLACE TABLE avo_etab AS
  SELECT siret_source AS siret, 'siret' AS niveau_cle, 1 AS sous_rang, cle, tel, courriel_a
    FROM avo_cle WHERE niveau_cle = 'siret'
  UNION ALL
  SELECT s.siret, 'siren', 2, c.cle, c.tel, c.courriel_a
    FROM avo_cle c JOIN socle s ON s.siren = c.siren WHERE c.niveau_cle = 'siren'
  UNION ALL
  SELECT s.siret, 'siren_repli', 3, c.cle, c.tel, c.courriel_a
    FROM avo_repli c JOIN socle s ON s.siren = c.siren;

CREATE OR REPLACE TABLE avo_gagnant AS
SELECT * EXCLUDE (rn) FROM (
  SELECT *, row_number() OVER (PARTITION BY siret ORDER BY sous_rang) AS rn FROM avo_etab) WHERE rn = 1;

-- L apport de l annuaire : courriel et telephone, aucun site. contact_<canal>_cle
-- porte le niveau de cle, non la valeur de la cle : c est ce niveau qui dit avec
-- quelle assurance la cellule a ete peinte.
CREATE OR REPLACE TABLE apport_avocats AS
  SELECT siret, 'tel' AS canal, 'avocats' AS source, tel AS valeur, niveau_cle AS cle,
         '${SOURCES.avocats.millesime}' AS millesime, NULL::DOUBLE AS distance_m, NULL::DOUBLE AS score,
         sous_rang
    FROM avo_gagnant WHERE tel IS NOT NULL
  UNION ALL
  SELECT siret, 'courriel', 'avocats', courriel_a, niveau_cle,
         '${SOURCES.avocats.millesime}', NULL, NULL, sous_rang
    FROM avo_gagnant WHERE courriel_a IS NOT NULL;

COPY (SELECT niveau, coalesce(niveau_cle, 'perdu') AS niveau_cle, count(*) AS lignes,
        count(tel) AS lignes_avec_tel, count(courriel_a) AS lignes_avec_courriel
      FROM avo_cle GROUP BY 1, 2 ORDER BY 1, 2)
  TO '${join(TRAVAIL, 'avocats-niveaux.json')}' (FORMAT JSON, ARRAY true);

-- Les etablissements vises par chaque niveau AVANT la priorite, et donc avec
-- leurs recouvrements. La somme depasse l union.
COPY (SELECT niveau_cle, count(DISTINCT siret) AS etablissements_vises FROM avo_etab GROUP BY 1 ORDER BY 1)
  TO '${join(TRAVAIL, 'avocats-vises.json')}' (FORMAT JSON, ARRAY true);

COPY (WITH v AS (SELECT DISTINCT siret, niveau_cle FROM avo_etab),
        c AS (SELECT siret, list_sort(list(niveau_cle)) AS n FROM v GROUP BY 1 HAVING count(*) > 1)
      SELECT array_to_string(n, ' + ') AS recouvrement, count(*) AS etablissements
      FROM c GROUP BY 1 ORDER BY 2 DESC)
  TO '${join(TRAVAIL, 'avocats-recouvrements.json')}' (FORMAT JSON, ARRAY true);

COPY (SELECT niveau_cle, count(*) AS etablissements_retenus FROM avo_gagnant GROUP BY 1 ORDER BY 1)
  TO '${join(TRAVAIL, 'avocats-retenus.json')}' (FORMAT JSON, ARRAY true);

-- Les cles de niveau siret redescendues qui se disputent un meme SIREN.
COPY (SELECT count(*) AS sirens_disputes, sum(n) AS cles_en_jeu, max(n) AS le_plus_charge,
        count(*) FILTER (WHERE nt > 1) AS telephones_divergents,
        count(*) FILTER (WHERE nc > 1) AS courriels_divergents
      FROM (SELECT siren, count(*) AS n, count(DISTINCT tel) AS nt, count(DISTINCT courriel_a) AS nc
            FROM avo_cle WHERE niveau_cle = 'siren_repli' GROUP BY 1 HAVING count(*) > 1))
  TO '${join(TRAVAIL, 'avocats-repli-disputes.json')}' (FORMAT JSON, ARRAY true);

COPY (SELECT canal, source, count(*) AS n
      FROM (SELECT canal, source FROM apport UNION ALL SELECT canal, source FROM apport_avocats)
      GROUP BY 1, 2 ORDER BY 1, 2)
  TO '${join(TRAVAIL, 'apports-bruts.json')}' (FORMAT JSON, ARRAY true);

-- Les sites distincts, a soumettre au module d hotes de production.
COPY (SELECT DISTINCT valeur FROM apport WHERE canal = 'site')
  TO '${join(TRAVAIL, 'sites.ndjson')}' (FORMAT JSON);
`
duck(sqlApports)
const apportsBruts = litJson('apports-bruts.json')
for (const r of apportsBruts) console.log(`  ${r.canal.padEnd(10)} ${r.source.padEnd(14)} ${String(r.n).padStart(8)}`)

const avNiveaux = litJson('avocats-niveaux.json')
const avVises = litJson('avocats-vises.json')
const avRecouvrements = litJson('avocats-recouvrements.json')
const avRetenus = litJson('avocats-retenus.json')
const avDisputes = litJson('avocats-repli-disputes.json')[0] || { sirens_disputes: 0, cles_en_jeu: 0, le_plus_charge: 0, telephones_divergents: 0, courriels_divergents: 0 }

console.log('\n  ANNUAIRE DES AVOCATS, LES TROIS NIVEAUX DE CLE')
console.log('    niveau de la source   niveau retenu     lignes   avec tel   avec courriel')
for (const r of avNiveaux) {
  console.log(`    ${r.niveau.padEnd(21)} ${r.niveau_cle.padEnd(16)} ${String(r.lignes).padStart(6)}   ${String(r.lignes_avec_tel).padStart(8)}   ${String(r.lignes_avec_courriel).padStart(13)}`)
}
console.log('\n    etablissements vises par niveau, avant la priorite')
for (const r of avVises) console.log(`      ${r.niveau_cle.padEnd(14)} ${String(r.etablissements_vises).padStart(8)}`)
console.log('    recouvrements entre niveaux')
for (const r of avRecouvrements) console.log(`      ${r.recouvrement.padEnd(28)} ${String(r.etablissements).padStart(6)}`)
console.log('    etablissements retenus apres la priorite')
for (const r of avRetenus) console.log(`      ${r.niveau_cle.padEnd(14)} ${String(r.etablissements_retenus).padStart(8)}`)
console.log(`    SIREN disputes entre cles siret redescendues : ${avDisputes.sirens_disputes} (${avDisputes.cles_en_jeu} cles, la plus chargee en porte ${avDisputes.le_plus_charge})`)
console.log(`      dont telephones divergents ${avDisputes.telephones_divergents}, courriels divergents ${avDisputes.courriels_divergents}`)

// ═══════════════════════════════════════════════════════════════════════════
// 2. LE VERDICT D HOTE, PAR LE MODULE DE PRODUCTION
// ═══════════════════════════════════════════════════════════════════════════
etape('2  ·  LE VERDICT D HOTE, PAR server/services/hotes-exclus.js')

const RESEAU = { societe_facebook: 'facebook', societe_instagram: 'instagram', societe_linkedin: 'linkedin' }
const lignes = []
let nSites = 0
const rl = createInterface({ input: createReadStream(join(TRAVAIL, 'sites.ndjson')), crlfDelay: Infinity })
for await (const l of rl) {
  if (!l.trim()) continue
  const { valeur } = JSON.parse(l)
  nSites++
  const hote = hoteDeSite(valeur)
  const nu = hote.replace(/^www\./, '').toLowerCase()
  lignes.push(JSON.stringify({
    valeur,
    hote,
    // Hote illisible, fail-closed, comme en production : hoteDeSite rend '' et
    // hostBlacklisted('') vaut true. Le point manquant vaut la meme chose. Sans
    // point il n y a pas de domaine enregistrable, et ces valeurs sont des
    // artefacts d analyse ou des non-reponses : http, https, htt, htpp, http;,
    // www, aucun, non, neant. Elles ne designent aucun site.
    illisible: hote === '' || !hote.includes('.'),
    liste_noire: hostBlacklisted(hote),
    reseau: RESEAU[champReseauPourHote(hote)] || null,
    annuaire_certificateur: ANNUAIRES_CERTIFICATEUR.some((a) => nu === a || nu.endsWith('.' + a))
  }))
}
writeFileSync(join(TRAVAIL, 'verdict.ndjson'), lignes.join('\n') + '\n')
console.log(`  sites distincts soumis     : ${nSites}`)
console.log(`  hote illisible             : ${lignes.filter((l) => JSON.parse(l).illisible).length}`)
console.log(`  hote en liste noire        : ${lignes.filter((l) => JSON.parse(l).liste_noire).length}`)
console.log(`  hote avec champ de reseau  : ${lignes.filter((l) => JSON.parse(l).reseau).length}`)
console.log(`  annuaire de certificateur  : ${lignes.filter((l) => JSON.parse(l).annuaire_certificateur).length}`)

// ═══════════════════════════════════════════════════════════════════════════
// 3. CE QUI N EST PAS UN SITE, PUIS LE REMPLISSAGE SI VIDE
// ═══════════════════════════════════════════════════════════════════════════
etape('3  ·  CE QUI N EST PAS UN SITE')

const valeurs = (canal) => ORDRE[canal].map((s, i) => `('${canal}', '${s}', ${i + 1})`).join(', ')

const sqlFusion = `
LOAD json;
SET preserve_insertion_order = false;

CREATE OR REPLACE TABLE verdict AS SELECT * FROM read_json('${join(TRAVAIL, 'verdict.ndjson')}');

-- Le tri du canal site. Trois motifs d ecart, et rien d autre :
--   hote_illisible          la valeur ne se lit pas comme une URL, fail-closed ;
--   annuaire_certificateur  RGE, la page est celle du portail de la marque ;
--   renvoi_facebook         RNA et Overture, la valeur va au canal social.
CREATE OR REPLACE TABLE apport_site AS
SELECT a.*, v.hote, v.reseau, v.liste_noire, v.annuaire_certificateur,
  CASE WHEN v.illisible THEN 'hote_illisible'
       WHEN a.source = 'rge' AND v.annuaire_certificateur THEN 'annuaire_certificateur'
       WHEN a.source IN ('rna_waldec', 'overture') AND v.reseau = 'facebook' THEN 'renvoi_facebook'
  END AS ecarte
FROM apport a JOIN verdict v USING (valeur)
WHERE a.canal = 'site';

CREATE OR REPLACE TABLE apport_retenu AS
  SELECT siret, canal, source, valeur, cle, millesime, distance_m, score, 0 AS sous_rang
    FROM apport WHERE canal <> 'site'
  UNION ALL
  SELECT siret, canal, source, valeur, cle, millesime, distance_m, score, 0
    FROM apport_site WHERE ecarte IS NULL
  UNION ALL
  SELECT siret, canal, source, valeur, cle, millesime, distance_m, score, sous_rang
    FROM apport_avocats;

-- L ordre par canal, arrete. Le rang seul decide : le premier rang qui porte une
-- valeur l ecrit, les suivants ne l ecrasent jamais.
CREATE OR REPLACE TABLE rang(canal VARCHAR, source VARCHAR, rang INTEGER);
INSERT INTO rang VALUES ${valeurs('tel')}, ${valeurs('courriel')}, ${valeurs('site')};

-- sous_rang ne separe que les niveaux de cle de l annuaire des avocats, qui est
-- une source unique portant trois assurances. Il vaut zero partout ailleurs.
CREATE OR REPLACE TABLE gagnant AS
SELECT * EXCLUDE (rn, rang) FROM (
  SELECT a.*, r.rang,
         row_number() OVER (PARTITION BY a.siret, a.canal ORDER BY r.rang, a.sous_rang, a.valeur) AS rn
  FROM apport_retenu a JOIN rang r ON r.canal = a.canal AND r.source = a.source
) WHERE rn = 1;

-- Le master tel qu il serait sans l annuaire des avocats, pour l avant et l apres.
CREATE OR REPLACE TABLE gagnant_avant AS
SELECT * EXCLUDE (rn, rang) FROM (
  SELECT a.*, r.rang,
         row_number() OVER (PARTITION BY a.siret, a.canal ORDER BY r.rang, a.sous_rang, a.valeur) AS rn
  FROM apport_retenu a JOIN rang r ON r.canal = a.canal AND r.source = a.source
  WHERE a.source <> 'avocats'
) WHERE rn = 1;

-- page_partagee_n, defini sur Overture ENTIER, non sur les seuls apparies. Pour un
-- SIRET, le plus grand nombre de lignes Overture portant l une de ses pages
-- sociales. Champ en nombre : le choix du seuil reste en aval.
CREATE OR REPLACE TABLE page AS
WITH u AS (
  SELECT cle::VARCHAR AS cle, 'facebook' AS plateforme, facebook AS page FROM ovtout WHERE facebook IS NOT NULL
  UNION ALL SELECT cle::VARCHAR, 'instagram', instagram FROM ovtout WHERE instagram IS NOT NULL
  UNION ALL SELECT cle::VARCHAR, 'linkedin', linkedin FROM ovtout WHERE linkedin IS NOT NULL
  UNION ALL SELECT cle::VARCHAR, 'social_autre', social_autre FROM ovtout WHERE social_autre IS NOT NULL
), n AS (SELECT plateforme, page, count(*) AS n FROM u GROUP BY 1, 2)
SELECT u.cle, max(n.n) AS page_partagee_n
FROM u JOIN n USING (plateforme, page) GROUP BY 1;

COPY (SELECT source, ecarte, count(*) AS n FROM apport_site WHERE ecarte IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2)
  TO '${join(TRAVAIL, 'ecarts-site.json')}' (FORMAT JSON, ARRAY true);
COPY (SELECT source, count(*) AS avant, count(*) FILTER (WHERE ecarte IS NULL) AS apres
      FROM apport_site GROUP BY 1 ORDER BY 1)
  TO '${join(TRAVAIL, 'site-avant-apres.json')}' (FORMAT JSON, ARRAY true);
-- Ce que la liste noire de production retirerait EN PLUS des trois motifs ci-dessus.
-- Mesure seule : l arbitrage n a pas etendu la liste, le master ne les ecarte pas.
COPY (SELECT source, count(*) AS n FROM apport_site
      WHERE ecarte IS NULL AND liste_noire GROUP BY 1 ORDER BY 2 DESC)
  TO '${join(TRAVAIL, 'liste-noire-restante.json')}' (FORMAT JSON, ARRAY true);
`
duck(sqlFusion)
for (const r of litJson('ecarts-site.json')) console.log(`  ${r.source.padEnd(14)} ${r.ecarte.padEnd(24)} ${String(r.n).padStart(7)}`)
console.log('\n  canal site, avant et apres le tri')
for (const r of litJson('site-avant-apres.json')) console.log(`  ${r.source.padEnd(14)} ${String(r.avant).padStart(7)} -> ${String(r.apres).padStart(7)}`)

// ═══════════════════════════════════════════════════════════════════════════
// 4. LE MASTER
// ═══════════════════════════════════════════════════════════════════════════
etape('4  ·  LE MASTER, UNE LIGNE PAR SIRET DU SOCLE')

// L annuaire des avocats publie son nom entier en origine. Les autres sources
// portent leur nom court, celui du manifeste.
const bloc = (canal, t) => `
  ${t}.valeur     AS contact_${canal},
  CASE WHEN ${t}.source = 'avocats' THEN 'CNB annuaire des avocats' ELSE ${t}.source END
                  AS contact_${canal}_origine,
  ${t}.cle        AS contact_${canal}_cle,
  ${t}.millesime  AS contact_${canal}_millesime,
  ${t}.distance_m AS contact_${canal}_distance_m,
  ${t}.score      AS contact_${canal}_score`

const sqlMaster = `
SET preserve_insertion_order = false;

CREATE OR REPLACE TABLE master AS
SELECT s.*,
${bloc('tel', 't')},
${bloc('courriel', 'c')},
${bloc('site', 'w')},
  so.facebook     AS contact_facebook,
  so.instagram    AS contact_instagram,
  so.linkedin     AS contact_linkedin,
  so.social_autre AS contact_social_autre,
  CASE WHEN so.siret IS NOT NULL THEN 'overture' END AS contact_social_origine,
  so.cle        AS contact_social_cle,
  so.millesime  AS contact_social_millesime,
  so.distance_m AS contact_social_distance_m,
  so.score      AS contact_social_score,
  pg.page_partagee_n
FROM socle s
LEFT JOIN (SELECT * FROM gagnant WHERE canal = 'tel')      t  USING (siret)
LEFT JOIN (SELECT * FROM gagnant WHERE canal = 'courriel') c  USING (siret)
LEFT JOIN (SELECT * FROM gagnant WHERE canal = 'site')     w  USING (siret)
LEFT JOIN social so USING (siret)
LEFT JOIN page pg ON pg.cle = so.cle;

COPY (SELECT * FROM master ORDER BY siret)
  TO '${MASTER}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 200000);
`
duck(sqlMaster)
const octets = statSync(MASTER).size
const sha1 = createHash('sha1').update(readFileSync(MASTER)).digest('hex')
console.log(`  ecrit : ${MASTER}`)
console.log(`  poids : ${(octets / 1024 / 1024).toFixed(1)} Mo  (${octets} octets)`)

// ═══════════════════════════════════════════════════════════════════════════
// 5. APRES FUSION, LES MESURES
// ═══════════════════════════════════════════════════════════════════════════
etape('5  ·  APRES FUSION')

const sqlMesures = `
LOAD json;
SET preserve_insertion_order = false;

-- La famille de metier est la section de la NAF, lue sur la division.
CREATE OR REPLACE MACRO section(naf) AS CASE
  WHEN naf IS NULL THEN NULL
  WHEN try_cast(naf[1:2] AS INTEGER) IS NULL THEN NULL
  WHEN try_cast(naf[1:2] AS INTEGER) BETWEEN  1 AND  3 THEN 'A agriculture, sylviculture et peche'
  WHEN try_cast(naf[1:2] AS INTEGER) BETWEEN  5 AND  9 THEN 'B industries extractives'
  WHEN try_cast(naf[1:2] AS INTEGER) BETWEEN 10 AND 33 THEN 'C industrie manufacturiere'
  WHEN try_cast(naf[1:2] AS INTEGER) = 35                THEN 'D electricite, gaz, vapeur'
  WHEN try_cast(naf[1:2] AS INTEGER) BETWEEN 36 AND 39 THEN 'E eau, assainissement, dechets'
  WHEN try_cast(naf[1:2] AS INTEGER) BETWEEN 41 AND 43 THEN 'F construction'
  WHEN try_cast(naf[1:2] AS INTEGER) BETWEEN 45 AND 47 THEN 'G commerce, reparation d automobiles'
  WHEN try_cast(naf[1:2] AS INTEGER) BETWEEN 49 AND 53 THEN 'H transports et entreposage'
  WHEN try_cast(naf[1:2] AS INTEGER) BETWEEN 55 AND 56 THEN 'I hebergement et restauration'
  WHEN try_cast(naf[1:2] AS INTEGER) BETWEEN 58 AND 63 THEN 'J information et communication'
  WHEN try_cast(naf[1:2] AS INTEGER) BETWEEN 64 AND 66 THEN 'K activites financieres et d assurance'
  WHEN try_cast(naf[1:2] AS INTEGER) = 68                THEN 'L activites immobilieres'
  WHEN try_cast(naf[1:2] AS INTEGER) BETWEEN 69 AND 75 THEN 'M activites specialisees, scientifiques et techniques'
  WHEN try_cast(naf[1:2] AS INTEGER) BETWEEN 77 AND 82 THEN 'N services administratifs et de soutien'
  WHEN try_cast(naf[1:2] AS INTEGER) = 84                THEN 'O administration publique'
  WHEN try_cast(naf[1:2] AS INTEGER) = 85                THEN 'P enseignement'
  WHEN try_cast(naf[1:2] AS INTEGER) BETWEEN 86 AND 88 THEN 'Q sante humaine et action sociale'
  WHEN try_cast(naf[1:2] AS INTEGER) BETWEEN 90 AND 93 THEN 'R arts, spectacles et activites recreatives'
  WHEN try_cast(naf[1:2] AS INTEGER) BETWEEN 94 AND 96 THEN 'S autres activites de services'
  WHEN try_cast(naf[1:2] AS INTEGER) BETWEEN 97 AND 98 THEN 'T menages employeurs'
  WHEN try_cast(naf[1:2] AS INTEGER) = 99                THEN 'U activites extra-territoriales'
END;

CREATE OR REPLACE VIEW m AS
SELECT siret, naf_etablissement, departement,
       contact_tel IS NOT NULL AS a_tel,
       contact_courriel IS NOT NULL AS a_courriel,
       contact_site IS NOT NULL AS a_site,
       contact_social_origine IS NOT NULL AS a_social,
       page_partagee_n
FROM master;

COPY (SELECT
        count(*) AS sirets_du_socle,
        count(*) FILTER (WHERE a_tel OR a_courriel OR a_site OR a_social) AS avec_au_moins_un_contact,
        count(*) FILTER (WHERE a_tel) AS avec_tel,
        count(*) FILTER (WHERE a_courriel) AS avec_courriel,
        count(*) FILTER (WHERE a_site) AS avec_site,
        count(*) FILTER (WHERE a_social) AS avec_social,
        count(*) FILTER (WHERE a_tel AND a_courriel AND a_site) AS avec_les_trois,
        count(*) FILTER (WHERE page_partagee_n IS NOT NULL) AS avec_page_partagee_mesuree,
        count(*) FILTER (WHERE page_partagee_n >= 2) AS avec_page_partagee
      FROM m) TO '${join(TRAVAIL, 'couverture.json')}' (FORMAT JSON, ARRAY true);

COPY (SELECT
        CASE WHEN a_tel THEN 'tel ' ELSE '' END || CASE WHEN a_courriel THEN 'courriel ' ELSE '' END
        || CASE WHEN a_site THEN 'site ' ELSE '' END || CASE WHEN a_social THEN 'social' ELSE '' END AS combinaison,
        count(*) AS n
      FROM m WHERE a_tel OR a_courriel OR a_site OR a_social
      GROUP BY 1 ORDER BY 2 DESC) TO '${join(TRAVAIL, 'combinaisons.json')}' (FORMAT JSON, ARRAY true);

COPY (SELECT coalesce(section(naf_etablissement), 'sans NAF lisible') AS famille,
        count(*) AS sirets, count(*) FILTER (WHERE a_tel OR a_courriel OR a_site OR a_social) AS servis,
        round(100.0 * count(*) FILTER (WHERE a_tel OR a_courriel OR a_site OR a_social) / count(*), 2) AS part
      FROM m GROUP BY 1 ORDER BY 2 DESC) TO '${join(TRAVAIL, 'familles.json')}' (FORMAT JSON, ARRAY true);

COPY (SELECT coalesce(departement, 'sans departement') AS departement,
        count(*) AS sirets, count(*) FILTER (WHERE a_tel OR a_courriel OR a_site OR a_social) AS servis,
        round(100.0 * count(*) FILTER (WHERE a_tel OR a_courriel OR a_site OR a_social) / count(*), 2) AS part
      FROM m GROUP BY 1 ORDER BY 2 DESC) TO '${join(TRAVAIL, 'departements.json')}' (FORMAT JSON, ARRAY true);

-- L apport propre : les cellules qu une source gagne, et parmi elles celles qu
-- aucune autre source ne pouvait fournir. Retirer la source, c est perdre celles-la.
COPY (WITH offres AS (SELECT siret, canal, count(DISTINCT source) AS n FROM apport_retenu GROUP BY 1, 2)
      SELECT g.canal, g.source, count(*) AS cellules_gagnees,
             count(*) FILTER (WHERE o.n = 1) AS apport_propre
      FROM gagnant g JOIN offres o ON o.siret = g.siret AND o.canal = g.canal
      GROUP BY 1, 2 ORDER BY 1, 3 DESC) TO '${join(TRAVAIL, 'apport-source.json')}' (FORMAT JSON, ARRAY true);

-- Le volume joint et ce qui reste dehors, source par source.
COPY (SELECT source, count(DISTINCT siret) AS sirets_offerts,
        count(DISTINCT siret) FILTER (WHERE siret IN (SELECT siret FROM socle)) AS sirets_du_socle,
        count(*) AS cellules_offertes
      FROM apport_retenu GROUP BY 1 ORDER BY 2 DESC) TO '${join(TRAVAIL, 'jointure.json')}' (FORMAT JSON, ARRAY true);

-- Reserve mesuree : l ecart de geocodage RGE contre Sirene.
COPY (WITH d AS (
        SELECT 2 * 6371000 * asin(sqrt(pow(sin(radians(r.latitude_rge - s.latitude) / 2), 2)
             + cos(radians(s.latitude)) * cos(radians(r.latitude_rge))
             * pow(sin(radians(r.longitude_rge - s.longitude) / 2), 2))) AS m
        FROM rge r JOIN socle s USING (siret)
        WHERE r.latitude_rge IS NOT NULL AND s.latitude IS NOT NULL)
      SELECT count(*) AS couples, round(median(m), 1) AS mediane_m,
             round(quantile_cont(m, 0.9), 1) AS d9_m FROM d)
  TO '${join(TRAVAIL, 'geocodage-rge.json')}' (FORMAT JSON, ARRAY true);

-- L apport du canal social, Overture seule, jamais arbitre : tout ce qui est
-- offert est ecrit, l apport propre y est egal a l apport.
COPY (SELECT count(*) AS sirets_servis, count(facebook) AS facebook, count(instagram) AS instagram,
        count(linkedin) AS linkedin, count(social_autre) AS social_autre FROM social)
  TO '${join(TRAVAIL, 'social.json')}' (FORMAT JSON, ARRAY true);

-- ── L annuaire des avocats, avant et apres ──────────────────────────────────
CREATE OR REPLACE TABLE servi_avant AS
  SELECT DISTINCT siret FROM (SELECT siret FROM gagnant_avant UNION ALL SELECT siret FROM social);
CREATE OR REPLACE TABLE servi_apres AS
  SELECT DISTINCT siret FROM (SELECT siret FROM gagnant UNION ALL SELECT siret FROM social);

COPY (SELECT count(*) AS sirets_du_socle,
        count(*) FILTER (WHERE siret IN (SELECT siret FROM servi_avant)) AS servis_avant,
        count(*) FILTER (WHERE siret IN (SELECT siret FROM servi_apres)) AS servis_apres
      FROM socle) TO '${join(TRAVAIL, 'avocats-servis.json')}' (FORMAT JSON, ARRAY true);

-- Trois sorts pour une cellule offerte par l annuaire :
--   ouverture      la cellule etait vide et le SIRET ne portait aucun contact ;
--   completion     la cellule etait vide, le SIRET portait deja un autre canal ;
--   corroboration  la cellule etait servie. Rien n est ecrit, quel que soit le niveau.
-- La comparaison de valeur ne sert qu a la mesure : chiffres seuls pour le telephone,
-- minuscules sans espace de bord pour le courriel. Le master ne reformate rien.
CREATE OR REPLACE TABLE avocats_effet AS
SELECT a.canal, a.cle AS niveau_cle, a.valeur, b.valeur AS valeur_avant, b.source AS source_avant,
       sa.siret IS NOT NULL AS sirets_deja_servi
FROM apport_avocats a
LEFT JOIN gagnant_avant b ON b.siret = a.siret AND b.canal = a.canal
LEFT JOIN servi_avant sa ON sa.siret = a.siret;

COPY (SELECT canal, niveau_cle, count(*) AS cellules_offertes,
        count(*) FILTER (WHERE valeur_avant IS NULL AND NOT sirets_deja_servi) AS ouvertures,
        count(*) FILTER (WHERE valeur_avant IS NULL AND sirets_deja_servi) AS completions,
        count(*) FILTER (WHERE valeur_avant IS NOT NULL) AS corroborations,
        count(*) FILTER (WHERE valeur_avant IS NOT NULL AND CASE
            WHEN canal = 'tel' THEN chiffres(valeur) = chiffres(valeur_avant)
            ELSE lower(trim(valeur)) = lower(trim(valeur_avant)) END) AS corroborations_meme_valeur
      FROM avocats_effet GROUP BY 1, 2 ORDER BY 1, 2)
  TO '${join(TRAVAIL, 'avocats-effet.json')}' (FORMAT JSON, ARRAY true);

COPY (SELECT count(*) AS sirets,
        count(*) FILTER (WHERE siret IN (SELECT siret FROM servi_avant)) AS servis_avant,
        count(*) FILTER (WHERE siret IN (SELECT siret FROM servi_apres)) AS servis_apres,
        count(*) FILTER (WHERE siret IN (SELECT siret FROM gagnant_avant WHERE canal = 'tel')) AS tel_avant,
        count(*) FILTER (WHERE siret IN (SELECT siret FROM gagnant WHERE canal = 'tel')) AS tel_apres,
        count(*) FILTER (WHERE siret IN (SELECT siret FROM gagnant_avant WHERE canal = 'courriel')) AS courriel_avant,
        count(*) FILTER (WHERE siret IN (SELECT siret FROM gagnant WHERE canal = 'courriel')) AS courriel_apres
      FROM socle WHERE naf_etablissement = '69.10Z')
  TO '${join(TRAVAIL, 'avocats-naf-6910z.json')}' (FORMAT JSON, ARRAY true);

-- page_partagee_n, la mesure sur Overture entier.
COPY (WITH u AS (
        SELECT cle::VARCHAR AS cle, 'facebook' AS plateforme, facebook AS page FROM ovtout WHERE facebook IS NOT NULL
        UNION ALL SELECT cle::VARCHAR, 'instagram', instagram FROM ovtout WHERE instagram IS NOT NULL
        UNION ALL SELECT cle::VARCHAR, 'linkedin', linkedin FROM ovtout WHERE linkedin IS NOT NULL
        UNION ALL SELECT cle::VARCHAR, 'social_autre', social_autre FROM ovtout WHERE social_autre IS NOT NULL),
      n AS (SELECT plateforme, page, count(*) AS n FROM u GROUP BY 1, 2)
      SELECT count(*) AS paires_partagees,
             count(DISTINCT o.siret) AS sirets_concernes
      FROM u JOIN n USING (plateforme, page) JOIN ov o ON o.ov_cle = u.cle
      WHERE n.n >= 2) TO '${join(TRAVAIL, 'page-partagee.json')}' (FORMAT JSON, ARRAY true);
`
duck(sqlMesures)

const couverture = litJson('couverture.json')[0]
const familles = litJson('familles.json')
const departements = litJson('departements.json')
const combinaisons = litJson('combinaisons.json')
const apportSource = litJson('apport-source.json')
const jointure = litJson('jointure.json')
const geoRge = litJson('geocodage-rge.json')[0]
const pagePartagee = litJson('page-partagee.json')[0]
const soc = litJson('social.json')[0]
const ecartsSite = litJson('ecarts-site.json')
const siteAvantApres = litJson('site-avant-apres.json')
const listeNoireRestante = litJson('liste-noire-restante.json')
const avServis = litJson('avocats-servis.json')[0]
const avEffet = litJson('avocats-effet.json')
const avNaf = litJson('avocats-naf-6910z.json')[0]

const pc = (n) => `${(100 * n / couverture.sirets_du_socle).toFixed(2)} %`
console.log(`  SIRET du socle              : ${couverture.sirets_du_socle}`)
console.log(`  au moins un contact         : ${couverture.avec_au_moins_un_contact}  (${pc(couverture.avec_au_moins_un_contact)})`)
for (const [l, v] of [['telephone', couverture.avec_tel], ['courriel', couverture.avec_courriel],
  ['site', couverture.avec_site], ['social', couverture.avec_social], ['les trois canaux', couverture.avec_les_trois]]) {
  console.log(`    ${l.padEnd(24)} ${String(v).padStart(9)}  (${pc(v)})`)
}
console.log(`  page partagee mesuree       : ${couverture.avec_page_partagee_mesuree}`)
console.log(`  dont page partagee (n >= 2) : ${couverture.avec_page_partagee}`)

console.log('\n  COMBINAISONS')
for (const r of combinaisons) console.log(`    ${r.combinaison.trim().padEnd(30)} ${String(r.n).padStart(9)}`)

console.log(`\n  CANAL SOCIAL, OVERTURE SEULE : ${soc.sirets_servis} SIRET servis`)
console.log(`    facebook ${soc.facebook}   instagram ${soc.instagram}   linkedin ${soc.linkedin}   social_autre ${soc.social_autre}`)
console.log('\n  APPORT PROPRE PAR SOURCE (cellules gagnees, dont nulle autre source ne l offrait)')
for (const r of apportSource) {
  console.log(`    ${r.canal.padEnd(10)} ${r.source.padEnd(14)} ${String(r.cellules_gagnees).padStart(8)}   propre ${String(r.apport_propre).padStart(8)}`)
}

console.log('\n  FAMILLES DE METIER')
for (const r of familles) console.log(`    ${r.famille.slice(0, 52).padEnd(54)} ${String(r.sirets).padStart(9)}  servis ${String(r.servis).padStart(8)}  ${String(r.part).padStart(6)} %`)

console.log('\n  DIX PREMIERS DEPARTEMENTS PAR VOLUME')
for (const r of departements.slice(0, 10)) console.log(`    ${r.departement.padEnd(6)} ${String(r.sirets).padStart(9)}  servis ${String(r.servis).padStart(8)}  ${String(r.part).padStart(6)} %`)

console.log('\n  L ANNUAIRE DES AVOCATS, AVANT ET APRES')
console.log(`    SIRET servis avant  : ${avServis.servis_avant}`)
console.log(`    SIRET servis apres  : ${avServis.servis_apres}`)
console.log(`    ecart               : ${avServis.servis_apres - avServis.servis_avant}`)
console.log('\n    canal      niveau         offertes  ouvertures  completions  corroborations  dont meme valeur')
for (const r of avEffet) {
  console.log(`    ${r.canal.padEnd(10)} ${r.niveau_cle.padEnd(14)} ${String(r.cellules_offertes).padStart(8)}  ${String(r.ouvertures).padStart(10)}  ${String(r.completions).padStart(11)}  ${String(r.corroborations).padStart(14)}  ${String(r.corroborations_meme_valeur).padStart(16)}`)
}
console.log(`\n    NAF 69.10Z, ${avNaf.sirets} SIRET`)
console.log(`      au moins un contact : ${avNaf.servis_avant} -> ${avNaf.servis_apres}  (+${avNaf.servis_apres - avNaf.servis_avant})`)
console.log(`      telephone           : ${avNaf.tel_avant} -> ${avNaf.tel_apres}  (+${avNaf.tel_apres - avNaf.tel_avant})`)
console.log(`      courriel            : ${avNaf.courriel_avant} -> ${avNaf.courriel_apres}  (+${avNaf.courriel_apres - avNaf.courriel_avant})`)

// ═══════════════════════════════════════════════════════════════════════════
// 6. LE MANIFESTE
// ═══════════════════════════════════════════════════════════════════════════
etape('6  ·  LE MANIFESTE')

const gagnees = (canal, source) => apportSource.find((r) => r.canal === canal && r.source === source) || null
const parSource = {}
for (const [nom, s] of Object.entries(SOURCES)) {
  const j = jointure.find((r) => r.source === nom)
  const canaux = {}
  for (const canal of ['tel', 'courriel', 'site']) {
    const g = gagnees(canal, nom)
    if (g) canaux[canal] = { cellules_gagnees: g.cellules_gagnees, apport_propre: g.apport_propre }
  }
  // Le canal social n a qu une source et aucun arbitrage : tout l offert est ecrit.
  if (nom === 'overture') {
    canaux.social = {
      cellules_gagnees: soc.sirets_servis,
      apport_propre: soc.sirets_servis,
      par_plateforme: { facebook: soc.facebook, instagram: soc.instagram, linkedin: soc.linkedin, social_autre: soc.social_autre }
    }
  }
  const ecarts = ecartsSite.filter((r) => r.source === nom)
  const av = siteAvantApres.find((r) => r.source === nom)
  const noire = listeNoireRestante.find((r) => r.source === nom)
  parSource[nom] = {
    fichier: s.fichier,
    ...(s.appariement ? { appariement: s.appariement } : {}),
    producteur: s.producteur,
    licence: s.licence,
    millesime: s.millesime,
    regle_jointure: s.regle_jointure,
    colonne_cle: s.cle,
    volume_joint: {
      sirets_offerts: j ? j.sirets_offerts : 0,
      sirets_du_socle: j ? j.sirets_du_socle : 0,
      cellules_offertes: j ? j.cellules_offertes : 0
    },
    apport_mesure: canaux,
    reste_dehors: {
      ...(av ? { canal_site_avant_le_tri: av.avant, canal_site_apres_le_tri: av.apres } : {}),
      ...(ecarts.length ? { ecarts_du_canal_site: Object.fromEntries(ecarts.map((e) => [e.ecarte, e.n])) } : {}),
      cellules_offertes_perdues_a_l_arbitrage:
        (j ? j.cellules_offertes : 0)
        - ['tel', 'courriel', 'site'].reduce((a, k) => a + (canaux[k] ? canaux[k].cellules_gagnees : 0), 0),
      ...(noire ? { hotes_de_liste_noire_conserves_faute_d_arbitrage: noire.n } : {})
    }
  }
}

const manifeste = {
  fichier: MASTER,
  fabrique_le: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  fabrique_par: 'scripts/fondre-master-movup.mjs, hors ligne, sans acces a la base',
  octets,
  sha1,
  lignes: couverture.sirets_du_socle,
  socle: {
    fichier: SOCLE.startsWith(RACINE + '/') ? SOCLE.slice(RACINE.length + 1) : SOCLE,
    millesime: '2026-09-01',
    sirets: couverture.sirets_du_socle,
    regle: 'une ligne par SIRET du socle, servie ou non. Le master ne cree ni ne retire aucun SIRET.'
  },
  vocabulaire: {
    canaux: ['site', 'courriel', 'tel', 'social'],
    colonnes_de_trace: ['contact_<canal>_origine', 'contact_<canal>_cle', 'contact_<canal>_millesime',
      'contact_<canal>_distance_m', 'contact_<canal>_score'],
    cle: 'la colonne visee dans la table de source : referentiel_overture.cle, referentiel_rge.cle, referentiel_atout_france.cle, et pour les autres l identifiant de la source. Exception nommee : l annuaire des avocats y porte son niveau de cle, siret, siren ou siren_repli, et non une valeur de cle.',
    millesime: 'quand la ligne a pris sa forme, jamais quand on l a regardee.',
    absence: 'l absence de valeur ne prend jamais de valeur par defaut, et vaut absence de trace.',
    distance_et_score: 'portes par les seuls canaux issus d un appariement calcule : Overture, Atout France, Museofile.',
    valeur: 'la valeur est portee telle que la source la livre. Aucun reformatage : contact_<canal>_origine dit sous quelle forme la lire.'
  },
  ordre_par_canal: {
    ...ORDRE,
    social: ['overture'],
    remplissage: 'si vide, canal par canal. Une valeur deja ecrite n est jamais ecrasee.'
  },
  page_partagee_n: {
    definition: 'pour un SIRET, le plus grand nombre de lignes Overture portant l une de ses pages sociales. Defini sur Overture ENTIER, non sur les seuls apparies.',
    forme: 'nombre, jamais drapeau. Le choix du seuil reste en aval.',
    paires_ligne_plateforme_partagees: pagePartagee.paires_partagees,
    sirets_concernes: pagePartagee.sirets_concernes,
    sirets_du_master_avec_n_superieur_a_1: couverture.avec_page_partagee
  },
  ce_qui_n_est_pas_un_site: {
    regle: 'application de la regle deja en production (commit 1e1825f, backfill 2a35235). hoteDeSite, hostBlacklisted et champReseauPourHote sont importes de server/services/hotes-exclus.js, jamais recopies.',
    hote_illisible: 'fail-closed, comme en production : hoteDeSite rend la chaine vide et hostBlacklisted("") vaut true. Un hote sans point est illisible au meme titre, faute de domaine enregistrable : http, https, htt, htpp, www, aucun, non, neant.',
    annuaires_de_certificateur: ANNUAIRES_CERTIFICATEUR,
    ecarts: Object.fromEntries(ecartsSite.map((e) => [`${e.source} ${e.ecarte}`, e.n]))
  },
  corrections_avant_fusion: {
    museofile_barre_oblique: 'deux lignes ecrivent le site avec une barre oblique de tete, retiree, l hote est recuperable.',
    overture_telephones_courts: 'les 33 telephones sous 9 chiffres sont ecartes.',
    overture_courriels_non_courriels: 'trois lignes portent une URL dans la colonne courriel. Ecartees du canal courriel. Correction hors des deux arretees, appliquee et declaree ici. Le test s arrete la : une adresse mal formee mais bien une adresse reste portee telle que livree.'
  },
  annuaire_des_avocats: {
    entree: 'data/appariement-local/appariement-avocats-20260717.parquet',
    election_du_courriel: 'variante A, deja elue dans le parquet d entree, colonne courriel_a : domaine propre d abord, puis avocat.fr, puis generaliste ; a egalite la valeur la plus frequente sur la cle, puis la plus petite. La fonte ne reelit rien.',
    canaux: ['courriel', 'tel'],
    aucun_site: 'l annuaire ne verse rien au canal site.',
    niveaux_de_cle: {
      siret: 'le SIRET reconstitue est au socle. La ligne peint ce seul etablissement.',
      siren: 'la source ne portait que le SIREN. La ligne peint tous les etablissements du SIREN.',
      siren_repli: 'le SIRET reconstitue est absent du socle mais son SIREN y est. La ligne redescend au SIREN et peint tous ses etablissements.',
      perdu: 'le SIREN est inconnu du socle. Aucun rattrapage.'
    },
    priorite: 'siret l emporte toujours. Entre siren et siren_repli, le niveau direct l emporte sur le repli. Le rang de l annuaire est le dernier de son canal : aucune cellule deja servie du master n est remplacee, quel que soit le niveau.',
    depart_d_egalite_du_repli: 'plusieurs cles de niveau siret peuvent redescendre au meme SIREN. La cle la plus chargee en lignes l emporte, puis la plus petite.',
    lignes_par_niveau: avNiveaux,
    etablissements_vises_avant_priorite: Object.fromEntries(avVises.map((r) => [r.niveau_cle, r.etablissements_vises])),
    recouvrements_entre_niveaux: Object.fromEntries(avRecouvrements.map((r) => [r.recouvrement, r.etablissements])),
    etablissements_retenus_apres_priorite: Object.fromEntries(avRetenus.map((r) => [r.niveau_cle, r.etablissements_retenus])),
    sirens_disputes_au_repli: avDisputes,
    trace: {
      'contact_<canal>_origine': 'CNB annuaire des avocats',
      'contact_<canal>_cle': 'siret, siren ou siren_repli',
      'contact_<canal>_millesime': '2026-07-17',
      'contact_<canal>_distance_m': 'absent, l appariement ne passe par aucune geometrie',
      'contact_<canal>_score': 'absent, l appariement ne passe par aucun nom'
    },
    avant_et_apres: {
      sirets_servis_avant: avServis.servis_avant,
      sirets_servis_apres: avServis.servis_apres,
      ecart: avServis.servis_apres - avServis.servis_avant,
      par_canal_et_par_niveau: avEffet,
      definitions: {
        ouverture: 'la cellule etait vide et le SIRET ne portait aucun contact, sur aucun canal.',
        completion: 'la cellule etait vide, le SIRET portait deja un contact sur un autre canal.',
        corroboration: 'la cellule etait deja servie. Rien n est ecrit.',
        corroborations_meme_valeur: 'mesure seule, sur chiffres du telephone et sur courriel en minuscules. Le master ne reformate aucune valeur.'
      },
      naf_6910z: avNaf
    }
  },
  par_source: parSource,
  qualifications: { ...QUALIFICATIONS, apport_au_master: 'aucun. Le fichier ne porte aucun canal de contact ; il est declare comme source du chantier.' },
  apres_fusion: {
    couverture,
    combinaisons: Object.fromEntries(combinaisons.map((c) => [c.combinaison.trim(), c.n])),
    apport_par_source: apportSource,
    par_famille_de_metier: familles,
    par_departement: departements
  },
  reserves_mesurees: {
    geocodage_rge_contre_sirene: {
      annonce: 'ecart de 105 m',
      mesure_ici: { couples: geoRge.couples, mediane_m: geoRge.mediane_m, decile_9_m: geoRge.d9_m },
      portee: 'le RGE joint par SIRET exact, l ecart ne pese pas sur la jointure. Il pese sur tout usage cartographique de la position RGE.'
    },
    corroboration_de_voie_overture: 'decroissante avec la distance. Les couples proches du seuil de 50 m corroborent moins souvent la voie que les couples a quelques metres. contact_site_distance_m et contact_site_score sont portes au master pour que l aval puisse resserrer.',
    une_seule_url_par_plateforme_sociale: 'limite d import : Overture ne retient qu une URL par plateforme. Un etablissement a plusieurs pages Facebook n en montre qu une.',
    liste_noire_de_production_non_etendue: {
      constat: 'l arbitrage a nomme trois ecarts et trois seulement. Les 86 hotes de BLACKLIST_HOSTS ne sont PAS retires du canal site du master.',
      volume_restant: Object.fromEntries(listeNoireRestante.map((r) => [r.source, r.n]))
    },
    canal_social_alimente_par_overture_seule: {
      constat: 'les renvois Facebook du RNA et d Overture sortent du canal site. Ils ne sont pas reverses dans les colonnes sociales, l ordre arrete du canal social etant Overture seule.',
      lecture: 'lecture retenue de "vont au canal social" : la valeur cesse d etre un site. La lecture inverse, un remplissage si vide des colonnes sociales par ces renvois, ferait porter contact_social_origine par une autre source qu Overture.'
    }
  }
}

writeFileSync(MANIFESTE, JSON.stringify(manifeste, null, 2) + '\n')
console.log(`  ecrit : ${MANIFESTE}`)
console.log(`\n  poids reel du master : ${(octets / 1024 / 1024).toFixed(1)} Mo`)
console.log(`  sha1                 : ${sha1}`)
console.log('\naucune ecriture en base, aucun commit.')
