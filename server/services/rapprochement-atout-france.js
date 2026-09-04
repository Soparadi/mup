// Rapprochement Atout France ↔ référentiel sociétés — moteur SEUL (aucun
// importeur, aucune route, aucun cron).
//
// La table referentiel_atout_france (21 360 hébergements classés, chargée par
// atout-france.js) porte un `website` pour 99,1 % de ses lignes. Les fiches
// referentiel_societes des trois NAF d'hébergement (55.10Z hôtels, 55.20Z
// hébergements touristiques de courte durée, 55.30Z terrains de camping) n'en
// ont, elles, presque jamais. Ce module rapproche les deux tables sur l'ADRESSE
// et le NOM, et n'écrit qu'un seul champ : `website`.
//
// LECTURE SEULE de referentiel_atout_france : JAMAIS d'écriture dans cette
// table. La seule écriture est l'enrichissement additif de referentiel_societes,
// par enrichReferentielActionnable et par elle seule (garde d'opposition,
// remplissage-si-vide, no-throw : tout est déjà là, rien n'est réécrit ici).
//
// BRANCHÉ dans /api/amorce (server.js), deuxième maillon de la chaîne différée :
// derrière le rapprochement OSM, devant le crawl mentions légales. L'appel y est
// GARDÉ SUR LE NAF CHERCHÉ, la table ne portant que de l'hébergement classé (voir
// NAFS_HEBERGEMENT ci-dessous). Ni cron, ni route propre. Reste pilotable à la
// main, département par département, et le mode À BLANC reste le défaut.
//
// ---------------------------------------------------------------------------
// LES TROIS TIERS ÉCRIVABLES — ce que la mesure à blanc sur les 134 fiches
// 55.30Z a arbitré, et que ce module ne fait qu'appliquer.
//
//   A    CP + voie + numéro concordants   ET nom concordant
//   A2   CP + voie + numéro concordants   ET aucune aiguille de nom disponible
//        côté fiche société
//   B    CP + voie concordants            ET nom concordant
//
// ON N'ÉCRIT PAS, et on ne marque rien comme épuisé :
//   · CP + voie concordants avec nom DISCORDANT — le nom CONTREDIT l'adresse ;
//   · CP + voie concordants sans numéro et sans aucune aiguille de nom — rien
//     ne confirme, l'adresse seule ne suffit pas sans le numéro ;
//   · CP seul concordant, avec ou sans nom ;
//   · aucun candidat au même code postal.
//
// LA DISTINCTION QUI PORTE TOUT LE MODULE : un nom ABSENT n'est pas un nom
// CONTRADICTOIRE. A2 existe parce que les six cas mesurés étaient des sociétés
// d'exploitation à enseigne vide — l'adresse exacte y est le seul signal
// disponible, et rien ne la contredit. Là où une aiguille de nom EXISTE et ne
// concorde pas, elle contredit : on s'abstient.
//
// D'OÙ L'ASYMÉTRIE DES AIGUILLES DE NOM : la CONCORDANCE se cherche sur QUATRE
// aiguilles, la CONTRADICTION ne se prononce que sur TROIS. Le corps de la
// raison sociale, hors parenthèses, confirme quand il concorde — « CAMPING DES
// HAUTES GRÉES » désigne bien l'hébergement, et c'est l'aiguille la plus
// productive de la mesure — mais il ne contredit JAMAIS : « SCI DES QUATRE
// VENTS » n'infirme pas « Camping du Lac ». Le détail est au-dessus
// d'aiguillesNom ; sans cette asymétrie, les six cas A2 basculeraient en
// discordants et le corps de la raison sociale ne rapporterait rien.
//
// DEUX REFUS s'appliquent ENSUITE, aux trois tiers indistinctement :
//   · DOMAINE MUTUALISÉ — un domaine porté par au moins deux établissements
//     distincts de referentiel_atout_france (chaîne, plateforme de réservation,
//     office de tourisme) ne désigne pas CET établissement : on ne l'écrit pas.
//     La règle se CALCULE sur la table, elle ne s'écrit pas à la main.
//   · AMBIGUÏTÉ — plusieurs candidats atteignent le même meilleur niveau avec
//     des sites différents : on s'abstient, comme le fait déjà sonderAdresse.
//
// ---------------------------------------------------------------------------
// CE QUI EST RÉUTILISÉ TEL QUEL, sans variante ni assouplissement :
//   parserAdresseAgregee, normaliserVoie, normaliserSociete, comparerNumero
//   (lib/societes.js), normaliserDomaine (rapprochement-osm.js),
//   enrichReferentielActionnable (referentiel.js).
// La comparaison de voie est l'ÉGALITÉ STRICTE des clés canoniques — celle que
// la mesure a chiffrée. Elle n'est pas assouplie ici.
//
// ---------------------------------------------------------------------------
// LE COMPTE RENDU SE BOUCLE, et c'est ce qui le rend lisible :
//
//   fiches = sans_candidat
//          + non_tranche_cp_seul
//          + non_tranche_nom_discordant
//          + non_tranche_voie_sans_nom
//          + a + a2 + b
//
//   ecrits = a + a2 + b
//          - refuses_ambiguite - refuses_sans_site - refuses_domaine_mutualise
//          (en mode à blanc : ecrits = 0, et appariements.length tient ce rôle)
//
// a, a2 et b comptent des CLASSEMENTS, pas des écritures : une fiche classée A
// puis refusée pour domaine mutualisé reste comptée en `a`. Sans quoi la somme
// ne fermerait plus et un refus se lirait comme un non-classement.
// ---------------------------------------------------------------------------

