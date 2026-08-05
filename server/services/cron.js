// Cron in-process. Deux horloges indépendantes :
//   • trial — emails de relance + auto-expire, démarré au boot de server.js si
//     NODE_ENV=production et CRON_ENABLED !== 'false'. Défaut : 8h Europe/Paris.
//   • actualités — ramassage du flux France 24, toutes les quinze minutes,
//     démarré sous CRON_ENABLED seul (voir startActualitesCron plus bas).
//
// Idempotence : garantie par les flags DB trial_email_j*_sent_at posés par
// trial-emails.js après chaque envoi. Le cron peut tourner plusieurs fois
// sans risque de double-envoi. Si Railway redémarre l'instance pendant
// l'exécution, on relance simplement le lendemain — les flags filtrent
// déjà les users ayant reçu l'email.
//
// Logging : chaque exécution écrit un audit_log avec event 'cron:trial:*'
// et metadata { sent, total, errors[] }.

import cron from 'node-cron'
import { getDb } from '../../lib/surreal.js'
import {
  sendTrialEndingSoonEmails,
  sendTrialEndingTodayEmails,
  expireTrialAutomatically,
  sendGraceEndingTomorrowEmails,
  sendTrialDataDeletionWarningEmails
} from './trial-emails.js'
import { purgeExpiredUsers, purgeExpiredTrials, deleteUserCascade } from './purge-expired.js'
import { sendAccountDeletionConfirmed } from './email.js'
import { ramasserActualites } from './actualites.js'

const SCHEDULE = process.env.CRON_TRIAL_SCHEDULE || '0 8 * * *'
const TIMEZONE = process.env.CRON_TIMEZONE || 'Europe/Paris'
const ACTUALITES_SCHEDULE = process.env.CRON_ACTUALITES_SCHEDULE || '*/15 * * * *'

// Helper d'audit cron — pattern aligné sur logAuditEvent de surreal-adapter
// mais inline ici pour éviter une dépendance croisée. Échec silencieux :
// un audit_log raté ne doit pas casser le batch trial.
async function logCronAudit(event, metadata) {
  try {
    const db = await getDb()
    // Même règle que logAuditEvent : un champ absent reste ABSENT de la requête.
    // Poser `null` sur un option<...> SCHEMAFULL fait rejeter le CREATE entier ;
    // les champs non posés (dont ip) deviennent NONE d'eux-mêmes.
    const fields = ['event = $event', "user_agent = 'cron'"]
    const params = { event }
    if (metadata && typeof metadata === 'object') {
      fields.push('metadata = $meta')
      params.meta = metadata
    }
    await db.query(`CREATE audit_log SET ${fields.join(', ')}`, params)
  } catch (e) {
    console.warn('[cron] logAudit échoué :', e.message)
  }
}

// Wrapper try/catch par fonction : si une étape plante, les autres continuent.
// Retourne le résumé pour log audit.
//
// prefixe — préfixe de l'event d'audit. Défaut 'cron:trial:' : les huit étapes
// existantes gardent mot pour mot l'event qu'elles écrivaient déjà. Le ramassage
// d'actualités, lui, passe 'cron:actualites:' — deux horloges, deux familles
// d'events, aucun mélange à la relecture de l'audit.
async function runStep(name, fn, prefixe = 'cron:trial:') {
  const startedAt = Date.now()
  try {
    const result = await fn()
    const ms = Date.now() - startedAt
    console.log(`[cron] ${name} terminé en ${ms}ms :`, JSON.stringify(result))
    await logCronAudit(`${prefixe}${name}`, { ...result, duration_ms: ms })
    return result
  } catch (e) {
    const ms = Date.now() - startedAt
    console.error(`[cron] ${name} planté en ${ms}ms :`, e.message)
    await logCronAudit(`${prefixe}${name}`, { error: e.message, duration_ms: ms })
    return { error: e.message }
  }
}

