// Chargeur RGE — rapatrie les qualifications « Reconnu Garant de
// l'Environnement » de l'ADEME et les range dans referentiel_rge (table définie
// par server/services/referentiel-rge.js).
//
// CE N'EST PAS UN CRAWL. Des GET sur l'API publique d'un producteur public, qui
// la documente et en publie les quotas. Comme atout-france.js, il ne passe NI par
// politeFetchText, NI par le portillon robots.txt, NI par la file mono-verrou :
// ces trois-là bornent le démarchage de sites tiers qui ne nous ont rien demandé.
//
// ── POURQUOI UNE PAGINATION, ET PAS UN FICHIER ──────────────────────────────
// Le jeu `liste-des-entreprises-rge-2` est VIRTUEL : une vue de `historique-rge`
// filtrée sur `traitement_termine = false`. Il n'a donc pas de fichier d'origine,
// et AUCUNE route de bloc n'existe — /raw, /full, /data-files, compatibilité ODS
// et export ODS v2.1 ont toutes été sondées, toutes en 404 ou vides. Les
// permissions `downloadFullData` / `downloadOriginalData` que le jeu affiche ne
// débloquent rien de tel : elles autorisent seulement `format=csv` sur /lines.
// Le plafond y est dur — « size + skip » ne peut pas dépasser 10 000.
//
// L'autre voie, le fichier hebdomadaire de `historique-rge`
// (historique-rge-last-export.csv), a été écartée pour trois raisons cumulées :
// 2,83 Go, 5,67 millions de lignes dont il faudrait refaire nous-mêmes le filtre
// `traitement_termine`, et surtout un Last-Modified de six mois — le producteur
// annonce un rafraîchissement hebdomadaire qu'il n'assure pas.
//
// Reste la pagination au curseur : 17 requêtes, ~76 Mo, environ deux minutes de
// réseau. Le gzip divise le transfert par 5,8 mais ne change RIEN à la durée (le
// temps est consommé par le scroll Elasticsearch côté ADEME, pas par le fil) :
// on ne le demande donc pas, une page décompressée de moins est une page de
// moins à garder en mémoire.
//
// ── LA CONTRAINTE STRUCTURANTE : UNE PAGE À LA FOIS ─────────────────────────
// Les 162 259 lignes ne sont JAMAIS accumulées. Une page (10 000 lignes,
// ~4,5 Mo de texte) est téléchargée, analysée, écrite par lots de 100, puis
// relâchée avant la suivante. movup-prod tourne sur 1 Go partagé avec le trafic
// live : 76 Mo de texte plus les objets analysés n'y tiennent pas, et c'est
// exactement le genre de pic qui a déjà fait lâcher le socket sur ce conteneur.
//
// ── LA REPRISE : LE CURSEUR DE LA SOURCE, ET RIEN D'AUTRE ───────────────────
// Pas de cache de module, contrairement à atout-france.js. Là-bas, le cache
// existe pour ne pas retélécharger onze fois un fichier de 3,7 Mo qui se lit
// d'un bloc. Ici la source EST paginée : elle fournit elle-même le point de
// reprise, dans l'en-tête `link: <…>; rel="next"` de chaque réponse. Le
// conserver en mémoire du processus n'apporterait rien et coûterait tout ce que
// coûte un état : un TTL à choisir, un verrou à poser, une reprise à réinventer
// après redémarrage. On le rend dans le compte rendu, l'appelant le repasse au
// suivant. Rien à expirer, rien à perdre au redémarrage.
//
// UNE SEULE RÉSERVE, et elle est réelle : si la réponse HTTP n'atteint jamais
// l'appelant — timeout de proxy Railway sur un appel long — le curseur est perdu
// avec elle, et il faut repartir de la page 1. D'où le journal : le curseur est
// LOGGÉ après chaque page, pas seulement rendu en fin d'appel. Un chargement
// interrompu se rattrape dans les logs Railway sans rien retélécharger. C'est le
// même service qu'un curseur persisté, sans la table qui va avec.
//
// CE QUE LE CURSEUR TRANSPORTE, et pourquoi on n'en prend qu'une partie.
// L'en-tête `link` donne une URL absolue complète. On n'en extrait que le
// paramètre `after` (deux entiers, « <_i>,<_rand> »), validé par CURSEUR_RE, et
// on reconstruit l'URL nous-mêmes à partir d'une base en dur. Refaire un fetch
// sur une URL venue d'un paramètre de requête HTTP serait une SSRF offerte : la
// route admin est certes derrière requireSuperadmin, mais une chaîne
// d'appelants ne se vérifie qu'une fois qu'elle est écrite. Deux entiers ne
// peuvent désigner aucun hôte.
//
// ── REPUBLICATION EN COURS DE CHARGEMENT ────────────────────────────────────
// L'ADEME refinalise le jeu chaque nuit vers 03 h 01. Le curseur `after` porte
// des valeurs de tri (_i, _rand) qui appartiennent à l'index du moment : appliqué
// à un index refait, il peut sauter ou répéter des lignes. On compare donc le
// Last-Modified de chaque page à celui de la première page de l'appel, et on
// S'ARRÊTE net s'il a bougé, avant d'écrire la page suspecte. L'appel rend le
// dernier curseur sûr ; l'appelant reprendra — sur la nouvelle édition, ce qui
// est le comportement voulu.
//
// JAMAIS DE THROW : le service avale et journalise, comme atout-france.js et
// actualites.js. Un chargement raté rend un compte à zéro ; la table garde ce
// qu'elle avait.
//
// Ce module NE RAPPROCHE RIEN. Il ne lit ni n'écrit referentiel_societes.

