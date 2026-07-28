// Tables RGPD optout — opt-out tiers prospects via /optout (art. 12 RGPD).
//
// optout_request   : file des demandes opt-out, conservation 5 ans
//                    (prescription action RGPD art. 12.3). EXCLUE de la
//                    purge utilisateur 9.16 (cf. server/services/purge-
//                    expired.js — modification ciblée en Étape 6 du brief
//                    Phase 6 pour figer cette exclusion en commentaire).
//
// optout_blocklist : liste persistante des emails/SIRET opt-out (hash
//                    SHA-256), consultée à chaque scraping INSEE pour
//                    exclure silencieusement les tiers déjà opt-out.
//                    EXCLUE de la purge — persistante par construction.
//
// Schéma défini ci-dessous (runOptoutMigration), joué au boot du serveur
// de manière idempotente (DEFINE … IF NOT EXISTS). Calque strict du
// pattern server/services/search-tracker.js (runLeadSearchMigration).
//
// Les helpers métier (insert demande, check blocklist, verify token,
// process admin) seront ajoutés dans des passes ultérieures du brief
// Phase 6 (Étapes 5, 7, 8).

import { getDb } from '../../lib/surreal.js'
import { createHash, randomBytes } from 'crypto'
import { normaliserDomaine } from './rapprochement-osm.js'
import { DOMAINES_PERSO } from '../../lib/import.js'

// ── migration idempotente ──
export async function runOptoutMigration() {
  const db = await getDb()
  const queries = [
    // ── optout_request — file des demandes opt-out tiers ──
    'DEFINE TABLE IF NOT EXISTS optout_request SCHEMAFULL',
    'DEFINE FIELD IF NOT EXISTS email ON optout_request TYPE string',
    'DEFINE FIELD IF NOT EXISTS email_hash ON optout_request TYPE string',
    'DEFINE FIELD IF NOT EXISTS siret ON optout_request TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS siret_hash ON optout_request TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS siren_hash ON optout_request TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS raison ON optout_request TYPE option<string>',
    "DEFINE FIELD IF NOT EXISTS status ON optout_request TYPE string ASSERT $value INSIDE ['pending_verification', 'verified', 'processed', 'rejected', 'expired_unverified']",
    'DEFINE FIELD IF NOT EXISTS verify_token ON optout_request TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS verify_expires_at ON optout_request TYPE option<datetime>',
    'DEFINE FIELD IF NOT EXISTS ip_address ON optout_request TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS user_agent ON optout_request TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS created_at ON optout_request TYPE datetime DEFAULT time::now()',
    'DEFINE FIELD IF NOT EXISTS verified_at ON optout_request TYPE option<datetime>',
    'DEFINE FIELD IF NOT EXISTS processed_at ON optout_request TYPE option<datetime>',
    'DEFINE FIELD IF NOT EXISTS processed_by ON optout_request TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS notes ON optout_request TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS short_ref ON optout_request TYPE option<string>',
    'DEFINE INDEX IF NOT EXISTS idx_optout_request_email_hash ON optout_request FIELDS email_hash',
    'DEFINE INDEX IF NOT EXISTS idx_optout_request_siret_hash ON optout_request FIELDS siret_hash',
    'DEFINE INDEX IF NOT EXISTS idx_optout_request_siren_hash ON optout_request FIELDS siren_hash',
    'DEFINE INDEX IF NOT EXISTS idx_optout_request_verify_token ON optout_request FIELDS verify_token UNIQUE',
    'DEFINE INDEX IF NOT EXISTS idx_optout_request_status ON optout_request FIELDS status',
    'DEFINE INDEX IF NOT EXISTS idx_optout_request_created_at ON optout_request FIELDS created_at',
    'DEFINE INDEX IF NOT EXISTS idx_optout_request_short_ref ON optout_request FIELDS short_ref',
    // ── optout_blocklist — liste persistante hash SHA-256, consultée scraping ──
    'DEFINE TABLE IF NOT EXISTS optout_blocklist SCHEMAFULL',
    'DEFINE FIELD IF NOT EXISTS email_hash ON optout_blocklist TYPE string',
    'DEFINE FIELD IF NOT EXISTS siret_hash ON optout_blocklist TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS siren_hash ON optout_blocklist TYPE option<string>',
    "DEFINE FIELD IF NOT EXISTS source ON optout_blocklist TYPE string ASSERT $value INSIDE ['user_request', 'admin_manual', 'legal_order']",
    'DEFINE FIELD IF NOT EXISTS request_id ON optout_blocklist TYPE option<record<optout_request>>',
    'DEFINE FIELD IF NOT EXISTS blocked_at ON optout_blocklist TYPE datetime DEFAULT time::now()',
    'DEFINE FIELD IF NOT EXISTS notes ON optout_blocklist TYPE option<string>',
    'DEFINE INDEX IF NOT EXISTS idx_optout_blocklist_email_hash ON optout_blocklist FIELDS email_hash',
    'DEFINE INDEX IF NOT EXISTS idx_optout_blocklist_siret_hash ON optout_blocklist FIELDS siret_hash',
    'DEFINE INDEX IF NOT EXISTS idx_optout_blocklist_siren_hash ON optout_blocklist FIELDS siren_hash',
    'DEFINE INDEX IF NOT EXISTS idx_optout_blocklist_source ON optout_blocklist FIELDS source',
    'DEFINE INDEX IF NOT EXISTS idx_optout_blocklist_blocked_at ON optout_blocklist FIELDS blocked_at'
  ]
  for (const q of queries) {
    try { await db.query(q) } catch (e) { console.warn('[optout-migration]', q.slice(0, 80), '→', e.message) }
  }
}

