// REPRISE DES CARTES DONT `contact` RÉPÈTE LA RAISON SOCIALE.
//
// migrateCard versait `name` dans `contact` à chaque lecture de fiche, et la
// carte repartait en base avec la valeur versée. Sur les cartes dont `name`
// portait la société, `contact` porte donc une raison sociale là où l'écran
// attend une personne. Le versement est arrêté (79b8efe, les quatre
// migrateCard) : la reprise peut avoir lieu.
//
// PRÉDICAT, trois conditions CUMULATIVES. Une carte n'entre dans la population
// que si les trois tiennent :
//   1. `contact` est renseigné ET répète la société portée par la carte
//      (comparaison normalisée, la même qu'au relevé
//      diag-lot-personne-saisie2.mjs : société = `co`, sinon `company`, sinon
//      `enseigne`) ;
//   2. le SIRET de la carte trouve sa ligne dans referentiel_societes, et
//      cette ligne porte un code de catégorie juridique non vide ;
//   3. ce code n'est PAS de niveau 1.
//
// LE NIVEAU 1 sort les entrepreneurs individuels sans regarder la forme de la
// chaîne. Chez eux la raison sociale EST le patronyme : un `contact` qui
// répète la société n'y est pas une erreur de versement, c'est la réalité de
// la fiche. Le code du référentiel tranche ce que la lecture de la chaîne ne
// peut pas trancher. 122 cartes sortent par là.
//
// LA JOINTURE EST PAR SIRET, et par lui seul. Aucun repli par SIREN : un SIREN
// couvre plusieurs établissements, dont la catégorie juridique servie ne serait
// pas forcément celle de l'établissement porté par la carte. Une carte sans
// SIRET, ou dont le SIRET ne trouve rien au référentiel, n'est pas touchée :
// elle sort de la population faute de code, jamais par supposition.
//
// EXCLUSION NOMINATIVE : le code 2210 est écarté de la reprise. La raison
// sociale d'un tel groupement entre personnes physiques est fréquemment la
// juxtaposition des patronymes des associés : un `contact` qui la répète peut
// y être une personne réelle, et la reprise se tromperait. Une carte est
// concernée. Elle est journalisée nominativement à la sortie, avec son motif,
// et se corrige à la main.
//
// VALEUR ÉCRITE : `contact` reçoit la chaîne vide, par UPDATE ... SET, une
// carte à la fois. Jamais CONTENT, qui remplacerait la fiche entière ; jamais
// la route PUT, qui rejouerait migrateCard sur le chemin. Aucune autre clé
// n'est écrite : ni `name`, ni `co`, ni `company`. Aucune découpe en prénom et
// nom : la reprise vide une case mal remplie, elle n'en remplit pas d'autres.
//
// LES 19 CARTES À CONTACT VIDE NE SONT PAS TOUCHÉES. Elles sortent par la
// condition 1, qui exige `contact` renseigné. Leur compte sert de garde.
//
// SEPT GARDES DE POPULATION, toutes obligatoires, toutes avant la première
// écriture. Si l'une cède, RIEN ne s'écrit : un écart signifie que la base a
// bougé depuis le relevé arbitré, et la reprise ne s'exécute pas sur une
// population qu'elle n'a pas vue.
//   G1  les candidats des trois conditions comptent exactement CANDIDATS ;
//   G2  la population, exclusion faite, compte exactement ATTENDU ;
//   G3  exactement une carte est écartée au titre du code 2210 ;
//   G4  aucune carte de la population ne porte un code de niveau 1 ;
//   G5  les cartes à contact vide comptent exactement VIDES, et aucune d'entre
//       elles n'est entrée dans la population ;
//   G6  le total de la table tient dans sa tolérance, TOTAL ± MARGE. Les deux
//       gardes de comptage exact ne disent rien de ce qui s'est créé à côté :
//       une table qui a beaucoup bougé depuis le relevé n'est plus la table
//       arbitrée, même si la population, elle, retombe sur ses pieds. La borne
//       est une fourchette et non une égalité : des cartes naissent au fil de
//       l'usage, et cela n'invalide pas le relevé ;
//   G7  aucune carte de la population ne porte `prenom` ou `nom_personne`. Ces
//       deux cases sont l'autorité sur la personne d'une carte. Une carte qui
//       les porte a été vue et saisie sur ce plan : son `contact` n'est plus le
//       résidu d'un versement automatique, et la reprise n'a pas à en juger.
//       Une seule suffit à tout arrêter, et elle est journalisée nominativement.
// S'y ajoute, à l'écriture, une relecture de chaque carte juste avant son
// UPDATE : la carte qui a quitté le prédicat depuis le SELECT est écartée, une
// saisie de l'abonné prime sur la reprise.
//
// À BLANC PAR DÉFAUT. L'écriture demande --ecrire.
import 'dotenv/config'
process.env.SURREAL_NAMESPACE = process.env.SURREAL_NAMESPACE || process.env.SURREAL_NS
process.env.SURREAL_DATABASE  = process.env.SURREAL_DATABASE  || process.env.SURREAL_DB

