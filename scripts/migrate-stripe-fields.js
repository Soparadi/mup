// One-shot — vérifie que les champs Stripe sont bien définis sur la table user
// et liste les utilisateurs existants avec leurs nouveaux champs (NULL par
// défaut puisque option<...>). À exécuter UNE seule fois après push.
//
// Cible : SurrealDB Cloud prod (.env du repo). Idempotent.
//
// Note : la migration de schéma (DEFINE FIELD IF NOT EXISTS) est jouée
// automatiquement au boot du serveur via runAuthMigration(). Ce script ne
// fait que vérifier et reporter — il n'écrit rien sur les users (les nouveaux
// champs sont option<...>, leur valeur par défaut est NONE, ce qui est correct
// pour les users pre-Stripe).
//
// Usage :
//   node scripts/migrate-stripe-fields.js

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

// 1. Vérifier les définitions de champ
console.log('Champs Stripe sur table user :')
const fields = ['stripe_customer_id', 'stripe_subscription_id', 'subscription_status',
                'current_period_end', 'plan_billing_cycle', 'siret', 'raison_sociale',
                'billing_address']
const info = await db.query('INFO FOR TABLE user')
const userInfo = info?.[0] || {}
const definedFields = userInfo?.fields || {}
for (const f of fields) {
  const def = definedFields[f]
  console.log(`  ${f.padEnd(28)} ${def ? 'OK' : 'MANQUE'}`)
}

// 2. Vérifier la table stripe_events_processed
console.log('\nTable stripe_events_processed :')
try {
  const r = await db.query('SELECT count() AS total FROM stripe_events_processed GROUP ALL')
  const total = r?.[0]?.[0]?.total || 0
  console.log(`  ${total} event(s) traité(s) à ce jour`)
} catch (e) {
  console.log(`  ERREUR : ${e.message}`)
}

// 3. Échantillon users avec leurs champs Stripe
console.log('\nÉchantillon users (5 plus récents) :')
const sample = await db.query(
  `SELECT email, plan, plan_billing_cycle, subscription_status,
          stripe_customer_id, current_period_end
   FROM user ORDER BY created_at DESC LIMIT 5`
)
const rows = sample?.[0] || []
rows.forEach(r => {
  const sub = r.subscription_status || 'NONE'
  const cust = r.stripe_customer_id || '—'
  const periodEnd = r.current_period_end
    ? new Date(r.current_period_end).toISOString().slice(0, 10)
    : '—'
  console.log(`  ${r.email}  plan=${r.plan || '—'}  status=${sub}  cust=${cust}  end=${periodEnd}`)
})

await db.close()
process.exit(0)
