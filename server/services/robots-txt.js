// Analyseur robots.txt — maison, RFC 9309, sans dépendance. Fonctions PURES :
// aucun réseau, aucun état, aucun cache ici (le cache par hôte vit chez l'appelant).
//
// Deux étages :
//   parserRobots(texte)              → structure cacheable (groupes + règles compilées)
//   evaluerRobots(parsed, chemin, ua)→ { autorise, crawlDelaySec }
//   robotsAutorise(texte, chemin, ua)→ convenance texte→décision (parse + évalue)
//
// Couverture RFC 9309 :
//   • groupement par User-agent, lignes User-agent consécutives partageant le même
//     bloc de règles ; un User-agent qui SUIT une règle ouvre un nouveau groupe.
//   • sélection du groupe : correspondance de préfixe insensible à la casse
//     (la valeur User-agent est préfixe du jeton du robot), le plus spécifique
//     (préfixe le plus long) l'emporte, repli sur « * », repli final = tout permis.
//   • Allow/Disallow arbitrés par le préfixe le plus long ; à longueur égale,
//     Allow l'emporte (§2.2.2). Disallow vide = aucune restriction (règle no-op).
//   • jokers « * » (séquence quelconque) et « $ » (ancre de fin) ; correspondance
//     ancrée au début du chemin (préfixe) sauf « $ » final.
//   • robustesse : BOM, CRLF/CR, commentaires « # », lignes sans « : », valeurs
//     malformées — jamais de throw, on ignore la ligne fautive.

// Jeton produit par défaut (partie « product token » de l'User-Agent réseau du module).
const DEFAULT_UA_TOKEN = 'MovUP'

// ---------------------------------------------------------------------------
// Compilation d'un motif de chemin (valeur d'Allow/Disallow) en RegExp ancrée.
//   • « * » → « .* » (séquence quelconque, éventuellement vide)
//   • « $ » FINAL → ancre de fin ; « $ » non final → littéral
//   • correspondance ancrée au début (préfixe), pas d'ancre de fin sinon
// ---------------------------------------------------------------------------

const REGEX_META = /[.*+?^${}()|[\]\\]/g
const escapeLiteral = (s) => s.replace(REGEX_META, '\\$&')

function compilerMotif(valeur) {
  const ancreFin = valeur.endsWith('$')
  const noyau = ancreFin ? valeur.slice(0, -1) : valeur
  // On découpe sur « * » : chaque tronçon est littéral, les jointures deviennent « .* ».
  const src = '^' + noyau.split('*').map(escapeLiteral).join('.*') + (ancreFin ? '$' : '')
  try { return new RegExp(src) } catch { return null }
}

// ---------------------------------------------------------------------------
// parserRobots(texte) → { groupes: [{ agents:[], regles:[{allow, len, re}], crawlDelaySec }] }
// Structure pure et sérialisable-en-mémoire, destinée à être mise en cache par hôte.
// ---------------------------------------------------------------------------

export function parserRobots(texte) {
  const groupes = []
  let courant = null
  let derniereEtaitRegle = false   // une règle a-t-elle précédé la ligne courante ?

  const lignes = String(texte || '')
    .replace(/^﻿/, '')        // BOM éventuel
    .split(/\r\n|\r|\n/)

  for (let brute of lignes) {
    // Commentaire : « # » jusqu'à la fin de ligne.
    const diese = brute.indexOf('#')
    if (diese !== -1) brute = brute.slice(0, diese)
    const ligne = brute.trim()
    if (!ligne) continue

    const sep = ligne.indexOf(':')
    if (sep === -1) continue        // ligne sans « : » → ignorée (robustesse)
    const champ = ligne.slice(0, sep).trim().toLowerCase()
    const valeur = ligne.slice(sep + 1).trim()

    if (champ === 'user-agent' || champ === 'useragent') {
      if (!valeur) continue
      // Nouveau groupe si aucun en cours OU si la ligne précédente était une règle.
      if (courant === null || derniereEtaitRegle) {
        courant = { agents: [], regles: [], crawlDelaySec: null }
        groupes.push(courant)
      }
      courant.agents.push(valeur.toLowerCase())
      derniereEtaitRegle = false
    } else if (champ === 'allow' || champ === 'disallow') {
      if (courant === null) continue          // règle avant tout User-agent → ignorée
      derniereEtaitRegle = true
      if (valeur === '') continue             // Disallow/Allow vide = no-op (aucune restriction)
      const re = compilerMotif(valeur)
      if (!re) continue                       // motif inanalysable → ignoré
      courant.regles.push({ allow: champ === 'allow', len: valeur.length, re })
    } else if (champ === 'crawl-delay' || champ === 'crawldelay') {
      if (courant === null) continue
      derniereEtaitRegle = true
      const n = Number.parseFloat(valeur)
      if (Number.isFinite(n) && n >= 0) courant.crawlDelaySec = n
    }
    // Sitemap, Host, etc. : hors périmètre → ignorés.
  }

  return { groupes }
}