import { getDb } from '../../lib/surreal.js'
import { normaliserSociete, normaliserVoie, comparerNumero, parserAdresseAgregee } from '../../lib/societes.js'
import { normaliserDomaine } from './rapprochement-osm.js'
import { enrichReferentielActionnable } from './referentiel.js'

// Coercition string sûre (calque rapprochement-osm.js / referentiel.js).
const str = v => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()))

// Les trois NAF d'hébergement, au format NN.NNL de referentiel_societes — ceux-là
// mêmes que nafDepuisTypologie (atout-france.js) déduit des typologies du fichier.
// EXPORTÉ : la garde NAF de /api/amorce s'appuie sur CETTE liste, jamais sur une
// copie. Deux listes divergentes laisseraient passer un NAF que le module ne
// sélectionne pas, ou en écarteraient un qu'il traite.
export const NAFS_HEBERGEMENT = ['55.10Z', '55.20Z', '55.30Z']

// ---------------------------------------------------------------------------
// DOMAINES MUTUALISÉS — table calculée sur l'ENSEMBLE NATIONAL, une fois par
// processus, en cache module (patron _idxByDept de rapprochement-osm.js).
//
// Un domaine est MUTUALISÉ dès qu'il est porté par ≥ 2 établissements DISTINCTS.
// « Distinct » se lit sur la clé naturelle `cle`, pas sur le nombre de lignes :
// le fichier porte 6 couples de lignes fondus par l'UPSERT, et deux lignes de
// même clé sont un seul établissement.
//
// AGRÉGATION EN JS, PAS EN BASE : movup-prod tourne sur 1 Go partagé avec le
// trafic live et n'encaisse pas les agrégats lourds. On tire deux colonnes
// courtes sur 21 k lignes (~1 Mo) et on compte en mémoire — c'est le même geste
// que « charger la tranche et indexer » du rapprochement OSM.
//
// ÉCHEC = NULL, JAMAIS UN ENSEMBLE VIDE. Un Set vide se lirait « aucun domaine
// mutualisé » et ouvrirait l'écriture de tous les domaines de chaîne. La passe
// entière s'interrompt plutôt que d'écrire sans cette table. Un null n'est pas
// mis en cache : l'appel suivant réessaie.
// ---------------------------------------------------------------------------
let _domainesMutualises = null   // Promise<Set<string>|null> mémorisée

// Clé domaine d'une ligne Atout France. `domaine` est posé au chargement
// (normaliserSite, atout-france.js) ; le repli par normaliserDomaine couvre une
// ligne ancienne ou partielle où seul `website` serait rempli. La MÊME
// expression sert à construire la table et à l'interroger — jamais deux formes.
function cleDomaine(af) {
  return str(af?.domaine).toLowerCase() || normaliserDomaine(af?.website)
}

