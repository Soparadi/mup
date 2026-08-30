// Cron in-process. Trois horloges indépendantes :
//   • trial — emails de relance + auto-expire, démarré au boot de server.js si
//     NODE_ENV=production et CRON_ENABLED !== 'false'. Défaut : 8h Europe/Paris.
//   • actualités — ramassage du flux France 24, toutes les quinze minutes,
//     démarré sous CRON_ENABLED seul (voir startActualitesCron plus bas).
//   • position — balayage quotidien des cartes pipeline sans coordonnées,
//     démarré sous CRON_ENABLED seul, pour le même motif que les actualités.
//
// Idempotence : garantie par les flags DB trial_email_j*_sent_at posés par
// trial-emails.js après chaque envoi. Le cron peut tourner plusieurs fois
// sans risque de double-envoi. Si Railway redémarre l'instance pendant
// l'exécution, on relance simplement le lendemain — les flags filtrent
// déjà les users ayant reçu l'email.
//
// Logging : chaque exécution écrit un audit_log avec event 'cron:trial:*' et
// metadata { …retour de l'étape, echeances_7j, duration_ms, ok }. Le passage
// entier écrit en plus une ligne de clôture 'cron:trial:passage' — son ABSENCE
// est la seule chose qui dise qu'un cron n'a pas tourné, un cron qui ne démarre
// pas n'écrivant rien, et rien ressemblant à rien.

import cron from 'node-cron'
import { getDb } from '../../lib/surreal.js'
import { compterEcheances } from '../../lib/echeances.js'
import {
  sendTrialEndingSoonEmails,
  sendTrialEndingTodayEmails,
  expireTrialAutomatically,
  sendGraceEndingTomorrowEmails,
  sendTrialDataDeletionWarningEmails
} from './trial-emails.js'
import { purgeExpiredUsers, purgeExpiredTrials, deleteUserCascade } from './purge-expired.js'
import { rattraperEssaisDormants } from './rattrapage-essai.js'
import { agregerVisitesJour } from './visites.js'
import { sendAccountDeletionConfirmed } from './email.js'
import { ramasserActualites } from './actualites.js'
import { balayerPositionsCartes } from './position-cartes.js'

const SCHEDULE = process.env.CRON_TRIAL_SCHEDULE || '0 8 * * *'
const TIMEZONE = process.env.CRON_TIMEZONE || 'Europe/Paris'
const ACTUALITES_SCHEDULE = process.env.CRON_ACTUALITES_SCHEDULE || '*/15 * * * *'
// Balayage de position — une fois par jour, et à une heure creuse. La
// population est AUTO-EXTINCTIVE : une carte positionnée en sort
// définitivement, et elle ne se regarnit qu'au rythme des corrections
// d'adresse. Passer plus souvent ne rattraperait rien de plus, cela ne ferait
// que relire la même population résiduelle.
const POSITION_SCHEDULE = process.env.CRON_POSITION_SCHEDULE || '30 4 * * *'

// Échéance de suppression de compte (art. 17) : la date d'action est
// deletion_scheduled_at lui-même. Voir lib/echeances.js pour la réserve de
// lecture — arithmétique native, aucune borne liée.
const ECHEANCES_ACCOUNT_DELETION = `deletion_scheduled_at != NONE
   AND deletion_scheduled_at >  time::now()
   AND deletion_scheduled_at <= time::now() + 7d`

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

// État d'une étape — le seul endroit où se décide ce que « sain » veut dire.
//
// DEUX SOURCES, et il en faut deux. L'exception attrapée par runStep n'est que
// la première ; l'échec RENDU EN BANDE est la seconde, et c'est la plus
// fréquente — aucune étape ne lève, toutes rattrapent. Sans la seconde, une
// sélection en panne (purge, j2, expire…) s'afficherait saine, ce qui est
// exactement la cécité que ce dispositif combat.
//
//   1. un retour qui n'est pas un objet — une étape qui ne rend rien ne dit
//      rien de bon, on ne lui accorde pas le bénéfice du doute ;
//   2. la clé `error` (chemin de l'exception, et retours en bande qui la
//      portent) ;
//   3. `errors[]` non vide — la forme des huit étapes trial ;
//   4. `erreurs` > 0 — la forme du ramassage d'actualités, qui compte ses
//      erreurs sans les lister. Sans cette branche, un flux à moitié en échec
//      passerait pour un ramassage sans faute.
function estOk(result) {
  if (!result || typeof result !== 'object') return false
  if (result.error) return false
  if (Array.isArray(result.errors) && result.errors.length) return false
  if (typeof result.erreurs === 'number' && result.erreurs > 0) return false
  return true
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
    // `ok` est posé APRÈS l'étalement, délibérément : une étape qui rendrait
    // elle-même un `ok` ne peut pas maquiller son état, c'est ce wrapper qui
    // tranche, sur le retour tel qu'il est arrivé.
    const meta = { ...result, duration_ms: ms }
    meta.ok = estOk(result)
    await logCronAudit(`${prefixe}${name}`, meta)
    return result
  } catch (e) {
    const ms = Date.now() - startedAt
    console.error(`[cron] ${name} planté en ${ms}ms :`, e.message)
    await logCronAudit(`${prefixe}${name}`, { error: e.message, duration_ms: ms, ok: false })
    return { error: e.message }
  }
}

