// Géolocalisation IP — best effort, fail silencieux.
// Utilisée au signup pour stocker une géo approximative (ville, région,
// code postal, lat/lng) qui sert ensuite à personnaliser les communications
// commerciales (sous réserve du consentement marketing recueilli au signup).
//
// Source : ipapi.co (DataTech LLC, US) — gratuit jusqu'à 1k req/jour, pas
// d'auth. Voir public/sous-traitants.html pour la doc RGPD.
//
// Contraintes :
//   - timeout court (2 s) pour ne jamais bloquer le signup
//   - retourne null si IP locale, IP invalide, timeout, ou erreur réseau
//   - aucune mise en cache (le signup est un événement unique par utilisateur)

const GEOLOCATION_TIMEOUT_MS = 2000

function isLocalOrPrivateIp(ip) {
  if (!ip) return true
  const v = ip.replace(/^::ffff:/, '')
  if (v === '::1' || v === '127.0.0.1') return true
  if (v.startsWith('10.')) return true
  if (v.startsWith('192.168.')) return true
  // 172.16.0.0/12 → 172.16.x.x à 172.31.x.x
  if (v.startsWith('172.')) {
    const second = parseInt(v.split('.')[1] || '0', 10)
    if (second >= 16 && second <= 31) return true
  }
  return false
}

export async function getLocationFromIp(ip) {
  if (isLocalOrPrivateIp(ip)) return null

  const cleanIp = ip.replace(/^::ffff:/, '')

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), GEOLOCATION_TIMEOUT_MS)

    const response = await fetch(`https://ipapi.co/${encodeURIComponent(cleanIp)}/json/`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'MovUP/1.0' }
    })

    clearTimeout(timeoutId)

    if (!response.ok) return null

    const data = await response.json()
    if (!data || data.error) return null

    return {
      city: data.city || null,
      region: data.region || null,
      country: data.country_name || null,
      country_code: data.country_code || null,
      postal_code: data.postal || null,
      latitude: data.latitude != null ? Number(data.latitude) : null,
      longitude: data.longitude != null ? Number(data.longitude) : null,
      ip_used: cleanIp,
      provider: 'ipapi.co',
      detected_at: new Date().toISOString()
    }
  } catch (e) {
    console.warn('[geolocation] échec géolocalisation IP :', e.message)
    return null
  }
}
