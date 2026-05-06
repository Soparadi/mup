// scripts/purge-auth-data.mjs
//
// Purge les 4 tables de la couche auth Phase 1 :
//   user, session, verification_token, audit_log
//
// Usage :
//   npm run purge:auth
//
// Garde-fous :
//   - Refus si NODE_ENV=production
//   - Affichage du compte avant purge
//   - Confirmation interactive : il faut taper exactement "SUPPRIMER"
//   - Lecture des credentials depuis process.env (.env local ou Railway env)

import 'dotenv/config'
import readline from 'node:readline'
import { getDb, close } from '../lib/surreal.js'

const TABLES = ['session', 'verification_token', 'audit_log', 'user']
const CONFIRM_WORD = 'SUPPRIMER'

function prompt(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, answer => { rl.close(); resolve(answer) })
  })
}

async function countAll(db) {
  const out = {}
  for (const table of TABLES) {
    try {
      const r = await db.query(`SELECT count() FROM ${table} GROUP ALL`)
      const row = r?.[0]?.[0]
      out[table] = row?.count ?? 0
    } catch (e) {
      out[table] = `error: ${e.message}`
    }
  }
  return out
}

function printCounts(label, counts) {
  console.log(`\n${label} :`)
  for (const t of TABLES) {
    console.log(`  ${t.padEnd(20)} ${counts[t]}`)
  }
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refus d\'exécuter en production. Pour purger la base prod, utilisez Surrealist Studio manuellement.')
    process.exit(1)
  }

  const required = ['SURREAL_URL', 'SURREAL_NAMESPACE', 'SURREAL_DATABASE', 'SURREAL_USER', 'SURREAL_PASS']
  const missing = required.filter(k => !process.env[k])
  if (missing.length) {
    console.error('Variables manquantes :', missing.join(', '))
    console.error('Renseignez .env (local) ou exportez-les avant de relancer.')
    process.exit(1)
  }

  console.log('purge-auth-data — connexion à', process.env.SURREAL_URL)
  console.log('  namespace :', process.env.SURREAL_NAMESPACE)
  console.log('  database  :', process.env.SURREAL_DATABASE)
  console.log('  utilisateur :', process.env.SURREAL_USER)

  const db = await getDb()

  const before = await countAll(db)
  printCounts('Avant purge', before)

  const totalBefore = TABLES.reduce((sum, t) => sum + (typeof before[t] === 'number' ? before[t] : 0), 0)
  if (totalBefore === 0) {
    console.log('\nAucune donnée à purger. Sortie.')
    await close()
    process.exit(0)
  }

  console.log('\nLes 4 tables auth ci-dessus seront entièrement vidées.')
  console.log('Cette action est IRRÉVERSIBLE.')
  const answer = await prompt(`Tapez ${CONFIRM_WORD} en majuscules pour confirmer la purge : `)
  if (answer !== CONFIRM_WORD) {
    console.log('Annulé, aucune donnée modifiée.')
    await close()
    process.exit(0)
  }

  console.log('\nPurge en cours…')
  // Ordre : on vide d'abord les tables qui référencent user (record<user>),
  // puis user en dernier — évite tout effet de bord d'intégrité.
  for (const table of TABLES) {
    try {
      await db.query(`DELETE ${table}`)
      console.log(`  ${table} : vidée`)
    } catch (e) {
      console.error(`  ${table} : ÉCHEC — ${e.message}`)
    }
  }

  const after = await countAll(db)
  printCounts('Après purge', after)

  await close()
  process.exit(0)
}

main().catch(async (e) => {
  console.error('Erreur fatale :', e.message)
  try { await close() } catch (_) {}
  process.exit(1)
})
