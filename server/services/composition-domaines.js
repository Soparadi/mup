// Service Composition de domaines — de la fiche Etalab aux adresses à tenter.
//
// Le moteur mentions légales part aujourd'hui d'un `website` DÉJÀ EN BASE
// (maillon 1.a) et n'a plus rien à faire quand il manque. Ce module fabrique la
// matière du chemin INVERSE : la fiche est le point de départ, l'adresse est
// CHERCHÉE. Il rend des candidats `{ url, origine }` et RIEN d'autre — il ne
// visite aucun site, n'écrit aucun champ, ne pose aucun horodatage. Tout ce qui
// suit (portillon robots.txt, lecture des pages, recoupement, écriture) reste le
// fait de mentions-legales.js.
//
// PAS ENCORE BRANCHÉ. Le maillon 1.b est aujourd'hui alimenté par recherche-web.js
// et par lui seul ; ce module ne lui est pas câblé. L'`origine` est portée dès
// maintenant pour que 1.b puisse, le jour où il le sera, distinguer une adresse
// COMPOSÉE d'une adresse rapportée par une recherche — deux provenances qui ne se
// valent pas et qu'il serait fâcheux d'avoir à redéduire après coup.
//
// ─────────────────────────────────────────────────────────────────────────────
// TROIS GESTES, DANS CET ORDRE
//
// 1. COMPOSITION. Trois origines, dans l'ordre de confiance décroissante :
//    l'enseigne, la parenthèse de la raison sociale, la raison sociale nue. Chaque
//    origine donne DEUX formes quand elle compte plusieurs mots — la forme collée
//    (`atelierdupont`) puis la variante à TIRETS (`atelier-du-pont`), au second
//    rang, jamais à la place de la première. Mesuré sur le 22 · 73.11Z : la
//    variante fait gagner une piste à des fiches qui n'en avaient aucune, et n'en
//    retire à personne — elle n'est qu'un ajout.
//
// 2. UNICITÉ. Une forme composée n'est une piste que si elle DÉSIGNE quelqu'un.
//    « atelier », « studio », « creation » sont portés par des centaines de
//    sociétés : le domaine qui leur correspond n'appartient à aucune d'elles, et
//    aller le lire reviendrait à imputer à une fiche le contenu d'une autre. Le
//    filtre écarte donc les bases portées par plus de SEUIL_UNICITE SIREN
//    distincts dans le référentiel entier, plus deux règles de forme (moins de
//    BASE_MIN caractères, ou tout en chiffres : ni l'une ni l'autre ne nomme une
//    société, elles n'apportent que du bruit).
//
//    LA CLAUSE D'EXEMPTION. Un domaine déjà inscrit comme `website` de l'UN des
//    porteurs de la base est retenu quel que soit le nombre de porteurs. Sept
//    sociétés d'un même réseau qui partagent une signature ET un domaine forment
//    une FAMILLE, pas un générique : le domaine leur est commun, le lire n'impute
//    rien à personne. Vérifié sur le référentiel : la clause ne rattrape aucun des
//    vrais génériques (« studio », « atelier », « salon », « france » restent
//    écartés, aucun d'eux n'étant le site déclaré d'un de ses porteurs).
//
// 3. RÉSOLUTION. Une forme qui ne résout pas n'est pas une adresse. Le geste est
//    DNS SEUL : aucune requête HTTP, aucun octet demandé au site, rien qui
//    ressemble à une visite. Il divise par dix le nombre d'adresses présentées au
//    maillon suivant, donc autant de passages dans la file polie du sortant.
//
// ─────────────────────────────────────────────────────────────────────────────
// L'INDEX D'UNICITÉ EST EN MÉMOIRE, ET CONSTRUIT UNE FOIS PAR LOT.
//
// Il n'y a pas moyen de poser la question à la base : `cle_nom` est une AUTRE
// normalisation (celle du rapprochement OSM), la forme composée n'est pas
// `cle_nom`, et aucun index ne porte sur elle. Compter les porteurs d'une base
// suppose donc de recomposer tout le référentiel — ce que fait chargerIndexUnicite,
// département par département (idx_ref_dept), en n'accumulant que les compteurs.
// L'instance est petite : on ne lui demande AUCUN agrégat, seulement des tranches
// indexées qu'elle sait rendre, et le comptage se fait ici.
//
// Un index qui n'a pas pu être chargé n'est PAS un index permissif : sans lui le
// geste 2 ne peut pas se faire, et composerPistes ne rend rien plutôt que de
// rendre des génériques.
//
// ─────────────────────────────────────────────────────────────────────────────
// CE QUI N'EST PAS ICI
//
//   • Le PLAFOND du nombre d'adresses tentées par fiche : il appartient à
//     l'appelant, qui seul connaît son budget de sortant (MAX_CANDIDATS, côté
//     mentions-legales.js). Le module rend tout ce qu'il a trouvé, dans l'ordre.
//   • L'origine « base + mot de métier » — le cas ECO PUBLICITE / CADOE, dont le
//     domaine (cadoe-pub) n'est ni l'enseigne, ni une parenthèse, ni la raison
//     sociale, mais l'une d'elles suffixée d'un mot de métier. Aucune des trois
//     origines ne l'atteint. Connu, non traité.
//   • Toute écriture, tout horodatage, toute lecture de page.

