// State JWT HS256 manuel (anti-CSRF, expiration 10 min) — partagé par les flux
// OAuth Google et Microsoft. Extrait de oauth-google.js sans changement de
// comportement (mêmes signatures, HS256, SECRET_KEY, exp 600s).
//
// Format : base64url(header).base64url(payload).base64url(hmac)

import { createHmac, randomBytes } from 'crypto'

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
