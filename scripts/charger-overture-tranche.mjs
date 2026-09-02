// CHARGEMENT D'OVERTURE PLACES EN BASE, UNE TRANCHE DÉPARTEMENTALE À LA FOIS.
//
// Écrit UNIQUEMENT referentiel_overture (table définie par
// server/services/referentiel-overture.js). Ne lit ni n'écrit AUCUNE autre
// table : ni referentiel_societes, ni referentiel_osm, ni les cartes. Aucun
// rapprochement, aucune coordonnée poussée vers une fiche.
//
// ── POURQUOI UN SCRIPT LOCAL, ET PAS UNE ROUTE D'ADMIN ──────────────────────
// La source est un fichier Parquet de 294 Mo lu par DuckDB. Le conteneur de
// production a 1 Go de mémoire partagée avec le trafic et n'a pas DuckDB : la
// lecture se fait donc ici, la base ne reçoit que des UPSERT. C'est le seul
// écart au patron de rge.js, qui rapatrie lui-même sa source parce qu'elle
// tient dans une requête HTTP.
//
// ── LA TRANCHE EST LE DÉPARTEMENT ───────────────────────────────────────────
// 2,16 M lignes pour la métropole : 100 tranches, la plus grosse 119 882 lignes
// (le 75), la moyenne 21 646, plus une tranche 'ZZ' de 90 059 lignes sans code
// postal exploitable. Le découpage n'est pas un confort d'exécution, c'est ce
// qui rend le chargement REPRENABLE : une tranche interrompue se rejoue seule,
// et l'UPSERT étant idempotent (record id = identifiant GERS), la rejouer deux
// fois ne crée pas un doublon.
//
// ── LE JOURNAL EST LE POINT DE REPRISE ──────────────────────────────────────
// Une ligne JSON par tranche terminée, ajoutée à un fichier. Au démarrage, les
// tranches déjà journalisées sont sautées ; --refaire les reprend. Pas d'état
// en base, pas de table de suivi : le journal est un fichier, il survit à tout,
// et il porte en même temps la mesure (durée, cadence, octets écrits) qui dira
// si le chargement complet tient dans son enveloppe.
//
// ── LA CADENCE NE PRIME JAMAIS SUR LE TRAFIC ────────────────────────────────
// LOT = 100 instructions par aller-retour, PAUSE_LOT_MS = 150 entre deux,
// strictement séquentiel : la cadence maison, celle de rge.js et
// d'atout-france.js. L'instance est petite et sert des abonnés pendant ce
// temps ; un chargement de fond qui la sature est un chargement raté, même
// s'il finit.
//
// USAGE
//   node scripts/charger-overture-tranche.mjs --parquet <fichier.parquet> 73
//   node scripts/charger-overture-tranche.mjs --parquet <f> 01 02 03 …
//   Options : --journal <fichier>   (défaut : scripts/out/overture-journal.jsonl)
//             --travail <dossier>   (défaut : dossier temporaire du système)
//             --release <édition>   (défaut : 2026-08-19.0)
//             --refaire             (rejoue une tranche déjà journalisée)
//             --garder              (conserve le NDJSON de travail)

import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { createReadStream, existsSync, readFileSync, appendFileSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDb, close } from '../lib/surreal.js'
import { departementDepuisCp, normaliserSite } from '../server/services/atout-france.js'
import { decouperAdresseAgregee } from '../lib/societes.js'

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..')
const TABLE = 'referentiel_overture'

const LOT = 100
const PAUSE_LOT_MS = 150
// Une ligne de progression toutes les PAS_TRACE lots, sur la sortie standard
// seulement : le journal, lui, garde UNE ligne par tranche.
const PAS_TRACE = 25

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Arguments.
// ---------------------------------------------------------------------------

function lireArgs(argv) {
  const o = {
    parquet: '',
    journal: join(RACINE, 'scripts', 'out', 'overture-journal.jsonl'),
    travail: tmpdir(),
    release: '2026-08-19.0',
    refaire: false,
    garder: false,
    tranches: []
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--parquet') { o.parquet = argv[++i]; continue }
    if (a === '--journal') { o.journal = argv[++i]; continue }
    if (a === '--travail') { o.travail = argv[++i]; continue }
    if (a === '--release') { o.release = argv[++i]; continue }
    if (a === '--refaire') { o.refaire = true; continue }
    if (a === '--garder') { o.garder = true; continue }
    if (a.startsWith('--')) throw new Error(`option inconnue : ${a}`)
    o.tranches.push(a.toUpperCase())
  }
  return o
}

