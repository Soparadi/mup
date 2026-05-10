// scripts/migrate-rdvs-to-agenda.js
//
// Migration one-shot — table pipeline.rdvs[] inline → table agenda.
// Single source of truth post-refactor PHASE 3 : la table agenda devient la
// référence unique pour tous les events (RDV, visio, mail, devis, perso).
//
// Diagnostic prod (date refactor) : 2 fiches avec rdvs[] non vides, 0 event
// déjà polluant en table agenda → migration triviale, aucun cleanup préalable
// nécessaire.
//
// Idempotence : clé déterministe `pipe_<ficheId>_<rdvId>` posée sur le champ
// `key` de l'event. Si la clé existe déjà en table agenda, on skip (pas de
// doublon en cas de relance).
//
// Rollback documenté :
//   surreal sql "DELETE FROM agenda WHERE key STARTSWITH 'pipe_'"
//   surreal sql "UPDATE pipeline SET rdvs = <champ original sauvegardé>"  // pas auto
// Le script affiche les rdvs[] AVANT migration → garder le log pour rollback.
//
// Usage : node scripts/migrate-rdvs-to-agenda.js
//
// ⚠️  À EXÉCUTER UNE SEULE FOIS APRÈS DÉPLOIEMENT DU REFACTOR PHASE 3.
//     Ne PAS lancer en CI ou en automatique. Validation utilisateur obligatoire.

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

// 1. Récupère toutes les fiches pipeline avec rdvs[] non vide.
const fichesQuery = await db.query(
  `SELECT id, userId, co, name, col, rdvs FROM pipeline WHERE array::len(rdvs ?? []) > 0`
)
const fiches = fichesQuery?.[0] || []

console.log(`Fiches avec rdvs[] inline : ${fiches.length}\n`)

if (fiches.length === 0) {
  console.log('Rien à migrer. Sortie.')
  await db.close()
  process.exit(0)
}

// 2. Logue la situation AVANT migration (pour rollback manuel si besoin).
console.log('─── État AVANT migration (rollback reference) ───')
for (const fiche of fiches) {
  const ficheIdStr = String(fiche.id).replace(/^pipeline:/, '').replace(/^⟨+|⟩+$/g, '')
  console.log(`  pipeline:${ficheIdStr} (${fiche.co || fiche.name || '—'}) — ${fiche.rdvs.length} rdv(s)`)
  fiche.rdvs.forEach(r => {
    console.log(`     · ${r.id || '(no id)'} | type=${r.type || '?'} | date=${r.date || '?'} | hour=${r.hour || '?'}`)
  })
}
console.log()

// 3. Pour chaque fiche, pour chaque rdv : CREATE event agenda si pas déjà existant.
let createdCount = 0
let skippedCount = 0

for (const fiche of fiches) {
  const ficheIdStr = String(fiche.id).replace(/^pipeline:/, '').replace(/^⟨+|⟩+$/g, '')
  const userId = fiche.userId
  if (!userId) {
    console.warn(`  ⚠️  pipeline:${ficheIdStr} sans userId, skip (orphelin)`)
    continue
  }

  for (const rdv of fiche.rdvs) {
    if (!rdv || !rdv.date) { skippedCount++; continue }
    const rdvIdSafe = rdv.id || ('rdv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6))
    const key = `pipe_${ficheIdStr}_${rdvIdSafe}`

    // Idempotence : si un event avec cette key existe déjà, skip.
    const existsQ = await db.query(
      `SELECT id FROM agenda WHERE key = $key LIMIT 1`,
      { key }
    )
    const exists = existsQ?.[0]?.[0]
    if (exists) {
      console.log(`  ↩  skip (déjà migré) ${key}`)
      skippedCount++
      continue
    }

    // Reformatage : date YYYY-MM-DD + start HH:MM (cohérent avec saveRdv post-refactor)
    let dateStr = ''
    let startStr = rdv.hour || '14:00'
    try {
      const d = new Date(rdv.date)
      if (!isNaN(d.getTime())) {
        dateStr = d.getFullYear() + '-' +
                  String(d.getMonth() + 1).padStart(2, '0') + '-' +
                  String(d.getDate()).padStart(2, '0')
        if (!rdv.hour) {
          startStr = String(d.getHours()).padStart(2, '0') + ':' +
                     String(d.getMinutes()).padStart(2, '0')
        }
      }
    } catch (e) { /* skip malformed */ }
    if (!dateStr) { skippedCount++; continue }

    const [hh, mn] = startStr.split(':')
    const endHh = String(Math.min(23, (parseInt(hh, 10) || 0) + 1)).padStart(2, '0')
    const endStr = endHh + ':' + (mn || '00')

    const body = {
      userId,
      ficheId: ficheIdStr,
      key,
      date: dateStr,
      start: startStr,
      end: endStr,
      title: fiche.co || fiche.name || '',
      contact: fiche.name || '',
      type: String(rdv.type || 'rdv').toLowerCase(),
      notes: '',
      migratedFrom: 'pipeline.rdvs',
      migratedAt: new Date().toISOString()
    }

    await db.query('CREATE agenda CONTENT $body', { body })
    createdCount++
    console.log(`  ✓ créé agenda(${key})`)
  }
}

console.log(`\n─── Étape 1 terminée : ${createdCount} event(s) créé(s), ${skippedCount} skip(s) ───\n`)

// 4. Vide les rdvs[] sur les fiches migrées.
console.log('─── Étape 2 : vidage rdvs[] sur fiches migrées ───')
const updateRes = await db.query(
  `UPDATE pipeline SET rdvs = [] WHERE array::len(rdvs ?? []) > 0 RETURN id`
)
const updated = (updateRes?.[0] || []).length
console.log(`  ${updated} fiche(s) avec rdvs[] = []`)

// 5. Vérification post-migration.
console.log('\n─── Vérification ───')
const verif = await db.query(
  `SELECT count() AS total FROM pipeline WHERE array::len(rdvs ?? []) > 0 GROUP ALL`
)
const remaining = verif?.[0]?.[0]?.total || 0
console.log(`  Fiches avec rdvs[] non vide après migration : ${remaining}`)

const verifAgenda = await db.query(
  `SELECT count() AS total FROM agenda WHERE migratedFrom = 'pipeline.rdvs' GROUP ALL`
)
const agendaTotal = verifAgenda?.[0]?.[0]?.total || 0
console.log(`  Events agenda issus de la migration : ${agendaTotal}`)

await db.close()
process.exit(0)