// ── helpers métier opt-out blocklist (Phase 6 Étape 5b) ──

// SHA-256 hex d'un identifiant (SIRET ou email). Normalisation .trim()
// AVANT hash (les SIRET sont déjà des strings de 14 chiffres ; .trim()
// absorbe d'éventuels espaces parasites issus d'un signup futur). Throw
// si entrée invalide : on ne hash jamais du vide (un hash de '' matcherait
// par accident une entrée blocklist mal formée).
export function hashIdentifier(value) {
  if (!value || typeof value !== 'string') {
    throw new TypeError('[optout] hashIdentifier: value doit être une string non vide')
  }
  return createHash('sha256').update(value.trim()).digest('hex')
}

// SIREN (9 chiffres) dérivé d'un SIRET (14 chiffres) : les 9 premiers chiffres
// après normalisation IDENTIQUE à celle de l'écriture (replace(/\s/g,'')) —
// sinon le hash du SIREN ne coïnciderait pas avec celui posé à l'insert et la
// comparaison raterait silencieusement. Le SIREN est dérivable gratuitement
// aux points d'appel (les 9 premiers chiffres du SIRET) et couvre TOUS les
// établissements de l'entreprise. Retourne null si l'entrée ne fournit pas au
// moins 9 caractères — on ne dérive jamais un SIREN tronqué qui matcherait par
// accident une entrée blocklist mal formée.
export function sirenFromSiret(siret) {
  if (!siret || typeof siret !== 'string') return null
  const clean = siret.replace(/\s/g, '')
  if (clean.length < 9) return null
  return clean.slice(0, 9)
}

