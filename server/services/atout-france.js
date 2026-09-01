// Chargeur Atout France — télécharge le fichier des hébergements touristiques
// classés et le range dans referentiel_atout_france (table définie par
// server/services/referentiel-atout-france.js).
//
// CE N'EST PAS UN CRAWL. Un seul GET, sur un fichier d'open data publié pour
// être téléchargé en bloc, chez un producteur public qui l'annonce et le
// versionne. Il ne passe donc NI par politeFetchText, NI par le portillon
// robots.txt, NI par les files de politesse : ces trois-là bornent le démarchage de
// sites tiers qui ne nous ont rien demandé, et n'ont rien à faire ici. Un fetch
// direct, un timeout généreux (3,7 Mo à rapatrier), et c'est tout.
//
// Analyse CSV MAISON, sans nouvelle dépendance. Le fichier est plat : 17
// colonnes, séparateur point-virgule, UTF-8, en-tête en première ligne, aucun
// point-virgule ni saut de ligne à l'intérieur d'un champ (vérifié : les 21 369
// lignes portent exactement 17 champs). Les guillemets qu'on y trouve sont
// DÉCORATIFS et parfois DÉPAREILLÉS — « Lieu dit "Le Chaumois" », mais aussi
// « Club  "Les Portes de l'Océan » sans fermante. D'où la règle du découpeur :
// un guillemet n'ouvre une citation que s'il est le PREMIER caractère du champ
// (règle RFC 4180 standard) ; partout ailleurs c'est un caractère comme un
// autre. Un analyseur qui traiterait tout guillemet comme un délimiteur
// avalerait la fin du fichier sur la ligne dépareillée.
//
// JAMAIS DE THROW : le service avale et journalise, comme actualites.js. Un
// chargement raté rend un compte à zéro ; la table garde ce qu'elle avait.
//
// CHARGEMENT BORNÉ. Un appel n'écrit qu'un nombre borné de lignes (défaut 2 000,
// maximum 5 000) et rend un `restant` : l'appelant relance jusqu'à zéro, comme
// pour le backfill cle_nom. Mais là où le backfill relit sa matière dans la base à
// chaque appel, la nôtre vient d'un fichier distant : elle est donc téléchargée et
// analysée UNE fois, puis gardée en cache entre deux appels. Durée de vie, reprise
// après redémarrage et verrou : tout est dit à la section CACHE, plus bas.
//
// Ce module NE RAPPROCHE RIEN. Il ne lit ni n'écrit referentiel_societes : le
// rapprochement par NAF + adresse + nom est une passe ultérieure.

import { getDb } from '../../lib/surreal.js'
import { parserAdresseAgregee } from '../../lib/societes.js'

const FICHIER_URL = 'https://data.classement.atout-france.fr/static/exportHebergementsClasses/hebergements_classes.csv'
const TABLE = 'referentiel_atout_france'

// Timeout large : le fichier fait ~3,7 Mo et le producteur n'est pas un CDN.
const FETCH_TIMEOUT_MS = 120000
// Garde-fou de taille : ~9× le fichier du jour. Au-delà, ce n'est plus ce fichier.
const MAX_BYTES = 32 * 1024 * 1024

// Écriture par lots de LOT instructions dans UN aller-retour. Le fichier fait
// 21 k lignes : une requête par ligne, ce serait 21 k allers-retours WebSocket et
// un chargement qui se compte en heures. Groupées par cent, c'est ~215 requêtes
// d'une soixantaine de kilo-octets — sans rapport avec les agrégations de masse
// qui mettent movup-prod à genoux, et une pause sépare tout de même les lots,
// sur le modèle du backfill cle_nom : ce chargement ne prime jamais sur une
// requête d'abonné.
const LOT = 100
const PAUSE_LOT_MS = 150