import { getDb } from '../../lib/surreal.js'
import { departementDepuisCp, normaliserSite } from './atout-france.js'

const TABLE = 'referentiel_rge'

// Base de l'API. Le slug est écrit en dur : l'identifiant interne du jeu
// (6x4i1u8yqh1sfhis83l1gw6f), que l'ADEME renvoie dans ses en-têtes `link`, est
// un détail d'implémentation de data-fair, pas une adresse publique.
const BASE_URL = 'https://data.ademe.fr/data-fair/api/v1/datasets/liste-des-entreprises-rge-2/lines'

// Les 20 colonnes de la source, plus `_id`. Demandées EXPLICITEMENT par `select`
// et non laissées au défaut : sans lui, le CSV rend les 20 colonnes métier mais
// PAS `_id`, qui est justement la clé. L'ordre demandé est l'ordre rendu, mais on
// ne s'y fie pas — l'appariement se fait par nom d'en-tête, plus bas.
const COLONNES_SOURCE = [
  '_id',
  'siret', 'nom_entreprise', 'adresse', 'code_postal', 'commune',
  'latitude', 'longitude', 'telephone', 'email', 'site_internet',
  'code_qualification', 'nom_qualification', 'url_qualification',
  'nom_certificat', 'domaine', 'meta_domaine', 'organisme',
  'particulier', 'lien_date_debut', 'lien_date_fin'
]

// Sans ces trois-là le CSV n'est pas celui qu'on croit : on n'écrit rien plutôt
// que d'écrire des colonnes décalées. `domaine` n'y figure pas — son absence
// laisserait `domaine_travaux` vide, ce qui est fâcheux mais pas faux.
const COLONNES_OBLIGATOIRES = ['_id', 'siret', 'code_postal']

// Le plafond dur de l'API. Ne pas augmenter : au-delà, HTTP 400.
const TAILLE_PAGE = 10000

// Bornes d'un appel, en PAGES. 4 pages = 40 000 lignes ≈ deux minutes, de quoi
// tenir sous le timeout de proxy. 17 pages couvrent le jeu entier (162 259 /
// 10 000 = 16,3), ce qui permet un chargement complet en un appel quand on peut
// se le permettre — mais c'est l'appel qui risque le plus de se perdre en route,
// cf. la réserve sur la reprise en tête de fichier.
const PAGES_DEFAUT = 4
const PAGES_MAX = 17