// Lookup batch blocklist par SIRET, ÉLARGI au SIREN. Retourne le Set des SIRET
// (valeurs d'origine) opt-out. Un SIRET du lot est bloqué s'il matche par son
// hash SIRET OU par le hash de son SIREN dérivé : le SIREN est la clé
// principale (l'accusé de réception parle de « vos données » sans limite
// d'établissement), une entrée blocklist posée au seul SIREN bloque donc TOUS
// les établissements du lot. siret_hash reste interrogé en plus — une entrée
// ancienne ou posée par voie administrative pourrait n'en porter qu'un.
// Exploite les index idx_optout_blocklist_siret_hash / _siren_hash via clauses
// IN. Chunk par 100 (limite défensive WebSocket). Fail-CLOSED : toute erreur DB
// → on bloque TOUT le lot (Set = toutes les entrées valides) + log warn. Un
// droit d'opposition ne peut pas dépendre de la santé de la connexion : dans le
// doute, on s'abstient. Même doctrine que le portillon robots.txt ; à l'échec,
// on bloque. Les onze appelants passent toujours des SIRET SANS CHANGER : la
// dérivation du SIREN est faite ici.
export async function checkBlocklistBatch(sirets) {
  const blocked = new Set()
  if (!Array.isArray(sirets) || sirets.length === 0) return blocked
  // Dédup + filtrage falsy. On indexe chaque SIRET par son hash SIRET, par le
  // hash de son SIREN dérivé, et on retient hash SIREN → SIRET(s) du lot (un
  // même SIREN peut coiffer plusieurs établissements présents dans le lot).
  const siretHashToSiret = new Map()       // hash(SIRET) → SIRET d'origine
  const siretHashToSirenHash = new Map()   // hash(SIRET) → hash(SIREN) dérivé
  const sirenHashToSirets = new Map()      // hash(SIREN) → [SIRET, …] du lot
  for (const s of sirets) {
    if (!s || typeof s !== 'string') continue
    const clean = s.trim()
    if (!clean) continue
    const siretHash = hashIdentifier(clean)
    siretHashToSiret.set(siretHash, clean)
    const siren = sirenFromSiret(clean)
    if (siren) {
      const sirenHash = hashIdentifier(siren)
      siretHashToSirenHash.set(siretHash, sirenHash)
      const list = sirenHashToSirets.get(sirenHash) || []
      list.push(clean)
      sirenHashToSirets.set(sirenHash, list)
    }
  }
  if (siretHashToSiret.size === 0) return blocked
  const siretHashes = [...siretHashToSiret.keys()]
  try {
    const db = await getDb()
    for (let i = 0; i < siretHashes.length; i += 100) {
      const chunk = siretHashes.slice(i, i + 100)
      const sirenChunk = [...new Set(
        chunk.map(h => siretHashToSirenHash.get(h)).filter(Boolean)
      )]
      const result = await db.query(
        'SELECT siret_hash, siren_hash FROM optout_blocklist'
        + ' WHERE siret_hash IN $siretHashes OR siren_hash IN $sirenHashes',
        { siretHashes: chunk, sirenHashes: sirenChunk }
      )
      const rows = result[0] || []
      for (const row of rows) {
        const bySiret = siretHashToSiret.get(row.siret_hash)
        if (bySiret) blocked.add(bySiret)
        const bySiren = sirenHashToSirets.get(row.siren_hash)
        if (bySiren) for (const st of bySiren) blocked.add(st)
      }
    }
  } catch (e) {
    console.warn('[optout] checkBlocklistBatch fail-closed :', e.message)
    return new Set(siretHashToSiret.values())
  }
  return blocked
}

// Lookup unitaire — DRY via checkBlocklistBatch([siret]). true si le SIRET
// est opt-out. Utilisé au refus dur POST /api/pipeline (rempart 2).
export async function checkBlocklistOne(siret) {
  const blocked = await checkBlocklistBatch([siret])
  return blocked.size > 0
}

