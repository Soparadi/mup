// scripts/reset-one-stripe-customer.js
//
// One-shot CIBLÉ — purge le stripe_customer_id périmé d'UN seul utilisateur,
// identifié par email + customer_id (double condition = garde-fou : si l'ID a
// déjà changé, l'UPDATE ne touche rien).
//
// Contexte : un customer_id créé en mode Stripe TEST devient invalide quand la
// prod passe en LIVE (« No such customer … a similar object exists in test
// mode »). On remet l'utilisateur dans un état « jamais abonné » pour qu'il
// re-souscrive proprement (nouveau client Live créé au prochain Checkout).
//
// Champs réinitialisés (5, nullables) : stripe_customer_id,
// stripe_subscription_id, subscription_status, current_period_end, trial_status.
// `plan` N'EST PAS touché : schéma `TYPE string DEFAULT "demarrage"` (non-nullable,
// refuse NONE). Sa valeur par défaut "demarrage" est déjà l'état « jamais abonné ».
//
// Usage local : node scripts/reset-one-stripe-customer.js
// Usage Railway (prod) : railway run node scripts/reset-one-stripe-customer.js
// Override possible : node scripts/reset-one-stripe-customer.js <email> <customer_id>

import 'dotenv/config'
import { Surreal } from 'surrealdb'

// ── Cible (défauts ; surchargeable via argv) ──
const TARGET_EMAIL       = process.argv[2] || 'by.bf@mac.com'
const TARGET_CUSTOMER_ID = process.argv[3] || 'cus_UTaDD9BfSB5wU7'

const FIELDS = [
  'id', 'email',
  'stripe_customer_id', 'stripe_subscription_id',
  'subscription_status', 'current_period_end',
  'trial_status', 'plan'
].join(', ')

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
console.log(`Namespace : ${ns} · Database : ${dbName}`)
console.log(`Cible : email=${TARGET_EMAIL} · customer_id=${TARGET_CUSTOMER_ID}\n`)

await db.connect(url, {
  namespace: ns,
  database: dbName,
  authentication: { namespace: ns, username: user, password: pass }
})

const params = { email: TARGET_EMAIL, customerId: TARGET_CUSTOMER_ID }

// 1. SELECT avant — état actuel de l'utilisateur ciblé
const beforeRes = await db.query(
  `SELECT ${FIELDS} FROM user WHERE email = $email`,
  params
)
const beforeRows = beforeRes?.[0] || []
console.log('── AVANT ──')
console.log(JSON.stringify(beforeRows, null, 2))

if (beforeRows.length === 0) {
  console.log(`\nAucun utilisateur avec email=${TARGET_EMAIL}. Sortie (rien à purger).`)
  await db.close()
  process.exit(0)
}

const matchesCustomer = beforeRows.some(r => r.stripe_customer_id === TARGET_CUSTOMER_ID)
if (!matchesCustomer) {
  console.log(`\nL'utilisateur n'a PAS stripe_customer_id=${TARGET_CUSTOMER_ID} (déjà purgé/changé ?).`)
  console.log('La double condition ne matchera rien — aucune écriture. Sortie.')
  await db.close()
  process.exit(0)
}

// 2. UPDATE ciblé — double condition email + customer_id, reset des 6 champs
console.log('\n── PURGE en cours (email + customer_id) ──')
const updateRes = await db.query(
  `UPDATE user SET
     stripe_customer_id     = NONE,
     stripe_subscription_id = NONE,
     subscription_status    = NONE,
     current_period_end     = NONE,
     trial_status           = NONE
   WHERE email = $email AND stripe_customer_id = $customerId
   RETURN BEFORE`,
  params
)
const updatedRows = updateRes?.[0] || []
console.log(`  ${updatedRows.length} utilisateur(s) purgé(s).`)

// 3. SELECT après — confirmation
const afterRes = await db.query(
  `SELECT ${FIELDS} FROM user WHERE email = $email`,
  params
)
console.log('\n── APRÈS ──')
console.log(JSON.stringify(afterRes?.[0] || [], null, 2))

await db.close()
process.exit(0)