import { Resolver } from 'node:dns/promises'
import { getDb } from '../../lib/surreal.js'
import { normaliserDomaine } from './rapprochement-osm.js'

// Extensions tentées, dans cet ordre : le .fr d'abord — le référentiel est
// français et l'entreprise qui n'a qu'un domaine l'a le plus souvent en .fr.
export const EXTENSIONS = ['fr', 'com']

// Bornes de la composition. FORME_MIN écarte les sigles de deux lettres, dont le
// domaine correspondant n'a aucune chance d'être celui de la société ; FORME_MAX
// est la limite d'un label DNS (RFC 1035), au-delà la forme n'est même pas un nom.
const FORME_MIN = 3
const FORME_MAX = 63

// Bornes du geste 2. BASE_MIN vaut cinq et non trois : entre les deux se logent
// les sigles (« pms », « ams », « efe ») dont le domaine appartient toujours à
// quelqu'un d'autre. Le seuil d'unicité vaut DEUX — une base portée par une ou
// deux sociétés nomme encore, au-delà elle catégorise.
const BASE_MIN = 5
export const SEUIL_UNICITE = 2

// Bornes du geste 3. Les résolveurs sont ÉPINGLÉS sur deux résolveurs publics :
// celui du fournisseur d'accès détourne fréquemment NXDOMAIN vers une page de
// parking, ce qui ferait résoudre absolument tout et viderait le geste de son sens.
const RESOLVEURS = ['1.1.1.1', '8.8.8.8']
const DNS_TIMEOUT_MS = 4000
const DNS_TRIES = 2
const LARGEUR_DNS = 16          // requêtes DNS simultanées (cf. politesse, plus bas)
const CACHE_DNS_MAX = 5000      // plafond d'entrées, éviction de la plus ancienne

// ---------------------------------------------------------------------------
// Normalisation. Reprise à l'identique de l'essai qui a servi à mesurer les trois
// gestes : changer un détail ici invalide la mesure du seuil, qui a été faite avec
// CES formes-là.
// ---------------------------------------------------------------------------

const str = (v) => typeof v === 'string' ? v.trim() : ''
const rempli = (v) => str(v) !== ''
const sansAccents = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')

// Les articles de tête sont retirés : « LE STUDIO » et « STUDIO » composent le
// même domaine, et c'est bien la même maison. Jamais le dernier mot, sous peine
// de vider une raison sociale qui n'est qu'un article.
const ARTICLES = new Set(['le', 'la', 'les', 'l'])

function mots(s) {
  let m = sansAccents(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  m = m ? m.split(/\s+/) : []
  while (m.length > 1 && ARTICLES.has(m[0])) m = m.slice(1)
  return m
}

const colle = (m) => m.join('')
const tirets = (m) => m.join('-')
const cle = (s) => mots(s).join(' ')
const horsParentheses = (s) => String(s || '').replace(/\([^)]*\)/g, ' ')
const parentheses = (s) => [...String(s || '').matchAll(/\(([^)]*)\)/g)].map(m => m[1])

// Les formes sous lesquelles le nom du dirigeant peut apparaître dans la raison
// sociale : le champ tel quel, sa part hors parenthèses, et chaque parenthèse.
function formesDirigeant(nom) {
  const out = new Set()
  if (!rempli(nom)) return out
  const ajoute = (v) => { const k = cle(v); if (k) out.add(k) }
  ajoute(nom); ajoute(horsParentheses(nom))
  for (const p of parentheses(nom)) ajoute(p)
  return out
}