// Bornes de la clé naturelle, par PARTIE (jamais sur la concaténation : tronquer
// l'ensemble laisserait un nom très long dévorer la part d'adresse et fusionner
// deux établissements distincts).
const MAX_PART_CLE = 90

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// CACHE du fichier analysé, et curseur de reprise.
//
// POURQUOI. Le backfill cle_nom relit sa matière dans la base à chaque appel, pour
// trois sous. Ici elle vient de chez un tiers et pèse 3,7 Mo : la retélécharger à
// chacun des ~11 appels d'un chargement complet, ce serait 40 Mo tirés chez un
// producteur public pour un travail qui n'en demande que 3,7. Le fichier est donc
// téléchargé UNE fois, analysé UNE fois, et le tableau d'hébergements qui en sort
// reste en mémoire du processus avec un curseur, le temps du chargement.
//
// BÉNÉFICE SECOND, pas accessoire : le producteur republie le fichier chaque jour.
// Sans cache, un chargement à cheval sur une publication mêlerait deux éditions.
// Avec, tous les appels d'un même chargement travaillent sur UNE photo.
//
// DURÉE DE VIE : CACHE_TTL_MS après le téléchargement, pas une seconde de plus.
// Trente minutes couvrent largement un chargement complet mené à la main (~11
// appels de quelques dizaines de secondes) et garantissent qu'un chargement lancé
// le lendemain reparte d'un fichier frais. Le cache est de surcroît LIBÉRÉ dès que
// le curseur atteint la fin : la mémoire (21 k objets) n'est pas retenue après
// coup, et un appel qui suit un chargement terminé en recommence proprement un
// autre, sur un fichier retéléchargé.
//
// REDÉMARRAGE DU SERVEUR EN COURS DE CHARGEMENT : cache et curseur disparaissent
// ENSEMBLE — ils sont le même objet, le curseur n'est persisté nulle part.
// L'appel suivant retélécharge, réanalyse, et REPART DE LA LIGNE 1 : un chargement
// interrompu se refait en entier, il ne saute rien. La table n'en souffre pas,
// l'UPSERT étant posé sur la clé naturelle — réécrire une ligne déjà écrite la
// réécrit à l'identique. Le seul coût est du temps. Idem si le TTL expire entre
// deux appels.
//
// L'invariant qui rend tout cela sûr : un curseur à K ne vaut « K lignes déjà
// traitées » que RELATIVEMENT au tableau qui l'accompagne, et il naît à 0 avec
// lui. Aucun chemin de code ne peut appliquer un curseur à un autre tableau.
//
// VERROU MONO-APPEL : deux appels concurrents se partageraient ce curseur et
// doubleraient la charge d'écriture sur movup-prod (1 Go partagé avec le trafic
// live). Le second est REFUSÉ (`occupe: true`, 409 côté route) plutôt que mis en
// file. Le cas visé n'est pas l'opérateur pressé mais le curl relancé après un
// timeout de proxy, alors que le serveur, lui, travaille toujours.
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 30 * 60 * 1000
let cache = null        // { hebergements, lus, ignores, sourceMaj, curseur, expire_a }
let enCours = false

// Bornes d'un appel, en LOTS de LOT lignes : défaut 20 (2 000 lignes), maximum 50
// (5 000 lignes) — mêmes bornes que ?batches= du backfill cle_nom, pour la même
// raison : tenir sous le timeout Railway.
const LOTS_DEFAUT = 20
const LOTS_MAX = 50

// ---------------------------------------------------------------------------
// Colonnes. Correspondance champ interne → en-tête du fichier, NORMALISÉ
// (majuscules, accents retirés, tout ce qui n'est pas alphanumérique ramené à
// un espace) : « CAPACITÉ D'ACCUEIL (PERSONNES) » et « CAPACITE D ACCUEIL
// PERSONNES » désignent alors la même colonne, et un producteur qui retire ses
// accents ou ses parenthèses ne casse rien.
//
// La correspondance est EXACTE, jamais par préfixe : « CLASSEMENT » et
// « CLASSEMENT PROROGE » se distinguent mal autrement. Si une colonne
// obligatoire manque, le fichier a changé de forme — on n'écrit rien et on le
// dit, plutôt que de deviner.
// ---------------------------------------------------------------------------
const COLONNES = {
  date_classement: 'DATE DE CLASSEMENT',
  typologie: 'TYPOLOGIE ETABLISSEMENT',
  classement: 'CLASSEMENT',
  categorie: 'CATEGORIE',
  // Troisième facette du classement, à côté de CLASSEMENT et CATÉGORIE, et
  // renseignée pour les seuls villages de vacances (« - » partout ailleurs).
  // Cinquième colonne du fichier : sa place logique est aussi sa place physique.
  mention: 'MENTION VILLAGES DE VACANCES',
  nom: 'NOM COMMERCIAL',
  adresse: 'ADRESSE',
  postcode: 'CODE POSTAL',
  city: 'COMMUNE',
  website: 'SITE INTERNET',
  type_sejour: 'TYPE DE SEJOUR',
  capacite: 'CAPACITE D ACCUEIL PERSONNES',
  chambres: 'NOMBRE DE CHAMBRES',
  emplacements: 'NOMBRE D EMPLACEMENTS',
  unites_habitation: 'NOMBRE D UNITES D HABITATION RESIDENCES DE TOURISME',
  logements: 'NOMBRE DE LOGEMENTS VILLAGES DE VACANCES',
  classement_proroge: 'CLASSEMENT PROROGE'
}