const EXPECTED_HOST = 'movup-prod-06fnm71lqlp2tfukdsfg07183o.aws-euw1.surreal.cloud'
if (!process.env.SURREAL_URL?.includes(EXPECTED_HOST) && process.env.ALLOW_ANY_HOST !== '1') {
  console.error('[reprise] REFUS : SURREAL_URL ne pointe pas sur movup-prod.'); process.exit(1)
}
const { getDb, close } = await import('../lib/surreal.js')

const ECRIRE = process.argv.includes('--ecrire')
// Constantes arbitrées sur les deux passages à blanc du 29 août, pris à quatre
// minutes d'intervalle après l'arrêt du versement, et identiques ligne pour
// ligne. Les valeurs de la phase 2 (72 / 71 / 28) ont été relevées AVANT cet
// arrêt : migrateCard versait encore, neuf cartes ont quitté le contact vide et
// le prédicat s'est élargi de 97 à 203 répétitions pendant l'intervalle.
const CANDIDATS = 81   // les trois conditions, exclusion non faite
const ATTENDU   = 80   // la population, code 2210 écarté
const VIDES     = 19   // cartes à contact vide, intouchées
const TOTAL     = 517  // total de la table au relevé
const MARGE     = 10   // tolérance sur ce total, en plus comme en moins
const CODE_EXCLU = '2210'

const first = (r) => (Array.isArray(r) ? r[0] : r) || []
const t = (v) => String(v == null ? '' : v).trim()
const norm = (v) => t(v).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()
const localId = (id) => (id && typeof id === 'object' && id.id != null ? String(id.id) : String(id || '')).replace(/^pipeline:/, '')
const societeDe = (c) => t(c.co) || t(c.company) || t(c.enseigne)
const niveau1 = (code) => t(code).startsWith('1')

const personne = (c) => t(c.prenom) || t(c.nom_personne)

// LE TAMIS, en une fonction, pour être rejoué mot pour mot après l'écriture.
// Le contrôle d'après-passe ne vaut que s'il applique le MÊME prédicat que
// celui qui a désigné la population : un recompte approximatif ne prouve rien.
// Il repart d'une lecture fraîche de la table et refait la jointure.
async function tamiser(db) {
  const rows = first(await db.query('SELECT id, contact, name, co, company, enseigne, siret, prenom, nom_personne FROM pipeline'))

  // Condition 1 seule. Le compte des cartes à contact vide est prélevé ici, sur
  // la même lecture, pour que la garde G5 porte sur le même instant.
  const vides = rows.filter(c => !t(c.contact))
  const repetent = rows.filter(c => t(c.contact) && societeDe(c) && norm(c.contact) === norm(societeDe(c)))

  // Conditions 2 et 3. Jointure par SIRET, par lots, pour ne pas balayer le
  // référentiel : la table porte 144k lignes et l'instance ne les agrège pas.
  const sirets = [...new Set(repetent.map(c => t(c.siret)).filter(Boolean))]
  const codes = new Map()
  for (let i = 0; i < sirets.length; i += 200) {
    const lot = sirets.slice(i, i + 200)
    for (const r of first(await db.query('SELECT siret, forme_juridique_code FROM referentiel_societes WHERE siret IN $lot', { lot }))) {
      if (t(r.forme_juridique_code)) codes.set(t(r.siret), t(r.forme_juridique_code))
    }
  }

  const candidats = []
  const sansCode = []
  const niveau1Sorties = []
  for (const c of repetent) {
    const code = codes.get(t(c.siret)) || ''
    if (!code) { sansCode.push(c); continue }
    if (niveau1(code)) { niveau1Sorties.push(c); continue }
    candidats.push({ ...c, code })
  }

  return {
    rows, vides, repetent, sansCode, niveau1Sorties, candidats,
    exclues: candidats.filter(c => c.code === CODE_EXCLU),
    population: candidats.filter(c => c.code !== CODE_EXCLU),
  }
}

