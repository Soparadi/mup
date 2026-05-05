// Service INSEE Sirene v3.11 — lookup d'un SIRET pour pré-remplir l'inscription.
// Réutilise le pattern du cache OAuth2 déjà présent dans server.js (token client_credentials,
// expiration suivie en mémoire). Doit être robuste : retourne null sans throw si l'API
// est indisponible ou si le SIRET est inconnu — le caller (route signup) decide de la suite.

let inseeToken = null
let inseeTokenExpires = 0

async function getInseeToken() {
  if (inseeToken && Date.now() < inseeTokenExpires) return inseeToken
  const id = process.env.INSEE_CLIENT_ID
  const secret = process.env.INSEE_CLIENT_SECRET
  if (!id || !secret) {
    console.error('[insee] INSEE_CLIENT_ID/SECRET manquants')
    return null
  }
  try {
    const creds = Buffer.from(id + ':' + secret).toString('base64')
    const r = await fetch('https://auth.insee.net/auth/realms/apim-gravitee/protocol/openid-connect/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + creds
      },
      body: 'grant_type=client_credentials'
    })
    if (!r.ok) {
      const body = await r.text()
      console.error('[insee] token error', r.status, body.slice(0, 200))
      return null
    }
    const data = await r.json()
    inseeToken = data.access_token
    inseeTokenExpires = Date.now() + (data.expires_in - 60) * 1000
    return inseeToken
  } catch (e) {
    console.error('[insee] token fetch failed', e.message)
    return null
  }
}

// Lookup d'un SIRET — retourne :
//   { raison_sociale, adresse_complete, code_postal, ville, code_naf }
// ou null si introuvable / API down.
export async function lookupSiret(siret) {
  const cleanSiret = String(siret || '').replace(/\s+/g, '')
  if (!/^\d{14}$/.test(cleanSiret)) return null

  const token = await getInseeToken()
  if (!token) return null

  try {
    const headers = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }
    if (process.env.INSEE_API_KEY) headers['X-Gravitee-Api-Key'] = process.env.INSEE_API_KEY
    const r = await fetch(
      'https://api.insee.fr/api-sirene/3.11/siret/' + encodeURIComponent(cleanSiret),
      { headers }
    )
    if (!r.ok) {
      if (r.status !== 404) console.error('[insee] lookup error', r.status)
      return null
    }
    const data = await r.json()
    const etab = data?.etablissement
    if (!etab) return null

    const ul = etab.uniteLegale || {}
    const adr = etab.adresseEtablissement || {}

    const raison = ul.denominationUniteLegale
      || [ul.prenomUsuelUniteLegale, ul.nomUniteLegale].filter(Boolean).join(' ').trim()
      || ul.denominationUsuelle1UniteLegale
      || cleanSiret

    const adresseParts = [
      adr.numeroVoieEtablissement,
      adr.indiceRepetitionEtablissement,
      adr.typeVoieEtablissement,
      adr.libelleVoieEtablissement
    ].filter(Boolean)
    const adresse_complete = adresseParts.join(' ').trim()
    const code_postal = adr.codePostalEtablissement || ''
    const ville = adr.libelleCommuneEtablissement || ''
    const code_naf = etab.periodesEtablissement?.[0]?.activitePrincipaleEtablissement
      || ul.activitePrincipaleUniteLegale
      || null

    return {
      raison_sociale: String(raison).trim(),
      adresse_complete,
      code_postal,
      ville,
      code_naf
    }
  } catch (e) {
    console.error('[insee] lookup crash', e.message)
    return null
  }
}