// Job principal — séquence J-2 → J-0 → expire. Aucun await bloquant entre
// les 3 (pas d'inter-dépendance), mais séquentiel pour ne pas hammer la DB.
async function runTrialJobs() {
  console.log('[cron] Trial jobs déclenchés à', new Date().toISOString())
  await runStep('j2', sendTrialEndingSoonEmails)
  await runStep('j0', sendTrialEndingTodayEmails)
  await runStep('trial_purge_warn', sendTrialDataDeletionWarningEmails)
  await runStep('expire', expireTrialAutomatically)
  await runStep('grace_j1', sendGraceEndingTomorrowEmails)
  await runStep('account_deletion', runAccountDeletions)
  await runStep('purge', purgeExpiredUsers)
  await runStep('purge_trial', purgeExpiredTrials)
}

// Suppression compte art. 17 (Phase 6 Étape 13) — exécute la cascade pour
// tous les users dont deletion_scheduled_at est échue. L'email + le prenom
// sont récupérés AVANT la cascade (impossible après le DELETE user). Échec
// d'un user loggé et non bloquant pour les autres.
async function runAccountDeletions() {
  const db = await getDb()
  const overdue = await db.query(
    'SELECT id, email, prenom, nom, deletion_requested_at FROM user'
    + ' WHERE deletion_scheduled_at != NONE AND deletion_scheduled_at <= time::now()'
  )
  const users = overdue?.[0] || []
  let processed = 0
  for (const u of users) {
    try {
      await deleteUserCascade(u.id)
      try {
        if (u.email) {
          await sendAccountDeletionConfirmed({
            to: u.email,
            prenom: u.prenom || '',
            nom: u.nom || '',
            requested_at: u.deletion_requested_at ? String(u.deletion_requested_at) : null
          })
        }
      } catch (mailErr) {
        console.error('[account_deletion] mail confirmé échec', String(u.id), mailErr.message)
      }
      processed++
    } catch (err) {
      console.error('[account_deletion]', String(u.id), err.message)
    }
  }
  return { processed, total: users.length }
}

// Ramassage du flux d'actualités. Une seule étape, sous le même wrapper que les
// huit autres (audit + durée), mais sous son propre préfixe d'event.
async function runActualitesJob() {
  await runStep('ramassage', ramasserActualites, 'cron:actualites:')
}

let started = false
let actualitesStarted = false

// Démarre le cron quotidien. Idempotent : 2e appel = no-op (évite double
// register en cas de hot reload). Skip si CRON_ENABLED === 'false'.
export function startCronJobs() {
  if (started) {
    console.warn('[cron] startCronJobs déjà appelé, skip')
    return
  }
  if (process.env.CRON_ENABLED === 'false') {
    console.log('[cron] CRON_ENABLED=false, cron désactivé')
    return
  }
  if (!cron.validate(SCHEDULE)) {
    console.error('[cron] Schedule invalide :', SCHEDULE, '— cron NON démarré')
    return
  }
  cron.schedule(SCHEDULE, runTrialJobs, { timezone: TIMEZONE })
  started = true
  console.log(`[cron] Trial cron jobs démarrés (schedule: ${SCHEDULE}, timezone: ${TIMEZONE})`)
}

// Démarre le cron d'actualités. Idempotent, comme startCronJobs, et skip sous
// CRON_ENABLED === 'false'.
//
// DIFFÉRENCE ASSUMÉE avec le cron trial : PAS de garde NODE_ENV. Le garde de
// production existe parce que le cron trial ENVOIE DES COURRIELS — le lancer en
// dev inonderait de vraies boîtes de vrais abonnés. Un ramassage d'actualités
// n'envoie rien, ne touche à aucun compte, n'écrit que dans sa propre table :
// il n'y a rien à protéger d'un lancement hors production, et le faire tourner
// en dev est même la seule façon d'y voir un bandeau garni.
export function startActualitesCron() {
  if (actualitesStarted) {
    console.warn('[cron] startActualitesCron déjà appelé, skip')
    return
  }
  if (process.env.CRON_ENABLED === 'false') {
    console.log('[cron] CRON_ENABLED=false, cron actualités désactivé')
    return
  }
  if (!cron.validate(ACTUALITES_SCHEDULE)) {
    console.error('[cron] Schedule actualités invalide :', ACTUALITES_SCHEDULE, '— cron NON démarré')
    return
  }
  cron.schedule(ACTUALITES_SCHEDULE, runActualitesJob, { timezone: TIMEZONE })
  actualitesStarted = true
  console.log(`[cron] Actualités cron démarré (schedule: ${ACTUALITES_SCHEDULE}, timezone: ${TIMEZONE})`)
}