async function calculerDomainesMutualises() {
  try {
    const db = await getDb()
    const r = await db.query('SELECT cle, domaine, website FROM referentiel_atout_france')
    const rows = r[0] || []
    if (!rows.length) {
      console.warn('[rapprochement-atout-france] table Atout France vide — table des domaines mutualisés inexploitable')
      return null
    }
    // domaine → Set des clés naturelles qui le portent. Le Set (et non un
    // compteur) est ce qui distingue « 2 établissements » de « 2 lignes ».
    const parDomaine = new Map()
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const d = cleDomaine(row)
      if (!d) continue
      const cle = str(row.cle)
      if (!cle) continue
      const s = parDomaine.get(d)
      if (s) s.add(cle)
      else parDomaine.set(d, new Set([cle]))
    }
    const mutualises = new Set()
    for (const [d, cles] of parDomaine) if (cles.size >= 2) mutualises.add(d)
    console.log(
      `[rapprochement-atout-france] domaines : ${parDomaine.size} distincts sur ${rows.length} lignes · ` +
      `${mutualises.size} mutualisés (≥ 2 établissements)`
    )
    return mutualises
  } catch (e) {
    console.warn('[rapprochement-atout-france]', String(e?.message || e).slice(0, 100))
    return null
  }
}

export async function chargerDomainesMutualises() {
  if (_domainesMutualises) return _domainesMutualises
  const promise = calculerDomainesMutualises()
  _domainesMutualises = promise
  const set = await promise
  if (!set) _domainesMutualises = null   // échec : pas de mise en cache, on réessaiera
  return set
}

// ---------------------------------------------------------------------------
// AIGUILLES DE NOM — le point du module où une erreur écrirait des sites sur les
// mauvaises fiches. Elles ne forment pas UN jeu mais DEUX, et cette asymétrie
// est délibérée :
//
//   · la CONCORDANCE se cherche sur les QUATRE aiguilles ci-dessous ;
//   · la CONTRADICTION ne se prononce que sur les TROIS PREMIÈRES.
//
// Du côté referentiel_societes :
//   1. `enseigne`        — le nom sous lequel l'établissement s'affiche. C'est
//      enseignes[0] (referentiel.js:445) : tester `enseigne` couvre donc le cas
//      « liste vide ». Les rangs suivants de `enseignes` ne sont PAS consultés,
//      la mesure ne les ayant pas consultés non plus ; les ignorer ne peut que
//      faire MANQUER une concordance, jamais en inventer une.
//   2. `nom_commercial`  — l'autre nom d'usage servi par Etalab.
//   3. le contenu des PARENTHÈSES de `raison_sociale` — « SARL MARTIN (HOTEL DU
//      PORT) » : la dénomination y loge l'enseigne, et c'est une aiguille.
//   4. le CORPS de `raison_sociale`, HORS PARENTHÈSES — CONFIRME SEULEMENT.
//
// POURQUOI LA QUATRIÈME CONFIRME. Beaucoup d'exploitants se dénomment du nom de
// leur hébergement : « CAMPING DES HAUTES GRÉES » désigne bien l'établissement
// classé du même nom. C'était l'aiguille la plus productive de la mesure — 15
// concordances strictes et 34 par inclusion, contre 13 et 22 pour l'enseigne.
// L'ignorer revenait à jeter la moitié du rendement du module.
//
// POURQUOI ELLE NE CONTREDIT JAMAIS. « SCI DES QUATRE VENTS » qui exploite
// « Camping du Lac » n'infirme rien : une société d'exploitation ne porte pas le
// nom de son hébergement, et son silence n'est pas un démenti. La compter parmi
// les contradictrices rendrait DISCORDANTS les six cas que la mesure a classés
// A2 — ceux-là mêmes, à enseigne vide, dont A2 tient sa raison d'être.
//
// Une valeur qui se normalise en chaîne vide (« SARL » seul) n'est pas une
// aiguille : elle ne confirme ni ne contredit. PURE.
//
// Rend { contradictrices, toutes } : `toutes` est `contradictrices` augmenté du
// corps de la raison sociale. Deux listes, jamais deux formes concurrentes.
// ---------------------------------------------------------------------------
export function aiguillesNom(soc) {
  const pousser = (liste, v) => {
    const k = normaliserSociete(str(v))
    if (k && !liste.includes(k)) liste.push(k)
  }
  const contradictrices = []
  pousser(contradictrices, soc?.enseigne)
  pousser(contradictrices, soc?.nom_commercial)
  const rs = str(soc?.raison_sociale)
  for (const m of rs.matchAll(/\(([^)]*)\)/g)) pousser(contradictrices, m[1])
  // Le corps, parenthèses RETIRÉES : sans ce retrait, « CAMPING DE LA PLAGE
  // (CAMPING DU PORT) » se normaliserait en un seul bloc mêlant les deux noms.
  const toutes = contradictrices.slice()
  pousser(toutes, rs.replace(/\([^)]*\)/g, ' '))
  return { contradictrices, toutes }
}