// La séquence du passage quotidien, déclarée en liste : c'est elle qui donne le
// nombre d'étapes ATTENDUES, sans quoi la ligne de clôture ne saurait pas
// distinguer un passage complet d'un passage interrompu.
//
// L'ordre des neuf étapes historiques est celui d'avant, inchangé. `visites`
// reste EN DERNIER : c'est la seule étape qui n'envoie rien et ne touche aucun
// compte, elle ne doit pas retarder les relances.
//
// `rattrapage_essai` est EN PREMIER, et c'est la seule raison de son rang : il
// normalise la population avant les étapes qui la lisent. Un compte dormant
// sans dates d'essai, resté d'une période où l'approbation manuelle était
// armée, y reçoit les siennes et rejoint le circuit ordinaire. Sous
// INSCRIPTION_APPROBATION, l'étape ne lit même pas la base et rend zéro.
const ETAPES_TRIAL = [
  ['rattrapage_essai', rattraperEssaisDormants],
  ['j2', sendTrialEndingSoonEmails],
  ['j0', sendTrialEndingTodayEmails],
  ['trial_purge_warn', sendTrialDataDeletionWarningEmails],
  ['expire', expireTrialAutomatically],
  ['grace_j1', sendGraceEndingTomorrowEmails],
  ['account_deletion', runAccountDeletions],
  ['purge', purgeExpiredUsers],
  ['purge_trial', purgeExpiredTrials],
  ['visites', agregerVisitesJour]
]

// Job principal — séquentiel, pour ne pas hammer la DB.
//
// LIGNE DE CLÔTURE. Le passage écrit, en tout dernier, un 'cron:trial:passage'
// qui répond à la question qu'aucune ligne ne posait : le cron a-t-il tourné ?
// Elle est écrite dans un `finally`, donc même si toutes les étapes ont échoué.
//
// CE QUI SIGNALE UNE TOURNÉE INTERROMPUE, C'EST L'ABSENCE DE CETTE LIGNE, et
// rien d'autre. Le mode d'interruption réel est l'instance Railway tuée en
// cours de passage : le `finally` ne s'exécute pas, aucune ligne n'est écrite,
// et c'est ce trou dans la série quotidienne qui le dit. D'où l'écriture
// inconditionnelle de la ligne — elle fait de « pas de ligne » un fait lisible
// plutôt qu'un silence ambigu.
//
// `etapes_jouees` ne prétend pas à ce rôle. La boucle n'a presque aucun chemin
// pour lever — runStep attrape tout ce que rend l'étape, logCronAudit attrape
// ses propres échecs — donc le compteur ne couvre qu'un cas résiduel. Il est
// gardé pour ce qu'il coûte : rien, et il rendrait visible l'imprévu qui
// arriverait quand même.
async function runTrialJobs() {
  const debutPassage = Date.now()
  console.log('[cron] Trial jobs déclenchés à', new Date().toISOString())
  const joues = []
  try {
    for (const [nom, fn] of ETAPES_TRIAL) {
      joues.push([nom, await runStep(nom, fn)])
    }
  } finally {
    const ko = joues.filter(([, r]) => !estOk(r)).map(([nom]) => nom)
    const complet = joues.length === ETAPES_TRIAL.length
    await logCronAudit('cron:trial:passage', {
      etapes: ETAPES_TRIAL.length,
      etapes_jouees: joues.length,
      etapes_ok: joues.length - ko.length,
      etapes_ko: ko.length,
      // Chaîne et non tableau : la clôture doit rester lisible d'un coup d'œil,
      // et vide quand tout va bien — jamais absente, jamais null.
      etapes_ko_noms: ko.join(','),
      duration_ms: Date.now() - debutPassage,
      ok: complet && ko.length === 0
    })
  }
}