// ---------------------------------------------------------------------------
// estPatronyme(fiche) — la raison sociale est le nom d'une personne.
//
// « DUPONT MARIE » dirigée par Marie Dupont ne compose pas un domaine : elle
// compose le nom de famille de quelqu'un, et `dupont.fr` appartient à un
// homonyme. La fiche est écartée ENTIÈREMENT, pas seulement son origine « raison
// sociale » : la présence du patronyme signale une structure qui n'a pas de nom
// commercial, et l'enseigne, quand elle existe, le répète.
//
// Le test est volontairement large (au moins deux mots, et le PRÉNOM du dirigeant
// parmi eux) : ce qu'il coûte, c'est quelques fiches non tentées ; ce qu'il évite,
// c'est d'aller lire le site d'un particulier qui n'a rien demandé.
// ---------------------------------------------------------------------------

export function estPatronyme(fiche) {
  if (!fiche) return false
  const k = cle(horsParentheses(fiche.raison_sociale))
  const m = k ? k.split(' ') : []
  if (m.length < 2) return false
  for (const d of formesDirigeant(fiche.dirigeant_nom)) {
    if (d && m.includes(d.split(' ')[0])) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// GESTE 1 — originesComposees(fiche)
//
// Rend `[{ forme, base, origine, variante }]` dans l'ordre à tenter :
//   • forme    — le label DNS, sans extension (« atelier-du-pont »)
//   • base     — la forme COLLÉE de la même origine (« atelierdupont »). C'est
//                elle, et jamais la forme, que le geste 2 interroge : la variante
//                à tirets ne change pas qui porte le nom.
//   • origine  — 'enseigne' | 'parenthèse' | 'raison sociale'
//   • variante — 'collée' | 'tirets'
//
// Deux parenthèses sont écartées : celle qui répète le nom du dirigeant (c'est le
// patronyme, pas une marque) et celle qui répète la raison sociale hors
// parenthèses (elle ne compose rien de nouveau).
//
// Le dédoublonnage porte sur la FORME et traverse les origines : une enseigne
// identique à la raison sociale ne produit qu'un candidat, et il porte l'origine
// la plus fiable des deux puisqu'elle est poussée la première.
// ---------------------------------------------------------------------------

export function originesComposees(fiche) {
  const out = []
  const vus = new Set()

  const pousse = (m, origine) => {
    if (!m.length) return
    const base = colle(m)
    // La variante à tirets n'a de sens qu'à partir de deux mots : sur un mot
    // unique elle est la forme collée, et le dédoublonnage l'écarterait de toute
    // façon — autant ne pas la fabriquer.
    const formes = m.length > 1
      ? [[base, 'collée'], [tirets(m), 'tirets']]
      : [[base, 'collée']]
    for (const [forme, variante] of formes) {
      if (!forme || forme.length < FORME_MIN || forme.length > FORME_MAX) continue
      if (vus.has(forme)) continue
      vus.add(forme)
      out.push({ forme, base, origine, variante })
    }
  }

  const rs = String(fiche?.raison_sociale || '')
  const motsHors = mots(horsParentheses(rs))
  const cleHors = motsHors.join(' ')
  const formesDir = formesDirigeant(fiche?.dirigeant_nom)

  if (rempli(fiche?.enseigne)) pousse(mots(fiche.enseigne), 'enseigne')
  for (const p of parentheses(rs)) {
    const k = cle(p)
    if (!k || formesDir.has(k) || k === cleHors) continue
    pousse(mots(p), 'parenthèse')
  }
  pousse(motsHors, 'raison sociale')

  return out
}

// ---------------------------------------------------------------------------
// L'INDEX D'UNICITÉ
//
// Deux tables par base normalisée :
//   • les SIREN qui la composent — le compteur du seuil ;
//   • les domaines des `website` de ces mêmes SIREN — la matière de l'exemption.
//
// Le SIREN, pas le SIRET : une société à douze établissements ne porte son nom
// qu'une fois, sans quoi le seuil serait franchi par des succursales.
//
// L'index est construit sur TOUTES les fiches, patronymes compris. Le seuil compte
// qui porte un nom, et un patronyme le porte comme un autre : l'écarter ferait
// passer pour unique une base que trois homonymes se disputent.
// ---------------------------------------------------------------------------

function nouvelIndex() {
  const porteurs = new Map()   // base → Set(siren)
  const sites = new Map()      // base → Set(domaine normalisé)
  let lignes = 0

  const ajouter = (ligne) => {
    const siren = str(ligne?.siren)
    if (!siren) return
    lignes++
    const domaine = rempli(ligne?.website) ? normaliserDomaine(ligne.website) : ''
    // Un Set : les deux variantes d'une même origine partagent leur base, et deux
    // origines peuvent la partager aussi. Un SIREN ne doit compter qu'une fois.
    const bases = new Set(originesComposees(ligne).map(o => o.base))
    for (const b of bases) {
      let p = porteurs.get(b)
      if (!p) { p = new Set(); porteurs.set(b, p) }
      p.add(siren)
      if (domaine) {
        let s = sites.get(b)
        if (!s) { s = new Set(); sites.set(b, s) }
        s.add(domaine)
      }
    }
  }

  const figer = () => ({
    lignes,
    bases: porteurs.size,
    // Nombre de SIREN distincts qui composent cette base.
    compte: (base) => porteurs.get(base)?.size || 0,
    // Le domaine est-il déjà le site déclaré de l'un des porteurs de la base ?
    connuDeLaFamille: (base, domaine) => porteurs.has(base) && (sites.get(base)?.has(domaine) || false)
  })

  return { ajouter, figer }
}

// indexerUnicite(lignes) — index à partir de lignes déjà en main. Exportée pour
// que l'appelant qui a lu le référentiel pour son compte n'ait pas à le relire.
export function indexerUnicite(lignes) {
  const idx = nouvelIndex()
  for (const l of (Array.isArray(lignes) ? lignes : [])) idx.ajouter(l)
  return idx.figer()
}

// ---------------------------------------------------------------------------
// chargerIndexUnicite() — balayage du référentiel entier, département par
// département. Rend l'index, ou NULL si la lecture a échoué (fail-safe : aucun
// throw remontant, et un null que l'appelant doit traiter comme un refus de
// composer, jamais comme une absence de filtre).
//
// Le balayage est SÉQUENTIEL et par tranche indexée : aucun agrégat n'est demandé
// à l'instance en dehors du dénombrement par département, qui est le seul moyen de
// connaître la liste des tranches. Les lignes ne sont pas accumulées — chacune est
// indexée puis relâchée.
// ---------------------------------------------------------------------------

export async function chargerIndexUnicite() {
  try {
    const db = await getDb()
    const r = await db.query('SELECT departement, count() AS n FROM referentiel_societes GROUP BY departement')
    const depts = (r[0] || []).map(x => str(x?.departement)).filter(Boolean).sort()
    if (!depts.length) return null

    const idx = nouvelIndex()
    for (const d of depts) {
      const q = await db.query(
        'SELECT siren, raison_sociale, enseigne, dirigeant_nom, website ' +
        'FROM referentiel_societes WITH INDEX idx_ref_dept WHERE departement = $d',
        { d }
      )
      for (const ligne of (q[0] || [])) idx.ajouter(ligne)
    }
    const index = idx.figer()
    console.log(`[composition-domaines] index d'unicité : ${index.lignes} lignes, ${index.bases} bases, ${depts.length} départements`)
    return index
  } catch (e) {
    console.warn('[composition-domaines]', String(e?.message || e).slice(0, 100))
    return null
  }
}

// ---------------------------------------------------------------------------
// GESTE 2 — passeUnicite(base, domaine, index, seuil)
//
// Le domaine COMPLET est nécessaire, et pas seulement la base : l'exemption
// compare ce qui est inscrit en base (« mediapilote.com »), donc l'extension
// compte. `mediapilote.fr` n'est le site déclaré de personne et reste écarté quand
// `mediapilote.com` passe — c'est exactement ce qu'on veut dire.
// ---------------------------------------------------------------------------

export function passeUnicite(base, domaine, index, seuil = SEUIL_UNICITE) {
  const b = str(base)
  if (!b || b.length < BASE_MIN) return false
  if (/^[0-9]+$/.test(b)) return false
  if (!index) return false                       // pas d'index : pas de composition
  if (index.compte(b) <= seuil) return true
  return index.connuDeLaFamille(b, str(domaine))
}

// ---------------------------------------------------------------------------
// GESTE 3 — résolution DNS
//
// resoudre(domaine) rend true si le nom a au moins une adresse, A ou AAAA. Jamais
// de throw : NXDOMAIN et ENOTFOUND valent « non », ENODATA sur A fait essayer
// AAAA, le reste (timeout, SERVFAIL) vaut « non » aussi — se tromper par excès de
// prudence ne coûte qu'une piste non tentée.
//
// POLITESSE. Ces requêtes ne touchent PAS le site : elles vont aux deux résolveurs
// publics épinglés, qui sont dimensionnés pour. Elles ne passent donc pas par la
// file mono-verrou du sortant HTTP (mentions-legales.js), qui protège les hôtes
// tiers d'une rafale — il n'y a ici aucun hôte tiers à protéger.
// ---------------------------------------------------------------------------

const resolveur = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: DNS_TRIES })
resolveur.setServers(RESOLVEURS)

