// Service Base Adresse Nationale — géocodage d'une adresse en lat/lng.
// API publique gouv.fr, sans clef. Retourne null si pas de résultat ou API down.

export async function geocode({ adresse, code_postal, ville }) {
  const parts = [adresse, code_postal, ville].filter(Boolean).map(s => String(s).trim()).filter(Boolean)
  if (parts.length === 0) return null
  const q = parts.join(' ')
  const url = 'https://api-adresse.data.gouv.fr/search/?q=' + encodeURIComponent(q) + '&limit=1'

  try {
    const r = await fetch(url)
    if (!r.ok) {
      console.error('[ban] geocode error', r.status)
      return null
    }
    const data = await r.json()
    const feature = data?.features?.[0]
    if (!feature) return null
    const coords = feature.geometry?.coordinates
    if (!Array.isArray(coords) || coords.length < 2) return null
    return {
      lng: Number(coords[0]),
      lat: Number(coords[1]),
      label: feature.properties?.label || null,
      score: feature.properties?.score || null
    }
  } catch (e) {
    console.error('[ban] geocode crash', e.message)
    return null
  }
}

// Reverse — la commune d'un point, par le /reverse/ de la même API publique.
// POURQUOI ICI. Le navigateur ne parle qu'à nos routes ; la Carte a besoin du
// nom de la commune où elle vient de relever une position, et ce nom se résout
// UNE FOIS, au relevé, pas à chaque ouverture d'une page qui l'affiche.
//
// LA COMMUNE SE PREND TELLE QUE LA BAN LA REND : sur le reverse, `city` est un
// champ à part entière — rien à découper dans un libellé, contrairement à une
// adresse saisie librement.
//
// Rend { ville, label } ou null : hors du domaine couvert (mer, étranger),
// panne, ou réponse sans commune exploitable. L'appelant décide de ce que vaut
// un null ; ici on n'invente pas de nom.
export async function reverseGeocode({ lat, lon }) {
  const la = Number(lat)
  const lo = Number(lon)
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null
  const url = 'https://api-adresse.data.gouv.fr/reverse/?lat=' + encodeURIComponent(la)
    + '&lon=' + encodeURIComponent(lo) + '&limit=1'

  try {
    const r = await fetch(url)
    if (!r.ok) {
      console.error('[ban] reverse error', r.status)
      return null
    }
    const data = await r.json()
    const p = data?.features?.[0]?.properties
    if (!p) return null
    const ville = p.city ? String(p.city).trim() : ''
    if (!ville) return null
    return { ville, label: p.label || null }
  } catch (e) {
    console.error('[ban] reverse crash', e.message)
    return null
  }
}
