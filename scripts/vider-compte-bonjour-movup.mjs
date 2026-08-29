// ─────────────────────────────────────────────────────────────────────────────
// JETABLE. HORS APPLICATION. Vide les données d'UN SEUL compte, sans le
// supprimer : le user, sa session et son audit_log restent en place.
//
// Il n'y a AUCUN DELETE nu dans ce fichier. Chaque suppression porte une clause
// de rattachement au compte visé, et le script refuse de démarrer si une seule
// entrée du plan en manque une.
//
// Usage :
//   node scripts/vider-compte-bonjour-movup.mjs            (passage à blanc)
//   node scripts/vider-compte-bonjour-movup.mjs --ecrire   (écriture réelle)
//
// Le passage à blanc est le défaut : sans --ecrire, aucune requête d'écriture
// n'est émise, pas même la révocation OAuth.
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config'

process.env.SURREAL_NAMESPACE = process.env.SURREAL_NAMESPACE || process.env.SURREAL_NS
process.env.SURREAL_DATABASE  = process.env.SURREAL_DATABASE  || process.env.SURREAL_DB

const ECRIRE = process.argv.includes('--ecrire')
const MODE = ECRIRE ? 'ÉCRITURE' : 'PASSAGE À BLANC'

// ── Cible ────────────────────────────────────────────────────────────────────
// uid nu (sans préfixe 'user:'), forme sous laquelle les tables SCHEMALESS
// stockent leur FK. Les tables SCHEMAFULL le reprennent via type::record.
const UID = 'kri23tva8wgveok9jlos'
const EMAIL = 'bonjour@movup.io'

// Inventaire de référence, relevé avant ce lot. Sert de garde : un écart franc
// signale qu'on ne regarde pas le compte qu'on croit.
// TOLÉRANCE ANNONCÉE : ±2 lignes par table. Le compte est vivant (une session
// ouverte peut créer un token ou une activité entre le relevé et l'exécution) ;
// au delà de 2 lignes d'écart, ce n'est plus de la dérive, c'est autre chose,
// et le script s'arrête. La tolérance ne protège rien par elle même : la
// sûreté vient de la clause WHERE, pas du compte attendu.
const TOLERANCE = 2

// ── Plan de suppression ──────────────────────────────────────────────────────
// `where` est OBLIGATOIRE et doit mentionner $uid : c'est la clause de
// rattachement, vérifiée avant toute requête par la garde structurelle.
// groupe 'liees' : pipeline, societes, contacts et lead_search sont noués par
// search_id et societe_id. Elles partent ENSEMBLE, dans une transaction unique,
// ou aucune ne part. Ne pas sortir une de ces quatre lignes du groupe.
const PLAN = [
  { table: 'pipeline',             where: 'userId  = $uid',                          attendu: 184, groupe: 'liees' },
  { table: 'societes',             where: 'userId  = $uid',                          attendu: 184, groupe: 'liees' },
  { table: 'contacts',             where: 'userId  = $uid',                          attendu: 183, groupe: 'liees' },
  { table: 'lead_search',          where: "user_id = type::record('user', $uid)",    attendu: 115, groupe: 'liees' },
  { table: 'activites',            where: 'userId  = $uid',                          attendu: 3,   groupe: 'seule' },
  { table: 'verification_token',   where: "user_id = type::record('user', $uid)",    attendu: 1,   groupe: 'seule' },
  // ownerId, pas userId : la FK de mailbox_credentials, comme dans la cascade.
  // Révocation Google AVANT le DELETE, voir plus bas.
  { table: 'mailbox_credentials',  where: 'ownerId = $uid',                          attendu: 1,   groupe: 'oauth' }
]

// Lues, jamais écrites. Affichées pour que le relevé montre ce qui survit.
const INTACTES = [
  { table: 'session',    where: "user_id = type::record('user', $uid)" },
  { table: 'audit_log',  where: "user_id = type::record('user', $uid)" }
]

const refus = (m) => { console.error('[vider] REFUS :', m); process.exit(1) }

// ── Garde d'hôte, sur le patron des diagnostics existants ────────────────────
const EXPECTED_HOST = 'movup-prod-06fnm71lqlp2tfukdsfg07183o.aws-euw1.surreal.cloud'
if (!process.env.SURREAL_URL?.includes(EXPECTED_HOST) && process.env.ALLOW_ANY_HOST !== '1') {
  refus('SURREAL_URL ne pointe pas sur movup-prod.')
}
const manquantes = ['SURREAL_URL', 'SURREAL_NAMESPACE', 'SURREAL_DATABASE', 'SURREAL_USER', 'SURREAL_PASS']
  .filter(k => !process.env[k])