// Cache des verdicts, plafonné, éviction de la plus ancienne entrée (Map = ordre
// d'insertion). La promesse est mise en cache, pas le booléen : deux fiches qui
// composent le même domaine dans le même lot ne le demandent qu'une fois.
const cacheDns = new Map()

export async function resoudre(domaine) {
  const d = str(domaine).toLowerCase()
  if (!d) return false
  const vu = cacheDns.get(d)
  if (vu) return vu

  const p = (async () => {
    for (const methode of ['resolve4', 'resolve6']) {
      try {
        const a = await resolveur[methode](d)
        if (Array.isArray(a) && a.length) return true
      } catch (e) {
        const c = String(e?.code || '')
        if (c === 'ENOTFOUND' || c === 'NXDOMAIN') return false
        if (c === 'ENODATA') continue          // pas d'A, il reste peut-être un AAAA
      }
    }
    return false
  })()

  if (cacheDns.size >= CACHE_DNS_MAX) {
    const plusAncien = cacheDns.keys().next().value
    if (plusAncien !== undefined) cacheDns.delete(plusAncien)
  }
  cacheDns.set(d, p)
  return p
}

// Exécution à largeur bornée, ordre du tableau préservé.
async function enParallele(taches, largeur = LARGEUR_DNS) {
  const out = new Array(taches.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(largeur, taches.length) }, async () => {
    while (i < taches.length) { const n = i++; out[n] = await taches[n]() }
  }))
  return out
}