// Sans nom commercial il n'y a rien à rapprocher ; sans code postal à 5 chiffres
// il n'y a pas de département, donc pas de borne de chargement.
const COLONNES_OBLIGATOIRES = ['nom', 'postcode']

// Champs numériques : les cinq dénombrements du fichier.
const CHAMPS_NOMBRE = new Set(['capacite', 'chambres', 'emplacements', 'unites_habitation', 'logements'])

// Typologie → NAF, au format NN.NNL de referentiel_societes (point, majuscule).
// Les six typologies du fichier sont couvertes ; une septième qui apparaîtrait
// laisserait simplement `naf` vide, sans erreur.
const NAF_PAR_TYPOLOGIE = {
  'HOTEL DE TOURISME': '55.10Z',
  'CAMPING': '55.30Z',
  'PARC RESIDENTIEL DE LOISIRS': '55.30Z',
  'RESIDENCE DE TOURISME': '55.20Z',
  'VILLAGE DE VACANCES': '55.20Z',
  'AUBERGE COLLECTIVE': '55.20Z'
}

// Champs optionnels écrits par l'UPSERT, dans l'ordre du SET. Un champ vide est
// posé à NONE (et non à '') : la table est SCHEMAFULL en option<…>, NONE est la
// forme de l'absence, et un rechargement doit pouvoir EFFACER une valeur que le
// producteur a retirée.
const CHAMPS_OPTIONNELS = [
  'website', 'domaine',
  'housenumber', 'street', 'postcode', 'city', 'adresse_brute',
  'naf', 'typologie', 'classement', 'categorie', 'mention', 'type_sejour',
  'capacite', 'chambres', 'emplacements', 'unites_habitation', 'logements',
  'date_classement', 'classement_proroge', 'source_maj'
]

// ---------------------------------------------------------------------------
// Analyse. Fonctions PURES : aucun réseau, aucune base.
// ---------------------------------------------------------------------------

// Retire les diacritiques (NFD) — pipeline commun à toutes les normalisations.
function sansAccents(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
}

// En-tête du fichier → forme canonique de comparaison.
function normaliserEntete(s) {
  return sansAccents(s).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()
}

// Valeur de cellule → chaîne exploitable. Le fichier écrit « - » là où la donnée
// est absente : c'est du vide, pas un contenu.
function valeur(s) {
  const v = String(s ?? '').trim()
  return v === '-' ? '' : v
}

// Dénombrement → entier, ou undefined. Une valeur non entière (le fichier n'en
// porte aucune aujourd'hui) laisse le champ ABSENT : jamais une erreur de ligne,
// jamais un NaN glissé dans une colonne typée number.
function nombre(s) {
  const v = valeur(s)
  if (!/^\d+$/.test(v)) return undefined
  const n = Number(v)
  return Number.isSafeInteger(n) ? n : undefined
}