if (manquantes.length) refus('variables manquantes : ' + manquantes.join(', '))

// ── Garde structurelle : aucune requête sans clause de rattachement ──────────
// Vérifiée sur le plan AVANT connexion, puis re-vérifiée sur chaque phrase SQL
// réellement construite (ceinture et bretelles : c'est la garde qui empêche
// qu'un DELETE nu sorte d'ici).
for (const p of [...PLAN, ...INTACTES]) {
  if (typeof p.where !== 'string' || !p.where.trim()) refus(`table ${p.table} sans clause de rattachement.`)
  if (!p.where.includes('$uid')) refus(`clause de ${p.table} ne porte pas sur $uid.`)
}
function phrase(verbe, p, suffixe = '') {
  const sql = `${verbe} ${p.table} WHERE ${p.where}${suffixe}`
  if (!/ WHERE .*\$uid/.test(sql)) refus(`phrase sans rattachement rejetée : ${sql}`)
  return sql
}

const { getDb, close } = await import('../lib/surreal.js')

async function compter(db, p) {
  const r = await db.query(`SELECT count() FROM ${p.table} WHERE ${p.where} GROUP ALL`, { uid: UID })
  if (!/ WHERE .*\$uid/.test(`SELECT count() FROM ${p.table} WHERE ${p.where} GROUP ALL`)) refus('comptage sans rattachement')
  return r?.[0]?.[0]?.count ?? 0
}