// Le curseur `after` de data-fair sous le tri `_i` : deux entiers, « _i,_rand ».
// Tout ce qui n'a pas cette forme est refusé sans fetch (cf. en-tête, SSRF).
const CURSEUR_RE = /^\d{1,20},\d{1,20}$/

// Timeout large : une page de 10 000 lignes se génère en ~7 s côté ADEME, mais
// le producteur n'est pas un CDN et le scroll peut traîner.
const FETCH_TIMEOUT_MS = 120000
// Garde-fou de taille : ~7× une page du jour. Au-delà, ce n'est plus une page.
const MAX_BYTES = 32 * 1024 * 1024

// Écriture par lots de LOT instructions dans UN aller-retour, avec une pause
// entre deux — cadence identique à atout-france.js et au backfill cle_nom, pour
// la même raison : ce chargement ne prime jamais sur une requête d'abonné.
const LOT = 100
const PAUSE_LOT_MS = 150
// Pause entre deux pages : l'ADEME publie 600 requêtes par minute en anonyme, on
// en fait 17 en tout — la pause n'est pas là pour le quota mais pour rendre la
// main au reste du processus entre deux blocs de 100 écritures.
const PAUSE_PAGE_MS = 500

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Champs optionnels écrits par l'UPSERT, dans l'ordre du SET. Un champ vide est
// posé à NONE (et non à '') : la table est SCHEMAFULL en option<…>, NONE est la
// forme de l'absence, et un rechargement doit pouvoir EFFACER une valeur que le
// producteur a retirée.
const CHAMPS_OPTIONNELS = [
  'nom_entreprise', 'adresse', 'code_postal', 'commune',
  'latitude', 'longitude',
  'telephone', 'email', 'site_internet', 'domaine_web',
  'code_qualification', 'nom_qualification', 'url_qualification',
  'nom_certificat', 'domaine_travaux', 'meta_domaine', 'organisme',
  'particulier', 'lien_date_debut', 'lien_date_fin',
  'source_maj'
]

// ---------------------------------------------------------------------------
// Analyse. Fonctions PURES : aucun réseau, aucune base.
// ---------------------------------------------------------------------------

// Découpe un texte CSV COMPLET en lignes de champs, selon RFC 4180 strict.
//
// CE N'EST PAS decouperLigne (atout-france.js), et la différence n'est pas de
// forme. Là-bas le fichier est plat : point-virgule, guillemets DÉCORATIFS et
// parfois dépareillés, aucun saut de ligne dans un champ — un découpage
// ligne par ligne suffit, et doit même se garder d'interpréter les guillemets
// trop littéralement. Ici le CSV est produit par data-fair : virgule, TOUS les
// champs texte cités, `""` pour un guillemet littéral (vérifié présent dans la
// source), et rien n'interdit un saut de ligne à l'intérieur d'une citation. Un
// découpeur ligne à ligne casserait dessus. On analyse donc le texte d'un seul
// tenant, l'état de citation traversant les fins de ligne.
//
// Le CR est ignoré HORS citation seulement (tolérance CRLF) ; à l'intérieur d'une
// citation il est de la donnée, et il est conservé.
//
// Un guillemet n'ouvre une citation que s'il est le PREMIER caractère du champ ;
// ailleurs c'est un caractère comme un autre. Une citation non refermée se clôt
// en fin de texte. PURE.
export function decouperCsvRge(texte) {
  const lignes = []
  const s = String(texte || '')
  let champ = ''
  let ligne = []
  let cite = false
  let debutChamp = true
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (cite) {
      if (c === '"') {
        if (s[i + 1] === '"') { champ += '"'; i++; continue }   // "" → guillemet littéral
        cite = false
        continue
      }
      champ += c
      continue
    }
    if (debutChamp) {
      debutChamp = false
      if (c === '"') { cite = true; continue }
    }
    if (c === ',') { ligne.push(champ); champ = ''; debutChamp = true; continue }
    if (c === '\n') { ligne.push(champ); lignes.push(ligne); ligne = []; champ = ''; debutChamp = true; continue }
    if (c === '\r') continue                                     // CRLF toléré hors citation
    champ += c
  }
  // Dernier champ : poussé seulement s'il y a matière. Un texte terminé par un
  // saut de ligne — le cas normal — ne produit donc pas de ligne vide finale.
  if (champ !== '' || ligne.length > 0) { ligne.push(champ); lignes.push(ligne) }
  return lignes
}