// Lookup batch blocklist par ADRESSE EMAIL — sœur de checkBlocklistBatch pour
// la clé email_hash. Retourne le Set des emails (valeurs d'origine) opposés.
// Sert le contrôle par adresse des routes d'enrichissement : une opposition
// déposée depuis un fournisseur grand public n'a ni siret_hash ni siren_hash
// (hors résolution domaine du commit 3) — seule son adresse est connue, et
// c'est justement l'adresse (societe_email) que ces routes révèlent.
// Normalisation toLowerCase().trim() AVANT hash — IDENTIQUE à l'écriture
// (insertOptoutRequest : emailNorm = String(email).toLowerCase().trim()), sinon
// la comparaison raterait silencieusement. FAIL-CLOSED comme sa sœur : toute
// erreur DB → on bloque TOUT le lot (Set = toutes les entrées valides) + warn.
export async function checkBlocklistEmailsBatch(emails) {
  const blocked = new Set()
  if (!Array.isArray(emails) || emails.length === 0) return blocked
  const hashToEmail = new Map()
  for (const e of emails) {
    if (!e || typeof e !== 'string') continue
    const clean = e.toLowerCase().trim()
    if (!clean) continue
    hashToEmail.set(hashIdentifier(clean), e)
  }
  if (hashToEmail.size === 0) return blocked
  const hashes = [...hashToEmail.keys()]
  try {
    const db = await getDb()
    for (let i = 0; i < hashes.length; i += 100) {
      const chunk = hashes.slice(i, i + 100)
      const result = await db.query(
        'SELECT email_hash FROM optout_blocklist WHERE email_hash IN $hashes',
        { hashes: chunk }
      )
      const rows = result[0] || []
      for (const row of rows) {
        const email = hashToEmail.get(row.email_hash)
        if (email) blocked.add(email)
      }
    }
  } catch (err) {
    console.warn('[optout] checkBlocklistEmailsBatch fail-closed :', err.message)
    return new Set(hashToEmail.values())
  }
  return blocked
}

// Lookup unitaire — DRY via checkBlocklistEmailsBatch([email]). true si l'email
// est opposé. Utilisé au SECOND filtre des routes d'enrichissement (contrôle par
// adresse), après lecture du référentiel.
export async function checkBlocklistEmailOne(email) {
  const blocked = await checkBlocklistEmailsBatch([email])
  return blocked.size > 0
}

// ── helpers métier demande opt-out + verify (Phase 6 Étape 8) ──

// Génère un token de vérification magic-link. Calque surreal-adapter.js :
// brut = randomBytes(32) base64url (inclus dans le lien email, jamais loggé
// ni stocké), hash SHA-256 hex (seul stocké en base, lookup par hash).
export function generateVerifyToken() {
  const token = randomBytes(32).toString('base64url')
  const tokenHash = createHash('sha256').update(token).digest('hex')
  return { token, tokenHash }
}

// Idempotence anti-double-submit : retourne une demande pending de moins
// d'1h pour le même couple (email_hash, siret_hash), sinon null. Branche
// explicitement sur `siret_hash IS NONE` plutôt que via un param NULL — le
// SDK mappe JS null → NULL, distinct de NONE en SurrealDB, ce qui fausserait
// la comparaison pour les demandes sans SIRET.
export async function findPendingRequest(emailHash, siretHash) {
  const db = await getDb()
  const base = 'SELECT * FROM optout_request WHERE email_hash = $emailHash'
    + " AND status = 'pending_verification' AND created_at > time::now() - 1h"
  const query = siretHash
    ? base + ' AND siret_hash = $siretHash LIMIT 1'
    : base + ' AND siret_hash IS NONE LIMIT 1'
  const params = siretHash ? { emailHash, siretHash } : { emailHash }
  const result = await db.query(query, params)
  return result[0]?.[0] || null
}

