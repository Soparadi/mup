// scripts/verify-optout-8c.js
//
// One-shot LECTURE SEULE — vérification de l'état des tables opt-out après la
// mise en production de la Phase 6 Étape 8 (routes API opt-out). N'écrit RIEN :
// 3 SELECT uniquement (counts + 5 dernières demandes).
//
// Env : SURREAL_URL / SURREAL_NAMESPACE / SURREAL_DATABASE / SURREAL_USER /
// SURREAL_PASS — mêmes variables que lib/surreal.js et les autres scripts.
// (Le brief 8c citait DB_HOST/DB_NAMESPACE… qui ne sont pas les noms réels.)
//
// Usage : node scripts/verify-optout-8c.js

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

// 1. Compteurs (lecture seule)
const reqCount = await db.query('SELECT count() FROM optout_request GROUP ALL')
const blkCount = await db.query('SELECT count() FROM optout_blocklist GROUP ALL')
console.log('optout_request   count :', reqCount?.[0]?.[0]?.count ?? 0)
console.log('optout_blocklist count :', blkCount?.[0]?.[0]?.count ?? 0)

// 2. 5 dernières demandes (sans champ sensible : ni email, ni hash, ni IP)
const last = await db.query(
  'SELECT id, short_ref, status, created_at, verified_at FROM optout_request ORDER BY created_at DESC LIMIT 5'
)
const rows = last?.[0] || []
console.log(`\n${rows.length} dernière(s) demande(s) optout_request :`)
for (const r of rows) {
  console.log('  -', JSON.stringify({
    id: String(r.id),
    short_ref: r.short_ref ?? null,
    status: r.status ?? null,
    created_at: r.created_at ? String(r.created_at) : null,
    verified_at: r.verified_at ? String(r.verified_at) : null
  }))
}

await db.close()
process.exit(0)