// Cellule → chaîne exploitable. Contrairement à Atout France, « - » n'est PAS une
// convention d'absence dans ce jeu : un simple trim suffit, et un tiret isolé
// serait de la donnée.
function valeur(s) {
  return String(s ?? '').trim()
}

// Coordonnée → nombre fini, ou undefined (~0,3 % des lignes sont sans
// coordonnées). Jamais de NaN glissé dans une colonne typée number. PURE.
function nombre(s) {
  const v = valeur(s)
  if (!v) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

// `particulier` → booléen, ou undefined. Le schéma de la source le déclare
// `boolean` ; c'est le CSV qui l'aplatit en 1/0. On accepte les deux écritures
// pour ne pas dépendre de ce détail de sérialisation. PURE.
function booleen(s) {
  const v = valeur(s).toLowerCase()
  if (v === '1' || v === 'true') return true
  if (v === '0' || v === 'false') return false
  return undefined
}

// SIRET → SIREN. Rend '' si le SIRET n'est pas fait de 14 chiffres — auquel cas
// la ligne est ignorée en amont, ce test n'étant qu'une ceinture. PURE.
export function sirenDepuisSiret(siret) {
  const v = valeur(siret)
  return /^\d{14}$/.test(v) ? v.slice(0, 9) : ''
}

// En-tête `link` → valeur du paramètre `after`, ou '' si l'en-tête est absent
// (dernière page) ou malformé.
//
// L'ABSENCE DE CET EN-TÊTE EST LE SIGNAL DE FIN, et le seul. Vérifié sur une
// requête à 353 résultats : data-fair n'émet pas de `rel="next"` quand la page
// rendue compte moins de lignes que `size`, en page unique comme en dernière
// page d'une série. On ne compte donc rien pour décider qu'on a terminé — on lit.
//
// Seul le paramètre `after` est retenu, jamais l'URL (cf. en-tête, SSRF). PURE.
export function extraireCurseur(link) {
  const v = String(link || '')
  if (!v) return ''
  // On ne retient que le membre marqué rel="next" — un en-tête `link` peut en
  // porter plusieurs, séparés par des virgules.
  for (const membre of v.split(/,\s*(?=<)/)) {
    if (!/rel\s*=\s*"?next"?/i.test(membre)) continue
    const m = membre.match(/<([^>]+)>/)
    if (!m) continue
    try {
      const after = new URL(m[1]).searchParams.get('after')
      const propre = String(after || '').trim()
      return CURSEUR_RE.test(propre) ? propre : ''
    } catch { return '' }
  }
  return ''
}

// URL d'une page. Construite ICI, à partir de BASE_URL en dur : le curseur ne
// fournit que deux entiers, jamais un hôte.
function construireUrl(curseur) {
  const u = new URL(BASE_URL)
  u.searchParams.set('format', 'csv')
  u.searchParams.set('size', String(TAILLE_PAGE))
  u.searchParams.set('sort', '_i')
  u.searchParams.set('select', COLONNES_SOURCE.join(','))
  if (curseur) u.searchParams.set('after', curseur)
  return u.toString()
}

// Lignes de CSV (en-tête comprise) → { entreprises, lignes, ignores }, où
// `lignes` compte les lignes de données lues et `ignores` celles écartées.
//
// IGNORÉE = sans `_id`, ou sans SIRET à 14 chiffres. Ce sont les deux seules
// conditions : `_id` porte l'idempotence, le SIRET porte la jointure, et une
// ligne privée de l'un ou de l'autre n'est utile à rien. Tout le reste passe —
// y compris les qualifications échues, y compris les lignes sans coordonnées,
// y compris un code postal aberrant (qui laisse seulement `departement` vide).
//
// Une ignorée n'est PAS une erreur : c'est une ligne de la source qu'on a lue et
// qu'on a décidé de ne pas garder. Les deux compteurs sont distincts dans le
// compte rendu, et le second ne compte que des échecs d'écriture. PURE.
export function analyserPage(lignesCsv, sourceMaj = '') {
  const entreprises = []
  let lignes = 0
  let ignores = 0
  if (!Array.isArray(lignesCsv) || lignesCsv.length < 1) return { entreprises, lignes, ignores }

  // Appariement par NOM d'en-tête, jamais par position : `select` rend
  // aujourd'hui les colonnes dans l'ordre demandé, mais rien ne l'engage.
  const rang = {}
  lignesCsv[0].forEach((e, i) => { rang[valeur(e)] = i })
  for (const col of COLONNES_OBLIGATOIRES) {
    if (rang[col] === undefined) {
      console.error('[rge] colonne obligatoire absente de la réponse —', col)
      return { entreprises, lignes, ignores }
    }
  }

  for (let i = 1; i < lignesCsv.length; i++) {
    const cols = lignesCsv[i]
    // Ligne vide résiduelle : ni lue, ni ignorée — elle n'existe pas.
    if (cols.length <= 1 && !valeur(cols[0])) continue
    lignes++
    const lire = (col) => (rang[col] === undefined ? '' : valeur(cols[rang[col]]))

    const cle = lire('_id')
    const siret = lire('siret')
    const siren = sirenDepuisSiret(siret)
    if (!cle || !siren) { ignores++; continue }

    const codePostal = lire('code_postal')
    // Hôte du site seulement : `site_internet` est stocké BRUT, à la différence
    // d'Atout France dont on normalise le `website` (37 % de vides ici, et deux
    // schémas d'écriture qu'on ne veut pas trancher au chargement).
    const { domaine } = normaliserSite(lire('site_internet'))

    entreprises.push({
      cle,
      siret,
      siren,
      departement: departementDepuisCp(codePostal),
      nom_entreprise: lire('nom_entreprise'),
      adresse: lire('adresse'),
      code_postal: codePostal,
      commune: lire('commune'),
      latitude: nombre(lire('latitude')),
      longitude: nombre(lire('longitude')),
      telephone: lire('telephone'),
      email: lire('email'),
      site_internet: lire('site_internet'),
      domaine_web: domaine,
      code_qualification: lire('code_qualification'),
      nom_qualification: lire('nom_qualification'),
      url_qualification: lire('url_qualification'),
      nom_certificat: lire('nom_certificat'),
      // Colonne source `domaine` → champ `domaine_travaux`. Le renommage est
      // documenté en tête de referentiel-rge.js : il évite une collision de sens
      // avec le `domaine` de referentiel_atout_france, qui est un hôte de site.
      domaine_travaux: lire('domaine'),
      meta_domaine: lire('meta_domaine'),
      organisme: lire('organisme'),
      particulier: booleen(lire('particulier')),
      lien_date_debut: lire('lien_date_debut'),
      lien_date_fin: lire('lien_date_fin'),
      source_maj: sourceMaj
    })
  }
  return { entreprises, lignes, ignores }
}

// ---------------------------------------------------------------------------
// Écriture.
// ---------------------------------------------------------------------------

// UPSERT … SET par `_id` de la source. Le record id EST la clé : recharger réécrit
// les mêmes records, jamais des doublons (l'index UNIQUE le garantit en plus).
// Idiome type::record identique à atout-france.js et au reste du serveur.
//
// `suffixe` distingue les paramètres des instructions groupées dans un même
// aller-retour ($cle_0, $cle_1, …).
//
// cached_at : première apparition, préservée d'un rechargement à l'autre par
// l'idiome IF … = NONE. refreshed_at : date du dernier passage, réécrite chaque fois.
function construireUpsert(e, suffixe) {
  const params = { [`id${suffixe}`]: e.cle }
  const assigns = [`cle = $id${suffixe}`]
  for (const champ of ['siret', 'siren', 'departement']) {
    assigns.push(`${champ} = $${champ}${suffixe}`)
    params[`${champ}${suffixe}`] = e[champ]
  }
  for (const champ of CHAMPS_OPTIONNELS) {
    const v = e[champ]
    // `false` est une valeur, pas une absence : le test porte sur undefined /
    // null / '', jamais sur la fausseté — sans quoi `particulier = false`
    // deviendrait NONE et la moitié du champ disparaîtrait.
    if (v === undefined || v === null || v === '') { assigns.push(`${champ} = NONE`); continue }
    assigns.push(`${champ} = $${champ}${suffixe}`)
    params[`${champ}${suffixe}`] = v
  }
  const sql = `UPSERT type::record("${TABLE}", $id${suffixe}) SET
       ${assigns.join(',\n       ')},
       source = 'ademe_rge',
       cached_at = IF cached_at = NONE THEN time::now() ELSE cached_at END,
       refreshed_at = time::now()`
  return { sql, params }
}

// Écrit un lot en UN aller-retour. Si le lot échoue (le pilote rejette la requête
// entière dès qu'une instruction est en erreur), on le rejoue ligne par ligne :
// une ligne fautive coûte une ligne, pas cent. Rend { ecrits, erreurs }.
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
    console.warn('[rge] lot rejeté, reprise ligne à ligne —', String(e?.message || e).slice(0, 120))
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
      console.warn('[rge]', String(e.cle).slice(0, 60), '—', String(err?.message || err).slice(0, 100))
    }
  }
  return { ecrits, erreurs }
}