// ---------------------------------------------------------------------------
// Extraction DuckDB : une tranche du Parquet vers un NDJSON de travail.
// ---------------------------------------------------------------------------

// Le département EN SQL, calqué exactement sur departementDepuisCp
// (atout-france.js) : outre-mer sur 3 chiffres, Corse coupée à 20200, métropole
// sur 2 chiffres. Toute autre forme de code postal tombe dans 'ZZ'. Deux règles
// qui divergeraient, c'est une tranche chargée deux fois et une autre jamais.
const SQL_DEPARTEMENT = `
  CASE
    WHEN cp IS NULL OR NOT regexp_matches(cp, '^[0-9]{5}$') THEN 'ZZ'
    WHEN cp LIKE '97%' OR cp LIKE '98%' THEN cp[1:3]
    WHEN cp LIKE '20%' THEN CASE WHEN CAST(cp AS INTEGER) < 20200 THEN '2A' ELSE '2B' END
    ELSE cp[1:2]
  END`

// Le code de tranche ne vient pas d'une requête HTTP mais de la ligne de
// commande ; il est quand même validé avant d'entrer dans le SQL, parce qu'un
// script qui interpole sans regarder finit toujours par être appelé par un
// autre script.
const TRANCHE_RE = /^(?:[0-9]{2}|[0-9]{3}|2A|2B|ZZ)$/

