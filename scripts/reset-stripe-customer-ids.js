// scripts/reset-stripe-customer-ids.js
//
// One-shot — UPDATE user SET stripe_customer_id = NONE pour tous les users
// dont le champ est posé. Utilisé pour repartir d'une base propre lors des
// tests Stripe (ex. après changement de mode Test/Live, ou après bascule de
// compte Stripe).
//
// Lecture-écriture ciblée : seul stripe_customer_id est touché. Les autres
// champs (subscription_status, plan, trial_status, etc.) ne sont PAS modifiés.
//
// Usage : node scripts/reset-stripe-customer-ids.js

import 'dotenv/config'
import { Surreal } from 'surrealdb'

const db = new Surreal()
const url = process.env.SURREAL_URL
const ns = process.env.SURREAL_NAMESPACE
const dbName = process.env.SURREAL_DATABASE
const user = process.env.SURREAL_USER
const pass = process.env.SURREAL_PASS

if (!url || !ns || !dbName || !user || !pass) {
  console.error('Variables SURREAL_* manquantes dans .env')
  process.exit(1)
}

console.log(`Connexion à ${url}`)
console.log(`Namespace : ${ns} · Database : ${dbName}\n`)

await db.connect(url, {
  namespace: ns,
  database: dbName,
  authentication: { namespace: ns, username: user, password: pass }
})

// 1. Compter avant
const before = await db.query(
  `SELECT count() AS total FROM user WHERE stripe_customer_id != NONE GROUP ALL`
)
const beforeTotal = before?.[0]?.[0]?.total || 0
console.log(`Utilisateurs avec stripe_customer_id défini : ${beforeTotal}`)

if (beforeTotal === 0) {
  console.log('Rien à réinitialiser. Sortie.')
  await db.close()
  process.exit(0)
}

// 2. Reset
console.log('\nReset en cours...')
const updateResult = await db.query(
  `UPDATE user SET stripe_customer_id = NONE WHERE stripe_customer_id != NONE RETURN BEFORE`
)
const updated = (updateResult?.[0] || []).length
console.log(`  ${updated} utilisateur(s) réinitialisé(s).`)

// 3. Vérification après
const after = await db.query(
  `SELECT count() AS total FROM user WHERE stripe_customer_id != NONE GROUP ALL`
)
const afterTotal = after?.[0]?.[0]?.total || 0
console.log(`\nReste avec stripe_customer_id défini après reset : ${afterTotal}`)

await db.close()
process.exit(0)