// UN GET d'une page, puis découpage CSV. Rend
// { lignesCsv, curseurSuivant, sourceMaj }, ou NULL si la page est injoignable,
// anormalement grosse ou illisible — un null se distingue d'une page à zéro
// ligne, et c'est ce qui permet plus haut de ne PAS conclure « terminé » après
// un échec réseau.
async function telechargerPage(curseur) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const r = await fetch(construireUrl(curseur), {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'Accept': 'text/csv,text/plain;q=0.9,*/*;q=0.5' }
    })
    clearTimeout(timer)
    if (!r.ok) {
      console.warn('[rge] page injoignable — HTTP', r.status)
      return null
    }
    // Licence Ouverte : la date de dernière mise à jour se cite. L'ADEME la donne
    // dans Last-Modified, concordant avec le dataUpdatedAt du jeu — c'est la date
    // de la DONNÉE, pas celle du téléchargement.
    const lm = r.headers.get('last-modified')
    const t = lm ? new Date(lm).getTime() : NaN
    const sourceMaj = Number.isFinite(t) ? new Date(t).toISOString() : ''
    const curseurSuivant = extraireCurseur(r.headers.get('link'))

    const texte = await r.text()
    if (texte.length > MAX_BYTES) {
      console.warn('[rge] page anormalement grosse —', texte.length, 'octets, chargement abandonné')
      return null
    }
    // BOM retiré : la source l'écrit (UTF-8 avec BOM), et il collerait au nom de
    // la première colonne, qui est justement `_id`.
    const lignesCsv = decouperCsvRge(texte.replace(/^﻿/, ''))
    return { lignesCsv, curseurSuivant, sourceMaj }
  } catch (e) {
    clearTimeout(timer)
    console.warn('[rge] téléchargement —', String(e?.message || e).slice(0, 120))
    return null
  }
}

