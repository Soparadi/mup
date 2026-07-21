// OAuth Google — helpers pour Track 1 (boîte personnelle Gmail).
//
// Variables d'environnement requises :
//   - GOOGLE_CLIENT_ID
//   - GOOGLE_CLIENT_SECRET
//   - GOOGLE_REDIRECT_URI
//   - SECRET_KEY (32 bytes hex) — pour signer le state JWT HS256
//
// Sans ces variables, isGoogleReady() = false et les routes /auth/google* renvoient 503.

import { google } from 'googleapis'

// State JWT HS256 (anti-CSRF) extrait dans oauth-state.js, partagé avec Microsoft.
// Ré-exporté ici pour préserver les imports existants depuis ce module.
export { signState, verifyState } from './oauth-state.js'

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid'
]

export function isGoogleReady() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REDIRECT_URI
  )
}

export function getOAuth2Client() {
  if (!isGoogleReady()) throw new Error('OAuth Google non configuré (GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI)')
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  )
}

export function generateAuthUrl(state) {
  const oauth2Client = getOAuth2Client()
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',  // force consent pour obtenir refresh_token à chaque connexion
    scope: GOOGLE_SCOPES,
    state,
    include_granted_scopes: true
  })
}

export async function exchangeCode(code) {
  const oauth2Client = getOAuth2Client()
  const { tokens } = await oauth2Client.getToken(code)
  return tokens // { access_token, refresh_token, expiry_date, token_type, scope, id_token }
}

export async function fetchUserEmail(tokens) {
  const info = await fetchUserInfo(tokens)
  return info?.email || null
}

// Retourne { email, name, given_name, family_name, picture } — utile pour personnaliser
// le welcome email avec le prénom récupéré côté Google.
export async function fetchUserInfo(tokens) {
  const oauth2Client = getOAuth2Client()
  oauth2Client.setCredentials(tokens)
  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client })
  const { data } = await oauth2.userinfo.get()
  return {
    email: data.email || null,
    name: data.name || null,
    given_name: data.given_name || null,
    family_name: data.family_name || null,
    picture: data.picture || null
  }
}

export async function refreshAccessToken(refreshToken) {
  const oauth2Client = getOAuth2Client()
  oauth2Client.setCredentials({ refresh_token: refreshToken })
  const { credentials } = await oauth2Client.refreshAccessToken()
  return credentials // { access_token, expiry_date, ... } — peut inclure un nouveau refresh_token
}

export async function revokeRefreshToken(refreshToken) {
  const oauth2Client = getOAuth2Client()
  try {
    await oauth2Client.revokeToken(refreshToken)
    return true
  } catch (e) {
    return false
  }
}