// Découpe UNE ligne en champs. Séparateur point-virgule. Un guillemet n'ouvre
// une citation que s'il est le PREMIER caractère du champ ; à l'intérieur d'une
// citation, «"" » vaut un guillemet littéral. Une citation non refermée se clôt
// en fin de ligne — le fichier en porte une, et elle ne doit pas contaminer la
// suite. PURE.
export function decouperLigne(ligne) {
  const champs = []
  const s = String(ligne || '')
  let courant = ''
  let debutChamp = true
  let cite = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (debutChamp) {
      debutChamp = false
      if (c === '"') { cite = true; continue }
    }
    if (cite) {
      if (c === '"') {
        if (s[i + 1] === '"') { courant += '"'; i++; continue }   // "" → guillemet littéral
        cite = false
        continue
      }
      courant += c
      continue
    }
    if (c === ';') { champs.push(courant); courant = ''; debutChamp = true; cite = false; continue }
    courant += c
  }
  champs.push(courant)
  return champs
}

// Code postal → département. Trois régimes :
//   · DOM-COM : 3 chiffres (971 Guadeloupe … 976 Mayotte, 988 Nouvelle-Calédonie
//     — le fichier porte 971 à 976 et 988) ;
//   · Corse : 2A au sud (20000-20199), 2B au nord (20200-20999) — le fichier
//     porte les deux (200xx/201xx d'un côté, 202xx/206xx de l'autre) ;
//   · métropole : les 2 premiers chiffres.
// Le code postal ne détermine pas le département avec une exactitude parfaite
// (quelques communes limitrophes relèvent du bureau distributeur voisin), mais
// il n'a ici qu'à borner un chargement, pas à établir une domiciliation. Rend ''
// si le code n'est pas fait de 5 chiffres. PURE.
export function departementDepuisCp(cp) {
  const v = String(cp || '').trim()
  if (!/^\d{5}$/.test(v)) return ''
  if (v.startsWith('97') || v.startsWith('98')) return v.slice(0, 3)
  if (v.startsWith('20')) return Number(v) < 20200 ? '2A' : '2B'
  return v.slice(0, 2)
}

// Typologie du fichier → code NAF. Comparaison sur la forme sans accents et en
// majuscules : « HÔTEL DE TOURISME » et « HOTEL DE TOURISME » sont la même
// chose. Rend '' pour une typologie inconnue. PURE.
export function nafDepuisTypologie(typologie) {
  const cle = sansAccents(valeur(typologie)).toUpperCase().replace(/\s+/g, ' ').trim()
  return NAF_PAR_TYPOLOGIE[cle] || ''
}

// Fragment de clé naturelle : minuscules, accents retirés, tout le reste ramené
// à un tiret, bornage à MAX_PART_CLE. PURE.
function fragmentCle(s) {
  return sansAccents(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_PART_CLE)
}

// Clé naturelle d'un établissement : nom commercial + code postal + adresse
// brute, chacun normalisé, séparés par « | ».
//
// POURQUOI CETTE CLÉ : le fichier ne porte AUCUN identifiant — ni SIRET, ni
// numéro de classement, ni rang stable (il est trié par nom, et un nouvel
// entrant décale tout ce qui suit). La position dans le fichier ne peut donc pas
// servir. Restent les seules données qui identifient l'établissement lui-même :
// comment il s'appelle et où il est. Deux téléchargements successifs produisent
// la même clé pour le même établissement, donc le même record : c'est toute
// l'idempotence dont on dispose.
//
// SA NORMALISATION EST DÉLIBÉRÉMENT AUTONOME, et n'appelle PAS normaliserSociete
// (lib/societes.js) bien que ce soit la fonction de normalisation de nom de la
// maison. normaliserSociete est une heuristique de RAPPROCHEMENT, appelée à être
// affinée (sa liste de suffixes a déjà bougé) ; l'adosser une clé de stockage
// signifierait qu'affiner le rapprochement réécrit 21 k identifiants et
// dédouble toute la table au chargement suivant. Une clé se gèle, une heuristique
// se règle : les deux ne partagent pas de code.
//
// LIMITE ASSUMÉE : un établissement qui change de nom commercial ou d'écriture
// d'adresse chez le producteur reçoit une clé neuve, et l'ancien record subsiste
// jusqu'à une purge (hors périmètre de cette passe). Le fichier porte par
// ailleurs 6 couples de lignes qui partagent déjà nom + CP + adresse : l'UPSERT
// les fond deux à deux, ce qui est le comportement voulu.
// PURE.
export function composerCle(nom, cp, adresse) {
  return `${fragmentCle(nom)}|${String(cp || '').trim()}|${fragmentCle(adresse)}`
}

