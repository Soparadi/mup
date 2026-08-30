// One-shot — approuve retroactivement les comptes anterieurs a l'approbation
// manuelle des inscriptions (lib/approbation.js). A executer une fois, AVANT
// de poser INSCRIPTION_APPROBATION=1 dans Railway.
//
// FACULTATIF, et il faut le savoir avant de le lancer. estEnAttente ecarte
// deja tout compte porteur d'un trial_started_at : les comptes existants sont
// hors d'atteinte de la porte, script ou pas, quel que soit l'ordre de
// deploiement. Ce script ne change donc RIEN a leur acces. Il pose la date
// d'approbation pour que la colonne « Acces approuve » du tableau superadmin
// se lise, plutot que de rester remplie de tirets.
//
// Comportement :
//   UPDATE user SET approved_at = created_at
//   WHERE approved_at IS NONE AND trial_started_at IS NOT NONE
//
// approved_at = created_at, et non time::now() : la date dit quand l'acces a
// ete ouvert, or il l'etait des l'inscription pour ces comptes-la. Affectation
// de champ a champ, donc datetime natif des deux cotes — aucune chaine ISO
// liee, aucune coercition a craindre.
//
// Ne touche AUCUN compte en attente : trial_started_at IS NOT NONE les ecarte.
// Un compte cree apres l'armement de la variable attend une approbation
// DECIDEE, jamais une approbation posee en bloc par un script.
//
// Idempotent : rejouer ne fait rien, la clause approved_at IS NONE ne rend
// plus personne.
//
// Usage :
//   node scripts/approuver-comptes-existants.mjs
//
// Cible la PROD (.env du repo pointe sur SurrealDB Cloud movup). Aucune
// confirmation interactive. Lire le code avant d'executer.

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

// 1. Les comptes concernés, nommés AVANT d'écrire. Un compte approuvé en bloc
//    doit pouvoir se relire dans la sortie du script, pas seulement se compter.
const avant = await db.query(
  `SELECT email, created_at FROM user
   WHERE approved_at IS NONE AND trial_started_at IS NOT NONE
   ORDER BY created_at`
)
const concernes = avant?.[0] || []
console.log(`Comptes à approuver rétroactivement : ${concernes.length}`)
for (const c of concernes) {
  const le = c.created_at ? new Date(c.created_at).toISOString().slice(0, 10) : '?'
  console.log(`  ${c.email}  (inscrit le ${le})`)
}

if (!concernes.length) {
  console.log('\nRien à approuver. Sortie.')
  await db.close()
  process.exit(0)
}

// 2. Écriture. Un SEUL champ touché.
console.log('\nApprobation en cours...')
const res = await db.query(
  `UPDATE user SET approved_at = created_at
   WHERE approved_at IS NONE AND trial_started_at IS NOT NONE
   RETURN AFTER`
)
const ecrits = (res?.[0] || []).length
console.log(`  ${ecrits} compte(s) approuvé(s).`)

// 3. Vérification APRÈS. Le reste attendu est zéro ; tout autre chiffre est un
//    échec silencieux d'écriture, pas une population résiduelle.
const apres = await db.query(
  `SELECT count() AS total FROM user
   WHERE approved_at IS NONE AND trial_started_at IS NOT NONE
   GROUP ALL`
)
const reste = apres?.[0]?.[0]?.total || 0
console.log(`\nReste sans date d'approbation, essai démarré : ${reste}`)

// 4. Les comptes réellement en attente, s'il y en a. Ce sont EUX qu'il faudra
//    approuver ou supprimer avant de vider la variable un jour : sans date de
//    fin d'essai, un compte en attente redevient un compte gratuit sans terme,
//    invisible aux relances comme à la purge.
const attente = await db.query(
  `SELECT email, created_at FROM user
   WHERE approved_at IS NONE AND trial_started_at IS NONE
   ORDER BY created_at`
)
const enAttente = attente?.[0] || []
console.log(`\nComptes en attente d'approbation : ${enAttente.length}`)
for (const c of enAttente) {
  const le = c.created_at ? new Date(c.created_at).toISOString().slice(0, 10) : '?'
  console.log(`  ${c.email}  (inscrit le ${le})`)
}

await db.close()
process.exit(0)
