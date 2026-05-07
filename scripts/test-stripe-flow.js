// scripts/test-stripe-flow.js
//
// Orchestration du test e2e Stripe — mode Test.
//
// Le script NE crée PAS d'utilisateur en base. Il vous accompagne :
//   1. Imprime les données de test à utiliser (SIRET, carte, etc.)
//   2. Vous guide pour créer un compte test via /signup en navigateur
//   3. Reçoit l'email du compte test en argument
//   4. Poll SurrealDB toutes les 5s et reporte les changements d'état
//      pendant que vous faites le Checkout en navigateur
//   5. S'arrête quand subscription_status === 'active' ou après 10 min
//
// Aucune écriture DB par le script. Le test pollue la base d'un user qui
// peut être nettoyé après via :
//   node scripts/purge-auth-data.mjs
//
// Usage :
//   node scripts/test-stripe-flow.js [email]
//   - sans email : affiche la doc de test et sort
//   - avec email : poll en continu (Ctrl+C pour stopper)

import 'dotenv/config'
import { Surreal } from 'surrealdb'

const APP_URL = process.env.APP_URL || 'https://movup.io'
const POLL_INTERVAL_MS = 5000
const POLL_MAX_DURATION_MS = 10 * 60 * 1000

function printTestDoc() {
  console.log(`
╭───────────────────────────────────────────────────────────╮
│  Test e2e Stripe MovUP — mode Test                        │
╰───────────────────────────────────────────────────────────╯

Ce script poll SurrealDB pour vérifier la bascule
trial_status → 'converted' et subscription_status → 'active'
après votre Checkout Stripe.

Étapes manuelles à exécuter dans votre navigateur :

  1. Ouvrir : ${APP_URL}/signup
     Créer un compte avec email jetable, ex :
       movup-test-${Date.now()}@example.com

  2. Aller sur : ${APP_URL}/account/upgrade?plan=activite
     (ou ?plan=demarrage / ?plan=croisiere)

  3. Saisir SIRET test : 542065479
     (LVMH — pré-remplit raison sociale + adresse)

  4. Cliquer "Continuer vers le paiement"
     → redirection Stripe Checkout

  5. Carte test Stripe :
       Numéro    : 4242 4242 4242 4242
       Date      : n'importe quelle date future (ex. 12/27)
       CVC       : 123
       ZIP       : 75001
       Nom       : Test MovUP

  6. Valider → redirection ${APP_URL}/account/billing?success=true

Pour démarrer le poll de cette session test :
  node scripts/test-stripe-flow.js <email-utilisé-au-signup>

Pour nettoyer après le test :
  node scripts/purge-auth-data.mjs
`)
}

function fmtDate(d) {
  if (!d) return '—'
  try {
    const date = new Date(d)
    if (isNaN(date.getTime())) return '—'
    return date.toISOString().replace('T', ' ').slice(0, 19)
  } catch (e) { return '—' }
}

function snapshot(u) {
  return [
    `trial_status=${u.trial_status || 'NONE'}`,
    `subscription_status=${u.subscription_status || 'NONE'}`,
    `plan=${u.plan || 'NONE'}`,
    `cycle=${u.plan_billing_cycle || 'NONE'}`,
    `cust=${u.stripe_customer_id ? u.stripe_customer_id.slice(0, 14) + '…' : '—'}`,
    `sub=${u.stripe_subscription_id ? u.stripe_subscription_id.slice(0, 14) + '…' : '—'}`,
    `period_end=${u.current_period_end ? new Date(u.current_period_end).toISOString().slice(0, 10) : '—'}`
  ].join('  ')
}

