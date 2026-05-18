// Cron in-process pour les emails de relance trial + auto-expire.
// Démarré une fois au boot de server.js si NODE_ENV=production et
// CRON_ENABLED !== 'false'. Schedule par défaut : 8h00 Europe/Paris quotidien.
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
  sendGraceEndingTomorrowEmails
} from './trial-emails.js'

const SCHEDULE = process.env.CRON_TRIAL_SCHEDULE || '0 8 * * *'
const TIMEZONE = process.env.CRON_TIMEZONE || 'Europe/Paris'

// Helper d'audit cron — pattern aligné sur logAuditEvent de surreal-adapter
// mais inline ici pour éviter une dépendance croisée. Échec silencieux :
// un audit_log raté ne doit pas casser le batch trial.
async function logCronAudit(event, metadata) {
  try {
    const db = await getDb()
    await db.query(
      'CREATE audit_log CONTENT { event: $event, ip: NONE, user_agent: $ua, metadata: $meta }',
      { event, ua: 'cron', meta: metadata || null }
    )
  } catch (e) {
    console.warn('[cron] logAudit échoué :', e.message)
  }
}

// Wrapper try/catch par fonction : si une étape plante, les autres continuent.
// Retourne le résumé pour log audit.
async function runStep(name, fn) {
  const startedAt = Date.now()
  try {
    const result = await fn()
    const ms = Date.now() - startedAt
    console.log(`[cron] ${name} terminé en ${ms}ms :`, JSON.stringify(result))
    await logCronAudit(`cron:trial:${name}`, { ...result, duration_ms: ms })
    return result
  } catch (e) {
    const ms = Date.now() - startedAt
    console.error(`[cron] ${name} planté en ${ms}ms :`, e.message)
    await logCronAudit(`cron:trial:${name}`, { error: e.message, duration_ms: ms })
    return { error: e.message }
  }
}

// Job principal — séquence J-2 → J-0 → expire. Aucun await bloquant entre
// les 3 (pas d'inter-dépendance), mais séquentiel pour ne pas hammer la DB.
async function runTrialJobs() {
  console.log('[cron] Trial jobs déclenchés à', new Date().toISOString())
  await runStep('j2', sendTrialEndingSoonEmails)
  await runStep('j0', sendTrialEndingTodayEmails)
  await runStep('expire', expireTrialAutomatically)
  await runStep('grace_j1', sendGraceEndingTomorrowEmails)
}

let started = false

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
