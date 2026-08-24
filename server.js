if(process.env.NODE_ENV !== 'production'){
  await import('dotenv/config')
}
import express from 'express'
import helmet from 'helmet'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { readFile } from 'fs/promises'
import { createHash } from 'crypto'
import nodemailer from 'nodemailer'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { getDb } from './lib/surreal.js'
import { startWatchdog } from './lib/watchdog.js'
import { encrypt, decrypt, isCryptoReady } from './lib/crypto.js'
import { getUserId, requireUserId } from './lib/auth.js'
import { cleanRecordId } from './lib/db.js'
import { normaliserSociete, comparerNumero, parserAdresseAgregee, voiesConcordent } from './lib/societes.js'
import { libelleFormeJuridique } from './lib/formes-juridiques.js'
import { analyserImport, analyserImportDetaille } from './lib/import.js'
import { normalizePersonFields } from './lib/person-fields.js'
import { router as authRouter } from './server/auth/routes.js'
import { router as stripeRouter, webhookHandler as stripeWebhookHandler } from './server/routes/stripe.js'
import { requireAuth, requireAuthHtml, readSessionToken } from './server/middleware/requireAuth.js'
import { requireActiveSubscription } from './server/middleware/subscription.js'
import { requireSuperadmin } from './server/middleware/requireSuperadmin.js'
import { deriveAppState } from './lib/derive-app-state.js'
import { runAuthMigration, invalidateSessionCacheByUserId, getSession, getSchemaFailureCount } from './server/auth/surreal-adapter.js'
import { runLeadSearchMigration, trackLeadSearch, getSearchHistory, trackContactEdit, trackEnrichAttempt, nettoyerSearchId, grouperRecherches, compterUsageParRecherche } from './server/services/search-tracker.js'
import { getInseeToken } from './server/services/insee.js'
import {
  runOptoutMigration,
  checkBlocklistBatch,
  checkBlocklistOne,
  checkBlocklistEmailOne,
  hashIdentifier,
  findPendingRequest,
  insertOptoutRequest,
  verifyOptoutToken
} from './server/services/optout.js'
import { runReferentielMigration, upsertReferentiel, enrichReferentielActionnable, markGisementComplete } from './server/services/referentiel.js'
import { runReferentielOsmMigration } from './server/services/referentiel-osm.js'
import { runActualitesMigration, lireActualites } from './server/services/actualites.js'
import { runReferentielAtoutFranceMigration } from './server/services/referentiel-atout-france.js'
import { chargerAtoutFrance } from './server/services/atout-france.js'
import { runReferentielRgeMigration } from './server/services/referentiel-rge.js'
import { chargerRge } from './server/services/rge.js'
import { runVisitesMigration, creerMesureAudience, visiteursALInstant, etatVivant, jourParis, decalerJour } from './server/services/visites.js'
import { BYPASS_EMAIL, isOwner } from './lib/vip.js'
import { getReferentielContactBySiret, getOsmContactBySiret, selectSiretsACrawler, getReferentielFaisceauBySiret, isGisementComplete, readReferentiel, countReferentielFresh } from './server/services/referentiel-read.js'
import { projeterReferentiel, retirerProjection } from './server/services/projection-referentiel.js'
import { lookupBusinessInfo } from './server/services/dataforseo.js'
import { rapprocherDepartement } from './server/services/rapprochement-osm.js'
import { rapprocherDepartementAtoutFrance } from './server/services/rapprochement-atout-france.js'
import { runMentionsLegalesJob, enrichirMentionsLegales } from './server/services/mentions-legales.js'
import { hostBlacklisted } from './server/services/recherche-web.js'
import { resoudrePositionMeteo } from './server/services/meteo-position.js'
import { sendOptoutVerify, sendOptoutAcknowledged, sendOptoutInternalNotification, sendAccountDeletionScheduled } from './server/services/email.js'
import { startCronJobs, startActualitesCron } from './server/services/cron.js'
import {
  getEffectivePlan,
  getLeadLimit,
  getLeadsConsumed,
  applyMonthlyReset,
  hasEnriched,
  markEnriched,
  consumeLead,
  porteCanalDecomptable,
  PLAN_LEAD_LIMITS
} from './server/config/plan-quotas.js'
import { PLANS as PRICING_PLANS, PLANS_ORDER } from './server/config/pricing-doctrine.js'
import {
  sendOne as mailServiceSendOne,
  getMailStatus as mailServiceStatus,
  isResendReady,
  verifyResendDomain,
  getResendDomainStatus,
  sendCampaign as mailServiceSendCampaign,
  verifyResendSignature,
  listMailboxCredentials,
  listGoogleMessages,
  listImapMessages,
  listMicrosoftMessages,
  getImapMessageBody,
  getGoogleMessageBody,
  getMicrosoftMessageBody,
  markImapMessageSeen,
  markGoogleMessageRead,
  getImapAccount,
  classifyMailError,
  sendWelcomeEmail,
  mailboxCredentialId,
  domainOf,
  listVerifiedResendDomains,
  isVerifiedResendSender,
  htmlToText
} from './lib/mail-service.js'
import {
  apposeSignature,
  chargeSignature,
  signatureEnSortie,
  motifLogoRefuse,
  DISPOSITIONS,
  TEXTE_LONGUEUR_MAX,
  LOGO_LARGEUR_ENCODEE_MAX,
  LOGO_HAUTEUR_ENCODEE_MAX
} from './lib/mail-signature.js'
import {
  litPieceDataUrl,
  motifPieceRefusee,
  nettoieNomFichier,
  pieceEnSortie,
  chargePiece,
  listeDevisSignes,
  PIECE_CORPS_LIMITE
} from './lib/piece-signee.js'
// Le logo du compte, en tête des devis. Trois noms de ce module portent ceux du
// module de signature de courriel juste au-dessus (même patron, bornes
// différentes) : ils sont renommés à l'entrée plutôt que de laisser deux
// plafonds de logo se répondre sous une seule identité.
import {
  chargeLogoCompte,
  logoEnSortie,
  motifLogoRefuse as motifLogoCompteRefuse,
  LOGO_LARGEUR_ENCODEE_MAX as LOGO_COMPTE_LARGEUR_MAX,
  LOGO_HAUTEUR_ENCODEE_MAX as LOGO_COMPTE_HAUTEUR_MAX
} from './lib/logo-compte.js'
import { controleAuthentification, redigeAnnonce } from './lib/mail-authentification.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()

// Indispensable derrière le proxy Railway : sans ça, req.ip = IP du proxy
// pour TOUTES les requêtes → rate-limit global inutilisable + getClientIp()
// remonte mauvaise IP dans audit_log. trust proxy = 1 = un seul niveau de
// proxy (Railway/Cloudflare).
app.set('trust proxy', 1)

// ── Webhook Stripe — DOIT être enregistré AVANT express.json() global ──
// Stripe envoie le payload brut, la signature est calculée sur ce buffer.
// Si express.json() avait déjà tourné, le body serait parsé et la signature
// invalidée. Cette route consomme uniquement le raw body.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler)

// ── Parseur étroit du dépôt de devis signé ────────────────────────────────
// Monté AVANT le parseur global, et gardé par MÉTHODE et par CHEMIN : lui seul
// accepte un corps au-delà des 10 Mo globaux, et seulement sur le dépôt d'une
// pièce signée. Tout le reste de l'application garde son plafond.
//
// POURQUOI AVANT, et non au niveau de la route. body-parser ne parse qu'une
// fois : le parseur global aurait déjà lu le corps (et posé req._body), un
// second parseur posé sur la route ne verrait plus rien à faire. C'est
// exactement ce qui arrive à visioBgJson, plus bas, qui ne desserre donc rien.
// Un PDF de 8 Mo pèse 11 Mo une fois en base64 : sous le seul parseur global,
// il finirait en 413 opaque, posé avant toute garde applicative, là où l'abonné
// attend le motif rédigé par motifPieceRefusee.
//
// Le plafond vient de PIECE_CORPS_LIMITE, dérivé du plafond en octets décodés
// (lib/piece-signee.js) : les deux valeurs ne peuvent pas diverger. La marge
// entre les deux (8 Mo admis, 12 Mo de corps toléré) est là pour que tout
// fichier REFUSÉ pour son poids le soit par motifPieceRefusee, en 400 rédigé,
// et non par le parseur. Au-delà, le 413 redevient muet : c'est à la page de
// mesurer le fichier avant de l'envoyer.
//
// Ce parseur tourne avant requireAuth, comme le global : il accepte donc de
// lire ce corps avant de savoir qui appelle. C'est déjà le cas des 10 Mo
// globaux, et le chemin gardé restreint la surface à une seule route.
//
// req.rawBody n'est pas capturé ici : il ne sert qu'à la validation HMAC des
// webhooks Resend, qui n'empruntent pas ce chemin.
const pieceSigneeJson = express.json({ limit: PIECE_CORPS_LIMITE })
const CHEMIN_DEPOT_PIECE = /^\/api\/devis\/[^/]+\/signature\/?$/i
app.use((req, res, next) => {
  if (req.method !== 'PUT') return next()
  if (!CHEMIN_DEPOT_PIECE.test(req.path)) return next()
  return pieceSigneeJson(req, res, next)
})

// `verify` capture le rawBody pour la validation HMAC des webhooks Resend (Svix).
// Ne change rien à `req.body` parsé — ajoute juste `req.rawBody` (string).
app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8') }
}))

// ─── DURCISSEMENT INFRA — helmet + rate-limit + origin check ───
// Posés APRÈS express.json et AVANT toute route /api/*. Le webhook Stripe
// (ligne 47, raw body) répond et termine sans next() — il n'atteint jamais
// ces middlewares (vérifié grep stripeWebhookHandler).

// Helmet — headers sécurité standards. CSP désactivé en V1 (à activer V1.1
// après audit complet des inline scripts/styles du frontend).
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}))

// Rate-limit global sur /api/* — 200 req/min/IP par défaut. Skips :
//   - /health (liveness probe)
//   - /stripe/webhook (signature HMAC, peut burst sur événements Stripe)
//   - /v2/webhooks/* (Resend, Svix HMAC vérifié)
// Note : req.path est relatif au mount '/api' → skip avec paths sans préfixe.
// Rate-limit existant sur /api/auth/* (5/15min, plus strict, custom in-memory)
// reste actif et empile au-dessus de celui-ci.
// 200 = 54 × 3. 54 : une minute de navigation réelle sur les pages les plus
// lourdes (tableau de bord 10 + visio 25 + fiche contact 11 + un retour
// d'onglet 8). ×3 : la clé de comptage est l'ADRESSE, pas le compte — trois
// abonnés derrière une même connexion, ou un abonné avec trois onglets,
// partagent ce plafond. L'ancienne valeur de 60 était dépassée par une seule
// minute d'usage normal.
const RATE_LIMIT_GLOBAL_MAX = parseInt(process.env.RATE_LIMIT_GLOBAL_MAX || '200', 10)
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10)

const globalApiLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_GLOBAL_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    return req.path === '/health'
        || req.path === '/stripe/webhook'
        || req.path.startsWith('/v2/webhooks/')
        || req.path.startsWith('/geocode')
        || req.path.startsWith('/sirene')
        || req.path.startsWith('/search')
        || req.path === '/dev/reset-contacts'  // outil dev : purge en 1 requête, hors 60/min
  }
})
app.use('/api', globalApiLimiter)

// Limiters dédiés aux endpoints proxy à fort volume légitime sur /prospection.
// Géocodage : la queue front cadence ~6.6 req/s = ~400/min en pic.
// SIRENE : pagination upstream + recherches successives.
// keyGenerator par défaut (ipKeyGenerator v8 = IPv6 /64, IPv4 par adresse).
const geocodeLimiter = rateLimit({
  windowMs: 60_000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limit_exceeded', detail: 'Trop de requêtes de géocodage, patientez un instant.' }
})
const sireneLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limit_exceeded', detail: 'Trop de recherches, patientez un instant.' }
})
const searchLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limit_exceeded', detail: 'Trop de recherches, patientez un instant.' }
})
app.use('/api/geocode', geocodeLimiter)
app.use('/api/sirene', sireneLimiter)
app.use('/api/search', searchLimiter)

// Rate-limit dédié opt-out — 3 req/24h/IP. Borne le flood de demandes
// d'opposition (anti-abus + anti-énumération). keyGenerator par req.ip
// (trust proxy = 1 → IP fiable). Message orienté tiers avec voie alternative
// dpo@movup.io pour les IP partagées (coworking, cabinet).
const optoutLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  message: {
    error: 'rate_limit_exceeded',
    detail: 'Trop de demandes depuis cette adresse. Veuillez réessayer dans quelques heures, ou contactez dpo@movup.io.'
  }
})

// Origin/Referer check sur méthodes mutantes /api/* — 403 si l'origine
// n'est pas dans la whitelist. SameSite=Lax couvre déjà la plupart des CSRF,
// c'est une 2e couche défensive. Skip webhooks externes (Stripe, Resend)
// qui n'envoient pas d'Origin.
const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS
  || 'https://movup.io,https://www.movup.io,https://mup-production.up.railway.app,http://localhost:8080')
  .split(',').map(s => s.trim()).filter(Boolean)

app.use('/api', (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next()
  if (req.path === '/stripe/webhook') return next()
  if (req.path.startsWith('/v2/webhooks/')) return next()

  // Origin (schéma+hôte) ou fallback Referer (URL complète) → réduits à leur
  // origine seule via URL().origin, puis égalité stricte contre l'allowlist.
  // Neutralise le contournement par préfixe (ex. https://movup.io.evil.com).
  const raw = req.get('Origin') || req.get('Referer') || ''
  let origin = ''
  try { origin = raw ? new URL(raw).origin : '' } catch { origin = '' }
  const isAllowed = origin !== '' && ALLOWED_ORIGINS.includes(origin)
  if (!isAllowed) {
    return res.status(403).json({ error: 'Origin not allowed' })
  }
  next()
})

const DEFAULT_USER_ID = process.env.MUP_DEFAULT_USER_ID || 'default'

// Derive IMAP host/port from SMTP config when IMAP fields are absent (V1 onboarding).
function deriveImapFromSmtp(host) {
  if (!host || typeof host !== 'string') return null
  return host.replace(/^smtp\./i, 'imap.')
}

// Strip secrets from a record before returning to client.
function stripSettingsSecrets(rec) {
  if (!rec) return rec
  const { smtp_pass_encrypted, imap_pass_encrypted, ...safe } = rec
  return {
    ...safe,
    configured: Boolean(smtp_pass_encrypted),
    has_imap: Boolean(imap_pass_encrypted)
  }
}

// Strip secrets from a mailbox_credentials / mail_settings record before
// returning to client. Couvre les champs des 2 tables :
//   - imap_password_encrypted, smtp_pass_encrypted (mail_settings v2)
//   - imap_pass_encrypted (mail_settings v1)
//   - accessToken, refreshToken (mailbox_credentials OAuth Google/Microsoft)
//   - password (paranoïa : ne devrait jamais être en clair en DB)
// Renvoie flags booléens utiles à l'UI.
function stripMailboxSecrets(rec) {
  if (!rec) return rec
  const {
    smtp_pass_encrypted,
    imap_pass_encrypted,
    imap_password_encrypted,
    accessToken,
    refreshToken,
    password,
    ...safe
  } = rec
  return {
    ...safe,
    configured: Boolean(smtp_pass_encrypted || imap_password_encrypted || accessToken),
    has_imap: Boolean(imap_password_encrypted || imap_pass_encrypted),
    has_smtp: Boolean(smtp_pass_encrypted),
    has_oauth: Boolean(accessToken || refreshToken)
  }
}

function requireCrypto(res) {
  if (!isCryptoReady()) {
    res.status(503).json({ error: 'Mail non configuré sur le serveur — SECRET_KEY absente' })
    return false
  }
  return true
}

function hashMessageId(messageId) {
  return createHash('sha256').update(String(messageId)).digest('hex').slice(0, 24)
}

// Idempotent upsert: CREATE if absent, UPDATE if AlreadyExists.
// Caller passes a hardcoded table name (never user input) and a clean id.
async function upsertRecord(db, table, cleanId, body) {
  const cleanBody = { ...body }
  delete cleanBody.id
  const createSql = `CREATE type::record("${table}", $id) CONTENT $body`
  const updateSql = `UPDATE type::record("${table}", $id) CONTENT $body`
  try {
    const result = await db.query(createSql, { id: cleanId, body: cleanBody })
    return { record: result[0]?.[0] || result[0] || null, status: 201, action: 'created' }
  } catch (e) {
    const isAlreadyExists =
      e?.name === 'AlreadyExistsError' ||
      e?.kind === 'AlreadyExists' ||
      String(e?.message || '').includes('already exists')
    if (!isAlreadyExists) throw e
    // Garde multi-tenant : un UPDATE ne doit jamais écraser le record d'un autre
    // tenant. cleanBody.userId est TOUJOURS l'userId de session (posé par chaque
    // appelant : body = { ...req.body, userId } ou payload.userId = session). On
    // relit l'appartenance du record préexistant ; si elle diffère, on refuse en
    // 404 — aligné sur le pattern des PUT/:id. Table hardcodée (jamais user input).
    const ownerRows = await db.query(`SELECT userId FROM type::record("${table}", $id)`, { id: cleanId })
    const existing = ownerRows[0]?.[0]
    if (existing && String(existing.userId) !== String(cleanBody.userId)) {
      return { record: { error: 'not_found' }, status: 404, action: 'denied' }
    }
    const result = await db.query(updateSql, { id: cleanId, body: cleanBody })
    return { record: result[0]?.[0] || result[0] || null, status: 200, action: 'updated' }
  }
}

// Lecture tolérante aux tables jamais créées. Sur une instance neuve, une table
// SurrealDB n'existe qu'après son premier write ; un SELECT avant cela jette
// "table does not exist". Ce cas = résultat vide, pas une panne. On ne neutralise
// QUE ce message ; toute autre erreur (réseau, auth, syntaxe) remonte à l'appelant
// et finit en 500 comme avant. Renvoie les lignes du 1er statement (result[0] || []).
async function queryOrEmpty(db, sql, params) {
  try {
    const result = await db.query(sql, params)
    return result[0] || []
  } catch (err) {
    if (String(err?.message || '').includes('does not exist')) return []
    throw err
  }
}

app.get('/api/health', async (req, res) => {
  const status = {
    server: 'ok',
    timestamp: new Date().toISOString(),
    // Référence du commit déployé, posée par Railway au runtime. Repli explicite
    // si absente (dev local, ou service non relié à un dépôt) : vérifier qu'un
    // déploiement est en ligne ne demande plus de guetter une chaîne dans le HTML.
    commit: process.env.RAILWAY_GIT_COMMIT_SHA || 'unknown',
    // Nombre de définitions de schéma ayant échoué au démarrage (runAuthMigration).
    // Le boot ne casse pas dessus : on rend visible, on ne fait pas échouer.
    schema_failures: getSchemaFailureCount(),
    surreal: 'unknown'
  }
  try {
    const db = await getDb()
    // Timeout dur : sans borne, la requête peut pendre indéfiniment sur une
    // socket morte et /api/health ne rend jamais. Railway n'appelle le
    // healthcheck qu'au déploiement, mais un curl externe qui pend masque un
    // process HS ; 5 s => même branche 503 que l'échec.
    let to
    await Promise.race([
      db.query('INFO FOR DB;'),
      new Promise((_, rej) => { to = setTimeout(() => rej(new Error('health query timeout')), 5000) })
    ])
    clearTimeout(to)
    status.surreal = 'ok'
    status.surreal_namespace = process.env.SURREAL_NAMESPACE
    status.surreal_database = process.env.SURREAL_DATABASE
  } catch(err){
    status.surreal = 'error'
    status.surreal_error = err.message
    return res.status(503).json(status)
  }
  res.json(status)
})

// ── Auth Phase 1 — routes publiques /api/auth/* ──
app.use('/api/auth', authRouter)

// ── Stripe (Checkout + Portal) — exempté de la gate auth + subscription ──
// Le webhook est déjà mounté avant express.json (raw body). Ces 2 routes
// utilisent JSON normal et exigent l'auth via requireAuth en route-level.
app.use('/api/stripe', stripeRouter)

// ── Démo publique landing — proxy /api/search anonymisé ──
// Mounté AVANT la gate auth. Retourne :
//   { total, totalCapped, preview[5], markers[<=500] }
//
// Filtrage région : recherche-entreprises.api.gouv.fr ignore `code_region`
// (renvoie le siège social, souvent IDF pour les chaînes nationales).
// On utilise `departement=CSV` : pour Bretagne (code 53) → "22,29,35,56".
//
// Sélection lat/lng : pour chaque résultat on pioche dans matching_etablissements
// le premier établissement physiquement dans la région (CP commençant par
// l'un des départements). Le `siege` n'est utilisé qu'en dernier recours
// (et seulement si son CP appartient bien à la région).
//
// recherche-entreprises plafonne `total_results` à 10 000 — au-delà on retourne
// `totalCapped: true` pour que le front affiche "10 000+".

// ── Filtre qualité fiches ──
// Une fiche est "prospectable" si :
//   1. au moins un dirigeant identifié (personne physique avec nom/prenoms,
//      ou personne morale avec denomination)
//   2. etat_administratif === 'A' (entreprise active — exclut les liquidations
//      finalisées et les radiations)
//   3. nature_juridique pas dans la liste exclue (54xx SCI patrimoniales,
//      71/72/73 organismes publics, 74 droit étranger)
//
// Limite connue : l'API gouv recherche-entreprises N'EXPOSE PAS de champ
// procedures_collectives / en_redressement / en_liquidation. Le filtre
// etat_administratif === 'A' capture seulement les liquidations CLÔTURÉES,
// pas les redressements en cours. Pour ces derniers il faudrait enrichir
// via Pappers ou BODACC en Phase 2.5.
// Préfixes nature juridique exclus de la prospection :
//   (aucun) — les organismes publics (71 administration publique,
//   72 collectivités territoriales, 73 établissements administratifs) et le
//   droit étranger (74) ne sont PLUS exclus : quand on recherche un secteur
//   donné (ex. 8710A EHPAD), un établissement public de ce secteur est une
//   cible valide. La recherche étant bornée par le code NAF, aucun risque
//   inter-secteur. Les EHPAD étant majoritairement publics/associatifs, les
//   exclure vidait le résultat.
// Les SARL/EURL (préfixe 54) sont la majorité des PME/TPE françaises,
// cible commerciale légitime → NE PAS exclure.
const EXCLUDED_NATURE_JURIDIQUE_PREFIXES = []

function hasNamedDirigeant(item) {
  const dirs = item && item.dirigeants
  if (!Array.isArray(dirs) || dirs.length === 0) return false
  for (const d of dirs) {
    if (!d || typeof d !== 'object') continue
    const nom = typeof d.nom === 'string' ? d.nom.trim() : ''
    const prenoms = typeof d.prenoms === 'string' ? d.prenoms.trim() : ''
    const denom = typeof d.denomination === 'string' ? d.denomination.trim() : ''
    if (nom || prenoms || denom) return true
  }
  return false
}

// allowInactive : consultation CIBLÉE (recherche par identifiant SIRET/SIREN saisi
// volontairement). Une recherche de masse FILTRE l'activité ; une consultation ciblée
// INFORME — elle ne doit pas MASQUER un établissement fermé délibérément recherché.
// L'état reste porté par la fiche (etat_administratif) pour signalement en aval.
// N'assouplit QUE le filtre d'activité ; diffusion RGPD et opt-out restent appliqués.
function isProspectable(item, allowInactive = false) {
  if (!item) return false
  if (!allowInactive && item.etat_administratif !== 'A') return false
  const nat = typeof item.nature_juridique === 'string' ? item.nature_juridique : ''
  if (nat && EXCLUDED_NATURE_JURIDIQUE_PREFIXES.some(p => nat.startsWith(p))) return false
  // hasNamedDirigeant N'EST PLUS bloquant : un établissement sans dirigeant
  // exposé dans Etalab (typiquement un organisme public/associatif comme un
  // EHPAD) reste prospectable via son contact d'établissement.
  return true
}

// ── isServedAddressActive — l'ADRESSE servie est-elle ouverte ? ──────────────
// isProspectable teste l'ENTREPRISE (etat_administratif racine = unité légale) ;
// ce test-ci porte sur l'ÉTABLISSEMENT retenu par pickLocalEtab — l'adresse
// réellement servie à l'abonné, qui peut être fermée alors que l'unité légale
// reste active. Miroir STRICT du filtre d'ÉCRITURE (referentiel.js,
// upsertReferentiel : etatAdm = état de l'étab servi, repli fiche, skip si ≠ 'A')
// — on masque à la lecture exactement ce qu'on n'écrit plus. Le repli sur l'état
// de la fiche est identique à l'écriture : quand l'étab ne porte pas d'état,
// l'unité légale (déjà filtrée par isProspectable) fait foi ; le test ne mord
// donc QUE sur une adresse explicitement fermée d'une entreprise active.
// allowInactive : même exemption qu'isProspectable — une recherche par
// identifiant volontaire VOIT l'adresse fermée, elle ne la masque pas.
function isServedAddressActive(etab, fiche, allowInactive = false) {
  if (allowInactive) return true
  const trim = v => (typeof v === 'string' ? v.trim() : '')
  const etatAdm = trim(etab?.etat_administratif) || trim(fiche?.etat_administratif)
  return etatAdm === 'A'
}

// ── Filtre diffusion INSEE (Phase 6 Étape 15 — droit d'opposition SIRENE) ──
// L'INSEE permet aux entrepreneurs individuels de s'opposer à la diffusion de
// leurs données SIRENE (loi République numérique 2016 art.1 ; art. L.1 CRPA).
// Le champ statut_diffusion porte cette opposition :
//   'O' = diffusion publique autorisée  → fiche conservée (cas nominal)
//   'P' = diffusion partielle (depuis le 21/03/2023, remplace l'ancien 'N')
//   'N' = non-diffusible (résiduel obsolète)
// Règle conservatrice : fiche conservée UNIQUEMENT si TOUS les champs
// statut_diffusion attendus valent strictement 'O'. Toute autre valeur (P, N,
// ou future) exclut la fiche silencieusement (anti-revelation : aucun message
// « X masquées », aucun log de SIRET). Un champ ABSENT exclut la fiche
// (variante stricte, fail-open en faveur des personnes concernées — cf.
// Doctrine 2 LIA-MOVUP-001 v1.1, commit 1aaedcb).
// Deux nominations selon la source :
//   etalab : statut_diffusion (racine) + statut_diffusion_etablissement
//            (siege + matching_etablissements[])
//   insee  : statutDiffusionEtablissement (racine étab.) +
//            uniteLegale.statutDiffusionUniteLegale
function isFullyDiffusible(record, source) {
  if (!record || typeof record !== 'object') return false
  if (source === 'etalab') {
    if (record.statut_diffusion !== 'O') return false
    const s = record.siege
    if (!s || s.statut_diffusion_etablissement !== 'O') return false
    if (Array.isArray(record.matching_etablissements)) {
      for (const e of record.matching_etablissements) {
        if (!e || e.statut_diffusion_etablissement !== 'O') return false
      }
    }
    return true
  }
  if (source === 'insee') {
    if (record.statutDiffusionEtablissement !== 'O') return false
    const ul = record.uniteLegale
    if (!ul || ul.statutDiffusionUniteLegale !== 'O') return false
    return true
  }
  return false
}

// ── deptMatchCp — un CP appartient-il au périmètre de départements demandé ?
// Cas général : préfixe CP (2 car.) ∈ allowedDepts. Cas Corse : le code
// département est 2A/2B mais les CP corses commencent par "20" (seul cas en
// France où préfixe CP ≠ code dept) → on accepte un CP "20xxx" dès que le
// périmètre inclut 2A ou 2B. allowedDepts vide = aucun filtre (accepte tout).
// Doit rester identique à prospection.html:deptMatchCp (cohérence client/serveur).
function deptMatchCp(allowedDepts, cp) {
  const depts = Array.isArray(allowedDepts) ? allowedDepts : []
  if (!depts.length) return true
  const prefix = String(cp || '').slice(0, 2)
  if (depts.indexOf(prefix) !== -1) return true
  if (prefix === '20' && (depts.indexOf('2A') !== -1 || depts.indexOf('2B') !== -1)) return true
  return false
}

// ── pickLocalEtab — établissement local d'une fiche pour un périmètre dept.
// Source de vérité unique (réplique prospection.html:2410-2423 + BARRIER NAF) : 1er
// matching_etablissements dont le CP ∈ allowedDepts, sinon siège si son CP ∈
// allowedDepts (ou allowedDepts vide). drop=true si un dept est demandé sans
// établissement local (= dept-drop du scroll). Retourne aussi le siret (dédup)
// et le NAF dotless (BARRIER NAF) de l'établissement choisi.
function pickLocalEtab(fiche, allowedDepts) {
  const depts = Array.isArray(allowedDepts) ? allowedDepts : []
  let etab = null
  const matching = Array.isArray(fiche.matching_etablissements) ? fiche.matching_etablissements : []
  for (const e of matching) {
    const cp = String(e?.code_postal || '')
    if (depts.length && deptMatchCp(depts, cp)) { etab = e; break }
  }
  if (!etab && fiche.siege) {
    const sCp = String(fiche.siege.code_postal || '')
    if (deptMatchCp(depts, sCp)) etab = fiche.siege
  }
  if (depts.length && !etab) return { etab: null, siret: '', naf: '', drop: true }
  if (!etab) etab = matching[0] || fiche.siege || {}
  const naf = String(etab.activite_principale || fiche.activite_principale || '').replace(/\./g, '')
  return { etab, siret: String(etab.siret || ''), naf, drop: false }
}

// ── keepLead — LA fonction de vérité « cette fiche compte-t-elle ? ».
// PURE (aucun await/IO) : les 2 impurs (existing pipeline, blocked opt-out)
// sont pré-résolus par l'appelant et passés dans ctx. Compose les 5 filtres
// dans l'ordre du scroll. Appelée par /api/search ET /api/search-count → une
// seule définition, divergence impossible par construction.
//   ctx = { allowedDepts:[], naf:'', existing:Set, blocked:Set }
// Asymétrie respectée : blocklist testée sur TOUS les SIRET (siège+matching),
// dédup testée sur fiche.siren + le siret du SEUL établissement local.
// Filtrage commune : assuré EXCLUSIVEMENT par code_commune (filtre upstream
// Etalab exact, poussé dans /api/search ET /api/search-count). Pas de re-filtre
// par libellé ici : il était redondant et fragile (pickLocalEtab choisit l'étab
// par DÉPARTEMENT, pas par commune → libellé d'une autre commune → drop à tort ;
// + accents/apostrophes/« Les »). Surtout, city_name n'étant pas transmis à
// /api/search-count, il rendait ctx.ville divergent entre les deux endpoints
// (« marché N / 0 chargée »). Retiré → parité stricte rétablie.
function keepLead(fiche, ctx) {
  if (!isProspectable(fiche, ctx.allowInactive)) return false
  if (!isFullyDiffusible(fiche, 'etalab')) return false
  const L = pickLocalEtab(fiche, ctx.allowedDepts)
  if (L.drop) return false
  // Adresse fermée → drop. On teste l'établissement RETENU (celui servi), pas
  // l'unité légale : isProspectable a déjà couvert l'entreprise. Miroir de
  // l'écriture ; exempté en recherche par identifiant (ctx.allowInactive).
  if (!isServedAddressActive(L.etab, fiche, ctx.allowInactive)) return false
  // NAF : exclut UNIQUEMENT sur inégalité stricte (naf étab vide = garder).
  if (ctx.naf && L.naf && L.naf !== ctx.naf) return false
  // blocklist : un quelconque SIRET de la fiche opt-out → drop
  if (ctx.blocked && ctx.blocked.size) {
    if (fiche.siege?.siret && ctx.blocked.has(fiche.siege.siret)) return false
    if (Array.isArray(fiche.matching_etablissements) &&
        fiche.matching_etablissements.some(e => e?.siret && ctx.blocked.has(e.siret))) return false
  }
  // dédup pipeline : siren fiche OU siret de l'établissement local déjà détenu
  if (fiche.siren && ctx.existing.has(String(fiche.siren))) return false
  if (L.siret && ctx.existing.has(L.siret)) return false
  return true
}

const REGION_DEPTS = {
  '11': ['75','77','78','91','92','93','94','95'],
  '24': ['18','28','36','37','41','45'],
  '27': ['21','25','39','58','70','71','89','90'],
  '28': ['14','27','50','61','76'],
  '32': ['02','59','60','62','80'],
  '44': ['08','10','51','52','54','55','57','67','68','88'],
  '52': ['44','49','53','72','85'],
  '53': ['22','29','35','56'],
  '75': ['16','17','19','23','24','33','40','47','64','79','86','87'],
  '76': ['09','11','12','30','31','32','34','46','48','65','66','81','82'],
  '84': ['01','03','07','15','26','38','42','43','63','69','73','74'],
  '93': ['04','05','06','13','83','84'],
  '94': ['2A','2B']
}

app.get('/api/public/search-demo', async (req, res) => {
  const naf = String(req.query.naf || '').trim()
  const region = String(req.query.region || '').trim()
  if (!naf) return res.status(400).json({ error: 'naf requis' })
  if (!region) return res.status(400).json({ error: 'region requise' })

  const depts = REGION_DEPTS[region]
  if (!depts) return res.status(400).json({ error: 'region inconnue' })

  // Raffinements optionnels (1.1) — département simple, code commune INSEE, code
  // postal. Servent la lecture-cache (gate + WHERE) et, sur MISS, restreignent la
  // requête Etalab au département reçu s'il est présent (sinon liste régionale).
  const departement = String(req.query.departement || '').trim()
  const codeCommune = String(req.query.code_commune || '').trim()
  const codePostal = String(req.query.code_postal || '').trim()

  let nafDotted = naf
  if (naf.length >= 4 && naf.indexOf('.') === -1) {
    nafDotted = naf.substring(0, 2) + '.' + naf.substring(2)
  }

  const PAGE_SIZE = 25
  const MAX_PAGES = 5
  const MAX_MARKERS = 500
  // MISS : département reçu s'il est présent, sinon la liste régionale (comme avant).
  const deptCsv = departement || depts.join(',')

  function buildUrl(page) {
    const p = new URLSearchParams()
    p.set('activite_principale', nafDotted)
    p.set('departement', deptCsv)
    p.set('per_page', String(PAGE_SIZE))
    p.set('page', String(page))
    // Filtres geo natifs — même patron que /api/search : code_postal en
    // passthrough, code_commune via communeParam (arrondissements PLM).
    if (codePostal) p.set('code_postal', codePostal)
    if (codeCommune) p.set('code_commune', communeParam(codeCommune))
    return 'https://recherche-entreprises.api.gouv.fr/search?' + p.toString()
  }

  // Pour chaque résultat, choisir un établissement physique dans le périmètre reçu.
  // Priorité : matching_etablissements (le plus pertinent), fallback siège
  // si son CP est aussi dans le périmètre reçu.
  // `allowed` est REQUIS, sans valeur par défaut : .map passe l'index en 2ᵉ
  // argument et deptMatchCp accepte tout périmètre non-tableau — un défaut
  // rouvrirait silencieusement le bornage. Les deux sites d'appel sont explicites.
  function pickLocalEtab(item, allowed) {
    const matching = Array.isArray(item.matching_etablissements) ? item.matching_etablissements : []
    for (let i = 0; i < matching.length; i++) {
      const cp = String(matching[i].code_postal || '')
      if (deptMatchCp(allowed, cp)) return matching[i]
    }
    const siege = item.siege || {}
    const cp = String(siege.code_postal || '')
    if (deptMatchCp(allowed, cp)) return siege
    return null
  }

  function mapItem(item, allowed) {
    const etab = pickLocalEtab(item, allowed)
    if (!etab) return null
    const lat = etab.latitude != null ? Number(etab.latitude) : null
    const lng = etab.longitude != null ? Number(etab.longitude) : null
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    if (lat === 0 && lng === 0) return null   // garde-fou (0,0) → dézoome
    return {
      nom_entreprise: item.nom_complet || item.nom_raison_sociale || '',
      ville: etab.libelle_commune || '',
      code_naf: nafDotted,
      libelle_naf: item.activite_principale_libelle || etab.activite_principale_libelle || '',
      lat,
      lng
    }
  }

  // ── Lecture-cache référentiel-first (calque /api/search geste B, 85b999c) ──
  // Si le gisement (naf, departement) est marqué COMPLET et FRAIS, on sert preview +
  // markers depuis referentiel_societes en UN SEUL aller-retour base (perPage aligné
  // sur MAX_MARKERS, page 1), contre cinq appels Etalab aujourd'hui. Toutes les
  // fonctions appelées sont fail-safe (null / 0 / results vides) → à la moindre
  // incertitude on retombe sur Etalab. Le try/catch de ceinture garantit qu'une
  // exception AVANT res.json dégrade en MISS (chemin Etalab), jamais en 502.
  // Démo ANONYME : PAS de trackLeadSearch (absent de ce chemin). ABSTENTIONS : PAS
  // d'upsertReferentiel, PAS de markGisementComplete (une lecture ne rajeunit jamais
  // ce qu'elle lit). Les fiches lues ont déjà passé keepLead à l'écriture (D1) → on
  // n'applique NI isProspectable NI l'extrapolation ratio : total est le count exact.
  try {
    // Cache tenté UNIQUEMENT sur département simple (sans virgule) reçu + NAF présent.
    if (departement && !departement.includes(',')) {
      const gisement = await isGisementComplete(naf, departement)
      if (gisement) {
        const total = await countReferentielFresh({ departement, naf, commune: codeCommune, codePostal })
        if (total > 0) {
          // perPage aligné sur le plafond de markers du handler (MAX_MARKERS), page 1 :
          // un seul aller-retour couvre preview (5) + markers (jusqu'à MAX_MARKERS-5).
          const lecture = await readReferentiel({ departement, naf, commune: codeCommune, codePostal, page: 1, perPage: MAX_MARKERS })
          // Garde page-1-vide : un gisement marqué mais rendant une page 1 VIDE (tout
          // opt-out) ne doit pas servir une réponse creuse → Etalab reprend la main.
          // La démo ne pagine pas (page toujours 1), d'où la garde réduite à > 0.
          if (lecture.results.length > 0) {
            // Dette SIREN assumée, alignée sur le moteur, non corrigée ici : `total`
            // compte des LIGNES (un SIRET par ligne) alors que l'aperçu est dédupliqué
            // par entreprise → sur un gisement multi-établissements, total peut dépasser
            // le nombre d'entreprises distinctes.
            const mapped = lecture.results.map(it => mapItem(it, [departement])).filter(Boolean)
            const preview = mapped.slice(0, 5)
            const markers = mapped.slice(5, 5 + (MAX_MARKERS - preview.length))
                                  .map(m => ({ lat: m.lat, lng: m.lng }))
            // total = countReferentielFresh (count exact) → totalCapped false (aucune
            // borne 10 000, contrairement au total_results Etalab extrapolé du MISS).
            console.log(`[search-demo-cache] HIT ${nafDotted}:${departement} servi=${lecture.results.length} total=${total}`)
            res.json({ total, totalCapped: false, preview, markers })
            return
          }
        }
      }
    }
  } catch (e) {
    console.warn('[search-demo-cache]', String(e?.message || e).slice(0, 80))
  }

  try {
    const r1 = await fetch(buildUrl(1))
    if (!r1.ok) return res.status(r1.status).json({ error: 'Recherche indisponible' })
    const data1 = await r1.json()
    const totalRaw = Number(data1.total_results || 0)
    const totalCapped = totalRaw >= 10000
    let raw = Array.isArray(data1.results) ? data1.results.slice() : []

    const pagesAvailable = Math.min(Math.ceil(totalRaw / PAGE_SIZE) || 1, MAX_PAGES)
    if (pagesAvailable > 1) {
      const promises = []
      for (let p = 2; p <= pagesAvailable; p++) {
        promises.push(fetch(buildUrl(p)).then(r => r.ok ? r.json() : null).catch(() => null))
      }
      const more = await Promise.all(promises)
      more.forEach(d => { if (d && Array.isArray(d.results)) raw = raw.concat(d.results) })
    }

    // Filtre diffusion INSEE (droit d'opposition) — exclut toute fiche dont un
    // statut_diffusion ≠ 'O', AVANT le filtre qualité et l'extrapolation ratio.
    const rawDiffusible = raw.filter(r => isFullyDiffusible(r, 'etalab'))
    if (rawDiffusible.length !== raw.length) console.log(`[diffusion] search-demo: ${raw.length - rawDiffusible.length} fiche(s) exclue(s)`)
    raw = rawDiffusible

    // Filtre opt-out RGPD — AU MÊME endroit que la diffusion : sur `raw`, AVANT
    // que fetchedCount ne soit mesuré, pour que le ratio voie les fiches retirées
    // des DEUX côtés de la fraction. Collecte siège + matching (doctrine 2396-2398),
    // drop si UN SEUL SIRET bloqué (keepLead 505-507). Fail-open (helper ne throw pas).
    const optoutSirets = []
    for (const r of raw) {
      if (r?.siege?.siret) optoutSirets.push(r.siege.siret)
      if (Array.isArray(r?.matching_etablissements)) {
        for (const e of r.matching_etablissements) if (e?.siret) optoutSirets.push(e.siret)
      }
    }
    const optoutBlocked = optoutSirets.length ? await checkBlocklistBatch(optoutSirets) : new Set()
    if (optoutBlocked.size) {
      const rawOptout = raw.filter(r =>
        !(r?.siege?.siret && optoutBlocked.has(r.siege.siret)) &&
        !(Array.isArray(r?.matching_etablissements) &&
          r.matching_etablissements.some(e => e?.siret && optoutBlocked.has(e.siret))))
      if (rawOptout.length !== raw.length) console.log(`[optout] search-demo: ${raw.length - rawOptout.length} fiche(s) exclue(s)`)
      raw = rawOptout
    }

    // Filtre qualité : on ne garde que les fiches "prospectables" (dirigeant
    // nommé + état actif + nature juridique pertinente). Le ratio observé sur
    // l'échantillon filtered/fetched sert à extrapoler le total estimé sur la
    // totalité de la région — l'API gouv ne donne pas le compte filtré exact
    // sans tout pager, extrapolation = compromis acceptable.
    const fetchedCount = raw.length
    const filteredRaw = raw.filter(isProspectable)
    const ratio = fetchedCount > 0 ? (filteredRaw.length / fetchedCount) : 1
    const totalEstimated = Math.round(totalRaw * ratio)

    const mapped = filteredRaw.map(it => mapItem(it, depts)).filter(Boolean)
    const preview = mapped.slice(0, 5)
    const markers = mapped.slice(5, 5 + (MAX_MARKERS - preview.length))
                          .map(m => ({ lat: m.lat, lng: m.lng }))

    res.json({ total: totalEstimated, totalCapped, preview, markers })
  } catch (e) {
    console.error('[public:search-demo]', e.message)
    res.status(502).json({ error: 'Service temporairement indisponible' })
  }
})

// Bandeau d'actualités du tableau de bord. Publique et déclarée ICI, AVANT le
// portillon d'authentification, sur le modèle de /api/public/search-demo : le
// bandeau s'affiche aussi sur des pages non authentifiées, et une manchette de
// presse n'est le secret de personne.
//
// Ne rend que ce que le bandeau affiche : titre, lien, date, source. Jamais la
// description — elle est stockée, elle n'a pas d'usage à l'écran aujourd'hui, et
// on n'expose pas un champ « au cas où ».
const ACTUALITES_AFFICHEES = 12

app.get('/api/public/actualites', async (req, res) => {
  try {
    const rows = await lireActualites(ACTUALITES_AFFICHEES)
    const items = rows.map(r => {
      // published_at revient en datetime natif : rendu en ISO, jamais l'objet brut.
      // Passage par getTime() plutôt que toISOString() direct — celui-ci lève sur
      // une date invalide, et une ligne douteuse ne doit pas coûter 502 aux onze
      // autres manchettes.
      const t = r.published_at ? new Date(r.published_at).getTime() : NaN
      return {
        titre: String(r.title || ''),
        lien: String(r.link || ''),
        date: Number.isFinite(t) ? new Date(t).toISOString() : null,
        source: String(r.source || '')
      }
    })
    res.json({ items })
  } catch (e) {
    console.error('[public:actualites]', e.message)
    res.status(502).json({ error: 'Service temporairement indisponible' })
  }
})

// ── Gate auth pour toutes les autres routes /api/* ──
// Exceptions : /api/auth/* (déjà mounté ci-dessus), /api/health (déjà déclaré
// ci-dessus, donc terminé avant ce middleware), webhook Resend (signature HMAC
// fait office d'auth), /api/public/* (démo landing déjà mountée ci-dessus).
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/') || req.path === '/auth' || req.path === '/health') return next()
  if (req.path.startsWith('/v2/webhooks/')) return next()
  if (req.path.startsWith('/public/')) return next()
  if (req.path === '/optout' || req.path.startsWith('/optout/')) return next()  // opt-out public RGPD art. 21
  return requireAuth(req, res, next)
})

// ── Gate subscription : essai 14j expiré → 402 sur les écritures ──
// Tourne APRÈS requireAuth (req.authUser disponible). Routes exemptées :
//   - /api/stripe/*               : paiement (passe 2)
//   - /api/user/me                : état trial pour le popup
//   - /api/account/privacy/export : RGPD à vie
// Les méthodes GET passent toujours (lecture seule autorisée même expiré).
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/') || req.path === '/auth' || req.path === '/health') return next()
  if (req.path.startsWith('/v2/webhooks/')) return next()
  if (req.path.startsWith('/public/')) return next()
  if (req.path === '/optout' || req.path.startsWith('/optout/')) return next()  // opt-out public RGPD art. 21
  if (req.path.startsWith('/stripe/')) return next()
  if (req.path === '/user/me') return next()
  if (req.path === '/account/privacy/export') return next()
  if (req.path === '/account/delete') return next()  // suppression compte art. 17 — accessible même abonnement expiré
  if (req.path === '/dev/reset-contacts') return next()  // outil dev gardé par flag ENABLE_DEV_RESET
  return requireActiveSubscription(req, res, next)
})

// ── Gate HTML pages app — protège les 15 routes app par requireAuthHtml ──
// 12 routes principales (APP_HTML_ROUTES) + 3 sous /account/ (billing, privacy,
// upgrade) couvertes par le préfixe APP_HTML_PREFIXES.
// Insérée AVANT express.static pour empêcher le service direct des pages
// HTML protégées sans cookie session valide. Toute autre URL (landing,
// login, légales, assets) tombe en next() vers express.static.
const APP_HTML_ROUTES = new Set([
  '/dashboard', '/prospection', '/pipeline', '/agenda', '/mail', '/visio',
  '/carte', '/contacts', '/devis', '/factures', '/frais', '/statistiques',
  '/superadmin', '/contact-societe'
])
const APP_HTML_PREFIXES = ['/account']

function isProtectedHtmlRoute(rawPath) {
  let p = String(rawPath || '/').replace(/\/+$/, '') || '/'
  p = p.replace(/\.html$/i, '')
  if (APP_HTML_ROUTES.has(p)) return true
  for (const prefix of APP_HTML_PREFIXES) {
    if (p === prefix || p.startsWith(prefix + '/')) return true
  }
  return false
}

// ── Redirection 301 héritée : /leads → /prospection ──
// La page Leads a été renommée Prospection (nomenclature 14 juin). On préserve
// les bookmarks/liens existants. PLACÉE AVANT le gate d'auth : /prospection a
// remplacé /leads dans APP_HTML_ROUTES, donc /leads n'est plus une route app —
// sans cette 301 il tomberait en 404 via express.static.
app.get('/leads', (req, res) => res.redirect(301, '/prospection'))

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next()
  if (req.path.startsWith('/api/')) return next()
  if (!isProtectedHtmlRoute(req.path)) return next()
  return requireAuthHtml(req, res, next)
})

// ── Route fiche société pleine page (Sprint 3) ──
// /contacts/:id sert public/contact-societe.html. Frontend lit l'id depuis
// window.location.pathname puis fetch /api/contacts pour charger le record.
// requireAuthHtml en route-level car isProtectedHtmlRoute ne matche que /contacts (sans /:id).
app.get('/contacts/:id', requireAuthHtml, (req, res) => {
  res.sendFile(join(__dirname, 'public', 'contact-societe.html'))
})

// ── Injection serveur-side window.__USER__ sur les routes app HTML ──
// Pattern Stripe/Linear : sidebar.js + scripts UI lisent window.__USER__ au load,
// zéro fetch supplémentaire au boot. Sécurité : sérialisation JSON + escape de
// </ en <\/ pour éviter une rupture de balise <script> via prenom/nom hostiles.
function escapeForScriptTag(json) {
  // Empêche `</script>`, `<!--`, `<![CDATA[` injectés via les champs user de
  // casser la balise <script> qui contient le JSON inline.
  return String(json)
    .replace(/<\/(script)/gi, '<\\/$1')
    .replace(/<!--/g, '<\\!--')
}

async function resolveAppHtmlFile(rawPath) {
  // Map URL → fichier disque, gérant extensions:['html'] et sous-dossiers.
  let p = String(rawPath || '/').replace(/\/+$/, '') || '/'
  // Pour /dashboard → public/dashboard.html
  // Pour /account/billing → public/account/billing.html
  // Pour /agenda.html → public/agenda.html (URL directe avec .html)
  const cleanPath = p.replace(/^\/+/, '')
  const candidates = cleanPath.endsWith('.html')
    ? [cleanPath]
    : [cleanPath + '.html']
  for (const rel of candidates) {
    try {
      const full = join(__dirname, 'public', rel)
      const html = await readFile(full, 'utf8')
      return html
    } catch (e) { /* try next */ }
  }
  return null
}

app.use(async (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next()
  if (req.path.startsWith('/api/')) return next()
  if (!isProtectedHtmlRoute(req.path)) return next()
  // Si pas d'authUser, requireAuthHtml a déjà 302'd → ce middleware ne s'exécute pas
  if (!req.authUser) return next()
  try {
    const html = await resolveAppHtmlFile(req.path)
    if (html === null) return next()
    const u = req.authUser
    const userIdStr = String(u.id || '').replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')
    const payload = {
      id: userIdStr,
      email: u.email || null,
      prenom: u.prenom || null,
      nom: u.nom || null,
      name: u.name || null,
      telephone: u.telephone || null,
      plan: u.plan || 'gratuit',
      trial_status: u.trial_status || null,
      trial_started_at: u.trial_started_at || null,
      trial_ends_at: u.trial_ends_at || null,
      subscription_status: u.subscription_status || null,
      current_period_end: u.current_period_end || null,
      app_state: deriveAppState(u),
      // Champs lus par trial-expired-modal (intended_plan), upgrade.html
      // (siret/raison_sociale/billing_address/intended_plan) et billing.html
      // (stripe_customer_id/plan_billing_cycle). Doit rester strictement
      // identique au payload /api/user/me — modifier les deux en parallèle.
      intended_plan: u.intended_plan || null,
      siret: u.siret || null,
      raison_sociale: u.raison_sociale || null,
      billing_address: u.billing_address || null,
      stripe_customer_id: u.stripe_customer_id || null,
      plan_billing_cycle: u.plan_billing_cycle || null
    }
    const json = escapeForScriptTag(JSON.stringify(payload))
    // Catalogue tarifaire (doctrine pricing) — donnée distincte du payload
    // utilisateur, qui lui doit rester strictement aligné sur /api/user/me.
    const pricing = {}
    for (const slug of PLANS_ORDER) {
      const p = PRICING_PLANS[slug]
      pricing[slug] = {
        label: p.label,
        priceMonthly: p.priceMonthly,
        priceAnnual: p.priceAnnual,
        priceAnnualTotal: p.priceAnnualTotal,
        color: p.color,
        // Quota leads mensuel — même source unique que la vitrine (PLAN_LEAD_LIMITS,
        // grille figée 30/60/120). Lecture directe car catalogue statique, non lié à
        // un user : le portillon VIP (getLeadLimit → Infinity) ne s'applique pas ici.
        leadQuota: PLAN_LEAD_LIMITS[slug]
      }
    }
    const pricingJson = escapeForScriptTag(JSON.stringify(pricing))
    const tag = '<script>window.__USER__=' + json + ';window.__PRICING__=' + pricingJson + ';</script>'
    let injected
    if (html.indexOf('</head>') !== -1) {
      injected = html.replace('</head>', tag + '</head>')
    } else if (html.indexOf('<body') !== -1) {
      injected = html.replace('<body', tag + '<body')
    } else {
      injected = tag + html
    }
    res.set('Content-Type', 'text/html; charset=utf-8')
    res.set('Cache-Control', 'no-store')
    return res.send(injected)
  } catch (e) {
    console.error('[user-inject]', e.message)
    return next()
  }
})

// ── Mesure d'audience du site public ──
// Placée JUSTE AVANT express.static : les pages applicatives ont déjà été
// servies par le middleware d'injection window.__USER__ au-dessus et
// n'arrivent pas ici ; celles qui y arriveraient malgré tout sont écartées par
// isProtectedHtmlRoute, le MÊME prédicat que le portillon d'authentification.
// Le middleware n'attend rien : il accroche un écouteur sur `finish` et rend
// la main (server/services/visites.js).
app.use(creerMesureAudience({ estPageApp: isProtectedHtmlRoute }))

// ── Fontes servies par le dépôt ──
// Monté AVANT le service général, qui servirait les mêmes fichiers sans
// aucun en-tête de cache : express.static laissé à ses valeurs par défaut
// ne pose ni max-age ni immutable, et chaque ouverture de page repayerait
// un aller-retour de revalidation 304 par fichier. Google renvoyait un an.
// Les repayer serait une régression, et ce sont les fontes : elles sont
// dans le chemin critique du premier rendu.
//
// Un an et immutable se tiennent parce que le nom du fichier porte la
// version de la fonte (geist-v5, geist-mono-v6, instrument-serif-v5) : une
// mise à jour change le nom, donc l'URL, et le cache d'un an ne peut jamais
// retenir un fichier périmé. Ne renommez pas ces fichiers sans changer la
// version, et ne changez pas leur contenu sans les renommer.
//
// Les .txt du dossier sont les deux licences OFL, que la clause 2 exige de
// distribuer avec les binaires : elles sont servies par le même montage.
app.use('/fonts', express.static(join(__dirname, 'public', 'fonts'), {
  maxAge: '1y',
  immutable: true,
  fallthrough: false
}))

// ── Bibliothèques du PDF servies par le dépôt ──
// Même montage que les fontes juste au-dessus, et pour la même raison : le
// service général rendrait ces deux fichiers sans aucun en-tête de cache, et
// un demi-mégaoctet de bibliothèque repayerait une revalidation 304 à chaque
// ouverture de devis.
//
// Un an et immutable se tiennent parce que le nom du fichier porte la
// version de la bibliothèque (html2canvas-1.4.1, jspdf-2.5.2) : une mise à
// jour change le nom, donc l'URL, et le cache d'un an ne peut jamais retenir
// un fichier périmé. Ne renommez pas ces fichiers sans changer la version, et
// ne changez pas leur contenu sans les renommer.
//
// Les .txt du dossier sont les licences MIT des deux bibliothèques, que
// celles-ci exigent de distribuer avec le code : même montage.
app.use('/vendor', express.static(join(__dirname, 'public', 'vendor'), {
  maxAge: '1y',
  immutable: true
  // PAS de fallthrough:false ici, à la différence des fontes. Une
  // bibliothèque absente doit finir en 404 ordinaire : c'est ce 404 qui fait
  // échouer le chargement du script, donc tomber dans le catch d'exportPDF,
  // qui affiche le motif de repli vers Imprimer. Le devis reste sortable.
}))

app.use(express.static(join(__dirname, 'public'), { extensions: ['html'] }))

// ── /api/leads/engaged ──
// Retourne l'union des SIRET et SIREN déjà engagés (Pipeline ∪ Contacts) pour
// le userId courant. Sert au KPI "Déjà engagés" sur /prospection pour signaler les
// fiches déjà prospectées et éviter le doublon.
app.get('/api/leads/engaged', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const [pip, ctx] = await Promise.all([
      queryOrEmpty(db, 'SELECT siret, siren FROM pipeline WHERE userId = $userId', { userId }),
      queryOrEmpty(db, 'SELECT siret, siren FROM contacts WHERE userId = $userId', { userId })
    ])
    const sirets = new Set()
    const sirens = new Set()
    const collect = (rows) => {
      (rows || []).forEach(r => {
        if (r?.siret) sirets.add(String(r.siret))
        if (r?.siren) sirens.add(String(r.siren))
      })
    }
    collect(pip)
    collect(ctx)
    res.json({ sirets: Array.from(sirets), sirens: Array.from(sirens) })
  } catch (err) {
    console.error('[leads/engaged]', err.message)
    res.status(500).json({ error: 'Lecture engagés impossible' })
  }
})

// ── /api/admin/comptes — superadmin, LECTURE SEULE ──
// Verrou route-level requireSuperadmin (req.authUser garanti par le gate global
// requireAuth, server.js:592). GET → passe le gate abonnement (lecture seule),
// donc dev accède même essai expiré. Rejoue les 3 SELECT de
// scripts/inventaire-comptes.js (aucune mutation, aucun appel Stripe) et agrège
// par compte. Renvoie un tableau JSON trié par created_at.
app.get('/api/admin/comptes', requireSuperadmin, async (req, res) => {
  const norm = (id) => String(id ?? '')
    .replace(/^user:/, '').replace(/^user_plan:/, '').replace(/^⟨+|⟩+$/g, '')
  // userField : valeur du champ sur user, sinon fallback sur user_plan.
  const userField = (u, plan, key) => {
    if (u[key] !== undefined && u[key] !== null && u[key] !== '') return u[key]
    if (plan && plan[key] !== undefined && plan[key] !== null && plan[key] !== '') return plan[key]
    return null
  }
  try {
    const db = await getDb()
    const [users, plans, pipes] = await Promise.all([
      queryOrEmpty(db, 'SELECT * FROM user ORDER BY created_at'),
      queryOrEmpty(db, 'SELECT * FROM user_plan'),
      queryOrEmpty(db, 'SELECT userId, count() AS n FROM pipeline GROUP BY userId')
    ])
    const planById = new Map()
    for (const p of plans) planById.set(norm(p.userId || p.id), p)
    const fichesById = new Map()
    for (const r of pipes) fichesById.set(norm(r.userId), r.n)

    const rows = users.map((u) => {
      const id = norm(u.id)
      const plan = planById.get(id)
      return {
        email: u.email || '',
        prenom: u.prenom || u.name || '',
        plan: userField(u, plan, 'plan') || 'gratuit',
        subscription_status: userField(u, plan, 'subscription_status') || '',
        trial_status: userField(u, plan, 'trial_status') || '',
        current_period_end: userField(u, plan, 'current_period_end') || null,
        leads: plan?.leadsConsumedThisMonth ?? u.leadsConsumedThisMonth ?? 0,
        fiches: fichesById.get(id) ?? 0,
        created_at: u.created_at || null,
        // Dernière venue — posée par toucherLastSeen dans les deux portillons de
        // session, pas d'une heure. NONE tant que le compte n'est pas revenu
        // depuis la mise en service du champ : la colonne affiche alors un tiret,
        // ce qui se lit « jamais vu », et non « vu il y a longtemps ».
        last_seen_at: u.last_seen_at || null,
        // Statut VIP — vit sur user (pas user_plan). Lu par le toggle superadmin.
        bypass: !!u.bypass
      }
    })
    res.json(rows)
  } catch (err) {
    console.error('[admin/comptes]', err.message)
    res.status(500).json({ error: 'Lecture comptes impossible' })
  }
})

// ── POST /api/admin/comptes/bypass — superadmin, écriture VIP CHIRURGICALE ──
// Même verrou que le GET (requireSuperadmin, dev@soparadi.com SEUL). Ne touche
// QUE le champ bypass via MERGE — jamais password_hash, email, plan,
// subscription_status, trial_status ni aucun autre champ. Après l'UPDATE,
// invalide le cache de session du user modifié pour que deriveAppState relise
// bypass sans attendre l'expiration du cache (sinon délai de ~30s).
app.post('/api/admin/comptes/bypass', requireSuperadmin, async (req, res) => {
  const email = String(req.body?.email ?? '').toLowerCase().trim()
  const bypass = req.body?.bypass
  // Booléen STRICT : rejette "true", 1, null, undefined.
  if (!email) return res.status(400).json({ error: 'email requis' })
  if (typeof bypass !== 'boolean') return res.status(400).json({ error: 'bypass doit être un booléen' })
  try {
    const db = await getDb()
    const found = await db.query('SELECT * FROM user WHERE email = $email LIMIT 1', { email })
    const u = found[0]?.[0]
    if (!u) return res.status(404).json({ error: 'compte introuvable' })
    // Id nettoyé (même norm que le GET) : sert au type::record ET à
    // l'invalidation — sinon l'invalidation par userId rate la comparaison.
    const id = String(u.id ?? '').replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')
    await db.query('UPDATE type::record("user", $id) MERGE { bypass: $v }', { id, v: bypass })
    invalidateSessionCacheByUserId(id)
    res.json({ email, bypass })
  } catch (err) {
    console.error('[admin/comptes/bypass]', err.message)
    res.status(500).json({ error: 'Mise à jour bypass impossible' })
  }
})

// ── GET /api/admin/comptes/:email — superadmin, LECTURE SEULE ──
// Même verrou que /api/admin/comptes (requireSuperadmin, dev@soparadi.com SEUL).
// AUCUNE mutation, AUCUN appel Stripe : que des SELECT.
//
// POURQUOI. Le tableau ne rend que dix colonnes alors que la fiche d'un compte
// en porte une quarantaine, et que son activité n'y figure pas du tout. Tout
// cela se lisait jusqu'ici par un script de diagnostic lancé à la main ; c'est
// désormais une route, et la page la déplie dans un panneau.
//
// CE QUI NE SORT JAMAIS D'ICI. La projection est ÉNUMÉRÉE champ par champ dans
// CHAMPS_USER : password_hash n'y est pas, aucun jeton de session ni de
// vérification non plus, et aucun `SELECT *` ne part vers le client. Ajouter un
// champ à la fiche demande de l'écrire dans cette liste — c'est le but. Même
// règle sur geo_data : la capture d'inscription porte l'IP interrogée
// (`ip_used`), la fiche n'en rend que la ville, la région et le pays.
//
// ABSENT N'EST PAS VIDE. Un champ jamais renseigné n'existe pas dans
// l'enregistrement ; sous une PROJECTION il revient tout de même, à null —
// vérifié en lecture sur la base, la projection ci-dessous rend ses 46 clés
// quoi qu'il arrive. Un test de présence de clé serait donc toujours vrai et ne
// dirait rien. C'est la VALEUR qui tranche, et chacune part sous enveloppe
// { present, valeur } : null ou undefined → absent ; false, 0 et la chaîne vide
// → présents. La page distingue ainsi « jamais renseigné » (tiret) de « posé
// puis vidé » (valeur vide) — un consentement retiré ne doit pas ressembler à
// un consentement jamais demandé.
//
// TYPES DE CLÉS, à ne pas mélanger : `user_id` est un record<user> sur
// lead_search — d'où type::record('user', $uid) ; `userId` est une CHAÎNE NUE
// sur pipeline, contacts, societes, devis, facture et user_plan. Les dates,
// elles, sont des datetime sur lead_search et user mais des CHAÎNES ISO sur
// contacts, societes et pipeline : leurs agrégats se font donc côté
// application, une base ne comparera pas une chaîne comme une date. Les lignes
// de lead_search sont d'ailleurs lues telles quelles, sans agrégat : elles se
// regroupent en recherches côté application (search-tracker).
const CHAMPS_USER = [
  'id',
  // Identité
  'prenom', 'nom', 'name', 'email', 'email_verified', 'created_at',
  // Contact
  'telephone', 'adresse', 'code_postal', 'ville', 'lat', 'lng',
  // Entreprise
  'siret', 'raison_sociale', 'code_naf', 'billing_address',
  // Origine (capture à l'inscription)
  'geo_data',
  // Consentements
  'marketing_consent', 'marketing_consent_at', 'cgu_accepted', 'cgu_accepted_at', 'cgu_version',
  // Abonnement
  'plan', 'intended_plan', 'intended_plan_at', 'trial_started_at', 'trial_ends_at', 'trial_status',
  'subscription_status', 'current_period_end', 'plan_billing_cycle', 'cancel_at_period_end',
  'past_due_since', 'stripe_customer_id', 'stripe_subscription_id', 'bypass',
  // Cycle de vie
  'welcome_email_sent_at', 'trial_email_j0_sent_at', 'trial_email_j2_sent_at',
  'trial_email_j12_sent_at', 'grace_j_minus_1_sent_at', 'trial_purge_warning_sent_at',
  'deletion_requested_at', 'deletion_scheduled_at', 'last_seen_at'
].join(', ')

app.get('/api/admin/comptes/:email', requireSuperadmin, async (req, res) => {
  const email = String(req.params.email ?? '').toLowerCase().trim()
  if (!email) return res.status(400).json({ error: 'email requis' })

  // Enveloppe { present, valeur } — cf. « ABSENT N'EST PAS VIDE » ci-dessus.
  // Un booléen false, un zéro et une chaîne vide sont PRÉSENTS ; seuls
  // undefined et null (la forme JS d'un NONE SurrealDB) valent absence.
  const ch = (o, cle) => (o && o[cle] !== undefined && o[cle] !== null)
    ? { present: true, valeur: o[cle] }
    : { present: false }

  // Millisecondes depuis une valeur datetime OU chaîne ISO ; null si ce n'en
  // est pas une. Le pilote rend tantôt un Date, tantôt une chaîne.
  const ms = (v) => {
    if (v === undefined || v === null || v === '') return null
    const d = v instanceof Date ? v : new Date(v)
    return Number.isNaN(d.getTime()) ? null : d.getTime()
  }
  // Plus récente des dates portées par un jeu de lignes, sur plusieurs clés
  // possibles : pipeline écrit `createdAt` depuis la page et `created_at`
  // depuis les imports, les deux cohabitent en base.
  const plusRecente = (lignes, ...cles) => {
    let max = null
    for (const l of lignes) {
      for (const c of cles) {
        const t = ms(l[c])
        if (t !== null && (max === null || t > max)) max = t
      }
    }
    return max
  }
  const nombre = (lignes) => Number(lignes?.[0]?.n) || 0

  try {
    const db = await getDb()
    const trouve = await queryOrEmpty(
      db, `SELECT ${CHAMPS_USER} FROM user WHERE email = $email LIMIT 1`, { email })
    const u = trouve[0]
    if (!u) return res.status(404).json({ error: 'compte introuvable' })

    // uid nu (sans préfixe ni chevrons) — même normalisation que les deux
    // routes voisines. Il sert au type::record des tables à clé record ET à
    // l'égalité de chaîne des tables métier.
    const uid = String(u.id ?? '').replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')

    const [plans, lignesRecherche, pipes, contacts, societes, devis, factures] = await Promise.all([
      // user_plan est tantôt clé par le champ userId, tantôt par l'identifiant
      // de record — les deux formes existent en base, les deux sont couvertes.
      queryOrEmpty(db,
        `SELECT leadsConsumedThisMonth, enrichedSirets, plan, subscription_status, trial_status, current_period_end
           FROM user_plan WHERE userId = $uid OR id = type::record('user_plan', $uid) LIMIT 1`, { uid }),
      // UNE SEULE LECTURE DE lead_search, et pas de count(). La table porte une
      // ligne par PAGE parcourue ; ce qu'on veut compter, ce sont des
      // recherches. Le regroupement se fait donc sur les lignes elles-mêmes
      // (grouperRecherches), et la même lecture sert au total, à la date de la
      // dernière recherche et aux vingt dernières rendues plus bas. Projection
      // de six colonnes sur les lignes d'UN user, servie par l'index
      // (user_id, searched_at) : aucune agrégation de masse.
      queryOrEmpty(db,
        `SELECT search_id, naf_code, naf_label, region_code, region_name,
                department_code, department_name, city_name, searched_at
           FROM lead_search WHERE user_id = type::record('user', $uid)
          ORDER BY searched_at DESC`, { uid }),
      // Les trois tables métier datées en CHAÎNES ISO : la projection ne
      // ramène que leurs colonnes de date, et le compte se lit sur le nombre
      // de lignes rendues — un count() de plus serait un aller-retour pour
      // rien. societes porte en plus search_id : les entreprises ajoutées par
      // recherche se comptent ici, sans une requête de plus.
      queryOrEmpty(db, 'SELECT createdAt, created_at FROM pipeline WHERE userId = $uid', { uid }),
      queryOrEmpty(db, 'SELECT created_at FROM contacts WHERE userId = $uid', { uid }),
      queryOrEmpty(db, 'SELECT created_at, updated_at, search_id FROM societes WHERE userId = $uid', { uid }),
      // Devis et factures : le compte suffit, count() GROUP ALL.
      queryOrEmpty(db, 'SELECT count() AS n FROM devis WHERE userId = $uid GROUP ALL', { uid }),
      queryOrEmpty(db, 'SELECT count() AS n FROM facture WHERE userId = $uid GROUP ALL', { uid })
    ])

    const plan = plans[0] || null

    // Repli user → user_plan, LE MÊME que /api/admin/comptes et /api/admin/kpi :
    // les trois routes doivent lire le même statut pour le même compte, sinon
    // la fiche contredit la ligne du tableau qu'on vient de cliquer. La
    // provenance est rendue avec la valeur, pour que le repli reste visible.
    const chPlan = (cle) => {
      if (u[cle] !== undefined && u[cle] !== null && u[cle] !== '') return { present: true, valeur: u[cle] }
      if (plan && plan[cle] !== undefined && plan[cle] !== null && plan[cle] !== '') {
        return { present: true, valeur: plan[cle], source: 'user_plan' }
      }
      return { present: false }
    }

    // Origine — capture d'inscription (server/services/geolocation.js). NI
    // `ip_used` NI le fournisseur n'en sortent : la fiche dit d'où la personne
    // s'est inscrite, pas depuis quelle adresse.
    const geo = (u.geo_data && typeof u.geo_data === 'object') ? u.geo_data : null

    // ── Dernière trace datée ──
    // Le plus récent des signaux datés du compte, avec l'écart en jours. Les
    // deux premiers sont des datetime, les trois suivants des chaînes ISO
    // agrégées ici même — d'où le passage par des millisecondes, seule échelle
    // où les cinq se comparent.
    // Des pages aux recherches — la règle est dans search-tracker (identifiant
    // écrit par la page, fenêtre de 5 min en repli pour les lignes qui n'en ont
    // pas). Les lignes arrivent de la plus récente à la plus ancienne : la
    // dernière recherche est donc la première ligne, sans agrégat.
    const recherchesReelles = grouperRecherches(lignesRecherche)
    const traces = [
      ['dernière venue', ms(u.last_seen_at)],
      ['dernière recherche', ms(lignesRecherche[0]?.searched_at)],
      ['dernière fiche pipeline', plusRecente(pipes, 'createdAt', 'created_at')],
      ['dernier contact', plusRecente(contacts, 'created_at')],
      ['dernière société', plusRecente(societes, 'updated_at', 'created_at')]
    ].filter(([, t]) => t !== null).sort((a, b) => b[1] - a[1])
    const recente = traces[0] || null
    const enrichis = Array.isArray(plan?.enrichedSirets) ? plan.enrichedSirets.length : 0

    // ── Ce que chacune des vingt dernières recherches a produit ──
    // Entreprises ajoutées (sociétés) : comptées sur les lignes de societes déjà
    // lues. C'est bien l'ENTREPRISE qu'on compte, pas ses dirigeants — 17 % des
    // sociétés n'en produisent aucun, et c'est l'entreprise que l'abonnée ajoute.
    const vingt = recherchesReelles.slice(0, 20)
    const nbSocietes = new Map()
    for (const s of societes) {
      const sid = String(s.search_id || '')
      if (sid) nbSocietes.set(sid, (nbSocietes.get(sid) || 0) + 1)
    }
    // Les deux autres compteurs vivent dans les tables d'usage, lues pour ces
    // vingt identifiants seulement.
    const { contactsModifies, enrichissements } =
      await compterUsageParRecherche(uid, vingt.map(g => g.search_id))
    // Une recherche sans identifiant (antérieure au lien) ne se voit rien
    // attribuer : ses trois compteurs valent null et sortiront à tiret. Rien
    // n'est reconstitué par horodatage.
    const compteur = (g, source) => g.search_id ? (source.get(g.search_id) || 0) : null

    res.json({
      email: u.email || email,

      identite: {
        prenom: ch(u, 'prenom'), nom: ch(u, 'nom'), name: ch(u, 'name'),
        email: ch(u, 'email'), email_verified: ch(u, 'email_verified'),
        created_at: ch(u, 'created_at')
      },

      contact: {
        telephone: ch(u, 'telephone'), adresse: ch(u, 'adresse'),
        code_postal: ch(u, 'code_postal'), ville: ch(u, 'ville'),
        lat: ch(u, 'lat'), lng: ch(u, 'lng')
      },

      entreprise: {
        siret: ch(u, 'siret'), raison_sociale: ch(u, 'raison_sociale'),
        code_naf: ch(u, 'code_naf'), billing_address: ch(u, 'billing_address')
      },

      origine: {
        ville: ch(geo, 'city'), region: ch(geo, 'region'), pays: ch(geo, 'country'),
        code_pays: ch(geo, 'country_code'), code_postal: ch(geo, 'postal_code'),
        captee_le: ch(geo, 'detected_at')
      },

      consentements: {
        marketing_consent: ch(u, 'marketing_consent'),
        marketing_consent_at: ch(u, 'marketing_consent_at'),
        cgu_accepted: ch(u, 'cgu_accepted'),
        cgu_accepted_at: ch(u, 'cgu_accepted_at'),
        cgu_version: ch(u, 'cgu_version')
      },

      abonnement: {
        plan: chPlan('plan'),
        intended_plan: ch(u, 'intended_plan'), intended_plan_at: ch(u, 'intended_plan_at'),
        trial_started_at: ch(u, 'trial_started_at'), trial_ends_at: ch(u, 'trial_ends_at'),
        trial_status: chPlan('trial_status'),
        subscription_status: chPlan('subscription_status'),
        current_period_end: chPlan('current_period_end'),
        plan_billing_cycle: ch(u, 'plan_billing_cycle'),
        cancel_at_period_end: ch(u, 'cancel_at_period_end'),
        past_due_since: ch(u, 'past_due_since'),
        stripe_customer_id: ch(u, 'stripe_customer_id'),
        stripe_subscription_id: ch(u, 'stripe_subscription_id'),
        bypass: ch(u, 'bypass')
      },

      cycle_de_vie: {
        welcome_email_sent_at: ch(u, 'welcome_email_sent_at'),
        trial_email_j0_sent_at: ch(u, 'trial_email_j0_sent_at'),
        trial_email_j2_sent_at: ch(u, 'trial_email_j2_sent_at'),
        trial_email_j12_sent_at: ch(u, 'trial_email_j12_sent_at'),
        grace_j_minus_1_sent_at: ch(u, 'grace_j_minus_1_sent_at'),
        trial_purge_warning_sent_at: ch(u, 'trial_purge_warning_sent_at'),
        deletion_requested_at: ch(u, 'deletion_requested_at'),
        deletion_scheduled_at: ch(u, 'deletion_scheduled_at'),
        last_seen_at: ch(u, 'last_seen_at')
      },

      activite: {
        // Des recherches, pas des pages : le déroulement d'un gisement compte
        // pour une, quel que soit le nombre de pages qu'il a demandées.
        recherches: recherchesReelles.length,
        fiches_pipeline: pipes.length,
        contacts: contacts.length,
        societes: societes.length,
        devis: nombre(devis),
        factures: nombre(factures),
        sirets_enrichis: enrichis,
        leads_consommes: Number(plan?.leadsConsumedThisMonth ?? 0) || 0,
        derniere_trace: recente
          ? {
              quoi: recente[0],
              quand: new Date(recente[1]).toISOString(),
              ecart_jours: Math.max(0, Math.floor((Date.now() - recente[1]) / 86400000))
            }
          : null
      },

      // Les vingt dernières RECHERCHES, datées de leur lancement. Plus de
      // `resultats` : le nombre annoncé par l'API n'a jamais dit ce que
      // l'abonnée en a fait. Trois compteurs le disent, ou trois null.
      recherches: vingt.map((g) => ({
        metier: [g.naf_code, g.naf_label].filter(Boolean).join(' '),
        zone: [g.city_name, g.department_name || g.department_code, g.region_name].filter(Boolean).join(', '),
        date: g.debut !== null ? new Date(g.debut).toISOString() : null,
        entreprises: compteur(g, nbSocietes),
        contacts_modifies: compteur(g, contactsModifies),
        enrichissements: compteur(g, enrichissements)
      }))
    })
  } catch (err) {
    console.error('[admin/comptes/:email]', err.message)
    res.status(500).json({ error: 'Lecture de la fiche impossible' })
  }
})

// ── GET /api/admin/kpi — superadmin, LECTURE SEULE ──
// Même verrou que /api/admin/comptes (requireSuperadmin, dev@soparadi.com SEUL).
// Aucune mutation, aucun appel Stripe.
//
// POURQUOI UNE ROUTE, et pas un calcul dans la page. Les cinq chiffres étaient
// dérivés côté navigateur du corps de /api/admin/comptes. Deux choses en
// découlaient : le tableau et les cartes disaient forcément la même chose, mais
// les cartes ne pouvaient jamais dire davantage — pas d'audience, pas de cumul
// hors fenêtre — et surtout la page comptait le COMPTE PROPRIÉTAIRE parmi les
// abonnés et son pipeline de mise au point parmi les fiches. Sur une base jeune
// c'est le premier chiffre en importance qui est faux.
//
// LE PROPRIÉTAIRE EST HORS DE TOUS LES INDICATEURS D'USAGE. L'adresse vient de
// BYPASS_EMAIL (lib/vip.js), source unique, jamais recopiée ici. Son compte,
// ses fiches et ses leads sont rendus à part sous `proprietaire` : retirés du
// total, pas escamotés. Le drapeau `bypass` des AUTRES comptes, lui, reste
// compté — ce sont de vrais utilisateurs, simplement dispensés du mur
// d'abonnement.
//
// COÛT DES LECTURES. Cinq requêtes, aucune sur un référentiel. `user` et
// `user_plan` sont projetées (jamais SELECT *) et se comptent en centaines de
// lignes ; `pipeline` est agrégée par count() GROUP BY userId ; `visite_jour`
// porte une ligne par jour depuis la mise en service ; `visite` est lue par
// ÉGALITÉ sur `jour` (champ indexé), donc une seule journée. Rien qui balaie
// une table de masse — l'instance est petite (1 Go), une agrégation large la
// fait tomber. La page rappelle cette route toutes les dix secondes : ce coût
// est celui d'un rafraîchissement, pas d'une consultation.
//
// TYPES DE CLÉS, à ne pas mélanger : `userId` est une CHAÎNE NUE sur pipeline et
// user_plan (d'où le norm ci-dessous, identique à celui de /api/admin/comptes) ;
// c'est `user_id` de type record<user> qui règne sur lead_search et audit_log —
// aucune des deux tables n'est lue ici, et le jour où elles le seront, la clé
// n'aura pas la même forme.
app.get('/api/admin/kpi', requireSuperadmin, async (req, res) => {
  const norm = (id) => String(id ?? '')
    .replace(/^user:/, '').replace(/^user_plan:/, '').replace(/^⟨+|⟩+$/g, '')
  // Même fallback user → user_plan que /api/admin/comptes : les deux routes
  // doivent lire le même statut pour le même compte, sinon les cartes
  // contredisent le tableau qu'elles surmontent.
  const champ = (u, plan, cle) => {
    if (u[cle] !== undefined && u[cle] !== null && u[cle] !== '') return u[cle]
    if (plan && plan[cle] !== undefined && plan[cle] !== null && plan[cle] !== '') return plan[cle]
    return null
  }
  // Jour civil Europe/Paris d'un datetime, quelle que soit la forme rendue par
  // le pilote (Date ou chaîne). Null si la valeur n'est pas une date.
  const jourDe = (v) => {
    if (!v) return null
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : jourParis(d)
  }
  // Lundi de la semaine d'une date AAAA-MM-JJ. Ancrage à midi UTC comme
  // decalerJour : le quantième obtenu ne dépend pas du changement d'heure.
  const lundiDe = (jour) => {
    const t = Date.parse(jour + 'T12:00:00Z')
    if (Number.isNaN(t)) return null
    const jsJour = new Date(t).getUTCDay()          // 0 = dimanche
    return decalerJour(jour, -(jsJour === 0 ? 6 : jsJour - 1))
  }

  // Le jour civil courant, Europe/Paris — celui que vit le lecteur du tableau.
  const jourCourant = jourParis()

  try {
    const db = await getDb()
    const [users, plans, pipes, agreges, detailDuJour] = await Promise.all([
      queryOrEmpty(db, 'SELECT id, email, created_at, bypass, plan, subscription_status, trial_status, leadsConsumedThisMonth FROM user'),
      queryOrEmpty(db, 'SELECT userId, id, plan, subscription_status, trial_status, leadsConsumedThisMonth FROM user_plan'),
      queryOrEmpty(db, 'SELECT userId, count() AS n FROM pipeline GROUP BY userId'),
      queryOrEmpty(db, 'SELECT jour, vues, visiteurs FROM visite_jour ORDER BY jour'),
      // LA JOURNÉE EN COURS. agregerVisitesJour ne traite que les journées
      // RÉVOLUES — par construction, sinon il écrirait une ligne fausse qu'il
      // faudrait réécrire le lendemain. Conséquence : le jour courant
      // n'apparaissait JAMAIS dans visite_jour, donc jamais dans la série. Il
      // est lu ici directement dans le DÉTAIL, par égalité sur `jour` (champ
      // indexé) et projeté sur le seul `jeton` : vues = lignes, visiteurs =
      // jetons distincts — exactement le calcul de l'agrégateur.
      queryOrEmpty(db, 'SELECT jeton FROM visite WHERE jour = $jour', { jour: jourCourant })
    ])

    const planParId = new Map()
    for (const p of plans) planParId.set(norm(p.userId || p.id), p)
    const fichesParId = new Map()
    for (const r of pipes) fichesParId.set(norm(r.userId), r.n)

    const cartes = { comptes: 0, essais: 0, essais_convertis: 0, abonnes: 0, fiches: 0, leads: 0, vip: 0 }
    const proprietaire = { email: BYPASS_EMAIL, present: false, fiches: 0, leads: 0 }
    const inscriptionsParJour = new Map()

    for (const u of users) {
      const id = norm(u.id)
      const plan = planParId.get(id)
      const fiches = Number(fichesParId.get(id) ?? 0) || 0
      const leads = Number(plan?.leadsConsumedThisMonth ?? u.leadsConsumedThisMonth ?? 0) || 0

      if (isOwner(u)) {
        proprietaire.present = true
        proprietaire.fiches += fiches
        proprietaire.leads += leads
        continue
      }

      cartes.comptes++
      if (champ(u, plan, 'subscription_status') === 'active') cartes.abonnes++
      if (champ(u, plan, 'trial_status') === 'active') cartes.essais++
      if (champ(u, plan, 'trial_status') === 'converted') cartes.essais_convertis++
      if (u.bypass === true) cartes.vip++
      cartes.fiches += fiches
      cartes.leads += leads

      const j = jourDe(u.created_at)
      if (j) inscriptionsParJour.set(j, (inscriptionsParJour.get(j) || 0) + 1)
    }

    const abonnes_pct = cartes.comptes ? Math.round(cartes.abonnes / cartes.comptes * 100) : 0

    // ── La journée en cours, recollée à la série des journées agrégées ──
    // L'AGRÉGAT PRIME. Si le cron a déjà écrit la date du jour dans visite_jour
    // — rattrapage après un long arrêt, passage à minuit pendant la lecture —
    // c'est sa ligne qui fait foi et le détail n'est pas relu : deux sources
    // pour une même date, c'est la source stable qui gagne.
    //
    // Sinon la journée est reconstruite depuis le détail et marquée
    // `partielle` : elle n'est pas finie, elle grossira jusqu'à minuit. Sans
    // ce drapeau, la dernière barre de la série se lirait comme une chute
    // alors qu'elle n'est qu'inachevée.
    const jours = agreges.slice()
    const dejaAgrege = agreges.some((r) => r.jour === jourCourant)
    let jour_courant = null
    if (dejaAgrege) {
      const r = agreges.find((x) => x.jour === jourCourant)
      jour_courant = {
        jour: jourCourant, vues: Number(r.vues) || 0, visiteurs: Number(r.visiteurs) || 0,
        partielle: false, source: 'agregat'
      }
    } else if (detailDuJour.length) {
      const distincts = new Set()
      for (const l of detailDuJour) distincts.add(l.jeton)
      jour_courant = {
        jour: jourCourant, vues: detailDuJour.length, visiteurs: distincts.size,
        partielle: true, source: 'detail'
      }
      jours.push({ jour: jourCourant, vues: jour_courant.vues, visiteurs: jour_courant.visiteurs, partielle: true })
    }

    // ── Série hebdomadaire — douze semaines, lundi comme premier jour ──
    // DEUX jeux de données par semaine, et pas un seul :
    //
    //   • visiteurs — la somme des visiteurs quotidiens distincts de la
    //     semaine. Ce n'est PAS un décompte d'individus sur sept jours, et ça ne
    //     peut pas l'être : le sel du jeton d'unicité tourne chaque nuit, donc
    //     deux journées ne partagent aucun jeton comparable (voir
    //     server/services/visites.js). La grandeur est un « visiteur-jour », et
    //     l'intitulé côté page le dit.
    //
    //   • inscriptions — le compte de créations de comptes, propriétaire exclu.
    //     Conservé alors que l'audience prend la vedette : c'est le seul des
    //     deux qui mesure une conversion, et une semaine à forte audience sans
    //     inscription est précisément le rapprochement qu'on veut voir.
    const SEMAINES = 12
    const lundiCourant = lundiDe(jourParis())
    const semaines = []
    for (let i = SEMAINES - 1; i >= 0; i--) {
      const debut = decalerJour(lundiCourant, -7 * i)
      semaines.push({ debut, fin: decalerJour(debut, 6), visiteurs: 0, vues: 0, inscriptions: 0, partielle: false })
    }
    const semaineParDebut = new Map(semaines.map((s) => [s.debut, s]))

    let vues_total = 0, visiteurs_total = 0
    for (const r of jours) {
      // Cumul depuis la mise en service : lu sur l'agrégat, JAMAIS par un
      // balayage du détail — c'est la raison d'être de visite_jour.
      vues_total += Number(r.vues) || 0
      visiteurs_total += Number(r.visiteurs) || 0
      const s = semaineParDebut.get(lundiDe(r.jour))
      if (s) {
        s.vues += Number(r.vues) || 0
        s.visiteurs += Number(r.visiteurs) || 0
        // La semaine qui porte la journée en cours est elle-même inachevée.
        if (r.partielle) s.partielle = true
      }
    }
    for (const [jour, n] of inscriptionsParJour) {
      const s = semaineParDebut.get(lundiDe(jour))
      if (s) s.inscriptions += n
    }

    res.json({
      cartes: { ...cartes, abonnes_pct },
      proprietaire,
      audience: {
        // Y a-t-il de quoi mesurer ? Depuis que la journée en cours est recollée
        // à la série, la réponse ne dépend plus du passage du cron : une seule
        // ligne dans `visite` aujourd'hui suffit, l'audience est « disponible »
        // le jour même de la mise en service. Reste un cas de bord assumé — du
        // détail sur des journées passées, pas encore agrégé, et aucune visite
        // aujourd'hui : il se referme à la première visite ou au premier cron,
        // et le lever demanderait un balayage de `visite` que cette instance ne
        // supporte pas.
        disponible: jours.length > 0,
        depuis: jours.length ? jours[0].jour : null,
        jours: jours.length,
        vues_total,
        visiteurs_total,
        // La journée en cours, à part : la série la porte déjà, mais la page
        // doit pouvoir dire qu'elle n'est pas finie.
        jour_courant,
        // Mémoire du process, jamais lue en base (fenêtre de cinq minutes).
        a_l_instant: visiteursALInstant()
      },
      // ── L'ÉTAT VIVANT ──
      // Entièrement dérivé de la fenêtre en mémoire (server/services/visites.js) :
      // aucune lecture de base, aucun coût de requête. Il ne survit pas à un
      // redémarrage du process — `minutes_couvertes` dit jusqu'où la mémoire
      // répond, pour qu'un trou ne se lise pas comme un creux d'audience.
      vivant: etatVivant(),
      semaines
    })
  } catch (err) {
    console.error('[admin/kpi]', err.message)
    res.status(500).json({ error: 'Lecture des indicateurs impossible' })
  }
})

// ── GET /api/debug/overpass — DIAGNOSTIC DÉVELOPPEMENT, À RETIRER AVANT LANCEMENT.
// Route de diagnostic LECTURE SEULE du remplissage Overpass dans
// referentiel_societes. Même verrou que les routes /api/admin/comptes
// (requireSuperadmin, dev@soparadi.com SEUL, req.authUser posé par le gate
// global requireAuth). GET → passe le gate abonnement (lecture seule).
// N'exécute QUE des SELECT (aucun UPDATE/CREATE, aucun appel réseau externe) et
// ne touche NI /api/search, NI overpass.js, NI /api/enrich.
//
// Paramètres optionnels ?naf=47.78A&dept=22 : quand les DEUX sont fournis,
// ajoute un bloc `couple` (total / avec_website / avec_societe_tel /
// avec_au_moins_un) mesurant le remplissage sur ce couple précis — le seul
// terrain où le connecteur Overpass a pu s'exécuter. Le NAF est normalisé
// comme l'appariement d'overpass.js:319-325 : insensible au point (la base
// stocke en pointé « 47.78A », les deux formes d'entrée sont acceptées).
app.get('/api/debug/overpass', requireSuperadmin, async (req, res) => {
  // Prédicat « champ non vide » (les 3 champs sont option<string> : NONE ou '').
  const nonVide = (f) => `${f} != NONE AND ${f} != ''`
  const vide = (f) => `(${f} = NONE OR ${f} = '')`
  const auMoinsUn =
    `(${nonVide('website')}) OR (${nonVide('societe_tel')}) OR (${nonVide('societe_email')})`
  const lesTrois =
    `(${nonVide('website')}) AND (${nonVide('societe_tel')}) AND (${nonVide('societe_email')})`
  const cnt = (rows) => (Array.isArray(rows) && rows[0] && typeof rows[0].count === 'number') ? rows[0].count : 0
  try {
    const db = await getDb()
    const [totalR, webR, telR, mailR, unR, deptTotR, deptUnR, gisWebR, gisSansContactR, gisSansMailR, gisSansTelR] = await Promise.all([
      db.query('SELECT count() FROM referentiel_societes GROUP ALL'),
      db.query(`SELECT count() FROM referentiel_societes WHERE ${nonVide('website')} GROUP ALL`),
      db.query(`SELECT count() FROM referentiel_societes WHERE ${nonVide('societe_tel')} GROUP ALL`),
      db.query(`SELECT count() FROM referentiel_societes WHERE ${nonVide('societe_email')} GROUP ALL`),
      db.query(`SELECT count() FROM referentiel_societes WHERE ${auMoinsUn} GROUP ALL`),
      db.query('SELECT departement, count() AS n FROM referentiel_societes GROUP BY departement'),
      db.query(`SELECT departement, count() AS n FROM referentiel_societes WHERE ${auMoinsUn} GROUP BY departement`),
      db.query(`SELECT count() FROM referentiel_societes WHERE ${nonVide('website')} GROUP ALL`),
      db.query(`SELECT count() FROM referentiel_societes WHERE ${nonVide('website')} AND ${vide('societe_email')} AND ${vide('societe_tel')} GROUP ALL`),
      db.query(`SELECT count() FROM referentiel_societes WHERE ${nonVide('website')} AND ${vide('societe_email')} GROUP ALL`),
      db.query(`SELECT count() FROM referentiel_societes WHERE ${nonVide('website')} AND ${vide('societe_tel')} GROUP ALL`)
    ])
    // Fusion des deux ventilations par département (total vs. au moins un contact).
    const avecContactParDept = new Map()
    for (const row of (deptUnR[0] || [])) avecContactParDept.set(String(row.departement ?? ''), row.n || 0)
    const parDepartement = (deptTotR[0] || [])
      .map((row) => {
        const dept = String(row.departement ?? '')
        return { departement: dept, total: row.n || 0, avec_contact: avecContactParDept.get(dept) || 0 }
      })
      .sort((a, b) => b.avec_contact - a.avec_contact || b.total - a.total)
      .slice(0, 20)

    // Bloc couple naf+dept (optionnel) — remplissage réel sur ce seul couple.
    // « au moins un » = website OU societe_tel (les deux champs qu'Overpass
    // écrit ; l'email n'entre pas dans cette mesure, conformément à la demande).
    //
    // Méthode : SELECT sur le DÉPARTEMENT seul (indexé), puis filtre NAF +
    // comptage en JS post-SELECT. On n'utilise PAS string::replace en SQL :
    // son support n'est pas garanti sous SurrealDB 2.6.5 (c'est ce qui avait
    // cassé Overpass en juillet). On reproduit exactement la doctrine
    // insensible-au-point d'overpass.js:319-325 (base pointée « 47.78A »,
    // entrée acceptée dans les deux formes via strip JS).
    let couple = null
    const nafRaw = String(req.query.naf || '').trim()
    const deptRaw = String(req.query.dept || '').trim()
    if (nafRaw && deptRaw) {
      const nafStrip = nafRaw.replace(/\./g, '')
      const rowsR = await db.query(
        'SELECT naf, website, societe_tel FROM referentiel_societes WHERE departement = $dept',
        { dept: deptRaw }
      )
      const rows = (Array.isArray(rowsR?.[0]) ? rowsR[0] : [])
        .filter((r) => String(r?.naf || '').replace(/\./g, '') === nafStrip)
      const rempli = (v) => v !== undefined && v !== null && String(v) !== ''
      let avecWeb = 0, avecTel = 0, avecUn = 0
      for (const r of rows) {
        const w = rempli(r?.website)
        const t = rempli(r?.societe_tel)
        if (w) avecWeb++
        if (t) avecTel++
        if (w || t) avecUn++
      }
      couple = {
        naf: nafRaw,
        dept: deptRaw,
        total: rows.length,
        avec_website: avecWeb,
        avec_societe_tel: avecTel,
        avec_au_moins_un: avecUn
      }
    }

    // Échantillon cle_nom — contrôle de visu AVANT backfill des restantes.
    // Projection légère (siret, enseigne, raison_sociale, cle_nom) sur les 10
    // premières fiches traitées, pour vérifier à l'œil que
    // cle_nom = normaliserSociete(enseigne || raison_sociale) : enseigne
    // prioritaire, repli raison sociale. Prédicat STRICT `!= NONE` (pas nonVide)
    // exprès : on veut VOIR les cle_nom = '' (raison sociale réduite à vide après
    // strip des suffixes) — les masquer cacherait un éventuel problème sur ces cas.
    const echClenomR = await db.query(
      `SELECT siret, enseigne, raison_sociale, cle_nom FROM referentiel_societes WHERE cle_nom != NONE LIMIT 10`
    )
    const echantillonClenom = Array.isArray(echClenomR?.[0]) ? echClenomR[0] : []

    // Comptage de complétude — LECTURE SEULE, requête count() filtrée isolée
    // (pas dans le Promise.all ci-dessus, pour ne pas le fragiliser). Les autres
    // agrégats de complétude (total, par canal, au moins un) sont déjà calculés
    // plus haut ; seul « les TROIS champs remplis » manque, on l'ajoute ici.
    const completR = await db.query(
      `SELECT count() FROM referentiel_societes WHERE ${lesTrois} GROUP ALL`
    )
    const completude = {
      total: cnt(totalR[0]),
      avec_au_moins_un: cnt(unR[0]),
      complete: cnt(completR[0]),
      detail: {
        avec_website: cnt(webR[0]),
        avec_tel: cnt(telR[0]),
        avec_email: cnt(mailR[0])
      }
    }

    res.json({
      total: cnt(totalR[0]),
      avec_website: cnt(webR[0]),
      avec_societe_tel: cnt(telR[0]),
      avec_societe_email: cnt(mailR[0]),
      avec_au_moins_un: cnt(unR[0]),
      par_departement_top20: parDepartement,
      gisement: {
        avec_website: cnt(gisWebR[0]),
        website_sans_contact: cnt(gisSansContactR[0]),
        website_sans_email: cnt(gisSansMailR[0]),
        website_sans_tel: cnt(gisSansTelR[0])
      },
      echantillon_clenom: echantillonClenom,
      completude,
      ...(couple ? { couple } : {})
    })
  } catch (err) {
    console.error('[debug/overpass]', err.message)
    res.status(500).json({ error: 'Diagnostic overpass impossible' })
  }
})

// ── POST /api/admin/referentiel/backfill-clenom — À RETIRER AVANT LANCEMENT.
// Backfill one-shot de cle_nom sur le stock referentiel_societes existant
// (étape 2/3). Même verrou que /api/admin/comptes et /api/debug/overpass
// (requireSuperadmin, dev@soparadi.com SEUL, req.authUser posé par le gate
// global). Déclenché À LA MAIN après merge (Railway), JAMAIS au boot (bloquerait
// le démarrage + rejeu à chaque redéploiement).
//
// normaliserSociete est du JS pur (NFD + strip suffixes) inexprimable en SurrealQL
// (et string::replace non fiable sous 2.6.5, cf. overpass) → lire→normaliser→réécrire
// par lots. Contrainte mémoire movup-prod (1 GB) : projection LÉGÈRE (id, enseigne,
// raison_sociale — JAMAIS etablissements[]/dirigeants[]), lot 500, cadence inter-lots.
//
// IDEMPOTENCE : curseur = WHERE cle_nom = NONE. On écrit TOUJOURS (même cle = ''),
// donc une ligne traitée quitte l'ensemble NONE → une reprise saute ce qui est fait
// et la boucle termine (raison sociale « SARL » seule → '' est un état terminal, pas
// un NONE qui rebouclerait). Bornage ?batches=N (défaut 20, max 50) pour tenir sous
// le timeout Railway ; l'appelant relance jusqu'à restant = 0.
app.post('/api/admin/referentiel/backfill-clenom', requireSuperadmin, async (req, res) => {
  const BATCH = 500
  const maxBatches = Math.min(50, Math.max(1, Number(req.query.batches) || 20))
  // count final optionnel : count() filtré GROUP ALL est sûr (même classe que
  // /api/debug/overpass), mais ?count=0 permet de le sauter par prudence.
  const withCount = String(req.query.count ?? '1') !== '0'
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  try {
    const db = await getDb()
    let traite = 0
    let lots = 0
    for (; lots < maxBatches; lots++) {
      // Projection LÉGÈRE (pas d'arrays lourds). Curseur cle_nom = NONE, ORDER BY
      // siret adossé à idx_ref_siret UNIQUE → walk indexé, pas de sort global.
      const r = await db.query(
        `SELECT id, siret, enseigne, raison_sociale FROM referentiel_societes
         WHERE cle_nom = NONE ORDER BY siret LIMIT ${BATCH}`
      )
      const rows = r[0] || []
      if (rows.length === 0) break   // plus rien à traiter
      for (const row of rows) {
        // COALESCE enseigne || raison_sociale, normalisé en JS pur.
        const cle = normaliserSociete(row.enseigne || row.raison_sociale || '')
        // Idiome dominant ET éprouvé en prod (server.js:263/897/1331…) : type::record
        // avec l'id extrait via cleanRecordId — strip le préfixe 'referentiel_societes:'
        // ET les chevrons ⟨⟩ dont SurrealDB entoure un id purement numérique (le SIRET).
        // Même helper que la création de ces records (referentiel.js:308) → symétrie.
        const id = cleanRecordId('referentiel_societes', String(row.id))
        if (!id) continue
        // Écriture TOUJOURS (même '') → la ligne quitte l'ensemble NONE (terminaison).
        await db.query('UPDATE type::record("referentiel_societes", $id) SET cle_nom = $cle', { id, cle })
        traite++
      }
      if (rows.length < BATCH) { lots++; break }   // dernier lot partiel : inutile de re-SELECT
      await sleep(300)   // cadence : ménage le 1 GB partagé avec le trafic live
    }
    // restant : count() filtré (PAS un agrégat lourd), optionnel via ?count=0.
    let restant = null
    if (withCount) {
      const c = await db.query(
        'SELECT count() FROM referentiel_societes WHERE cle_nom = NONE GROUP ALL'
      )
      restant = Number(c?.[0]?.[0]?.count) || 0
    }
    res.json({ traite, lots, restant })
  } catch (err) {
    console.error('[backfill-clenom]', err.message)
    res.status(500).json({ error: 'Backfill cle_nom impossible' })
  }
})

// ── POST /api/admin/atout-france/charger — déclencheur MANUEL du chargement du
// fichier Atout France dans referentiel_atout_france. Même verrou que
// /api/admin/referentiel/backfill-clenom (requireSuperadmin, dev@soparadi.com
// SEUL, req.authUser posé par le gate global).
//
// PAS DE CRON dans ce lot, délibérément : le fichier est mis à jour tous les
// jours, mais on regarde d'abord ce qui atterrit avant d'automatiser le
// rechargement. Déclenché à la main après merge (Railway), JAMAIS au boot.
//
// BORNÉ par ?lots=N — lots de 100 lignes, défaut 20 (2 000 lignes), maximum 50
// (5 000), mêmes bornes que ?batches= du backfill cle_nom et pour la même raison :
// tenir sous le timeout Railway. Le bornage est appliqué DANS le service, seul
// endroit qui connaisse la taille d'un lot. L'appelant relance jusqu'à
// `restant: 0` ; ~11 appels pour le fichier entier au défaut.
//
// Le fichier n'est PAS retéléchargé à chaque appel : le service le garde analysé
// en mémoire avec un curseur, une demi-heure durant (cf. section CACHE de
// atout-france.js). Un redémarrage du serveur en cours de chargement perd cache et
// curseur ensemble : le chargement RECOMMENCE de la ligne 1, sans jamais sauter de
// ligne, l'UPSERT sur clé naturelle rendant le rejeu anodin.
//
// Compte rendu à trois échelles, détaillé au-dessus de chargerAtoutFrance :
// `lus`/`ignores`/`retenus` portent sur le FICHIER, `traites`/`ecrits`/`erreurs`
// sur CET APPEL, `curseur`/`restant` sur le chargement en cours. `restant: null`
// = inconnu (échec), à ne pas lire comme un chargement terminé.
//
// chargerAtoutFrance n'écrit QUE referentiel_atout_france — aucune écriture dans
// referentiel_societes, aucun rapprochement — et ne throw jamais : elle rend son
// compte rendu même en échec. Le 500 ci-dessous ne couvre que l'imprévu.
app.post('/api/admin/atout-france/charger', requireSuperadmin, async (req, res) => {
  try {
    const compte = await chargerAtoutFrance({ lots: req.query.lots })
    // 409 : verrou mono-appel du service. Un second chargement concurrent
    // doublerait la charge d'écriture sur movup-prod sans rien avancer — le cas
    // visé est le curl relancé après un timeout de proxy, alors que le serveur
    // travaille toujours. Rien n'a été fait, le compte rendu est à zéro.
    if (compte.occupe) return res.status(409).json(compte)
    res.json(compte)
  } catch (err) {
    console.error('[atout-france/charger]', err.message)
    res.status(500).json({ error: 'Chargement Atout France impossible' })
  }
})

// ── POST /api/admin/rge/charger — déclencheur MANUEL du chargement des
// qualifications RGE de l'ADEME dans referentiel_rge. Même verrou que
// /api/admin/atout-france/charger (requireSuperadmin, dev@soparadi.com SEUL,
// req.authUser posé par le gate global).
//
// PAS DE CRON dans ce lot, délibérément : la source est refinalisée chaque nuit,
// mais on regarde d'abord ce qui atterrit — et surtout si `_id` est stable d'une
// republication à l'autre — avant d'automatiser quoi que ce soit. Déclenché à la
// main après merge (Railway), JAMAIS au boot.
//
// BORNÉ par ?pages=N — pages de 10 000 lignes (plafond dur de l'API ADEME),
// défaut 4 (40 000 lignes), maximum 17 (le jeu entier, 162 259 lignes). Le
// bornage est appliqué DANS le service.
//
// REPRISE PAR ?curseur=… — et c'est toute la différence avec Atout France. Là-bas
// le fichier se télécharge d'un bloc et le service garde son curseur en mémoire
// une demi-heure ; ici la source EST paginée et fournit elle-même le point de
// reprise, que le service rend dans `curseur_suivant`. L'appelant le repasse tel
// quel à l'appel suivant, jusqu'à `termine: true`. Aucun état côté serveur : un
// redémarrage en cours de chargement ne perd rien, à condition d'avoir gardé le
// dernier curseur rendu. Le service le journalise page par page pour cette
// raison — si CETTE réponse HTTP se perd (timeout de proxy sur un appel long),
// le curseur se relit dans les logs Railway.
//
// Le curseur est refusé s'il n'a pas la forme « <entier>,<entier> » : il n'est
// jamais interprété comme une URL, l'adresse de l'API étant en dur dans le
// service. Un curseur mal formé rend un compte à zéro, sans repartir en silence
// de la première page.
//
// `termine: false` ne veut PAS dire « échec » : c'est l'état normal tant qu'il
// reste des pages. Seul un `curseur_suivant: null` AVEC `termine: false` signale
// que rien n'a pu être lu.
//
// chargerRge n'écrit QUE referentiel_rge — aucune écriture dans
// referentiel_societes, aucun rapprochement — et ne throw jamais : elle rend son
// compte rendu même en échec. Le 500 ci-dessous ne couvre que l'imprévu.
app.post('/api/admin/rge/charger', requireSuperadmin, async (req, res) => {
  try {
    const compte = await chargerRge({ pages: req.query.pages, curseur: req.query.curseur })
    res.json(compte)
  } catch (err) {
    console.error('[rge/charger]', err.message)
    res.status(500).json({ error: 'Chargement RGE impossible' })
  }
})

// ── POST /api/admin/rapprochement/dept — À RETIRER AVANT LANCEMENT.
// Déclenche rapprocherDepartement sur UN département, à la main, pour valider le
// pont adresse (certain_adresse/presume_adresse). Même verrou que /api/admin/comptes
// et /api/debug/overpass (requireSuperadmin, dev@soparadi.com SEUL, req.authUser posé
// par le gate global). SYNCHRONE à la requête — contrairement à /api/amorce, PAS de
// setTimeout et PAS d'enchaînement selectSiretsACrawler/runMentionsLegalesJob : aucun
// effet de bord crawl. Renvoie l'objet compteurs complet pour comparaison au point de
// référence. rapprocherDepartement est fill-if-empty (jamais d'écrasement) → relançable
// sans dégât sur le même dept.
app.post('/api/admin/rapprochement/dept', requireSuperadmin, async (req, res) => {
  const dept = String(req.query?.dept ?? req.body?.dept ?? '').trim()
  if (!dept) return res.status(400).json({ error: 'dept requis' })
  try {
    const compteurs = await rapprocherDepartement(dept)
    res.json(compteurs)
  } catch (err) {
    console.error('[admin/rapprochement/dept]', err.message)
    res.status(500).json({ error: 'Rapprochement département impossible' })
  }
})

app.get('/api/pipeline', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const result = await db.query('SELECT * FROM pipeline WHERE userId = $userId', { userId })
    // Projection du référentiel mutualisé — jointure en lot sur la clé SIRET, dans
    // un sous-objet `referentiel`. Rien n'est recopié sur les cartes ; le régime
    // décomptable (email / téléphone au seul SIRET payé) est appliqué là, une fois.
    // Fail-open : référentiel injoignable → cartes non projetées, jamais d'erreur.
    res.json(await projeterReferentiel(result[0] || [], userId))
  } catch (err) {
    // Table jamais créée (nouvelle instance, aucun POST pipeline) : liste vide,
    // pas une erreur. On ne neutralise QUE ce cas ; toute autre panne SurrealDB
    // continue de remonter en 500.
    if (String(err?.message || '').includes('does not exist')) {
      return res.json([])
    }
    console.error('[pipeline]', err)
    res.status(500).json({ error: 'Impossible de lire les cartes pipeline' })
  }
})

app.post('/api/pipeline', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const body = retirerProjection({ ...(req.body || {}), userId }) // userId forcé, body.userId écrasé

    // Date de création posée par le serveur quand le client n'en fournit pas :
    // une carte enregistrée sans date de création n'en a plus jamais. Le client
    // reste libre de fournir la sienne (import, reprise d'un existant). Nom
    // canonique : created_at ; createdAt (abandonné en écriture) est repris.
    if (!body.created_at) {
      body.created_at = body.createdAt || new Date().toISOString()
    }

    const db = await getDb()

    // Quota leads (Phase 2 roadmap, commit 1) — ne s'applique QU'AUX ajouts
    // depuis la page Leads, marqués par body.source === 'SIRENE' (posé par
    // prospection.html addToPipeline). Les autres flux (visio/contacts/csv_import/
    // manual/paste/facture_import/pipeline) passent sans lookup, sans
    // décompte, sans blocage : comportement strictement inchangé.
    //
    // Dette consignée (HORS scope ce commit) : body.source est hardcodé
    // côté client, donc contournable par requête forgée (POST direct avec
    // source='visio'). Correctif durable = autorité serveur sur la provenance
    // (ex. route POST /api/pipeline/from-leads dédiée + middleware d'ajout
    // de source). À traiter dans une passe de durcissement future.
    const isLeadsAddition = body.source === 'SIRENE'

    // ── Rempart 2 opt-out (RGPD art. 12) — refus dur à l'ajout, AVANT le
    // check quota : une tentative bloquée ne consomme pas de lead
    // (leadsConsumedThisMonth non décrémenté). Lookup unitaire (1 SELECT).
    // Ne s'applique qu'aux ajouts Leads (source SIRENE) porteurs d'un
    // SIRET ; les autres flux passent strictement inchangés.
    if (isLeadsAddition && body.siret && await checkBlocklistOne(body.siret)) {
      return res.status(403).json({
        error: 'opt_out',
        message: "Cette entreprise n'est pas disponible pour prospection."
      })
    }

    // Geste A : décompte de quota retiré à l'AJOUT au pipeline. Plus aucun
    // plafond ni 402 'pipeline_quota' sur les ajouts source 'SIRENE' — l'ajout
    // au pipeline est désormais libre. Le péage est déplacé vers la Vitesse 2
    // (enrichissement de fiche), hors périmètre ici. Les helpers de quota
    // (getLeadLimit/getLeadsConsumed/getEffectivePlan) et la route
    // /api/user-plan/check-quota restent en place pour ce réemploi futur.
    // Le Rempart 2 opt-out RGPD ci-dessus (blocklist SIRET) reste pleinement
    // actif : il ne dépend pas du quota.

    const cleanId = cleanRecordId('pipeline', body?.id)
    let payload = null
    let payloadStatus = 201
    if (cleanId) {
      const { record, status, action } = await upsertRecord(db, 'pipeline', cleanId, body)
      if (action === 'updated') console.log(`[pipeline] upsert pipeline:${cleanId}`)
      payload = record
      payloadStatus = status
    } else {
      const result = await db.query('CREATE pipeline CONTENT $body', { body })
      payload = result[0]?.[0] || result[0] || null
      payloadStatus = 201
    }

    // Geste A : incrément leadsConsumedThisMonth retiré à l'ajout au pipeline.
    // L'ajout d'une fiche (source 'SIRENE') ne décompte plus le quota. Le péage
    // sera reporté sur l'enrichissement (Vitesse 2), hors périmètre ici.

    return res.status(payloadStatus).json(payload)
  } catch (err) {
    console.error('[pipeline]', err)
    res.status(500).json({ error: 'Impossible de créer la carte pipeline' })
  }
})

// ── Matérialisation d'un prospect — société + dirigeants (contacts) + carte
// pipeline en UNE transaction. Autorité serveur sur la provenance
// (source:'prospection' posée ici, non spoofable côté client) ; lève la dette
// du double POST plat + source hardcodée (cf. POST /api/pipeline).
//
// Ordre strict : 400 siret manquant -> 403 opt-out (AVANT toute écriture) ->
// dirigeants (portés par la fiche, sinon re-fetch HORS transaction, dégradé
// gracieux) -> dédup SIRET -> transaction unique. Société déjà existante
// (findSocieteBySiret) : SKIP création société + dirigeants, carte créée
// seulement si pas déjà au pipeline.
// Échec re-fetch : société/carte créées quand même, dirigeants_crees:0.
//
// Servi à l'unité par POST /api/pipeline/from-lead, et par lot par
// POST /api/pipeline/from-leads — même cœur, mêmes règles, deux entrées.

// Les trois refus possibles de la matérialisation, avec leur code et leur
// libellé. Table unique pour que la route unitaire et la route de lot parlent
// exactement le même langage : l'une les rend en HTTP, l'autre les compte.
// Le 400 ne porte pas de message (forme d'origine préservée à l'octet près).
const REFUS_PROSPECT = {
  siren_manquant: { http: 400, error: 'siren_requis' },
  opt_out: {
    http: 403,
    error: 'opt_out',
    message: "Cette entreprise n'est pas disponible pour prospection."
  },
  etablissement_ferme: {
    http: 409,
    error: 'etablissement_ferme',
    message: "Cette entreprise n'est plus en activité et ne peut pas être ajoutée au suivi."
  }
}
function corpsRefus(refus) {
  const r = REFUS_PROSPECT[refus]
  return r.message ? { error: r.error, message: r.message } : { error: r.error }
}

// ── Cœur partagé de la matérialisation d'un prospect ──────────────────────
// Extrait de POST /api/pipeline/from-lead sans rien y changer : même ordre de
// contrôles (SIREN requis -> opt-out -> dirigeants -> établissement
// fermé -> dédup société -> dédup carte), mêmes écritures, même transaction
// unique. Seuls les TROIS lookups de dédoublonnage / opposition sont injectés
// par l'appelant :
//   estOptOut(siret)             -> bool   (rempart RGPD)
//   trouverSociete(siren)        -> record société | null
//   estDejaPipeline(siren,siret) -> bool
// La route unitaire passe les lookups directs — une requête chacun, exactement
// comme avant. La route de lot passe des lookups servis par un cache chargé UNE
// fois pour tout le lot et tenu à jour au fil des créations : sans ça, 188
// fiches feraient 188 x 3 allers-retours, et deux établissements d'un même
// SIREN présents dans le même lot se dédoubleraient (le lookup ne voit pas ce
// que la fiche précédente vient d'écrire).
//
// Retour : { ok:false, refus } pour un refus, sinon { ok:true, societe_id,
// dirigeants_crees, dedup, societe_creee, carte_creee }. L'appelant tranche :
// la route unitaire répond en HTTP, la route de lot écarte et poursuit.
async function materialiserProspect(userId, body, lookups) {
  // 1. SIREN requis (identifiant de dédup : une société = une unité légale).
  //    SIRET conservé pour le stockage / l'opt-out, mais n'est plus la
  //    condition de rejet.
  const siret = String(body.siret || '').replace(/\s+/g, '')
  const siren = String(body.siren || '').replace(/\s+/g, '')
  if (!siren) return { ok: false, refus: 'siren_manquant' }
  // Recherche d'origine — l'identifiant minté par la page au lancement, porté
  // par la fiche depuis qu'elle est entrée au buffer. Recopié tel quel sur les
  // trois enregistrements créés ici : c'est le seul lien exact entre « ce que
  // l'abonnée a cherché » et « ce qu'elle en a tiré ». Vide (ajout hors
  // Prospection, recherche par identifiant, page antérieure) : rien n'est
  // rattaché, et rien n'est deviné par horodatage.
  const searchId = nettoyerSearchId(body.search_id)
  // 2. Rempart opt-out RGPD — refus dur AVANT toute écriture.
  if (await lookups.estOptOut(siret)) {
    return { ok: false, refus: 'opt_out' }
  }
  // 3. Dirigeants + identité INSEE. DEUX voies, une seule règle de forme.
  //    a) La fiche PORTE déjà ses dirigeants : la recherche vient de les
  //       ramener (chemin Etalab comme chemin cache de /api/search), la page
  //       les transmet avec la fiche. On les emploie, ZÉRO appel réseau. C'est
  //       ce qui rend l'ajout en bloc tenable : 188 fiches ne redemandent plus
  //       à Etalab 188 fois ce qu'on a déjà sous la main.
  //    b) Sinon (ajout hors Prospection, recherche par identifiant, fiche
  //       d'une page antérieure, corps sans dirigeants) : re-fetch Etalab HORS
  //       transaction, exactement comme avant. Dégradé gracieux assuré par le
  //       helper : vide si 429/erreur, jamais throw.
  //    Dans les deux cas c'est normaliserDirigeants qui a tranché la forme —
  //    les contacts créés par l'une ou l'autre voie sont indiscernables.
  //
  //    Ce que la voie (a) ne rapporte pas : effectif et statut_diffusion, qui
  //    ne voyagent pas avec la fiche — ils restent vides sur le record société,
  //    comme lorsque le re-fetch dégrade. etat_administratif, lui, voyage : le
  //    filtre d'activité juste en dessous le lit à l'identique, à la même
  //    place, avec la même tolérance sur l'inconnu.
  const dirigeantsFournis = Array.isArray(body.dirigeants) ? body.dirigeants : []
  const dd = dirigeantsFournis.length
    ? {
        dirigeants: normaliserDirigeants(dirigeantsFournis),
        effectif: '',
        etat_administratif: typeof body.etat_administratif === 'string' ? body.etat_administratif : '',
        statut_diffusion: ''
      }
    : await refetchDirigeants(siren)
  // Filtre d'activité — matérialisation vers le suivi. L'état (unité légale) vient
  // d'être refetché juste au-dessus ; on le TESTE ici, avant toute écriture. Un
  // établissement fermé ne doit pas entrer au suivi : état CONNU et ≠ 'A' → 409,
  // aucune société / carte créée. État INCONNU ('' : refetch dégradé sur 429/réseau)
  // → on laisse passer (le dégradé gracieux du helper est préservé, jamais de blocage
  // sur incertitude). Test volontairement AVANT getDb : rien n'est touché en base.
  if (dd.etat_administratif && dd.etat_administratif !== 'A') {
    return { ok: false, refus: 'etablissement_ferme' }
  }

  const db = await getDb()
  // 4. Dédup société par SIREN (une société = une unité légale ; deux
  //    établissements d'un même SIREN → UNE fiche). societe_id stocké SANS
  //    préfixe de table (cohérent avec genId / ecrireImport).
  const existing = await lookups.trouverSociete(siren)
  const neuve = !existing
  const societeId = existing
    ? String(existing.id).replace(/^societes:/, '')
    : genId('s_')

  // Carte pipeline : créée sauf si la société est déjà au board (dédup
  // siren/siret). Lookup unique avant la transaction (fail-fast lecture).
  const dejaPipeline = await lookups.estDejaPipeline(siren, siret)

  const now = new Date().toISOString()
  const raison = body.raison_sociale || ''
  // Enseigne (nom commercial) persistée à part du nom juridique — sert à
  // composer le titre de fiche côté abonné (module partagé _mup-nom.js).
  const enseigne = String(body.enseigne || '').trim()
  // raison_sociale nettoyée : le nom juridique SEUL. Quand le client s'est
  // rabattu sur nom_complet (nom_raison_sociale absent), la chaîne embarque
  // l'enseigne entre parenthèses en fin — on la retire pour ne stocker que le
  // nom juridique. Repli sur la valeur brute si le nettoyage vide tout.
  const raisonClean = raison.replace(/\s*\([^()]*\)\s*$/, '').trim() || raison
  // Adresse « voie » (numéro + type + libellé) pour le record société et la
  // face société dupliquée ; adresse « complète » (+ CP + ville) pour la carte.
  let adresse = [body.adresse_numero_voie, body.adresse_type_voie, body.adresse_libelle_voie]
    .filter(Boolean).join(' ').trim()
  // Repli (option A) : les matching_etablissements de recherche-entreprises ne
  // portent PAS les champs voie structurés (numero/type/libelle), seulement
  // l'adresse agrégée. Si la voie est vide mais qu'un body.address agrégé
  // existe, on extrait la rue en retirant « <CP 5 chiffres> <ville> » de la
  // fin. Pas de match -> on garde l'agrégé complet (jamais de perte).
  if (!adresse && body.address) {
    const agg = String(body.address).trim()
    adresse = agg.replace(/\s+\d{5}\s+.+$/, '').trim() || agg
  }
  const zip = body.adresse_code_postal || ''
  const ville = body.adresse_libelle_commune || ''
  const adresseComplete = [adresse, zip, ville].filter(Boolean).join(' ').trim()
  const formeLib = libelleFormeJuridique(body.forme)
  // Siège social (transporté par le client depuis r.siege Etalab, sans appel
  // réseau). Persisté sur le record société ET dupliqué sur la face société du
  // contact (la fiche lit la face depuis le record contact, pas societes) pour
  // que le bandeau « siège ailleurs » puisse comparer siege_siret au siret.
  const siegeAdresse = body.siege_adresse || ''
  const siegeSiret = body.siege_siret || ''
  const nombreEtablissements = body.nombre_etablissements != null ? body.nombre_etablissements : null
  // Face société dupliquée sur chaque contact (dette ch.3 : la fiche lit la
  // face société depuis le record contact, pas depuis la table societes).
  const faceSociete = {
    website: '',
    adresse,
    zip,
    ville,
    societe_email: '',
    societe_tel: '',
    societe_linkedin: '',
    forme_juridique: formeLib,
    note_societe: '',
    siege_adresse: siegeAdresse,
    siege_siret: siegeSiret,
    nombre_etablissements: nombreEtablissements
  }

  const stmts = ['BEGIN TRANSACTION;']
  const params = {}

  // [si neuve] CREATE société.
  if (neuve) {
    params.sid = societeId
    params.sbody = {
      userId,
      raison_sociale: raisonClean,
      enseigne,
      cle_normalisee: normaliserSociete(raisonClean),
      siret,
      siren,
      naf: body.naf || '',
      naf_libelle: body.naf_libelle || '',
      forme_juridique_code: body.forme || '',
      forme_juridique: formeLib,
      date_creation: body.date_creation || '',
      capital: body.capital || '',
      effectif: dd.effectif || '',
      etat_administratif: dd.etat_administratif || '',
      statut_diffusion: dd.statut_diffusion || '',
      adresse,
      zip,
      ville,
      siege_adresse: siegeAdresse,
      siege_siret: siegeSiret,
      nombre_etablissements: nombreEtablissements,
      lat: body.lat != null ? body.lat : null,
      lng: body.lng != null ? body.lng : null,
      source: 'prospection',
      search_id: searchId,
      created_at: now,
      updated_at: now
    }
    stmts.push('CREATE type::record("societes", $sid) CONTENT $sbody;')
  }

  // [si neuve] CREATE un contact par dirigeant physique (RGPD : pas
  // d'email/mobile/linkedin, coordonnées laissées vides).
  let dirigeantsCrees = 0
  if (neuve) {
    let di = 0
    for (const d of dd.dirigeants) {
      const contactNom = [d.prenom, d.nom_personne].filter(Boolean).join(' ').trim()
      params['cid' + di] = genId('c_')
      params['cbody' + di] = normalizePersonFields({
        userId,
        nom: raisonClean,
        enseigne,
        contact_nom: contactNom,
        prenom: d.prenom || '',
        nom_personne: d.nom_personne || '',
        poste: d.poste || '',
        email: '',
        phone: '',
        linkedin: '',
        siren,
        siret,
        naf: body.naf || '',
        code_naf: body.naf || '',
        ...faceSociete,
        societe_id: societeId,
        statut: 'pro',
        source: 'prospection',
        search_id: searchId,
        entity_origine: 'mup',
        status: 'new',
        created_at: now,
        updated_at: now
      })
      stmts.push(`CREATE type::record("contacts", $cid${di}) CONTENT $cbody${di};`)
      di++
      dirigeantsCrees++
    }
  }

  // CREATE carte pipeline (sauf société déjà au board). Titre = raison
  // sociale ; contact = 1er dirigeant (vide si dégradé).
  if (!dejaPipeline) {
    const premier = dd.dirigeants[0]
    const contactCarte = premier
      ? [premier.prenom, premier.nom_personne].filter(Boolean).join(' ').trim()
      : ''
    params.pbody = {
      userId,
      company: raisonClean,
      co: raisonClean,
      name: raisonClean,
      enseigne,
      siren,
      siret,
      sector: body.naf_libelle || '',
      address: adresseComplete,
      contact: contactCarte,
      email: '',
      phone: '',
      website: '',
      col: 'prospects',
      val: 0,
      days: 0,
      activity: [],
      source: 'prospection',
      search_id: searchId,
      societe_id: societeId,
      // La carte reçoit la même date de création que le record société et les
      // records dirigeants créés dans cette transaction. Son omission ici
      // était le défaut du chemin nominal d'ajout depuis la Prospection.
      created_at: now
    }
    // Coordonnées Etalab portées par la fiche — celles-là mêmes que cette
    // transaction écrit sur le record société ci-dessus. Aucun appel réseau :
    // la carte naît placée au lieu d'attendre un géocodage au premier
    // affichage de la Carte.
    // NORMALISÉES À L'ÉCRITURE, motif de server/services/referentiel.js :
    // Number puis Number.isFinite, clé POSÉE si finie, OMISE sinon — jamais de
    // null, jamais de NaN sur la carte. Le `!= null` du bloc société ne suffit
    // pas ici : storedLatLng (public/carte.html) fait un parseFloat sans garde
    // de format, une chaîne à virgule décimale y passerait ('48,85' -> 48) et
    // poserait un marqueur à des dizaines de kilomètres, en silence. La chaîne
    // vide est écartée avec l'absence (Number('') vaudrait 0).
    // Traitement PAR COUPLE, comme server.js:740 pour les marqueurs de
    // recherche : une coordonnée seule n'est pas exploitable, et le couple
    // (0,0) est écarté (null-island, que storedLatLng refuse déjà).
    const pLat = (body.lat == null || body.lat === '') ? NaN : Number(body.lat)
    const pLng = (body.lng == null || body.lng === '') ? NaN : Number(body.lng)
    if (Number.isFinite(pLat) && Number.isFinite(pLng) && !(pLat === 0 && pLng === 0)) {
      params.pbody.lat = pLat
      params.pbody.lng = pLng
    }
    stmts.push('CREATE pipeline CONTENT $pbody;')
  }

  stmts.push('COMMIT TRANSACTION;')
  // hasWrites : société neuve OU carte à créer. Si société existante ET déjà
  // au pipeline -> aucune écriture, on évite une transaction vide.
  if (neuve || !dejaPipeline) {
    await db.query(stmts.join('\n'), params)
  }

  return {
    ok: true,
    societe_id: societeId,
    dirigeants_crees: dirigeantsCrees,
    dedup: !neuve,
    // Ce qui a RÉELLEMENT été écrit — la route unitaire n'en avait pas besoin
    // (son 201/200 le dit déjà), le décompte du lot en vit.
    societe_creee: neuve,
    carte_creee: !dejaPipeline
  }
}

// Les trois lookups en direct : une requête chacun, à chaque fiche. C'est ce
// que faisait la route unitaire avant l'extraction, mot pour mot.
function lookupsDirects(userId) {
  return {
    estOptOut: (siret) => checkBlocklistOne(siret),
    trouverSociete: (siren) => findSocieteBySiren(siren, userId),
    estDejaPipeline: async (siren, siret) => {
      const db = await getDb()
      const pres = await db.query('SELECT siren, siret FROM pipeline WHERE userId = $userId', { userId })
      return (pres[0] || []).some(c =>
        (siren && String(c.siren) === siren) || (siret && String(c.siret) === siret)
      )
    }
  }
}

app.post('/api/pipeline/from-lead', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const r = await materialiserProspect(userId, req.body || {}, lookupsDirects(userId))
    if (!r.ok) return res.status(REFUS_PROSPECT[r.refus].http).json(corpsRefus(r.refus))
    return res.status(r.societe_creee ? 201 : 200).json({
      ok: true,
      societe_id: r.societe_id,
      dirigeants_crees: r.dirigeants_crees,
      dedup: r.dedup
    })
  } catch (err) {
    console.error('[pipeline:from-lead]', err)
    res.status(500).json({ error: 'Impossible de matérialiser le prospect' })
  }
})

// ── POST /api/pipeline/from-leads — le même geste, sur un lot ─────────────
// Reçoit un TABLEAU de fiches au contrat de corps de la route unitaire (soit
// { fiches: [...] }, soit le tableau nu) et les matérialise l'une après
// l'autre par materialiserProspect. UN SEUL appel HTTP pour tout le lot : le
// rate-limit global de 60/min n'est pas approché, et rien ne l'exempte.
//
// AUCUN ARRÊT GLOBAL SUR UN REFUS UNITAIRE : une fiche en opposition RGPD, un
// établissement fermé, un SIREN manquant, une panne isolée — la fiche est
// écartée, le lot continue. La réponse est un décompte, jamais une erreur.
//
// Les trois lookups sont chargés UNE fois pour tout le lot puis tenus à jour
// au fil des créations : sans ça, 188 fiches feraient 188 lectures de la
// blocklist, 188 SELECT societes et 188 SELECT pipeline — et deux
// établissements d'un même SIREN présents dans le même lot créeraient deux
// sociétés (le lookup ne voit pas ce que la fiche précédente vient d'écrire).
// Les règles de dédoublonnage, elles, sont identiques à l'unitaire.
app.post('/api/pipeline/from-leads', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  const t0 = Date.now()
  try {
    const body = req.body
    const fiches = Array.isArray(body) ? body : (Array.isArray(body?.fiches) ? body.fiches : null)
    if (!fiches) return res.status(400).json({ error: 'tableau_requis' })

    const decompte = {
      total: fiches.length,
      ajoutees: 0,
      deja_presentes: 0,
      ecartees: 0,
      motifs: { opt_out: 0, etablissement_ferme: 0, siren_manquant: 0, erreur: 0 },
      societes_creees: 0,
      dirigeants_crees: 0
    }
    if (!fiches.length) {
      return res.json({ ok: true, ...decompte, duree_ms: Date.now() - t0 })
    }

    // Opposition RGPD — UNE lecture de blocklist pour tout le lot.
    // checkBlocklistOne n'est rien d'autre que checkBlocklistBatch sur une
    // seule entrée : même clé (hash SIRET + hash SIREN dérivé), même
    // fail-closed (erreur DB -> tout le lot est réputé opposé).
    const bloques = await checkBlocklistBatch(
      fiches.map(f => String(f?.siret || '').replace(/\s+/g, '')).filter(Boolean)
    )

    const db = await getDb()
    // Sociétés déjà connues de l'abonné, indexées par SIREN. Le cœur ne lit que
    // `.id` du record rendu — on n'en garde donc que ça.
    const sres = await db.query('SELECT id, siren FROM societes WHERE userId = $userId', { userId })
    const societesParSiren = new Map()
    for (const s of (sres[0] || [])) {
      if (s?.siren) societesParSiren.set(String(s.siren), { id: s.id })
    }
    // Cartes déjà au board : les deux clés du test unitaire, chacune en Set.
    const pres = await db.query('SELECT siren, siret FROM pipeline WHERE userId = $userId', { userId })
    const pipelineSirens = new Set()
    const pipelineSirets = new Set()
    for (const c of (pres[0] || [])) {
      if (c?.siren) pipelineSirens.add(String(c.siren))
      if (c?.siret) pipelineSirets.add(String(c.siret))
    }

    const lookupsLot = {
      estOptOut: (siret) => bloques.has(siret),
      trouverSociete: (siren) => societesParSiren.get(siren) || null,
      estDejaPipeline: (siren, siret) =>
        (!!siren && pipelineSirens.has(siren)) || (!!siret && pipelineSirets.has(siret))
    }

    // Séquentiel, fiche après fiche. Les fiches qui portent leurs dirigeants
    // (le cas nominal depuis la Prospection) ne touchent plus le réseau du
    // tout ; celles qui n'en portent pas retombent sur le re-fetch Etalab, et
    // c'est pour elles que la boucle reste séquentielle — paralléliser
    // saturerait l'IP de sortie (429), le même écueil que le déroulement de la
    // recherche.
    for (const fiche of fiches) {
      const f = fiche || {}
      try {
        const r = await materialiserProspect(userId, f, lookupsLot)
        if (!r.ok) {
          decompte.ecartees++
          decompte.motifs[r.refus]++
          continue
        }
        // Le cache voit ce que cette fiche vient d'écrire : la suivante, si
        // elle porte le même SIREN, sera dédupliquée comme elle l'aurait été
        // par une relecture en base.
        const siren = String(f.siren || '').replace(/\s+/g, '')
        const siret = String(f.siret || '').replace(/\s+/g, '')
        if (r.societe_creee) {
          decompte.societes_creees++
          societesParSiren.set(siren, { id: 'societes:' + r.societe_id })
        }
        if (r.carte_creee) {
          decompte.ajoutees++
          if (siren) pipelineSirens.add(siren)
          if (siret) pipelineSirets.add(siret)
        } else {
          decompte.deja_presentes++
        }
        decompte.dirigeants_crees += r.dirigeants_crees
      } catch (e) {
        // Panne d'UNE fiche (SurrealDB, données aberrantes) : elle est écartée,
        // le lot ne s'arrête pas. Journalisée pour ne pas disparaître.
        console.error('[pipeline:from-leads] fiche écartée', f.siren || '', e)
        decompte.ecartees++
        decompte.motifs.erreur++
      }
    }

    const duree = Date.now() - t0
    console.log(
      `[pipeline:from-leads] ${decompte.total} fiches en ${duree} ms `
      + `(${Math.round(duree / decompte.total)} ms/fiche) — `
      + `${decompte.ajoutees} ajoutées, ${decompte.deja_presentes} déjà présentes, `
      + `${decompte.ecartees} écartées `
      + `(opt-out ${decompte.motifs.opt_out}, fermé ${decompte.motifs.etablissement_ferme}, `
      + `sans SIREN ${decompte.motifs.siren_manquant}, erreur ${decompte.motifs.erreur})`
    )
    return res.json({ ok: true, ...decompte, duree_ms: duree })
  } catch (err) {
    console.error('[pipeline:from-leads]', err)
    res.status(500).json({ error: 'Impossible de matérialiser le lot de prospects' })
  }
})

// ── Pont coordonnées société entre les deux fiches d'un même établissement ──
//
// Un même établissement existe couramment deux fois chez le MÊME abonné : une
// carte `pipeline` et une (ou plusieurs) fiche(s) `contacts`. Les champs
// ci-dessous sont ceux de l'ENTREPRISE, pas de la personne : saisis d'un
// côté, ils valent de l'autre. Le pont les y recopie.
//
// TABLE DE CORRESPONDANCE EXPLICITE ET ORIENTÉE — une entrée par champ, portant
// sa clé de chaque côté. Les deux tables ne nomment pas tout pareil et la
// symétrie implicite serait DESTRUCTRICE : sur `contacts`, `linkedin` est celui
// de la PERSONNE (il figure dans PERSON_FIELDS) et le LinkedIn d'entreprise s'y
// appelle `societe_linkedin`. Un pont qui recopierait `linkedin` sous le même
// nom effacerait le profil du dirigeant à chaque enregistrement d'une carte.
// D'où : en écrivant vers `contacts`, `linkedin` de la carte devient
// `societe_linkedin` ; en écrivant vers `pipeline`, `societe_linkedin` de la
// fiche redevient `linkedin`. Aucune autre lecture possible, aucune boucle.
//
// C'est aussi de cette table, et d'elle seule, que se dérive la liste blanche
// du SQL : un nom de champ interpolé vient toujours d'ici, jamais d'une clé
// reçue dans un corps de requête.
//
// HORS PÉRIMÈTRE, volontairement : l'adresse (les deux tables ne la découpent
// pas pareil — un bloc d'un côté, voie/CP/ville de l'autre), la raison sociale
// (ses alias sont réécrits par `migrateCard` à chaque chargement), `siret` et
// `siren` (ils sont la CLÉ du pont, ils ne voyagent pas) et tout champ de
// personne.
const CHAMPS_PONT_SOCIETE = [
  // même nom des deux côtés
  { pipeline: 'sector', contacts: 'sector' },
  { pipeline: 'website', contacts: 'website' },
  { pipeline: 'societe_email', contacts: 'societe_email' },
  { pipeline: 'societe_tel', contacts: 'societe_tel' },
  { pipeline: 'facebook', contacts: 'facebook' },
  { pipeline: 'instagram', contacts: 'instagram' },
  { pipeline: 'enseigne', contacts: 'enseigne' },
  // le nom change selon la table
  { pipeline: 'forme', contacts: 'forme_juridique' },
  { pipeline: 'naf', contacts: 'code_naf' },
  { pipeline: 'notes', contacts: 'note_societe' },
  { pipeline: 'linkedin', contacts: 'societe_linkedin' }
]

// Clé d'un champ du pont dans la table visée — l'unique lecture autorisée de la
// table de correspondance, orientée par la table et jamais par le corps reçu.
const clePont = (champ, table) => (table === 'pipeline' ? champ.pipeline : champ.contacts)

// Valeur d'un champ du pont, vue comme une chaîne comparable : absent, null et
// chaîne vide sont un seul et même « pas renseigné ».
const valeurPont = (v) => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()))

// Ce qu'un PUT fait réellement bouger parmi les champs du pont — comparaison de
// l'enregistrement AVANT (`rec`, déjà relu par les deux routes) au corps qui va
// le remplacer. `source` est la table qu'on vient d'écrire : elle décide sous
// quel nom lire, la table de correspondance décidant sous quel nom rendre.
// Deux filtres, dans cet ordre :
//
//   • VIDE NON RETENU — effacer une case d'un côté ne vide PAS l'autre. Limite
//     assumée et voulue : le pont propage la saisie, jamais la suppression.
//     Sans ce filtre, un formulaire qui n'envoie simplement pas la clé effacerait
//     la fiche jumelle à chaque geste.
//   • INCHANGÉ NON RETENU — c'est la garde de déclenchement, et elle porte sur
//     les onze champs : aucun d'eux modifié, patch vide, le pont ne cherche rien
//     et n'écrit rien. Les pages enregistrent en continu et la quasi-totalité de
//     leurs PUT ne touchent aucun de ces champs (colonne déplacée, note de
//     personne, rendez-vous). C'est cette garde qui tient le coût, la table
//     jumelle étant balayée sans index.
//
// Le patch est rendu DÉJÀ TRADUIT — clés de la table de DESTINATION — et ne
// porte que les champs modifiés, jamais les onze en bloc.
function patchPontSociete(rec, body, source) {
  const patch = {}
  const destination = source === 'pipeline' ? 'contacts' : 'pipeline'
  for (const champ of CHAMPS_PONT_SOCIETE) {
    const lu = clePont(champ, source)
    const apres = valeurPont(body?.[lu])
    if (!apres) continue
    if (valeurPont(rec?.[lu]) === apres) continue
    patch[clePont(champ, destination)] = apres
  }
  return patch
}

// Recopie les coordonnées société modifiées sur les enregistrements du MÊME
// SIRET appartenant au MÊME abonné, dans la table jumelle.
//
// CLÉ : LE SIRET SEUL — ni `siren`, ni `societe_id`. Les deux sont à la maille
// de l'unité légale (`societe_id` est dédupliqué par `findSocieteBySiren`) et
// feraient descendre le téléphone du siège sur l'agence. SIRET normalisé comme
// ailleurs (espaces retirés, cf. findSocieteBySiret) ; SIRET vide → aucun pont.
//
// TOUS LES JUMEAUX, jamais le premier trouvé : un abonné a couramment plusieurs
// contacts pour un même SIRET, un par dirigeant. Ces champs sont ceux de
// l'entreprise, ils valent pour chacun d'eux — d'où l'UPDATE … WHERE, sans LIMIT.
//
// LE `WHERE` PORTE LUI-MÊME `userId` : la garde d'appartenance de la route
// protège le record désigné par l'URL, jamais celui qu'on va chercher. Même
// motif que le `DELETE agenda WHERE userId = $userId AND ficheId = $ficheId`
// de la route voisine.
//
// ÉCRITURE DIRECTE EN BASE, JAMAIS PAR LA ROUTE JUMELLE : un SET ciblé sur les
// seuls champs modifiés, sur le modèle d'enrichReferentielActionnable. Ne pas
// traverser de route règle d'un coup la réentrance (le pont ne se rappelle pas
// lui-même), le doublement de `trackContactEdit` et l'application à contretemps
// de `normalizePersonFields`. Corollaire : le pont N'APPELLE PAS
// `trackContactEdit` — cette fonction n'est pas idempotente (un CREATE par
// appel) et ses lignes sont lues (agrégation par recherche, export RGPD) : une
// saisie unique compterait double, et autant de fois qu'il y a de jumeaux.
//
// Contrairement au référentiel mutualisé, le pont ÉCRASE : entre deux
// enregistrements du même abonné, la saisie la plus récente fait foi.
//
// FIRE-AND-FORGET, NO-THROW : appelée sans await, tout échec avalé et loggé —
// le pont ne doit jamais faire échouer l'enregistrement qui l'a déclenché.
// Aucun jumeau trouvé → 0 ligne modifiée, silence, pas erreur.
async function ponterCoordonneesSociete({ userId, siret, table, patch }) {
  try {
    if (!userId) return
    const cleanSiret = String(siret || '').replace(/\s+/g, '')
    if (!cleanSiret) return
    const params = { siret: cleanSiret, userId }
    const assigns = []
    for (const champ of CHAMPS_PONT_SOCIETE) {
      // Liste blanche stricte, DÉRIVÉE DE LA TABLE DE CORRESPONDANCE : on
      // parcourt la table et non les clés du patch, si bien que le nom interpolé
      // dans le SQL vient toujours d'ici — jamais d'une valeur reçue. La clé
      // retenue est celle de la table VISÉE, `table` étant la destination.
      const k = clePont(champ, table)
      if (!(k in (patch || {}))) continue
      assigns.push(`${k} = $${k}`)
      params[k] = patch[k]
    }
    if (!assigns.length) return
    const db = await getDb()
    // Table jamais en variable Surreal — on switch sur 2 SQL hardcodés
    // (cf. selectContactRecord).
    const sql = table === 'pipeline'
      ? `UPDATE pipeline SET ${assigns.join(', ')} WHERE userId = $userId AND siret = $siret`
      : `UPDATE contacts SET ${assigns.join(', ')} WHERE userId = $userId AND siret = $siret`
    await db.query(sql, params)
  } catch (e) {
    console.warn('[pont-societe]', String(e?.message || e).slice(0, 80))
  }
}

app.put('/api/pipeline/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const { id } = req.params
    const db = await getDb()

    // Ownership check : 404 si record absent OU appartient à un autre user
    const existing = await db.query('SELECT * FROM type::record("pipeline", $id)', { id })
    const rec = existing[0]?.[0]
    if (!rec || rec.userId !== userId) {
      return res.status(404).json({ error: 'Carte introuvable' })
    }

    // UPDATE — strip body.id et préserve userId initial
    const cleanBody = retirerProjection({ ...(req.body || {}) })
    delete cleanBody.id
    cleanBody.userId = userId
    // Date de création préservée. UPDATE … CONTENT remplace le record entier :
    // un client qui omet created_at l'effacerait à chaque sauvegarde. On
    // réinjecte celle du record relu ci-dessus (repli createdAt, nom abandonné
    // mais encore porté par l'existant). Une date de création ne se réécrit
    // pas : si le corps en porte une autre, celle du record gagne.
    const dateCreationOrigine = rec.created_at || rec.createdAt
    if (dateCreationOrigine) cleanBody.created_at = dateCreationOrigine
    const result = await db.query('UPDATE type::record("pipeline", $id) CONTENT $body', { id, body: cleanBody })
    // Enrichissement additif du référentiel mutualisé (clé SIRET) — motif calqué
    // sur PUT /api/contacts/:id, même intention : ce que l'abonné saisit ou enrichit
    // depuis la carte remonte au référentiel mutualisé. FIRE-AND-FORGET (sans await),
    // no-op silencieux si le SIRET est absent du référentiel. Additif strict côté DB.
    // NB : la route contacts étant polymorphe (id préfixé pipeline: → table pipeline),
    // une écriture par ce chemin fera aussi partir l'appel côté contacts. Sans
    // conséquence : l'enrichissement est additif et n'écrit que sur les champs vides.
    // Le LinkedIn d'une carte est stocké sous `linkedin` — jamais sous
    // `societe_linkedin`, que seule la fiche société écrit. On lisait donc une
    // clé toujours absente, et aucun LinkedIn saisi depuis une carte ne
    // remontait au référentiel. L'ancienne clé reste en repli.
    enrichReferentielActionnable(cleanBody.siret, {
      website: cleanBody.website,
      societe_email: cleanBody.societe_email,
      societe_tel: cleanBody.societe_tel,
      societe_linkedin: cleanBody.linkedin || cleanBody.societe_linkedin
    })
    // Pont coordonnées société — la carte vient d'être écrite, le jumeau à
    // rejoindre est donc du côté `contacts`. FIRE-AND-FORGET (sans await).
    ponterCoordonneesSociete({
      userId,
      siret: cleanBody.siret,
      table: 'contacts',
      patch: patchPontSociete(rec, cleanBody, 'pipeline')
    })
    res.json(result[0]?.[0] || result[0] || {})
  } catch (err) {
    console.error('[pipeline]', err)
    res.status(500).json({ error: 'Impossible de mettre à jour la carte pipeline' })
  }
})

app.delete('/api/pipeline/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    // Tolère les 2 formes : "abc123" (id nu) ou "pipeline:abc123" (forme SurrealDB
    // complète). Tolère aussi "contacts:abc123" → strip le préfixe table.
    const id = cleanRecordId('pipeline', req.params.id) || String(req.params.id || '').replace(/^[a-z_]+:/i, '')
    const existing = await db.query('SELECT * FROM type::record("pipeline", $id)', { id })
    const rec = existing[0]?.[0]
    if (!rec || rec.userId !== userId) {
      return res.status(404).json({ error: 'Carte introuvable' })
    }
    await db.query('DELETE type::record("pipeline", $id)', { id })
    // Cascade : les évènements agenda créés depuis cette fiche portent son
    // ficheId. Sans ce geste ils survivaient à la fiche et restaient au
    // calendrier en pointant vers un prospect disparu. Le WHERE userId porte
    // le contrôle d'appartenance, en plus de celui déjà fait sur la fiche
    // elle-même juste au-dessus.
    await db.query(
      'DELETE agenda WHERE userId = $userId AND ficheId = $ficheId',
      { userId, ficheId: String(id) }
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('[pipeline]', err)
    res.status(500).json({ error: 'Impossible de supprimer la carte pipeline' })
  }
})

app.get('/api/contacts', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const rows = await queryOrEmpty(db, 'SELECT * FROM contacts WHERE userId = $userId', { userId })
    // Projection du référentiel mutualisé — cf. GET /api/pipeline. La liste n'est
    // pas paginée : c'est le découpage par tranches de 100 de la jointure qui
    // borne le lot.
    res.json(await projeterReferentiel(rows, userId))
  } catch (err) {
    console.error('[contacts]', err)
    res.status(500).json({ error: 'Impossible de lire les contacts' })
  }
})

app.post('/api/contacts', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const body = retirerProjection({ ...(req.body || {}), userId })
    // Lien société (SCHEMALESS, champs optionnels) : societe_id (record/null),
    // statut ("pro"/"reserve"), source (saisie/linkedin/phone/mail/carnet).
    // Persistés tels quels via CONTENT ; on coerce seulement societe_id vide -> null.
    // Les contacts qui n'envoient pas ces clés ne sont pas touchés.
    if ('societe_id' in body && !(typeof body.societe_id === 'string' && body.societe_id.trim())) {
      body.societe_id = null
    }
    // Brique A — face personne : champs additifs garantis + sync emails[]/email
    // et telephones[]/phone. Non destructif (voir lib/person-fields.js).
    Object.assign(body, normalizePersonFields(body))
    const db = await getDb()
    const cleanId = cleanRecordId('contacts', body?.id)
    if (cleanId) {
      const { record, status, action } = await upsertRecord(db, 'contacts', cleanId, body)
      if (action === 'updated') console.log(`[contacts] upsert contacts:${cleanId}`)
      return res.status(status).json(record)
    }
    const result = await db.query('CREATE contacts CONTENT $body', { body })
    res.status(201).json(result[0]?.[0] || result[0] || null)
  } catch (err) {
    console.error('[contacts]', err)
    res.status(500).json({ error: 'Impossible de créer le contact' })
  }
})

// Deux valeurs sont-elles la MÊME valeur, du point de vue d'une fiche ? Absent,
// null et chaîne vide sont un seul et même « pas renseigné » — sans quoi le
// premier enregistrement d'un contact créé depuis la Prospection compterait
// vingt modifications pour vingt champs restés vides. Le reste se compare en
// chaîne (3 et "3" ne sont pas deux valeurs) ; objets et tableaux par leur
// forme sérialisée.
function memeValeur(a, b) {
  const vide = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
  if (vide(a) && vide(b)) return true
  if (vide(a) !== vide(b)) return false
  if (typeof a === 'object' || typeof b === 'object') {
    try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false }
  }
  return String(a) === String(b)
}

// Champs qu'un PUT fait réellement bouger sur un contact — comparaison de
// l'enregistrement AVANT aux clés que le corps apporte.
//
// LA COMPARAISON NE PORTE QUE SUR LES CLÉS PRÉSENTES DANS LE CORPS. Elle
// parcourait l'union des deux jeux de clés, parce que l'écriture était un
// remplacement intégral : une clé absente du corps disparaissait de la base,
// c'était donc bien une modification. L'écriture est devenue CIBLÉE (MERGE) et
// cette prémisse est tombée — une clé absente n'est plus touchée. La garder
// aurait compté la quarantaine de champs non envoyés comme autant de
// modifications à chaque frappe, dans des lignes qui sont LUES (agrégation par
// recherche, export RGPD).
//
// Les quatre clés ignorées ne disent rien de ce que l'abonnée a saisi :
// `updated_at` est réécrit par la page à chaque enregistrement, et un contact
// serait « modifié » à chaque passage sans qu'un seul caractère ait changé.
const CHAMPS_HORS_MODIF = new Set(['id', 'userId', 'created_at', 'updated_at'])
function champsModifies(avant, apres) {
  const bouges = []
  for (const c of Object.keys(apres || {})) {
    if (CHAMPS_HORS_MODIF.has(c)) continue
    if (!memeValeur(avant?.[c], apres?.[c])) bouges.push(c)
  }
  return bouges
}

// Face personne d'un corps PARTIEL — cf. normalizePersonFields (lib/person-fields.js).
//
// Cette fonction-là GARANTIT LA PRÉSENCE des quinze champs personne, valeurs
// vides comprises. C'était sans conséquence tant que le client envoyait le
// record entier ; appliquée telle quelle à un corps partiel, elle y injecterait
// quinze clés vides que l'écriture ciblée poserait en base — la face personne
// serait effacée à chaque enregistrement d'un champ société.
//
// On la fait donc travailler sur le record FUSIONNÉ (l'existant relu, recouvert
// du corps), et on ne retient de son résultat que les clés que le corps portait
// déjà. Ce qu'elle apporte alors, ce sont ses COERCIONS (civilité en chaîne,
// consentement en booléen, listes nettoyées et dédoublonnées) — pas des clés
// supplémentaires.
//
// SEULE EXCEPTION, et c'est tout l'objet de la normalisation : les deux couples
// liste/valeur-unique. Envoyer `emails` fait écrire `email`, et réciproquement ;
// idem pour `telephones`/`phone`. C'est le seul endroit où le serveur écrit une
// clé que le client ne lui a pas envoyée, et il le fait parce que les deux
// formes sont une seule donnée.
function normaliserFacePersonnePartielle(rec, corps) {
  const base = { ...(rec || {}) }
  // Le corps fait autorité sur la donnée qu'il porte. S'il n'envoie que la forme
  // unique (`email`, `phone`) sans sa liste, la liste de l'existant ne doit pas
  // la recouvrir : cleanList retiendrait la liste et ignorerait la valeur reçue.
  if ('email' in corps && !('emails' in corps)) delete base.emails
  if ('phone' in corps && !('telephones' in corps)) delete base.telephones
  const complet = normalizePersonFields({ ...base, ...corps })
  const retenu = {}
  for (const k of Object.keys(corps)) retenu[k] = complet[k]
  if ('emails' in corps || 'email' in corps) {
    retenu.emails = complet.emails
    retenu.email = complet.email
  }
  if ('telephones' in corps || 'phone' in corps) {
    retenu.telephones = complet.telephones
    retenu.phone = complet.phone
  }
  return retenu
}

// ── Helpers /api/contacts/:id polymorphes (Sprint 3.5) ──
// La liste /contacts fusionne côté client /api/contacts (table contacts)
// et /api/pipeline (table pipeline). Les ids transmis au serveur portent
// le préfixe de leur table d'origine. Ces routes routent dynamiquement
// vers la bonne table en fonction du préfixe.
function detectContactTable(rawId) {
  return String(rawId || '').startsWith('pipeline:') ? 'pipeline' : 'contacts'
}
function stripContactPrefix(rawId) {
  return String(rawId || '').replace(/^(contacts|pipeline):/, '')
}
async function selectContactRecord(db, tb, id) {
  // Table jamais en variable Surreal — on switch sur 2 SQL hardcoded.
  const sql = tb === 'pipeline'
    ? 'SELECT * FROM type::record("pipeline", $id)'
    : 'SELECT * FROM type::record("contacts", $id)'
  const r = await queryOrEmpty(db, sql, { id })
  return r[0] || null
}

app.get('/api/contacts/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const tb = detectContactTable(req.params.id)
    const id = stripContactPrefix(req.params.id)
    const db = await getDb()
    const rec = await selectContactRecord(db, tb, id)
    if (!rec || rec.userId !== userId) {
      return res.status(404).json({ error: 'Contact introuvable' })
    }
    res.json(rec)
  } catch (err) {
    console.error('[contacts:get]', err)
    res.status(500).json({ error: 'Lecture contact impossible' })
  }
})

app.put('/api/contacts/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const tb = detectContactTable(req.params.id)
    const id = stripContactPrefix(req.params.id)
    const db = await getDb()
    const rec = await selectContactRecord(db, tb, id)
    if (!rec || rec.userId !== userId) {
      return res.status(404).json({ error: 'Contact introuvable' })
    }
    const cleanBody = retirerProjection({ ...(req.body || {}) })
    delete cleanBody.id
    cleanBody.userId = userId
    // Lien société (SCHEMALESS) : voir POST /api/contacts. Coerce societe_id vide -> null.
    if ('societe_id' in cleanBody && !(typeof cleanBody.societe_id === 'string' && cleanBody.societe_id.trim())) {
      cleanBody.societe_id = null
    }
    // Corps sans aucune donnée (seul l'userId forcé ci-dessus) : rien à écrire.
    // On rend l'enregistrement relu — pour l'appelant, un enregistrement sans
    // rien à enregistrer est un succès, pas une panne.
    if (Object.keys(cleanBody).length <= 1) return res.json(rec)
    // Brique A — face personne (table contacts uniquement, jamais pipeline).
    if (tb === 'contacts') Object.assign(cleanBody, normaliserFacePersonnePartielle(rec, cleanBody))

    // ── ÉCRITURE CIBLÉE : LES SEULES CLÉS REÇUES, JAMAIS LE RECORD ENTIER ──
    //
    // `CONTENT` remplaçait le record par le corps. Un client qui tenait une copie
    // datée — un onglet resté ouvert — écrasait donc en silence tout ce qu'un
    // autre onglet, le pont inter-fiches ou un autre appareil avait écrit depuis,
    // y compris des champs qu'il n'avait jamais affichés. Rien ne le signalait,
    // ni à l'écran ni au journal.
    //
    // `MERGE` n'écrit que les clés présentes dans le corps ; une clé absente
    // n'est pas touchée. La distinction que porte la page — clé absente = champ
    // non modifié, clé à chaîne vide = champ effacé par l'abonnée — arrive donc
    // intacte en base, sans sentinelle ni convention : la présence de la clé dit
    // tout.
    //
    // POURQUOI MERGE ET NON LE `SET k = $k` À LISTE BLANCHE du pont
    // (ponterCoordonneesSociete) ou du référentiel (enrichReferentielActionnable) :
    // ces deux-là écrivent un jeu de champs FERMÉ et énumérable, et interpolent
    // donc des noms tirés d'une constante du serveur. `contacts` est SCHEMALESS,
    // son jeu de champs est ouvert, et aucune liste blanche honnête n'y est
    // possible. MERGE tient la même exigence par un chemin plus court : le corps
    // est un PARAMÈTRE LIÉ, aucun nom de champ n'est interpolé dans le SQL, donc
    // aucun ne peut venir d'une valeur reçue. Même verbe et même raison qu'à
    // PUT /api/user-settings, « pour que Frais et Statistiques cohabitent sans
    // s'écraser ».
    //
    // Acquis au passage : `created_at` n'est plus effacé par un client qui
    // l'omet — il n'est simplement plus touché. La réinjection que fait la route
    // pipeline voisine n'a plus lieu d'être de ce côté.
    const sql = tb === 'pipeline'
      ? 'UPDATE type::record("pipeline", $id) MERGE $body'
      : 'UPDATE type::record("contacts", $id) MERGE $body'
    const result = await db.query(sql, { id, body: cleanBody })
    // SIRET de l'écriture, pour les deux appels qui suivent : le corps s'il le
    // porte, sinon l'enregistrement relu. Le corps est devenu PARTIEL et le
    // SIRET n'est pas modifiable depuis la fiche (champ readonly) : il n'y
    // figure quasiment jamais, et continuer à le lire là seulement aurait éteint
    // d'un coup l'enrichissement du référentiel ET le pont, tous deux clés sur
    // lui. Le corps garde la priorité — une écriture délibérée du SIRET fait
    // autorité sur l'état d'avant.
    const siretEcriture = cleanBody.siret || rec.siret
    // Trace d'usage — UNE LIGNE PAR MODIFICATION RÉELLE, jamais par requête. La
    // fiche société enregistre en continu (autosave) et la plupart de ses PUT ne
    // changent rien : la comparaison avant/après tranche, liste vide → aucune
    // écriture (garde interne à trackContactEdit). Le rattachement à la recherche
    // d'origine vient de l'enregistrement AVANT (`rec.search_id`, posé par
    // from-lead) : le corps arrive du client, il ne fait pas autorité là-dessus.
    // FIRE-AND-FORGET, échec silencieux : jamais un enregistrement perdu pour
    // une trace manquée.
    trackContactEdit({
      userId,
      searchId: rec.search_id,
      contactTable: tb,
      contactId: id,
      champs: champsModifies(rec, cleanBody)
    }).catch(() => {})
    // Enrichissement additif du référentiel mutualisé (clé SIRET) depuis la saisie
    // abonné — FIRE-AND-FORGET (sans await) : ne bloque pas la réponse déjà servie,
    // no-op silencieux si le SIRET est absent du référentiel. Additif strict côté DB.
    //
    // Le corps étant partiel, les quatre valeurs ne sont plus renvoyées à chaque
    // enregistrement mais à la SEULE saisie qui les concerne. L'enrichissement
    // n'écrivant que sur les champs vides, le résultat en base est le même —
    // c'est le bruit qui disparaît, pas un apport.
    enrichReferentielActionnable(siretEcriture, {
      website: cleanBody.website,
      societe_email: cleanBody.societe_email,
      societe_tel: cleanBody.societe_tel,
      societe_linkedin: cleanBody.societe_linkedin
    })
    // Pont coordonnées société — cette route est polymorphe : elle vient
    // d'écrire l'une OU l'autre table selon le préfixe de l'id. Le jumeau à
    // rejoindre est donc dans L'AUTRE, déterminée par celle qu'on vient
    // d'écrire. FIRE-AND-FORGET (sans await).
    //
    // Le corps partiel ne change RIEN à ce que patchPontSociete produit : un
    // champ non envoyé y passe par le filtre « vide non retenu » (valeurPont
    // d'une clé absente rend la chaîne vide), là où un champ envoyé inchangé
    // passait par le filtre « inchangé non retenu ». Deux portes, même sortie —
    // le patch est celui d'avant, aux mêmes conditions de déclenchement.
    ponterCoordonneesSociete({
      userId,
      siret: siretEcriture,
      table: tb === 'pipeline' ? 'contacts' : 'pipeline',
      patch: patchPontSociete(rec, cleanBody, tb)
    })
    res.json(result[0]?.[0] || result[0] || {})
  } catch (err) {
    console.error('[contacts:put]', err)
    res.status(500).json({ error: 'Impossible de mettre à jour le contact' })
  }
})

app.delete('/api/contacts/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const tb = detectContactTable(req.params.id)
    const id = stripContactPrefix(req.params.id)
    const db = await getDb()
    const rec = await selectContactRecord(db, tb, id)
    if (!rec || rec.userId !== userId) {
      return res.status(404).json({ error: 'Contact introuvable' })
    }
    const sql = tb === 'pipeline'
      ? 'DELETE type::record("pipeline", $id)'
      : 'DELETE type::record("contacts", $id)'
    await db.query(sql, { id })
    res.json({ ok: true })
  } catch (err) {
    console.error('[contacts:delete]', err)
    res.status(500).json({ error: 'Impossible de supprimer le contact' })
  }
})

// Dédup d'une société par SIRET, scopée au user. Retourne le record ou null.
// SIRET nettoyé des espaces (les sources INSEE le formatent par blocs).
// Siret vide → null (jamais de match sur chaîne vide). Index idx_societes_siret.
async function findSocieteBySiret(siret, userId) {
  const clean = String(siret || '').replace(/\s+/g, '')
  if (!clean || !userId) return null
  const db = await getDb()
  const result = await db.query(
    'SELECT * FROM societes WHERE siret = $siret AND userId = $userId LIMIT 1',
    { siret: clean, userId }
  )
  return result[0]?.[0] || null
}

// Dédup d'une société par SIREN, scopée au user. Retourne le record ou null.
// SIREN nettoyé des espaces (les sources INSEE le formatent par blocs).
// Siren vide → null (jamais de match sur chaîne vide). Index idx_societes_siren.
async function findSocieteBySiren(siren, userId) {
  const clean = String(siren || '').replace(/\s+/g, '')
  if (!clean || !userId) return null
  const db = await getDb()
  const result = await db.query(
    'SELECT * FROM societes WHERE siren = $siren AND userId = $userId LIMIT 1',
    { siren: clean, userId }
  )
  return result[0]?.[0] || null
}

// ── Normalisation des dirigeants — LA règle, en UN seul endroit ──────────
// Trois passes, dans cet ordre : on ne garde que les personnes physiques
// identifiées, on les mappe aux champs contacts, on dédoublonne les mandats
// répétés.
//   prénom  : PREMIER MOT seulement (Etalab empile tous les prénoms d'état
//             civil — « FABIENNE FRANCOISE MARIE-JOSEPHE » → « FABIENNE »)
//   nom     : brut (nom de naissance + nom d'usage entre parenthèses gardés)
//   poste   : qualite
//   dédup   : clé prénom(1er mot) + nom, insensible à la casse ; Etalab répète
//             la même personne sur plusieurs mandats (périodes distinctes),
//             on garde la 1re occurrence
// Les personnes morales (type_dirigeant ≠ 'personne physique', portant une
// denomination) sont rejetées : on ne matérialise que des contacts physiques.
//
// SERT AUX DEUX VOIES : le re-fetch Etalab ci-dessous, ET les dirigeants que
// la page transmet avec la fiche (déjà ramenés par la recherche). Une seule
// règle, donc une seule forme de contact, quelle que soit la voie d'entrée —
// sans quoi les contacts créés par un ajout en bloc n'auraient pas la même
// forme que ceux créés jusqu'ici.
//
// DEUX FORMES EN ENTRÉE, aucune supposée : le chemin Etalab de /api/search
// rend `prenoms` (tous les prénoms, séparés par des espaces) et `qualite` ; le
// chemin cache (referentielRowToFiche) rend `prenom` ET `prenoms` (la même
// valeur) plus `qualite`. On lit `prenoms` d'abord, `prenom` en repli — le
// premier mot est pris dans les deux cas, le résultat est le même.
//
// Le filtre « au moins un nom ou un prénom » est appliqué APRÈS le mapping
// (prenom vide ⟺ source des prénoms vide, nom_personne vide ⟺ nom vide) :
// même population retenue, une seule lecture des champs d'entrée.
function normaliserDirigeants(liste) {
  const brut = (Array.isArray(liste) ? liste : [])
    .filter(d => d && typeof d === 'object')
    .filter(d => d.type_dirigeant === 'personne physique')
    .map(d => {
      const prenomsSrc = typeof d.prenoms === 'string' && d.prenoms.trim()
        ? d.prenoms
        : (typeof d.prenom === 'string' ? d.prenom : '')
      return {
        prenom: prenomsSrc.trim().split(/\s+/)[0] || '',
        nom_personne: typeof d.nom === 'string' ? d.nom.trim() : '',
        poste: typeof d.qualite === 'string' ? d.qualite.trim() : ''
      }
    })
    .filter(d => d.prenom || d.nom_personne)
  const vus = new Set()
  return brut.filter(d => {
    const cle = (d.prenom + '|' + d.nom_personne).toLowerCase().trim()
    if (vus.has(cle)) return false
    vus.add(cle)
    return true
  })
}

// ── Re-fetch dirigeants Etalab par SIREN (matérialisation d'un prospect) ──
// Au passage d'un lead en société on recharge la fiche complète recherche-
// entreprises pour récupérer, en UN SEUL appel (zéro requête en plus) :
//   - dirigeants[] (filtrés aux personnes physiques)
//   - tranche_effectif_salarie / etat_administratif / statut_diffusion
// Mapping dirigeant -> { prenom, nom_personne, poste } (champs contacts).
// Les personnes morales (type_dirigeant !== 'personne physique', portant une
// denomination) sont rejetées : on ne matérialise que des contacts physiques.
//
// DÉGRADÉ GRACIEUX : tout échec (429 persistant, réseau, 5xx, fiche absente)
// retourne un résultat VIDE — jamais de throw. L'appelant crée la société
// quand même (dirigeants_crees:0), un hoquet API ne bloque pas l'ajout.
// 429 : un seul retry, qui lit Retry-After et patiente avant de réessayer.
async function refetchDirigeants(siren) {
  const vide = { dirigeants: [], effectif: '', etat_administratif: '', statut_diffusion: '' }
  const clean = String(siren || '').replace(/\s+/g, '')
  if (!clean) return vide
  const url = 'https://recherche-entreprises.api.gouv.fr/search?q=' + encodeURIComponent(clean) + '&per_page=1'
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url)
      // 429 rate-limit : sur la 1re tentative on respecte Retry-After (défaut
      // 1 s) puis on réessaie UNE fois ; 429 persistant -> dégradé vide.
      if (r.status === 429) {
        if (attempt === 0) {
          const ra = parseInt(r.headers.get('retry-after'), 10)
          const delay = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000
          await new Promise(res => setTimeout(res, delay))
          continue
        }
        return vide
      }
      if (!r.ok) return vide
      const data = await r.json()
      const fiche = Array.isArray(data.results) ? data.results[0] : null
      if (!fiche) return vide
      // Forme des dirigeants : la règle commune, pas une deuxième écriture
      // (prénom au 1er mot, nom brut, poste depuis qualite, dédup des mandats).
      const dirigeants = normaliserDirigeants(fiche.dirigeants)
      return {
        dirigeants,
        effectif: typeof fiche.tranche_effectif_salarie === 'string' ? fiche.tranche_effectif_salarie : '',
        etat_administratif: typeof fiche.etat_administratif === 'string' ? fiche.etat_administratif : '',
        statut_diffusion: typeof fiche.statut_diffusion === 'string' ? fiche.statut_diffusion : ''
      }
    } catch (e) {
      return vide
    }
  }
  return vide
}

// ── /api/societes — calquées sur /api/contacts (SCHEMALESS, scoping userId,
// cleanRecordId, type::record hardcodé). cle_normalisee via normaliserSociete.
app.get('/api/societes', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    res.json(await queryOrEmpty(db, 'SELECT * FROM societes WHERE userId = $userId', { userId }))
  } catch (err) {
    console.error('[societes]', err)
    res.status(500).json({ error: 'Impossible de lire les sociétés' })
  }
})

app.post('/api/societes', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const body = { ...(req.body || {}), userId }
    // cle_normalisee calculée si absente ; valeur fournie explicitement respectée.
    if (!body.cle_normalisee && body.raison_sociale) {
      body.cle_normalisee = normaliserSociete(body.raison_sociale)
    }
    const now = new Date().toISOString()
    if (!body.created_at) body.created_at = now
    body.updated_at = now
    const db = await getDb()
    const cleanId = cleanRecordId('societes', body?.id)
    if (cleanId) {
      const { record, status, action } = await upsertRecord(db, 'societes', cleanId, body)
      if (action === 'updated') console.log(`[societes] upsert societes:${cleanId}`)
      return res.status(status).json(record)
    }
    const result = await db.query('CREATE societes CONTENT $body', { body })
    res.status(201).json(result[0]?.[0] || result[0] || null)
  } catch (err) {
    console.error('[societes]', err)
    res.status(500).json({ error: 'Impossible de créer la société' })
  }
})

app.put('/api/societes/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const id = cleanRecordId('societes', req.params.id) || String(req.params.id || '').replace(/^[a-z_]+:/i, '')
    const existing = await db.query('SELECT * FROM type::record("societes", $id)', { id })
    const rec = existing[0]?.[0]
    if (!rec || rec.userId !== userId) return res.status(404).json({ error: 'Société introuvable' })
    const cleanBody = { ...(req.body || {}) }
    delete cleanBody.id
    cleanBody.userId = userId
    // Recalcule la clé si la raison sociale change (sauf clé fournie explicitement).
    if (
      cleanBody.raison_sociale &&
      cleanBody.raison_sociale !== rec.raison_sociale &&
      !('cle_normalisee' in (req.body || {}))
    ) {
      cleanBody.cle_normalisee = normaliserSociete(cleanBody.raison_sociale)
    }
    // Préserve created_at initial (CONTENT remplace tout le record).
    if (rec.created_at) cleanBody.created_at = rec.created_at
    cleanBody.updated_at = new Date().toISOString()
    const result = await db.query('UPDATE type::record("societes", $id) CONTENT $body', { id, body: cleanBody })
    res.json(result[0]?.[0] || result[0] || {})
  } catch (err) {
    console.error('[societes:put]', err)
    res.status(500).json({ error: 'Impossible de mettre à jour la société' })
  }
})

app.delete('/api/societes/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const id = cleanRecordId('societes', req.params.id) || String(req.params.id || '').replace(/^[a-z_]+:/i, '')
    const existing = await db.query('SELECT * FROM type::record("societes", $id)', { id })
    const rec = existing[0]?.[0]
    if (!rec || rec.userId !== userId) return res.status(404).json({ error: 'Société introuvable' })
    await db.query('DELETE type::record("societes", $id)', { id })
    res.json({ ok: true })
  } catch (err) {
    console.error('[societes:delete]', err)
    res.status(500).json({ error: 'Impossible de supprimer la société' })
  }
})

// ── /api/dev/reset-contacts — purge dev : vide contacts + societes + pipeline
// du userId courant en UNE transaction tout-ou-rien. Outil de test destructeur,
// gardé par le flag ENABLE_DEV_RESET (absent → 404, ne révèle pas la route).
// Exempté du rate-limit global et du gate abonnement (cf. skip + middleware).
app.post('/api/dev/reset-contacts', async (req, res) => {
  if (process.env.ENABLE_DEV_RESET !== '1') return res.status(404).end()
  const userId = requireUserId(req, res)
  if (!userId) return
  if (req.body?.confirm !== 'RESET') {
    return res.status(400).json({ error: 'confirmation requise' })
  }
  try {
    const db = await getDb()
    const result = await db.query(
      'BEGIN TRANSACTION;\n' +
      'DELETE contacts WHERE userId = $userId RETURN BEFORE;\n' +
      'DELETE societes WHERE userId = $userId RETURN BEFORE;\n' +
      'DELETE pipeline WHERE userId = $userId RETURN BEFORE;\n' +
      'COMMIT TRANSACTION;',
      { userId }
    )
    res.json({
      ok: true,
      contacts_supprimes: (result[0] || []).length,
      societes_supprimees: (result[1] || []).length,
      pipeline_supprimes: (result[2] || []).length
    })
  } catch (err) {
    console.error('[dev:reset-contacts]', err)
    res.status(500).json({ error: 'Reset impossible' })
  }
})

// ── /api/import — moteur d'import contacts multi-format ──
// Le client envoie { filename, content } avec content = base64 du fichier brut
// (uniforme csv/xlsx/vcf : xlsx est binaire). analyserImport (lib/import.js)
// est pur (zéro DB) ; seule la route /api/import écrit, en transaction.

function genId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

// Construit et exécute l'écriture en UNE transaction SurrealDB : sociétés
// absentes d'abord, puis personnes (création ou enrichissement). Les ids des
// sociétés neuves sont générés côté JS pour résoudre societe_id avant l'écriture.
// Erreur -> la transaction est annulée, rien n'est écrit à moitié.
async function ecrireImport(db, userId, plan) {
  const now = new Date().toISOString()

  // Sociétés existantes (cle_normalisee -> { id, raison }).
  const sExist = await db.query(
    'SELECT id, cle_normalisee, raison_sociale FROM societes WHERE userId = $userId',
    { userId }
  )
  // societe_id stocké SANS préfixe de table (cohérent avec genId). La relecture
  // SurrealDB renvoie l'id préfixé ("societes:xxx") -> on strip pour que les
  // clés d'index coïncident avec celles écrites à la création (sinon le 2e
  // import ne reconnaît plus l'existant et recrée des doublons).
  const cleToSociete = new Map()
  for (const s of sExist[0] || []) {
    if (s.cle_normalisee) {
      cleToSociete.set(s.cle_normalisee, { id: String(s.id).replace(/^societes:/, ''), raison: s.raison_sociale || '' })
    }
  }

  // Contacts existants -> index par email, par (contact_nom + societe_id) et
  // par societe_id (pour ne pas re-matérialiser une entité pure déjà représentée).
  const cExist = await db.query('SELECT * FROM contacts WHERE userId = $userId', { userId })
  const byEmail = new Map()
  const byNomSoc = new Map()
  const bySocieteId = new Map()
  for (const c of cExist[0] || []) {
    if (c.email) byEmail.set(String(c.email).toLowerCase(), c)
    // Même normalisation d'id que cleToSociete : strip du préfixe "societes:".
    const cSocId = c.societe_id ? String(c.societe_id).replace(/^societes:/, '') : ''
    const nomNorm = normaliserSociete(c.contact_nom || '')
    if (nomNorm) byNomSoc.set(nomNorm + '|' + cSocId, c)
    if (cSocId) bySocieteId.set(cSocId, c)
  }

  // Clés société portées par au moins une personne de cet import : ces sociétés
  // sont déjà représentées par une fiche (face société du contact). Les autres
  // sont des ENTITÉS PURES, à matérialiser comme contact à face personne vide.
  const clesAvecPersonne = new Set(
    (plan.personnes || []).map(p => p.societe_cle).filter(Boolean)
  )

  // Plan société indexé par clé : la face société (adresse/cp/ville/site/email/
  // tél standard) est dupliquée sur le contact, car la fiche lit cette face
  // depuis le record contact, jamais depuis la table societes (dette technique
  // tracée en roadmap : source de vérité à basculer sur societes via societe_id).
  const planSocieteByCle = new Map(
    (plan.societes || []).map(s => [s.cle_normalisee, s])
  )

  const stmts = ['BEGIN TRANSACTION;']
  const params = { }
  let nbSocietes = 0
  let nbCrees = 0
  let nbEnrichis = 0
  let nbEntites = 0

  // 1) Sociétés absentes.
  let si = 0
  for (const s of plan.societes) {
    if (cleToSociete.has(s.cle_normalisee)) continue
    const id = genId('s_')
    cleToSociete.set(s.cle_normalisee, { id, raison: s.raison_sociale || '' })
    params['sid' + si] = id
    params['sbody' + si] = {
      userId,
      raison_sociale: s.raison_sociale || '',
      cle_normalisee: s.cle_normalisee,
      email: s.email || '',
      phone: s.tel || '',
      website: s.site || '',
      linkedin: s.linkedin || '',
      adresse: s.adresse || '',
      ville: s.ville || '',
      zip: s.cp || '',
      forme_juridique: s.forme_juridique || '',
      // Identité INSEE — jamais fournie par l'import (reste vide), alimentée
      // ultérieurement par l'enrichissement SIRENE / la fiche société.
      siret: s.siret || '',
      siren: s.siren || '',
      naf: s.naf || '',
      naf_libelle: s.naf_libelle || '',
      forme_juridique_code: s.forme_juridique_code || '',
      date_creation: s.date_creation || '',
      capital: s.capital || '',
      effectif: s.effectif || '',
      note_societe: s.note_societe || '',
      source: s.source || 'import',
      created_at: now,
      updated_at: now
    }
    stmts.push(`CREATE type::record("societes", $sid${si}) CONTENT $sbody${si};`)
    si++
    nbSocietes++
  }

  // 2) Personnes : création ou enrichissement (vides only).
  let ci = 0
  for (const p of plan.personnes) {
    const societe = p.societe_cle ? cleToSociete.get(p.societe_cle) : null
    const societeId = societe ? societe.id : null
    const sPlan = p.societe_cle ? planSocieteByCle.get(p.societe_cle) : null
    // Face société dupliquée sur le contact (lue par la fiche depuis le contact).
    const faceSociete = {
      website: (sPlan && sPlan.site) || '',
      adresse: (sPlan && sPlan.adresse) || '',
      zip: (sPlan && sPlan.cp) || '',
      ville: (sPlan && sPlan.ville) || '',
      societe_email: (sPlan && sPlan.email) || '',
      societe_tel: (sPlan && sPlan.tel) || '',
      societe_linkedin: (sPlan && sPlan.linkedin) || '',
      forme_juridique: (sPlan && sPlan.forme_juridique) || '',
      note_societe: (sPlan && sPlan.note_societe) || ''
    }
    const fullName = [p.prenom, p.nom].filter(Boolean).join(' ').trim()
    const nomNorm = normaliserSociete(fullName)

    let existant = null
    if (p.email) existant = byEmail.get(String(p.email).toLowerCase())
    if (!existant && !p.email && nomNorm) {
      existant = byNomSoc.get(nomNorm + '|' + (societeId || ''))
    }

    if (existant) {
      // Enrichir les champs vides uniquement, jamais écraser.
      const merged = { ...existant }
      const apport = {
        prenom: p.prenom, nom_personne: p.nom, contact_nom: fullName, poste: p.poste,
        email: p.email, phone: p.tel, linkedin: p.linkedin, note_personne: p.note_personne,
        ...faceSociete
      }
      for (const [k, v] of Object.entries(apport)) {
        if (!merged[k] && v) merged[k] = v
      }
      if (!merged.societe_id && societeId) merged.societe_id = societeId
      if (!merged.statut) merged.statut = p.statut
      else if (merged.statut === 'reserve' && p.statut === 'pro') merged.statut = 'pro'
      if (!merged.source && p.source) merged.source = p.source
      merged.userId = userId
      merged.updated_at = now
      const id = String(existant.id).replace(/^contacts:/, '')
      delete merged.id
      params['cid' + ci] = id
      params['cbody' + ci] = normalizePersonFields(merged)
      stmts.push(`UPDATE type::record("contacts", $cid${ci}) CONTENT $cbody${ci};`)
      nbEnrichis++
    } else {
      const id = genId('c_')
      params['cid' + ci] = id
      params['cbody' + ci] = normalizePersonFields({
        userId,
        nom: societe ? societe.raison : fullName,
        contact_nom: fullName,
        prenom: p.prenom || '',
        nom_personne: p.nom || '',
        poste: p.poste || '',
        email: p.email || '',
        phone: p.tel || '',
        linkedin: p.linkedin || '',
        note_personne: p.note_personne || '',
        ...faceSociete,
        societe_id: societeId,
        statut: p.statut,
        source: p.source || 'import',
        status: 'new',
        entity_origine: 'mup',
        created_at: now,
        updated_at: now
      })
      stmts.push(`CREATE type::record("contacts", $cid${ci}) CONTENT $cbody${ci};`)
      nbCrees++
    }
    ci++
  }

  // 3) Entités pures : société sans aucune personne -> contact face personne
  // vide. On NE pose PAS email/phone/contact_nom dessus (sinon la fiche
  // afficherait une personne fantôme) : les coordonnées restent sur la société.
  // Invariant d'affichage : une fiche deux faces, jamais amputée.
  for (const s of plan.societes) {
    if (clesAvecPersonne.has(s.cle_normalisee)) continue
    const soc = cleToSociete.get(s.cle_normalisee)
    if (!soc) continue
    if (bySocieteId.has(String(soc.id))) continue // déjà matérialisée
    const id = genId('c_')
    params['cid' + ci] = id
    params['cbody' + ci] = normalizePersonFields({
      userId,
      nom: s.raison_sociale || soc.raison || '',
      contact_nom: '',
      prenom: '',
      poste: '',
      email: '',
      phone: '',
      linkedin: '',
      societe_linkedin: s.linkedin || '',
      website: s.site || '',
      adresse: s.adresse || '',
      zip: s.cp || '',
      ville: s.ville || '',
      societe_email: s.email || '',
      societe_tel: s.tel || '',
      forme_juridique: s.forme_juridique || '',
      note_societe: s.note_societe || '',
      societe_id: soc.id,
      statut: 'pro',
      source: s.source || 'import',
      status: 'new',
      entity_origine: 'mup',
      created_at: now,
      updated_at: now
    })
    stmts.push(`CREATE type::record("contacts", $cid${ci}) CONTENT $cbody${ci};`)
    bySocieteId.set(String(soc.id), true)
    nbEntites++
    ci++
  }

  stmts.push('COMMIT TRANSACTION;')
  if (si + ci > 0) await db.query(stmts.join('\n'), params)

  // Enrichissement additif du référentiel mutualisé (clé SIRET) depuis la saisie
  // importée — face société dupliquée sur les contacts (personnes) ET entités pures
  // dérivent toutes deux de plan.societes. FIRE-AND-FORGET (sans await) : ne bloque
  // pas la réponse d'import, no-op silencieux pour tout SIRET absent du référentiel.
  for (const s of plan.societes) {
    enrichReferentielActionnable(s.siret, {
      website: s.site,
      societe_email: s.email,
      societe_tel: s.tel,
      societe_linkedin: s.linkedin
    })
  }

  return {
    stats: {
      ...plan.stats,
      nb_societes_creees: nbSocietes,
      nb_contacts_crees: nbCrees,
      nb_contacts_enrichis: nbEnrichis,
      nb_entites_materialisees: nbEntites
    }
  }
}

app.post('/api/import/dryrun', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const { filename, content } = req.body || {}
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'Contenu manquant' })
    }
    const buffer = Buffer.from(content, 'base64')
    const plan = analyserImportDetaille(filename || '', buffer)
    res.json(plan)
  } catch (err) {
    console.error('[import:dryrun]', err)
    res.status(400).json({ error: err.message || 'Analyse impossible' })
  }
})

app.post('/api/import', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const { filename, content, mapping } = req.body || {}
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'Contenu manquant' })
    }
    const buffer = Buffer.from(content, 'base64')
    const map = mapping && typeof mapping === 'object' ? mapping : null
    const plan = analyserImport(filename || '', buffer, map)
    const db = await getDb()
    const result = await ecrireImport(db, userId, plan)
    res.json({ ok: true, ...result })
  } catch (err) {
    console.error('[import]', err)
    res.status(500).json({ error: err.message || 'Import impossible' })
  }
})

app.get('/api/agenda', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const ficheId = typeof req.query?.ficheId === 'string' ? req.query.ficheId.trim() : ''
    // Deux formes ont été écrites : nue ("abc123") depuis le Pipeline, préfixée
    // ("pipeline:abc123") depuis l'Agenda et la Visio. L'égalité stricte faisait
    // disparaître les secondes de la fiche. La lecture accepte les deux le temps
    // que l'ancien s'éteigne ; rien n'est réécrit.
    const ficheIdNu = ficheId.replace(/^pipeline:/, '')
    const result = ficheId
      ? await queryOrEmpty(
          db,
          'SELECT * FROM agenda WHERE userId = $userId AND ficheId IN $ficheIds',
          { userId, ficheIds: [ficheIdNu, 'pipeline:' + ficheIdNu] }
        )
      : await queryOrEmpty(db, 'SELECT * FROM agenda WHERE userId = $userId', { userId })
    res.json(result)
  } catch (err) {
    console.error('[agenda]', err)
    res.status(500).json({ error: 'Impossible de lire les évènements agenda' })
  }
})
app.post('/api/agenda', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const body = { ...(req.body || {}), userId }
    const db = await getDb()
    const cleanId = cleanRecordId('agenda', body?.id)
    if (cleanId) {
      const { record, status, action } = await upsertRecord(db, 'agenda', cleanId, body)
      if (action === 'updated') console.log(`[agenda] upsert agenda:${cleanId}`)
      return res.status(status).json(record)
    }
    const result = await db.query('CREATE agenda CONTENT $body', { body })
    res.status(201).json(result[0]?.[0] || result[0] || null)
  } catch (err) {
    console.error('[agenda]', err)
    res.status(500).json({ error: 'Impossible de créer l\'évènement agenda' })
  }
})
app.put('/api/agenda/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const { id } = req.params
    const db = await getDb()
    const existing = await db.query('SELECT * FROM type::record("agenda", $id)', { id })
    const rec = existing[0]?.[0]
    if (!rec || rec.userId !== userId) {
      return res.status(404).json({ error: 'Évènement introuvable' })
    }
    const cleanBody = { ...(req.body || {}) }
    delete cleanBody.id
    cleanBody.userId = userId
    const result = await db.query('UPDATE type::record("agenda", $id) CONTENT $body', { id, body: cleanBody })
    res.json(result[0]?.[0] || result[0] || {})
  } catch (err) {
    console.error('[agenda]', err)
    res.status(500).json({ error: 'Impossible de mettre à jour l\'évènement agenda' })
  }
})
app.delete('/api/agenda/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const { id } = req.params
    const existing = await db.query('SELECT * FROM type::record("agenda", $id)', { id })
    const rec = existing[0]?.[0]
    if (!rec || rec.userId !== userId) {
      return res.status(404).json({ error: 'Évènement introuvable' })
    }
    await db.query('DELETE type::record("agenda", $id)', { id })
    res.json({ ok: true })
  } catch (err) {
    console.error('[agenda]', err)
    res.status(500).json({ error: 'Impossible de supprimer l\'évènement agenda' })
  }
})

// ── FIL D'ACTIVITÉ ──
// Une note ou une action saisie depuis n'importe quelle porte — panneau du
// Pipeline, fiche contact, agenda, visio — appartient à l'entreprise, pas au
// record par lequel elle est entrée. Tant que le journal était un tableau
// `activity[]` ou `noteEntries[]` DANS un enregistrement, il était dans un
// seul des deux par construction. Table à part, sur le modèle d'agenda.
//
// Forme d'un enregistrement : userId, ancrage (id local du record de départ,
// préfixe de table retiré), type, texte, ts (ISO 8601). Rien de dérivé n'y
// est écrit : la désignation de l'entreprise est une résolution de lecture.
//
// `agenda` reste le journal du planifié. Le fil le lit, il ne l'absorbe pas.

// Normalise une clé d'ancrage : id local, sans préfixe de table. Le client
// peut envoyer l'une ou l'autre forme, comme pour ficheId.
function normAncrage(raw) {
  return String(raw == null ? '' : raw).replace(/^[a-z_]+:/i, '').trim()
}

app.get('/api/activites', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    // `ancrage` accepte une liste séparée par des virgules : la résolution de
    // lecture rassemble les ids équivalents d'une même entreprise et les lit
    // en un seul aller-retour.
    const raw = typeof req.query?.ancrage === 'string' ? req.query.ancrage : ''
    const ancrages = raw.split(',').map(normAncrage).filter(Boolean)
    const result = ancrages.length
      ? await queryOrEmpty(
          db,
          'SELECT * FROM activites WHERE userId = $userId AND ancrage IN $ancrages',
          { userId, ancrages }
        )
      : await queryOrEmpty(db, 'SELECT * FROM activites WHERE userId = $userId', { userId })
    res.json(result)
  } catch (err) {
    console.error('[activites]', err)
    res.status(500).json({ error: 'Impossible de lire le fil d\'activité' })
  }
})
app.post('/api/activites', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const body = { ...(req.body || {}), userId }
    if (body.ancrage != null) body.ancrage = normAncrage(body.ancrage)
    const db = await getDb()
    const cleanId = cleanRecordId('activites', body?.id)
    if (cleanId) {
      const { record, status, action } = await upsertRecord(db, 'activites', cleanId, body)
      if (action === 'updated') console.log(`[activites] upsert activites:${cleanId}`)
      return res.status(status).json(record)
    }
    const result = await db.query('CREATE activites CONTENT $body', { body })
    res.status(201).json(result[0]?.[0] || result[0] || null)
  } catch (err) {
    console.error('[activites]', err)
    res.status(500).json({ error: 'Impossible d\'enregistrer l\'activité' })
  }
})
app.put('/api/activites/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const { id } = req.params
    const db = await getDb()
    const existing = await db.query('SELECT * FROM type::record("activites", $id)', { id })
    const rec = existing[0]?.[0]
    if (!rec || rec.userId !== userId) {
      return res.status(404).json({ error: 'Activité introuvable' })
    }
    const cleanBody = { ...(req.body || {}) }
    delete cleanBody.id
    cleanBody.userId = userId
    if (cleanBody.ancrage != null) cleanBody.ancrage = normAncrage(cleanBody.ancrage)
    const result = await db.query('UPDATE type::record("activites", $id) CONTENT $body', { id, body: cleanBody })
    res.json(result[0]?.[0] || result[0] || {})
  } catch (err) {
    console.error('[activites]', err)
    res.status(500).json({ error: 'Impossible de mettre à jour l\'activité' })
  }
})
app.delete('/api/activites/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const { id } = req.params
    const existing = await db.query('SELECT * FROM type::record("activites", $id)', { id })
    const rec = existing[0]?.[0]
    if (!rec || rec.userId !== userId) {
      return res.status(404).json({ error: 'Activité introuvable' })
    }
    await db.query('DELETE type::record("activites", $id)', { id })
    res.json({ ok: true })
  } catch (err) {
    console.error('[activites]', err)
    res.status(500).json({ error: 'Impossible de supprimer l\'activité' })
  }
})

// ── INSEE OAuth2 token cache ── déplacé dans server/services/insee.js,
// getInseeToken importé en tête de fichier (seule source de vérité).

// Paris/Lyon/Marseille : Etalab indexe les établissements sous les codes
// d'arrondissement, PAS sous le code commune globale INSEE (75056/69123/13055
// renvoient ~0 établissement). On détend ces 3 codes en CSV d'arrondissements ;
// toute autre commune passe en l'état. Bornes vérifiées côté Etalab.
const PLM_ARRONDISSEMENTS = {
  '75056': Array.from({ length: 20 }, (_, i) => String(75101 + i)).join(','), // Paris 75101–75120
  '69123': Array.from({ length: 9 },  (_, i) => String(69381 + i)).join(','), // Lyon  69381–69389
  '13055': Array.from({ length: 16 }, (_, i) => String(13201 + i)).join(','), // Marseille 13201–13216
}
function communeParam(code) { return PLM_ARRONDISSEMENTS[code] || code }
// Départements à arrondissements municipaux, DÉRIVÉS des clés PLM_ARRONDISSEMENTS
// (75056→75, 69123→69, 13055→13). Même principe qu'au front : pas de nouvelle liste.
const PLM_DEPTS = new Set(Object.keys(PLM_ARRONDISSEMENTS).map(c => c.slice(0, 2)))

// ── API proxies ──
app.get('/api/search', async (req, res) => {
  // Garde départements à arrondissements : sans code_commune, la requête viserait
  // le département entier (gros gisement, centaines de pages). On exige une
  // ville/arrondissement. Placée en tête : bloque aussi le chemin lecture-cache.
  const plmDept = String(req.query.departement || '').trim()
  const plmCommune = String(req.query.code_commune || '').trim()
  if (PLM_DEPTS.has(plmDept) && !plmCommune) {
    res.status(400).json({ error: 'Choisissez une ville ou un arrondissement pour lancer la recherche sur ce département.' })
    return
  }
  // ── Lecture-cache référentiel-first (geste B, branchement) ──
  // Si le gisement (naf, dept) est marqué COMPLET et FRAIS, on sert la page depuis
  // referentiel_societes sans jamais taper Etalab. Toutes les fonctions appelées
  // sont fail-safe (null / 0 / results vides sur erreur) : à la moindre incertitude
  // on retombe sur le chemin Etalab d'origine. Le try/catch de ceinture garantit
  // qu'une exception inattendue AVANT res.json dégrade en MISS, jamais en 500.
  // ABSTENTIONS sur ce chemin (une lecture ne rajeunit jamais ce qu'elle lit, sinon
  // rien ne périme) : PAS d'upsertReferentiel (rajeunirait refreshed_at, que
  // readReferentiel filtre à 30 j), aucune écriture sur referentiel_gisements. On NE
  // rejoue PAS keepLead : le SQL filtre déjà dept/NAF/commune/CP et readReferentiel
  // applique déjà la blocklist ; le ctx Etalab rejetterait à tort. Le tracking
  // historique (lead_search) est CONSERVÉ : un HIT reste une recherche à tracer.
  try {
    const cDept = String(req.query.departement || '').trim()
    const cNaf = req.query.activite_principale || req.query.code_naf || ''
    const cCommune = req.query.code_commune
    const cCp = req.query.code_postal
    const cPage = req.query.page
    const cPerPage = Math.min(parseInt(req.query.per_page) || 25, 25)
    // Cache tenté UNIQUEMENT sur dept simple (sans virgule) + NAF présents.
    if (cDept && !cDept.includes(',') && String(cNaf).trim()) {
      const gisement = await isGisementComplete(cNaf, cDept)
      if (gisement) {
        const total = await countReferentielFresh({ departement: cDept, naf: cNaf, commune: cCommune, codePostal: cCp })
        if (total > 0) {
          const lecture = await readReferentiel({ departement: cDept, naf: cNaf, commune: cCommune, codePostal: cCp, page: cPage, perPage: cPerPage })
          const pageNum = Number(cPage) || 1
          // Garde de sécurité : un gisement marqué mais qui rend une page 1 VIDE ne
          // doit pas servir une réponse creuse → on laisse Etalab reprendre la main.
          // Aux pages > 1, une page vide est une fin de flux légitime (raw_count 0).
          if (lecture.results.length > 0 || pageNum !== 1) {
            // DETTE ASSUMÉE (non corrigée ici) : total_results compte des LIGNES
            // (un SIRET par ligne) alors que le front déduplique par SIREN. Sur un
            // gisement multi-établissements, S.market est donc SURESTIMÉ et le front
            // paginera jusqu'à la page vide au lieu de s'arrêter au marché réel. La
            // terminaison reste garantie côté front par raw_count === 0.
            console.log(`[search-cache] HIT ${cNaf}:${cDept} page=${pageNum} servi=${lecture.results.length} total=${total}`)
            if (req.userId) {
              trackLeadSearch({
                userId: req.userId,
                nafCode: req.query.activite_principale || req.query.code_naf || req.query.q || '',
                nafLabel: req.query.naf_label || '',
                regionCode: req.query.code_region || req.query.region || '',
                regionName: req.query.region_name || '',
                departmentCode: req.query.code_departement || req.query.departement || '',
                departmentName: req.query.department_name || '',
                cityName: req.query.city_name || req.query.ville || '',
                resultsCount: total,
                searchId: req.query.search_id
              }).catch(() => {})
            }
            res.json({ results: lecture.results, total_results: total, raw_count: lecture.raw_count, page: pageNum, per_page: cPerPage, from_cache: true })
            return
          }
        }
      }
    }
  } catch (e) {
    console.warn('[search-cache]', String(e?.message || e).slice(0, 80))
  }
  const params = new URLSearchParams()
  if(req.query.q) params.set('q', req.query.q)
  if(req.query.region) params.set('region', req.query.region)
  if(req.query.code_naf) params.set('activite_principale', req.query.code_naf)
  if(req.query.activite_principale) params.set('activite_principale', req.query.activite_principale)
  // Filtres geo natifs recherche-entreprises — pousse en upstream pour réduire
  // le drop client-side (avant : 96% des résultats jetés par pickLocalEtab).
  if(req.query.departement) params.set('departement', req.query.departement)
  if(req.query.code_postal) params.set('code_postal', req.query.code_postal)
  if(req.query.code_commune) params.set('code_commune', communeParam(req.query.code_commune))
  // per_page respecte la demande du front (= PAGE_SIZE client), borné à 25
  // = max Etalab. Aligne pagination client/upstream pour éviter les pages
  // fantômes au-delà du dataset. Lève la régression de volume introduite
  // par le commit 1828e2d (per_page hardcoded à 10 sur cette branche).
  params.set('per_page', String(Math.min(parseInt(req.query.per_page) || 25, 25)))
  if(req.query.page) params.set('page', req.query.page)
  // ── Appel Etalab : retry serveur sur 429 + timeout ──
  // Le 429 vient du rate-limit posé sur l'IP de sortie Railway, PARTAGÉE entre
  // tous les abonnés : la cadence du front (déjà throttlée) n'y peut rien, on
  // absorbe donc ici. 3 tentatives max, et UNIQUEMENT sur 429 — tout autre
  // non-2xx (500/502/503) garde le chemin actuel (garde !r.ok, aucun retry).
  // Délai : Retry-After s'il est présent et parsable (borné à 5 s), sinon
  // backoff 1 s puis 2 s. Jitter ±20 % OBLIGATOIRE : sans lui tous les clients
  // rate-limités retapent en phase et le 429 se reproduit en boucle.
  // Sur épuisement : même 502 { error, upstream_status: 429 } qu'avant — le
  // retry front reste la 2e ligne, et S.upstreamPage n'étant incrémentée qu'au
  // succès, la pagination n'est pas affectée.
  // Timeout 9 s (AbortSignal) : sans lui un amont qui pend bloque indéfiniment.
  // Un abort compte comme un échec de tentative, mais n'est PAS un 429 : il ne
  // lit pas Retry-After et retombe sur le backoff par défaut.
  const etalabUrl = 'https://recherche-entreprises.api.gouv.fr/search?' + params.toString()
  const pageLog = req.query.page || 1
  const jitter = ms => Math.round(ms * (0.8 + Math.random() * 0.4))
  try {
    let r = null
    for (let attempt = 0; attempt < 3; attempt++) {
      let aborted = false
      try {
        r = await fetch(etalabUrl, { signal: AbortSignal.timeout(9000) })
      } catch (e) {
        // Timeout / réseau : dernière tentative -> on laisse remonter au
        // catch global du handler (502 muet, comportement actuel).
        if (attempt === 2) throw e
        aborted = true
      }
      if (!aborted && r.status !== 429) break
      if (attempt === 2) break
      let delay = attempt === 0 ? 1000 : 2000
      if (!aborted) {
        const ra = parseInt(r.headers.get('retry-after'), 10)
        if (Number.isFinite(ra) && ra > 0) delay = Math.min(ra * 1000, 5000)
        console.warn('[search] Etalab 429, retry ' + (attempt + 1) + '/2 page=' + pageLog)
      }
      await new Promise(resolve => setTimeout(resolve, jitter(delay)))
    }
    // Seul capteur de fréquence des 429 réellement subis après absorption.
    if (r && r.status === 429) console.warn('[search] Etalab 429 épuisé page=' + pageLog)
    // Garde non-ok : sur 429 (rate-limit) ou 5xx, Etalab renvoie un corps d'erreur
    // SANS `results`. Le parser puis le servir en 200 le fait passer pour une page
    // vide côté front → armement du fallback resp2 (2e appel Etalab sur une API déjà
    // saturée). On relaie ici un échec PROPRE (non-2xx) : le front throw sur resp.ok
    // == false AVANT le test resp2, et laisse le retry cadencé (fetchLeadsWithRetry /
    // loadMore, backoff + jitter) gérer. Doctrine « ne jamais saturer ».
    if (!r.ok) {
      console.warn('[search] Etalab non-ok status=' + r.status + ' page=' + (req.query.page || 1))
      return res.status(502).json({ error: 'Service temporairement indisponible', upstream_status: r.status })
    }
    const data = await r.json()
    // Recherche par IDENTIFIANT (searchById : SIRET 14 ou SIREN 9 chiffres saisi
    // volontairement, sans dept/NAF/région). Consultation CIBLÉE → on n'applique PAS
    // le filtre d'activité : un établissement fermé délibérément recherché doit être
    // VU, pas masqué (l'état voyage sur la fiche pour signalement). Opt-out RGPD et
    // filtre diffusion restent, eux, pleinement appliqués (via keepLead ci-dessous).
    const qNorm = String(req.query.q || '').replace(/\s+/g, '')
    const isIdentifierSearch = /^(\d{9}|\d{14})$/.test(qNorm) &&
      !req.query.departement && !req.query.activite_principale &&
      !req.query.code_naf && !req.query.region
    // Filtre qualité : on retire les fiches non-prospectables (sans dirigeant,
    // cessées, ou nature juridique exclue — SCI/organismes publics/droit
    // étranger). total_results est ré-estimé via le ratio observé sur la page
    // courante — extrapolation acceptable car l'API ne donne pas le compte
    // exact filtré.
    if (Array.isArray(data.results)) {
      const fetched = data.results.length
      // brut upstream de la page (avant isProspectable/diffusion/blocklist) —
      // exposé au front pour distinguer "page upstream vide" (fin de flux) de
      // "page upstream pleine mais 100%-filtrée serveur" (≠ fin de flux).
      data.raw_count = fetched
      // Le ratio extrapole le total ANNONCÉ ; il doit compter les fiches
      // RÉELLEMENT servies. isProspectable teste l'entreprise ; on lui ADJOINT
      // le même test d'adresse que keepLead (établissement retenu ouvert), pour
      // que le total baisse dans la même proportion que les fiches servies. On
      // n'introduit PAS ici la déduplication (pipeline abonné) ni la blocklist :
      // le total mesure le MARCHÉ disponible, pas ce qu'il reste à traiter — l'y
      // mêler ferait fondre le marché à mesure que l'abonné remplit son pipeline.
      const ratioDepts = req.query.departement ? String(req.query.departement).split(',') : []
      const kept = data.results.filter(f => {
        if (!isProspectable(f, isIdentifierSearch)) return false
        const L = pickLocalEtab(f, ratioDepts)
        return isServedAddressActive(L.etab, f, isIdentifierSearch)
      })
      data.results = kept
      if (fetched > 0 && typeof data.total_results === 'number') {
        const ratio = kept.length / fetched
        data.total_results = Math.round(data.total_results * ratio)
      }
    }
    // ── Filtrage unique via keepLead (source de vérité, Étape 1 Voie 1) ──
    // Remplace diffusion + blocklist et ajoute dept/ville/NAF/dédup, EN AVAL de
    // la capture raw_count (le brut reste intact) et de l'extrapolation
    // isProspectable (le « 182 » d'ouverture reste). data.results est ici
    // l'échantillon isProspectable ; keepLead re-vérifie (pur, idempotent) puis
    // applique les 5 autres filtres. Pré-résout les 2 impurs UNE fois/page.
    if (Array.isArray(data.results) && data.results.length) {
      const brut = data.results.length
      // Impur 1 — blocklist opt-out : collecte TOUS les SIRET de la page (siège
      // + matching), un seul batch (calque doctrine anti-révélation).
      const allSirets = []
      for (const r of data.results) {
        if (r?.siege?.siret) allSirets.push(r.siege.siret)
        if (Array.isArray(r?.matching_etablissements)) {
          for (const e of r.matching_etablissements) if (e?.siret) allSirets.push(e.siret)
        }
      }
      const blocked = await checkBlocklistBatch(allSirets)
      // Impur 2 — pipeline du user (dédup) : siren ET siret, falsy exclus
      // (réplique _getExistingSirets). Fail-open : échec DB → Set vide, jamais
      // de 500 (la dédup est ignorée, pas bloquante).
      const existing = new Set()
      try {
        const db = await getDb()
        const pres = await db.query('SELECT * FROM pipeline WHERE userId = $userId', { userId: req.userId })
        for (const c of (pres[0] || [])) {
          if (c?.siren) existing.add(String(c.siren))
          if (c?.siret) existing.add(String(c.siret))
        }
      } catch (e) {
        console.warn('[search] lecture pipeline échouée (dédup ignorée) :', e.message)
      }
      const ctx = {
        allowedDepts: req.query.departement ? String(req.query.departement).split(',') : [],
        naf: String(req.query.code_naf || req.query.activite_principale || '').replace(/\./g, ''),
        existing,
        blocked,
        allowInactive: isIdentifierSearch
      }
      data.results = data.results.filter(f => keepLead(f, ctx))
      console.log(`[search] page=${req.query.page || 1} brut=${brut} garde=${data.results.length}`)
    }
    // servedSiret — SIRET de l'établissement servi par fiche (matching[0], repli
    // siège), normalisé. Fonction PURE (n'utilise que r / Array / String) : hissée
    // ici pour le TRI DE SERVICE, sans dépendre du scope de ce bloc.
    const servedSiret = r => {
      const m = Array.isArray(r?.matching_etablissements) ? r.matching_etablissements : []
      return String((m[0] && m[0].siret) || (r?.siege && r.siege.siret) || '').replace(/\s+/g, '')
    }
    // ── Tri de service — relecture referentiel_societes propre au tri ──
    // Réordonne les fiches par le triplet [rangDirect, site?, linkedin?], où
    // rangDirect (clé primaire) est le socle de COORDONNÉES DIRECTES lu en base :
    //   0 = mail ET tél · 1 = mail seul · 2 = tél seul · 3 = ni l'un ni l'autre.
    // À triplet égal, l'ordre Etalab est préservé (Array.prototype.sort stable, V8).
    // Lecture PROPRE au tri (getDb + SELECT dédié), autonome.
    // Fail-open : tout échec laisse data.results dans l'ordre Etalab.
    // RIEN de nouveau sérialisé — on ne fait que réordonner ; aucun rang / flag /
    // has_contact / linkedin n'est écrit sur les fiches. Map de tri strictement locale.
    if (Array.isArray(data.results) && data.results.length) {
      try {
        const uniq = [...new Set(data.results.map(servedSiret).filter(Boolean))]
        const flags = new Map() // siret -> { email:bool, tel:bool, site:bool, linkedin:bool }
        if (uniq.length) {
          const db = await getDb()
          const qr = await db.query(
            'SELECT siret, societe_email, societe_tel, website, societe_linkedin FROM referentiel_societes WHERE siret IN $sirets',
            { sirets: uniq }
          )
          for (const row of (qr && qr[0]) || []) {
            const k = typeof row?.siret === 'string' ? row.siret.trim() : ''
            if (!k) continue
            const email = typeof row.societe_email === 'string' && row.societe_email.trim() !== ''
            const tel = typeof row.societe_tel === 'string' && row.societe_tel.trim() !== ''
            const site = typeof row.website === 'string' && row.website.trim() !== ''
            const linkedin = typeof row.societe_linkedin === 'string' && row.societe_linkedin.trim() !== ''
            flags.set(k, { email, tel, site, linkedin })
          }
        }
        // Triplet local par fiche — décoré une fois, jamais recalculé dans le comparateur.
        // rangDirect vient EXCLUSIVEMENT des coordonnées lues en base (jamais de
        // matching_etablissements). Siret absent de flags → [3,1,1] (tout en bas).
        const rankOf = r => {
          const f = flags.get(servedSiret(r))
          if (!f) return [3, 1, 1]
          const rangDirect = (f.email && f.tel) ? 0 : f.email ? 1 : f.tel ? 2 : 3
          return [rangDirect, f.site ? 0 : 1, f.linkedin ? 0 : 1]
        }
        const rk = new Map(data.results.map(r => [r, rankOf(r)]))
        data.results.sort((a, b) => {
          const ra = rk.get(a), rb = rk.get(b)
          return (ra[0] - rb[0]) || (ra[1] - rb[1]) || (ra[2] - rb[2])
        })
      } catch (e) {
        console.warn('[search:sort-service]', String(e?.message || e).slice(0, 80))
      }
    }
    res.json(data)
    // Fire-and-forget : alimentation du référentiel entreprises mutualisé
    // (socle Etalab). Lancé APRÈS res.json, sans await — même modèle que
    // trackLeadSearch : zéro impact sur la latence servie à l'abonné. Le service
    // avale tout échec (try/catch global + log [referentiel-upsert]), donc jamais
    // de promesse rejetée à neutraliser ici.
    upsertReferentiel(data.results)
    // Fire-and-forget : tracking historique recherches. Lancé APRÈS res.json
    // pour ne jamais bloquer la réponse au front. Échec silencieux côté
    // search-tracker, .catch final pour neutraliser toute promesse rejetée.
    //
    // cityName VIENT DE city_name, le libellé que la page envoie déjà (« Paris
    // 1er », « Lyon 3e »). On lisait code_commune : l'historique gardait un code
    // INSEE là où l'abonnée avait demandé une ville. `ville` reste le repli des
    // appels qui n'envoient pas le libellé.
    //
    // searchId : minté par la page au lancement, identique pour toutes les pages
    // d'une même recherche. Nettoyé et validé côté search-tracker.
    if (req.userId) {
      trackLeadSearch({
        userId: req.userId,
        nafCode: req.query.activite_principale || req.query.code_naf || req.query.q || '',
        nafLabel: req.query.naf_label || '',
        regionCode: req.query.code_region || req.query.region || '',
        regionName: req.query.region_name || '',
        departmentCode: req.query.code_departement || req.query.departement || '',
        departmentName: req.query.department_name || '',
        cityName: req.query.city_name || req.query.ville || '',
        resultsCount: typeof data.total_results === 'number' ? data.total_results : (Array.isArray(data.results) ? data.results.length : 0),
        searchId: req.query.search_id
      }).catch(() => {})
    }
  } catch(e) {
    res.status(502).json({ error: 'Service temporairement indisponible' })
  }
})

// ── Rapprochement OSM à la demande (département de la recherche) ──
// Auto-gated par la gate auth /api/* (req.userId rempli). Reçoit le département
// cherché par le front en fin de recherche. Répond immédiatement, puis lance le
// rapprochement en différé : le setTimeout 30s laisse les upsertReferentiel
// page-par-page (fire-and-forget de /api/search) flusher le socle Etalab en base
// avant l'appariement OSM. rapprocherDepartement borne le chargement OSM à la
// bbox du dept (mémoire) et est no-throw (try/catch interne), .catch de ceinture
// sur l'appel différé.
app.post('/api/amorce', async (req, res) => {
  const dept = String(req.body?.dept || '').trim()
  const naf = String(req.body?.naf || '').trim()
  const geoFin = req.body?.geoFin === true
  // fromCache : la recherche a été servie depuis le cache référentiel (from_cache).
  // Un gisement LU ne doit pas se re-marquer complet (ni rajeunir son marqueur) —
  // on n'écrit le marqueur qu'au terme d'un vrai déroulement Etalab.
  const fromCache = req.body?.fromCache === true
  res.json({ ok: true })
  // Fire-and-forget différé : lancé APRÈS res.json, sans await.
  // Enchaînement CHAÎNÉ (pas parallèle — le crawl mentions légales et le
  // rapprochement OSM partagent le trafic sortant, jamais simultané) :
  //   1. rapprocherDepartement(dept) : moteur OSM, écrit websites + contacts.
  //   2. rapprocherDepartementAtoutFrance(dept) : moteur Atout France, écrit des
  //      websites sur les seules fiches des trois NAF d'hébergement.
  //   3. selectSiretsACrawler(dept, N) : SIRET du dept ayant gagné un website
  //      mais sans contact complet (2e source lit ces websites fraîchement écrits).
  //   4. runMentionsLegalesJob(sirets) : crawl mentions légales, extrait tél/email
  //      en fill-if-empty. Plafond N (env CRAWL_ML_BATCH, défaut 50) borne le crawl.
  //
  // L'ORDRE DES DEUX RAPPROCHEMENTS N'EST PAS INTERCHANGEABLE, deux fois :
  //   · Atout France AVANT selectSiretsACrawler, parce que cette sélection ne
  //     retient que les fiches ayant DÉJÀ un website (referentiel-read.js). Placé
  //     après, il écrirait des sites que le crawl ne lirait qu'à la recherche
  //     SUIVANTE sur le même département.
  //   · Atout France APRÈS l'OSM, parce que les deux écrivent en
  //     remplissage-si-vide — le premier arrivé gagne — et que l'OSM apparie par
  //     identifiant dans l'écrasante majorité de ses cas, là où Atout France
  //     apparie sur l'adresse et le nom. La source la plus sûre passe d'abord.
  setTimeout(() => {
    if (naf && !geoFin && !fromCache && !dept.includes(',')) markGisementComplete(naf, dept)
    rapprocherDepartement(dept)
      .then(async () => {
        // `{ blanc: false }` OBLIGATOIRE et EXPLICITE : le défaut du module est le
        // mode à blanc, et l'omettre ne ferait rien, en silence. Le module ne
        // throw jamais et rend son compte rendu — rien à garder ici.
        const af = await rapprocherDepartementAtoutFrance(dept, { blanc: false })
        console.log(
          `[amorce] dept ${dept} — Atout France : ${af.fiches} fiches · ` +
          `A=${af.a} A2=${af.a2} B=${af.b} · ${af.ecrits} écrits · ${af.duree_ms}ms`
        )
        const N = parseInt(process.env.CRAWL_ML_BATCH || '50', 10)
        const sirets = await selectSiretsACrawler(dept, N)
        if (sirets.length) await runMentionsLegalesJob(sirets)
        console.log(`[amorce] dept ${dept} — rapprochement OK, ${sirets.length} crawlés`)
      })
      .catch(e => console.warn('[amorce]', String(e?.message || e).slice(0, 80)))
  }, 30000)
})

// ── Crawl mentions légales à la demande (lot de SIRET explicite) ──
// Auto-gated par la gate auth /api/* (req.userId rempli). Répond immédiatement,
// puis lance le job en différé : maillons URL→page légale→extraction→recoupement,
// écriture fill-if-empty (website/societe_email/societe_tel) via le référentiel.
// Idempotent (TTL 30 j sur mentions_legales_checked_at) — un SIRET vérifié
// récemment est sauté. Le module a son try/catch global (aucun throw remontant).
app.post('/api/mentions-legales', async (req, res) => {
  const raw = req.body?.sirets
  const sirets = Array.isArray(raw)
    ? raw.map(s => String(s || '').replace(/\s+/g, '')).filter(Boolean)
    : []
  if (sirets.length === 0) return res.status(400).json({ error: 'sirets (array) requis' })
  res.json({ ok: true, recus: sirets.length })
  // Fire-and-forget différé : lancé APRÈS res.json, sans await.
  setTimeout(() => { runMentionsLegalesJob(sirets) }, 1000)
})

// ── Historique des recherches Leads pour l'utilisateur authentifié ──
// Protégé automatiquement par la gate auth /api/* (req.userId déjà rempli).
app.get('/api/user/search-history', async (req, res) => {
  try {
    const result = await getSearchHistory(req.userId, {
      limit: req.query.limit,
      offset: req.query.offset
    })
    res.json(result)
  } catch (err) {
    console.error('[search-history]', err.message)
    res.status(500).json({ error: 'Impossible de lire l\'historique' })
  }
})

// ── État courant utilisateur — utilisé par le popup trial-expired-modal.js ──
// Exempté de la gate subscription (le popup l'appelle à chaque page load,
// même expiré, pour décider d'afficher l'overlay).
app.get('/api/user/me', async (req, res) => {
  try {
    const u = req.authUser
    if (!u) return res.status(401).json({ error: 'unauthorized' })
    res.json({
      id: String(u.id || '').replace(/^user:/, '').replace(/^⟨+|⟩+$/g, ''),
      email: u.email || null,
      prenom: u.prenom || null,
      nom: u.nom || null,
      name: u.name || null,
      telephone: u.telephone || null,
      plan: u.plan || 'gratuit',
      trial_status: u.trial_status || null,
      trial_started_at: u.trial_started_at || null,
      trial_ends_at: u.trial_ends_at || null,
      subscription_status: u.subscription_status || null,
      current_period_end: u.current_period_end || null,
      app_state: deriveAppState(u),
      // Mêmes 6 champs que l'injection window.__USER__ (server.js:~552-562) —
      // doit rester strictement identique : trial-expired-modal lit intended_plan
      // via les deux sources (window au load, /api/user/me au refresh + sur 402).
      intended_plan: u.intended_plan || null,
      siret: u.siret || null,
      raison_sociale: u.raison_sociale || null,
      billing_address: u.billing_address || null,
      stripe_customer_id: u.stripe_customer_id || null,
      plan_billing_cycle: u.plan_billing_cycle || null
    })
  } catch (err) {
    console.error('[user:me]', err.message)
    res.status(500).json({ error: 'Erreur serveur' })
  }
})

// ── Export RGPD article 20 — JSON dump de toutes les données du user ──
// Exempté de la gate subscription (accessible à vie, même après résiliation).
// Rate limit 5 / 24h via la table privacy_export_log.
// ── Profil RGPD art. 14 (Phase 6 Étape 14) — raison_sociale + SIRET ─────
// Persiste l'identité responsable de traitement sur le record user. Utilisée
// par le popup setup SIRET de mail.html avant le 1er cold mail (le footer
// art. 14 en a besoin). Validation SIRET 14 chiffres (+ ASSERT schéma).
app.post('/api/account/profile', async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'unauthorized' })
    const { raison_sociale, siret } = req.body || {}
    if (!raison_sociale || typeof raison_sociale !== 'string' || raison_sociale.trim().length < 2) {
      return res.status(400).json({ error: 'invalid_raison_sociale', message: 'Raison sociale requise (2 caractères minimum).' })
    }
    const siretNorm = siret ? String(siret).replace(/\s/g, '') : null
    if (!siretNorm || !/^\d{14}$/.test(siretNorm)) {
      return res.status(400).json({ error: 'invalid_siret', message: 'Le SIRET doit contenir 14 chiffres.' })
    }
    const db = await getDb()
    const uid = String(req.userId).replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')
    const upd = await db.query(
      "UPDATE type::record('user', $uid) SET raison_sociale = $rs, siret = $sr RETURN AFTER",
      { uid, rs: raison_sociale.trim(), sr: siretNorm }
    )
    const rec = upd?.[0]?.[0] || {}
    return res.status(200).json({ ok: true, raison_sociale: rec.raison_sociale, siret: rec.siret })
  } catch (e) {
    console.error('[account:profile]', e.message)
    return res.status(500).json({ error: 'server_error' })
  }
})

// ── LOGO DU COMPTE, EN TÊTE DES DEVIS ─────────────────────────────────
// Table `account_logo`, une image par abonné, id = userId. Le patron est celui
// de `mail_signature` : voir le bloc SIGNATURE D'ABONNÉ plus bas, dont ces trois
// routes reprennent la doctrine point par point.
//
// UNE TABLE À ELLE, et non une clé de plus dans user_settings : cette table-là
// est écrite par trois pages, dont deux renvoient leur objet ENTIER en PUT. Une
// image de plusieurs centaines de kilooctets y repartirait à chaque
// enregistrement d'un réglage sans rapport, et un onglet resté ouvert sur Frais
// l'effacerait en reposant ses vieilles valeurs. Séparée, elle ne peut plus
// être emportée par une écriture qui ne la vise pas.
//
// UN NOM DE COMPTE, ET HORS DU GABARIT /api/devis/*. Le logo appartient à
// l'abonné et non à une pièce : il coiffe TOUS ses devis, ceux d'hier compris.
// Le loger sous /api/devis/… l'aurait de surcroît exposé à la contrainte
// d'ordre de déclaration de ce gabarit, où /api/devis/:id capte tout ce qui le
// suit. Ici, aucune route ne le précède ni ne le suit qui puisse le capter.
//
// L'IDENTITÉ VIENT DE req.userId, que seul requireAuth pose depuis la session
// vérifiée, et JAMAIS de requireUserId, dont la chaîne de repli lit l'en-tête
// x-user-id, la query et le corps (cf. lib/auth.js, note SEC 1). Ce logo part
// imprimé sur des pièces envoyées à des clients : l'identité doit se lire dans
// la route, sans dépendre de l'ordre d'un middleware à des milliers de lignes
// d'ici. Ne pas revenir à requireUserId ici.
//
// La garde est explicite parce que String(undefined) vaut « undefined », qui
// serait un identifiant d'enregistrement parfaitement valide : une requête
// atteignant ces routes hors du portillon partagerait alors un même logo avec
// toutes les autres. Absente, l'identité vaut 401, sans qu'une seule lecture ni
// écriture ait lieu.
//
// AUCUN PARSEUR PROPRE. Le plafond est de 1 000 Ko d'octets décodés, soit
// environ 1,33 Mo en adresse data: ; le parseur global de 10 Mo les porte, et
// lui en poser un second n'ajouterait qu'un endroit de plus où les deux
// chiffres peuvent diverger.

const LOGO_COMPTE_VIDE = {
  logo_data_url: null,
  logo_width: null,
  logo_height: null,
  updated_at: null
}

// Une dimension de logo est une métadonnée d'affichage, pas une donnée de
// confiance. Hors bornes, non entière ou absente, elle est mise à null : la
// feuille retombe alors sur ses plafonds en millimètres, qui tiennent les
// proportions sans connaître la taille. Rien à refuser ici : il n'y a rien à
// protéger qu'un plafond ne tienne déjà.
function dimensionLogoCompte(valeur, max) {
  const n = Number(valeur)
  if (!Number.isInteger(n) || n <= 0 || n > max) return null
  return n
}

app.get('/api/account/logo', async (req, res) => {
  const userId = req.userId ? String(req.userId) : null
  if (!userId) return res.status(401).json({ error: 'Authentification requise' })
  try {
    const db = await getDb()
    // N'avoir aucun logo est un état normal, pas une erreur : la page reçoit
    // l'objet vide plutôt qu'un 404 à interpréter.
    res.json(logoEnSortie(await chargeLogoCompte(db, userId)) || LOGO_COMPTE_VIDE)
  } catch (err) {
    console.error('[account/logo:get]', err.message)
    res.status(500).json({ error: 'Lecture de votre logo impossible' })
  }
})

app.put('/api/account/logo', async (req, res) => {
  const userId = req.userId ? String(req.userId) : null
  if (!userId) return res.status(401).json({ error: 'Authentification requise' })
  const body = req.body || {}
  if (!body.logo_data_url) {
    return res.status(400).json({ error: 'Aucune image n\'a été fournie.' })
  }
  // Le logo arrive mis au format par la page. Le serveur le relit quand même,
  // sans croire ni le type annoncé ni le poids déclaré : motifLogoCompteRefuse
  // tranche sur les OCTETS DÉCODÉS, et rend le motif tel qu'il sera lu.
  const motif = motifLogoCompteRefuse(body.logo_data_url)
  if (motif) return res.status(400).json({ error: motif })
  try {
    const db = await getDb()
    // Le remplacement intégral d'upsertRecord est ici la bonne opération : ce
    // payload EST le logo entier, et « Remplacer » doit effacer le précédent.
    const payload = {
      userId,
      logo_data_url: String(body.logo_data_url),
      logo_width: dimensionLogoCompte(body.logo_width, LOGO_COMPTE_LARGEUR_MAX),
      logo_height: dimensionLogoCompte(body.logo_height, LOGO_COMPTE_HAUTEUR_MAX),
      updated_at: new Date().toISOString()
    }
    const { record, status } = await upsertRecord(db, 'account_logo', userId, payload)
    res.status(status).json(logoEnSortie(record) || LOGO_COMPTE_VIDE)
  } catch (err) {
    console.error('[account/logo:put]', err.message)
    res.status(500).json({ error: 'Enregistrement de votre logo impossible' })
  }
})

// Retire le logo, et rien d'autre. Une route dédiée plutôt qu'un PUT à vide :
// « je retire mon logo » est un geste, pas une écriture d'image nulle, et le
// PUT ci-dessus refuse justement le corps sans image.
app.delete('/api/account/logo', async (req, res) => {
  const userId = req.userId ? String(req.userId) : null
  if (!userId) return res.status(401).json({ error: 'Authentification requise' })
  try {
    const db = await getDb()
    await db.query('DELETE type::record("account_logo", $id)', { id: userId })
    res.json({ ok: true })
  } catch (err) {
    console.error('[account/logo:delete]', err.message)
    res.status(500).json({ error: 'Suppression de votre logo impossible' })
  }
})

// ── Suppression de compte RGPD art. 17 (Phase 6 Étape 13) ──────────────
// Effacement avec délai d'annulation 7 jours. Exécution effective par le cron
// account_deletion (cascade deleteUserCascade, conservation comptable). POST +
// DELETE whitelistés de la gate subscription (un abonné expiré/résilié doit
// pouvoir demander la suppression). Auth requise (req.userId).
app.post('/api/account/delete', async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'unauthorized' })
    const { confirm } = req.body || {}
    if (confirm !== 'SUPPRIMER') {
      return res.status(400).json({ error: 'invalid_confirm', message: 'Confirmation invalide. Saisissez SUPPRIMER pour confirmer.' })
    }
    const db = await getDb()
    const uid = String(req.userId).replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')
    const sel = await db.query("SELECT subscription_status FROM type::record('user', $uid)", { uid })
    const u = sel?.[0]?.[0]
    if (!u) return res.status(404).json({ error: 'not_found' })
    if (u.subscription_status === 'active') {
      return res.status(409).json({
        error: 'subscription_active',
        message: 'Veuillez résilier votre abonnement depuis /account/billing avant de demander la suppression de votre compte.'
      })
    }
    const upd = await db.query(
      "UPDATE type::record('user', $uid) SET deletion_requested_at = time::now(), deletion_scheduled_at = time::now() + 7d RETURN AFTER",
      { uid }
    )
    const rec = upd?.[0]?.[0] || {}
    const scheduledAt = rec.deletion_scheduled_at ? String(rec.deletion_scheduled_at) : null

    // Email best-effort (doctrine 8b) : un échec d'envoi ne bloque pas la demande.
    try {
      const email = rec.email || req.authUser?.email
      if (email) await sendAccountDeletionScheduled({ to: email, prenom: rec.prenom || req.authUser?.prenom || '', nom: rec.nom || req.authUser?.nom || '', scheduled_at: scheduledAt })
    } catch (err) {
      console.error('[account:delete] sendAccountDeletionScheduled failed:', err.message)
    }
    return res.status(200).json({ ok: true, scheduled_at: scheduledAt, delay_days: 7 })
  } catch (e) {
    console.error('[account:delete:post]', e.message)
    return res.status(500).json({ error: 'server_error' })
  }
})

// Annulation de la demande de suppression avant l'échéance.
app.delete('/api/account/delete', async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'unauthorized' })
    const db = await getDb()
    const uid = String(req.userId).replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')
    const sel = await db.query("SELECT deletion_requested_at FROM type::record('user', $uid)", { uid })
    const u = sel?.[0]?.[0]
    if (!u || !u.deletion_requested_at) {
      return res.status(404).json({ error: 'no_pending_deletion', message: 'Aucune demande de suppression en cours.' })
    }
    await db.query(
      "UPDATE type::record('user', $uid) SET deletion_requested_at = NONE, deletion_scheduled_at = NONE",
      { uid }
    )
    return res.status(200).json({ ok: true, cancelled: true })
  } catch (e) {
    console.error('[account:delete:cancel]', e.message)
    return res.status(500).json({ error: 'server_error' })
  }
})

// État de la demande de suppression (lecture seule).
app.get('/api/account/deletion-status', async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'unauthorized' })
    const db = await getDb()
    const uid = String(req.userId).replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')
    const sel = await queryOrEmpty(db, "SELECT deletion_requested_at, deletion_scheduled_at FROM type::record('user', $uid)", { uid })
    const u = sel[0] || {}
    const requestedAt = u.deletion_requested_at ? String(u.deletion_requested_at) : null
    const scheduledAt = u.deletion_scheduled_at ? String(u.deletion_scheduled_at) : null
    let daysRemaining = null
    if (scheduledAt) {
      const ms = new Date(scheduledAt).getTime() - Date.now()
      daysRemaining = ms > 0 ? Math.ceil(ms / (24 * 60 * 60 * 1000)) : 0
    }
    return res.status(200).json({
      pending: !!requestedAt,
      requested_at: requestedAt,
      scheduled_at: scheduledAt,
      days_remaining: daysRemaining
    })
  } catch (e) {
    console.error('[account:deletion-status]', e.message)
    return res.status(500).json({ error: 'server_error' })
  }
})

app.get('/api/account/privacy/export', async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'unauthorized' })
    const db = await getDb()
    const cleanUserId = String(req.userId).replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')

    // Rate limit 5 exports / 24h
    try {
      const recent = await db.query(
        `SELECT count() AS total FROM privacy_export_log
         WHERE user_id = type::record('user', $uid)
         AND exported_at > time::now() - 24h
         GROUP ALL`,
        { uid: cleanUserId }
      )
      const total = recent?.[0]?.[0]?.total || 0
      if (total >= 5) {
        return res.status(429).json({
          error: 'rate_limit_exceeded',
          message: 'Limite de 5 exports par 24h atteinte. Réessayez plus tard.'
        })
      }
    } catch (e) { /* rate limit best-effort, on ne bloque pas */ }

    // Récupération scopée userId — toutes les tables data du user.
    // Tokens OAuth (mailbox_credentials.accessToken/refreshToken) chiffrés
    // sont retirés du dump pour ne pas exposer même chiffrés.
    async function dump(table) {
      try {
        const r = await db.query(`SELECT * FROM ${table} WHERE userId = $uid`, { uid: cleanUserId })
        return r?.[0] || []
      } catch (e) { return [] }
    }
    async function dumpUserDirect() {
      try {
        const r = await db.query(`SELECT * FROM type::record('user', $id)`, { id: cleanUserId })
        const u = r?.[0]?.[0] || {}
        const { password_hash, ...safe } = u
        return safe
      } catch (e) { return null }
    }
    async function dumpMailboxCreds() {
      try {
        const r = await db.query(
          `SELECT id, ownerId, provider, email, scope, tokenExpiresAt, createdAt, updatedAt
           FROM mailbox_credentials WHERE ownerId = $uid`,
          { uid: cleanUserId }
        )
        return r?.[0] || []
      } catch (e) { return [] }
    }
    // Tables à clé record<user> — lead_search et les deux tables d'usage écrites
    // par le serveur (modifications de contact, tentatives d'enrichissement).
    // Même patron que dump(), seule la forme de la clé change : type::record
    // au lieu d'une chaîne nue. L'abonnée ne les voit nulle part dans
    // l'application ; raison de plus pour qu'elles figurent dans son export.
    async function dumpParUserRecord(table) {
      try {
        const r = await db.query(
          `SELECT * FROM ${table} WHERE user_id = type::record('user', $uid)`,
          { uid: cleanUserId }
        )
        return r?.[0] || []
      } catch (e) { return [] }
    }

    // devis_signature : les devis signés que le client a renvoyés et que
    // l'abonné a déposés. La charge fait jusqu'à 8 Mo par pièce (cf.
    // PIECE_OCTETS_MAX dans lib/piece-signee.js) et l'export l'emporte en
    // entier : sans garde, un abonné qui a numérisé cent devis fabriquerait un
    // JSON de plusieurs centaines de mégaoctets, assemblé en mémoire vive sur
    // une instance d'un gigaoctet PARTAGÉE par tous les abonnés.
    //
    // BUDGET CUMULÉ, et non un plafond par pièce : c'est le total assemblé qui
    // rompt, jamais la pièce prise seule. Le pic vaut le double du budget, la
    // sérialisation JSON doublant les octets déjà chargés ; 50 Mo tiennent donc
    // la centaine de mégaoctets au pire moment. La couverture reste large : les
    // images sont remises au format par la page avant envoi, et un devis signé
    // numérisé pèse le plus souvent quelques centaines de kilooctets.
    //
    // ORDRE DÉTERMINISTE, la pièce la plus ancienne d'abord (first_deposited_at,
    // puis devisId pour départager deux dates égales), et débordement par ARRÊT :
    // les pièces retenues sont toujours les N plus anciennes, jamais un choix qui
    // dépendrait du remplissage. Sans cet ordre, deux exports successifs ne
    // rendraient pas les mêmes pièces et l'abonné ne saurait plus lesquelles il
    // détient.
    //
    // DEUX PASSES : les métadonnées d'abord, qui ne pèsent rien et portent
    // `octets` (le compte des octets DÉCODÉS, dont le base64 se déduit : il
    // gonfle de 4/3) ; le budget se tranche dessus, et seules les pièces retenues
    // voient leur charge rapatriée. Une passe unique aurait chargé toutes les
    // pièces pour en écarter ensuite, c'est-à-dire exactement le pic qu'on évite.
    const EXPORT_PIECES_BUDGET_BASE64 = 50 * 1024 * 1024

    async function dumpDevisSignature() {
      let metas = []
      try {
        const r = await db.query(
          // L'ORDER BY ci-dessous tient parce que first_deposited_at est une
          // chaîne ISO 8601 UTC (new Date().toISOString(), cf. PUT
          // /api/devis/:id/signature), et non un datetime : à largeur fixe et
          // même fuseau, l'ordre lexicographique EST l'ordre chronologique.
          // Changer ce champ de type changerait donc l'ordre de cet export.
          `SELECT devisId, content_type, octets, filename, deposited_at, first_deposited_at
           FROM devis_signature WHERE userId = $uid
           ORDER BY first_deposited_at ASC, devisId ASC`,
          { uid: cleanUserId }
        )
        metas = r?.[0] || []
      } catch (e) { return { pieces: [], omises: 0 } }

      const retenues = []
      let cumul = 0
      for (const m of metas) {
        const base64Estime = Math.ceil((Number(m?.octets) || 0) / 3) * 4
        if (cumul + base64Estime > EXPORT_PIECES_BUDGET_BASE64) break
        cumul += base64Estime
        retenues.push(m)
      }
      const omises = metas.length - retenues.length
      if (!retenues.length) return { pieces: [], omises }

      const dids = retenues.map(m => String(m?.devisId || '')).filter(Boolean)
      const charges = new Map()
      try {
        const r = await db.query(
          `SELECT devisId, contenu_data_url FROM devis_signature
           WHERE userId = $uid AND devisId IN $dids`,
          { uid: cleanUserId, dids }
        )
        for (const row of (r?.[0] || [])) {
          charges.set(String(row?.devisId || ''), row?.contenu_data_url || null)
        }
      } catch (e) { return { pieces: [], omises: metas.length } }

      // L'ordre du SELECT ci-dessus n'est pas garanti par `IN` : la sortie est
      // reconstruite depuis `retenues`, qui porte l'ordre chronologique décidé.
      const pieces = retenues.map(m => ({
        devisId: m?.devisId || null,
        content_type: m?.content_type || null,
        octets: Number(m?.octets) || 0,
        filename: m?.filename || null,
        deposited_at: m?.deposited_at || null,
        first_deposited_at: m?.first_deposited_at || null,
        contenu_data_url: charges.get(String(m?.devisId || '')) || null
      }))
      return { pieces, omises }
    }
    const devisSignes = await dumpDevisSignature()

    // Le champ de tête, rédigé POUR L'ABONNÉ et placé avant tout le reste dans
    // le fichier. Une pièce absente sans explication se lit comme une perte ;
    // dite ainsi, elle est un second geste à faire, depuis le devis concerné.
    //
    // NULL, DONC CHAMP ABSENT, quand l'abonné n'a aucun devis signé : annoncer
    // une pièce jointe à qui n'en a déposé aucune décrirait un fonds qui
    // n'existe pas. Le champ ne paraît que s'il y a une pièce à commenter.
    const devisSignesNote = devisSignes.omises > 0
      ? `${devisSignes.omises} de vos devis signés figurent dans ce fichier sans leur pièce jointe : à elles seules, ces pièces dépassent la taille qu'un export peut porter. Rien n'est perdu. Chacune reste consultable et téléchargeable depuis son devis dans MovUP, par le lien qui ouvre le devis signé. Les pièces présentes ici sont les plus anciennes que vous ayez déposées.`
      : (devisSignes.pieces.length
        ? 'Vos devis signés figurent dans ce fichier avec leur pièce jointe.'
        : null)

    const payload = {
      exported_at: new Date().toISOString(),
      export_version: 1,
      ...(devisSignesNote ? { devis_signes_note: devisSignesNote } : {}),
      user: await dumpUserDirect(),
      contacts: await dump('contacts'),
      // societes — manquait depuis l'origine de la table : les raisons sociales
      // et coordonnées des prospects sortaient par les contacts et les cartes,
      // jamais par la fiche société elle-même.
      societes: await dump('societes'),
      pipeline: await dump('pipeline'),
      agenda: await dump('agenda'),
      devis: await dump('devis'),
      // La pièce signée vit dans sa table à elle (cf. lib/piece-signee.js) : sans
      // cette ligne, l'export rendait le devis sans ce que le client en a signé.
      devis_signature: devisSignes.pieces,
      facture: await dump('facture'),
      frais: await dump('frais'),
      frais_recurrents: await dump('frais_recurrents'),
      user_settings: await dump('user_settings'),
      // account_logo : le logo que l'abonné imprime en tête de ses devis. Table
      // à part de user_settings, donc ligne à part ici : c'est une donnée
      // personnelle comme les autres, et la séparation qui la protège d'une
      // écriture de réglages ne doit pas la faire manquer à son export. Aucun
      // mécanisme de budget ne lui est nécessaire : un enregistrement par
      // compte, plafonné à 1 000 Ko (LOGO_OCTETS_MAX dans lib/logo-compte.js).
      account_logo: await dump('account_logo'),
      // mail_signature : table à part de mail_settings, et manquante ici depuis
      // l'origine : le logo et le texte de signature sont des données
      // personnelles comme les autres. Aucun mécanisme de budget ne lui est
      // nécessaire, son logo étant plafonné à 300 Ko par abonné (LOGO_OCTETS_MAX
      // dans lib/mail-signature.js) et l'enregistrement unique par compte.
      mail_signature: await dump('mail_signature'),
      mailbox_credentials: await dumpMailboxCreds(),
      search_history: await dumpParUserRecord('lead_search'),
      contact_edits: await dumpParUserRecord('lead_contact_edit'),
      enrichment_attempts: await dumpParUserRecord('lead_enrichment'),
      // Note : exclus volontairement — leads INSEE (données publiques),
      // mailbox tokens en clair, password_hash, sessions, verification_token.
    }

    const json = JSON.stringify(payload, null, 2)
    const dateSlug = new Date().toISOString().slice(0, 10)
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="movup-export-${cleanUserId}-${dateSlug}.json"`)

    // Log l'export pour le rate limit + traçabilité (best-effort, pas bloquant).
    db.query(
      `CREATE privacy_export_log SET
        user_id = type::record('user', $uid),
        exported_at = time::now(),
        bytes_size = $size`,
      { uid: cleanUserId, size: Buffer.byteLength(json, 'utf8') }
    ).catch(e => console.warn('[privacy:export] log échec :', e.message))

    res.send(json)
  } catch (err) {
    console.error('[privacy:export]', err.message)
    res.status(500).json({ error: 'Export impossible' })
  }
})

// ── INSEE SIRENE search (must be before :siret route) ──
app.get('/api/sirene/search', async (req, res) => {
  const token = await getInseeToken()
  console.log('[INSEE] token:', token ? 'OK' : 'NULL')
  if(!token) {
    console.error('[INSEE] No token — CLIENT_ID:', process.env.INSEE_CLIENT_ID ? 'present' : 'MISSING', 'SECRET:', process.env.INSEE_CLIENT_SECRET ? 'present' : 'MISSING')
    return res.status(503).json({ error: 'INSEE auth indisponible' })
  }
  let q = req.query.q || ''
  // Convert NAF codes without dots: 8230Z → 82.30Z in the query
  q = q.replace(/activitePrincipaleEtablissement:(\d{2})(\d{2}[A-Z])/g, 'activitePrincipaleEtablissement:$1.$2')
  const nombre = Math.min(parseInt(req.query.nombre) || 20, 1000)
  const debut = parseInt(req.query.debut) || 0
  const inseeUrl = 'https://api.insee.fr/api-sirene/3.11/siret?q=' + encodeURIComponent(q) + '&nombre=' + nombre + '&debut=' + debut
  try {
    console.log('[INSEE] Calling:', inseeUrl.substring(0, 200))
    const hdrs = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }
    if(process.env.INSEE_API_KEY) hdrs['X-Gravitee-Api-Key'] = process.env.INSEE_API_KEY
    const r = await fetch(inseeUrl, { headers: hdrs })
    console.log('[INSEE] Response:', r.status, r.headers.get('content-type'))
    if(!r.ok) { const body = await r.text(); console.error('[INSEE] Search error:', r.status, body.substring(0,300)); return res.status(502).json({ error: 'Recherche INSEE échouée', upstream_status: r.status }) }
    const data = await r.json()
    console.log('[INSEE] Success: total=', data.header?.total, 'etablissements=', data.etablissements?.length)
    // ── Filtre diffusion INSEE (droit d'opposition) — AVANT le Rempart 1 opt-out.
    if (Array.isArray(data.etablissements) && data.etablissements.length) {
      const before = data.etablissements.length
      data.etablissements = data.etablissements.filter(e => isFullyDiffusible(e, 'insee'))
      if (data.etablissements.length !== before) console.log(`[diffusion] /api/sirene/search: ${before - data.etablissements.length} fiche(s) exclue(s)`)
    }
    // ── Rempart 1 opt-out (RGPD art. 12) — filtrage silencieux upstream.
    // INSEE SIRENE porte le SIRET en top-level (etab.siret). Batch IN
    // (≤100 SIRET, nombre déjà borné l.1235) puis retrait des fiches
    // blocklistées. Anti-revelation : aucun message « X masquées ».
    if (Array.isArray(data.etablissements) && data.etablissements.length) {
      const blocked = await checkBlocklistBatch(data.etablissements.map(e => e?.siret).filter(Boolean))
      if (blocked.size) {
        data.etablissements = data.etablissements.filter(e => !(e?.siret && blocked.has(e.siret)))
      }
    }
    res.json(data)
  } catch(e) {
    console.error('[INSEE] Fetch crash:', e.message)
    res.status(502).json({ error: 'INSEE indisponible' })
  }
})

// ── INSEE SIRENE enrichment by SIRET ──
app.get('/api/sirene/:siret', async (req, res) => {
  // Rempart opt-out RGPD AVANT le fetch INSEE : inutile d'interroger l'API pour
  // une fiche qu'on ne servira pas. 404 indiscernable de la garde diffusion.
  const siret = String(req.params.siret || '').replace(/\s+/g, '')
  if (await checkBlocklistOne(siret)) {
    console.log(`[optout] sirene refusé ${siret}`)
    return res.status(404).json({ error: 'not_found' })
  }
  const token = await getInseeToken()
  if(!token) return res.status(503).json({ error: 'INSEE auth indisponible' })
  try {
    const hdrs2 = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }
    if(process.env.INSEE_API_KEY) hdrs2['X-Gravitee-Api-Key'] = process.env.INSEE_API_KEY
    const r = await fetch('https://api.insee.fr/api-sirene/3.11/siret/' + encodeURIComponent(req.params.siret), { headers: hdrs2 })
    if(!r.ok) return res.status(502).json({ error: 'Lookup INSEE échoué', upstream_status: r.status })
    const data = await r.json()
    // Filtre diffusion INSEE (droit d'opposition) — singleton. Anti-revelation :
    // 404 not_found (ne jamais révéler le statut d'opposition au client).
    if (data && data.etablissement && !isFullyDiffusible(data.etablissement, 'insee')) {
      return res.status(404).json({ error: 'not_found' })
    }
    res.json(data)
  } catch(e) {
    res.status(502).json({ error: 'INSEE indisponible' })
  }
})

// GET /api/enrich/:siret — LECTURE SEULE de la fiche contact société.
//   • route de LECTURE seule : ne décompte JAMAIS, n'écrit JAMAIS, n'appelle
//     AUCUN tiers (pas de DataForSEO, pas de markEnriched, pas de consumeLead).
//   • elle sert l'affichage à l'ouverture d'une fiche ; le POST reste le seul
//     geste PAYANT, celui qui va chercher ce que le référentiel ne connaît pas
//     encore (maillon DataForSEO / Google My Business).
//   • le gate quota est volontairement absent : lire ce que le référentiel sait
//     DÉJÀ ne consomme rien — d'où l'absence de getLeadsConsumed / getLeadLimit.
// Forme de réponse strictement identique au POST (found + 6 champs), mais SANS
// le maillon DataForSEO : ce GET ne rend que ce que le référentiel sait déjà, il
// peut donc rendre MOINS que le POST sur une fiche que GMB aurait complétée.
app.get('/api/enrich/:siret', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  const siret = String(req.params.siret || '').replace(/\s+/g, '')
  if (!siret) return res.status(400).json({ error: 'SIRET manquant' })

  try {
    const user = req.authUser
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    // Rempart opt-out RGPD — MÊME code et MÊME corps de réponse que le POST : le
    // client n'a qu'un seul cas 403 à traiter, GET comme POST.
    if (await checkBlocklistOne(siret)) {
      console.log(`[optout] enrich(get) refusé ${siret}`)
      return res.status(403).json({
        error: 'opt_out',
        message: "Cette entreprise n'est pas disponible pour prospection."
      })
    }

    const [soc, osm] = await Promise.all([
      getReferentielContactBySiret(siret),
      getOsmContactBySiret(siret)
    ])
    const s = soc || {}
    const o = osm || {}
    // Société prioritaire, OSM en fill-if-empty. Fusion champ par champ, à
    // l'identique du POST : valeur société si non vide, sinon valeur OSM.
    const pick = (a, b) => (String(a || '').trim() || String(b || '').trim())
    const merged = {
      website: pick(s.website, o.website),
      societe_email: pick(s.societe_email, o.societe_email),
      societe_tel: pick(s.societe_tel, o.societe_tel),
      societe_facebook: pick(s.societe_facebook, o.societe_facebook),
      societe_instagram: pick(s.societe_instagram, o.societe_instagram),
      societe_linkedin: pick(s.societe_linkedin, o.societe_linkedin)
    }

    // Second filtre opt-out — par ADRESSE. La fiche révèle un societe_email qui
    // peut être opposé même sans siret_hash/siren_hash : opposition déposée
    // depuis un fournisseur grand public, qu'aucune résolution domaine (commit 3)
    // ne relie à une entreprise. merged.societe_email est déjà sous la main
    // (aucune requête en plus). Réponse STRICTEMENT identique au blocage par
    // SIRET — l'abonné ignore par quelle clé la fiche est opposée.
    // LIMITE ASSUMÉE : ce contrôle ne couvre que l'adresse. Un téléphone révélé
    // sur une fiche dont seule l'adresse est opposée passerait encore, sauf si
    // le SIREN a pu être résolu au commit 3 — résidu connu, traité par la
    // reprise manuelle sous un mois annoncée dans l'accusé de réception.
    if (merged.societe_email && await checkBlocklistEmailOne(merged.societe_email)) {
      console.log(`[optout] enrich(get) refusé ${siret}`)
      return res.status(403).json({
        error: 'opt_out',
        message: "Cette entreprise n'est pas disponible pour prospection."
      })
    }

    const found = Object.values(merged).some(v => v)
    res.json({ found, ...merged })
  } catch (err) {
    console.error('[enrich:get]', err.message)
    if (!res.headersSent) res.status(500).json({ error: 'Enrichissement indisponible' })
  }
})

// Budget d'attente accordé au crawl mentions légales DANS la route d'enrichissement,
// compté depuis l'entrée en route. Au-delà, la route rend la main sans l'attendre.
const ENRICH_ML_BUDGET_MS = 15000

// Hôte d'un website de référentiel. Le schéma est parfois absent en base ; on le
// complète pour parser, sans jamais réécrire la valeur. Rend '' si illisible —
// et hostBlacklisted('') vaut true, donc l'illisible n'est jamais crawlé.
function hostDeSite(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  try { return new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s).host } catch { return '' }
}

// POST /api/enrich/:siret — restitution des champs contact société depuis DEUX
// sources : referentiel_societes (amorçage Overpass, PRIORITAIRE) et referentiel_osm
// (réserve nationale OSM, fill-if-empty). Fusion champ par champ : valeur société si
// non vide, sinon valeur OSM.
//
// GATE QUOTA en tête de route : un utilisateur au plafond n'obtient plus de
// restitution. L'idempotence SIRET passe AVANT le gate — un SIRET déjà enrichi
// par ce user a déjà été payé, il reste consultable même au plafond.
app.post('/api/enrich/:siret', async (req, res) => {
  // Repère de temps de la route : le budget du maillon mentions légales se compte
  // DEPUIS L'ENTRÉE, pas depuis son propre départ. Ce qu'on borne, c'est l'attente
  // de l'abonné — les lectures qui précèdent en font partie.
  const tRoute = Date.now()
  const userId = requireUserId(req, res)
  if (!userId) return
  const siret = String(req.params.siret || '').replace(/\s+/g, '')
  if (!siret) return res.status(400).json({ error: 'SIRET manquant' })

  try {
    const user = req.authUser
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    // Rempart opt-out RGPD en tête : bloque d'un coup l'écriture DataForSEO, le décompte consumeLead et la restitution.
    if (await checkBlocklistOne(siret)) {
      console.log(`[optout] enrich refusé ${siret}`)
      trackEnrichAttempt({ userId, siret, issue: 'refus_opposition' }).catch(() => {})
      return res.status(403).json({
        error: 'opt_out',
        message: "Cette entreprise n'est pas disponible pour prospection."
      })
    }
    const db = await getDb()
    // SELECT unique : le record sert au test d'idempotence (hasEnriched, PURE) et,
    // s'il faut gater, à la lecture du compteur (getLeadsConsumed, qui applique le
    // reset lazy si le plan est payant). Repli sur un record neutre si absent.
    const recRes = await db.query('SELECT * FROM type::record("user_plan", $id)', { id: userId })
    const rec = recRes[0]?.[0] || { userId, leadsConsumedThisMonth: 0, lastResetDate: null }
    if (!hasEnriched(rec, siret)) {
      const consumed = await getLeadsConsumed(db, userId, rec, user)
      // getLeadLimit est la SEULE porte VIP (Infinity). Jamais PLAN_LEAD_LIMITS en direct.
      const limit = getLeadLimit(user)
      if (consumed >= limit) {
        // error === 'quota_exceeded' impérativement : trial_expired / grace_expired /
        // grace_active déclencheraient la modale du wrapper (subscription.js:86,
        // trial-expired-modal.js:305), qui n'a rien à voir avec un plafond de leads.
        trackEnrichAttempt({ userId, siret, issue: 'refus_quota' }).catch(() => {})
        return res.status(402).json({
          error: 'quota_exceeded',
          plan: getEffectivePlan(user),
          quotaUsed: consumed,
          quotaLimit: limit === Infinity ? null : limit,
          quotaPeriod: getEffectivePlan(user) === 'essai' ? 'essai' : 'monthly',
          upgradeUrl: '/account/billing'
        })
      }
    }

    const [soc, osm] = await Promise.all([
      getReferentielContactBySiret(siret),
      getOsmContactBySiret(siret)
    ])
    const s = soc || {}
    const o = osm || {}
    // Société prioritaire, OSM en fill-if-empty. Société ne porte que website /
    // societe_email / societe_tel ; facebook / instagram / linkedin viennent d'OSM.
    const pick = (a, b) => (String(a || '').trim() || String(b || '').trim())
    const merged = {
      website: pick(s.website, o.website),
      societe_email: pick(s.societe_email, o.societe_email),
      societe_tel: pick(s.societe_tel, o.societe_tel),
      societe_facebook: pick(s.societe_facebook, o.societe_facebook),
      societe_instagram: pick(s.societe_instagram, o.societe_instagram),
      societe_linkedin: pick(s.societe_linkedin, o.societe_linkedin)
    }

    // Second filtre opt-out — par ADRESSE (cf. GET). Placé APRÈS la lecture du
    // référentiel (merged.societe_email sous la main, aucune requête en plus) et
    // AVANT tout appel payant DataForSEO / toute écriture / tout décompte quota :
    // un contrôle placé plus tard ferait payer un enrichissement qu'on refuse
    // ensuite. Capte l'opposition déposée depuis un fournisseur grand public
    // (ni siret_hash ni siren_hash, hors résolution domaine du commit 3). Réponse
    // STRICTEMENT identique au blocage par SIRET — même code, même motif, même
    // journalisation.
    // LIMITE ASSUMÉE : ce contrôle ne couvre que l'adresse. Un téléphone révélé
    // sur une fiche dont seule l'adresse est opposée passerait encore, sauf si le
    // SIREN a pu être résolu au commit 3 — résidu connu, traité par la reprise
    // manuelle sous un mois annoncée dans l'accusé de réception.
    if (merged.societe_email && await checkBlocklistEmailOne(merged.societe_email)) {
      console.log(`[optout] enrich refusé ${siret}`)
      trackEnrichAttempt({ userId, siret, issue: 'refus_opposition' }).catch(() => {})
      return res.status(403).json({
        error: 'opt_out',
        message: "Cette entreprise n'est pas disponible pour prospection."
      })
    }

    // ── Maillon Mentions légales (crawl du site DÉJÀ connu) ─────────────────
    // AVANT DataForSEO, et pour cause : le site de l'entreprise est déjà en base,
    // il porte souvent le courriel et le téléphone en clair sur sa page de
    // mentions légales ou de contact, et il ne coûte rien. Appeler le fournisseur
    // payant à sa place, c'est payer pour moins : DataForSEO ne rend JAMAIS de
    // courriel. Le crawl, lui, en rend — sous corroboration (SIRET/SIREN de la
    // page, ou deux signaux parmi raison sociale / adresse / dirigeant).
    //
    // Conditions cumulatives, aucune requête supplémentaire pour les évaluer :
    //   • un website en base (sinon rien à lire — le maillon 1.b reste hors jeu) ;
    //   • au moins un des trois canaux manquant (mêmes trois que `complet` plus
    //     bas : trois pleins → rien à chercher) ;
    //   • hôte hors liste noire : sur planity/carrefour/orpi… la page porte le
    //     SIRET du réseau, elle ne peut rien corroborer.
    const siteHote = hostDeSite(merged.website)
    const manqueCanal = !(merged.website && merged.societe_tel && merged.societe_email)
    // Courriel tel que le rempart par adresse (ci-dessus) l'a vu. Sert de témoin :
    // si le crawl en fait apparaître un AUTRE, celui-là n'a jamais été opposé au
    // rempart, et doit l'être. Cf. le second passage juste après ce bloc.
    const emailAvantMl = merged.societe_email
    if (merged.website && manqueCanal && !hostBlacklisted(siteHote)) {
      try {
        // Budget de 15 s MESURÉ DEPUIS L'ENTRÉE EN ROUTE. Au dépassement, la main
        // passe à la suite : le crawl N'EST PAS annulé, il continue en fond
        // derrière la file mono-verrou et son écriture (fill-if-empty, référentiel
        // mutualisé) profitera au clic suivant. Ce clic suivant est idempotent —
        // markEnriched a déjà marqué ce SIRET pour ce user, added:false, aucun
        // second décompte. Perdre la course coûte donc une attente, jamais un lead.
        const restant = ENRICH_ML_BUDGET_MS - (Date.now() - tRoute)
        if (restant > 0) {
          // Le moteur ne throw pas (try/catch global) ; le .catch est structurel,
          // pour qu'aucune promesse perdante ne puisse rejeter sans gestionnaire.
          const crawl = enrichirMentionsLegales(siret, { forcerTtl: true, sansRechercheWeb: true })
            .catch(e => { console.warn('[enrich:ml]', String(e?.message || e).slice(0, 80)) })
          let minuteur
          const bornage = new Promise(r => { minuteur = setTimeout(r, restant) })
          try { await Promise.race([crawl, bornage]) } finally { clearTimeout(minuteur) }
        }
        // Le moteur écrit en base et NE REND PAS les valeurs : on relit, on refait
        // le pick (société prioritaire, OSM en fill-if-empty), et `complet` juste
        // en dessous s'en trouve recalculé — c'est lui qui décide si DataForSEO
        // part. Relecture faite même en cas de dépassement : le crawl a pu écrire
        // entre la fin du budget et cette ligne.
        const soc3 = await getReferentielContactBySiret(siret)
        if (soc3) {
          merged.website = pick(soc3.website, merged.website)
          merged.societe_email = pick(soc3.societe_email, merged.societe_email)
          merged.societe_tel = pick(soc3.societe_tel, merged.societe_tel)
        }
      } catch (e) {
        // Fail-safe intégral : tout pépin retombe sur le merged existant.
        console.warn('[enrich:ml]', String(e?.message || e).slice(0, 80))
      }
    }

    // Troisième passage du rempart opt-out — par ADRESSE, sur le courriel ISSU DU
    // CRAWL. Le rempart par adresse est évalué plus haut, avant le moteur ; en
    // juillet, un second passage après enrichissement avait été jugé inutile au
    // motif que DataForSEO ne rend jamais de courriel — vrai pour lui, faux
    // désormais : le moteur mentions légales, lui, en écrit. Un courriel opposé
    // depuis un fournisseur grand public (ni siret_hash ni siren_hash) sortirait
    // sans avoir jamais rencontré le rempart. Il le rencontre ici : APRÈS la
    // relecture, AVANT toute restitution et AVANT consumeLead — un contrôle placé
    // plus tard décompterait un lead qu'on refuse ensuite.
    // Testé SEULEMENT si le crawl a fait apparaître un courriel différent de celui
    // déjà passé au rempart : sinon la réponse est connue, et la requête inutile.
    // Réponse STRICTEMENT identique aux deux autres blocages — même code, même
    // motif, même journalisation : l'abonné ignore par quelle clé la fiche est
    // opposée. checkBlocklistEmailOne est fail-closed, inchangée.
    if (merged.societe_email && merged.societe_email !== emailAvantMl &&
        await checkBlocklistEmailOne(merged.societe_email)) {
      console.log(`[optout] enrich refusé ${siret}`)
      trackEnrichAttempt({ userId, siret, issue: 'refus_opposition' }).catch(() => {})
      return res.status(403).json({
        error: 'opt_out',
        message: "Cette entreprise n'est pas disponible pour prospection."
      })
    }

    // ── Maillon DataForSEO (Business Info / Google My Business) ──────────────
    // Complète la fiche société SI un canal contact manque, avec écriture SOUS
    // corroboration adresse STRICTE. Fail-safe intégral : toute erreur retombe
    // sur le merge existant (le res.json normal reste servi).
    //   • Appel SEULEMENT si incomplet : au moins un de website / societe_tel /
    //     societe_email vide. Trois pleins → pas d'appel.
    //   • Écriture SEULEMENT si corroboration OK : CP (Etalab présent dans
    //     l'address DataForSEO) ET rue+numéro (parserAdresseAgregee des deux).
    //   • fill-if-empty via enrichReferentielActionnable : website (=url) +
    //     societe_tel (=phone) si non vides. Pas d'email (GMB n'en rend pas).
    // NOTE : le faisceau (getReferentielFaisceauBySiret, referentiel-read.js:290-294)
    //   PORTE l'enseigne → keyword bâti sur l'enseigne en priorité (nom commercial
    //   recherchable, ex. fiches EI), repli sur raison_sociale si enseigne vide.
    const complet = merged.website && merged.societe_tel && merged.societe_email
    if (!complet) {
      try {
        const faisceau = await getReferentielFaisceauBySiret(siret)
        const ville = String(faisceau?.ville || '').trim()
        const enseigne = String(faisceau?.enseigne || '').trim()
        const raison = String(faisceau?.raison_sociale || '').trim()
        const nom = enseigne || raison
        const keyword = `${nom} ${ville}`.trim()
        if (faisceau && keyword) {
          const info = await lookupBusinessInfo({ keyword })
          // Corroboration adresse : address DataForSEO vs faisceau.adresse (agrégée).
          if (info.found && info.address && faisceau.adresse) {
            const cp = String(faisceau.code_postal || '').trim()
            const refA = parserAdresseAgregee(faisceau.adresse)
            const dfsA = parserAdresseAgregee(info.address)
            const cpOk = cp && info.address.includes(cp)
            const voieOk = voiesConcordent(refA.voie, dfsA.voie)
            const numOk = comparerNumero(refA.numero, dfsA.numero)
            if (cpOk && voieOk && numOk) {
              const patch = {}
              if (!merged.website && info.url) patch.website = info.url
              if (!merged.societe_tel && info.phone) patch.societe_tel = info.phone
              // Re-lecture ciblée UNIQUEMENT si une écriture est tentée.
              if (Object.keys(patch).length) {
                await enrichReferentielActionnable(siret, patch)
                const soc2 = await getReferentielContactBySiret(siret)
                if (soc2) {
                  merged.website = pick(soc2.website, merged.website)
                  merged.societe_tel = pick(soc2.societe_tel, merged.societe_tel)
                }
              }
            }
          }
        }
      } catch (e) {
        // Le maillon ne casse jamais la route : on retombe sur le merge existant.
        console.warn('[enrich:dataforseo]', String(e?.message || e).slice(0, 80))
      }
    }

    const found = Object.values(merged).some(v => v)
    // Décompte : SEULEMENT si on a livré un canal décomptable (email/tél) ET que
    // ce SIRET n'était pas déjà marqué pour ce user. markEnriched est appelé
    // APRÈS found && porteCanalDecomptable — jamais avant : marquer un SIRET sans
    // coordonnée le rendrait « payé » et le ferait skipper le gate à vie. added
    // (RETURN BEFORE) garantit un incrément unique : un second onglet sur le même
    // SIRET lit un BEFORE qui contient déjà le SIRET → added:false → pas de double
    // décompte. Dette connue assumée : course multi-onglet sur SIRET DIFFÉRENTS à
    // limit-1 → léger dépassement borné, hors périmètre.
    if (found && porteCanalDecomptable(merged)) {
      const { added } = await markEnriched(db, userId, siret)
      if (added) await consumeLead(db, userId)
    }
    res.json({ found, ...merged })
    // Trace d'usage — UNE LIGNE PAR TENTATIVE, posée à CHACUNE des sorties de la
    // route, celle-ci comme les trois refus plus haut. `found` sépare les deux
    // issues de la sortie nominale : quelque chose a été livré, ou la recherche
    // n'a rien rendu. Après res.json, fire-and-forget : le rattachement à la
    // recherche d'origine (relecture de la société par SIRET) se paie hors de
    // l'attente de l'abonnée.
    trackEnrichAttempt({ userId, siret, issue: found ? 'livre' : 'sans_resultat' }).catch(() => {})
  } catch (err) {
    console.error('[enrich]', err.message)
    if (!res.headersSent) res.status(500).json({ error: 'Enrichissement indisponible' })
  }
})

app.get('/api/geocode', async (req, res) => {
  const q = req.query.q || ''
  const type = req.query.type || ''
  try {
    // Try with type filter first (municipality for cities)
    let url = 'https://api-adresse.data.gouv.fr/search/?q=' + encodeURIComponent(q) + '&limit=1'
    if(type) url += '&type=' + type
    let r = await fetch(url)
    let data = await r.json()
    // If no result with type filter, retry without
    if(type && (!data.features || !data.features.length)) {
      r = await fetch('https://api-adresse.data.gouv.fr/search/?q=' + encodeURIComponent(q) + '&limit=1')
      data = await r.json()
    }
    res.json(data)
  } catch(e) {
    res.status(502).json({ error: 'Géocodage indisponible' })
  }
})

// ── Opt-out RGPD art. 21 (Phase 6 Étape 8) ──────────────────────────────
// POST /api/optout : enregistre une demande d'opposition + envoie un magic
// link de vérification. Rate-limit 3/24h/IP. Réponse anti-énumération
// (identique quel que soit l'état réel). Honeypot + question logique +
// consentement = anti-bot. Aucune donnée du tiers renvoyée.
app.post('/api/optout', optoutLimiter, async (req, res) => {
  try {
    const { email, siret, website, confirm_word, consent } = req.body || {}

    // 1. Honeypot — si rempli, 200 silencieux (ne pas révéler le piège).
    if (website && String(website).trim() !== '') {
      return res.status(200).json({ ok: true, redirect: '/optout-confirmation' })
    }
    // 2. Question logique anti-bot.
    if (confirm_word !== 'OPTOUT') {
      return res.status(400).json({ error: 'invalid_confirm', detail: 'Le mot de confirmation est incorrect.' })
    }
    // 3. Consentement obligatoire.
    if (!consent) {
      return res.status(400).json({ error: 'missing_consent', detail: 'Vous devez confirmer être habilité à formuler la demande.' })
    }
    // 4. Email.
    const emailNorm = String(email || '').toLowerCase().trim()
    if (!emailNorm || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
      return res.status(400).json({ error: 'invalid_email', detail: 'Adresse email invalide.' })
    }
    // 5. SIRET optionnel (14 chiffres).
    const siretNorm = siret ? String(siret).replace(/\s/g, '') : null
    if (siretNorm && !/^\d{14}$/.test(siretNorm)) {
      return res.status(400).json({ error: 'invalid_siret', detail: 'Le SIRET doit contenir 14 chiffres.' })
    }

    // 6. Idempotence UX (arbitrage 8b) : on détecte une demande pending < 1h
    //    pour le même couple, mais on crée tout de même une nouvelle demande
    //    (impossible de renvoyer l'ancien lien — seul le hash est stocké ; un
    //    tiers ayant perdu le 1er email doit pouvoir réessayer). Flood borné
    //    par le rate-limit 3/24h/IP. Réponse identique = aucune énumération.
    const emailHash = hashIdentifier(emailNorm)
    const siretHash = siretNorm ? hashIdentifier(siretNorm) : null
    const existing = await findPendingRequest(emailHash, siretHash)
    if (existing) console.log('[optout] demande pending <1h déjà présente — nouvelle demande créée (idempotence UX)')

    const { token, shortRef } = await insertOptoutRequest({
      email: emailNorm,
      siret: siretNorm,
      ip: req.ip,
      userAgent: req.headers['user-agent'] || null
    })

    // 7. Envoi email best-effort (le sender lève ; on swallow ici).
    let emailOk = true
    try {
      await sendOptoutVerify({ to: emailNorm, token, shortRef })
    } catch (e) {
      emailOk = false
      console.error('[optout:send-email]', e.message)
    }

    // 8. Réponse anti-énumération identique : 200 si email parti, 202 Accepted
    //    si échec Resend (demande enregistrée, jamais d'erreur technique
    //    exposée au tiers).
    return res.status(emailOk ? 200 : 202).json({ ok: true, redirect: '/optout-confirmation' })
  } catch (e) {
    console.error('[optout:post]', e.message)
    return res.status(500).json({ error: 'server_error', detail: 'Une erreur est survenue. Veuillez réessayer.' })
  }
})

// GET /api/optout/verify/:token : consomme le token, inscrit en blocklist,
// sert la page verified avec substitution server-side des placeholders (pas
// de template engine — pattern read+inject). Re-clic post-vérif = succès
// idempotent. Token invalide/expiré = redirect /optout?error=invalid_or_expired.
app.get('/api/optout/verify/:token', async (req, res) => {
  try {
    const { token } = req.params
    if (!token || token.length < 20) {
      return res.redirect(302, '/optout?error=invalid_or_expired')
    }
    const result = await verifyOptoutToken(token)
    if (!result.ok) {
      return res.redirect(302, '/optout?error=' + encodeURIComponent(result.reason || 'invalid_or_expired'))
    }
    const filePath = join(__dirname, 'public', 'optout-verified.html')
    let html = await readFile(filePath, 'utf8')
    const deadline = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      .toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })

    // Phase 6 Étape 9 — sur PREMIÈRE vérification uniquement (pas de re-clic) :
    // accusé de réception au tiers (art. 12.3 RGPD) + notification interne
    // bonjour@movup.io. try/catch séparés best-effort : l'échec d'un envoi
    // n'empêche ni l'autre ni le redirect /optout-verified (doctrine 8b).
    if (result.ok && !result.alreadyVerified) {
      try {
        await sendOptoutAcknowledged({
          to: result.email,
          shortRef: result.requestId,
          verifiedAt: result.verifiedAt,
          processingDeadline: deadline
        })
      } catch (err) {
        console.error('[optout] sendOptoutAcknowledged failed:', err.message)
      }
      try {
        await sendOptoutInternalNotification({
          shortRef: result.requestId,
          verifiedAt: result.verifiedAt,
          processingDeadline: deadline
        })
      } catch (err) {
        console.error('[optout] sendOptoutInternalNotification failed:', err.message)
      }
    }

    html = html
      .replace(/\{\{REQUEST_ID\}\}/g, String(result.requestId || '').replace(/[<>"'&]/g, ''))
      .replace(/\{\{PROCESSING_DEADLINE\}\}/g, deadline)
    res.set('Content-Type', 'text/html; charset=utf-8')
    return res.status(200).send(html)
  } catch (e) {
    console.error('[optout:verify]', e.message)
    return res.redirect(302, '/optout?error=server_error')
  }
})

// ── MAIL ──────────────────────────────────────────────────────────────
// V1: mono-utilisateur via MUP_DEFAULT_USER_ID. Multi-tenant à brancher
// quand l'auth arrive. Aucun quota MUP — limite déléguée au SMTP utilisateur.

app.get('/api/mail/settings/:userId', async (req, res) => {
  if (!requireCrypto(res)) return
  try {
    const userId = String(req.userId)
    if (String(req.params.userId) !== userId) return res.status(403).json({ error: 'forbidden' })
    const db = await getDb()
    const rec = (await queryOrEmpty(db, 'SELECT * FROM type::record("mail_settings", $id)', { id: userId }))[0]
    if (!rec) return res.status(404).json({ error: 'Configuration mail introuvable' })
    res.json(stripSettingsSecrets(rec))
  } catch (err) {
    console.error('[mail/settings:get]', err.message)
    res.status(500).json({ error: 'Lecture configuration mail impossible' })
  }
})

app.post('/api/mail/settings', async (req, res) => {
  if (!requireCrypto(res)) return
  try {
    const body = req.body || {}
    const userId = String(req.userId)
    const db = await getDb()
    const payload = {
      userId,
      smtp_host: body.smtp_host || '',
      smtp_port: Number(body.smtp_port) || 587,
      smtp_secure: body.smtp_secure ?? (Number(body.smtp_port) === 465),
      smtp_user: body.smtp_user || body.from_email || '',
      imap_host: body.imap_host || deriveImapFromSmtp(body.smtp_host) || '',
      imap_port: Number(body.imap_port) || 993,
      imap_secure: body.imap_secure ?? true,
      imap_user: body.imap_user || body.smtp_user || body.from_email || '',
      from_name: body.from_name || '',
      from_email: body.from_email || '',
      signature_html: body.signature_html || '',
      signature_text: body.signature_text || '',
      onboarded_at: new Date().toISOString()
    }
    if (body.smtp_pass) payload.smtp_pass_encrypted = encrypt(String(body.smtp_pass))
    if (body.imap_pass) {
      payload.imap_pass_encrypted = encrypt(String(body.imap_pass))
    } else if (body.smtp_pass) {
      payload.imap_pass_encrypted = encrypt(String(body.smtp_pass))
    }
    const { record, status } = await upsertRecord(db, 'mail_settings', userId, payload)
    res.status(status).json(stripSettingsSecrets(record))
  } catch (err) {
    console.error('[mail/settings:post]', err.message)
    res.status(500).json({ error: 'Enregistrement configuration mail impossible' })
  }
})

app.delete('/api/mail/settings/:userId', async (req, res) => {
  if (!requireCrypto(res)) return
  try {
    const userId = String(req.userId)
    if (String(req.params.userId) !== userId) return res.status(403).json({ error: 'forbidden' })
    const db = await getDb()
    await db.query('DELETE type::record("mail_settings", $id)', { id: userId })
    res.json({ ok: true })
  } catch (err) {
    console.error('[mail/settings:delete]', err.message)
    res.status(500).json({ error: 'Suppression configuration mail impossible' })
  }
})

// ── SIGNATURE D'ABONNÉ ────────────────────────────────────────────────
// Table `mail_signature`, tenue à l'écart de mail_settings juste au-dessus —
// et c'est tout son objet. Deux mécanismes de cette table-là rendraient la
// cohabitation dangereuse :
//   - l'enregistrement passe par upsertRecord, dont la branche de mise à jour
//     fait UPDATE … CONTENT : un remplacement intégral, pas une fusion. Un
//     enregistrement de signature aux champs SMTP/IMAP vides effacerait le mot
//     de passe chiffré de la boîte et la débrancherait en silence ;
//   - la suppression y est totale : « je supprime ma signature » emporterait
//     la boîte, et symétriquement déconnecter une boîte emporterait la
//     signature.
// Séparées, les deux vies ne peuvent plus se marcher dessus par construction.
//
// Rien de chiffré ne traverse ces routes : tout ce que porte la table est
// destiné à partir en clair dans les messages de l'abonné. Il n'y a donc pas
// d'équivalent de stripSettingsSecrets à appliquer avant de la rendre.
//
// L'IDENTITÉ VIENT DE req.userId, que seul requireAuth pose, depuis la session
// vérifiée — et non de requireUserId, dont la chaîne de repli lit l'en-tête
// x-user-id, la query et le corps (cf. lib/auth.js et la note SEC 1 plus bas,
// qui la dit spoofable). Cette table porte le logo et le texte qui partiront
// signés du nom de l'abonné dans chacun de ses courriels : l'identité doit se
// lire dans la route, sans dépendre de l'ordre d'un middleware à des milliers
// de lignes d'ici. Ne pas revenir à requireUserId ici.
//
// La garde est explicite parce que String(undefined) vaut « undefined », qui
// serait un identifiant d'enregistrement parfaitement valide : une requête
// atteignant ces routes hors du portillon partagerait alors un même espace de
// signature avec toutes les autres. Absente, l'identité vaut 401, sans qu'une
// seule lecture ni écriture ait lieu.

const SIGNATURE_VIDE = {
  active: false,
  texte: '',
  disposition: 'dessus',
  logo_data_url: null,
  logo_width: null,
  logo_height: null,
  updated_at: null
}

// Une dimension de logo est une métadonnée d'affichage, pas une donnée de
// confiance. Hors bornes, non entière ou absente, elle est mise à null : le
// balisage retombe alors sur son plafond en style, qui tient les proportions
// sans connaître la taille. Rien à refuser ici — il n'y a rien à protéger
// qu'un plafond ne tienne déjà.
function dimensionLogo(valeur, max) {
  const n = Number(valeur)
  if (!Number.isInteger(n) || n <= 0 || n > max) return null
  return n
}

app.get('/api/mail/signature', async (req, res) => {
  const userId = req.userId ? String(req.userId) : null
  if (!userId) return res.status(401).json({ error: 'Authentification requise' })
  try {
    const db = await getDb()
    // N'avoir aucune signature est un état normal, pas une erreur : la page
    // reçoit le formulaire vide plutôt qu'un 404 à interpréter.
    res.json(signatureEnSortie(await chargeSignature(db, userId)) || SIGNATURE_VIDE)
  } catch (err) {
    console.error('[mail/signature:get]', err.message)
    res.status(500).json({ error: 'Lecture de votre signature impossible' })
  }
})

app.put('/api/mail/signature', async (req, res) => {
  const userId = req.userId ? String(req.userId) : null
  if (!userId) return res.status(401).json({ error: 'Authentification requise' })
  const body = req.body || {}
  // Ce qui est reçu est du texte, jamais du balisage : le HTML de la signature
  // est construit à l'envoi, à partir de ce texte et de cette disposition.
  const texte = typeof body.texte === 'string' ? body.texte : ''
  if (texte.length > TEXTE_LONGUEUR_MAX) {
    return res.status(400).json({ error: `Votre texte de signature dépasse ${TEXTE_LONGUEUR_MAX} caractères.` })
  }
  const disposition = DISPOSITIONS.includes(body.disposition) ? body.disposition : 'dessus'
  // Le logo arrive mis au format par la page. Le serveur le relit quand même,
  // sans croire ni le type annoncé ni le poids déclaré : motifLogoRefuse
  // tranche sur les octets décodés, et rend le motif tel qu'il sera lu.
  let logo = null
  if (body.logo_data_url) {
    const motif = motifLogoRefuse(body.logo_data_url)
    if (motif) return res.status(400).json({ error: motif })
    logo = String(body.logo_data_url)
  }
  // Un interrupteur ne s'allume pas sur du vide : il annoncerait une signature
  // qui ne s'apposerait jamais, et l'abonné chercherait la panne à l'envoi.
  if (body.active === true && !texte.trim() && !logo) {
    return res.status(400).json({ error: 'Écrivez un texte ou téléversez un logo avant d\'activer votre signature.' })
  }
  try {
    const db = await getDb()
    // Ici le remplacement intégral d'upsertRecord est la bonne opération, et
    // non le piège qu'il est sur mail_settings : ce payload EST la signature
    // entière. Retirer son logo doit effacer le champ, pas le laisser en place.
    const payload = {
      userId,
      active: body.active === true,
      texte,
      disposition,
      logo_data_url: logo,
      logo_width: logo ? dimensionLogo(body.logo_width, LOGO_LARGEUR_ENCODEE_MAX) : null,
      logo_height: logo ? dimensionLogo(body.logo_height, LOGO_HAUTEUR_ENCODEE_MAX) : null,
      updated_at: new Date().toISOString()
    }
    const { record, status } = await upsertRecord(db, 'mail_signature', userId, payload)
    res.status(status).json(signatureEnSortie(record) || SIGNATURE_VIDE)
  } catch (err) {
    console.error('[mail/signature:put]', err.message)
    res.status(500).json({ error: 'Enregistrement de votre signature impossible' })
  }
})

// Supprime la signature, et rien d'autre : aucune boîte connectée n'est
// concernée par cette route.
app.delete('/api/mail/signature', async (req, res) => {
  const userId = req.userId ? String(req.userId) : null
  if (!userId) return res.status(401).json({ error: 'Authentification requise' })
  try {
    const db = await getDb()
    await db.query('DELETE type::record("mail_signature", $id)', { id: userId })
    res.json({ ok: true })
  } catch (err) {
    console.error('[mail/signature:delete]', err.message)
    res.status(500).json({ error: 'Suppression de votre signature impossible' })
  }
})

// ── AUTHENTIFICATION DU DOMAINE DE LA BOÎTE CONNECTÉE ─────────────────────
// Un abonné qui prospecte depuis contact@son-domaine.fr ne saura jamais que
// ses messages sont écartés : il n'y a ni plainte ni signalement, seulement
// une prospection qui ne reçoit pas de réponse. Cette route lit la zone DNS de
// son domaine et rend ce qui manque, déjà rédigé — lib/mail-authentification.js
// est l'autorité, la page n'interprète aucun code.
//
// D'OÙ VIENT LA BOÎTE. La même que celle dont la page fait son compte principal
// (/api/v2/mail/accounts, puis boites[0] côté page) : les comptes OAuth
// d'abord, la boîte IMAP héritée ensuite. L'identité vient de req.userId, jamais
// d'un paramètre — ce contrôle nomme un domaine et le rend à l'écran.
//
// LE TRANSPORT RÉEL, PAS LA BOÎTE. sendOne() achemine par Resend TOUTE adresse
// relevant d'un domaine vérifié, y compris quand une boîte du même nom est
// connectée : dans ce cas les enregistrements qui comptent sont ceux posés à la
// vérification, et contrôler le fournisseur de la boîte accuserait un domaine
// parfaitement en règle. La condition reprend donc celle de l'envoi, clé Resend
// comprise — sans clé, l'envoi retombe sur la boîte, et le contrôle aussi.
async function boiteDontOnPart(db, userId) {
  const creds = await listMailboxCredentials(db, userId)
  let boite = null
  if (creds[0]) {
    boite = { email: creds[0].email, provider: creds[0].provider, smtp_host: null }
  } else {
    const imap = await getImapAccount(db, userId)
    if (!imap) return null
    // getImapAccount ne rend pas l'hôte d'envoi, et c'est lui qui désigne le
    // fournisseur d'une boîte branchée en manuel. On relit le champ, et rien
    // d'autre : aucun secret ne sort de cette fonction.
    const rec = (await queryOrEmpty(db, 'SELECT smtp_host FROM type::record("mail_settings", $id)', { id: userId }))[0]
    boite = { email: imap.email, provider: 'imap', smtp_host: rec?.smtp_host || null }
  }
  if (!boite.email) return null
  const domaine = domainOf(boite.email)
  if (domaine && isResendReady()) {
    const verifies = await listVerifiedResendDomains(db, userId)
    boite.envoiParDomaineVerifie = verifies.includes(domaine)
  }
  return boite
}

// Revalidation forcée : elle court-circuite le cache du module, donc une
// dizaine de résolutions à chaque appel. Un abonné qui vient de faire poser la
// ligne appuie deux ou trois fois, ce qui est légitime ; une page laissée
// ouverte sur un minuteur ne l'est pas. Trente secondes entre deux passages en
// force, par abonné — au-delà, la réponse vient du cache sans que rien ne soit
// refusé : l'abonné voit une réponse, pas une erreur. La table ne porte qu'un
// horodatage par abonné ayant forcé au moins une fois : elle est bornée par le
// nombre d'abonnés, pas par le trafic.
const DERNIERE_REVALIDATION = new Map()
const DELAI_REVALIDATION_MS = 30 * 1000

app.get('/api/mail/authentification-domaine', async (req, res) => {
  const userId = req.userId ? String(req.userId) : null
  if (!userId) return res.status(401).json({ error: 'Authentification requise' })
  try {
    const db = await getDb()
    const boite = await boiteDontOnPart(db, userId)
    // Aucune boîte connectée : il n'y a pas de domaine à contrôler, et surtout
    // rien à annoncer. L'état est rendu tel quel, la page n'affiche rien.
    if (!boite) return res.json({ etat: 'sans_objet', motif: 'aucune_boite', annonce: null })

    let forcer = req.query.revalider === '1'
    if (forcer) {
      const dernier = DERNIERE_REVALIDATION.get(userId) || 0
      if (Date.now() - dernier < DELAI_REVALIDATION_MS) forcer = false
      else DERNIERE_REVALIDATION.set(userId, Date.now())
    }

    const resultat = await controleAuthentification(boite, { forcer })
    res.json({
      etat: resultat.etat,
      motif: resultat.motif || null,
      domaine: resultat.domaine || null,
      fournisseur: resultat.fournisseur ? resultat.fournisseur.nom : null,
      manquants: resultat.manquants || [],
      dmarc: resultat.dmarc || null,
      annonce: redigeAnnonce(resultat)
    })
  } catch (err) {
    // Un contrôle de délivrabilité ne doit jamais devenir une panne de la page
    // Mail. En cas d'échec, le silence : la page ne montre rien de plus qu'à
    // l'ordinaire, et l'abonné ne lit pas une erreur qui ne lui apprend rien.
    console.error('[mail/authentification-domaine]', err.message)
    res.json({ etat: 'indetermine', motif: 'erreur_serveur', annonce: null })
  }
})

app.post('/api/mail/test-smtp', async (req, res) => {
  if (!requireCrypto(res)) return
  const body = req.body || {}
  if (!body.smtp_host || !body.smtp_user || !body.smtp_pass) {
    return res.status(400).json({ error: 'Paramètres SMTP incomplets' })
  }
  try {
    const transporter = nodemailer.createTransport({
      host: body.smtp_host,
      port: Number(body.smtp_port) || 587,
      secure: body.smtp_secure ?? (Number(body.smtp_port) === 465),
      auth: { user: body.smtp_user, pass: body.smtp_pass }
    })
    await transporter.verify()
    res.json({ ok: true })
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message })
  }
})

app.post('/api/mail/test-imap', async (req, res) => {
  if (!requireCrypto(res)) return
  const body = req.body || {}
  const host = body.imap_host || deriveImapFromSmtp(body.smtp_host)
  const user = body.imap_user || body.smtp_user
  const pass = body.imap_pass || body.smtp_pass
  if (!host || !user || !pass) {
    return res.status(400).json({ error: 'Paramètres IMAP incomplets' })
  }
  const client = new ImapFlow({
    host,
    port: Number(body.imap_port) || 993,
    secure: body.imap_secure ?? true,
    auth: { user, pass },
    logger: false
  })
  try {
    await client.connect()
    await client.logout()
    res.json({ ok: true })
  } catch (err) {
    try { await client.logout() } catch (e) {}
    res.status(502).json({ ok: false, error: err.message })
  }
})

app.get('/api/mail', async (req, res) => {
  try {
    const userId = String(req.userId)
    const db = await getDb()
    const prospectId = req.query.prospectId ? String(req.query.prospectId) : null
    let result
    if (prospectId) {
      result = await queryOrEmpty(
        db,
        'SELECT * FROM mail WHERE userId = $userId AND prospectId = $prospectId ORDER BY date DESC',
        { userId, prospectId }
      )
    } else {
      result = await queryOrEmpty(db, 'SELECT * FROM mail WHERE userId = $userId ORDER BY date DESC', { userId })
    }
    res.json(result)
  } catch (err) {
    console.error('[mail:list]', err.message)
    res.status(500).json({ error: 'Lecture mails impossible' })
  }
})

app.get('/api/mail/:id', async (req, res) => {
  try {
    const userId = String(req.userId)
    const db = await getDb()
    const rec = (await queryOrEmpty(db, 'SELECT * FROM type::record("mail", $id)', { id: req.params.id }))[0]
    if (!rec || String(rec.userId) !== userId) return res.status(404).json({ error: 'Mail introuvable' })
    res.json(rec)
  } catch (err) {
    console.error('[mail:get]', err.message)
    res.status(500).json({ error: 'Lecture mail impossible' })
  }
})

app.delete('/api/mail/:id', async (req, res) => {
  try {
    const userId = String(req.userId)
    const db = await getDb()
    const existing = await db.query('SELECT userId FROM type::record("mail", $id)', { id: req.params.id })
    const rec = existing[0]?.[0]
    if (!rec || String(rec.userId) !== userId) return res.status(404).json({ error: 'Mail introuvable' })
    await db.query('DELETE type::record("mail", $id)', { id: req.params.id })
    res.json({ ok: true })
  } catch (err) {
    console.error('[mail:delete]', err.message)
    res.status(500).json({ error: 'Suppression mail impossible' })
  }
})

app.post('/api/mail/send', async (req, res) => {
  if (!requireCrypto(res)) return
  try {
    const body = req.body || {}
    const userId = String(req.userId)
    if (!body.to || !body.subject) {
      return res.status(400).json({ error: 'Destinataire et objet requis' })
    }
    const db = await getDb()
    const settingsResult = await db.query('SELECT * FROM type::record("mail_settings", $id)', { id: userId })
    const settings = settingsResult[0]?.[0]
    if (!settings || !settings.smtp_pass_encrypted) {
      return res.status(503).json({ error: 'Configuration SMTP absente — terminez l\'onboarding' })
    }

    const smtpPass = decrypt(settings.smtp_pass_encrypted)
    const transporter = nodemailer.createTransport({
      host: settings.smtp_host,
      port: settings.smtp_port,
      secure: settings.smtp_secure,
      auth: { user: settings.smtp_user, pass: smtpPass }
    })

    const bodyHtml = body.body_html || (body.body_text || '').replace(/\n/g, '<br>')
    const finalHtml = settings.signature_html
      ? `${bodyHtml}<br><br>${settings.signature_html}`
      : bodyHtml
    const finalText = settings.signature_text
      ? `${body.body_text || ''}\n\n${settings.signature_text}`
      : (body.body_text || '')

    const mailOptions = {
      from: settings.from_name ? `"${settings.from_name}" <${settings.from_email}>` : settings.from_email,
      to: body.to,
      cc: body.cc || undefined,
      subject: body.subject,
      text: finalText,
      html: finalHtml
    }

    let sendInfo
    try {
      sendInfo = await transporter.sendMail(mailOptions)
    } catch (smtpErr) {
      const failedRecord = {
        userId,
        direction: 'sent',
        prospectId: body.prospectId || null,
        from: settings.from_email,
        to: body.to,
        cc: body.cc || '',
        subject: body.subject,
        body_html: finalHtml,
        body_text: finalText,
        date: new Date().toISOString(),
        messageId: '',
        status: 'failed',
        error: smtpErr.message,
        attachments: []
      }
      const rid = `failed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      await upsertRecord(db, 'mail', rid, failedRecord)
      return res.status(502).json({ error: smtpErr.message })
    }

    const messageId = sendInfo.messageId || `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const recordId = hashMessageId(messageId)
    const sentRecord = {
      userId,
      direction: 'sent',
      prospectId: body.prospectId || null,
      from: settings.from_email,
      to: body.to,
      cc: body.cc || '',
      subject: body.subject,
      body_html: finalHtml,
      body_text: finalText,
      date: new Date().toISOString(),
      messageId,
      status: 'sent',
      attachments: []
    }
    const { record, status } = await upsertRecord(db, 'mail', recordId, sentRecord)
    res.status(status).json(record)
  } catch (err) {
    console.error('[mail/send]', err.message)
    res.status(500).json({ error: 'Envoi mail impossible' })
  }
})

app.post('/api/mail/sync', async (req, res) => {
  if (!requireCrypto(res)) return
  const userId = requireUserId(req, res)
  if (!userId) return
  const body = req.body || {}
  const onlyProspectId = body.prospectId ? String(body.prospectId) : null
  try {
    const db = await getDb()
    const settingsResult = await db.query('SELECT * FROM type::record("mail_settings", $id)', { id: userId })
    const settings = settingsResult[0]?.[0]
    if (!settings || !settings.imap_pass_encrypted) {
      return res.status(503).json({ error: 'Configuration IMAP absente' })
    }

    const pipelineResult = await db.query('SELECT id, email, co, name FROM pipeline WHERE userId = $userId', { userId })
    let cards = pipelineResult[0] || []
    if (onlyProspectId) cards = cards.filter(c => String(c.id) === onlyProspectId)
    const targets = cards.filter(c => c.email && /@/.test(c.email))
    if (!targets.length) return res.json({ synced: 0, errors: [] })

    const imapPass = decrypt(settings.imap_pass_encrypted)
    const client = new ImapFlow({
      host: settings.imap_host,
      port: settings.imap_port,
      secure: settings.imap_secure,
      auth: { user: settings.imap_user, pass: imapPass },
      logger: false
    })

    let synced = 0
    const errors = []
    try {
      await client.connect()
      const lock = await client.getMailboxLock('INBOX')
      try {
        for (const card of targets) {
          try {
            const uids = await client.search({ from: card.email })
            if (!uids || !uids.length) continue
            for await (const msg of client.fetch(uids, { source: true })) {
              const parsed = await simpleParser(msg.source)
              const messageId = parsed.messageId || `${card.email}_${parsed.date?.toISOString() || Date.now()}`
              const recordId = hashMessageId(messageId)
              const existing = await db.query('SELECT id FROM type::record("mail", $id)', { id: recordId })
              if (existing[0]?.[0]) continue
              await upsertRecord(db, 'mail', recordId, {
                userId,
                direction: 'received',
                prospectId: String(card.id),
                from: parsed.from?.text || card.email,
                to: parsed.to?.text || settings.from_email,
                cc: parsed.cc?.text || '',
                subject: parsed.subject || '',
                body_html: parsed.html || '',
                body_text: parsed.text || '',
                date: parsed.date ? parsed.date.toISOString() : new Date().toISOString(),
                messageId,
                status: 'received',
                attachments: (parsed.attachments || []).map(a => ({
                  filename: a.filename,
                  contentType: a.contentType,
                  size: a.size
                }))
              })
              synced++
            }
          } catch (cardErr) {
            errors.push({ prospectId: String(card.id), error: cardErr.message })
          }
        }
      } finally {
        lock.release()
      }
      await client.logout()
    } catch (imapErr) {
      try { await client.logout() } catch (e) {}
      return res.status(502).json({ error: imapErr.message })
    }
    res.json({ synced, errors })
  } catch (err) {
    console.error('[mail/sync]', err.message)
    res.status(500).json({ error: 'Synchronisation IMAP impossible' })
  }
})

// ── VISIO ─────────────────────────────────────────────────────────────
// V1: scoping par userId via getUserId() (env MUP_DEFAULT_USER_ID en mono-user).
// IndexedDB des blobs documents reste local (V2 = stockage cloud).

const visioBgJson = express.json({ limit: '20mb' })

app.get('/api/visio/settings', async (req, res) => {
  try {
    const db = await getDb()
    const userId = String(getUserId(req))
    const rows = await queryOrEmpty(db, 'SELECT * FROM type::record("visio_settings", $id)', { id: userId })
    res.json(rows[0] || { userId })
  } catch (err) {
    console.error('[visio/settings:get]', err.message)
    res.status(500).json({ error: 'Lecture configuration visio impossible' })
  }
})

async function visioSettingsUpsertHandler(req, res) {
  try {
    const db = await getDb()
    const userId = String(getUserId(req))
    const body = req.body || {}
    const payload = { ...body, userId, updated_at: new Date().toISOString() }
    const { record, status } = await upsertRecord(db, 'visio_settings', userId, payload)
    res.status(status).json(record)
  } catch (err) {
    console.error('[visio/settings:upsert]', err.message)
    res.status(500).json({ error: 'Enregistrement configuration visio impossible' })
  }
}
app.put('/api/visio/settings', visioSettingsUpsertHandler)
// POST alias pour sendBeacon (beforeunload flush) — sendBeacon ne supporte que POST
app.post('/api/visio/settings', visioSettingsUpsertHandler)

app.get('/api/visio/logs', async (req, res) => {
  try {
    const db = await getDb()
    const userId = String(getUserId(req))
    const prospectId = req.query.prospectId ? String(req.query.prospectId) : null
    let result
    if (prospectId) {
      result = await queryOrEmpty(
        db,
        'SELECT * FROM visio_log WHERE userId = $userId AND prospectId = $prospectId ORDER BY started_at DESC',
        { userId, prospectId }
      )
    } else {
      result = await queryOrEmpty(db, 'SELECT * FROM visio_log WHERE userId = $userId ORDER BY started_at DESC', { userId })
    }
    res.json(result)
  } catch (err) {
    console.error('[visio/logs:list]', err.message)
    res.status(500).json({ error: 'Lecture logs visio impossible' })
  }
})

app.post('/api/visio/logs', async (req, res) => {
  try {
    const db = await getDb()
    const userId = String(getUserId(req))
    const body = req.body || {}
    const payload = {
      userId,
      prospectId: body.prospectId || null,
      rdvId: body.rdvId || null,
      provider: body.provider || 'custom',
      link: body.link || '',
      started_at: body.started_at || new Date().toISOString(),
      ended_at: body.ended_at || null,
      duration_seconds: body.duration_seconds || 0,
      notes: body.notes || ''
    }
    const cleanId = cleanRecordId('visio_log', body.id) || `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const { record, status } = await upsertRecord(db, 'visio_log', cleanId, payload)
    res.status(status).json(record)
  } catch (err) {
    console.error('[visio/logs:post]', err.message)
    res.status(500).json({ error: 'Enregistrement log visio impossible' })
  }
})

app.delete('/api/visio/logs/:id', async (req, res) => {
  try {
    const userId = String(req.userId)
    const db = await getDb()
    const existing = await db.query('SELECT userId FROM type::record("visio_log", $id)', { id: req.params.id })
    const rec = existing[0]?.[0]
    if (!rec || String(rec.userId) !== userId) return res.status(404).json({ error: 'Log visio introuvable' })
    await db.query('DELETE type::record("visio_log", $id)', { id: req.params.id })
    res.json({ ok: true })
  } catch (err) {
    console.error('[visio/logs:delete]', err.message)
    res.status(500).json({ error: 'Suppression log visio impossible' })
  }
})

function draftId(userId, prospectId) {
  return `${String(userId).replace(/[^a-zA-Z0-9_]/g, '_')}_${String(prospectId).replace(/[^a-zA-Z0-9_]/g, '_')}`
}

app.get('/api/visio/drafts/:prospectId', async (req, res) => {
  try {
    const db = await getDb()
    const userId = String(getUserId(req))
    const id = draftId(userId, req.params.prospectId)
    const rec = (await queryOrEmpty(db, 'SELECT * FROM type::record("visio_draft", $id)', { id }))[0]
    if (!rec) return res.status(404).json({ error: 'Draft introuvable' })
    res.json(rec)
  } catch (err) {
    console.error('[visio/drafts:get]', err.message)
    res.status(500).json({ error: 'Lecture draft impossible' })
  }
})

app.put('/api/visio/drafts/:prospectId', async (req, res) => {
  try {
    const db = await getDb()
    const userId = String(getUserId(req))
    const prospectId = String(req.params.prospectId)
    const id = draftId(userId, prospectId)
    const payload = {
      userId,
      prospectId,
      content: (req.body && req.body.content) || '',
      updated_at: new Date().toISOString()
    }
    const { record, status } = await upsertRecord(db, 'visio_draft', id, payload)
    res.status(status).json(record)
  } catch (err) {
    console.error('[visio/drafts:put]', err.message)
    res.status(500).json({ error: 'Enregistrement draft impossible' })
  }
})

app.delete('/api/visio/drafts/:prospectId', async (req, res) => {
  try {
    const db = await getDb()
    const userId = String(getUserId(req))
    const id = draftId(userId, req.params.prospectId)
    await db.query('DELETE type::record("visio_draft", $id)', { id })
    res.json({ ok: true })
  } catch (err) {
    console.error('[visio/drafts:delete]', err.message)
    res.status(500).json({ error: 'Suppression draft impossible' })
  }
})

app.get('/api/visio/bg-custom', async (req, res) => {
  try {
    const db = await getDb()
    const userId = String(getUserId(req))
    const rec = (await queryOrEmpty(db, 'SELECT * FROM type::record("visio_bg_custom", $id)', { id: userId }))[0]
    if (!rec) return res.status(404).json({ error: 'Fond personnalisé absent' })
    res.json(rec)
  } catch (err) {
    console.error('[visio/bg:get]', err.message)
    res.status(500).json({ error: 'Lecture fond personnalisé impossible' })
  }
})

app.put('/api/visio/bg-custom', visioBgJson, async (req, res) => {
  try {
    const db = await getDb()
    const userId = String(getUserId(req))
    const body = req.body || {}
    const payload = {
      userId,
      data_base64: body.data_base64 || '',
      mime: body.mime || 'image/jpeg',
      size: Number(body.size) || (body.data_base64 ? body.data_base64.length : 0),
      updated_at: new Date().toISOString()
    }
    const { record, status } = await upsertRecord(db, 'visio_bg_custom', userId, payload)
    res.status(status).json(record)
  } catch (err) {
    console.error('[visio/bg:put]', err.message)
    res.status(500).json({ error: 'Enregistrement fond personnalisé impossible' })
  }
})

app.delete('/api/visio/bg-custom', async (req, res) => {
  try {
    const db = await getDb()
    const userId = String(getUserId(req))
    await db.query('DELETE type::record("visio_bg_custom", $id)', { id: userId })
    res.json({ ok: true })
  } catch (err) {
    console.error('[visio/bg:delete]', err.message)
    res.status(500).json({ error: 'Suppression fond personnalisé impossible' })
  }
})

app.get('/api/visio/docs', async (req, res) => {
  try {
    const db = await getDb()
    const userId = String(getUserId(req))
    res.json(await queryOrEmpty(db, 'SELECT * FROM visio_doc WHERE userId = $userId ORDER BY addedAt DESC', { userId }))
  } catch (err) {
    console.error('[visio/docs:list]', err.message)
    res.status(500).json({ error: 'Lecture documents impossible' })
  }
})

app.post('/api/visio/docs', async (req, res) => {
  try {
    const db = await getDb()
    const userId = String(getUserId(req))
    const body = req.body || {}
    const payload = {
      userId,
      name: body.name || '',
      tag: body.tag || 'custom',
      mime: body.mime || '',
      size: Number(body.size) || 0,
      pinned: Boolean(body.pinned),
      indexedDb_local_id: body.indexedDb_local_id || body.id || null,
      addedAt: body.addedAt || new Date().toISOString()
    }
    const cleanId = cleanRecordId('visio_doc', body.id) || `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const { record, status } = await upsertRecord(db, 'visio_doc', cleanId, payload)
    res.status(status).json(record)
  } catch (err) {
    console.error('[visio/docs:post]', err.message)
    res.status(500).json({ error: 'Enregistrement document impossible' })
  }
})

app.put('/api/visio/docs/:id', async (req, res) => {
  try {
    const userId = String(req.userId)
    const db = await getDb()
    const id = req.params.id
    const existing = await db.query('SELECT * FROM type::record("visio_doc", $id)', { id })
    const rec = existing[0]?.[0]
    if (!rec || String(rec.userId) !== userId) return res.status(404).json({ error: 'Document introuvable' })
    const cleanBody = { ...(req.body || {}) }
    delete cleanBody.id
    cleanBody.userId = userId
    const result = await db.query('UPDATE type::record("visio_doc", $id) CONTENT $body', { id, body: cleanBody })
    res.json(result[0]?.[0] || result[0] || {})
  } catch (err) {
    console.error('[visio/docs:put]', err.message)
    res.status(500).json({ error: 'Mise à jour document impossible' })
  }
})

app.delete('/api/visio/docs/:id', async (req, res) => {
  try {
    const userId = String(req.userId)
    const db = await getDb()
    const existing = await db.query('SELECT userId FROM type::record("visio_doc", $id)', { id: req.params.id })
    const rec = existing[0]?.[0]
    if (!rec || String(rec.userId) !== userId) return res.status(404).json({ error: 'Document introuvable' })
    await db.query('DELETE type::record("visio_doc", $id)', { id: req.params.id })
    res.json({ ok: true })
  } catch (err) {
    console.error('[visio/docs:delete]', err.message)
    res.status(500).json({ error: 'Suppression document impossible' })
  }
})

app.post('/api/visio/docs/:id/open', async (req, res) => {
  try {
    const db = await getDb()
    const userId = String(getUserId(req))
    const docId = req.params.id
    const body = req.body || {}
    const payload = {
      userId,
      docId,
      prospectId: body.prospectId || null,
      societe: body.societe || '',
      openedAt: body.openedAt || new Date().toISOString()
    }
    const recordId = `open_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const { record, status } = await upsertRecord(db, 'visio_doc_open', recordId, payload)
    res.status(status).json(record)
  } catch (err) {
    console.error('[visio/docs:open]', err.message)
    res.status(500).json({ error: 'Enregistrement ouverture impossible' })
  }
})

app.get('/api/visio/doc-opens', async (req, res) => {
  try {
    const db = await getDb()
    const userId = String(getUserId(req))
    res.json(await queryOrEmpty(
      db,
      'SELECT * FROM visio_doc_open WHERE userId = $userId ORDER BY openedAt DESC',
      { userId }
    ))
  } catch (err) {
    console.error('[visio/doc-opens:list]', err.message)
    res.status(500).json({ error: 'Lecture historique global ouvertures impossible' })
  }
})

app.get('/api/visio/docs/:id/opens', async (req, res) => {
  try {
    const db = await getDb()
    const userId = String(getUserId(req))
    const docId = req.params.id
    res.json(await queryOrEmpty(
      db,
      'SELECT * FROM visio_doc_open WHERE userId = $userId AND docId = $docId ORDER BY openedAt DESC',
      { userId, docId }
    ))
  } catch (err) {
    console.error('[visio/docs:opens]', err.message)
    res.status(500).json({ error: 'Lecture historique ouvertures impossible' })
  }
})

// ── DEVIS / FACTURES ──────────────────────────────────────────────────
// V1: numérotation séquentielle protégée par mutex in-process per-(userId,type).
// Test race condition (5 POST simultanés) sur UPDATE+fallback CREATE a échoué :
// UPDATE sur record absent retourne [] et la branche CREATE n'est pas atomique
// → bascule sur sérialisation node.js. Marche tant qu'un seul replica Railway
// gère les requêtes. À revoir si scale-out > 1 replica (passer à un lock
// distribué ou à une séquence SurrealDB native si proposée).

const _counterMutex = new Map() // key: `${userId}_${type}` → pending promise

async function nextSequenceNumber(db, userId, type) {
  const key = `${userId}_${type}`
  const prev = _counterMutex.get(key) || Promise.resolve()
  let release
  const wait = new Promise(r => { release = r })
  _counterMutex.set(key, wait)
  try {
    await prev
    return await _generateSequenceUnsafe(db, userId, type)
  } finally {
    release()
    if (_counterMutex.get(key) === wait) _counterMutex.delete(key)
  }
}

async function _generateSequenceUnsafe(db, userId, type) {
  const year = new Date().getFullYear()
  const counterId = `${String(userId).replace(/[^a-zA-Z0-9_]/g, '_')}_${type}_${year}`
  // À l'intérieur du mutex : SELECT actuel → calcule nextSeq → UPDATE/CREATE.
  // Pas de race possible : un seul caller à la fois pour ce (userId,type).
  const sel = await db.query('SELECT seq FROM type::record("counter", $id)', { id: counterId })
  const current = sel[0]?.[0]
  const nextSeq = current ? Number(current.seq || 0) + 1 : 1
  if (current) {
    await db.query(
      'UPDATE type::record("counter", $id) SET seq = $seq, updated_at = time::now()',
      { id: counterId, seq: nextSeq }
    )
  } else {
    await db.query(
      'CREATE type::record("counter", $id) CONTENT { userId: $userId, type: $type, year: $year, seq: $seq, updated_at: time::now() }',
      { id: counterId, userId, type, year, seq: nextSeq }
    )
  }
  const prefix = type === 'facture' ? 'FAC' : 'DEV'
  const padded = String(nextSeq).padStart(4, '0')
  return { numero: `${prefix}-${year}-${padded}`, seq: nextSeq, year }
}

// Arrondi comptable à deux décimales, même règle que les pages : chaque ligne
// d'abord, puis le total. N'arrondir que le total laisserait les décimales
// tronquées des lignes s'additionner et diverger d'un centime de la somme des
// lignes imprimées sur le document.
function round2(n) {
  const v = Number.parseFloat(n)
  return Number.isFinite(v) ? Math.round((v + Number.EPSILON) * 100) / 100 : 0
}

function numOrZero(v) {
  const n = Number.parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

// ── DEVIS ──
app.get('/api/devis', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    res.json(await queryOrEmpty(db, 'SELECT * FROM devis WHERE userId = $userId ORDER BY date_emission DESC, created_at DESC', { userId }))
  } catch (err) {
    console.error('[devis:list]', err.message)
    res.status(500).json({ error: 'Lecture devis impossible' })
  }
})

// ── DEVIS SIGNÉ PAR LE CLIENT ─────────────────────────────────────────────
// L'abonné envoie son devis, le client le renvoie signé par courriel, et
// l'abonné dépose ici cette pièce. Elle vit dans la table `devis_signature`,
// un enregistrement par devis, id = id du devis (cf. lib/piece-signee.js pour
// le pourquoi de la table séparée).
//
// CE QUE LA PIÈCE DÉCLENCHE, et qui n'est pas dans cette table :
//   - le devis se fige (POST, PUT et DELETE le refusent en 409),
//   - il devient convertible en facture, la pièce valant acceptation.
//
// L'IDENTITÉ VIENT DE req.userId, que seul requireAuth pose depuis la session
// vérifiée, et non de requireUserId, dont la chaîne de repli lit l'en-tête
// x-user-id, la query et le corps, et retombe sur 'default'. Ces routes portent
// une pièce contractuelle signée d'un tiers : l'identité doit se lire dans la
// route, sans dépendre de l'ordre d'un middleware à des milliers de lignes
// d'ici. La garde est explicite parce que String(undefined) vaut « undefined »,
// identifiant d'enregistrement parfaitement valide, qui ferait d'un espace de
// signatures un bien commun.
//
// AUCUNE ROUTE DE SUPPRESSION, et c'est délibéré. Retirer la pièce rendrait au
// devis toute sa mutabilité : ses lignes, ses montants et son numéro
// redeviendraient modifiables alors qu'un client les a signés, et le numéro
// déjà consommé serait libéré. Rien n'est perdu pour autant : la pièce reste
// dans la boîte de courriel de l'abonné, et un nouveau dépôt remplace le
// précédent. Ne pas ajouter de DELETE ici.
//
// Le dépôt est une ÉCRITURE : il passe donc le portillon d'abonnement, et un
// essai expiré le voit en 402 comme toute autre écriture. Aucune exemption.

// Présence d'une pièce signée, en une lecture qui ne rapatrie aucune charge :
// c'est le prédicat du figeage et de la garde de conversion. queryOrEmpty ne
// neutralise qu'un seul cas, la table jamais créée, qui ne porte alors aucune
// pièce ; toute autre panne de lecture remonte à l'appelant et finit en 500,
// jamais en « pas de pièce ». Un devis signé ne doit pas redevenir modifiable
// parce qu'une requête a échoué.
async function pieceSigneeExiste(db, devisId) {
  const rows = await queryOrEmpty(db, 'SELECT id FROM type::record("devis_signature", $id)', { id: devisId })
  return Boolean(rows[0])
}

// Message unique du refus, pour que les trois écritures gelées nomment la même
// raison. Un 409 muet enverrait l'abonné chercher la panne dans son réseau.
const DEVIS_FIGE = 'Ce devis a été signé par votre client, il n\'est plus modifiable'

// DÉCLARÉE AVANT app.get('/api/devis/:id') : Express sert la première route
// qui filtre, et ':id' attraperait 'signatures' comme un identifiant de devis.
// Ne pas déplacer cette route plus bas.
//
// La LISTE des identifiants signés, et rien d'autre : la page l'appelle à
// chaque ouverture pour poser une pastille sur les lignes concernées. Les
// identifiants sont rendus nettoyés (sans le préfixe 'devis:'), forme sous
// laquelle ils servent de clé.
app.get('/api/devis/signatures', async (req, res) => {
  const userId = req.userId ? String(req.userId) : null
  if (!userId) return res.status(401).json({ error: 'Authentification requise' })
  try {
    const db = await getDb()
    res.json(await listeDevisSignes(db, userId))
  } catch (err) {
    console.error('[devis:signatures]', err.message)
    res.status(500).json({ error: 'Lecture des devis signés impossible' })
  }
})

// Métadonnées de la pièce, charge exclue : de quoi écrire « PDF, 1,2 Mo, déposé
// le 3 mars » et proposer le lien qui l'ouvre.
app.get('/api/devis/:id/signature', async (req, res) => {
  const userId = req.userId ? String(req.userId) : null
  if (!userId) return res.status(401).json({ error: 'Authentification requise' })
  try {
    const db = await getDb()
    const devisId = cleanRecordId('devis', req.params.id) || req.params.id
    const piece = await chargePiece(db, devisId)
    if (!piece || String(piece.userId) !== userId) {
      return res.status(404).json({ error: 'Aucun devis signé déposé' })
    }
    res.json(pieceEnSortie(piece))
  } catch (err) {
    console.error('[devis:signature:get]', err.message)
    res.status(500).json({ error: 'Lecture du devis signé impossible' })
  }
})

// La charge, servie telle qu'elle est arrivée, pour ouvrir la pièce dans un
// onglet. Le type sort de l'adresse data: relue ici, jamais d'un champ de la
// base : nosniff interdit au navigateur d'en inventer un autre, et le nom du
// fichier est refabriqué avant d'entrer dans l'en-tête. La liste des types
// acceptés (PDF et images matricielles, jamais SVG) est ce qui rend cet
// affichage sans danger.
app.get('/api/devis/:id/signature/fichier', async (req, res) => {
  const userId = req.userId ? String(req.userId) : null
  if (!userId) return res.status(401).json({ error: 'Authentification requise' })
  try {
    const db = await getDb()
    const devisId = cleanRecordId('devis', req.params.id) || req.params.id
    const piece = await chargePiece(db, devisId)
    if (!piece || String(piece.userId) !== userId) {
      return res.status(404).json({ error: 'Aucun devis signé déposé' })
    }
    const lu = litPieceDataUrl(piece.contenu_data_url)
    if (!lu) return res.status(500).json({ error: 'Le devis signé déposé est illisible' })
    res.setHeader('Content-Type', lu.contentType)
    res.setHeader('Content-Length', String(lu.octets.length))
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Content-Disposition', `inline; filename="${nettoieNomFichier(piece.filename, lu.contentType)}"`)
    res.send(lu.octets)
  } catch (err) {
    console.error('[devis:signature:fichier]', err.message)
    res.status(500).json({ error: 'Lecture du devis signé impossible' })
  }
})

// Dépôt et remplacement. Sous le parseur étroit monté en tête de fichier :
// c'est la seule route de l'application qui accepte un corps au-delà de 10 Mo.
app.put('/api/devis/:id/signature', async (req, res) => {
  const userId = req.userId ? String(req.userId) : null
  if (!userId) return res.status(401).json({ error: 'Authentification requise' })
  try {
    const db = await getDb()
    const devisId = cleanRecordId('devis', req.params.id) || req.params.id
    // Le devis doit exister et être le sien : une pièce ne s'accroche pas à un
    // document absent, et l'appartenance se vérifie sur le devis, pas sur ce
    // que le corps de la requête raconte.
    const rows = await queryOrEmpty(db, 'SELECT userId FROM type::record("devis", $id)', { id: devisId })
    const devis = rows[0]
    if (!devis || String(devis.userId) !== userId) return res.status(404).json({ error: 'Devis introuvable' })

    // Ni le type annoncé ni le poids déclaré par la page ne sont crus :
    // motifPieceRefusee tranche sur les octets décodés et rend le motif tel
    // qu'il sera lu à l'abonné.
    const dataUrl = req.body?.contenu_data_url
    const motif = motifPieceRefusee(dataUrl)
    if (motif) return res.status(400).json({ error: motif })
    const lu = litPieceDataUrl(dataUrl)

    // PREMIER DÉPÔT RELU ET RÉINJECTÉ. upsertRecord écrit en UPDATE … CONTENT,
    // qui REMPLACE l'enregistrement en entier : un champ absent de ce payload
    // est un champ effacé. Sans cette relecture, chaque remplacement écraserait
    // first_deposited_at par la date du remplacement, et la date à laquelle le
    // client a signé serait perdue au premier renvoi de pièce.
    const ancienne = await chargePiece(db, devisId)
    const now = new Date().toISOString()

    const payload = {
      userId,
      devisId,
      contenu_data_url: String(dataUrl),
      content_type: lu.contentType,
      octets: lu.octets.length,
      filename: nettoieNomFichier(req.body?.filename, lu.contentType),
      deposited_at: now,
      first_deposited_at: ancienne?.first_deposited_at || now
    }
    const { record, status } = await upsertRecord(db, 'devis_signature', devisId, payload)
    // upsertRecord rend 404 quand l'enregistrement préexistant appartient à un
    // autre compte. Le devis a déjà été contrôlé plus haut : ce cas ne devrait
    // pas se produire, et s'il se produit il ne s'agit pas d'une pièce à rendre.
    if (status === 404) return res.status(404).json({ error: 'Devis introuvable' })
    res.status(status).json(pieceEnSortie(record))
  } catch (err) {
    console.error('[devis:signature:put]', err.message)
    res.status(500).json({ error: 'Enregistrement du devis signé impossible' })
  }
})

app.get('/api/devis/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const id = cleanRecordId('devis', req.params.id) || req.params.id
    const rec = (await queryOrEmpty(db, 'SELECT * FROM type::record("devis", $id)', { id }))[0]
    if (!rec || rec.userId !== userId) return res.status(404).json({ error: 'Devis introuvable' })
    res.json(rec)
  } catch (err) {
    console.error('[devis:get]', err.message)
    res.status(500).json({ error: 'Lecture devis impossible' })
  }
})

app.post('/api/devis', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const body = { ...(req.body || {}), userId }
    // Numéro auto si absent et pas de fourniture explicite
    if (!body.numero && !body.num) {
      const { numero, seq, year } = await nextSequenceNumber(db, userId, 'devis')
      body.numero = numero
      body.numero_seq = seq
      body.numero_year = year
    }
    const now = new Date().toISOString()
    if (!body.created_at) body.created_at = now
    body.updated_at = now

    const cleanId = cleanRecordId('devis', body.id)
    if (cleanId) {
      // FIGEAGE. Cette route est un upsert : avec un id, elle REMPLACE un devis
      // existant, et c'est par elle que passe l'enregistrement de la page. Un
      // devis dont le client a renvoyé la pièce signée ne se réécrit plus.
      //
      // Dans cette branche seulement : sans id, il s'agit d'une création, et un
      // document qui n'existe pas encore ne peut porter aucune pièce signée.
      if (await pieceSigneeExiste(db, cleanId)) {
        return res.status(409).json({ error: DEVIS_FIGE })
      }
      const { record, status } = await upsertRecord(db, 'devis', cleanId, body)
      return res.status(status).json(record)
    }
    const result = await db.query('CREATE devis CONTENT $body', { body })
    res.status(201).json(result[0]?.[0] || result[0] || null)
  } catch (err) {
    console.error('[devis:post]', err.message)
    res.status(500).json({ error: 'Enregistrement devis impossible' })
  }
})

app.put('/api/devis/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const id = cleanRecordId('devis', req.params.id) || req.params.id
    const existing = await db.query('SELECT * FROM type::record("devis", $id)', { id })
    const rec = existing[0]?.[0]
    if (!rec || rec.userId !== userId) return res.status(404).json({ error: 'Devis introuvable' })
    // FIGEAGE, après la garde d'appartenance : un devis signé par le client ne
    // se réécrit plus. L'ordre compte, un 409 posé avant elle dirait à un tiers
    // qu'un devis signé existe sous cet identifiant.
    if (await pieceSigneeExiste(db, id)) {
      return res.status(409).json({ error: DEVIS_FIGE })
    }
    const cleanBody = { ...(req.body || {}) }
    delete cleanBody.id
    cleanBody.userId = userId
    cleanBody.updated_at = new Date().toISOString()
    // Préserve numero/numero_seq/numero_year initial (non-rewritable)
    if (rec.numero) cleanBody.numero = rec.numero
    if (rec.numero_seq) cleanBody.numero_seq = rec.numero_seq
    if (rec.numero_year) cleanBody.numero_year = rec.numero_year
    const result = await db.query('UPDATE type::record("devis", $id) CONTENT $body', { id, body: cleanBody })
    res.json(result[0]?.[0] || result[0] || {})
  } catch (err) {
    console.error('[devis:put]', err.message)
    res.status(500).json({ error: 'Mise à jour devis impossible' })
  }
})

app.delete('/api/devis/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const id = cleanRecordId('devis', req.params.id) || req.params.id
    const existing = await db.query('SELECT * FROM type::record("devis", $id)', { id })
    const rec = existing[0]?.[0]
    if (!rec || rec.userId !== userId) return res.status(404).json({ error: 'Devis introuvable' })
    // FIGEAGE, après la garde d'appartenance. Supprimer emporterait la pièce
    // avec le document qu'elle engage, et libérerait un numéro déjà consommé
    // par un devis que le client a signé.
    if (await pieceSigneeExiste(db, id)) {
      return res.status(409).json({ error: DEVIS_FIGE })
    }
    await db.query('DELETE type::record("devis", $id)', { id })
    res.json({ ok: true })
  } catch (err) {
    console.error('[devis:delete]', err.message)
    res.status(500).json({ error: 'Suppression devis impossible' })
  }
})

// ── FACTURES ──
app.get('/api/factures', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    res.json(await queryOrEmpty(db, 'SELECT * FROM facture WHERE userId = $userId ORDER BY date_emission DESC, created_at DESC', { userId }))
  } catch (err) {
    console.error('[factures:list]', err.message)
    res.status(500).json({ error: 'Lecture factures impossible' })
  }
})

app.get('/api/factures/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const id = cleanRecordId('facture', req.params.id) || req.params.id
    const rec = (await queryOrEmpty(db, 'SELECT * FROM type::record("facture", $id)', { id }))[0]
    if (!rec || rec.userId !== userId) return res.status(404).json({ error: 'Facture introuvable' })
    res.json(rec)
  } catch (err) {
    console.error('[factures:get]', err.message)
    res.status(500).json({ error: 'Lecture facture impossible' })
  }
})

app.post('/api/factures', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const body = { ...(req.body || {}), userId }
    if (!body.numero && !body.numero_seq) {
      const { numero, seq, year } = await nextSequenceNumber(db, userId, 'facture')
      body.numero = numero
      body.numero_seq = seq
      body.numero_year = year
    }
    const now = new Date().toISOString()
    if (!body.created_at) body.created_at = now
    body.updated_at = now

    const cleanId = cleanRecordId('facture', body.id)
    if (cleanId) {
      const { record, status } = await upsertRecord(db, 'facture', cleanId, body)
      return res.status(status).json(record)
    }
    const result = await db.query('CREATE facture CONTENT $body', { body })
    res.status(201).json(result[0]?.[0] || result[0] || null)
  } catch (err) {
    console.error('[factures:post]', err.message)
    res.status(500).json({ error: 'Enregistrement facture impossible' })
  }
})

app.put('/api/factures/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const id = cleanRecordId('facture', req.params.id) || req.params.id
    const existing = await db.query('SELECT * FROM type::record("facture", $id)', { id })
    const rec = existing[0]?.[0]
    if (!rec || rec.userId !== userId) return res.status(404).json({ error: 'Facture introuvable' })
    const cleanBody = { ...(req.body || {}) }
    delete cleanBody.id
    cleanBody.userId = userId
    cleanBody.updated_at = new Date().toISOString()
    // Numéro séquentiel verrouillé après création (exigence facturation 2027)
    if (rec.numero) cleanBody.numero = rec.numero
    if (rec.numero_seq) cleanBody.numero_seq = rec.numero_seq
    if (rec.numero_year) cleanBody.numero_year = rec.numero_year
    const result = await db.query('UPDATE type::record("facture", $id) CONTENT $body', { id, body: cleanBody })
    res.json(result[0]?.[0] || result[0] || {})
  } catch (err) {
    console.error('[factures:put]', err.message)
    res.status(500).json({ error: 'Mise à jour facture impossible' })
  }
})

app.delete('/api/factures/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const id = cleanRecordId('facture', req.params.id) || req.params.id
    const existing = await db.query('SELECT * FROM type::record("facture", $id)', { id })
    const rec = existing[0]?.[0]
    if (!rec || rec.userId !== userId) return res.status(404).json({ error: 'Facture introuvable' })
    await db.query('DELETE type::record("facture", $id)', { id })
    res.json({ ok: true })
  } catch (err) {
    console.error('[factures:delete]', err.message)
    res.status(500).json({ error: 'Suppression facture impossible' })
  }
})

// Conversion devis accepté → facture
app.post('/api/factures/from-devis/:devisId', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    // La page renvoie l'id tel que l'API le lui a servi ('devis:xxx') : même
    // normalisation que les autres routes devis, sans quoi type::record() ne
    // trouve rien et la conversion tombe en 404 quel que soit l'état du devis.
    const devisId = cleanRecordId('devis', req.params.devisId) || req.params.devisId
    const dResult = await db.query('SELECT * FROM type::record("devis", $id)', { id: devisId })
    const devis = dResult[0]?.[0]
    if (!devis || devis.userId !== userId) return res.status(404).json({ error: 'Devis introuvable' })
    // GARDE D'ACCEPTATION. La forme précédente s'ouvrait sur `devis.statut &&` :
    // un devis sans champ `statut` (la forme plate écrite par la page ne porte
    // que `status`) court-circuitait le test et se convertissait sans aucun
    // contrôle. La garde ne gardait rien.
    //
    // Convertible à deux titres, dont un seul suffit :
    //   - le devis est marqué accepté, dans l'une ou l'autre des deux formes ;
    //   - une pièce signée est déposée, qui VAUT acceptation.
    // Le second titre existe pour que l'abonné qui recueille la signature de son
    // client n'ait pas à passer en plus par le sélecteur de statut ; le premier
    // pour que celui qui n'en recueille jamais ne soit pas bloqué.
    //
    // Ceci RESTREINT un comportement jusqu'ici permissif : un devis ni accepté
    // ni signé se convertit aujourd'hui, il ne se convertira plus.
    const accepte = devis.statut === 'accepte' || devis.status === 'accepted'
    if (!accepte && !(await pieceSigneeExiste(db, devisId))) {
      return res.status(412).json({ error: 'Le devis doit être accepté, ou porter le devis signé de votre client, avant conversion' })
    }
    // Idempotence : un devis ne produit qu'une facture, et la garde est ici.
    // Le contrôle de la page ne tient pas contre un double-clic, un onglet resté
    // ouvert sur un devis déjà converti, ou un appel direct de l'API.
    if (devis.facture_id) {
      return res.status(409).json({ error: 'Devis déjà converti en facture', facture: devis.facture_id })
    }

    // Réservation atomique AVANT la génération du numéro : un UPDATE ... WHERE
    // qui ne matche pas retourne [], donc le second appel concurrent repart en
    // 409 sans avoir consommé un numéro de séquence pour une facture qui ne
    // naîtra pas. Les trois formes de vide sont testées : un devis écrit par la
    // page peut porter un champ absent (NONE), null, ou la chaîne vide.
    const claimNow = new Date().toISOString()
    const claim = await db.query(
      `UPDATE type::record("devis", $id) SET conversion_at = $now
       WHERE (conversion_at = NONE OR conversion_at = NULL OR conversion_at = '')
         AND (facture_id = NONE OR facture_id = NULL OR facture_id = '')`,
      { id: devisId, now: claimNow }
    )
    if (!claim[0]?.[0]) {
      return res.status(409).json({ error: 'Conversion déjà en cours ou déjà effectuée' })
    }

    // Génère le numéro de facture séquentiel
    const { numero, seq, year } = await nextSequenceNumber(db, userId, 'facture')
    const now = new Date().toISOString()
    // Régime REPORTÉ du devis, jamais recalculé depuis le compte : le devis a été
    // émis sous un régime (son taux `tva`), la facture le fige à l'identique.
    const tauxDevis = Number(devis.tva) || 0
    const tvaApplicable = tauxDevis > 0

    // La facture doit porter les champs que factures.html lit. Sans client{},
    // lignes[] et les trois totaux, elle s'affiche à 0 € dans la liste et tombe
    // dans le prédicat « facture fantôme » qui arme le bouton « Vider la base de
    // test ». Lecture tolérante des deux formes du devis : la forme plate
    // historique (name/co/addr/lines[desc,qty,pu]) et la forme unifiée.
    const lignesSrc = Array.isArray(devis.lignes) && devis.lignes.length
      ? devis.lignes
      : (Array.isArray(devis.lines) ? devis.lines : [])
    const lignes = lignesSrc.map(l => {
      const quantite = numOrZero(l.quantite ?? l.qty)
      const prixUnitaire = numOrZero(l.prix_unitaire ?? l.pu)
      const ligne = {
        designation: String(l.designation ?? l.desc ?? ''),
        quantite,
        prix_unitaire: prixUnitaire,
        total: round2(quantite * prixUnitaire)
      }
      if (l.unite) ligne.unite = l.unite
      if (l.date) ligne.date = l.date
      return ligne
    })
    const totalHt = round2(lignes.reduce((s, l) => s + l.total, 0))
    const montantTva = round2(totalHt * tauxDevis / 100)
    const totalTtc = round2(totalHt + montantTva)

    const clientSrc = devis.client || {}
    const siret = String(clientSrc.siret || devis.client_siret || devis.siret || '').replace(/\D/g, '')
    const client = {
      nom: clientSrc.nom || devis.co || devis.name || '',
      adresse: clientSrc.adresse || devis.addr || '',
      siret,
      // Le SIREN est les neuf premiers chiffres du SIRET : une identité, pas une
      // inférence. Rien n'est composé si le SIRET n'a pas ses quatorze chiffres.
      siren: clientSrc.siren || (siret.length === 14 ? siret.slice(0, 9) : ''),
      email: clientSrc.email || devis.email || ''
    }

    const facturePayload = {
      ...devis,
      userId,
      id: undefined,
      type: 'facture',
      numero, numero_seq: seq, numero_year: year,
      client,
      lignes,
      total_ht: totalHt,
      montant_tva: montantTva,
      total_ttc: totalTtc,
      tva_applicable: tvaApplicable,
      taux_tva: tauxDevis,
      mention_tva: tvaApplicable ? '' : 'TVA non applicable, art. 293 B du CGI',
      devis_id: devis.id,
      devis_origine_id: devis.id,
      statut: 'en_attente',
      date_emission: now.slice(0, 10),
      created_at: now,
      updated_at: now
    }
    delete facturePayload.id
    // Champs du devis qui mentiraient sur la facture : `num` doublerait `numero`
    // avec le numéro du DEVIS, `status` doublerait `statut` avec 'accepted',
    // `conversion_at` n'a de sens que sur le devis réservé.
    delete facturePayload.num
    delete facturePayload.status
    delete facturePayload.conversion_at

    let created = null
    try {
      const result = await db.query('CREATE facture CONTENT $body', { body: facturePayload })
      created = result[0]?.[0] || result[0] || null
    } catch (createErr) {
      // Réservation relâchée : sans cela le devis resterait converti à vide et
      // aucune reprise ne serait possible.
      await db.query('UPDATE type::record("devis", $id) SET conversion_at = NONE', { id: devisId })
        .catch(() => {})
      throw createErr
    }

    // Marque le devis transformé
    await db.query('UPDATE type::record("devis", $id) SET statut = "accepte", facture_id = $fid, updated_at = $now',
      { id: devisId, fid: created?.numero || numero, now })

    res.status(201).json(created)
  } catch (err) {
    console.error('[factures:from-devis]', err.message)
    res.status(500).json({ error: 'Conversion devis → facture impossible' })
  }
})

// ── FRAIS ──
app.get('/api/frais', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    res.json(await queryOrEmpty(db, 'SELECT * FROM frais WHERE userId = $userId ORDER BY date DESC, createdAt DESC', { userId }))
  } catch (err) {
    console.error('[frais:list]', err.message)
    res.status(500).json({ error: 'Lecture frais impossible' })
  }
})

app.get('/api/frais/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const id = cleanRecordId('frais', req.params.id) || req.params.id
    const rec = (await queryOrEmpty(db, 'SELECT * FROM type::record("frais", $id)', { id }))[0]
    if (!rec || rec.userId !== userId) return res.status(404).json({ error: 'Frais introuvable' })
    res.json(rec)
  } catch (err) {
    console.error('[frais:get]', err.message)
    res.status(500).json({ error: 'Lecture frais impossible' })
  }
})

app.post('/api/frais', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const body = { ...(req.body || {}), userId }
    const now = new Date().toISOString()
    if (!body.createdAt) body.createdAt = now
    body.updatedAt = now
    const cleanId = cleanRecordId('frais', body.id)
    if (cleanId) {
      const { record, status } = await upsertRecord(db, 'frais', cleanId, body)
      return res.status(status).json(record)
    }
    const result = await db.query('CREATE frais CONTENT $body', { body })
    res.status(201).json(result[0]?.[0] || result[0] || null)
  } catch (err) {
    console.error('[frais:post]', err.message)
    res.status(500).json({ error: 'Enregistrement frais impossible' })
  }
})

app.put('/api/frais/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const id = cleanRecordId('frais', req.params.id) || req.params.id
    const existing = await db.query('SELECT * FROM type::record("frais", $id)', { id })
    const rec = existing[0]?.[0]
    if (!rec || rec.userId !== userId) return res.status(404).json({ error: 'Frais introuvable' })
    const cleanBody = { ...(req.body || {}) }
    delete cleanBody.id
    cleanBody.userId = userId
    cleanBody.updatedAt = new Date().toISOString()
    const result = await db.query('UPDATE type::record("frais", $id) CONTENT $body', { id, body: cleanBody })
    res.json(result[0]?.[0] || result[0] || {})
  } catch (err) {
    console.error('[frais:put]', err.message)
    res.status(500).json({ error: 'Mise à jour frais impossible' })
  }
})

app.delete('/api/frais/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const id = cleanRecordId('frais', req.params.id) || req.params.id
    const existing = await db.query('SELECT * FROM type::record("frais", $id)', { id })
    const rec = existing[0]?.[0]
    if (!rec || rec.userId !== userId) return res.status(404).json({ error: 'Frais introuvable' })
    await db.query('DELETE type::record("frais", $id)', { id })
    res.json({ ok: true })
  } catch (err) {
    console.error('[frais:delete]', err.message)
    res.status(500).json({ error: 'Suppression frais impossible' })
  }
})

// ── FRAIS RÉCURRENTS ──
app.get('/api/frais-recurrents', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    res.json(await queryOrEmpty(db, 'SELECT * FROM frais_recurrents WHERE userId = $userId ORDER BY createdAt DESC', { userId }))
  } catch (err) {
    console.error('[frais-recurrents:list]', err.message)
    res.status(500).json({ error: 'Lecture frais récurrents impossible' })
  }
})

app.get('/api/frais-recurrents/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const id = cleanRecordId('frais_recurrents', req.params.id) || req.params.id
    const rec = (await queryOrEmpty(db, 'SELECT * FROM type::record("frais_recurrents", $id)', { id }))[0]
    if (!rec || rec.userId !== userId) return res.status(404).json({ error: 'Frais récurrent introuvable' })
    res.json(rec)
  } catch (err) {
    console.error('[frais-recurrents:get]', err.message)
    res.status(500).json({ error: 'Lecture frais récurrent impossible' })
  }
})

app.post('/api/frais-recurrents', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const body = { ...(req.body || {}), userId }
    const now = new Date().toISOString()
    if (!body.createdAt) body.createdAt = now
    body.updatedAt = now
    const cleanId = cleanRecordId('frais_recurrents', body.id)
    if (cleanId) {
      const { record, status } = await upsertRecord(db, 'frais_recurrents', cleanId, body)
      return res.status(status).json(record)
    }
    const result = await db.query('CREATE frais_recurrents CONTENT $body', { body })
    res.status(201).json(result[0]?.[0] || result[0] || null)
  } catch (err) {
    console.error('[frais-recurrents:post]', err.message)
    res.status(500).json({ error: 'Enregistrement frais récurrent impossible' })
  }
})

app.put('/api/frais-recurrents/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const id = cleanRecordId('frais_recurrents', req.params.id) || req.params.id
    const existing = await db.query('SELECT * FROM type::record("frais_recurrents", $id)', { id })
    const rec = existing[0]?.[0]
    if (!rec || rec.userId !== userId) return res.status(404).json({ error: 'Frais récurrent introuvable' })
    const cleanBody = { ...(req.body || {}) }
    delete cleanBody.id
    cleanBody.userId = userId
    cleanBody.updatedAt = new Date().toISOString()
    const result = await db.query('UPDATE type::record("frais_recurrents", $id) CONTENT $body', { id, body: cleanBody })
    res.json(result[0]?.[0] || result[0] || {})
  } catch (err) {
    console.error('[frais-recurrents:put]', err.message)
    res.status(500).json({ error: 'Mise à jour frais récurrent impossible' })
  }
})

app.delete('/api/frais-recurrents/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const id = cleanRecordId('frais_recurrents', req.params.id) || req.params.id
    const existing = await db.query('SELECT * FROM type::record("frais_recurrents", $id)', { id })
    const rec = existing[0]?.[0]
    if (!rec || rec.userId !== userId) return res.status(404).json({ error: 'Frais récurrent introuvable' })
    await db.query('DELETE type::record("frais_recurrents", $id)', { id })
    res.json({ ok: true })
  } catch (err) {
    console.error('[frais-recurrents:delete]', err.message)
    res.status(500).json({ error: 'Suppression frais récurrent impossible' })
  }
})

// ── USER SETTINGS ── (1 record par user, partagé Frais/Statistiques)
// PUT en MERGE pour que Frais et Statistiques cohabitent sans s'écraser.
app.get('/api/user-settings', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const rec = (await queryOrEmpty(db, 'SELECT * FROM type::record("user_settings", $id)', { id: userId }))[0]
    if (!rec) return res.json({ tvaAssujetti: false, formeJuridique: '', siret: '' })
    res.json(rec)
  } catch (err) {
    console.error('[user-settings:get]', err.message)
    res.status(500).json({ error: 'Lecture user settings impossible' })
  }
})

app.put('/api/user-settings', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const cleanBody = { ...(req.body || {}) }
    delete cleanBody.id
    cleanBody.userId = userId
    cleanBody.updatedAt = new Date().toISOString()
    const sel = await db.query('SELECT * FROM type::record("user_settings", $id)', { id: userId })
    const exists = sel[0]?.[0]
    if (exists) {
      const r = await db.query('UPDATE type::record("user_settings", $id) MERGE $body', { id: userId, body: cleanBody })
      return res.status(200).json(r[0]?.[0] || r[0] || null)
    }
    const r = await db.query('CREATE type::record("user_settings", $id) CONTENT $body', { id: userId, body: cleanBody })
    res.status(201).json(r[0]?.[0] || r[0] || null)
  } catch (err) {
    console.error('[user-settings:put]', err.message)
    res.status(500).json({ error: 'Mise à jour user settings impossible' })
  }
})

// ── MÉTÉO — position de l'abonné ──
// Rend la position sur laquelle le composant météo interrogera Open-Meteo, et
// la SOURCE dont elle vient, pour que l'affichage puisse la nommer et signaler
// un repli. La cascade est dans server/services/meteo-position.js : c'est là
// que se lit la doctrine, pas ici.
//
// LECTURE SEULE, y compris sur geo_data : cette route n'écrit rien et ne
// déclenche aucune géolocalisation d'adresse réseau. Elle relit ce qui est en
// base. Réponse 200 même sans position connue — { source: null } n'est pas une
// erreur, c'est un état légitime que la page sait rendre (invitation à
// renseigner l'adresse de départ).
app.get('/api/meteo/position', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    // req.authUser est le record user complet posé par requireAuth : ville,
    // code_postal, lat, lng et geo_data y sont déjà, aucune relecture à faire.
    const db = await getDb()
    const settings = (await queryOrEmpty(
      db, 'SELECT homeAddress, homeLat, homeLon FROM type::record("user_settings", $id)', { id: userId }))[0] || null
    const pos = await resoudrePositionMeteo({ user: req.authUser, settings })
    res.json(pos)
  } catch (err) {
    console.error('[meteo:position]', err.message)
    res.status(500).json({ error: 'Position indisponible' })
  }
})

// ── USER PLAN ── (1 record par user, défaut "gratuit" si absent)
// LECTURE SEULE côté HTTP : le GET ci-dessous sert les compteurs, le PUT est
// fermé en 405 (voir la note au-dessus du handler).

// applyMonthlyReset + firstOfMonthIsoUTC déplacés dans
// server/config/plan-quotas.js (source unique des quotas leads). Importés
// en tête de fichier. Les callers ci-dessous restent inchangés (même
// signature, même comportement).

app.get('/api/user-plan', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const user = req.authUser
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    const db = await getDb()
    const rec = (await queryOrEmpty(db, 'SELECT * FROM type::record("user_plan", $id)', { id: userId }))[0]
    const limit = getLeadLimit(user)
    if (!rec) return res.json({
      userId, plan: 'gratuit', leadsConsumed: 0, leadsConsumedThisMonth: 0,
      lastResetDate: null,
      quotaLimit: limit === Infinity ? null : limit
    })
    const fresh = await applyMonthlyReset(db, userId, rec, user)
    res.json({ ...fresh, quotaLimit: limit === Infinity ? null : limit })
  } catch (err) {
    console.error('[user-plan:get]', err.message)
    res.status(500).json({ error: 'Lecture user plan impossible' })
  }
})

// FERMÉE EN ÉCRITURE. Le MERGE précédent recopiait le body verbatim (seul
// 'plan' était filtré en 422) : un PUT { leadsConsumedThisMonth: 0 } remettait
// le compteur de quota à zéro, un lastResetDate posé neutralisait le reset
// mensuel, un enrichedSirets: [] effaçait l'idempotence d'enrichissement.
// Trois portes dérobées ouvertes à tout utilisateur authentifié, sur le record
// qui porte précisément les compteurs que le gate quota doit faire respecter.
//
// Aucune liste blanche ici : l'ensemble des champs légitimement posables par le
// client est VIDE. Cette route n'avait plus aucun appelant en écriture depuis la
// suppression de la modale plan (étape C2) — la branche saveJSON('mup_user_plan')
// de statistiques.html n'était elle-même jamais appelée.
//
// Les écritures légitimes sur user_plan passent toutes hors HTTP :
//   - reset mensuel      → applyMonthlyReset (server/config/plan-quotas.js)
//   - marquage enrichi   → markEnriched      (server/config/plan-quotas.js)
//   - plan               → webhooks Stripe / signup
app.put('/api/user-plan', (req, res) => res.status(405).json({
  error: 'method_not_allowed',
  message: 'Cette route n\'accepte plus d\'écriture. Les compteurs sont gouvernés par le serveur.'
}))

// Squelette V1 : retourne toujours allowed:true tant que les paliers ne sont pas validés.
// Quand PLAN_QUOTAS sera rempli, activer la logique allowed = quotaUsed < quotaLimit ici.
app.post('/api/user-plan/check-quota', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const user = req.authUser
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    const db = await getDb()
    const result = await db.query('SELECT * FROM type::record("user_plan", $id)', { id: userId })
    const rec = result[0]?.[0] || { userId, plan: 'gratuit', leadsConsumed: 0, leadsConsumedThisMonth: 0, lastResetDate: null }
    const consumed = await getLeadsConsumed(db, userId, rec, user)
    const limit = getLeadLimit(user)
    const plan = getEffectivePlan(user)
    res.json({
      allowed: consumed < limit,
      plan,
      quotaUsed: consumed,
      quotaLimit: limit === Infinity ? null : limit,
      quotaPeriod: plan === 'essai' ? 'essai' : 'monthly',
      upgradeUrl: '/account/billing'
    })
  } catch (err) {
    console.error('[user-plan:check-quota]', err.message)
    res.status(500).json({ error: 'Vérification quota impossible' })
  }
})

app.get('/api/user-plan-history', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 50)
    res.json(await queryOrEmpty(
      db,
      'SELECT * FROM user_plan_history WHERE userId = $userId ORDER BY changed_at DESC LIMIT $limit',
      { userId, limit }
    ))
  } catch (err) {
    console.error('[user-plan-history:list]', err.message)
    res.status(500).json({ error: 'Lecture historique plan impossible' })
  }
})

// ── /api/v2/mail/* ── (refonte mail double track : Track 1 OAuth/IMAP, Track 2 Resend)
// Session 1 : seules les routes IMAP fallback sont implémentées.
// OAuth Google/Microsoft = sessions 2/3, Resend = sessions 6-8.

// Status général de la boîte mail du user (UI mail.html consomme).
app.get('/api/v2/mail/status', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const status = await mailServiceStatus(db, userId)
    res.json(status)
  } catch (err) {
    console.error('[v2/mail:status]', err.message)
    res.status(500).json({ error: 'Lecture statut mail impossible' })
  }
})

// Test la connexion IMAP+SMTP avant sauvegarde. Body : { email, password, imap_host, imap_port,
// imap_secure, smtp_host, smtp_port, smtp_secure }. Renvoie { imap_ok, smtp_ok, errors }.
app.post('/api/v2/mail/imap/test', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  if (!isCryptoReady()) return res.status(503).json({ error: 'Mail non configuré sur le serveur — SECRET_KEY absente' })
  const { email, password, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure } = req.body || {}
  if (!email || !password || !imap_host || !smtp_host) {
    return res.status(400).json({ error: 'Champs requis : email, password, imap_host, smtp_host' })
  }
  const errors = {}
  let imap_ok = false, smtp_ok = false
  try {
    const client = new ImapFlow({
      host: imap_host,
      port: Number(imap_port || 993),
      secure: imap_secure !== false,
      auth: { user: email, pass: password },
      logger: false
    })
    await client.connect()
    await client.logout()
    imap_ok = true
  } catch (e) {
    errors.imap = e.message
  }
  try {
    const port = Number(smtp_port || 465)
    const transport = nodemailer.createTransport({
      host: smtp_host,
      port,
      secure: smtp_secure !== false && port === 465,
      auth: { user: email, pass: password },
      tls: { rejectUnauthorized: true }
    })
    await transport.verify()
    smtp_ok = true
  } catch (e) {
    errors.smtp = e.message
  }
  res.json({ imap_ok, smtp_ok, errors })
})

// ── Une boîte, et une seule ──
// L'abonné prospecte depuis une boîte : tant qu'elle est connectée, en brancher
// une autre est refusé. Il n'y a pas de remplacement — c'est lui qui déconnecte
// la sienne, par le geste des Paramètres, s'il veut en brancher une autre.
// Rebrancher LA MÊME adresse chez LE MÊME fournisseur n'est pas une autre
// boîte : c'est ce qui répare un jeton expiré, et cela doit rester possible.
// Une boîte IMAP héritée occupe la place au même titre qu'une boîte OAuth.
// Renvoie la boîte qui fait obstacle, ou null quand la voie est libre. Un
// abonné qui en aurait plusieurs — connectées avant cette règle — les garde et
// peut rebrancher chacune : la reconnaissance de la boîte passe AVANT le refus,
// sans quoi aucune des siennes ne serait plus réparable.
async function boiteFaisantObstacle(db, ownerId, { provider, email }) {
  const cible = String(email || '').toLowerCase()
  const memeBoite = b => b.provider === provider && String(b.email || '').toLowerCase() === cible
  const creds = await listMailboxCredentials(db, ownerId)
  const boites = creds.map(c => ({ provider: c.provider, email: c.email }))
  const imap = await getImapAccount(db, ownerId)
  if (imap) boites.push({ provider: 'imap', email: imap.email })
  if (boites.some(memeBoite)) return null
  return boites[0] || null
}

// Le motif dit ce qui occupe la place et le geste qui la libère. Il part tel
// quel à l'abonné — aucun détail technique dedans.
function motifBoiteOccupee(obstacle) {
  return 'Une autre boîte est déjà connectée (' + obstacle.email + '). '
    + 'Déconnectez-la dans Mail › Paramètres avant d\'en connecter une autre.'
}

// Retour des callbacks quand la place est prise. Canal à part, et c'est tout
// son objet : passer par <fournisseur>_error ferait lire « Erreur Google » un
// refus qui vient de MovUP, et enverrait l'abonné chercher une panne chez un
// fournisseur qui n'a rien refusé. Ne voyage que l'adresse qui occupe la
// place ; la phrase est écrite par la page, qui n'attribue rien à personne.
function retourBoiteOccupee(obstacle) {
  return '/mail.html?boite_occupee=' + encodeURIComponent(obstacle.email || '')
}

// Sauvegarde la config IMAP du user (chiffrement password). Body identique à imap/test.
// Stockage dans mail_settings:userId (réutilise la table existante, schéma SCHEMALESS).
app.post('/api/v2/mail/imap/connect', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  if (!isCryptoReady()) return res.status(503).json({ error: 'Mail non configuré sur le serveur — SECRET_KEY absente' })
  const { email, password, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, provider_hint } = req.body || {}
  if (!email || !password || !imap_host || !smtp_host) {
    return res.status(400).json({ error: 'Champs requis : email, password, imap_host, smtp_host' })
  }
  try {
    const db = await getDb()
    // Rien n'est écrit tant qu'une autre boîte occupe la place. Le contrôle
    // vaut aussi ici : mail_settings est classé par abonné, une adresse
    // différente écraserait silencieusement celle qui s'y trouve.
    const obstacle = await boiteFaisantObstacle(db, userId, { provider: 'imap', email })
    if (obstacle) return res.status(409).json({ code: 'boite_deja_connectee', error: motifBoiteOccupee(obstacle) })
    const payload = {
      userId,
      email,
      provider: 'imap',
      provider_hint: provider_hint || null,
      imap_host,
      imap_port: Number(imap_port || 993),
      imap_secure: imap_secure !== false,
      imap_user: email,
      imap_password_encrypted: encrypt(password),
      smtp_host,
      smtp_port: Number(smtp_port || 465),
      smtp_secure: smtp_secure !== false,
      smtp_pass_encrypted: encrypt(password),
      needs_reconnect: false,
      updated_at: new Date().toISOString()
    }
    const sel = await db.query('SELECT * FROM type::record("mail_settings", $id)', { id: userId })
    if (sel[0]?.[0]) {
      const r = await db.query('UPDATE type::record("mail_settings", $id) MERGE $body', { id: userId, body: payload })
      return res.status(200).json({ ok: true, provider: 'imap', email, record: stripMailboxSecrets(r[0]?.[0] || null) })
    }
    payload.created_at = new Date().toISOString()
    const r = await db.query('CREATE type::record("mail_settings", $id) CONTENT $body', { id: userId, body: payload })
    res.status(201).json({ ok: true, provider: 'imap', email, record: stripMailboxSecrets(r[0]?.[0] || null) })
  } catch (err) {
    console.error('[v2/mail:imap-connect]', err.message)
    res.status(500).json({ error: 'Sauvegarde config IMAP impossible' })
  }
})

// Déconnecte la boîte mail du user — supprime le record mail_settings.
app.post('/api/v2/mail/disconnect', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    await db.query('DELETE type::record("mail_settings", $id)', { id: userId })
    res.json({ ok: true })
  } catch (err) {
    console.error('[v2/mail:disconnect]', err.message)
    res.status(500).json({ error: 'Déconnexion impossible' })
  }
})

// Renvoie l'adresse d'expédition si elle est bien à cet abonné, sinon null.
// Trois sources et pas une de plus : ses comptes OAuth, sa boîte IMAP, et les
// domaines qu'il a fait vérifier — une adresse d'un domaine vérifié lui
// appartient autant qu'une boîte connectée. La comparaison ignore la casse,
// qu'une adresse ne distingue pas. Les deux premières sources rendent la
// valeur telle qu'elle est en base ; la troisième rend l'adresse demandée,
// dont le domaine — seul élément qui engage l'abonné — a été autorisé.
const FORME_ADRESSE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
async function allowedSenderEmail(db, ownerId, wanted) {
  const cible = String(wanted || '').trim().toLowerCase()
  if (!cible) return null
  const creds = await listMailboxCredentials(db, ownerId)
  const match = creds.find(c => String(c.email || '').toLowerCase() === cible)
  if (match) return match.email
  const imap = await getImapAccount(db, ownerId)
  if (imap && String(imap.email || '').toLowerCase() === cible) return imap.email
  if (FORME_ADRESSE.test(cible) && await isVerifiedResendSender(db, ownerId, cible)) return cible
  return null
}

// Un message parti par Resend ne passe par aucun serveur de l'abonné : son
// fournisseur ne l'a pas vu, et le dossier Envoyés de sa boîte ne le contiendra
// jamais. C'est le seul cas où MUP doit garder le message, sans quoi il
// n'existe nulle part. Ce que le fournisseur connaît déjà n'est pas réécrit
// ici : pas de doublon possible, donc pas de rapprochement à inventer.
// Le format reprend celui de la table mail (direction, from, to, subject,
// body_text, date, status) et ajoute transport, qui isole ces enregistrements
// de tous les autres.
async function traceEnvoiResend(db, userId, { from, to, subject, body, html, messageId }) {
  const maintenant = new Date().toISOString()
  const cle = messageId || `resend_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const record = {
    userId,
    direction: 'sent',
    transport: 'resend',
    prospectId: null,
    from: from || '',
    to: Array.isArray(to) ? to.join(', ') : String(to || ''),
    cc: '',
    subject: subject || '',
    body_html: html || '',
    body_text: body || '',
    date: maintenant,
    messageId: messageId || '',
    status: 'sent',
    attachments: []
  }
  await upsertRecord(db, 'mail', hashMessageId(cle), record)
}

// Envoi 1:1 — utilise mail-service.js (route sur le bon provider).
// Session 1 : seul provider:'imap' fonctionne.
app.post('/api/v2/mail/send', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  const { to, subject, body, html, attachments, from_email } = req.body || {}
  if (!to || !subject) return res.status(400).json({ error: 'Champs requis : to, subject' })
  try {
    const db = await getDb()
    // L'expéditeur choisi ne peut désigner qu'une adresse que l'abonné possède
    // déjà : il est vérifié contre ses propres comptes et ses propres domaines,
    // jamais cru sur parole. Absent, le service choisit comme avant.
    let expediteur = null
    if (from_email) {
      expediteur = await allowedSenderEmail(db, userId, from_email)
      if (!expediteur) {
        return res.status(403).json({ error: 'Cette adresse d\'expédition n\'est ni l\'une de vos boîtes connectées ni un domaine que vous avez fait vérifier' })
      }
    }
    // ── La signature s'appose ICI, et non dans sendOne ──
    // sendOne est un service : un futur appelant y hériterait de la signature
    // sans l'avoir demandée. Les campagnes, notamment, ne doivent jamais la
    // porter — ce sont des envois de masse, pas des messages écrits par
    // l'abonné. Cette route est le seul endroit du serveur où un message est
    // rédigé par un humain, donc le seul où la signature a un sens.
    //
    // L'identité est celle que reçoit sendOne, et pas une autre : le message
    // part de la boîte de `userId`, il doit porter la signature de `userId`.
    // Les deux ne peuvent pas diverger, sans quoi un message partirait d'une
    // boîte signé du nom d'un autre. Derrière le portillon /api/*, requireAuth
    // pose req.session.userId, que getUserId lit en tête de sa chaîne : la
    // valeur EST celle de la session, la même sous laquelle les routes de
    // signature écrivent.
    //
    // UNE SIGNATURE QUI NE SE CHARGE PAS NE RETIENT PAS LE MESSAGE. Il part
    // sans elle, et l'échec se lit dans les journaux. Un message qui ne part
    // pas est pire qu'un message sans signature — c'est la doctrine déjà
    // appliquée à la trace d'envoi qui ne s'écrit pas, quelques lignes plus
    // bas. Le repli n'a rien à rétablir : l'affectation n'a pas lieu si l'appel
    // jette, si bien que le message d'origine est toujours là, intact. Rien ne
    // peut être apposé à moitié — apposeSignature ne rend qu'un triple complet.
    let aEnvoyer = { body, html, attachments }
    try {
      aEnvoyer = await apposeSignature(db, userId, aEnvoyer)
    } catch (e) {
      console.error('[v2/mail:send] signature non apposée, message envoyé sans elle —', e.message)
    }
    const result = await mailServiceSendOne(db, userId, {
      to,
      subject,
      body: aEnvoyer.body,
      html: aEnvoyer.html,
      attachments: aEnvoyer.attachments,
      from_email: expediteur
    })
    // Le message est parti : une trace qui ne s'écrit pas ne doit pas le faire
    // passer pour perdu. L'échec se lit dans les journaux, l'abonné garde sa
    // confirmation d'envoi.
    //
    // La trace porte le message APPOSÉ, pas celui saisi. Elle existe parce que
    // ce message n'existe nulle part ailleurs : y consigner autre chose que ce
    // qui est parti la viderait de sa raison d'être. Le logo y voyage en
    // référence cid: sans la pièce qui la résout — la relecture d'un envoi
    // Resend signé montre donc la signature avec une image absente. Réparer
    // cela demande de toucher la lecture, hors de cette passe.
    if (result?.provider === 'resend') {
      try {
        await traceEnvoiResend(db, userId, {
          from: result.from || expediteur, to, subject,
          body: aEnvoyer.body, html: aEnvoyer.html, messageId: result.messageId
        })
      } catch (e) {
        console.error('[v2/mail:send] envoi remis mais trace non écrite —', e.message)
      }
    }
    res.json(result)
  } catch (err) {
    console.error('[v2/mail:send]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── OAuth Google (Track 1 — boîte personnelle Gmail) ──

import('./lib/oauth-google.js')  // pre-warm import (no-op)
  .catch((err) => console.error('[oauth-google] pre-warm import échoué:', err?.message))

// SEC 1 — dérive l'ownerId de la session vérifiée (cookie mup_session) et non
// de requireUserId (spoofable via header/query/body). Fail-closed : 401 si pas
// de session valide. Utilisé par les flux OAuth Google et Microsoft, qui
// écrivent des mailbox_credentials liées à cet ownerId.
async function requireSessionOwnerId(req, res) {
  const token = readSessionToken(req)
  if (!token) { res.status(401).json({ error: 'Authentification requise' }); return null }
  const session = await getSession(token)
  if (!session) { res.status(401).json({ error: 'Session invalide ou expirée' }); return null }
  return String(session.user_id).replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')
}

// ── Disponibilité des fournisseurs OAuth de boîte mail ──
// La page mail interroge cette route AVANT d'envoyer le navigateur sur
// /auth/<fournisseur> : non configuré, celui-ci répond 503 en pleine page, donc
// hors de l'application. Ne renvoie qu'un booléen par fournisseur — jamais les
// identifiants, ni le détail des variables d'environnement manquantes.
//
// S'y ajoute googleAppVerified, qui ne dit rien de la configuration mais de
// l'état de notre dossier chez Google : tant que la validation n'a pas abouti,
// Google intercale un écran d'avertissement entre le clic et le consentement.
// La page s'en sert pour préparer l'abonné à cet écran. Le jour où la
// validation aboutit, poser GOOGLE_APP_VERIFIED=true suffit à retirer la
// préparation — l'absence de variable vaut « pas encore validée ».
app.get('/api/mail/oauth-providers', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const { isGoogleReady } = await import('./lib/oauth-google.js')
    const { isMicrosoftReady } = await import('./lib/oauth-microsoft.js')
    const verified = String(process.env.GOOGLE_APP_VERIFIED || '').trim().toLowerCase()
    res.json({
      google: isGoogleReady(),
      microsoft: isMicrosoftReady(),
      googleAppVerified: verified === 'true' || verified === '1'
    })
  } catch (err) {
    console.error('[oauth-providers]', err.message)
    res.status(500).json({ error: 'Disponibilité des fournisseurs indisponible' })
  }
})

app.get('/auth/google', async (req, res) => {
  const ownerId = await requireSessionOwnerId(req, res)
  if (!ownerId) return
  try {
    const { isGoogleReady, signState, generateAuthUrl } = await import('./lib/oauth-google.js')
    if (!isGoogleReady()) return res.status(503).json({ error: 'OAuth Google non configuré (variables GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI manquantes)' })
    const state = signState({ ownerId, companyId: req.query.companyId || null })
    const url = generateAuthUrl(state)
    res.redirect(302, url)
  } catch (err) {
    console.error('[oauth-google:start]', err.message)
    res.status(500).json({ error: 'Démarrage OAuth Google impossible' })
  }
})

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { isGoogleReady, verifyState, exchangeCode, fetchUserInfo, revokeRefreshToken } = await import('./lib/oauth-google.js')
    const { encryptMailToken, isMailCryptoReady } = await import('./lib/crypto.js')
    if (!isGoogleReady()) return res.status(503).send('OAuth Google non configuré')
    if (!isMailCryptoReady()) return res.status(503).send('MAIL_ENCRYPTION_KEY/SECRET_KEY manquante')

    const { code, state, error: googleErr } = req.query
    if (googleErr) return res.redirect(302, '/mail.html?google_error=' + encodeURIComponent(String(googleErr)))
    if (!code || !state) return res.status(400).send('code/state manquants')
    const claims = verifyState(String(state))
    if (!claims) return res.status(401).send('state JWT invalide ou expiré (>10 min)')

    const tokens = await exchangeCode(String(code))
    if (!tokens.refresh_token) {
      return res.redirect(302, '/mail.html?google_error=' + encodeURIComponent('Aucun refresh_token reçu — révoquer l\'app dans les paramètres Google et réessayer'))
    }
    const userInfo = await fetchUserInfo(tokens)
    if (!userInfo?.email) return res.status(502).send('Email utilisateur introuvable via Google API')
    const email = userInfo.email

    const db = await getDb()
    // Une boîte, et une seule. Le refus est ici parce que la page peut être
    // contournée, pas le callback : l'abonné repart sans qu'aucune credential
    // n'ait été créée, ramené dans l'application — jamais sur du JSON brut.
    // Le jeton qu'on vient d'obtenir n'étant pas conservé, on le révoque : rien
    // ne doit rester ouvert côté Google au nom d'une connexion refusée.
    const obstacle = await boiteFaisantObstacle(db, claims.ownerId, { provider: 'google', email })
    if (obstacle) {
      await revokeRefreshToken(tokens.refresh_token)
      return res.redirect(302, retourBoiteOccupee(obstacle))
    }
    const recordId = mailboxCredentialId(claims.ownerId, 'google', email)
    const now = new Date().toISOString()
    const payload = {
      ownerId: claims.ownerId,
      companyId: claims.companyId || null,
      provider: 'google',
      email,
      userName: userInfo.name || null,
      givenName: userInfo.given_name || null,
      accessToken: encryptMailToken(tokens.access_token),
      refreshToken: encryptMailToken(tokens.refresh_token),
      tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      scope: tokens.scope || null,
      updatedAt: now
    }
    const sel = await db.query('SELECT * FROM type::record("mailbox_credentials", $id)', { id: recordId })
    if (sel[0]?.[0]) {
      await db.query('UPDATE type::record("mailbox_credentials", $id) MERGE $body', { id: recordId, body: payload })
    } else {
      payload.createdAt = now
      await db.query('CREATE type::record("mailbox_credentials", $id) CONTENT $body', { id: recordId, body: payload })
    }

    // Welcome email auto via Resend (idempotent — skip si welcomeEmailSentAt déjà set).
    // try/catch — un échec d'envoi ne casse pas le flow OAuth.
    try {
      if (isResendReady()) {
        const result = await sendWelcomeEmail(db, {
          ownerId: claims.ownerId,
          companyId: claims.companyId || null,
          provider: 'google',
          userEmail: email,
          userName: userInfo.given_name || userInfo.name || null
        })
        if (result.sent) console.log('[oauth-google:welcome] envoyé pour', email)
        else if (result.skipped) console.log('[oauth-google:welcome] skip (' + result.reason + ') pour', email)
      } else {
        console.warn('[oauth-google:welcome] RESEND_API_KEY absente, welcome non envoyé')
      }
    } catch (e) {
      console.warn('[oauth-google:welcome] erreur (non bloquante) :', e.message)
    }

    res.redirect(302, '/mail.html?google_connected=1&email=' + encodeURIComponent(email))
  } catch (err) {
    console.error('[oauth-google:callback]', err.message)
    res.redirect(302, '/mail.html?google_error=' + encodeURIComponent(err.message || 'Erreur OAuth Google'))
  }
})

app.post('/auth/google/disconnect', async (req, res) => {
  const ownerId = await requireSessionOwnerId(req, res)
  if (!ownerId) return
  const { email } = req.body || {}
  if (!email) return res.status(400).json({ error: 'email requis' })
  try {
    const db = await getDb()
    const recordId = mailboxCredentialId(ownerId, 'google', email)
    const sel = await db.query('SELECT * FROM type::record("mailbox_credentials", $id)', { id: recordId })
    const cred = sel[0]?.[0]
    if (!cred || cred.ownerId !== ownerId) return res.status(404).json({ error: 'Compte introuvable' })

    // Révocation côté Google (best effort)
    try {
      const { decryptMailToken } = await import('./lib/crypto.js')
      const { revokeRefreshToken, isGoogleReady } = await import('./lib/oauth-google.js')
      if (isGoogleReady() && cred.refreshToken) {
        const refreshToken = decryptMailToken(cred.refreshToken)
        await revokeRefreshToken(refreshToken)
      }
    } catch (e) {
      console.warn('[oauth-google:revoke] échec révocation côté Google :', e.message)
    }

    await db.query('DELETE type::record("mailbox_credentials", $id)', { id: recordId })
    res.status(204).end()
  } catch (err) {
    console.error('[oauth-google:disconnect]', err.message)
    res.status(500).json({ error: 'Déconnexion impossible' })
  }
})

// ── OAuth Microsoft (Track 1 — boîte personnelle Outlook / Microsoft 365) ──
// Miroir des routes Google. ownerId dérivé de la session vérifiée (SEC 1).

app.get('/auth/microsoft', async (req, res) => {
  const ownerId = await requireSessionOwnerId(req, res)
  if (!ownerId) return
  try {
    const { isMicrosoftReady, signState, generateAuthUrl } = await import('./lib/oauth-microsoft.js')
    if (!isMicrosoftReady()) return res.status(503).json({ error: 'OAuth Microsoft non configuré (variables MICROSOFT_CLIENT_ID/SECRET/REDIRECT_URI manquantes)' })
    const state = signState({ ownerId, companyId: req.query.companyId || null })
    const url = generateAuthUrl(state)
    res.redirect(302, url)
  } catch (err) {
    console.error('[oauth-microsoft:start]', err.message)
    res.status(500).json({ error: 'Démarrage OAuth Microsoft impossible' })
  }
})

app.get('/auth/microsoft/callback', async (req, res) => {
  try {
    const { isMicrosoftReady, verifyState, exchangeCode, fetchUserInfo } = await import('./lib/oauth-microsoft.js')
    const { encryptMailToken, isMailCryptoReady } = await import('./lib/crypto.js')
    if (!isMicrosoftReady()) return res.status(503).send('OAuth Microsoft non configuré')
    if (!isMailCryptoReady()) return res.status(503).send('MAIL_ENCRYPTION_KEY/SECRET_KEY manquante')

    const { code, state, error: msErr } = req.query
    if (msErr) return res.redirect(302, '/mail.html?microsoft_error=' + encodeURIComponent(String(msErr)))
    if (!code || !state) return res.status(400).send('code/state manquants')
    const claims = verifyState(String(state))
    if (!claims) return res.status(401).send('state JWT invalide ou expiré (>10 min)')

    const tokens = await exchangeCode(String(code))
    if (!tokens.refresh_token) {
      return res.redirect(302, '/mail.html?microsoft_error=' + encodeURIComponent('Aucun refresh_token reçu — vérifier le scope offline_access et réessayer'))
    }
    const userInfo = await fetchUserInfo(tokens)
    if (!userInfo?.email) return res.status(502).send('Email utilisateur introuvable via Microsoft Graph')
    const email = userInfo.email

    const db = await getDb()
    // Même refus que côté Google, et pour la même raison : le callback est le
    // seul endroit qu'on ne contourne pas. Pas de révocation ici — Microsoft
    // n'expose pas d'endpoint programmatique v2 (cf. /auth/microsoft/disconnect,
    // dont la révocation est un no-op) ; le jeton non conservé expire de
    // lui-même.
    const obstacle = await boiteFaisantObstacle(db, claims.ownerId, { provider: 'microsoft', email })
    if (obstacle) {
      return res.redirect(302, retourBoiteOccupee(obstacle))
    }
    const recordId = mailboxCredentialId(claims.ownerId, 'microsoft', email)
    const now = new Date().toISOString()
    const payload = {
      ownerId: claims.ownerId,
      companyId: claims.companyId || null,
      provider: 'microsoft',
      email,
      userName: userInfo.name || null,
      givenName: userInfo.given_name || null,
      accessToken: encryptMailToken(tokens.access_token),
      refreshToken: encryptMailToken(tokens.refresh_token),
      tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      scope: tokens.scope || null,
      updatedAt: now
    }
    const sel = await db.query('SELECT * FROM type::record("mailbox_credentials", $id)', { id: recordId })
    if (sel[0]?.[0]) {
      await db.query('UPDATE type::record("mailbox_credentials", $id) MERGE $body', { id: recordId, body: payload })
    } else {
      payload.createdAt = now
      await db.query('CREATE type::record("mailbox_credentials", $id) CONTENT $body', { id: recordId, body: payload })
    }

    // Welcome email auto via Resend (idempotent — même logique que Google).
    // try/catch — un échec d'envoi ne casse pas le flow OAuth.
    try {
      if (isResendReady()) {
        const result = await sendWelcomeEmail(db, {
          ownerId: claims.ownerId,
          companyId: claims.companyId || null,
          provider: 'microsoft',
          userEmail: email,
          userName: userInfo.given_name || userInfo.name || null
        })
        if (result.sent) console.log('[oauth-microsoft:welcome] envoyé pour', email)
        else if (result.skipped) console.log('[oauth-microsoft:welcome] skip (' + result.reason + ') pour', email)
      } else {
        console.warn('[oauth-microsoft:welcome] RESEND_API_KEY absente, welcome non envoyé')
      }
    } catch (e) {
      console.warn('[oauth-microsoft:welcome] erreur (non bloquante) :', e.message)
    }

    res.redirect(302, '/mail.html?microsoft_connected=1&email=' + encodeURIComponent(email))
  } catch (err) {
    console.error('[oauth-microsoft:callback]', err.message)
    res.redirect(302, '/mail.html?microsoft_error=' + encodeURIComponent(err.message || 'Erreur OAuth Microsoft'))
  }
})

app.post('/auth/microsoft/disconnect', async (req, res) => {
  const ownerId = await requireSessionOwnerId(req, res)
  if (!ownerId) return
  const { email } = req.body || {}
  if (!email) return res.status(400).json({ error: 'email requis' })
  try {
    const db = await getDb()
    const recordId = mailboxCredentialId(ownerId, 'microsoft', email)
    const sel = await db.query('SELECT * FROM type::record("mailbox_credentials", $id)', { id: recordId })
    const cred = sel[0]?.[0]
    if (!cred || cred.ownerId !== ownerId) return res.status(404).json({ error: 'Compte introuvable' })

    // Révocation côté Microsoft : no-op (pas d'endpoint programmatique v2).
    // Appel conservé pour symétrie avec Google ; le DELETE ci-dessous fait foi.
    try {
      const { revokeRefreshToken, isMicrosoftReady } = await import('./lib/oauth-microsoft.js')
      if (isMicrosoftReady() && cred.refreshToken) {
        await revokeRefreshToken()
      }
    } catch (e) {
      console.warn('[oauth-microsoft:revoke] échec révocation côté Microsoft :', e.message)
    }

    await db.query('DELETE type::record("mailbox_credentials", $id)', { id: recordId })
    res.status(204).end()
  } catch (err) {
    console.error('[oauth-microsoft:disconnect]', err.message)
    res.status(500).json({ error: 'Déconnexion impossible' })
  }
})

// ── Liste tous les comptes mail connectés du user (mailbox_credentials + mail_settings IMAP)
app.get('/api/v2/mail/accounts', async (req, res) => {
  const ownerId = requireUserId(req, res)
  if (!ownerId) return
  try {
    const db = await getDb()
    const oauth = await listMailboxCredentials(db, ownerId)
    // Aplatit (jamais de token retourné — listMailboxCredentials ne sélectionne pas access/refresh)
    const accounts = oauth.map(c => ({
      id: c.id,
      provider: c.provider,
      email: c.email,
      scope: c.scope,
      tokenExpiresAt: c.tokenExpiresAt,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt
    }))
    // Inclut aussi la config IMAP legacy si existe
    const imapStatus = await mailServiceStatus(db, ownerId)
    if (imapStatus.connected && imapStatus.provider === 'imap' && imapStatus.email) {
      accounts.push({ id: `mail_settings:${ownerId}`, provider: 'imap', email: imapStatus.email, legacy: true })
    }
    // Un domaine vérifié dont aucune boîte connectée ne relève n'apparaîtrait
    // nulle part : l'abonné aurait le droit d'en partir sans pouvoir le
    // choisir. Une entrée alors, et une seule — bâtie sur son adresse de
    // connexion, et seulement si elle relève de ce domaine. Elle ne prétend pas
    // être une boîte : sendOnly dit qu'on en part sans jamais y lire.
    const adresseConnexion = String(req.authUser?.email || '').trim()
    const domaineConnexion = domainOf(adresseConnexion)
    if (domaineConnexion && !accounts.some(a => domainOf(a.email) === domaineConnexion)) {
      const verifies = await listVerifiedResendDomains(db, ownerId)
      if (verifies.includes(domaineConnexion)) {
        accounts.push({ id: `resend:${domaineConnexion}`, provider: 'resend', email: adresseConnexion, sendOnly: true })
      }
    }
    res.json(accounts)
  } catch (err) {
    console.error('[v2/mail:accounts]', err.message)
    res.status(500).json({ error: 'Lecture comptes impossible' })
  }
})

// Résout la boîte à lire À PARTIR DE LA SESSION. Le paramètre email ne sert
// qu'à départager plusieurs comptes DÉJÀ possédés par cet abonné
// (listMailboxCredentials filtre sur ownerId) : il ne peut jamais désigner la
// boîte d'un autre. Renvoie null si aucune boîte n'est connectée.
async function resolveMailAccount(db, ownerId, email) {
  const wanted = email ? String(email) : null
  const creds = await listMailboxCredentials(db, ownerId)
  if (wanted) {
    const match = creds.find(c => c.email === wanted)
    if (match) return { provider: match.provider, email: match.email }
  }
  const imap = await getImapAccount(db, ownerId)
  if (imap) return { provider: 'imap', email: imap.email }
  if (creds[0]) return { provider: creds[0].provider, email: creds[0].email }
  return null
}

// Traduit une erreur de lecture en réponse lisible par l'abonné. Le détail
// technique reste dans les logs serveur, jamais dans la réponse.
function sendMailReadError(res, err, tag) {
  console.error(tag, err?.message)
  if (err?.code === 'no_account') {
    return res.status(409).json({ code: 'no_account', error: 'Aucune boîte mail connectée.' })
  }
  if (err?.code === 'unsupported_provider') {
    return res.status(409).json({ code: 'unsupported_provider', error: err.message })
  }
  if (err?.code === 'no_sent_folder') {
    return res.status(409).json({ code: 'no_sent_folder', error: err.message })
  }
  if (err?.code === 'not_found') {
    return res.status(404).json({ code: 'not_found', error: 'Ce message n\'est plus disponible dans votre boîte.' })
  }
  const kind = err?.mailKind || classifyMailError(err)
  // Autorisation manquante — refus du fournisseur (403 de scope) ou consentement
  // enregistré trop étroit. Ce n'est pas une panne : rien ne sert à réessayer.
  // Le message ne promet pas qu'une reconnexion y changerait quelque chose,
  // puisque cela dépend du consentement demandé au moment où elle a lieu.
  if (err?.code === 'scope_insuffisant' || kind === 'scope') {
    return res.status(409).json({
      code: 'scope_insuffisant',
      error: 'MovUP n\'est pas autorisé à modifier les messages de cette boîte.'
    })
  }
  if (kind === 'auth') {
    return res.status(409).json({
      code: 'reconnect_required',
      error: 'Votre boîte a refusé les identifiants enregistrés. Reconnectez-la depuis l\'onglet Paramètres.'
    })
  }
  return res.status(502).json({
    code: 'network',
    error: 'La connexion à votre boîte a échoué. Réessayez dans un instant.'
  })
}

// Les trois fournisseurs de boîte — google, imap, microsoft — se lisent. Ce
// qui tombe ici n'est pas une boîte : un domaine vérifié dont on part sans
// jamais y lire (provider 'resend', sendOnly), ou un mode de connexion qu'on ne
// connaît pas. Message explicite plutôt que liste vide.
function unsupportedProviderError() {
  const err = new Error('La lecture des messages n\'est pas disponible pour ce mode de connexion.')
  err.code = 'unsupported_provider'
  return err
}

// Les envois partis par Resend, en enveloppes, telles que la liste des Envoyés
// les attend. Ceux-là et pas d'autres : ce qui est parti par le fournisseur de
// l'abonné est déjà dans son dossier Envoyés à lui. Aucune clé de
// rapprochement à inventer, aucun doublon possible.
const ENVOIS_RESEND_MAX = 200
async function envoisResendEnveloppes(db, ownerId, plafond) {
  const n = Math.min(Math.max(Number(plafond) || 50, 1), ENVOIS_RESEND_MAX)
  const lignes = await queryOrEmpty(
    db,
    `SELECT * FROM mail WHERE userId = $userId AND transport = "resend" ORDER BY date DESC LIMIT ${n}`,
    { userId: ownerId }
  )
  return lignes.map(r => ({
    id: 'resend:' + String(r.id).replace(/^mail:/, '').replace(/^⟨+|⟩+$/g, ''),
    from: r.from || '',
    to: r.to || '',
    subject: r.subject || '',
    snippet: '',
    date: r.date || null,
    unread: false,
    folder: 'sent',
    transport: 'resend'
  }))
}

// Une seule liste, la plus récente en tête, bornée comme celle du fournisseur.
function fusionEnvoyes(messages, parResend, plafond) {
  if (!parResend.length) return messages
  return messages
    .concat(parResend)
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
    .slice(0, plafond)
}

// Liste les enveloppes d'un dossier (Reçus ou Envoyés). Aucun corps n'est
// rapatrié ici : le corps se charge au clic via /api/v2/mail/message.
app.get('/api/v2/mail/inbox-preview', async (req, res) => {
  const ownerId = requireUserId(req, res)
  if (!ownerId) return
  const { email, limit, query, folder } = req.query
  const wantedFolder = folder === 'sent' ? 'sent' : 'inbox'
  const plafond = Math.min(Math.max(Number(limit) || 50, 1), ENVOIS_RESEND_MAX)
  try {
    const db = await getDb()
    const parResend = wantedFolder === 'sent' ? await envoisResendEnveloppes(db, ownerId, plafond) : []
    const account = await resolveMailAccount(db, ownerId, email)
    if (!account) {
      // Un abonné qui n'écrit que depuis un domaine vérifié n'a pas de boîte à
      // interroger — ses envois existent quand même.
      if (parResend.length) return res.json(parResend)
      return res.status(409).json({ code: 'no_account', error: 'Aucune boîte mail connectée.' })
    }
    if (account.provider === 'google') {
      const messages = await listGoogleMessages(db, ownerId, account.email, {
        limit: limit ? Number(limit) : 25,
        query: query ? String(query) : 'newer_than:7d',
        folder: wantedFolder
      })
      return res.json(fusionEnvoyes(messages, parResend, plafond))
    }
    if (account.provider === 'imap') {
      const messages = await listImapMessages(db, ownerId, {
        folder: wantedFolder,
        limit: limit ? Number(limit) : 50
      })
      return res.json(fusionEnvoyes(messages, parResend, plafond))
    }
    if (account.provider === 'microsoft') {
      // Pas de paramètre query ici : la voie Graph ne pose aucune fenêtre de
      // date, elle lit le dossier tel quel.
      const messages = await listMicrosoftMessages(db, ownerId, account.email, {
        folder: wantedFolder,
        limit: limit ? Number(limit) : 50
      })
      return res.json(fusionEnvoyes(messages, parResend, plafond))
    }
    throw unsupportedProviderError()
  } catch (err) {
    sendMailReadError(res, err, '[v2/mail:inbox-preview]')
  }
})

// Le corps d'un envoi parti par Resend se sert depuis la table mail : aucun
// fournisseur ne l'a jamais eu. Le record est relu sous l'abonné qui le
// demande — l'identifiant d'un autre ne rend rien. Comme les autres corps, il
// part en deux champs : le HTML enregistré tel quel, et son texte pour le repli.
async function corpsEnvoiResend(db, ownerId, recordId) {
  const propre = String(recordId || '').replace(/[^a-zA-Z0-9_-]/g, '')
  const rec = propre
    ? (await queryOrEmpty(db, 'SELECT * FROM type::record("mail", $id)', { id: propre }))[0]
    : null
  if (!rec || String(rec.userId) !== String(ownerId) || rec.transport !== 'resend') {
    const err = new Error('Envoi introuvable')
    err.code = 'not_found'
    throw err
  }
  return {
    id: 'resend:' + propre,
    folder: 'sent',
    from: rec.from || '',
    to: rec.to || '',
    subject: rec.subject || '',
    date: rec.date || null,
    text: rec.body_text || (rec.body_html ? htmlToText(rec.body_html) : ''),
    html: rec.body_html || '',
    attachments: [],
    // Un envoi relu depuis notre base n'a pas de partie en ligne : le HTML
    // stocké est celui qui est parti, ses images y sont déjà des adresses.
    inlineImages: []
  }
}

// Corps d'UN message, chargé au clic. Rend le texte ET le HTML d'origine, non
// retouché : c'est la page qui l'enferme dans un cadre isolé, sans script ni
// accès à la session. Le texte reste le repli quand il n'y a pas de partie HTML.
// Aucune écriture en base, la lecture reste volatile.
app.get('/api/v2/mail/message', async (req, res) => {
  const ownerId = requireUserId(req, res)
  if (!ownerId) return
  const { email, id, folder } = req.query
  if (!id) return res.status(400).json({ error: 'Identifiant de message requis' })
  const wantedFolder = folder === 'sent' ? 'sent' : 'inbox'
  try {
    const db = await getDb()
    if (String(id).startsWith('resend:')) {
      return res.json(await corpsEnvoiResend(db, ownerId, String(id).slice('resend:'.length)))
    }
    const account = await resolveMailAccount(db, ownerId, email)
    if (!account) {
      return res.status(409).json({ code: 'no_account', error: 'Aucune boîte mail connectée.' })
    }
    if (account.provider === 'google') {
      return res.json(await getGoogleMessageBody(db, ownerId, account.email, String(id)))
    }
    if (account.provider === 'imap') {
      return res.json(await getImapMessageBody(db, ownerId, { folder: wantedFolder, uid: String(id) }))
    }
    if (account.provider === 'microsoft') {
      return res.json(await getMicrosoftMessageBody(db, ownerId, account.email, String(id), { folder: wantedFolder }))
    }
    throw unsupportedProviderError()
  } catch (err) {
    sendMailReadError(res, err, '[v2/mail:message]')
  }
})

// Marque un message comme lu chez le fournisseur : une étiquette retirée
// (Gmail UNREAD) ou un drapeau posé (IMAP \Seen), rien d'autre. Route SÉPARÉE
// de /api/v2/mail/message à dessein : la lecture d'un message ne doit jamais
// dépendre de la réussite du marquage. Aucun état de lecture n'est stocké chez
// nous — la liste suivante le relira chez le fournisseur, comme aujourd'hui.
app.post('/api/v2/mail/mark-read', async (req, res) => {
  const ownerId = requireUserId(req, res)
  if (!ownerId) return
  const { email, id, folder } = req.body || {}
  if (!id) return res.status(400).json({ error: 'Identifiant de message requis' })
  const wantedFolder = folder === 'sent' ? 'sent' : 'inbox'
  try {
    // Un envoi servi depuis notre table n'a jamais eu d'état de lecture chez un
    // tiers : il n'y a rien à modifier, et rien à faire croire.
    if (String(id).startsWith('resend:')) {
      return res.status(409).json({
        code: 'unsupported_provider',
        error: 'Un envoi parti par MovUP n\'a pas d\'état de lecture à modifier.'
      })
    }
    const db = await getDb()
    const account = await resolveMailAccount(db, ownerId, email)
    if (!account) {
      return res.status(409).json({ code: 'no_account', error: 'Aucune boîte mail connectée.' })
    }
    if (account.provider === 'google') {
      return res.json(await markGoogleMessageRead(db, ownerId, account.email, String(id)))
    }
    if (account.provider === 'imap') {
      return res.json(await markImapMessageSeen(db, ownerId, { folder: wantedFolder, uid: String(id) }))
    }
    return res.status(409).json({
      code: 'unsupported_provider',
      error: 'Le marquage comme lu n\'est pas disponible pour ce mode de connexion.'
    })
  } catch (err) {
    sendMailReadError(res, err, '[v2/mail:mark-read]')
  }
})

// ────────────────────────────────────────────────────────────────────────────
// TRACK 2 — RESEND COLD MAILING CAMPAGNES
// ────────────────────────────────────────────────────────────────────────────

function ensureResendOrFail(res) {
  if (!isResendReady()) {
    res.status(503).json({ error: 'RESEND_API_KEY non configurée — voir README-mail.md' })
    return false
  }
  return true
}

// Sanitize une chaîne pour l'utiliser comme id SurrealDB (alphanum + underscore + hyphen).
function safeId(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 80)
}

// ── DOMAINS RESEND ──

// POST /api/v2/campaigns/domain/verify
// Body : { domain_name }
// Crée le domaine sur Resend (ou récupère l'existant si 409), retourne records DNS.
app.post('/api/v2/campaigns/domain/verify', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  if (!ensureResendOrFail(res)) return
  const { domain_name } = req.body || {}
  if (!domain_name || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain_name)) {
    return res.status(400).json({ error: 'domain_name invalide' })
  }
  try {
    const result = await verifyResendDomain(domain_name)
    const db = await getDb()
    const recordId = `${userId}__${safeId(domain_name)}`
    const payload = {
      userId,
      domain_name,
      resend_domain_id: result.id,
      status: result.status || 'pending',
      dns_records: result.records || [],
      verified_at: result.status === 'verified' ? new Date().toISOString() : null,
      updated_at: new Date().toISOString()
    }
    const sel = await db.query('SELECT * FROM type::record("domains_resend", $id)', { id: recordId })
    if (sel[0]?.[0]) {
      await db.query('UPDATE type::record("domains_resend", $id) MERGE $body', { id: recordId, body: payload })
    } else {
      payload.created_at = new Date().toISOString()
      await db.query('CREATE type::record("domains_resend", $id) CONTENT $body', { id: recordId, body: payload })
    }
    res.json({
      record_id: recordId,
      resend_domain_id: result.id,
      domain_name,
      status: result.status || 'pending',
      dns_records: result.records || [],
      existing: Boolean(result.existing)
    })
  } catch (err) {
    console.error('[campaigns:domain-verify]', err.message)
    if (/rate limit|429/i.test(err.message)) return res.status(503).json({ error: 'Resend rate limit, réessayez dans quelques secondes' })
    res.status(500).json({ error: err.message || 'Vérification domaine impossible' })
  }
})

// GET /api/v2/campaigns/domain/status?domain_id=xxx
// Resync l'état Resend → table domains_resend, retourne le statut courant.
app.get('/api/v2/campaigns/domain/status', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  if (!ensureResendOrFail(res)) return
  const { domain_id } = req.query
  if (!domain_id) return res.status(400).json({ error: 'domain_id requis (id Resend)' })
  try {
    const live = await getResendDomainStatus(domain_id)
    const db = await getDb()
    // Update dans notre table le record matchant resend_domain_id pour ce userId
    const local = (await queryOrEmpty(db, 'SELECT * FROM domains_resend WHERE userId = $userId AND resend_domain_id = $rid', { userId, rid: domain_id }))[0]
    // Isolation lecture : ne rien exposer d'un domaine non possédé par ce tenant.
    if (!local) return res.status(404).json({ error: 'Domaine introuvable' })
    if (local) {
      const recordId = String(local.id).replace(/^domains_resend:/, '').replace(/^⟨+|⟩+$/g, '')
      const patch = {
        status: live.status,
        dns_records: live.records,
        updated_at: new Date().toISOString()
      }
      if (live.status === 'verified' && !local.verified_at) {
        patch.verified_at = new Date().toISOString()
      }
      await db.query('UPDATE type::record("domains_resend", $id) MERGE $body', { id: recordId, body: patch })
    }
    res.json({ resend_domain_id: live.id, domain_name: live.name, status: live.status, dns_records: live.records })
  } catch (err) {
    console.error('[campaigns:domain-status]', err.message)
    res.status(500).json({ error: err.message || 'Lecture statut domaine impossible' })
  }
})

// GET /api/v2/campaigns/domain/list — domaines du user en base locale
app.get('/api/v2/campaigns/domain/list', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    res.json(await queryOrEmpty(db, 'SELECT * FROM domains_resend WHERE userId = $userId ORDER BY created_at DESC', { userId }))
  } catch (err) {
    console.error('[campaigns:domain-list]', err.message)
    res.status(500).json({ error: 'Lecture domaines impossible' })
  }
})

// ── CAMPAIGNS ──

// POST /api/v2/campaigns/create
// Body : { name, template_subject, template_html, template_text?, recipients[], from_email, from_name?, reply_to?, scheduled_at? }
app.post('/api/v2/campaigns/create', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  const { name, template_subject, template_html, template_text, recipients, from_email, from_name, reply_to, scheduled_at } = req.body || {}
  if (!name || !template_subject || !from_email) {
    return res.status(400).json({ error: 'Champs requis : name, template_subject, from_email' })
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: 'recipients requis (array non vide)' })
  }
  if (!template_html && !template_text) {
    return res.status(400).json({ error: 'template_html ou template_text requis' })
  }
  try {
    const db = await getDb()
    const id = 'camp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
    const now = new Date().toISOString()
    const status = scheduled_at ? 'scheduled' : 'draft'
    const body = {
      userId,
      name,
      template_subject,
      template_html: template_html || null,
      template_text: template_text || null,
      recipients,
      recipients_count: recipients.length,
      from_email,
      from_name: from_name || null,
      reply_to: reply_to || null,
      scheduled_at: scheduled_at || null,
      status,
      stats: { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unsubscribed: 0 },
      created_at: now,
      updated_at: now
    }
    const result = await db.query('CREATE type::record("campaigns", $id) CONTENT $body', { id, body })
    res.status(201).json(result[0]?.[0] || result[0] || null)
  } catch (err) {
    console.error('[campaigns:create]', err.message)
    res.status(500).json({ error: 'Création campagne impossible' })
  }
})

// POST /api/v2/campaigns/:id/send
app.post('/api/v2/campaigns/:id/send', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  if (!ensureResendOrFail(res)) return
  const id = cleanRecordId('campaigns', req.params.id) || req.params.id
  try {
    const db = await getDb()
    const sel = await db.query('SELECT * FROM type::record("campaigns", $id)', { id })
    const campaign = sel[0]?.[0]
    if (!campaign || campaign.userId !== userId) return res.status(404).json({ error: 'Campagne introuvable' })
    if (campaign.status === 'sending' || campaign.status === 'completed') {
      return res.status(409).json({ error: `Campagne déjà ${campaign.status} — envoi refusé (idempotence)` })
    }

    // Vérifie qu'au moins un domaine vérifié existe pour ce user (cohérence with from_email)
    const domains = await db.query('SELECT * FROM domains_resend WHERE userId = $userId AND status = "verified"', { userId })
    const verified = (domains[0] || []).map(d => d.domain_name)
    const fromDomain = String(campaign.from_email).split('@')[1]
    const movupShared = fromDomain === 'movup.io'  // domaine partagé MUP, toujours autorisé
    if (!verified.includes(fromDomain) && !movupShared) {
      return res.status(412).json({ error: `Domaine ${fromDomain} non vérifié. Vérifier dans l'onglet Paramètres avant l'envoi.` })
    }

    // Pré-check RGPD art. 14 (Phase 6 Étape 14) : identité responsable de
    // traitement (raison_sociale + siret) requise AVANT tout envoi. Bloque la
    // campagne en amont (pas d'interruption en cours de batch, pas de statut
    // 'sending' prématuré). 400 siret_missing → popup setup côté front.
    const uidClean = String(userId).replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')
    const uSel = await db.query("SELECT raison_sociale, siret FROM type::record('user', $uid)", { uid: uidClean })
    const senderUser = uSel?.[0]?.[0] || {}
    const senderSiret = senderUser.siret ? String(senderUser.siret).replace(/\s/g, '') : ''
    if (!senderUser.raison_sociale || !/^\d{14}$/.test(senderSiret)) {
      return res.status(400).json({
        error: 'siret_missing',
        message: 'Identité commerciale incomplète. Veuillez compléter votre raison sociale et SIRET avant le premier envoi.'
      })
    }

    // Mark as sending immediately for idempotence guard
    await db.query('UPDATE type::record("campaigns", $id) MERGE $body', { id, body: { status: 'sending', send_started_at: new Date().toISOString(), updated_at: new Date().toISOString() } })

    const result = await mailServiceSendCampaign(userId, {
      from: campaign.from_email,
      fromName: campaign.from_name,
      replyTo: campaign.reply_to,
      recipients: campaign.recipients,
      subject: campaign.template_subject,
      html: campaign.template_html,
      text: campaign.template_text,
      user: { raison_sociale: senderUser.raison_sociale, siret: senderSiret }
    })

    const stats = campaign.stats || { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unsubscribed: 0 }
    stats.sent = (stats.sent || 0) + result.sent_count
    await db.query('UPDATE type::record("campaigns", $id) MERGE $body', {
      id,
      body: {
        status: result.failed_count > 0 && result.sent_count === 0 ? 'failed' : 'completed',
        sent_at: new Date().toISOString(),
        stats,
        batch_ids: result.batch_ids,
        sent_count: result.sent_count,
        failed_count: result.failed_count,
        updated_at: new Date().toISOString()
      }
    })
    const responseStatus = result.failed_count > 0 && result.sent_count === 0 ? 502 : 200
    res.status(responseStatus).json({
      id,
      sent_count: result.sent_count,
      failed_count: result.failed_count,
      batch_ids: result.batch_ids,
      total: result.total,
      last_error: result.last_error || undefined
    })
  } catch (err) {
    console.error('[campaigns:send]', err.message)
    // Reset le status si on a marqué sending mais que l'envoi a totalement échoué avant batch
    try {
      const db = await getDb()
      await db.query('UPDATE type::record("campaigns", $id) MERGE $body', { id, body: { status: 'failed', last_error: err.message, updated_at: new Date().toISOString() } })
    } catch (e) {/* swallow */}
    if (/rate limit|429/i.test(err.message)) return res.status(503).json({ error: 'Resend rate limit — réessayez dans quelques secondes' })
    res.status(500).json({ error: err.message || 'Envoi campagne impossible' })
  }
})

// GET /api/v2/campaigns — liste des campagnes du user
app.get('/api/v2/campaigns', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    res.json(await queryOrEmpty(db, 'SELECT id, name, status, recipients_count, from_email, scheduled_at, sent_at, stats, created_at FROM campaigns WHERE userId = $userId AND (status != "deleted" OR status IS NONE) ORDER BY created_at DESC', { userId }))
  } catch (err) {
    console.error('[campaigns:list]', err.message)
    res.status(500).json({ error: 'Lecture campagnes impossible' })
  }
})

// GET /api/v2/campaigns/:id — détail
app.get('/api/v2/campaigns/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const id = cleanRecordId('campaigns', req.params.id) || req.params.id
    const campaign = (await queryOrEmpty(db, 'SELECT * FROM type::record("campaigns", $id)', { id }))[0]
    if (!campaign || campaign.userId !== userId) return res.status(404).json({ error: 'Campagne introuvable' })
    res.json(campaign)
  } catch (err) {
    console.error('[campaigns:get]', err.message)
    res.status(500).json({ error: 'Lecture campagne impossible' })
  }
})

// GET /api/v2/campaigns/:id/stats — agrégats + liste recipients avec dernier event
app.get('/api/v2/campaigns/:id/stats', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const id = cleanRecordId('campaigns', req.params.id) || req.params.id
    const campaign = (await queryOrEmpty(db, 'SELECT * FROM type::record("campaigns", $id)', { id }))[0]
    if (!campaign || campaign.userId !== userId) return res.status(404).json({ error: 'Campagne introuvable' })

    // Liste des events de cette campagne
    const events = await queryOrEmpty(db, 'SELECT * FROM campaign_events WHERE campaign_id = $cid ORDER BY timestamp DESC', { cid: String(campaign.id).replace(/^campaigns:/, '').replace(/^⟨+|⟩+$/g, '') })

    // Agrégats par destinataire (dernier event par recipient_email)
    const lastByRecipient = new Map()
    for (const e of events) {
      if (!lastByRecipient.has(e.recipient_email)) {
        lastByRecipient.set(e.recipient_email, e)
      }
    }
    const recipientsStatus = (campaign.recipients || []).map(r => {
      const last = lastByRecipient.get(r.email) || null
      return { email: r.email, last_event: last ? last.event_type : null, last_timestamp: last ? last.timestamp : null }
    })

    res.json({
      id: campaign.id,
      stats: campaign.stats || {},
      status: campaign.status,
      recipients_count: campaign.recipients_count,
      recipients_status: recipientsStatus,
      events_total: events.length
    })
  } catch (err) {
    console.error('[campaigns:stats]', err.message)
    res.status(500).json({ error: 'Lecture stats campagne impossible' })
  }
})

// DELETE /api/v2/campaigns/:id — soft delete
app.delete('/api/v2/campaigns/:id', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return
  try {
    const db = await getDb()
    const id = cleanRecordId('campaigns', req.params.id) || req.params.id
    const sel = await db.query('SELECT * FROM type::record("campaigns", $id)', { id })
    const campaign = sel[0]?.[0]
    if (!campaign || campaign.userId !== userId) return res.status(404).json({ error: 'Campagne introuvable' })
    await db.query('UPDATE type::record("campaigns", $id) MERGE $body', { id, body: { status: 'deleted', deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() } })
    res.json({ ok: true })
  } catch (err) {
    console.error('[campaigns:delete]', err.message)
    res.status(500).json({ error: 'Suppression campagne impossible' })
  }
})

// ── WEBHOOK RESEND ──
// Validation HMAC Svix obligatoire. Refus 401 si invalide.
app.post('/api/v2/webhooks/resend', async (req, res) => {
  const verification = verifyResendSignature(req.rawBody, req.headers)
  if (!verification.ok) {
    console.warn('[webhook:resend] signature invalide :', verification.reason)
    return res.status(401).json({ error: 'signature invalide', reason: verification.reason })
  }
  // Réponse 200 immédiate (Resend re-tente si > 5s ou non 2xx)
  res.status(200).json({ ok: true })

  // Traitement asynchrone — n'affecte pas le 200 déjà envoyé
  ;(async () => {
    try {
      const event = req.body
      const type = event?.type || ''
      const data = event?.data || {}
      const recipient = Array.isArray(data.to) ? data.to[0] : data.email_id || data.to || null

      // Map event type → notre nomenclature interne
      const map = {
        'email.delivered': 'delivered',
        'email.opened': 'opened',
        'email.clicked': 'clicked',
        'email.bounced': 'bounced',
        'email.complained': 'complained',
        'email.unsubscribed': 'unsubscribed'
      }
      const eventType = map[type]
      if (!eventType) {
        console.log('[webhook:resend] event type non géré :', type)
        return
      }

      const db = await getDb()
      // Lookup campagne via batch_ids match. Les batch_ids étant uniques globalement,
      // un match suffit à identifier la campagne (pas de dépendance aux tags Resend).
      // Race condition : Resend envoie le webhook ~500ms après batch.send(), mais l'écriture
      // batch_ids côté SurrealDB Cloud peut prendre 700-1000ms (round-trip).
      // → retry court (4 tentatives, 500ms entre chaque, 1.5s max) couvre la fenêtre.
      let campaignId = null
      const emailId = data.email_id
      if (emailId) {
        const lookup = async () => {
          try {
            const found = await db.query('SELECT id FROM campaigns WHERE batch_ids CONTAINS $eid LIMIT 1', { eid: emailId })
            return found[0]?.[0] || null
          } catch (e) {
            try {
              const found2 = await db.query('SELECT id FROM campaigns WHERE $eid IN batch_ids LIMIT 1', { eid: emailId })
              return found2[0]?.[0] || null
            } catch (e2) {
              console.error('[webhook:resend] lookup query error :', e2.message)
              return null
            }
          }
        }
        let c = await lookup()
        let retries = 0
        while (!c && retries < 3) {
          await new Promise(res => setTimeout(res, 500))
          retries++
          c = await lookup()
        }
        if (c) campaignId = String(c.id).replace(/^campaigns:/, '').replace(/^⟨+|⟩+$/g, '')
      }

      // Aucune campagne rattachée après les quatre tentatives : c'est le cas
      // NORMAL d'un courriel transactionnel (activation, bienvenue…), qui
      // n'appartient à aucune campagne par construction. On s'arrête sans
      // créer d'accusé orphelin rattaché à rien.
      if (!campaignId) {
        console.log('[webhook:resend] envoi transactionnel sans campagne —', eventType, 'ignoré')
        return
      }

      // Insert event
      const eventDoc = {
        campaign_id: campaignId,
        recipient_email: recipient,
        event_type: eventType,
        timestamp: data.created_at || new Date().toISOString(),
        metadata: { resend_email_id: emailId, raw_type: type, click_url: data.click?.link || null, bounce_reason: data.bounce?.message || null }
      }
      await db.query('CREATE campaign_events CONTENT $body', { body: eventDoc })

      // Update agrégats si campagne identifiée
      if (campaignId) {
        const camp = await db.query('SELECT stats FROM type::record("campaigns", $id)', { id: campaignId })
        const stats = camp[0]?.[0]?.stats || { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unsubscribed: 0 }
        stats[eventType] = (stats[eventType] || 0) + 1
        await db.query('UPDATE type::record("campaigns", $id) MERGE $body', { id: campaignId, body: { stats, updated_at: new Date().toISOString() } })
      }
    } catch (e) {
      console.error('[webhook:resend:async]', e.message)
    }
  })()
})

// Handler 404 final — toute route GET non matchée par express.static, l'API
// ou les middlewares ci-dessus tombe ici. Plus de fallback silencieux sur
// dashboard.html (qui exposait le HTML protégé sans auth).
// Note : `/` est servie par express.static qui sert public/index.html via
// l'option default index — pas besoin de handler explicite.
app.use((req, res) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return res.status(404).sendFile(join(__dirname, 'public', '404.html'), err => {
      if (err) res.status(404).type('text/plain').send('404 — Page introuvable')
    })
  }
  res.status(404).json({ error: 'not_found' })
})

// Initialise tables on boot (idempotent: IF NOT EXISTS keeps redeploys quiet)
;(async () => {
  try {
    const db = await getDb()
    await db.query('DEFINE TABLE IF NOT EXISTS mail_settings SCHEMALESS')
    // Distincte de mail_settings à dessein — cf. le bloc SIGNATURE D'ABONNÉ.
    await db.query('DEFINE TABLE IF NOT EXISTS mail_signature SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS mail SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS visio_settings SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS visio_log SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS visio_draft SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS visio_bg_custom SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS visio_doc SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS visio_doc_open SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS devis SCHEMALESS')
    // Le logo qui coiffe les devis. Distinct de user_settings à dessein, cf. le
    // bloc LOGO DU COMPTE : trois pages écrivent les réglages, deux en renvoyant
    // l'objet entier, et une image n'a rien à faire dans ce trafic.
    await db.query('DEFINE TABLE IF NOT EXISTS account_logo SCHEMALESS')
    // Distincte de devis à dessein, cf. le bloc DEVIS SIGNÉ PAR LE CLIENT : une
    // écriture du devis remplace le document en entier et emporterait la pièce.
    await db.query('DEFINE TABLE IF NOT EXISTS devis_signature SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS facture SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS counter SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS frais SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS frais_recurrents SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS user_settings SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS user_plan SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS user_plan_history SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS domains_resend SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS campaigns SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS campaign_events SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS mailbox_credentials SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS societes SCHEMALESS')
    // pipeline/contacts : créées-au-write historiquement. Définies au boot pour
    // qu'un SELECT sur instance neuve renvoie [] au lieu de "table does not exist".
    await db.query('DEFINE TABLE IF NOT EXISTS pipeline SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS contacts SCHEMALESS')
    await db.query('DEFINE TABLE IF NOT EXISTS agenda SCHEMALESS')
    // activites : le fil d'activité, hors des enregistrements qu'il concerne.
    await db.query('DEFINE TABLE IF NOT EXISTS activites SCHEMALESS')
    // Indexes pour les requêtes scoping userId et lookups par campagne/destinataire
    // mail : lue à chaque ouverture des Envoyés, toujours filtrée sur userId.
    await db.query('DEFINE INDEX IF NOT EXISTS mail_user ON TABLE mail COLUMNS userId')
    await db.query('DEFINE INDEX IF NOT EXISTS campaigns_user ON TABLE campaigns COLUMNS userId')
    await db.query('DEFINE INDEX IF NOT EXISTS domains_user ON TABLE domains_resend COLUMNS userId')
    await db.query('DEFINE INDEX IF NOT EXISTS events_campaign ON TABLE campaign_events COLUMNS campaign_id')
    await db.query('DEFINE INDEX IF NOT EXISTS events_recipient ON TABLE campaign_events COLUMNS recipient_email')
    // Unicité (ownerId, email, provider) — un user ne peut connecter 2x la même boîte sur le même provider
    await db.query('DEFINE INDEX IF NOT EXISTS mailbox_creds_unique ON TABLE mailbox_credentials COLUMNS ownerId, email, provider UNIQUE')
    await db.query('DEFINE INDEX IF NOT EXISTS mailbox_creds_owner ON TABLE mailbox_credentials COLUMNS ownerId')
    // Sociétés — rapprochement par cle_normalisee (NON unique : homonymes possibles)
    await db.query('DEFINE INDEX IF NOT EXISTS idx_societes_cle ON societes FIELDS cle_normalisee')
    // Sociétés — dédup par SIRET (NON unique : siret vide partagé tant que non enrichi)
    await db.query('DEFINE INDEX IF NOT EXISTS idx_societes_siret ON societes FIELDS siret')
    // Sociétés — dédup par SIREN (NON unique : siren vide partagé tant que non enrichi)
    await db.query('DEFINE INDEX IF NOT EXISTS idx_societes_siren ON societes FIELDS siren')
    // Fil d'activité — toute lecture filtre userId, et la lecture d'une fiche
    // y ajoute la liste des ancrages équivalents.
    await db.query('DEFINE INDEX IF NOT EXISTS activites_user ON TABLE activites COLUMNS userId, ancrage')
    console.log('[boot] tables ready (mail x2, visio x6, devis x2, facture, counter, frais x2, user_settings, user_plan x2, mail_v2 x3, mailbox_credentials, societes, pipeline, contacts, agenda, activites + 11 indexes)')
  } catch (e) {
    console.error('[boot] table init failed:', e.message)
  }
  // Auth Phase 1 — applique migration tables user/session/verification_token/audit_log.
  try {
    await runAuthMigration()
    console.log('[boot] auth tables ready (user, session, verification_token, audit_log)')
  } catch (e) {
    console.error('[boot] auth migration failed:', e.message)
  }
  // Tracking historique usage Leads — lead_search (+ 3 index), lead_contact_edit
  // et lead_enrichment (+ 2 index chacune). Idempotent, aucune reprise du passé.
  try {
    await runLeadSearchMigration()
    console.log('[boot] lead_search + lead_contact_edit + lead_enrichment ready (+ 7 indexes)')
  } catch (e) {
    console.error('[boot] lead_search migration failed:', e.message)
  }
  // Tables RGPD optout — opt-out tiers via /optout (art. 12 RGPD). Conservées
  // hors purge utilisateur 9.16 (cf. server/services/purge-expired.js).
  try {
    await runOptoutMigration()
    console.log('[boot] optout tables ready (request + blocklist, 9 indexes)')
  } catch (e) {
    console.error('[boot] optout migration failed:', e.message)
  }
  // Référentiel entreprises mutualisé — table referentiel_societes (clé SIRET),
  // partagée entre tous les utilisateurs (aucun userId). Vide au boot :
  // alimentation par UPSERT dans une passe ultérieure.
  try {
    await runReferentielMigration()
    console.log('[boot] referentiel_societes table ready (+ 6 indexes)')
  } catch (e) {
    console.error('[boot] referentiel migration failed:', e.message)
  }
  // Référentiel OSM — réserve nationale de contacts issus du gisement
  // OpenStreetMap, table referentiel_osm (clé osm_id). Séparée de
  // referentiel_societes, SIRET en index secondaire pour la jointure.
  // Vide au boot : alimentation par UPSERT dans une passe ultérieure.
  try {
    await runReferentielOsmMigration()
    console.log('[boot] referentiel_osm table ready (+ 2 indexes)')
  } catch (e) {
    console.error('[boot] referentiel_osm migration failed:', e.message)
  }
  // Actualités — table actualites (clé guid), alimentée par le cron toutes les
  // quinze minutes et lue par /api/public/actualites. Vide au boot.
  try {
    await runActualitesMigration()
    console.log('[boot] actualites table ready (+ 2 indexes)')
  } catch (e) {
    console.error('[boot] actualites migration failed:', e.message)
  }
  // Référentiel Atout France — table referentiel_atout_france (clé naturelle
  // composée nom+CP+adresse), hébergements touristiques classés. Séparée de
  // referentiel_societes, bornée par département faute de coordonnées dans la
  // source. Vide au boot : alimentation par POST /api/admin/atout-france/charger.
  try {
    await runReferentielAtoutFranceMigration()
    console.log('[boot] referentiel_atout_france table ready (+ 3 indexes)')
  } catch (e) {
    console.error('[boot] referentiel_atout_france migration failed:', e.message)
  }
  // Référentiel RGE — table referentiel_rge (clé = `_id` de la source ADEME),
  // qualifications « Reconnu Garant de l'Environnement ». Séparée de
  // referentiel_societes, jointe par SIREN et non par SIRET (un quart des
  // entreprises est enregistré chez l'ADEME sous un autre établissement).
  // Vide au boot : alimentation par POST /api/admin/rge/charger.
  try {
    await runReferentielRgeMigration()
    console.log('[boot] referentiel_rge table ready (+ 4 indexes)')
  } catch (e) {
    console.error('[boot] referentiel_rge migration failed:', e.message)
  }
  // Audience du site public — tables visite (détail, 90 jours) et visite_jour
  // (agrégat, conservé). Aucun userId, aucun lien avec la table user : ce sont
  // des visiteurs anonymes. Vides au boot, alimentées par le middleware de
  // mesure et par l'étape « visites » du cron quotidien.
  try {
    await runVisitesMigration()
    console.log('[boot] visite tables ready (visite + visite_jour, 2 indexes)')
  } catch (e) {
    console.error('[boot] visites migration failed:', e.message)
  }
  // Cron trial — node-cron in-process déclenché à 8h Europe/Paris.
  // Skip si NODE_ENV !== 'production' (évite spam emails en dev) ou
  // si CRON_ENABLED === 'false' (override Railway).
  if (process.env.NODE_ENV === 'production') {
    try {
      startCronJobs()
    } catch (e) {
      console.error('[boot] cron startup failed:', e.message)
    }
  } else {
    console.log('[boot] cron skipped (NODE_ENV !== production)')
  }
  // Cron actualités — HORS du garde NODE_ENV ci-dessus, volontairement : ce
  // garde protège des envois de courriels en dev, or un ramassage de flux
  // n'envoie rien. Seul CRON_ENABLED === 'false' l'arrête (le skip est décidé
  // dans startActualitesCron, comme pour le cron trial).
  try {
    startActualitesCron()
  } catch (e) {
    console.error('[boot] cron actualités startup failed:', e.message)
  }
})()

// ── Filet de sécurité process ──────────────────────────────────────────────
// Un process vivant mais incapable de servir n'est jamais relancé par Railway :
// ON_FAILURE ne se déclenche que sur exit non nul, et le healthcheck n'est
// consulté qu'au déploiement. On rend donc le process explicitement mortel sur
// erreur fatale, pour que la restartPolicy le relève.
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err?.message)
  console.error(err?.stack || err)
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason))
  console.error('[fatal] unhandledRejection:', err.message)
  console.error(err.stack || err)
  process.exit(1)
})

const server = app.listen(process.env.PORT || 3000, () => console.log('✓ mup running'))

// Sonde active SurrealDB : abat le process après 10 échecs consécutifs pour
// déclencher la relance Railway (voir lib/watchdog.js).
startWatchdog(getDb)

// app.listen échoue en asynchrone (port occupé, EACCES…) : sans ce handler,
// l'erreur remonte en unhandled et le boot part en vrille silencieuse.
server.on('error', (err) => {
  console.error('[fatal] server.listen error:', err?.message)
  console.error(err?.stack || err)
  process.exit(1)
})

// Arrêt propre sur signal (déploiement, scale-down). Délai de garde : si
// server.close pend sur des connexions vivantes, on sort quand même.
let shuttingDown = false
function gracefulShutdown(signal){
  if(shuttingDown) return
  shuttingDown = true
  console.log(`[shutdown] ${signal} reçu, fermeture du serveur…`)
  const guard = setTimeout(() => {
    console.error('[shutdown] délai de garde dépassé, sortie forcée')
    process.exit(0)
  }, 10000)
  guard.unref()
  server.close(() => {
    clearTimeout(guard)
    console.log('[shutdown] serveur fermé proprement')
    process.exit(0)
  })
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))