// ---------------------------------------------------------------------------
// chargerRge({ pages, curseur }) — UNE TRANCHE de chargement. JAMAIS de throw :
// rend un compte rendu. `pages` borne l'appel (défaut 4, maximum 17), `curseur`
// reprend là où le précédent s'est arrêté (vide = depuis le début).
//
// COMPTE RENDU
//   pages_lues       pages effectivement téléchargées ET écrites par cet appel
//   lignes           lignes de données lues dans ces pages
//   ignores          lignes écartées faute de `_id` ou de SIRET à 14 chiffres.
//                    PAS une erreur : une ligne lue et refusée sciemment.
//                    lignes = ignores + (ecrits + erreurs)
//   ecrits           UPSERT acceptés
//   erreurs          UPSERT rejetés — la ligne est comptée et le curseur passe
//                    outre : elle n'est pas rejouée dans ce chargement-ci, un
//                    suivant la réécrira (l'UPSERT étant idempotent)
//   curseur_suivant  à repasser au prochain appel. NULL = il n'y a pas de suite,
//                    soit parce que le chargement est terminé, soit parce que
//                    rien n'a pu être lu. Les deux se distinguent par `termine`.
//   termine          true SEULEMENT si la source a cessé d'émettre un
//                    `rel="next"` — c'est-à-dire si on a lu la dernière page.
//                    Un échec réseau, une borne `pages` atteinte ou une
//                    republication détectée laissent termine à FALSE : un
//                    chargement inachevé ne doit jamais se lire comme terminé.
//   source_maj       Last-Modified de la donnée, ISO. '' si l'ADEME ne l'a pas donné.
//   duree_ms
//
// `ecrits` compte les UPSERT acceptés, pas les records distincts. Un même `_id`
// ne peut pas apparaître deux fois dans un chargement (l'index est UNIQUE et la
// pagination ne repasse pas), donc le cumul des `ecrits` d'un chargement complet
// doit égaler le count de la table — à la différence d'Atout France, où six
// couples de lignes partagent une clé. Un écart est le signe d'un `_id` instable,
// et c'est le contrôle qui vaut d'être fait après deux chargements.
//
// PAS DE VERROU MONO-APPEL, contrairement à atout-france.js. Là-bas le verrou
// protège un curseur PARTAGÉ en mémoire de module, que deux appels concurrents
// feraient avancer deux fois. Ici il n'y a rien à partager : chaque appel porte
// son curseur. Deux appels simultanés ne se corrompent pas — ils gaspillent, au
// pire, en réécrivant les mêmes lignes à l'identique.
// ---------------------------------------------------------------------------

