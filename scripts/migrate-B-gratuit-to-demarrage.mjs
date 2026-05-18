// Migration data ÉTAPE B (séquence A→B→C→D→G→F→E→H, décision 1.2).
// UPDATE user SET plan='demarrage' WHERE plan='gratuit' — aligne la
// valeur historique 'gratuit' sur la nomenclature unique doctrine.
//
// Préconditions :
//   - Étape A déployée (commit 9f2ca92) : signup pose désormais
//     plan='demarrage', donc le set 'gratuit' est stable (n'augmente
//     plus en arrière-plan pendant cette migration)
//   - Snapshot pré-B pris hors repo (/tmp/movup-snapshot-pre-B-*.json),
//     liste des 4 user.id ciblés préservée pour rollback éventuel
//
// Idempotence : relancé après succès, ne trouve plus de 'gratuit',
// log "déjà appliquée" et sort sans action.
//
// Garde-fou : si le count initial ≠ 4 (et ≠ 0), abort sans muter.
// Évite de muter un état inattendu (ex : nouveau signup intercalé).
//
// CONTRAT : UPDATE FILTRÉ par WHERE plan='gratuit'. Jamais d'UPDATE
// sans WHERE sur cette table.

import { getDb, close } from '/Users/nouvellevagu.es/Soparadi/mup/lib/surreal.js'

const EXPECTED_COUNT = 4

async function main() {
  const db = await getDb()

  console.log('=== ÉTAPE B — migration user.plan "gratuit" → "demarrage" ===')

  // Step 1 — garde-fou : compter et lister les records 'gratuit'
  const preSel = await db.query("SELECT id FROM user WHERE plan = 'gratuit'")
  const preRecords = preSel[0] || []
  const preCount = preRecords.length
  console.log('\nRecords actuellement plan=\'gratuit\' :', preCount)

  if (preCount === 0) {
    console.log('Aucun record à muter — migration déjà appliquée (idempotent). Sortie sans action.')
    return
  }
  if (preCount !== EXPECTED_COUNT) {
    console.error('ABORT — count attendu =', EXPECTED_COUNT, ', count trouvé =', preCount)
    console.error('État inattendu (probablement nouveau signup intercalé pendant la fenêtre).')
    console.error('Investiguer manuellement avant de muter. Le script ne touche RIEN.')
    process.exitCode = 1
    return
  }

  console.log('\nIds ciblés par l\'UPDATE :')
  for (const r of preRecords) console.log('  -', String(r.id))

  // Step 2 — UPDATE filtré (WHERE obligatoire — jamais d'UPDATE sans filter)
  const updateRes = await db.query("UPDATE user SET plan = 'demarrage' WHERE plan = 'gratuit'")
  const updated = updateRes[0] || []
  console.log('\nUPDATE exécuté.', updated.length, 'records mis à jour.')

  // Step 3 — distribution post-migration (attendu : demarrage=5, plus de gratuit)
  const distRes = await db.query('SELECT plan, count() AS n FROM user GROUP BY plan')
  const dist = distRes[0] || []
  console.log('\nDistribution post-migration :')
  console.log(JSON.stringify(dist, null, 2))

  // Step 4 — vérification individuelle des records mutés
  console.log('\nVérification individuelle (chaque id muté avec son nouveau plan) :')
  for (const r of updated) console.log('  -', String(r.id), '→', r.plan)
}

try {
  await main()
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  await close()
}