// ---------------------------------------------------------------------------
// composerPistes(fiche, index) — les trois gestes sur une fiche.
//
// Rend `[{ url, origine }]`, dans l'ordre à tenter : enseigne avant parenthèse
// avant raison sociale, forme collée avant variante à tirets, .fr avant .com.
//
// `url` EST UN DOMAINE NU, sans schéma, et c'est voulu : normalizeUrl y ajoutera
// https, et analyserSite ne s'autorise le repli sur http QUE si c'est nous qui
// avons ajouté le schéma. Écrire « https://… » ici priverait de ce repli les sites
// qui ne répondent qu'en clair — une part non négligeable de ce référentiel.
//
// Rend [] sans rien demander au réseau quand la fiche est un patronyme, quand elle
// ne compose rien, ou quand l'index manque.
// ---------------------------------------------------------------------------

export async function composerPistes(fiche, index) {
  if (!fiche || !index) return []
  if (estPatronyme(fiche)) return []

  const candidats = []
  for (const o of originesComposees(fiche)) {
    for (const ext of EXTENSIONS) {
      const domaine = `${o.forme}.${ext}`
      if (!passeUnicite(o.base, domaine, index)) continue
      candidats.push({ domaine, origine: o.origine })
    }
  }
  if (!candidats.length) return []

  const verdicts = await enParallele(candidats.map(c => () => resoudre(c.domaine)))
  return candidats
    .filter((_, i) => verdicts[i] === true)
    .map(c => ({ url: c.domaine, origine: c.origine }))
}

// ---------------------------------------------------------------------------
// composerPistesLot(fiches) — un lot, UN SEUL index.
//
// Rend une Map SIRET → `[{ url, origine }]`. L'index coûte un balayage du
// référentiel : il se charge une fois pour le lot, jamais par fiche. Une fiche
// sans SIRET est ignorée ; un index illisible rend un lot vide et le dit.
// ---------------------------------------------------------------------------

export async function composerPistesLot(fiches) {
  const out = new Map()
  const liste = (Array.isArray(fiches) ? fiches : []).filter(Boolean)
  if (!liste.length) return out

  const index = await chargerIndexUnicite()
  if (!index) {
    console.warn('[composition-domaines] index d\'unicité indisponible — aucune piste composée')
    return out
  }

  for (const f of liste) {
    const siret = str(f.siret).replace(/\s+/g, '')
    if (!siret) continue
    out.set(siret, await composerPistes(f, index))
  }
  return out
}
