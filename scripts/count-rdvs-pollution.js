// scripts/count-rdvs-pollution.js
//
// LECTURE SEULE — diagnostic PHASE 3.A refactor agenda.
// Compte 2 choses sur la prod SurrealDB :
//
//   1. pipeline.rdvs[] non vide          → volume à migrer vers table agenda
//   2. agenda.isFromPipeline = true       → pollution antérieure (commit 9003ff7)
//
// Aucune écriture. Sortie console uniquement.
//
// Usage : node scripts/count-rdvs-pollution.js

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

// ─────────────────────────────────────────────────────────
// Query 1 — pipeline.rdvs[] non vide
// ─────────────────────────────────────────────────────────
const q1 = await db.query(
  `SELECT count() AS total FROM pipeline WHERE array::len(rdvs ?? []) > 0 GROUP ALL`
)
const fichesAvecRdvs = q1?.[0]?.[0]?.total || 0

const q1b = await db.query(
  `SELECT math::sum(array::len(rdvs ?? [])) AS total FROM pipeline GROUP ALL`
)
const totalRdvsInline = q1b?.[0]?.[0]?.total || 0

console.log('─── Query 1 — pipeline.rdvs[] inline ───')
console.log(`Fiches avec au moins 1 rdv inline : ${fichesAvecRdvs}`)
console.log(`Total rdvs inline (toutes fiches confondues) : ${totalRdvsInline}`)

// ─────────────────────────────────────────────────────────
// Query 2 — agenda.isFromPipeline = true (pollution PHASE 2)
// ─────────────────────────────────────────────────────────
const q2 = await db.query(
  `SELECT count() AS total FROM agenda WHERE isFromPipeline = true GROUP ALL`
)
const eventsPollution = q2?.[0]?.[0]?.total || 0

console.log('\n─── Query 2 — agenda.isFromPipeline = true ───')
console.log(`Events pollués (synthétiques persistés à tort) : ${eventsPollution}`)

// ─────────────────────────────────────────────────────────
// Bonus — total events agenda (contexte)
// ─────────────────────────────────────────────────────────
const q3 = await db.query(`SELECT count() AS total FROM agenda GROUP ALL`)
const totalAgenda = q3?.[0]?.[0]?.total || 0

console.log(`\nTotal events agenda (contexte) : ${totalAgenda}`)

await db.close()
process.exit(0)