function extraire(o, tranche) {
  if (!TRANCHE_RE.test(tranche)) throw new Error(`tranche invalide : ${tranche}`)
  const sortie = join(o.travail, `overture-${tranche}.ndjson`)
  const sql = `
    SET memory_limit='4GB';
    SET preserve_insertion_order=false;
    COPY (
      SELECT id, nom, marque, cat, taxo, basic_category, confidence, operating_status,
             websites, emails, phones, socials,
             adr, ville, cp, lat, lng,
             datasets, licences, maj_source, version
      FROM read_parquet('${o.parquet.replace(/'/g, "''")}')
      WHERE ${SQL_DEPARTEMENT} = '${tranche}'
    ) TO '${sortie.replace(/'/g, "''")}' (FORMAT JSON);`
  const t0 = Date.now()
  const r = spawnSync('duckdb', ['-c', sql], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (r.error) throw new Error(`duckdb introuvable ou illisible : ${r.error.message}`)
  if (r.status !== 0) throw new Error(`duckdb a rendu ${r.status} : ${String(r.stderr || '').slice(0, 400)}`)
  return { fichier: sortie, ms: Date.now() - t0, octets: statSync(sortie).size }
}

// ---------------------------------------------------------------------------
// Analyse d'une ligne NDJSON. PURE : aucun réseau, aucune base.
// ---------------------------------------------------------------------------

// Première valeur exploitable d'une liste de la source (websites, phones,
// emails). 350 lignes portent deux téléphones et 1 260 deux sites ; sur
// l'échantillon la seconde valeur n'a jamais désigné un autre établissement,
// elle est laissée de côté plutôt que stockée dans un champ qui n'existerait
// que pour 0,06 % des lignes.
function premier(liste) {
  if (!Array.isArray(liste)) return ''
  for (const v of liste) {
    const s = String(v == null ? '' : v).trim()
    if (s) return s
  }
  return ''
}

// Éclatement des réseaux sociaux par hôte, patron referentiel_osm. Une URL non
// reconnue va dans social_autre, la première seulement.
function eclaterSocials(liste) {
  const out = { facebook: '', instagram: '', linkedin: '', social_autre: '' }
  if (!Array.isArray(liste)) return out
  for (const brut of liste) {
    const u = String(brut == null ? '' : brut).trim()
    if (!u) continue
    const hote = (u.match(/^https?:\/\/([^/?#]+)/i)?.[1] || '').toLowerCase().replace(/^www\./, '')
    if (!out.facebook && /(^|\.)facebook\.com$|(^|\.)fb\.com$/.test(hote)) { out.facebook = u; continue }
    if (!out.instagram && /(^|\.)instagram\.com$/.test(hote)) { out.instagram = u; continue }
    if (!out.linkedin && /(^|\.)linkedin\.com$/.test(hote)) { out.linkedin = u; continue }
    if (!out.social_autre) out.social_autre = u
  }
  return out
}

// Adresse libre → { numero, libelle }, BRUTS tous les deux.
//
// La coupe est celle de parserAdresseAgregee (lib/societes.js) : on retire
// d'abord le « CP + ville » final par decouperAdresseAgregee, puis le PREMIER
// groupe de chiffres est le numéro et l'indice accolé (bis, ter, une lettre)
// appartient au numéro, pas à la voie. Ce qui reste est le libellé.
//
// LA SEULE DIFFÉRENCE avec parserAdresseAgregee, et elle est voulue : le
// libellé n'est PAS canonisé. Il est stocké tel que la source l'écrit, comme
// referentiel_osm.street et comme referentiel_societes.libelle_voie ; c'est
// normaliserVoie qui canonise, au moment de comparer. Un champ nommé
// libelle_voie qui contiendrait une clé canonique mentirait sur son contenu, et
// la première requête écrite de mémoire serait fausse silencieusement. PURE.
function eclaterAdresseLibre(adresse) {
  const { voie: corps } = decouperAdresseAgregee(adresse)
  if (!corps) return { numero: '', libelle: '' }
  const m = corps.match(/\d+/)
  if (!m) return { numero: '', libelle: corps.trim() }
  const libelle = corps
    .slice(m.index + m[0].length)
    .replace(/^\s*(bis|ter|quater|quinquies|[a-z])\b/i, ' ')
    .trim()
  return { numero: m[0], libelle }
}

// Les listes datasets / licences sont parallèles, une entrée par source de
// l'enregistrement (4,33 M sources pour 2,16 M lignes françaises). On les joint
// par virgule dans leur ordre d'origine plutôt que d'en élire une : la licence
// applicable à la ligne est l'ensemble de celles-ci, pas la première.
function joindre(liste) {
  if (!Array.isArray(liste)) return ''
  const vus = []
  for (const v of liste) {
    const s = String(v == null ? '' : v).trim()
    if (s && !vus.includes(s)) vus.push(s)
  }
  return vus.join(',')
}

// La date de mise à jour la plus RÉCENTE parmi les sources de la ligne : c'est
// celle qui répond à « de quand date cette information ».
function derniereMaj(liste) {
  if (!Array.isArray(liste)) return ''
  let max = ''
  for (const v of liste) {
    const s = String(v == null ? '' : v).trim()
    if (s && s > max) max = s
  }
  return max
}

// Une ligne NDJSON → l'objet à écrire, ou NULL si elle n'a pas de nom : un lieu
// sans nom ne désigne rien, et `nom` est déclaré non optionnel dans le schéma.
export function analyserLigne(l, release) {
  const nom = String(l?.nom || '').trim()
  const cle = String(l?.id || '').trim()
  if (!cle || !nom) return null
  const cp = String(l?.cp || '').trim()
  const adresse = String(l?.adr || '').trim()
  const { numero, libelle } = eclaterAdresseLibre(adresse)
  const { website, domaine } = normaliserSite(premier(l?.websites))
  const soc = eclaterSocials(l?.socials)
  return {
    cle,
    nom,
    marque: String(l?.marque || '').trim(),
    categorie: String(l?.cat || '').trim(),
    taxonomie: String(l?.taxo || '').trim(),
    categorie_base: String(l?.basic_category || '').trim(),
    confiance: typeof l?.confidence === 'number' ? l.confidence : null,
    statut: String(l?.operating_status || '').trim(),
    site: website,
    domaine,
    telephone: premier(l?.phones),
    email: premier(l?.emails),
    facebook: soc.facebook,
    instagram: soc.instagram,
    linkedin: soc.linkedin,
    social_autre: soc.social_autre,
    adresse,
    numero_voie: numero,
    libelle_voie: libelle,
    code_postal: cp,
    ville: String(l?.ville || '').trim(),
    departement: departementDepuisCp(cp),
    lat: typeof l?.lat === 'number' ? l.lat : null,
    lng: typeof l?.lng === 'number' ? l.lng : null,
    source_dataset: joindre(l?.datasets),
    source_licence: joindre(l?.licences),
    source_maj: derniereMaj(l?.maj_source),
    source_release: release,
    source_version: typeof l?.version === 'number' ? l.version : null
  }
}

// ---------------------------------------------------------------------------
// Écriture.
// ---------------------------------------------------------------------------

// Champs optionnels du SET, dans l'ordre du schéma. Une valeur vide est posée à
// NONE et non à '' : la table est SCHEMAFULL en option<…>, NONE est la forme de
// l'absence, et un rechargement doit pouvoir EFFACER une valeur que la source a
// retirée.
const CHAMPS_OPTIONNELS = [
  'marque', 'categorie', 'taxonomie', 'categorie_base', 'confiance', 'statut',
  'site', 'domaine', 'telephone', 'email',
  'facebook', 'instagram', 'linkedin', 'social_autre',
  'adresse', 'numero_voie', 'libelle_voie', 'code_postal', 'ville',
  'lat', 'lng',
  'source_dataset', 'source_licence', 'source_maj', 'source_release', 'source_version'
]

// UPSERT … SET par identifiant GERS. Le record id EST la clé : recharger réécrit
// les mêmes records, jamais des doublons (l'index UNIQUE le garantit en plus).
// `suffixe` distingue les paramètres des instructions groupées dans un même
// aller-retour. cached_at garde la première apparition, refreshed_at date le
// dernier passage. Idiome identique à rge.js et atout-france.js.
function construireUpsert(e, suffixe) {
  const params = { [`id${suffixe}`]: e.cle }
  const assigns = [`cle = $id${suffixe}`]
  for (const champ of ['nom', 'departement']) {
    assigns.push(`${champ} = $${champ}${suffixe}`)
    params[`${champ}${suffixe}`] = e[champ]
  }
  for (const champ of CHAMPS_OPTIONNELS) {
    const v = e[champ]
    // Le test porte sur undefined / null / '', jamais sur la fausseté : une
    // confiance de 0 et une latitude de 0 sont des valeurs.
    if (v === undefined || v === null || v === '') { assigns.push(`${champ} = NONE`); continue }
    assigns.push(`${champ} = $${champ}${suffixe}`)
    params[`${champ}${suffixe}`] = v
  }
  const sql = `UPSERT type::record("${TABLE}", $id${suffixe}) SET
       ${assigns.join(',\n       ')},
       source = 'overture',
       cached_at = IF cached_at = NONE THEN time::now() ELSE cached_at END,
       refreshed_at = time::now()`
  return { sql, params }
}

// Écrit un lot en UN aller-retour. Si le lot échoue (le pilote rejette la
// requête entière dès qu'une instruction est en erreur), on le rejoue ligne par
// ligne : une ligne fautive coûte une ligne, pas cent.
async function ecrireLot(db, lot) {
  const morceaux = []
  const params = {}
  lot.forEach((e, i) => {
    const { sql, params: p } = construireUpsert(e, `_${i}`)
    morceaux.push(sql)
    Object.assign(params, p)
  })
  try {
    await db.query(morceaux.join(';\n'), params)
    return { ecrits: lot.length, erreurs: 0 }
  } catch (e) {
    console.warn('[overture] lot rejeté, reprise ligne à ligne :', String(e?.message || e).slice(0, 140))
  }
  let ecrits = 0
  let erreurs = 0
  for (const e of lot) {
    try {
      const { sql, params: p } = construireUpsert(e, '')
      await db.query(sql, p)
      ecrits++
    } catch (err) {
      erreurs++
      console.warn('[overture]', String(e.cle).slice(0, 40), ':', String(err?.message || err).slice(0, 120))
    }
  }
  return { ecrits, erreurs }
}

// ---------------------------------------------------------------------------
// Une tranche.
// ---------------------------------------------------------------------------

function mediane(xs) {
  if (!xs.length) return 0
  const t = [...xs].sort((a, b) => a - b)
  return t[Math.floor(t.length / 2)]
}
function centile(xs, p) {
  if (!xs.length) return 0
  const t = [...xs].sort((a, b) => a - b)
  return t[Math.min(t.length - 1, Math.floor(t.length * p))]
}

async function chargerTranche(o, tranche) {
  const debut = new Date()
  const t0 = Date.now()
  const ext = extraire(o, tranche)
  console.log(`[overture ${tranche}] extraction : ${ext.ms} ms, ${(ext.octets / 1048576).toFixed(1)} Mo de NDJSON`)

  const db = await getDb()
  let lignes = 0
  let ignores = 0
  let ecrits = 0
  let erreurs = 0
  let octetsDocs = 0
  const duree = []
  let lot = []

  const passer = async () => {
    if (!lot.length) return
    const t = Date.now()
    const r = await ecrireLot(db, lot)
    duree.push(Date.now() - t)
    ecrits += r.ecrits
    erreurs += r.erreurs
    lot = []
    if (duree.length % PAS_TRACE === 0) {
      const faits = duree.length * LOT
      console.log(`[overture ${tranche}] ${faits} lignes, ${duree.length} lots, dernier ${duree[duree.length - 1]} ms, médiane ${mediane(duree)} ms`)
    }
    await sleep(PAUSE_LOT_MS)
  }

  const flux = createInterface({ input: createReadStream(ext.fichier, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const brut of flux) {
    const s = brut.trim()
    if (!s) continue
    lignes++
    let obj
    try { obj = JSON.parse(s) } catch { ignores++; continue }
    const e = analyserLigne(obj, o.release)
    if (!e) { ignores++; continue }
    // Poids du document tel qu'il part vers la base, valeurs vides exclues :
    // c'est la mesure qui rapporte la taille au nombre de lignes.
    octetsDocs += Buffer.byteLength(JSON.stringify(e), 'utf8')
    lot.push(e)
    if (lot.length >= LOT) await passer()
  }
  await passer()

  if (!o.garder) { try { unlinkSync(ext.fichier) } catch {} }

  const ms = Date.now() - t0
  return {
    tranche,
    debut: debut.toISOString(),
    fin: new Date().toISOString(),
    ms,
    extraction_ms: ext.ms,
    lignes,
    ignores,
    ecrits,
    erreurs,
    lots: duree.length,
    lot_ms_median: mediane(duree),
    lot_ms_p95: centile(duree, 0.95),
    lot_ms_min: duree.length ? Math.min(...duree) : 0,
    lot_ms_max: duree.length ? Math.max(...duree) : 0,
    octets_docs: octetsDocs,
    octets_par_ligne: ecrits ? Math.round(octetsDocs / ecrits) : 0,
    release: o.release
  }
}

// ---------------------------------------------------------------------------
// Journal et boucle de tranches.
// ---------------------------------------------------------------------------

function tranchesJournalisees(chemin) {
  if (!existsSync(chemin)) return new Set()
  const faites = new Set()
  for (const l of readFileSync(chemin, 'utf8').split('\n')) {
    const s = l.trim()
    if (!s) continue
    try { const j = JSON.parse(s); if (j.tranche) faites.add(String(j.tranche)) } catch {}
  }
  return faites
}

async function main() {
  const o = lireArgs(process.argv.slice(2))
  if (!o.parquet || !existsSync(o.parquet)) throw new Error('--parquet <fichier> requis, et lisible')
  if (!o.tranches.length) throw new Error('aucune tranche demandée (ex. : 73, ou 01 02 03, ou ZZ)')
  mkdirSync(dirname(o.journal), { recursive: true })

  const faites = tranchesJournalisees(o.journal)
  const bilans = []
  for (const tranche of o.tranches) {
    if (faites.has(tranche) && !o.refaire) {
      console.log(`[overture ${tranche}] déjà journalisée, sautée (--refaire pour la rejouer)`)
      continue
    }
    const bilan = await chargerTranche(o, tranche)
    appendFileSync(o.journal, JSON.stringify(bilan) + '\n')
    bilans.push(bilan)
    console.log(`[overture ${tranche}] ${bilan.ecrits} écrits, ${bilan.erreurs} erreurs, ${bilan.ignores} ignorés, ${Math.round(bilan.ms / 1000)} s, lot médian ${bilan.lot_ms_median} ms, ${bilan.octets_par_ligne} o/ligne`)
  }
  console.log('\n══ COMPTE RENDU BRUT ══')
  console.log(JSON.stringify(bilans, null, 2))
}

// Le module s'exécute quand il EST le programme, et se laisse importer sinon :
// analyserLigne se vérifie alors sur un échantillon sans ouvrir de connexion ni
// écrire une ligne.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .catch((e) => { console.error('[overture] arrêt :', e?.message || e); process.exitCode = 1 })
    .finally(() => close())
}