// Site du fichier → { website, domaine }. 1 877 des 21 183 sites renseignés sont
// écrits sans schéma (« www.exemple.fr ») : tels quels ils ne sont ni cliquables
// ni analysables, on préfixe en https. Tout ce qui n'est pas http(s) avec un hôte
// pourvu d'un point est écarté des DEUX champs — un `website` inexploitable vaut
// moins que pas de website. PURE.
export function normaliserSite(brut) {
  const v = valeur(brut)
  if (!v) return { website: '', domaine: '' }
  const candidat = /^https?:\/\//i.test(v) ? v : 'https://' + v
  try {
    const u = new URL(candidat)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { website: '', domaine: '' }
    const domaine = u.hostname.toLowerCase().replace(/^www\./, '')
    if (!domaine.includes('.')) return { website: '', domaine: '' }
    return { website: u.toString(), domaine }
  } catch {
    return { website: '', domaine: '' }
  }
}

// Adresse du fichier → { numero, voie }, par parserAdresseAgregee — la fonction
// déjà en service côté société (lib/societes.js:179), pas une variante.
//
// Elle attend la forme Etalab « <voie> <CP> <ville> » et commence par en retirer
// le « CP + ville » FINAL. On la lui reconstitue donc — mais SEULEMENT si le
// fichier donne les deux : sur les 2 lignes à commune vide, « 28 rue de la
// rouelle 35120 » ne correspond plus au motif attendu, le retrait n'opère pas et
// le code postal finirait dans le libellé de voie. Sans commune, on passe donc
// l'adresse SEULE, forme que la fonction traite tout aussi bien.
//
// city et postcode ne sont JAMAIS redéduits de l'agrégat : le fichier les donne
// en colonnes propres, les recalculer n'ajouterait qu'une chance de se tromper.
// PURE.
function eclaterAdresse(adresse, postcode, city) {
  if (!adresse) return { numero: '', voie: '' }
  const agregat = postcode && city ? `${adresse} ${postcode} ${city}` : adresse
  return parserAdresseAgregee(agregat)
}

// Texte CSV → { hebergements, lus, ignores }. PURE : ni réseau, ni base.
//   lus      = lignes de données lues (en-tête et lignes vides exclues)
//   ignores  = lignes sans nom commercial ou sans code postal à 5 chiffres
//   lus = hebergements.length + ignores
export function analyserCsv(texte, sourceMaj = '') {
  const hebergements = []
  let lus = 0
  let ignores = 0

  // BOM éventuel retiré : il collerait à l'en-tête de la première colonne.
  const brut = String(texte || '').replace(/^﻿/, '')
  const lignes = brut.split(/\r?\n/)
  if (lignes.length < 2) {
    console.warn('[atout-france] fichier vide ou sans ligne de données')
    return { hebergements, lus, ignores }
  }

  const entetes = decouperLigne(lignes[0]).map(normaliserEntete)
  const rang = {}
  for (const [champ, entete] of Object.entries(COLONNES)) {
    const p = entetes.indexOf(entete)
    if (p >= 0) rang[champ] = p
  }
  for (const champ of COLONNES_OBLIGATOIRES) {
    if (rang[champ] === undefined) {
      // Le fichier a changé de forme. On n'écrit RIEN : une table à moitié
      // remplie de colonnes décalées est pire qu'une table inchangée.
      console.error('[atout-france] colonne obligatoire absente —', COLONNES[champ])
      return { hebergements, lus, ignores }
    }
  }

  for (let i = 1; i < lignes.length; i++) {
    const ligne = lignes[i]
    if (!ligne.trim()) continue          // ligne vide (dont la dernière du fichier)
    lus++
    const cols = decouperLigne(ligne)
    const lire = (champ) => (rang[champ] === undefined ? '' : valeur(cols[rang[champ]]))

    const nom = lire('nom')
    const postcode = lire('postcode')
    const departement = departementDepuisCp(postcode)
    if (!nom || !departement) { ignores++; continue }

    const adresseBrute = lire('adresse')
    const city = lire('city')
    const parsee = eclaterAdresse(adresseBrute, postcode, city)
    const { website, domaine } = normaliserSite(lire('website'))

    const h = {
      cle: composerCle(nom, postcode, adresseBrute),
      nom,
      departement,
      website,
      domaine,
      housenumber: parsee.numero,
      street: parsee.voie,
      postcode,
      city,
      adresse_brute: adresseBrute,
      naf: nafDepuisTypologie(lire('typologie')),
      typologie: lire('typologie'),
      classement: lire('classement'),
      categorie: lire('categorie'),
      mention: lire('mention'),
      type_sejour: lire('type_sejour'),
      date_classement: lire('date_classement'),
      classement_proroge: lire('classement_proroge'),
      source_maj: sourceMaj
    }
    for (const champ of CHAMPS_NOMBRE) {
      h[champ] = rang[champ] === undefined ? undefined : nombre(cols[rang[champ]])
    }
    hebergements.push(h)
  }

  return { hebergements, lus, ignores }
}