// ---------------------------------------------------------------------------
// Normalise l'entrée « chemin » : accepte un chemin ou une URL complète, rend le
// pathname + query (ce que robots.txt met en correspondance). Vide → « / ».
// ---------------------------------------------------------------------------

function toChemin(chemin) {
  let c = String(chemin || '')
  if (c.includes('://')) {
    try { const u = new URL(c); c = u.pathname + u.search } catch { /* garde brut */ }
  }
  if (!c) return '/'
  if (!c.startsWith('/')) c = '/' + c
  return c
}

// ---------------------------------------------------------------------------
// Sélection du groupe applicable au jeton du robot. Rend l'ensemble des règles et
// le crawl-delay du meilleur match (préfixe le plus long ; repli « * » ; sinon vide).
// ---------------------------------------------------------------------------

function selectionner(groupes, uaToken) {
  const token = String(uaToken || '').toLowerCase()

  // Meilleure longueur de correspondance non-« * » ; -1 si aucune.
  let meilleureLen = -1
  for (const g of groupes) {
    for (const a of g.agents) {
      if (a === '*') continue
      if (token.startsWith(a) && a.length > meilleureLen) meilleureLen = a.length
    }
  }

  // Fusionne les règles de TOUS les groupes atteignant le critère retenu (gère les
  // groupes dupliqués), puis, à défaut, de tous les groupes « * ».
  const specifique = meilleureLen >= 0
  const retenus = groupes.filter((g) =>
    g.agents.some((a) => specifique
      ? (a !== '*' && token.startsWith(a) && a.length === meilleureLen)
      : a === '*')
  )
  if (retenus.length === 0) return { regles: [], crawlDelaySec: null }

  const regles = retenus.flatMap((g) => g.regles)
  // crawl-delay : premier défini parmi les groupes retenus.
  let crawlDelaySec = null
  for (const g of retenus) {
    if (g.crawlDelaySec != null) { crawlDelaySec = g.crawlDelaySec; break }
  }
  return { regles, crawlDelaySec }
}

// ---------------------------------------------------------------------------
// evaluerRobots(parsed, chemin, uaToken) → { autorise, crawlDelaySec }
// Arbitrage par préfixe le plus long ; égalité → Allow l'emporte ; aucune règle
// correspondante → autorisé par défaut.
// ---------------------------------------------------------------------------

export function evaluerRobots(parsed, chemin, uaToken = DEFAULT_UA_TOKEN) {
  const groupes = (parsed && Array.isArray(parsed.groupes)) ? parsed.groupes : []
  const { regles, crawlDelaySec } = selectionner(groupes, uaToken)
  const c = toChemin(chemin)

  let allowLen = -1
  let disallowLen = -1
  for (const r of regles) {
    if (!r.re.test(c)) continue
    if (r.allow) { if (r.len > allowLen) allowLen = r.len }
    else { if (r.len > disallowLen) disallowLen = r.len }
  }

  // Aucune règle ne matche → autorisé. Sinon, le préfixe le plus long tranche ;
  // à égalité (allowLen === disallowLen), Allow l'emporte.
  const autorise = allowLen >= disallowLen
  return { autorise, crawlDelaySec }
}

// ---------------------------------------------------------------------------
// Convenance : texte brut → décision (parse + évalue en un appel). Pour l'usage
// mis en cache, préférer parserRobots une fois puis evaluerRobots par chemin.
// ---------------------------------------------------------------------------

export function robotsAutorise(texte, chemin, uaToken = DEFAULT_UA_TOKEN) {
  return evaluerRobots(parserRobots(texte), chemin, uaToken)
}