// LONGUEUR MINIMALE de l'aiguille testée par inclusion — 4, comme l'appelant
// existant de presentNorm (mentions-legales.js:639). En deçà, un fragment
// (« lac », « mer ») collisionne avec trop de noms pour rien prouver.
const LONGUEUR_MIN_INCLUSION = 4

// Inclusion d'une clé normalisée dans une autre. C'est le geste EXACT de
// presentNorm (mentions-legales.js:575), recopié ici parce que cette fonction
// n'est pas exportée et que mentions-legales.js est hors périmètre.
function inclutCle(corpus, aiguille) {
  return aiguille.length >= LONGUEUR_MIN_INCLUSION && corpus.includes(aiguille)
}

// Une aiguille CONFIRME si elle égale la clé Atout France, ou si l'une s'inclut
// dans l'autre. LES DEUX SENS sont testés — la mesure ayant compté les deux :
// « CAMPING DES HAUTES GRÉES » côté Atout France contre « CAMPING DES HAUTES
// GRÉES SARL » côté société, et l'inverse. L'égalité reste testée à part : elle
// vaut à toute longueur, là où l'inclusion s'arrête à 4 caractères.
//
// REND LE MODE, PAS UN BOOLÉEN — '' quand rien ne concorde, sinon laquelle des
// trois formes a joué. La chaîne vide est falsy et les trois autres truthy : les
// tests restent des tests, et le MÊME geste qui décide est celui qui rapporte.
// Sans ça, la traçabilité du mode à blanc serait un second calcul, libre de
// diverger de celui-ci le jour où l'un des deux bougerait. PURE.
function modeConcordance(cleAf, aiguille) {
  if (aiguille === cleAf) return 'egalite'
  // inclutCle(corpus, aiguille) : l'aiguille est CONTENUE dans le corpus. Les
  // deux appels ci-dessous se lisent donc dans ce sens-là, pas dans l'autre.
  if (inclutCle(cleAf, aiguille)) return 'inclusion_aiguille_dans_af'
  if (inclutCle(aiguille, cleAf)) return 'inclusion_af_dans_aiguille'
  return ''
}

// Verdict de nom d'un candidat Atout France face aux aiguilles d'une fiche :
//   'concordant'  UNE DES QUATRE aiguilles confirme (A, B)
//   'discordant'  aucune ne confirme, et au moins une des TROIS contradictrices
//                 existe → elles CONTREDISENT
//   'absent'      aucune ne confirme et aucune contradictrice n'existe → rien ne
//                 confirme, rien ne contredit (A2 reste ouvert)
//
// L'INCLUSION NE SERT QU'À CONFIRMER. Une aiguille qui ne s'inclut pas ne prouve
// rien de plus qu'une aiguille qui n'est pas égale : la contradiction reste ce
// qu'elle a toujours été, l'absence de toute concordance parmi les trois
// aiguilles contradictrices.
//
// Un nom Atout France qui se normalise en chaîne vide (cas de théorie : la
// colonne NOM COMMERCIAL est obligatoire au chargement) ne confirme rien — il
// n'ouvre donc aucune écriture là où une contradictrice existe.
//
// detailNom PRONONCE, verdictNom n'en garde que le verdict. UNE SEULE fonction
// décide ; le mode à blanc lit ce qu'elle a décidé, il ne le redécide pas.
// Rend { verdict, aiguille_confirmante, mode_concordance } : les deux derniers
// champs sont la chaîne vide dès que le verdict n'est pas 'concordant' —
// 'discordant' comme 'absent' se prononcent en l'absence de toute aiguille
// confirmante, il n'y a donc rien à nommer. PURE.
export function detailNom(af, aiguilles) {
  const cleAf = normaliserSociete(str(af?.nom))
  if (cleAf) {
    for (const k of (aiguilles?.toutes || [])) {
      const mode = modeConcordance(cleAf, k)
      if (mode) return { verdict: 'concordant', aiguille_confirmante: k, mode_concordance: mode }
    }
  }
  const verdict = (aiguilles?.contradictrices || []).length ? 'discordant' : 'absent'
  return { verdict, aiguille_confirmante: '', mode_concordance: '' }
}

