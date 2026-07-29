// Watchdog SurrealDB — sonde active, indépendante du trafic HTTP.
//
// Railway ne relance un process que sur exit non nul (ON_FAILURE) et ne consulte
// le healthcheck qu'au déploiement. Un process dont la connexion SurrealDB est
// morte sans reconstruction possible reste donc vivant et muet indéfiniment.
// Ce watchdog sonde la base toutes les 30 s ; après 10 échecs consécutifs il
// tue le process pour que la restartPolicy le relève.

const INTERVAL_MS = 30000
const QUERY_TIMEOUT_MS = 5000
const MAX_CONSECUTIVE_FAILURES = 10
const MIN_UPTIME_MS = 10 * 60 * 1000 // pas de sortie avant 10 min d'uptime

let started = false
let exited = false // une seule sortie possible

async function probe(getDb){
  const db = await getDb()
  let to
  try {
    await Promise.race([
      db.query('INFO FOR DB;'),
      new Promise((_, rej) => { to = setTimeout(() => rej(new Error('watchdog query timeout')), QUERY_TIMEOUT_MS) })
    ])
  } finally {
    clearTimeout(to)
  }
}

export function startWatchdog(getDb){
  if(started) return
  started = true

  const bootedAt = Date.now()
  let consecutiveFailures = 0
  let lastError = null

  const timer = setInterval(async () => {
    try {
      await probe(getDb)
      consecutiveFailures = 0
      lastError = null
    } catch(err){
      consecutiveFailures++
      lastError = err
      console.error(`[watchdog] sonde KO (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${err?.message}`)

      if(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !exited){
        const uptimeMs = Date.now() - bootedAt
        // Grâce au démarrage : pendant les 10 premières minutes, la base peut
        // encore se rétablir seule ; on n'abat pas le process trop tôt.
        if(uptimeMs < MIN_UPTIME_MS){
          console.error(`[watchdog] ${consecutiveFailures} échecs mais uptime ${Math.round(uptimeMs / 1000)}s < ${MIN_UPTIME_MS / 1000}s, sortie différée`)
          return
        }
        exited = true
        clearInterval(timer)
        console.error(`[watchdog] ${consecutiveFailures} échecs consécutifs, uptime ${Math.round(uptimeMs / 1000)}s, dernière erreur: ${lastError?.message}. Sortie(1) pour relance Railway.`)
        process.exit(1)
      }
    }
  }, INTERVAL_MS)
}
