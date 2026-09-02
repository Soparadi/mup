// Module Recherche Web — maillon 1.b de la chaîne mentions légales.
//
// Rôle : à partir du faisceau (raison sociale, ville, éventuel dirigeant), rendre
// une LISTE de candidats URL (sites d'entreprise plausibles) que mentions-legales.js
// vérifiera un par un au maillon 4. On ne fait JAMAIS confiance au rang : le rang
// n'est qu'un ordre de passage, l'acceptation vient du recoupement.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ ⚠ BACKEND DE RECHERCHE NON ENCORE BRANCHÉ — par décision.                  │
// │ fetchSerp() est une interface FIGÉE : entrée = requête (string), sortie = │
// │ liste d'URLs candidates (string[]). Le backend réel (Brave / Serper /     │
// │ Google / DuckDuckGo) sera choisi et câblé dans une passe dédiée. Le choix │
// │ se fait par la variable d'env SERP_BACKEND ; tant qu'elle est absente ou  │
// │ pointe un backend non implémenté, fetchSerp rend [] (maillon 1.b inerte,  │
// │ aucun appel sortant). Tout le reste (requêtes, blacklist, filtrage) est   │
// │ complet et opérationnel.                                                  │
// └─────────────────────────────────────────────────────────────────────────┘
//
// Contrainte politesse : quand un backend sera câblé, TOUT appel sortant devra passer
// par politeFetchText (mentions-legales.js), donc par le MÊME dispositif que les crawls
// de sites tiers. Les files y sont par hôte : les hôtes de SERP auront la leur, séparée
// de celle des sites visités, espacée comme eux et bornée par le même sémaphore. Une
// seule IP, jamais de rafale vers un serveur.

import { normText } from './overpass.js'
import { politeFetchText } from './mentions-legales.js'

// La liste noire des hôtes et son prédicat vivent désormais dans hotes-exclus.js,
// module feuille sans aucune dépendance. Motif : le filtre d'écriture du référentiel
// (enrichReferentielActionnable) doit les lire, or ce module-ci importe
// mentions-legales.js, qui importe referentiel.js ; les laisser ici aurait fermé un
// cycle d'import. Ils restent RÉEXPORTÉS depuis cette adresse : les appelants
// historiques (server.js, rapprochement-osm.js, les bancs de scripts/) ne changent
// pas une ligne.
import { hostBlacklisted } from './hotes-exclus.js'
export { BLACKLIST_HOSTS, hostBlacklisted } from './hotes-exclus.js'

// ---------------------------------------------------------------------------
// Détection patronyme : la raison sociale est-elle (essentiellement) le nom du
// dirigeant ? Si oui, « dirigeant_nom + ville » est une requête complémentaire
// utile (beaucoup de TPE artisanales se référencent au nom du gérant).
// ---------------------------------------------------------------------------

function estPatronyme(raisonSociale, dirigeantNom) {
  const rs = normText(raisonSociale)
  const dn = normText(dirigeantNom)
  if (!rs || !dn) return false
  // Le nom du dirigeant apparaît dans la raison sociale, ou la raison sociale est
  // un libellé court dominé par ce nom.
  if (rs.includes(dn)) return true
  const rsTokens = rs.split(/\s+/).filter(Boolean)
  return rsTokens.length <= 2 && rsTokens.some(t => t === dn)
}

// ---------------------------------------------------------------------------
// Construction des requêtes. « raison_sociale + ville » toujours ; on ajoute
// « dirigeant_nom + ville » si la raison sociale est un patronyme.
// ---------------------------------------------------------------------------

export function buildQueries({ raison_sociale, ville, dirigeant_nom } = {}) {
  const rs = String(raison_sociale || '').trim()
  const v = String(ville || '').trim()
  const dn = String(dirigeant_nom || '').trim()
  const queries = []
  if (rs) queries.push([rs, v].filter(Boolean).join(' '))
  if (dn && estPatronyme(rs, dn)) queries.push([dn, v].filter(Boolean).join(' '))
  // Dédup en préservant l'ordre.
  return [...new Set(queries.filter(Boolean))]
}

// ---------------------------------------------------------------------------
// Filtrage des candidats : http(s) only, hors blacklist, réduits à l'origine
// (on crawle la home au maillon 2), dédupliqués en préservant l'ordre.
// ---------------------------------------------------------------------------

export function filtrerCandidats(urls) {
  const out = []
  const seen = new Set()
  for (const raw of (Array.isArray(urls) ? urls : [])) {
    let u
    try { u = new URL(String(raw || '').trim()) } catch { continue }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue
    if (hostBlacklisted(u.host)) continue
    const origin = u.origin
    if (seen.has(origin)) continue
    seen.add(origin)
    out.push(origin)
  }
  return out
}

// ---------------------------------------------------------------------------
// fetchSerp(query) — INTERFACE FIGÉE, backend résolu par SERP_BACKEND.
//   entrée : query (string)         sortie : Promise<string[]> (URLs organiques)
// Registre de backends : chaque entrée est un async (query) => string[]. Tous sont
// aujourd'hui des STUBS (rendent [] via stubNonBranche) ; brancher un moteur =
// remplacer le stub correspondant par l'appel réel, impérativement à travers
// politeFetchText (file de l'hôte et sémaphore partagés). SERP_BACKEND absente,
// inconnue ou non implémentée → [] : aucun appel sortant, maillon 1.b inerte mais
// présent.
// ---------------------------------------------------------------------------

const SERP_BACKENDS = {
  brave: (query) => stubNonBranche('brave', query),
  serper: (query) => stubNonBranche('serper', query),
  google: (query) => stubNonBranche('google', query),
  ddg: (query) => stubNonBranche('ddg', query)
}

// Avertit une seule fois par process qu'un backend nommé n'est pas encore branché,
// puis rend [] sans aucun appel réseau.
let serpWarned = false
function stubNonBranche(name, query) {
  if (!serpWarned) {
    console.warn(`[recherche-web] SERP_BACKEND=${name} non branché — maillon 1.b inerte ([])`)
    serpWarned = true
  }
  void query
  void politeFetchText   // verrou partagé, référencé pour le câblage à venir
  return []
}

async function fetchSerp(query) {
  const backend = String(process.env.SERP_BACKEND || '').trim().toLowerCase()
  const impl = SERP_BACKENDS[backend]
  if (!impl) return []   // non configuré → aucun candidat, aucun appel sortant
  try {
    const urls = await impl(query)
    return Array.isArray(urls) ? urls : []
  } catch (e) {
    console.warn('[recherche-web]', String(e?.message || e).slice(0, 80))
    return []
  }
}

// ---------------------------------------------------------------------------
// rechercherUrlSociete(faisceau) — API publique du module.
// Rend une liste ORDONNÉE de candidats (origines) à vérifier au maillon 4.
// Aucun throw remontant (fail-safe → [] en cas de pépin).
// ---------------------------------------------------------------------------

export async function rechercherUrlSociete({ raison_sociale, ville, dirigeant_nom } = {}) {
  try {
    const queries = buildQueries({ raison_sociale, ville, dirigeant_nom })
    if (queries.length === 0) return []
    const brut = []
    for (const q of queries) {
      const urls = await fetchSerp(q)
      if (Array.isArray(urls)) brut.push(...urls)
    }
    return filtrerCandidats(brut)
  } catch (e) {
    console.warn('[recherche-web]', String(e?.message || e).slice(0, 80))
    return []
  }
}
