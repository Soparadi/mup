// REPRISE DES CARTES DONT `name` A ÉTÉ ÉCRASÉ PAR migrateCard.
//
// migrateCard réalignait `name` sur `contact` à chaque lecture de fiche, et la
// fiche repartait en base avec la valeur réécrite. La saisie d'origine de
// `name` est perdue sur les cartes ainsi reprises. L'écrasement est arrêté
// (b1ad083, 17ad975, b23f7c5, 8ccf448, 789c240) et `co` est hors d'atteinte
// des trois migrateCard : la reprise peut donc avoir lieu.
//
// POPULATION, prédicat étroit, quatre classes exclusives (comparaison
// normalisée, la même qu'au relevé diag-pipeline-name-ecrase3.mjs) :
//   A  name === contact === co        entreprises individuelles, indiscernables
//   B  name === co, name !== contact  intacte
//   C  name === contact, name !== co  ÉCRASÉE, contact non vide : la population
//   D  le reste
// Seule la classe C est reprise.
//
// VALEUR ÉCRITE : `name := co`, rien d'autre. `co` est identique à
// `societes.raison_sociale` sur 112/112, contre-épreuve déjà faite. Aucun appel
// réseau, aucune jointure, aucun recours au référentiel à l'écriture : la
// valeur est déjà sur la carte.
//
// GARDES À L'ÉCRITURE, toutes obligatoires :
//   - la population doit compter exactement ATTENDU cartes, sinon rien ne
//     s'écrit : un écart signifie que la base a bougé depuis le relevé ;
//   - `co` est relu juste avant chaque écriture, et rien ne s'écrit s'il est
//     vide ;
//   - la carte est écartée si elle a quitté la classe C entre la lecture et
//     l'écriture : une saisie de l'abonné prime.
// L'écriture est un MERGE d'une SEULE clé, `name`, un identifiant à la fois.
// `contact`, `co`, `company` et toute autre clé restent intouchés. Aucune autre
// table.
//
// À BLANC PAR DÉFAUT. L'écriture demande --ecrire.
import 'dotenv/config'
process.env.SURREAL_NAMESPACE = process.env.SURREAL_NAMESPACE || process.env.SURREAL_NS
process.env.SURREAL_DATABASE  = process.env.SURREAL_DATABASE  || process.env.SURREAL_DB
const { getDb, close } = await import('../lib/surreal.js')

const ECRIRE = process.argv.includes('--ecrire')
const ATTENDU = 112
const first = (r) => (Array.isArray(r) ? r[0] : r) || []
const t = (v) => String(v == null ? '' : v).trim()
const norm = (v) => t(v).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()
const localId = (id) => (id && typeof id === 'object' && id.id != null ? String(id.id) : String(id || '')).replace(/^pipeline:/, '')

const classe = (c) => {
  const n = norm(c.name), ct = norm(c.contact), co = norm(c.co)
  if (n === ct && n === co) return 'A'
  if (n === co && n !== ct) return 'B'
  if (n === ct && n !== co && t(c.contact)) return 'C'
  return 'D'
}
const comptes = (rows) => {
  const r = { A: 0, B: 0, C: 0, D: 0 }
  for (const c of rows) r[classe(c)]++
  return r
}

try {
  const db = await getDb()
  const rows = first(await db.query('SELECT id, name, co, contact, siret FROM pipeline'))
  const avant = comptes(rows)
  const population = rows.filter(c => classe(c) === 'C')

  console.log((ECRIRE ? 'ECRITURE' : 'A BLANC') + '   ' + rows.length + ' cartes en base')
  console.log('classes   A ' + avant.A + '   B ' + avant.B + '   C ' + avant.C + '   D ' + avant.D)
  console.log('population de reprise (classe C) : ' + population.length + '   attendu ' + ATTENDU + '\n')

  // Dix cartes de la population, `name` et `co` portés par la carte, et la
  // raison sociale du référentiel en regard. Lecture de contrôle seulement :
  // l'écriture ne s'en sert pas.
  const echantillon = population.slice(0, 10)
  const sirets = [...new Set(echantillon.map(c => t(c.siret)).filter(Boolean))]
  const soc = new Map()
  if (sirets.length) {
    for (const so of first(await db.query('SELECT raison_sociale, siret FROM societes WHERE siret IN $sirets', { sirets }))) {
      soc.set(t(so.siret), t(so.raison_sociale))
    }
  }
  console.log('DIX CARTES DE LA POPULATION')
  for (const c of echantillon) {
    const rs = soc.get(t(c.siret))
    const accord = rs == null ? 'societes: absent' : (norm(rs) === norm(c.co) ? 'accord' : 'DIVERGENCE')
    console.log('  ' + localId(c.id))
    console.log('    name actuel      « ' + t(c.name) + ' »')
    console.log('    co               « ' + t(c.co) + ' »')
    console.log('    raison_sociale   « ' + (rs == null ? '' : rs) + ' »   ' + accord)
  }
  console.log('')

  if (!ECRIRE) {
    console.log('Passage à blanc : rien n\'a été écrit.')
  } else if (population.length !== ATTENDU) {
    console.log('ARRET : la population compte ' + population.length + ' cartes, attendu ' + ATTENDU + '.')
    console.log('La base a bougé depuis le relevé. Rien n\'a été écrit.')
  } else {
    let ecrites = 0, ecartees = 0
    for (const c of population) {
      const id = localId(c.id)
      // Relecture juste avant l'écriture : `co` est-il toujours là, et la carte
      // est-elle toujours de classe C ? Une saisie survenue depuis le SELECT
      // prime sur la reprise.
      const frais = first(await db.query('SELECT name, co, contact FROM type::record("pipeline", $id)', { id }))[0]
      const motifs = []
      if (!frais) motifs.push('carte introuvable à la relecture')
      else {
        if (!t(frais.co)) motifs.push('co vide')
        if (classe(frais) !== 'C') motifs.push('la carte a quitté la classe C depuis la lecture, la saisie prime')
      }
      if (motifs.length) {
        ecartees++
        console.log('ECARTEE   ' + id + '   ' + motifs.join(' ; '))
        continue
      }
      await db.query('UPDATE type::record("pipeline", $id) MERGE { name: $nom }', { id, nom: t(frais.co) })
      ecrites++
      console.log('ECRITE    ' + id + '   name « ' + t(frais.name) +' » devient « ' + t(frais.co) + ' »')
    }
    console.log('\nécrites ' + ecrites + '   écartées ' + ecartees + '   sur ' + population.length)

    const apres = comptes(first(await db.query('SELECT id, name, co, contact FROM pipeline')))
    console.log('\nCONTROLE DE POPULATION')
    console.log('classe C   ' + avant.C + ' avant   ' + apres.C + ' après   (attendu 0)')
    console.log('classe B   ' + avant.B + ' avant   ' + apres.B + ' après   (attendu ' + (avant.B + ATTENDU) + ')')
    console.log('classe A   ' + avant.A + ' avant   ' + apres.A + ' après   (attendu inchangé)')
    console.log('classe D   ' + avant.D + ' avant   ' + apres.D + ' après   (attendu inchangé)')
  }
} finally { await close() }
