// ─────────────────────────────────────────────────────────────────────────────
// JETABLE. HORS APPLICATION. Supprime QUATRE enregistrements NOMMÉS, et eux
// seuls : deux évènements agenda et deux entrées de fil qui pointent une fiche
// pipeline n'ayant jamais existé, produits par la chaîne de création défaillante
// corrigée le 29 août 2026.
//
// SUPPRESSION PAR IDENTIFIANT NOMMÉ. Les quatre records sont énumérés en dur
// ci dessous. Chaque DELETE porte sur `type::record('<table>', $id)` avec $id
// lié : il n'y a AUCUN DELETE sur une clause de forme, aucun balayage de table,
// aucune requête capable d'emporter un cinquième record. Une garde relit chaque
// phrase SQL construite et refuse tout ce qui s'écarte de ce patron.
//
// Usage :
//   node scripts/nettoyer-quatre-orphelins.mjs            (passage à blanc)
//   node scripts/nettoyer-quatre-orphelins.mjs --ecrire   (écriture réelle)
//
// Le passage à blanc est le défaut : sans --ecrire, aucune requête d'écriture
// n'est émise. Le recensement des autres orphelins est fait dans les deux modes,
// il est en lecture seule et ne conduit à aucune suppression : ce script ne
// touche que les quatre records nommés, quoi qu'il trouve.
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config'

process.env.SURREAL_NAMESPACE = process.env.SURREAL_NAMESPACE || process.env.SURREAL_NS
process.env.SURREAL_DATABASE  = process.env.SURREAL_DATABASE  || process.env.SURREAL_DB

const ECRIRE = process.argv.includes('--ecrire')
const MODE = ECRIRE ? 'ÉCRITURE' : 'PASSAGE À BLANC'

// ── Les quatre cibles, en dur ────────────────────────────────────────────────
// `lien` est le champ qui porte le renvoi vers la fiche fantôme : ficheId pour
// agenda, ancrage pour activites. `attendu` est sa valeur annoncée. Les deux
// sont vérifiés avant toute écriture.
const UID = 'va9eyn24a2mhxpvzfkqs'
const FICHES = ['c1788007430644', 'c1788007596372']

const CIBLES = [
  { table: 'agenda',    id: 'f2ibzx9ecmgofo3nq7v5', lien: 'ficheId', attendu: 'c1788007430644' },
  { table: 'agenda',    id: '13t4t0cvi3nuva94zr3h', lien: 'ficheId', attendu: 'c1788007596372' },
  { table: 'activites', id: 'dymqbsseuo6b68uxsfxl', lien: 'ancrage', attendu: 'c1788007430644' },
  { table: 'activites', id: 'mct9bujg00wkwxzx0s9n', lien: 'ancrage', attendu: 'c1788007596372' }
]

const TABLES_AUTORISEES = new Set(['agenda', 'activites'])

const refus = (m) => { console.error('\n[orphelins] REFUS :', m); process.exit(1) }

// ── Garde d'hôte, sur le patron des diagnostics existants ────────────────────
const EXPECTED_HOST = 'movup-prod-06fnm71lqlp2tfukdsfg07183o.aws-euw1.surreal.cloud'
if (!process.env.SURREAL_URL?.includes(EXPECTED_HOST) && process.env.ALLOW_ANY_HOST !== '1') {
  refus('SURREAL_URL ne pointe pas sur movup-prod.')
}
const manquantes = ['SURREAL_URL', 'SURREAL_NAMESPACE', 'SURREAL_DATABASE', 'SURREAL_USER', 'SURREAL_PASS']
  .filter(k => !process.env[k])
if (manquantes.length) refus('variables manquantes : ' + manquantes.join(', '))

// ── Garde structurelle, avant connexion ──────────────────────────────────────
// Aucune cible hors des deux tables visées, aucun identifiant de forme
// inattendue, aucun doublon : la liste doit désigner quatre records distincts.
if (CIBLES.length !== 4) refus(`la liste doit contenir exactement 4 cibles, elle en contient ${CIBLES.length}.`)
const vues = new Set()
for (const c of CIBLES) {
  if (!TABLES_AUTORISEES.has(c.table)) refus(`table hors périmètre : ${c.table}.`)
  if (!/^[a-z0-9]+$/.test(c.id)) refus(`identifiant de forme inattendue : ${c.table}:${c.id}.`)
  if (!FICHES.includes(c.attendu)) refus(`${c.table}:${c.id} annonce une fiche hors des deux visées.`)
  const cle = `${c.table}:${c.id}`
  if (vues.has(cle)) refus(`cible en double : ${cle}.`)
  vues.add(cle)
}