// Suppression compte art. 17 (Phase 6 Étape 13) — exécute la cascade pour
// tous les users dont deletion_scheduled_at est échue. L'email + le prenom
// sont récupérés AVANT la cascade (impossible après le DELETE user). Échec
// d'un user loggé et non bloquant pour les autres.
//
// REND SES ÉCHECS. Les échecs unitaires ne partaient qu'en console : l'audit
// affichait `processed: 0, total: 3` sans un mot sur les trois cascades
// tombées. Ils remontent désormais dans errors[], donc dans `ok`. Sans
// adresse : ces comptes sont en cours de suppression, l'identifiant suffit.
async function runAccountDeletions() {
  const echeances_7j = await compterEcheances('account_deletion', ECHEANCES_ACCOUNT_DELETION)
  const errors = []
  let db
  let users = []
  try {
    db = await getDb()
    const overdue = await db.query(
      'SELECT id, email, prenom, nom, deletion_requested_at FROM user'
      + ' WHERE deletion_scheduled_at != NONE AND deletion_scheduled_at <= time::now()'
    )
    users = overdue?.[0] || []
  } catch (e) {
    console.error('[account_deletion] SELECT échoué :', e.message)
    return { processed: 0, total: 0, echeances_7j, errors: [{ stage: 'select', error: e.message }] }
  }
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
        // La cascade a eu lieu ; seul le courriel de confirmation manque. Compté
        // à part de l'échec de suppression : le compte EST supprimé.
        console.error('[account_deletion] mail confirmé échec', String(u.id), mailErr.message)
        errors.push({ userId: String(u.id), stage: 'mail', error: mailErr.message })
      }
      processed++
    } catch (err) {
      console.error('[account_deletion]', String(u.id), err.message)
      errors.push({ userId: String(u.id), stage: 'cascade', error: err.message })
    }
  }
  return { processed, total: users.length, echeances_7j, errors }
}

// Ramassage du flux d'actualités. Une seule étape, sous le même wrapper que les
// huit autres (audit + durée), mais sous son propre préfixe d'event.
async function runActualitesJob() {
  await runStep('ramassage', ramasserActualites, 'cron:actualites:')
}

// Balayage de position. Une seule étape, même wrapper, préfixe propre : la
// ligne 'cron:position:balayage' est donc à la fois l'audit de l'étape et la
// LIGNE DE CLÔTURE du passage, comme pour le ramassage d'actualités. Son
// absence est la seule chose qui dise que le balayage n'a pas tourné.
//
// NON-RÉENTRANCE. node-cron ne saute pas un tic parce que le précédent tourne
// encore, et ce passage-ci peut durer : à 350 ms par carte, une population de
// mille cartes tient six minutes, et rien ne borne sa taille par construction.
// Deux passages superposés ne corrompraient rien — le balayage est idempotent,
// il réécrirait les mêmes coordonnées — mais ils paieraient deux fois la
// lecture et, sur la voie 2, deux fois la BAN. Le drapeau est remis à plat dans
// un `finally` : une étape qui plante ne doit pas condamner toutes les
// suivantes, or runStep rattrape déjà tout ce qui vient de dessous.
let balayagePositionEnCours = false
async function runBalayagePositionJob() {
  if (balayagePositionEnCours) {
    console.warn('[cron] balayage position déjà en cours, tic ignoré')
    return
  }
  balayagePositionEnCours = true
  try {
    await runStep('balayage', balayerPositionsCartes, 'cron:position:')
  } finally {
    balayagePositionEnCours = false
  }
}

let started = false
let actualitesStarted = false
let positionStarted = false

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

// Démarre le balayage de position. Idempotent, comme les deux autres, et skip
// sous CRON_ENABLED === 'false'.
//
// PAS DE GARDE NODE_ENV, sur le motif que startActualitesCron énonce déjà : ce
// garde existe parce que le cron trial ENVOIE DES COURRIELS, et le lancer en
// dev inonderait de vraies boîtes. Un balayage de position n'envoie rien, ne
// touche à aucun compte, et n'écrit que deux flottants sur des cartes qui n'en
// ont aucun. Il n'y a rien à protéger d'un lancement hors production.
//
// CE QU'IL NE FAIT PAS, et qui vient ailleurs : il ne touche pas à l'écriture
// de la Carte, qui continue de persister ce qu'elle géocode, ni à
// pipeline.html, qui continue d'effacer lat/lng à la correction d'une voie.
// C'est précisément cet effacement que le balayage neutralise, en rendant la
// position sans attendre que quiconque rouvre la Carte.
export function startBalayagePositionCron() {
  if (positionStarted) {
    console.warn('[cron] startBalayagePositionCron déjà appelé, skip')
    return
  }
  if (process.env.CRON_ENABLED === 'false') {
    console.log('[cron] CRON_ENABLED=false, cron position désactivé')
    return
  }
  if (!cron.validate(POSITION_SCHEDULE)) {
    console.error('[cron] Schedule position invalide :', POSITION_SCHEDULE, '— cron NON démarré')
    return
  }
  cron.schedule(POSITION_SCHEDULE, runBalayagePositionJob, { timezone: TIMEZONE })
  positionStarted = true
  console.log(`[cron] Balayage position démarré (schedule: ${POSITION_SCHEDULE}, timezone: ${TIMEZONE})`)
}