// ---------------------------------------------------------------------------
// Écriture.
// ---------------------------------------------------------------------------

// UPSERT … SET par clé naturelle. Le record id EST la clé : recharger le fichier
// réécrit les mêmes records, jamais des doublons (l'index UNIQUE le garantit en
// plus). Idiome type::record identique à actualites.js et au reste du serveur.
//
// `suffixe` distingue les paramètres des instructions groupées dans un même
// aller-retour ($nom_0, $nom_1, …).
//
// cached_at : première apparition, préservée d'un rechargement à l'autre par
// l'idiome IF … = NONE (mêmes raisons que published_at dans actualites.js).
// refreshed_at : date du dernier passage, réécrite à chaque fois.
function construireUpsert(h, suffixe) {
  const params = { [`id${suffixe}`]: h.cle }
  const assigns = [`cle = $id${suffixe}`]
  for (const champ of ['nom', 'departement']) {
    assigns.push(`${champ} = $${champ}${suffixe}`)
    params[`${champ}${suffixe}`] = h[champ]
  }
  for (const champ of CHAMPS_OPTIONNELS) {
    const v = h[champ]
    if (v === undefined || v === null || v === '') { assigns.push(`${champ} = NONE`); continue }
    assigns.push(`${champ} = $${champ}${suffixe}`)
    params[`${champ}${suffixe}`] = v
  }
  const sql = `UPSERT type::record("${TABLE}", $id${suffixe}) SET
       ${assigns.join(',\n       ')},
       source = 'atout_france',
       cached_at = IF cached_at = NONE THEN time::now() ELSE cached_at END,
       refreshed_at = time::now()`
  return { sql, params }
}

// Écrit un lot en UN aller-retour, et rend le nombre d'instructions acceptées.
// Si le lot échoue (le pilote rejette la requête entière dès qu'une instruction
// est en erreur), on le rejoue ligne par ligne : une ligne fautive coûte une
// ligne, pas cent. Rend { ecrits, erreurs }.
async function ecrireLot(db, lot) {
  const morceaux = []
  const params = {}
  lot.forEach((h, i) => {
    const { sql, params: p } = construireUpsert(h, `_${i}`)
    morceaux.push(sql)
    Object.assign(params, p)
  })
  try {
    await db.query(morceaux.join(';\n'), params)
    return { ecrits: lot.length, erreurs: 0 }
  } catch (e) {
    console.warn('[atout-france] lot rejeté, reprise ligne à ligne —', String(e?.message || e).slice(0, 120))
  }
  let ecrits = 0
  let erreurs = 0
  for (const h of lot) {
    try {
      const { sql, params: p } = construireUpsert(h, '')
      await db.query(sql, p)
      ecrits++
    } catch (e) {
      erreurs++
      console.warn('[atout-france]', h.cle.slice(0, 60), '—', String(e?.message || e).slice(0, 100))
    }
  }
  return { ecrits, erreurs }
}

