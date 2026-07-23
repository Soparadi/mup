// Client DataForSEO — Business Info (Google My Business), appel Live UNIQUE.
// Une seule fonction exportée : lookupBusinessInfo({ keyword }). Fail-safe strict :
// toute erreur (réseau, HTTP, timeout, payload illisible) rend { found:false },
// JAMAIS de throw remontant — l'appelant (maillon Enrichir) ne doit pas casser.
// Le secret (DATAFORSEO_AUTH, Basic auth base64) n'est JAMAIS loggé.

const ENDPOINT = 'https://api.dataforseo.com/v3/business_data/google/my_business_info/live'
const LOCATION_CODE = 2250   // France
const LANGUAGE_CODE = 'fr'

// { found:true, title, phone, url, address } sur succès, sinon { found:false }.
// keyword vide → { found:false } sans appel réseau. Pas de timeout explicite :
// l'appel Live aboutit sans limite (le fetch garde son plafond réseau natif).
export async function lookupBusinessInfo({ keyword } = {}) {
  const kw = String(keyword || '').trim()
  if (!kw) return { found: false }
  const auth = process.env.DATAFORSEO_AUTH
  if (!auth) return { found: false }

  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify([
        { keyword: kw, location_code: LOCATION_CODE, language_code: LANGUAGE_CODE }
      ])
    })
    if (!r.ok) return { found: false }
    const data = await r.json()
    // Arborescence DataForSEO : tasks[0].result[0].items[]. items[0] = la fiche.
    const task = Array.isArray(data?.tasks) ? data.tasks[0] : null
    const result = Array.isArray(task?.result) ? task.result[0] : null
    const items = Array.isArray(result?.items) ? result.items : []
    const item = items[0]
    if (!item) return { found: false }
    return {
      found: true,
      title: String(item.title || ''),
      phone: String(item.phone || ''),
      url: String(item.url || ''),
      address: String(item.address || '')
    }
  } catch (e) {
    console.warn('[dataforseo]', String(e?.message || e).slice(0, 80))
    return { found: false }
  }
}