// Fabrique la SEULE phrase de suppression que ce script sait émettre, et la
// relit : un DELETE qui ne serait pas rivé à un identifiant nommé est rejeté.
function phraseDelete(c) {
  const sql = `DELETE type::record('${c.table}', $id) RETURN BEFORE`
  const patron = /^DELETE type::record\('(agenda|activites)', \$id\) RETURN BEFORE$/
  if (!patron.test(sql)) refus(`phrase de suppression non conforme, rejetée : ${sql}`)
  return sql
}

const { getDb, close } = await import('../lib/surreal.js')

const local = (v) => String(v == null ? '' : v).replace(/^[a-z_]+:/i, '').trim()

try {
  const db = await getDb()
  const q = async (sql, params) => (await db.query(sql, params))?.[0] || []

  console.log(`\n[orphelins] mode : ${MODE}`)
  console.log(`[orphelins] hôte : ${EXPECTED_HOST}`)
  console.log(`[orphelins] cible : 4 records nommés du user ${UID}\n`)

  // ── Comptes avant ──────────────────────────────────────────────────────────
  const compter = async (t) => (await q(`SELECT count() AS n FROM ${t} GROUP ALL`))?.[0]?.n ?? 0
  const avant = { agenda: await compter('agenda'), activites: await compter('activites') }

  // ── Garde 1 : les quatre records existent, avec le bon user et le bon lien ─
  console.log('── Les quatre records, tels qu\'ils sont en base ──\n')
  for (const c of CIBLES) {
    const rows = await q(`SELECT * FROM type::record('${c.table}', $id)`, { id: c.id })
    const rec = rows?.[0]
    if (!rec) refus(`${c.table}:${c.id} introuvable — la base ne porte pas ce record.`)
    if (String(rec.userId || '') !== UID) {
      refus(`${c.table}:${c.id} porte userId=${rec.userId}, attendu ${UID}.`)
    }
    const porte = local(rec[c.lien])
    if (porte !== c.attendu) {
      refus(`${c.table}:${c.id} porte ${c.lien}=${rec[c.lien]}, attendu ${c.attendu}.`)
    }
    c.record = rec
    console.log(`  ${c.table}:${c.id}`)
    console.log(`    ${JSON.stringify(rec, (k, v) => (v && v.constructor && v.constructor.name === 'RecordId' ? String(v) : v), 2).split('\n').join('\n    ')}`)
    console.log('')
  }
  console.log('existence + userId + lien : conformes sur les 4 records  ✅\n')

  // ── Garde 2 : aucune carte pipeline ne porte ces deux identifiants ─────────
  // Deux vérifications : par identifiant de record, et par balayage des 333
  // cartes à la recherche d'un champ qui porterait l'une des deux valeurs.
  // Si une carte est apparue depuis le relevé, l'orphelin n'en est plus un et
  // le script s'arrête sans rien écrire.
  const cartes = await q('SELECT * FROM pipeline')
  const idsCartes = new Set(cartes.map(r => local(r.id)))
  for (const f of FICHES) {
    if (idsCartes.has(f)) refus(`pipeline:${f} EXISTE désormais — ces records ne sont plus orphelins.`)
  }
  const parChamp = []
  for (const r of cartes) {
    for (const [k, v] of Object.entries(r)) {
      if (k === 'id') continue
      if (FICHES.includes(local(v))) parChamp.push(`pipeline:${local(r.id)}.${k}`)
    }
  }
  if (parChamp.length) refus(`des cartes pipeline portent ces identifiants dans un champ : ${parChamp.join(', ')}.`)
  console.log(`absence de carte  : ni pipeline:${FICHES[0]} ni pipeline:${FICHES[1]}, ni comme id ni dans un champ  ✅\n`)

  // ── Recensement, LECTURE SEULE, sans effet sur le plan ────────────────────
  // Un ancrage / ficheId est légitime s'il désigne un record de pipeline ou de
  // contacts (les deux surfaces qui écrivent le fil et l'agenda). Les deux
  // colonnes distinguent l'orphelin strict (aucune carte pipeline) de
  // l'orphelin franc (aucun record d'aucune des deux tables).
  const contacts = await q('SELECT id FROM contacts')
  const idsContacts = new Set(contacts.map(r => local(r.id)))
  const vivant = (v) => idsCartes.has(v) || idsContacts.has(v)

  console.log('── Recensement des orphelins, tous utilisateurs confondus (lecture seule) ──\n')
  const recensement = {}
  for (const [table, champ] of [['agenda', 'ficheId'], ['activites', 'ancrage']]) {
    const rows = await q(`SELECT * FROM ${table}`)
    const orphelins = []
    for (const r of rows) {
      const cle = local(r[champ])
      if (!cle) continue
      if (!vivant(cle)) orphelins.push({ id: String(r.id), user: String(r.userId || ''), cle, pipelineSeul: !idsCartes.has(cle) })
    }
    recensement[table] = orphelins
    console.log(`  ${table} : ${rows.length} lignes au total, ${orphelins.length} orpheline(s)`)
    for (const o of orphelins) {
      const vise = CIBLES.some(c => `${c.table}:${c.id}` === o.id) ? '  ← au plan' : '  ← HORS PLAN'
      console.log(`    ${o.id.padEnd(32)} user ${o.user}  ${champ}=${o.cle}${vise}`)
    }
    console.log('')
  }
  const horsPlan = [...recensement.agenda, ...recensement.activites]
    .filter(o => !CIBLES.some(c => `${c.table}:${c.id}` === o.id))
  console.log(`  total recensé : ${recensement.agenda.length} sur agenda, ${recensement.activites.length} sur activites`)
  console.log(`  dont HORS PLAN (non touchés par ce script) : ${horsPlan.length}\n`)

  // ── Comptes attendus après ────────────────────────────────────────────────
  const parTable = { agenda: CIBLES.filter(c => c.table === 'agenda').length, activites: CIBLES.filter(c => c.table === 'activites').length }
  console.log('── Comptes ──\n')
  console.log('  table         avant   supprimés   après attendu')
  for (const t of ['agenda', 'activites']) {
    console.log('  ' + t.padEnd(14) + String(avant[t]).padStart(5) + String(parTable[t]).padStart(12) + String(avant[t] - parTable[t]).padStart(16))
  }

  if (!ECRIRE) {
    console.log('\n[orphelins] PASSAGE À BLANC : aucune écriture émise.')
    console.log('[orphelins] Relancer avec --ecrire pour supprimer les 4 records nommés ci dessus.')
    await close(); process.exit(0)
  }

  // ══ ÉCRITURE ═══════════════════════════════════════════════════════════════
  // Quatre suppressions, une par identifiant nommé. Aucune transaction : les
  // quatre records sont indépendants, et un échec au troisième ne rend pas les
  // deux premiers illégitimes.
  console.log('\n[orphelins] ÉCRITURE.\n')
  let supprimes = 0
  for (const c of CIBLES) {
    const r = await q(phraseDelete(c), { id: c.id })
    const n = Array.isArray(r) ? r.length : (r ? 1 : 0)
    supprimes += n
    console.log(`  ${(c.table + ':' + c.id).padEnd(32)} supprimé : ${n}`)
  }

  console.log('\n── Contrôle après ──\n')
  for (const c of CIBLES) {
    const rows = await q(`SELECT id FROM type::record('${c.table}', $id)`, { id: c.id })
    console.log(`  ${(c.table + ':' + c.id).padEnd(32)} ${rows?.[0] ? 'ENCORE PRÉSENT ❌' : 'absent ✅'}`)
  }
  console.log('')
  console.log('  table         avant   après   attendu')
  for (const t of ['agenda', 'activites']) {
    const apres = await compter(t)
    console.log('  ' + t.padEnd(14) + String(avant[t]).padStart(5) + String(apres).padStart(8) + String(avant[t] - parTable[t]).padStart(10) +
      (apres === avant[t] - parTable[t] ? '  ✅' : '  ÉCART ❌'))
  }
  console.log(`\n[orphelins] Terminé. ${supprimes} record(s) supprimé(s) sur 4 nommés.`)

  await close(); process.exit(0)
} catch (e) {
  console.error('\n[orphelins] ÉCHEC :', e?.stack || e)
  try { await close() } catch {}
  process.exit(1)
}