async function main() {
  const email = process.argv[2]
  if (!email) {
    printTestDoc()
    process.exit(0)
  }

  const required = ['SURREAL_URL', 'SURREAL_NAMESPACE', 'SURREAL_DATABASE', 'SURREAL_USER', 'SURREAL_PASS']
  const missing = required.filter(k => !process.env[k])
  if (missing.length) {
    console.error('Variables manquantes :', missing.join(', '))
    process.exit(1)
  }

  const db = new Surreal()
  await db.connect(process.env.SURREAL_URL, {
    namespace: process.env.SURREAL_NAMESPACE,
    database: process.env.SURREAL_DATABASE,
    authentication: {
      namespace: process.env.SURREAL_NAMESPACE,
      username: process.env.SURREAL_USER,
      password: process.env.SURREAL_PASS
    }
  })

  console.log(`Poll utilisateur : ${email}`)
  console.log(`URL prod : ${APP_URL}`)
  console.log(`Intervalle : ${POLL_INTERVAL_MS / 1000}s — timeout : ${POLL_MAX_DURATION_MS / 60000} min`)
  console.log(`Ctrl+C pour stopper.\n`)

  // Vérifier que l'user existe avant de poll
  const initial = await db.query(
    `SELECT * FROM user WHERE email = $email LIMIT 1`,
    { email }
  )
  const u0 = initial?.[0]?.[0]
  if (!u0) {
    console.error(`Utilisateur ${email} introuvable. Faire le signup d'abord.`)
    await db.close()
    process.exit(1)
  }

  console.log('État initial :')
  console.log('  ' + snapshot(u0) + '\n')

  // Poll loop
  const startedAt = Date.now()
  let lastSnapshot = snapshot(u0)
  let lastEventCount = 0

  while (Date.now() - startedAt < POLL_MAX_DURATION_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))

    try {
      const r = await db.query(
        `SELECT * FROM user WHERE email = $email LIMIT 1`,
        { email }
      )
      const u = r?.[0]?.[0]
      if (!u) {
        console.warn('Utilisateur disparu en cours de poll. Sortie.')
        break
      }
      const snap = snapshot(u)
      if (snap !== lastSnapshot) {
        console.log(`[${fmtDate(new Date())}] CHANGEMENT :`)
        console.log('  ' + snap)
        lastSnapshot = snap
      } else {
        process.stdout.write('.')
      }

      // Compter les events Stripe traités (indice que le webhook a bien tourné)
      const eventsResult = await db.query(
        `SELECT count() AS total FROM stripe_events_processed GROUP ALL`
      )
      const eventCount = eventsResult?.[0]?.[0]?.total || 0
      if (eventCount !== lastEventCount) {
        console.log(`\n[${fmtDate(new Date())}] events Stripe traités : ${eventCount} (+${eventCount - lastEventCount})`)
        lastEventCount = eventCount
      }

      // Critère de succès : subscription_status === 'active' + trial_status === 'converted'
      if (u.subscription_status === 'active' && u.trial_status === 'converted') {
        console.log(`\n[${fmtDate(new Date())}] SUCCÈS — abonnement actif.`)
        console.log('\nRécap final :')
        console.log('  email                  ' + u.email)
        console.log('  plan                   ' + u.plan)
        console.log('  plan_billing_cycle     ' + u.plan_billing_cycle)
        console.log('  subscription_status    ' + u.subscription_status)
        console.log('  trial_status           ' + u.trial_status)
        console.log('  current_period_end     ' + fmtDate(u.current_period_end))
        console.log('  stripe_customer_id     ' + (u.stripe_customer_id || '—'))
        console.log('  stripe_subscription_id ' + (u.stripe_subscription_id || '—'))
        console.log('  siret                  ' + (u.siret || '—'))
        console.log('  raison_sociale         ' + (u.raison_sociale || '—'))
        console.log('\nTests post-Checkout à valider :')
        console.log('  - Email subscription_activated reçu (vérifier inbox)')
        console.log(`  - GET ${APP_URL}/account/billing affiche le plan`)
        console.log(`  - POST /api/contacts ne renvoie plus 402 (mutations débloquées)`)
        console.log(`  - Customer Portal accessible via "Gérer mon abonnement"`)
        await db.close()
        process.exit(0)
      }
    } catch (e) {
      console.warn('\n[poll] erreur :', e.message)
    }
  }

  console.log(`\nTimeout après ${POLL_MAX_DURATION_MS / 60000} min sans bascule active. Vérifier :`)
  console.log('  - Webhook Stripe correctement configuré (URL + signing secret)')
  console.log('  - Logs Railway pour les erreurs côté webhookHandler')
  console.log('  - Stripe Dashboard → Developers → Events pour voir si le webhook a été tenté')
  await db.close()
  process.exit(2)
}

main().catch(e => {
  console.error('Erreur fatale :', e.message)
  process.exit(1)
})