// La forme qu'attend la boucle, inchangée : un verdict, rien d'autre. Elle reste
// la seule chose dont l'entonnoir a besoin, et aucun de ses appelants n'a à
// connaître la traçabilité. PURE.
export function verdictNom(af, aiguilles) {
  return detailNom(af, aiguilles).verdict
}

// ---------------------------------------------------------------------------
// L'ENTONNOIR D'ADRESSE. Le code postal est le PLANCHER : les candidats sont
// indexés par CP, tout ce qui suit affine à l'intérieur d'un même CP.
//   'voie_numero'  voie ET numéro concordants
//   'voie'         voie concordante, numéro non concordant (ou absent d'un côté)
//   'cp'           ni l'un ni l'autre
// La voie se compare par ÉGALITÉ STRICTE des clés canoniques normaliserVoie —
// la comparaison que la mesure a chiffrée, pas une variante tolérante. PURE.
// ---------------------------------------------------------------------------
function niveauAdresse(af, voieSoc, numSoc) {
  const voieOk = !!voieSoc && normaliserVoie('', af?.street) === voieSoc
  if (!voieOk) return 'cp'
  return comparerNumero(numSoc, af?.housenumber) ? 'voie_numero' : 'voie'
}

// Niveau d'adresse + verdict de nom → tier écrivable, ou null. Les trois seuls
// couples écrivables sont ceux qu'a arbitrés la mesure ; tout le reste est null.
// PURE.
function tierCandidat(niveau, nom) {
  if (niveau === 'voie_numero' && nom === 'concordant') return 'A'
  if (niveau === 'voie_numero' && nom === 'absent') return 'A2'
  if (niveau === 'voie' && nom === 'concordant') return 'B'
  return null
}

// Rang de comparaison entre candidats d'une MÊME fiche, du meilleur au moindre :
//   4  écrivable à l'adresse exacte (A ou A2)
//   3  écrivable à la voie (B)
//   2  voie concordante mais non écrivable (nom discordant, ou nom absent sans
//      numéro) — le candidat existe, il ne tranche pas
//   1  code postal seul
// A et A2 partagent le rang 4 sans jamais se rencontrer : le verdict 'absent'
// est une propriété de la FICHE (elle n'a aucune aiguille), il vaut donc pour
// tous ses candidats à la fois. PURE.
function rangCandidat(niveau, tier) {
  if (tier === 'A' || tier === 'A2') return 4
  if (tier === 'B') return 3
  return niveau === 'cp' ? 1 : 2
}

// Voie + numéro d'une fiche société. D'abord les champs éclatés ; s'ils sont
// vides — cas SYSTÉMATIQUE côté Etalab, qui ne peuple jamais type_voie /
// libelle_voie —, repli sur l'agrégat `adresse` parsé. Sans ce repli, voieSoc
// reste vide et l'entonnoir ne dépasse jamais le code postal. Calque exact de
// sonderAdresse (rapprochement-osm.js:224). PURE.
function voieEtNumero(soc) {
  let voie = normaliserVoie(soc?.type_voie, soc?.libelle_voie)
  let numero = soc?.numero_voie
  if (!voie) {
    const parsee = parserAdresseAgregee(soc?.adresse)
    voie = parsee.voie
    numero = parsee.numero
  }
  return { voie, numero }
}