// Crée une demande opt-out en statut pending_verification. Stocke le HASH du
// token (jamais le brut). Les champs optionnels (siret, ip, user_agent) ne
// sont posés que s'ils sont présents (option<string> = string|NONE — on évite
// d'assigner NULL). Datetimes via time::now() côté DB. Retourne
// { request, token } : token BRUT pour le lien email, à ne jamais logger.
export async function insertOptoutRequest({ email, siret, ip, userAgent }) {
  const db = await getDb()
  const emailNorm = String(email || '').toLowerCase().trim()
  const siretNorm = siret ? String(siret).replace(/\s/g, '') : null
  // Un numéro d'établissement saisi par l'opposant est ÉLARGI à son SIREN,
  // jamais conservé au seul SIRET : le SIREN est la clé principale.
  const sirenNorm = siretNorm ? sirenFromSiret(siretNorm) : null
  const emailHash = hashIdentifier(emailNorm)
  const siretHash = siretNorm ? hashIdentifier(siretNorm) : null
  const sirenHash = sirenNorm ? hashIdentifier(sirenNorm) : null
  const { token, tokenHash } = generateVerifyToken()
  // Référence courte lisible (6 hex aléatoires → MUP-OPT-A3F9C1). Stockée +
  // indexée pour la recherche backend par référence. Collision négligeable
  // au volume opt-out (16,7M combinaisons).
  const shortRef = 'MUP-OPT-' + randomBytes(3).toString('hex').toUpperCase()

  const fields = [
    'email = $email',
    'email_hash = $emailHash',
    "status = 'pending_verification'",
    'verify_token = $tokenHash',
    'short_ref = $shortRef',
    'verify_expires_at = time::now() + 24h',
    'created_at = time::now()'
  ]
  const params = { email: emailNorm, emailHash, tokenHash, shortRef }
  if (siretNorm) {
    fields.push('siret = $siret', 'siret_hash = $siretHash')
    params.siret = siretNorm
    params.siretHash = siretHash
  }
  // siren_hash reporté dès qu'un SIRET est fourni (élargissement à l'entreprise).
  // Pas de champ SIREN clair stocké — minimisation art. 5.1.c, comme le hash.
  if (sirenHash) {
    fields.push('siren_hash = $sirenHash')
    params.sirenHash = sirenHash
  }
  // IP hashée en base (cohérence email_hash/siret_hash, minimisation
  // art. 5.1.c) ; l'IP claire ne sert qu'au rate-limit middleware en amont,
  // jamais affichée ni au tiers ni dans l'email.
  if (ip) { fields.push('ip_address = $ip'); params.ip = hashIdentifier(String(ip)) }
  if (userAgent) { fields.push('user_agent = $userAgent'); params.userAgent = String(userAgent) }

  const result = await db.query(`CREATE optout_request SET ${fields.join(', ')}`, params)
  const request = result[0]?.[0] || null
  return { request, token, shortRef }
}

// Résolution DÉTERMINISTE domaine → SIREN pour l'opposition sans numéro
// d'établissement (cas nominal RGPD 3, ~6 sur 10). Le domaine de l'adresse
// professionnelle — la partie après l'arobase — désigne l'entreprise sans
// interprétation ; on le rapproche du champ website de referentiel_societes.
// Retourne le SIREN (string 9 chiffres, normalisé comme sirenFromSiret) ou
// null. RÈGLES :
//  - fournisseur grand public (DOMAINES_PERSO) → null d'emblée : un gmail /
//    orange / wanadoo ne désigne aucune entreprise ;
//  - correspondance EXACTE de domaine uniquement (normaliserDomaine côté JS),
//    jamais d'approximation sur le nom ni de match partiel. Le pré-filtre DB
//    string::contains ne fait que borner le transfert (website NON indexé →
//    full scan, mais événement rare : un clic de vérification) ;
//  - plusieurs fiches peuvent porter le même domaine (établissements d'une même
//    entreprise) : SIREN unique → posé ; SIREN divergents → AMBIGU, on
//    journalise et on ne pose rien plutôt que de choisir au hasard.
export async function resolveSirenByDomain(email) {
  const addr = String(email || '').toLowerCase().trim()
  const at = addr.lastIndexOf('@')
  if (at < 0 || at === addr.length - 1) return null
  const domaine = addr.slice(at + 1).trim()
  if (!domaine || DOMAINES_PERSO.has(domaine)) return null

  const db = await getDb()
  const rows = (await db.query(
    'SELECT siren, website FROM referentiel_societes'
    + " WHERE website IS NOT NONE AND website != ''"
    + ' AND string::contains(string::lowercase(website), $needle)',
    { needle: domaine }
  ))[0] || []

  const sirens = new Set()
  for (const row of rows) {
    if (normaliserDomaine(row.website) !== domaine) continue // EXACT seul
    const siren = sirenFromSiret(String(row.siren || ''))
    if (siren) sirens.add(siren)
  }
  if (sirens.size === 0) return null
  if (sirens.size > 1) {
    console.warn(
      `[optout] résolution domaine AMBIGUË ${domaine} → SIREN divergents (${[...sirens].join(', ')}) : aucune écriture`
    )
    return null
  }
  return [...sirens][0]
}