let sortie = 0
try {
  const db = await getDb()
  console.log(`[vider] mode : ${MODE}`)
  console.log(`[vider] hôte : ${EXPECTED_HOST}`)
  console.log(`[vider] cible : user:${UID}\n`)

  // ── Garde 1 : identité de la cible ─────────────────────────────────────────
  const u = await db.query("SELECT id, email FROM user WHERE id = type::record('user', $uid)", { uid: UID })
  const cible = u?.[0]?.[0]
  if (!cible) refus(`user:${UID} introuvable.`)
  if (String(cible.email || '').toLowerCase() !== EMAIL) {
    refus(`user:${UID} porte l'email ${cible.email}, attendu ${EMAIL}.`)
  }
  // Réciproque : l'email ne doit désigner que ce compte là.
  const parEmail = await db.query('SELECT id FROM user WHERE email = $email', { email: EMAIL })
  const ids = (parEmail?.[0] || []).map(r => String(r.id))
  if (ids.length !== 1 || !ids[0].includes(UID)) {
    refus(`${EMAIL} ne résout pas exactement user:${UID} (${ids.join(', ') || 'aucun'}).`)
  }
  console.log(`identité      : user:${UID} = ${cible.email}  ✅`)

  // ── Garde 2 : les comptes par table collent à l'inventaire ─────────────────
  console.log(`\nRelevé par table (tolérance annoncée ±${TOLERANCE}) :\n`)
  console.log('  table                  avant   inventaire   écart   après attendu')
  let ecarts = []
  let total = 0
  for (const p of PLAN) {
    p.avant = await compter(db, p)
    const ecart = p.avant - p.attendu
    total += p.avant
    if (Math.abs(ecart) > TOLERANCE) ecarts.push(`${p.table} (${p.avant} vs ${p.attendu})`)
    console.log(
      '  ' + p.table.padEnd(22) +
      String(p.avant).padStart(5) +
      String(p.attendu).padStart(13) +
      (ecart === 0 ? '       0' : (ecart > 0 ? '  +' : '  ') + ecart).padStart(8) +
      '0'.padStart(16)
    )
  }
  console.log('  ' + '(total)'.padEnd(22) + String(total).padStart(5) + String(671).padStart(13))

  console.log('\nLaissé intact (lu, jamais écrit) :')
  for (const p of INTACTES) {
    console.log('  ' + p.table.padEnd(22) + String(await compter(db, p)).padStart(5) + '   inchangé')
  }
  console.log('  ' + 'user'.padEnd(22) + '    1   inchangé (aucun DELETE user dans ce script)')
  console.log("  le référentiel mutualisé n'est jamais touché : aucune table sans rattachement au compte.")

  if (ecarts.length) refus('écart au delà de la tolérance : ' + ecarts.join(', '))
  console.log(`\ncomptes       : conformes à l'inventaire, tolérance ±${TOLERANCE}  ✅`)

  // ── mailbox_credentials : état de la révocation ────────────────────────────
  const { isGoogleReady } = await import('../lib/oauth-google.js')
  const cr = await db.query('SELECT provider, refreshToken FROM mailbox_credentials WHERE ownerId = $uid', { uid: UID })
  const creds = cr?.[0] || []
  const google = creds.filter(c => c?.provider === 'google' && c.refreshToken)
  console.log(`\nmailbox_credentials : ${creds.length} ligne(s), dont ${google.length} google avec refresh_token`)
  console.log(`  OAuth Google configuré dans cet environnement : ${isGoogleReady() ? 'oui' : 'NON'}`)
  if (!isGoogleReady() && google.length) {
    console.log('  ⚠️ sans GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI, la révocation échouera et sera rapportée nommément ;')
    console.log("     le DELETE aboutira quand même (art. 17 : une révocation en échec ne bloque pas l'effacement).")
  }

  if (!ECRIRE) {
    console.log('\n[vider] PASSAGE À BLANC : aucune écriture émise, aucune révocation appelée.')
    console.log('[vider] Relancer avec --ecrire pour exécuter le plan ci dessus.')
    await close(); process.exit(0)
  }

  // ══ ÉCRITURE ═══════════════════════════════════════════════════════════════
  console.log('\n[vider] ÉCRITURE.\n')

  // 1. Révocation Google AVANT le DELETE, sur le patron exact de
  // deleteUserCascade : chaque échec attrapé individuellement, jamais bloquant,
  // et rapporté nommément à la fin.
  const { decryptMailToken } = await import('../lib/crypto.js')
  const { revokeRefreshToken } = await import('../lib/oauth-google.js')
  const revocations = []
  for (const [i, cred] of google.entries()) {
    try {
      const plain = decryptMailToken(cred.refreshToken)
      const ok = await revokeRefreshToken(plain)
      revocations.push({ rang: i + 1, ok, motif: ok ? null : 'revokeRefreshToken a rendu false' })
    } catch (e) {
      revocations.push({ rang: i + 1, ok: false, motif: e?.message || String(e) })
    }
  }
  for (const r of revocations) {
    console.log(`  révocation google #${r.rang} : ${r.ok ? '✅ révoqué' : '❌ ÉCHEC — ' + r.motif}`)
  }

  // 2. Les quatre tables liées, dans UNE transaction : elles partent ensemble
  // ou aucune ne part. Un échec ici laisse la base intacte et arrête le script.
  const liees = PLAN.filter(p => p.groupe === 'liees')
  const tx = ['BEGIN TRANSACTION;', ...liees.map(p => phrase('DELETE', p, ' RETURN BEFORE;')), 'COMMIT TRANSACTION;'].join('\n')
  const res = await db.query(tx, { uid: UID })
  liees.forEach((p, i) => { p.supprimes = (res?.[i] || []).length })
  for (const p of liees) console.log(`  ${p.table.padEnd(22)} supprimées : ${p.supprimes}`)

  // 3. Le reste, table par table.
  for (const p of PLAN.filter(x => x.groupe !== 'liees')) {
    const r = await db.query(phrase('DELETE', p, ' RETURN BEFORE'), { uid: UID })
    p.supprimes = (r?.[0] || []).length
    console.log(`  ${p.table.padEnd(22)} supprimées : ${p.supprimes}`)
  }

  // 4. Recompte de contrôle.
  console.log('\nAprès :')
  let residu = 0
  for (const p of PLAN) {
    const apres = await compter(db, p)
    residu += apres
    console.log(`  ${p.table.padEnd(22)} reste : ${apres}`)
  }
  console.log('\nToujours en place :')
  for (const p of INTACTES) console.log(`  ${p.table.padEnd(22)} ${await compter(db, p)}`)

  const echecs = revocations.filter(r => !r.ok)
  if (echecs.length) {
    console.log(`\n⚠️ RÉVOCATION GOOGLE EN ÉCHEC sur ${echecs.length} credential(s) : ` +
      echecs.map(r => `#${r.rang} (${r.motif})`).join(', '))
    console.log('   Les lignes ont été supprimées malgré tout. Le refresh_token peut rester actif côté Google :')
    console.log('   à révoquer à la main depuis https://myaccount.google.com/permissions.')
    sortie = 2
  }
  console.log(`\n[vider] Terminé. Résidu sur le périmètre : ${residu}.`)

  await close(); process.exit(sortie)
} catch (e) {
  console.error('\n[vider] ÉCHEC :', e?.stack || e)
  try { await close() } catch {}
  process.exit(1)
}
