// OAuth Microsoft — helpers pour Track 1 (boîte personnelle Outlook / Microsoft 365).
// Miroir de oauth-google.js. Endpoints Microsoft identity platform v2 appelés en
// fetch direct — AUCUNE dépendance npm (Node 18+ fournit fetch global).
//
// Variables d'environnement requises :
//   - MICROSOFT_CLIENT_ID
//   - MICROSOFT_CLIENT_SECRET
//   - MICROSOFT_REDIRECT_URI
//   - MICROSOFT_TENANT (optionnel, défaut 'common')
//   - SECRET_KEY (32 bytes hex) — via lib/oauth-state.js pour signer le state JWT HS256
//
// Sans CLIENT_ID/SECRET/REDIRECT_URI, isMicrosoftReady() = false et les routes
// /auth/microsoft* renvoient 503.

// State JWT HS256 (anti-CSRF) partagé avec Google — même signature/format.
export { signState, verifyState } from './oauth-state.js'

// Scopes délégués Microsoft Graph. offline_access est requis pour obtenir un
// refresh_token ; openid/email pour l'identité.
export const MICROSOFT_SCOPES = [
  'Mail.Send',
  'Mail.Read',
  'User.Read',
  'openid',
  'email',
  'offline_access'
]

function tenant() {
  return process.env.MICROSOFT_TENANT || 'common'
}

function authorityBase() {
  return `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0`
}

export function isMicrosoftReady() {
  return Boolean(
    process.env.MICROSOFT_CLIENT_ID &&
    process.env.MICROSOFT_CLIENT_SECRET &&
    process.env.MICROSOFT_REDIRECT_URI
  )
}

function requireConfig() {
  if (!isMicrosoftReady()) throw new Error('OAuth Microsoft non configuré (MICROSOFT_CLIENT_ID/SECRET/REDIRECT_URI)')
}

// Normalise la réponse token Microsoft vers la même forme que googleapis
// (access_token / refresh_token / expiry_date en ms epoch / scope) pour que
// server.js et mail-service.js partagent le même code d'écriture.
function normalizeTokens(data) {
  const expiryDate = data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : null
  return {
    access_token: data.access_token || null,
    refresh_token: data.refresh_token || null,
    expiry_date: expiryDate,
    scope: data.scope || null,
    token_type: data.token_type || null,
    id_token: data.id_token || null
  }
}

export function generateAuthUrl(state) {
  requireConfig()
  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID,
    response_type: 'code',
    redirect_uri: process.env.MICROSOFT_REDIRECT_URI,
    response_mode: 'query',
    scope: MICROSOFT_SCOPES.join(' '),
    prompt: 'select_account',
    state
  })
  return `${authorityBase()}/authorize?${params.toString()}`
}

export async function exchangeCode(code) {
  requireConfig()
  const body = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
    redirect_uri: process.env.MICROSOFT_REDIRECT_URI,
    grant_type: 'authorization_code',
    scope: MICROSOFT_SCOPES.join(' '),
    code
  })
  const resp = await fetch(`${authorityBase()}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new Error('Échange code Microsoft échoué : ' + (data.error_description || data.error || resp.status))
  return normalizeTokens(data) // { access_token, refresh_token, expiry_date, scope, token_type, id_token }
}

// Retourne { email, name, given_name, family_name, picture } via GET /v1.0/me.
// email = mail (primaire) ou userPrincipalName en repli. Graph n'expose pas la
// photo via /me — picture reste null (endpoint /me/photo séparé, non requis ici).
export async function fetchUserInfo(tokens) {
  const resp = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: `Bearer ${tokens.access_token}` }
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new Error('Lecture profil Microsoft échouée : ' + (data.error?.message || resp.status))
  return {
    email: data.mail || data.userPrincipalName || null,
    name: data.displayName || null,
    given_name: data.givenName || null,
    family_name: data.surname || null,
    picture: null
  }
}

export async function refreshAccessToken(refreshToken) {
  requireConfig()
  const body = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
    grant_type: 'refresh_token',
    scope: MICROSOFT_SCOPES.join(' '),
    refresh_token: refreshToken
  })
  const resp = await fetch(`${authorityBase()}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new Error('Refresh token Microsoft échoué : ' + (data.error_description || data.error || resp.status))
  return normalizeTokens(data) // peut inclure un nouveau refresh_token (rotation)
}

// Microsoft identity platform v2 n'expose pas d'endpoint de révocation
// programmatique par refresh_token (contrairement à Google). L'utilisateur
// révoque le consentement via https://account.live.com/consent/Manage. No-op
// documenté pour préserver la même signature que oauth-google.js — le disconnect
// supprime de toute façon le record mailbox_credentials côté MUP.
export async function revokeRefreshToken() {
  return false
}