// Consomme un token de vérification : passe la demande en 'verified' puis
// l'inscrit dans optout_blocklist. Lookup par hash du token. source =
// 'user_request' (valeur imposée par l'ASSERT du schéma Étape 4 :
// INSIDE ['user_request','admin_manual','legal_order'] — 'optout_request'
// n'est PAS une valeur acceptée). Liens record via type::record (pattern
// purge-expired.js). Re-clic = SELECT vide (status déjà 'verified') →
// invalid_or_expired, ce qui prévient aussi le doublon blocklist.
export async function verifyOptoutToken(token) {
  if (!token || typeof token !== 'string') {
    return { ok: false, reason: 'invalid_or_expired' }
  }
  const db = await getDb()
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const sel = await db.query(
    'SELECT * FROM optout_request WHERE verify_token = $tokenHash'
    + " AND status = 'pending_verification' AND verify_expires_at > time::now() LIMIT 1",
    { tokenHash }
  )
  const request = sel[0]?.[0]
  if (!request) {
    // Re-clic idempotent : token déjà consommé (status 'verified'). Succès
    // silencieux SANS ré-insertion blocklist (art. 12 transparence — l'action
    // a déjà été faite, on n'affiche pas d'erreur au tiers).
    const done = await db.query(
      "SELECT short_ref, id FROM optout_request WHERE verify_token = $tokenHash AND status = 'verified' LIMIT 1",
      { tokenHash }
    )
    const doneReq = done[0]?.[0]
    if (doneReq) return { ok: true, alreadyVerified: true, requestId: doneReq.short_ref || String(doneReq.id) }
    return { ok: false, reason: 'invalid_or_expired' }
  }

  const reqId = String(request.id).replace(/^optout_request:/, '').replace(/^⟨+|⟩+$/g, '')

  await db.query(
    "UPDATE type::record('optout_request', $reqId) SET status = 'verified', verified_at = time::now()",
    { reqId }
  )

  const blockFields = [
    'email_hash = $emailHash',
    "source = 'user_request'",
    "request_id = type::record('optout_request', $reqId)",
    'blocked_at = time::now()'
  ]
  const blockParams = { emailHash: request.email_hash, reqId }
  if (request.siret_hash) {
    blockFields.push('siret_hash = $siretHash')
    blockParams.siretHash = request.siret_hash
  }
  // Élargissement systématique au SIREN (clé principale de l'opposition) : le
  // siren_hash est déjà porté par la demande (insertOptoutRequest), on le
  // re-dérive du SIRET clair en filet de sécurité pour une demande pending
  // antérieure à l'introduction du champ. Une opposition posée sur un
  // établissement vaut ainsi pour l'entreprise entière.
  let sirenHash = request.siren_hash || null
  if (!sirenHash && request.siret) {
    const siren = sirenFromSiret(request.siret)
    if (siren) sirenHash = hashIdentifier(siren)
  }
  // Cas nominal RGPD 3 : opposition sans numéro d'établissement (ni siret_hash
  // ni siren_hash). Résolution DÉTERMINISTE du domaine de l'adresse vers le
  // SIREN via le website du référentiel. FAIL-SAFE ABSOLU : toute erreur laisse
  // l'opposition enregistrée telle quelle — c'est le droit de la personne, il
  // ne peut dépendre du succès d'une requête d'agrément. Le contrôle par
  // adresse (commit 4) prend le relais à défaut de résolution.
  if (!sirenHash && request.email) {
    try {
      const siren = await resolveSirenByDomain(request.email)
      if (siren) sirenHash = hashIdentifier(siren)
    } catch (e) {
      console.warn('[optout] résolution domaine→SIREN échouée (opposition enregistrée) :', e.message)
    }
  }
  if (sirenHash) {
    blockFields.push('siren_hash = $sirenHash')
    blockParams.sirenHash = sirenHash
  }
  await db.query(`CREATE optout_blocklist SET ${blockFields.join(', ')}`, blockParams)

  return {
    ok: true,
    alreadyVerified: false,
    requestId: request.short_ref || String(request.id),
    email: request.email,
    verifiedAt: new Date().toISOString()
  }
}