// UN GET, puis l'analyse. Rend { hebergements, lus, ignores, sourceMaj }, ou NULL
// si le fichier est injoignable, anormalement gros, ou inexploitable — un null se
// distingue d'une analyse à zéro ligne, et c'est ce qui permet plus bas à
// `restant` de valoir null (inconnu) plutôt que 0 (terminé) après un échec.
async function telechargerEtAnalyser() {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  let texte = ''
  let sourceMaj = ''
  try {
    const r = await fetch(FICHIER_URL, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'Accept': 'text/csv,text/plain;q=0.9,*/*;q=0.5' }
    })
    clearTimeout(timer)
    if (!r.ok) {
      console.warn('[atout-france] fichier injoignable — HTTP', r.status)
      return null
    }
    // Licence Ouverte : la date de dernière mise à jour se cite. Le producteur
    // la donne dans Last-Modified — c'est celle du fichier, pas celle du
    // téléchargement, et c'est bien la première qu'il faut conserver.
    const lm = r.headers.get('last-modified')
    const t = lm ? new Date(lm).getTime() : NaN
    sourceMaj = Number.isFinite(t) ? new Date(t).toISOString() : ''
    texte = await r.text()
    if (texte.length > MAX_BYTES) {
      console.warn('[atout-france] fichier anormalement gros —', texte.length, 'octets, chargement abandonné')
      return null
    }
  } catch (e) {
    clearTimeout(timer)
    console.warn('[atout-france] téléchargement —', String(e?.message || e).slice(0, 120))
    return null
  }

  const { hebergements, lus, ignores } = analyserCsv(texte, sourceMaj)
  if (hebergements.length === 0) {
    console.warn('[atout-france] fichier joignable mais aucune ligne exploitable')
    return null
  }
  return { hebergements, lus, ignores, sourceMaj }
}

// ---------------------------------------------------------------------------
// chargerAtoutFrance({ lots }) — UNE TRANCHE de chargement. JAMAIS de throw : rend
// un compte rendu. `lots` borne l'appel en lots de LOT lignes (défaut 20, maximum
// 50), l'appelant relançant jusqu'à restant = 0.
//
// Le compte rendu mêle trois échelles. Elles ne se confondent pas si on lit les
// noms, et aucune n'est déductible d'une autre :
//
//   ÉCHELLE FICHIER — identique d'un appel à l'autre tant que le cache tient
//     lus      lignes de données du fichier (en-tête et lignes vides exclues)
//     ignores  lignes sans nom commercial ou sans code postal à 5 chiffres
//     retenus  lignes exploitables du fichier          lus = retenus + ignores
//
//   ÉCHELLE APPEL — ce que CET appel a fait
//     traites  lignes retenues présentées à l'écriture traites = ecrits + erreurs
//     ecrits   UPSERT acceptés
//     erreurs  UPSERT rejetés — la ligne est comptée et le curseur passe outre :
//              elle n'est pas rejouée dans ce chargement-ci, un suivant la réécrira
//     lots     lots de LOT écrits (≤ la borne demandée)
//     duree_ms
//
//   ÉCHELLE CHARGEMENT — où en est-on
//     curseur  lignes retenues traitées depuis le début du chargement
//     restant  retenus - curseur. ZÉRO = terminé (relancer entamera un nouveau
//              chargement, sur un fichier retéléchargé). NULL = INCONNU, le
//              téléchargement ou l'analyse a échoué : un échec ne doit jamais se
//              lire comme un chargement terminé.
//
//   origine     'telechargement' (cet appel a tiré le fichier) | 'cache' | ''
//   source_maj  Last-Modified du fichier, '' si le producteur ne l'a pas donné
//   occupe      true = appel REFUSÉ, un chargement est déjà en cours ; rien n'a
//               été téléchargé ni écrit, tous les compteurs sont à zéro
//
// `ecrits` compte les UPSERT acceptés, pas les records distincts : le fichier
// porte 6 couples de lignes qui partagent la même clé naturelle, et l'UPSERT les
// fond deux à deux. L'écart attendu entre le cumul des `ecrits` d'un chargement
// complet et le count de la table est donc de 6, pas de 0.
// ---------------------------------------------------------------------------

