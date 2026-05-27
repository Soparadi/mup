// scripts/audit-stripe-customers.js
//
// LECTURE SEULE (DB + Stripe) — audite tous les stripe_customer_id présents en
// base et vérifie auprès de Stripe (mode de la clé STRIPE_SECRET_KEY active)
// si chacun est valide ou périmé.
//
// Contexte : après bascule Stripe TEST → LIVE, les customer_id créés en Test
// deviennent invalides (« No such customer … exists in test mode »). Ce script
// recense qui est concerné, SANS rien modifier.
//
// Classement :
//   VALIDE_LIVE  : stripe.customers.retrieve OK (non supprimé)  → rien à faire
//   PERIME_TEST  : erreur Stripe resource_missing               → à purger
//   ERREUR_AUTRE : autre erreur (ou customer supprimé)          → investiguer
//
// Garanties : aucun UPDATE DB, aucun create/delete Stripe (retrieve only).
// Throttle 150 ms entre chaque retrieve (~7 req/s, sous le rate limit 100/s).
//
// Usage local   : node scripts/audit-stripe-customers.js
// Usage Railway : railway run node scripts/audit-stripe-customers.js

import 'dotenv/config'
import { Surreal } from 'surrealdb'
import Stripe from 'stripe'

const THROTTLE_MS = 150

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
function pad(s, n) { s = String(s ?? ''); return s.length >= n ? s : s + ' '.repeat(n - s.length) }

// ── SurrealDB (mêmes vars que reset-stripe-customer-ids.js) ──
const db = new Surreal()
const url = process.env.SURREAL_URL
const ns = process.env.SURREAL_NAMESPACE
const dbName = process.env.SURREAL_DATABASE
const dbUser = process.env.SURREAL_USER
const dbPass = process.env.SURREAL_PASS

if (!url || !ns || !dbName || !dbUser || !dbPass) {
  console.error('Variables SURREAL_* manquantes dans .env')
  process.exit(1)
}

// ── Stripe (lecture seule) ──
const stripeKey = process.env.STRIPE_SECRET_KEY
if (!stripeKey) {
  console.error('STRIPE_SECRET_KEY manquante')
  process.exit(1)
}
const stripe = new Stripe(stripeKey, { apiVersion: '2024-06-20' })
const stripeMode = stripeKey.startsWith('sk_live_') ? 'LIVE'
                 : stripeKey.startsWith('sk_test_') ? 'TEST' : 'INCONNU'

console.log(`Connexion à ${url}`)
console.log(`Namespace : ${ns} · Database : ${dbName}`)
console.log(`Clé Stripe : mode ${stripeMode}\n`)

await db.connect(url, {
  namespace: ns,
  database: dbName,
  authentication: { namespace: ns, username: dbUser, password: dbPass }
})

// 1. SELECT — tous les users avec un stripe_customer_id posé
const res = await db.query(
  `SELECT id, email, stripe_customer_id, subscription_status, plan, trial_status
   FROM user WHERE stripe_customer_id != NONE`
)
const users = res?.[0] || []
console.log(`Utilisateurs avec stripe_customer_id : ${users.length}\n`)

if (users.length === 0) {
  console.log('Rien à auditer. Sortie.')
  await db.close()
  process.exit(0)
}

// 2. Pour chaque user : retrieve Stripe (lecture seule) + classement
const rows = []
const errorsDetail = []
const counts = { VALIDE_LIVE: 0, PERIME_TEST: 0, ERREUR_AUTRE: 0 }

for (const u of users) {
  const cid = u.stripe_customer_id
  let statut, categorie, action
  try {
    const cust = await stripe.customers.retrieve(cid)
    if (cust && cust.deleted) {
      statut = 'SUPPRIMÉ'; categorie = 'ERREUR_AUTRE'; action = 'investiguer'
      errorsDetail.push(`${u.email} (${cid}) : customer supprimé côté Stripe (deleted:true)`)
    } else {
      statut = 'valide'; categorie = 'VALIDE_LIVE'; action = 'rien'
    }
  } catch (err) {
    const code = err?.code || err?.raw?.code
    if (code === 'resource_missing') {
      statut = 'resource_missing'; categorie = 'PERIME_TEST'; action = 'à purger'
    } else {
      statut = 'ERREUR'; categorie = 'ERREUR_AUTRE'; action = 'investiguer'
      errorsDetail.push(`${u.email} (${cid}) : ${err?.type || 'Error'} — ${err?.message || String(err)}`)
    }
  }
  counts[categorie]++
  rows.push({ email: u.email, cid, statut, sub: u.subscription_status ?? '—', plan: u.plan ?? '—', action })
  await sleep(THROTTLE_MS)
}

// 3. Tableau récap
const W = { email: 30, cid: 22, statut: 17, sub: 12, plan: 10, action: 11 }
const sep = '|' + Object.values(W).map(w => '-'.repeat(w + 2)).join('|') + '|'
console.log(
  '| ' + pad('email', W.email) + ' | ' + pad('customer_id', W.cid) + ' | ' +
  pad('statut Stripe', W.statut) + ' | ' + pad('sub DB', W.sub) + ' | ' +
  pad('plan DB', W.plan) + ' | ' + pad('action', W.action) + ' |'
)
console.log(sep)
for (const r of rows) {
  console.log(
    '| ' + pad(r.email, W.email) + ' | ' + pad(r.cid, W.cid) + ' | ' +
    pad(r.statut, W.statut) + ' | ' + pad(r.sub, W.sub) + ' | ' +
    pad(r.plan, W.plan) + ' | ' + pad(r.action, W.action) + ' |'
  )
}

// 4. Synthèse
console.log('')
console.log(`Récap (mode Stripe ${stripeMode}) :`)
console.log(`  VALIDE_LIVE  : ${counts.VALIDE_LIVE}  (rien à faire)`)
console.log(`  PERIME_TEST  : ${counts.PERIME_TEST}  (à purger)`)
console.log(`  ERREUR_AUTRE : ${counts.ERREUR_AUTRE}  (investiguer)`)

if (counts.PERIME_TEST > 0) {
  console.log('\nÀ purger (customer_id introuvables en mode courant) :')
  rows.filter(r => r.action === 'à purger').forEach(r => console.log(`  - ${r.email} → ${r.cid}`))
}
if (errorsDetail.length > 0) {
  console.log('\nDétail erreurs/cas à investiguer :')
  errorsDetail.forEach(e => console.log(`  - ${e}`))
}

await db.close()
process.exit(0)