try {
  const db = await getDb()
  const { rows, vides, repetent, sansCode, niveau1Sorties, candidats, exclues, population } = await tamiser(db)

  console.log((ECRIRE ? 'ÉCRITURE' : 'À BLANC') + '   ' + rows.length + ' cartes en base\n')
  console.log('TAMIS')
  console.log('  total de la table                     ' + rows.length + '   attendu ' + TOTAL + ' ± ' + MARGE)
  console.log('  contact répète la société             ' + repetent.length)
  console.log('  dont sans code au référentiel         ' + sansCode.length + '   (SIRET absent ou sans catégorie juridique, non touchées)')
  console.log('  dont code de niveau 1                 ' + niveau1Sorties.length + '   (entrepreneurs individuels, non touchées)')
  console.log('  candidats des trois conditions        ' + candidats.length + '   attendu ' + CANDIDATS)
  console.log('  écartées code ' + CODE_EXCLU + '                    ' + exclues.length)
  console.log('  POPULATION DE REPRISE                 ' + population.length + '   attendu ' + ATTENDU)
  console.log('  cartes à contact vide, intouchées     ' + vides.length + '   attendu ' + VIDES)
  console.log('  dont population portant une case de personne  ' + population.filter(personne).length + '   attendu 0\n')

  const parCode = new Map()
  for (const c of population) parCode.set(c.code, (parCode.get(c.code) || 0) + 1)
  console.log('RÉCAPITULATIF PAR CODE DE CATÉGORIE JURIDIQUE')
  for (const [code, n] of [...parCode.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    console.log('  ' + code + '   ' + n)
  }
  console.log('  total ' + population.length + '\n')

  console.log('ÉCARTÉES NOMINATIVEMENT, CODE ' + CODE_EXCLU)
  if (!exclues.length) console.log('  aucune')
  for (const c of exclues) {
    console.log('  ' + localId(c.id) + '   contact « ' + t(c.contact) + ' »   société « ' + societeDe(c) + ' »   siret ' + t(c.siret))
    console.log('    motif : groupement entre personnes physiques, dont la raison sociale est fréquemment')
    console.log('            la juxtaposition des patronymes des associés. Correction à la main.')
  }
  console.log('')

  console.log('POPULATION, CARTE PAR CARTE')
  for (const c of population) {
    console.log('  ' + localId(c.id) + '   code ' + c.code + '   siret ' + t(c.siret))
    console.log('    contact actuel   « ' + t(c.contact) + ' »   devient « »')
    console.log('    société          « ' + societeDe(c) + ' »')
    console.log('    name             « ' + t(c.name) + ' »   (non touché)')
    console.log('    prenom « ' + t(c.prenom) + ' »   nom_personne « ' + t(c.nom_personne) + ' »   (non touchés)')
  }
  console.log('')

  const cedees = []
  if (candidats.length !== CANDIDATS) cedees.push('G1 candidats ' + candidats.length + ', attendu ' + CANDIDATS)
  if (population.length !== ATTENDU) cedees.push('G2 population ' + population.length + ', attendu ' + ATTENDU)
  if (exclues.length !== 1) cedees.push('G3 écartées code ' + CODE_EXCLU + ' : ' + exclues.length + ', attendu 1')
  const fuiteNiveau1 = population.filter(c => niveau1(c.code))
  if (fuiteNiveau1.length) cedees.push('G4 ' + fuiteNiveau1.length + ' carte(s) de niveau 1 dans la population')
  const idsVides = new Set(vides.map(c => localId(c.id)))
  const fuiteVide = population.filter(c => idsVides.has(localId(c.id)))
  if (vides.length !== VIDES) cedees.push('G5 contact vide ' + vides.length + ', attendu ' + VIDES)
  if (fuiteVide.length) cedees.push('G5 ' + fuiteVide.length + ' carte(s) à contact vide dans la population')
  if (Math.abs(rows.length - TOTAL) > MARGE) cedees.push('G6 total de la table ' + rows.length + ', hors de ' + TOTAL + ' ± ' + MARGE)
  const fuitePersonne = population.filter(personne)
  if (fuitePersonne.length) cedees.push('G7 ' + fuitePersonne.length + ' carte(s) de la population portant prenom ou nom_personne')

  if (fuitePersonne.length) {
    console.log('CARTES DE LA POPULATION PORTANT UNE CASE DE PERSONNE, G7')
    for (const c of fuitePersonne) {
      console.log('  ' + localId(c.id) + '   prenom « ' + t(c.prenom) + ' »   nom_personne « ' + t(c.nom_personne) + ' »')
      console.log('    contact « ' + t(c.contact) + ' »   société « ' + societeDe(c) + ' »')
    }
    console.log('')
  }

  console.log('GARDES DE POPULATION')
  if (!cedees.length) console.log('  les sept tiennent.')
  for (const m of cedees) console.log('  CÈDE   ' + m)
  console.log('')

  if (!ECRIRE) {
    console.log('Passage à blanc : rien n\'a été écrit.')
  } else if (cedees.length) {
    console.log('ARRÊT : ' + cedees.length + ' garde(s) ont cédé. La base a bougé depuis le relevé.')
    console.log('Rien n\'a été écrit.')
  } else {
    let ecrites = 0, ecartees = 0
    for (const c of population) {
      const id = localId(c.id)
      // Relecture juste avant l'écriture. La carte qui a quitté le prédicat
      // depuis le SELECT est écartée : une saisie de l'abonné prime.
      const frais = first(await db.query('SELECT contact, co, company, enseigne FROM type::record("pipeline", $id)', { id }))[0]
      const motifs = []
      if (!frais) motifs.push('carte introuvable à la relecture')
      else if (!t(frais.contact)) motifs.push('contact déjà vide')
      else if (!societeDe(frais) || norm(frais.contact) !== norm(societeDe(frais))) motifs.push('contact ne répète plus la société, la saisie prime')
      if (motifs.length) {
        ecartees++
        console.log('ÉCARTÉE   ' + id + '   ' + motifs.join(' ; '))
        continue
      }
      await db.query('UPDATE type::record("pipeline", $id) SET contact = \'\'', { id })
      ecrites++
      console.log('ÉCRITE    ' + id + '   contact « ' + t(frais.contact) + ' » devient vide')
    }
    console.log('\nécrites ' + ecrites + '   écartées ' + ecartees + '   sur ' + population.length)

    // CONTRE-ÉPREUVE : le tamis entier rejoué sur une lecture fraîche, par la
    // même fonction et le même prédicat. Le travail n'est fait que si le tamis
    // ne trouve plus de candidat : zéro. Le compte des écartées est retranché
    // des attendus, une carte non écrite étant restée dans sa population.
    const ap = await tamiser(db)
    const l = (nom, avant, apres, attendu) =>
      console.log('  ' + nom.padEnd(30) + String(avant).padStart(4) + ' avant  ' + String(apres).padStart(4) + ' après   attendu ' + attendu +
                  (apres === attendu ? '' : '   ÉCART'))
    console.log('\nCONTRÔLE DE POPULATION, LE TAMIS REJOUÉ')
    l('total de la table', rows.length, ap.rows.length, rows.length)
    l('contact répète la société', repetent.length, ap.repetent.length, repetent.length - ecrites)
    l('dont code de niveau 1', niveau1Sorties.length, ap.niveau1Sorties.length, niveau1Sorties.length)
    l('candidats des trois conditions', candidats.length, ap.candidats.length, ecartees + exclues.length)
    l('écartées code ' + CODE_EXCLU, exclues.length, ap.exclues.length, exclues.length)
    l('POPULATION DE REPRISE', population.length, ap.population.length, ecartees)
    l('contact vide', vides.length, ap.vides.length, vides.length + ecrites)
    if (ap.population.length) {
      console.log('\n  cartes encore dans la population :')
      for (const c of ap.population) console.log('    ' + localId(c.id) + '   contact « ' + t(c.contact) + ' »')
    }
  }
} finally { await close() }
