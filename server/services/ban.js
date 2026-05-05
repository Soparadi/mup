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
