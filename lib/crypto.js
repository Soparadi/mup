import { randomBytes, createCipheriv, createDecipheriv } from 'crypto'

const ALGO = 'aes-256-gcm'
const IV_LENGTH = 12
const TAG_LENGTH = 16

let cachedKey = null
let warned = false

function loadKey() {
  if (cachedKey) return cachedKey
  const hex = process.env.SECRET_KEY
  if (!hex || hex.length !== 64) {
    if (!warned) {
      console.warn('[crypto] SECRET_KEY missing or invalid (expected 32-byte hex). Mail routes disabled.')
      warned = true
    }
    return null
  }
  try {
    cachedKey = Buffer.from(hex, 'hex')
    if (cachedKey.length !== 32) {
      cachedKey = null
      if (!warned) {
        console.warn('[crypto] SECRET_KEY decoded length != 32 bytes. Mail routes disabled.')
        warned = true
      }
      return null
    }
    return cachedKey
  } catch (e) {
    if (!warned) {
      console.warn('[crypto] SECRET_KEY decode failed:', e.message)
      warned = true
    }
    return null
  }
}

export function isCryptoReady() {
  return loadKey() !== null
}

export function encrypt(plaintext) {
  const key = loadKey()
  if (!key) throw new Error('SECRET_KEY not configured')
  if (typeof plaintext !== 'string') throw new Error('encrypt expects a string')
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGO, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString('base64')
}

export function decrypt(payload) {
  const key = loadKey()
  if (!key) throw new Error('SECRET_KEY not configured')
  if (typeof payload !== 'string') throw new Error('decrypt expects a base64 string')
  const buf = Buffer.from(payload, 'base64')
  if (buf.length < IV_LENGTH + TAG_LENGTH + 1) throw new Error('encrypted payload too short')
  const iv = buf.subarray(0, IV_LENGTH)
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH)
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return decrypted.toString('utf8')
}

// Variantes pour les tokens OAuth (mailbox_credentials).
// Priorité MAIL_ENCRYPTION_KEY si présente, sinon fallback SECRET_KEY (compat).
let cachedMailKey = null
function loadMailKey() {
  if (cachedMailKey) return cachedMailKey
  const hex = process.env.MAIL_ENCRYPTION_KEY || process.env.SECRET_KEY
  if (!hex || hex.length !== 64) return null
  try {
    const buf = Buffer.from(hex, 'hex')
    if (buf.length !== 32) return null
    cachedMailKey = buf
    return buf
  } catch (e) { return null }
}

export function isMailCryptoReady() {
  return loadMailKey() !== null
}

export function encryptMailToken(plaintext) {
  const key = loadMailKey()
  if (!key) throw new Error('MAIL_ENCRYPTION_KEY (ou SECRET_KEY) non configurée')
  if (typeof plaintext !== 'string') throw new Error('encryptMailToken expects a string')
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGO, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString('base64')
}

export function decryptMailToken(payload) {
  const key = loadMailKey()
  if (!key) throw new Error('MAIL_ENCRYPTION_KEY (ou SECRET_KEY) non configurée')
  if (typeof payload !== 'string') throw new Error('decryptMailToken expects a base64 string')
  const buf = Buffer.from(payload, 'base64')
  if (buf.length < IV_LENGTH + TAG_LENGTH + 1) throw new Error('encrypted payload too short')
  const iv = buf.subarray(0, IV_LENGTH)
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH)
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return decrypted.toString('utf8')
}