// ---------------------------------------------------------------------------
// rapprocherDepartementAtoutFrance(dept, { blanc })
//
// MODE À BLANC PAR DÉFAUT — décision assumée. `blanc` vaut TRUE si on ne le dit
// pas : écrire dans referentiel_societes demande `{ blanc: false }`, explicite.
// L'inverse ne coûtait qu'un mot, et le défaut d'un module de rapprochement non
// branché doit être celui qui ne laisse pas de trace. `{ blanc: true }` reste
// évidemment valide et fait exactement ce qu'il dit.
//
// À blanc, TOUT le calcul est fait — chargements, entonnoir, refus, y compris
// l'interruption si la table des domaines mutualisés est inexploitable — et
// RIEN n'est écrit. Le compte rendu est le même, augmenté de `appariements` :
// la liste de ce qui SERAIT écrit, une entrée par fiche.
//
// Chaque entrée porte `aiguille_confirmante` et `mode_concordance` — la clé
// normalisée qui a emporté la concordance de nom, et laquelle des trois formes
// a joué (égalité, ou l'une des deux inclusions). C'est ce qui rend RELISABLE
// l'inclusion à quatre caractères : une aiguille réduite au seul mot « camping »
// confirmerait n'importe quel nom d'hébergement, et le risque a beau être borné
// — la concordance ne joue qu'au niveau voie ou voie+numéro, l'ambiguïté écarte
// les ex aequo —, il doit se LIRE dans la liste, pas se déduire du code. Vide
// sur un A2, où par définition rien n'a confirmé. Le mode écrivant n'expose ni
// ne calcule aucun des deux.
//
// SÉQUENTIEL : on attend chaque écriture avant la fiche suivante (des milliers
// d'UPDATE concurrents non-awaités satureraient la connexion SurrealDB et
// perdraient des écritures). enrichReferentielActionnable garde son try/catch
// interne : une fiche en échec n'interrompt jamais la passe.
//
// FAIL-SAFE : ne throw JAMAIS. Tout échec rend un compte rendu, éventuellement
// à zéro.
// ---------------------------------------------------------------------------
export async function rapprocherDepartementAtoutFrance(dept, { blanc = true } = {}) {
  const debut = Date.now()
  const d = str(dept)
  const compte = {
    fiches: 0,
    candidats: 0,
    a: 0,
    a2: 0,
    b: 0,
    non_tranche_nom_discordant: 0,
    non_tranche_cp_seul: 0,
    // AJOUT au jeu de compteurs demandé, sans quoi la somme ne ferme pas : CP +
    // voie concordants, numéro non concordant, et AUCUNE aiguille de nom. Ce
    // n'est ni un nom discordant (rien ne contredit) ni un CP seul (la voie
    // concorde) — et ce n'est pas écrivable : B exige un nom qui confirme.
    non_tranche_voie_sans_nom: 0,
    sans_candidat: 0,
    refuses_domaine_mutualise: 0,
    refuses_ambiguite: 0,
    // AJOUT, même raison : classé A/A2/B mais le candidat retenu ne porte aucun
    // site. Rien à écrire, et ce n'est ni une ambiguïté ni un domaine mutualisé.
    refuses_sans_site: 0,
    ecrits: 0,
    duree_ms: 0
  }
  const appariements = []
  const rendre = () => {
    compte.duree_ms = Date.now() - debut
    return blanc ? { ...compte, appariements } : compte
  }

  if (!d) {
    console.warn('[rapprochement-atout-france] département vide — rien à faire')
    return rendre()
  }

  // La table des domaines mutualisés est une CONDITION D'ÉCRITURE, pas un
  // ornement : sans elle, on écrirait les domaines de chaîne. Absente → on
  // s'arrête là, y compris à blanc (le mode à blanc doit prédire exactement ce
  // que ferait le mode écrivant).
  const mutualises = await chargerDomainesMutualises()
  if (!mutualises) {
    console.warn('[rapprochement-atout-france] domaines mutualisés indisponibles — passe abandonnée')
    return rendre()
  }

  // ── Tranche départementale Atout France, indexée par code postal ──
  // Le CP est le plancher de l'entonnoir : une fiche ne voit que les candidats
  // de SON code postal, et l'index évite de balayer la tranche par fiche.
  const parCp = new Map()
  try {
    const db = await getDb()
    const r = await db.query(
      'SELECT cle, nom, website, domaine, housenumber, street, postcode, city ' +
      'FROM referentiel_atout_france WHERE departement = $d',
      { d }
    )
    for (const af of (r[0] || [])) {
      if (!af || typeof af !== 'object') continue
      const cp = str(af.postcode)
      if (!cp) continue
      const liste = parCp.get(cp)
      if (liste) liste.push(af)
      else parCp.set(cp, [af])
    }
  } catch (e) {
    console.warn('[rapprochement-atout-france]', String(e?.message || e).slice(0, 100))
    return rendre()
  }

  // ── Fiches sociétés du département : les trois NAF d'hébergement, et le seul
  // `website` VIDE — comparer ce qui est déjà rempli ne mènerait à rien, l'écriture
  // étant de toute façon en remplissage-si-vide.
  //
  // TROIS REQUÊTES D'ÉGALITÉ, PAS UN `naf IN $nafs`. Mesuré à l'EXPLAIN : le `IN`
  // n'est pas une clause indexable, le planificateur n'emprunte alors que
  // idx_ref_dept (le département SEUL) et filtre le NAF en mémoire — 7 045 fiches
  // lues sur le 75 pour zéro fiche traitée, 1,5 s payée à CHAQUE recherche
  // d'abonné du département. Une égalité par code rend la clause indexable.
  //
  // ET UN `WITH INDEX` EXPLICITE, parce que l'égalité seule ne suffit pas : laissé
  // libre, le planificateur préfère idx_ref_naf (le NAF seul), ce qui n'est rapide
  // que tant que ces trois NAF sont rares à l'échelle NATIONALE — vrai aujourd'hui
  // (134 lignes), faux le jour où le référentiel couvrira l'hôtellerie. `WITH
  // INDEX idx_ref_dept_naf` (referentiel.js:123) épingle le seul accès qui borne
  // les DEUX dimensions. Mesures movup-prod, les trois requêtes cumulées :
  // 1 536 ms → 85 ms sur le 75, 675 ms → 99 ms sur le 22.
  //
  // Un nom d'index inconnu ne throw PAS — SurrealDB retombe sur le balayage de
  // table : la requête resterait correcte, seulement lente, si l'index venait à
  // manquer. Rien à rattraper ici.
  //
  // Fusion en mémoire, sans dédoublonnage : une fiche porte UN seul NAF, les trois
  // ensembles sont disjoints par construction.
  let societes = []
  try {
    const db = await getDb()
    for (const naf of NAFS_HEBERGEMENT) {
      const r = await db.query(
        'SELECT siret, raison_sociale, enseigne, nom_commercial, naf, ' +
        'code_postal, numero_voie, type_voie, libelle_voie, adresse, ville, website ' +
        'FROM referentiel_societes WITH INDEX idx_ref_dept_naf ' +
        'WHERE departement = $d AND naf = $naf AND (website = NONE OR website = "")',
        { d, naf }
      )
      for (const soc of (r[0] || [])) societes.push(soc)
    }
  } catch (e) {
    console.warn('[rapprochement-atout-france]', String(e?.message || e).slice(0, 100))
    return rendre()
  }

  for (const soc of societes) {
    try {
      // Garde JS doublant le filtre SQL : un website fait d'espaces passerait
      // `website = ""` en base et ne doit pas être rapproché pour autant.
      if (str(soc.website)) continue
      compte.fiches++

      const cp = str(soc.code_postal)
      const candidats = (cp && parCp.get(cp)) || []
      if (!candidats.length) { compte.sans_candidat++; continue }
      compte.candidats += candidats.length

      const aiguilles = aiguillesNom(soc)
      const { voie: voieSoc, numero: numSoc } = voieEtNumero(soc)

      // Meilleur rang atteint, et TOUS les candidats qui l'atteignent : ce sont
      // eux, et eux seuls, que l'ambiguïté départage.
      let meilleurRang = 0
      let meilleurTier = null
      let meilleurNiveau = 'cp'
      let exAequo = []
      for (const af of candidats) {
        const niveau = niveauAdresse(af, voieSoc, numSoc)
        const nom = verdictNom(af, aiguilles)
        const tier = tierCandidat(niveau, nom)
        const rang = rangCandidat(niveau, tier)
        if (rang > meilleurRang) {
          meilleurRang = rang
          meilleurTier = tier
          meilleurNiveau = niveau
          exAequo = [af]
        } else if (rang === meilleurRang) {
          exAequo.push(af)
        }
      }

      // ── Non tranché : on ne marque RIEN comme épuisé, une autre passe pourra
      // reprendre ces fiches. ──
      if (meilleurRang === 1) { compte.non_tranche_cp_seul++; continue }
      if (meilleurRang === 2) {
        // Le rang 2 est soit « la voie concorde mais une aiguille la contredit »,
        // soit « la voie concorde, pas le numéro, et aucune aiguille ne confirme ».
        // Ce sont les CONTRADICTRICES qui tranchent entre les deux pour toute la
        // fiche — les mêmes que celles qui prononcent 'discordant', sans quoi une
        // fiche verdictée 'absent' se compterait ici comme discordante.
        if (aiguilles.contradictrices.length) compte.non_tranche_nom_discordant++
        else compte.non_tranche_voie_sans_nom++
        continue
      }

      // ── Classement (avant refus : a/a2/b comptent des classements) ──
      if (meilleurTier === 'A') compte.a++
      else if (meilleurTier === 'A2') compte.a2++
      else compte.b++

      // ── Ambiguïté : plusieurs candidats au même meilleur niveau avec des
      // sites DIFFÉRENTS → abstention. Un site absent ('') compte comme une
      // valeur distincte : deux établissements dont un seul a un site restent
      // deux établissements, et écrire ce site reviendrait à tirer au sort
      // lequel des deux est la société. ──
      const sites = new Set(exAequo.map(af => str(af.website)))
      if (sites.size > 1) { compte.refuses_ambiguite++; continue }

      const retenu = exAequo[0]
      const site = str(retenu.website)
      if (!site) { compte.refuses_sans_site++; continue }

      // ── Domaine mutualisé : porté par ≥ 2 établissements distincts, il ne
      // désigne pas CET établissement. Refus, quel que soit le tier. ──
      const domaine = cleDomaine(retenu)
      if (domaine && mutualises.has(domaine)) { compte.refuses_domaine_mutualise++; continue }

      if (blanc) {
        // TRAÇABILITÉ, MODE À BLANC UNIQUEMENT. detailNom est PURE et c'est elle
        // que verdictNom appelle : ce second appel, sur le candidat RETENU et les
        // MÊMES aiguilles, rend nécessairement ce que la boucle a décidé plus
        // haut. Rapporter ne peut donc pas diverger de décider — il n'y a qu'une
        // implémentation, et le mode écrivant, lui, ne calcule rien de plus.
        const detail = detailNom(retenu, aiguilles)
        appariements.push({
          siret: str(soc.siret).replace(/\s+/g, ''),
          raison_sociale: str(soc.raison_sociale),
          enseigne: str(soc.enseigne),
          naf: str(soc.naf),
          tier: meilleurTier,
          niveau: meilleurNiveau,
          adresse_societe: str(soc.adresse) || `${str(soc.numero_voie)} ${str(soc.libelle_voie)}`.trim(),
          cp,
          af_cle: str(retenu.cle),
          af_nom: str(retenu.nom),
          af_adresse: `${str(retenu.housenumber)} ${str(retenu.street)}`.trim(),
          af_ville: str(retenu.city),
          website: site,
          domaine,
          // Ce qui a emporté la concordance de nom. Vide sur un A2 : là, RIEN
          // n'a confirmé — c'est l'absence d'aiguille qui ouvre le tier, pas une
          // aiguille qui concorde.
          aiguille_confirmante: detail.aiguille_confirmante,
          mode_concordance: detail.mode_concordance
        })
        continue
      }

      // ecrits compte les enrichissements DISPATCHÉS. L'écriture réelle est
      // tranchée en remplissage-si-vide côté base : ce compteur ne la mesure pas.
      compte.ecrits++
      // Provenance : la source ET le tier qui a tranché. Le tier dit à quel prix
      // l'appariement a été obtenu (A nom concordant, A2 adresse exacte sans nom,
      // B nom concordant sans le numéro de voie), et rien d'autre en base ne le
      // porte : la fiche enrichie ne garde que le site. meilleurTier vaut
      // forcément 'A', 'A2' ou 'B' ici, les rangs 1 et 2 ayant déjà continué.
      await enrichReferentielActionnable(
        str(soc.siret).replace(/\s+/g, ''),
        { website: site },
        { contact_origine: `atout_france_${meilleurTier.toLowerCase()}` }
      )
    } catch (e) {
      console.warn('[rapprochement-atout-france]', String(e?.message || e).slice(0, 100))
    }
  }

  compte.duree_ms = Date.now() - debut
  console.log(
    `[rapprochement-atout-france] dept ${d}${blanc ? ' — À BLANC, rien écrit' : ''} · ` +
    `${compte.fiches} fiches · ${compte.candidats} candidats examinés | ` +
    `A=${compte.a} A2=${compte.a2} B=${compte.b} | ` +
    `non tranché : nom discordant=${compte.non_tranche_nom_discordant} ` +
    `voie sans nom=${compte.non_tranche_voie_sans_nom} ` +
    `CP seul=${compte.non_tranche_cp_seul} sans candidat=${compte.sans_candidat} | ` +
    `refus : mutualisé=${compte.refuses_domaine_mutualise} ambiguïté=${compte.refuses_ambiguite} ` +
    `sans site=${compte.refuses_sans_site} | ` +
    `${blanc ? appariements.length + ' appariements retenus' : compte.ecrits + ' écrits'} · ` +
    `${compte.duree_ms}ms`
  )
  return rendre()
}
