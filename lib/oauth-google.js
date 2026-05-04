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
import { createHmac, randomBytes } from 'crypto'

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
  const oauth2Client = getOAuth2Client()
  oauth2Client.setCredentials(tokens)
  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client })
  const { data } = await oauth2.userinfo.get()
  return data.email
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

// ── State JWT HS256 manuel (anti-CSRF, expiration 10 min) ──
// Format : base64url(header).base64url(payload).base64url(hmac)

function getStateSecret() {
  const hex = process.env.SECRET_KEY
  if (!hex || hex.length !== 64) throw new Error('SECRET_KEY (32 bytes hex) requise pour signer le state OAuth')
  return Buffer.from(hex, 'hex')
}

function b64u(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function b64uDecode(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

export function signState(payload) {
  const header = { alg: 'HS256', typ: 'JWT' }
  const enriched = { ...payload, iat: Math.floor(Date.now() / 1000), nonce: randomBytes(8).toString('hex') }
  const h = b64u(JSON.stringify(header))
  const b = b64u(JSON.stringify(enriched))
  const sig = b64u(createHmac('sha256', getStateSecret()).update(`${h}.${b}`).digest())
  return `${h}.${b}.${sig}`
}

export function verifyState(token) {
  if (!token || typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [h, b, s] = parts
  const expected = b64u(createHmac('sha256', getStateSecret()).update(`${h}.${b}`).digest())
  if (s !== expected) return null
  let payload
  try { payload = JSON.parse(b64uDecode(b).toString('utf8')) } catch (e) { return null }
  // Expiration stricte 10 min
  if (typeof payload.iat !== 'number') return null
  if (Math.floor(Date.now() / 1000) - payload.iat > 600) return null
  return payload
}
