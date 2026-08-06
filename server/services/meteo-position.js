// Position retenue pour la météo d'un abonné.
//
// POURQUOI. Le composant météo interrogeait Open-Meteo sur des coordonnées
// littérales — celles de Combourg, posées à la construction du widget. Tous
// les abonnés voyaient donc la même météo, celle d'une ville qui n'est pas la
// leur. La position se dérive désormais du compte, par une cascade à trois
// rangs dont le PREMIER RENSEIGNÉ GAGNE :
//
//   1. user_settings.homeLat / homeLon — l'adresse de départ de tournée. Seule
//      position que l'abonné ait lui-même déclarée et validée, et la seule qui
//      réponde à la question posée : la météo utile avant une tournée est celle
//      du point de départ, pas celle du siège ni celle du fournisseur d'accès.
//   2. user.lat / user.lng ; à défaut user.ville + user.code_postal, géocodés
//      par la Base Adresse Nationale.
//   3. user.geo_data.latitude / longitude — la position de l'adresse réseau
//      captée UNE FOIS à l'inscription (services/geolocation.js), jamais
//      rafraîchie. Repli seulement : elle vaut ce que valait la connexion ce
//      jour-là, et l'affichage le signale.
//
// AUCUN REPLI EN DUR. Pas de ville de secours : quand les trois rangs sont
// muets, la fonction rend { source: null } et le composant n'affiche pas de
// météo — il invite à renseigner l'adresse de départ. Une météo fausse est
// pire qu'une météo absente, elle ne se distingue pas d'une météo juste.
//
// geo_data N'EST JAMAIS RÉÉCRIT ici : donnée d'inscription, lecture seule.
// Aucune géolocalisation d'adresse réseau n'est déclenchée à l'exécution —
// le rang 3 relit ce qui est en base, il ne rappelle pas ipapi.co.

import { geocode } from './ban.js'

// Un nombre exploitable : ni null, ni NaN, ni la chaîne vide, ni un booléen.
// `Number('')` vaut 0 — d'où le rejet explicite de la chaîne vide, sans quoi
// un champ vidé passerait pour le point (0, 0), au large du golfe de Guinée.
function nombre(v) {
  if (v === undefined || v === null || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// Un couple de coordonnées terrestres, ou null. Le contrôle de bornes n'est pas
// décoratif : Open-Meteo répond 400 hors domaine, et le widget afficherait
// « indisponible » sans qu'on sache que la donnée était en cause.
function coordonnees(latBrut, lonBrut) {
  const lat = nombre(latBrut)
  const lon = nombre(lonBrut)
  if (lat === null || lon === null) return null
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
  return { lat, lon }
}

function texte(v) {
  const s = (v === undefined || v === null) ? '' : String(v).trim()
  return s || null
}

// Cache mémoire du géocodage ville + code postal (rang 2b). La BAN est une API
// publique sans clef : on ne la réinterroge pas à chaque ouverture du tableau
// de bord pour une adresse qui ne bouge pas. Purge en bloc au-delà d'un millier
// d'entrées — borne de sécurité mémoire, l'instance est petite.
const CACHE_GEOCODAGE = new Map()
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const CACHE_MAX = 1000

async function geocoderCommune(ville, codePostal) {
  const cle = [codePostal || '', ville || ''].join('|').toLowerCase()
  const cache = CACHE_GEOCODAGE.get(cle)
  if (cache && (Date.now() - cache.at) < CACHE_TTL_MS) return cache.valeur

  const r = await geocode({ code_postal: codePostal, ville })
  const pos = r ? coordonnees(r.lat, r.lng) : null
  const valeur = pos ? { ...pos, label: texte(r.label) } : null

  if (CACHE_GEOCODAGE.size >= CACHE_MAX) CACHE_GEOCODAGE.clear()
  CACHE_GEOCODAGE.set(cle, { at: Date.now(), valeur })
  return valeur
}

// Nom de commune tiré d'une adresse complète : le composant n'a la place que
// d'une ligne, il affiche la commune et non la voie. La BAN rend ses libellés
// SANS virgule — « 12 Rue de la Gare 35270 Combourg » — d'où la découpe sur le
// code postal, la virgule ne servant que pour une saisie libre. Sans code
// postal reconnaissable on rend le libellé tel quel plutôt que de le mutiler.
function communeDepuisLabel(label) {
  if (!label) return null
  const brut = String(label).split(',').pop().trim()
  const apresCodePostal = brut.match(/\b\d{5}\s+(.+)$/)
  return texte(apresCodePostal ? apresCodePostal[1] : brut)
}

// Rend { lat, lon, ville, source } — source ∈ 'depart' | 'compte' | 'reseau' —
// ou { source: null } quand aucun rang ne répond. `settings` est le record
// user_settings du compte (peut être null : la table n'a pas d'enregistrement
// tant qu'aucun réglage n'a été posé).
export async function resoudrePositionMeteo({ user, settings }) {
  const u = user || {}
  const s = settings || {}

  // ── Rang 1 — adresse de départ déclarée ──
  const depart = coordonnees(s.homeLat, s.homeLon)
  if (depart) {
    return {
      lat: depart.lat,
      lon: depart.lon,
      // homeAddress est saisie libre : on n'en garde que la commune quand elle
      // est reconnaissable, sinon le libellé tel quel.
      ville: communeDepuisLabel(s.homeAddress) || texte(s.homeAddress),
      source: 'depart'
    }
  }

  // ── Rang 2a — coordonnées portées par le compte ──
  const compte = coordonnees(u.lat, u.lng)
  if (compte) {
    return { lat: compte.lat, lon: compte.lon, ville: texte(u.ville), source: 'compte' }
  }

  // ── Rang 2b — commune du compte, géocodée ──
  const ville = texte(u.ville)
  const codePostal = texte(u.code_postal)
  if (ville || codePostal) {
    const pos = await geocoderCommune(ville, codePostal)
    if (pos) {
      return { lat: pos.lat, lon: pos.lon, ville: ville || communeDepuisLabel(pos.label), source: 'compte' }
    }
  }

  // ── Rang 3 — adresse réseau captée à l'inscription ──
  const g = (u.geo_data && typeof u.geo_data === 'object') ? u.geo_data : null
  if (g) {
    const reseau = coordonnees(g.latitude, g.longitude)
    if (reseau) {
      return { lat: reseau.lat, lon: reseau.lon, ville: texte(g.city), source: 'reseau' }
    }
  }

  // ── Rien de connu — surtout pas de ville de secours ──
  return { lat: null, lon: null, ville: null, source: null }
}
