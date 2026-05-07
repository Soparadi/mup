// One-shot — migration des utilisateurs créés AVANT le déploiement de la
// logique essai 14 jours. À exécuter UNE seule fois après push.
//
// Comportement :
//   UPDATE user SET
//     trial_started_at = created_at,
//     trial_ends_at = created_at + 14 jours,
//     trial_status = 'active'
//   WHERE trial_status IS NONE
//
// Les utilisateurs qui ont déjà un trial_status (signup post-déploiement,
// ou override manuel comme le compte fondateur) ne sont pas touchés.
//
// Idempotent : rejouer ne fait rien si tous les users ont trial_status.
//
// Usage :
//   node scripts/migrate-trial-status.js
//
// ⚠️ Cible la PROD (.env du repo pointe sur SurrealDB Cloud movup). Aucune
// confirmation interactive — l'opération est sûre (idempotente, lecture
// seule sur les comptes déjà migrés). Mais lire le code avant d'exécuter.

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

// 1. Compter les utilisateurs concernés AVANT
const beforeCount = await db.query(
  `SELECT count() AS total FROM user WHERE trial_status IS NONE GROUP ALL`
)
const beforeTotal = beforeCount?.[0]?.[0]?.total || 0
console.log(`Utilisateurs sans trial_status : ${beforeTotal}`)

if (beforeTotal === 0) {
  console.log('Rien à migrer. Sortie.')
  await db.close()
  process.exit(0)
}

// 2. Migration : trial_started_at = created_at, trial_ends_at = created_at + 14d
console.log('\nMigration en cours...')
const updateResult = await db.query(
  `UPDATE user SET
    trial_started_at = created_at,
    trial_ends_at = created_at + 14d,
    trial_status = 'active'
   WHERE trial_status IS NONE
   RETURN AFTER`
)
const updated = (updateResult?.[0] || []).length
console.log(`  ${updated} utilisateur(s) mis à jour.`)

// 3. Vérification APRÈS
const afterCount = await db.query(
  `SELECT count() AS total FROM user WHERE trial_status IS NONE GROUP ALL`
)
const afterTotal = afterCount?.[0]?.[0]?.total || 0
console.log(`\nReste sans trial_status après migration : ${afterTotal}`)

// 4. Échantillon des résultats
const sample = await db.query(
  `SELECT email, prenom, nom, trial_status, trial_started_at, trial_ends_at
   FROM user ORDER BY created_at DESC LIMIT 5`
)
const rows = sample?.[0] || []
if (rows.length) {
  console.log('\nÉchantillon (5 plus récents) :')
  rows.forEach(r => {
    const ends = r.trial_ends_at ? new Date(r.trial_ends_at).toISOString().slice(0, 10) : '—'
    console.log(`  ${r.email}  status=${r.trial_status || 'NONE'}  expire=${ends}`)
  })
}

await db.close()
process.exit(0)