export async function chargerAtoutFrance({ lots } = {}) {
  const debut = Date.now()
  const maxLots = Math.min(LOTS_MAX, Math.max(1, Number(lots) || LOTS_DEFAUT))
  const compte = {
    lus: 0, ignores: 0, retenus: 0,
    traites: 0, ecrits: 0, erreurs: 0, lots: 0,
    curseur: 0, restant: null,
    origine: '', source_maj: '', occupe: false, duree_ms: 0
  }

  if (enCours) {
    compte.occupe = true
    compte.duree_ms = Date.now() - debut
    console.warn('[atout-france] appel refusé — un chargement est déjà en cours')
    return compte
  }
  enCours = true

  try {
    // TTL échu : le cache est jeté AVANT d'être lu, jamais pendant. Le curseur
    // part avec lui, et l'appel repart de la ligne 1 sur un fichier frais.
    if (cache && Date.now() > cache.expire_a) {
      console.log('[atout-france] cache expiré — retéléchargement, reprise depuis la ligne 1')
      cache = null
    }

    let analyse = cache
    if (analyse) {
      compte.origine = 'cache'
    } else {
      analyse = await telechargerEtAnalyser()
      if (analyse) {
        compte.origine = 'telechargement'
        cache = { ...analyse, curseur: 0, expire_a: Date.now() + CACHE_TTL_MS }
        analyse = cache
      }
    }

    if (analyse) {
      compte.lus = analyse.lus
      compte.ignores = analyse.ignores
      compte.retenus = analyse.hebergements.length
      compte.source_maj = analyse.sourceMaj
      compte.curseur = cache.curseur
      compte.restant = cache.hebergements.length - cache.curseur

      // SÉQUENTIEL, lot après lot : on attend l'écriture d'un lot avant d'envoyer
      // le suivant, avec une pause entre deux — movup-prod tourne sur 1 Go partagé
      // avec le trafic live, et ce chargement ne doit jamais primer sur une requête
      // d'abonné (même cadence que le backfill cle_nom).
      const db = await getDb()
      for (let l = 0; l < maxLots && cache.curseur < cache.hebergements.length; l++) {
        const lot = cache.hebergements.slice(cache.curseur, cache.curseur + LOT)
        const { ecrits, erreurs } = await ecrireLot(db, lot)
        // Le curseur avance APRÈS l'écriture, et de tout le lot : il ne désigne
        // jamais que des lignes effectivement présentées à la base.
        cache.curseur += lot.length
        compte.traites += lot.length
        compte.ecrits += ecrits
        compte.erreurs += erreurs
        compte.lots++
        // Tenus à jour à CHAQUE lot, et pas seulement en sortie de boucle : si un
        // imprévu interrompt l'appel en cours de route, le compte rendu dit encore
        // où en est le curseur, et l'appel suivant y reprend.
        compte.curseur = cache.curseur
        compte.restant = cache.hebergements.length - cache.curseur
        if (l + 1 < maxLots && cache.curseur < cache.hebergements.length) await sleep(PAUSE_LOT_MS)
      }

      // Fichier épuisé : le cache a fait son office, on rend les 21 k objets tout
      // de suite plutôt que de les garder jusqu'au TTL. Un appel ultérieur entamera
      // un nouveau chargement, sur un fichier retéléchargé.
      if (compte.restant === 0) cache = null
    }

    console.log(
      `[atout-france] lus=${compte.lus} ignorés=${compte.ignores} retenus=${compte.retenus}` +
      ` | cet appel : traités=${compte.traites} écrits=${compte.ecrits} erreurs=${compte.erreurs}` +
      ` lots=${compte.lots}/${maxLots} origine=${compte.origine || 'échec'}` +
      ` | curseur=${compte.curseur} restant=${compte.restant === null ? 'inconnu' : compte.restant}` +
      ` durée=${Date.now() - debut}ms maj=${compte.source_maj || 'inconnue'}`
    )
  } catch (e) {
    console.error('[atout-france]', String(e?.message || e).slice(0, 120))
  } finally {
    enCours = false
    compte.duree_ms = Date.now() - debut
  }
  return compte
}