export async function chargerRge({ pages, curseur } = {}) {
  const debut = Date.now()
  const maxPages = Math.min(PAGES_MAX, Math.max(1, Number(pages) || PAGES_DEFAUT))
  const compte = {
    pages_lues: 0, lignes: 0, ecrits: 0, ignores: 0, erreurs: 0,
    curseur_suivant: null, termine: false, source_maj: '', duree_ms: 0
  }

  let courant = String(curseur ?? '').trim()
  if (courant && !CURSEUR_RE.test(courant)) {
    // Rien n'est tenté : un curseur mal formé est une erreur d'appelant, pas une
    // panne, et repartir silencieusement de la page 1 rechargerait 162 k lignes
    // à l'insu de qui croyait reprendre.
    console.error('[rge] curseur refusé, forme attendue « <entier>,<entier> » —', courant.slice(0, 60))
    compte.duree_ms = Date.now() - debut
    return compte
  }

  try {
    const db = await getDb()
    for (let p = 0; p < maxPages; p++) {
      const page = await telechargerPage(courant)
      // Échec réseau : on s'arrête sur le dernier curseur sûr, termine reste false.
      if (!page) break

      // Republication détectée en cours d'appel : le curseur porte des valeurs de
      // tri d'un index qui n'existe plus. On s'arrête AVANT d'écrire cette page.
      if (compte.source_maj && page.sourceMaj && page.sourceMaj !== compte.source_maj) {
        console.warn(
          `[rge] source republiée en cours de chargement (${compte.source_maj} → ${page.sourceMaj})` +
          ` — arrêt à la page ${p + 1}, reprise possible sur la nouvelle édition`
        )
        break
      }
      if (!compte.source_maj) compte.source_maj = page.sourceMaj

      // Nombre de lignes REÇUES par l'analyse, en-tête comprise. C'est cette
      // mesure-là qui fonde la rupture ci-dessous, et pas les compteurs rendus :
      // quand une colonne obligatoire manque, analyserPage sort avant même sa
      // boucle et rend lignes=0 ignores=0 — un test sur `lignes` ne verrait donc
      // JAMAIS le cas qu'il vise, et les dix-sept pages défileraient sans rien
      // écrire tout en rapportant un pages_lues non nul.
      const lignesRecues = Array.isArray(page.lignesCsv) ? page.lignesCsv.length : 0
      const { entreprises, lignes, ignores } = analyserPage(page.lignesCsv, page.sourceMaj)
      // Le CSV portait des lignes de données (en-tête + au moins une), et
      // l'analyse n'en rend ni retenue ni ignorée : en-tête inattendue, ou
      // colonnes décalées. On ne va pas plus loin, les pages suivantes auront le
      // même défaut. La page n'est PAS comptée dans pages_lues et le curseur ne
      // bouge pas : l'appel rend le dernier point de reprise sûr.
      if (lignesRecues > 1 && entreprises.length === 0 && ignores === 0) {
        console.error(
          `[rge] page ${p + 1} illisible — ${lignesRecues - 1} ligne(s) reçue(s), aucune retenue ni ignorée` +
          ' (en-tête inattendue ?) — arrêt du chargement'
        )
        break
      }

      compte.pages_lues++
      compte.lignes += lignes
      compte.ignores += ignores

      // SÉQUENTIEL, lot après lot, avec une pause entre deux : movup-prod tourne
      // sur 1 Go partagé avec le trafic live, et ce chargement ne doit jamais
      // primer sur une requête d'abonné (même cadence que le backfill cle_nom).
      for (let d = 0; d < entreprises.length; d += LOT) {
        const lot = entreprises.slice(d, d + LOT)
        const { ecrits, erreurs } = await ecrireLot(db, lot)
        compte.ecrits += ecrits
        compte.erreurs += erreurs
        if (d + LOT < entreprises.length) await sleep(PAUSE_LOT_MS)
      }

      courant = page.curseurSuivant
      compte.curseur_suivant = page.curseurSuivant || null

      // Le curseur est JOURNALISÉ ici, page par page, et pas seulement rendu en
      // fin d'appel : si la réponse HTTP se perd (timeout de proxy), c'est cette
      // ligne de log qui permet de reprendre sans repartir de la page 1.
      console.log(
        `[rge] page ${compte.pages_lues}/${maxPages} — lignes=${lignes} ignorées=${ignores}` +
        ` cumul écrits=${compte.ecrits} | curseur=${page.curseurSuivant || 'FIN'}`
      )

      // Fin de jeu : data-fair cesse d'émettre `rel="next"` sur la dernière page.
      // C'est le seul signal de fin, et il est fiable (vérifié).
      if (!page.curseurSuivant) { compte.termine = true; break }
      if (p + 1 < maxPages) await sleep(PAUSE_PAGE_MS)
    }

    console.log(
      `[rge] pages=${compte.pages_lues}/${maxPages} lignes=${compte.lignes}` +
      ` écrits=${compte.ecrits} ignorées=${compte.ignores} erreurs=${compte.erreurs}` +
      ` | terminé=${compte.termine} curseur=${compte.curseur_suivant || 'aucun'}` +
      ` durée=${Date.now() - debut}ms maj=${compte.source_maj || 'inconnue'}`
    )
  } catch (e) {
    console.error('[rge]', String(e?.message || e).slice(0, 120))
  } finally {
    compte.duree_ms = Date.now() - debut
  }
  return compte
}
