// Reprise de l'existant : les fiches referentiel_societes dont le champ `website`
// porte deja un hote de la liste noire. ADMINISTRATION, PAS MIGRATION : rien
// n'appelle ce fichier, il ne s'execute qu'a la main et jamais au boot.
//
// POURQUOI. Le commit precedent (hotes-exclus.js + le filtre pose dans
// enrichReferentielActionnable) ferme l'entonnoir d'ecriture : plus aucun
// website de la liste noire n'entre au referentiel. Il ne touche pas au stock
// deja ecrit, qui continue d'occuper des places dans le vivier de crawl sans
// jamais aboutir ni etre horodate. Ce script traite ce stock, et lui seul.
//
// CE QU'IL FAIT, fiche par fiche, avec la MEME lecture d'hote que le filtre
// (hoteDeSite + hostBlacklisted + champReseauPourHote, importes, jamais recopies) :
//   . hote avec champ de reseau social correspondant, ce champ VIDE en base
//     -> la valeur y est deplacee, et website est vide ;
//   . hote avec champ correspondant DEJA REMPLI -> la valeur est perdue,
//     website est vide, l'existant du champ d'accueil est preserve. C'est la
//     regle de remplissage-si-vide du referentiel, appliquee ici a l'identique ;
//   . hote sans champ d'accueil (planity, tchip, orpi, business.site : ils
//     decrivent un reseau, pas l'etablissement) -> la valeur est perdue,
//     website est vide. Aucun champ nouveau n'est cree pour les recueillir.
// Dans les trois cas website finit vide : c'est le seul effacement, et il est
// voulu.
//
// A BLANC PAR DEFAUT. Sans --ecrire, le script lit, decide, imprime, et ne pose
// pas une seule instruction d'ecriture. L'ecriture ne part que sur ce drapeau.
//
// PREMIER EFFACEMENT D'UN CHAMP DU REFERENTIEL, donc rien en une seule
// instruction : la population entiere est lue d'abord, puis ecrite par lots de
// --lot fiches (25 par defaut), une fiche a la fois, chacune par un UPDATE cible
// sur son identifiant, avec un compte rendu apres chaque lot. Aucun UPDATE de
// masse, aucun WHERE portant sur plusieurs fiches.
//
// RELECTURE AVANT CHAQUE ECRITURE. Entre la lecture de la population et
// l'ecriture d'une fiche, une saisie abonne a pu passer. La fiche est relue
// juste avant : si son website n'est plus celui qui a ete juge, elle est
// ecartee sans ecriture. Le remplissage-si-vide est en plus applique cote
// SurrealQL sur le champ d'accueil, comme partout ailleurs dans le referentiel.
//
// REMPART OPT-OUT. Une fiche sous opposition n'est pas ecrite du tout, pas meme
// pour deplacer sa valeur : le rempart interdit d'ecrire au referentiel pour ce
// SIRET, et ce script ne s'en dispense pas. Consequence assumee : ces fiches
// gardent leur website de liste noire et ressortent a chaque passage. Elles sont
// comptees a part dans le compte rendu.
//
// RELANCABLE SANS DEGAT. La selection est un predicat sur l'etat courant : une
// fiche traitee n'a plus de website, ne passe donc plus le filtre de population
// et ne ressort pas. Aucun marqueur a poser, aucun etat a conserver entre deux
// passages.
//
//   node scripts/reprise-site-liste-noire.mjs                  (a blanc)
//   node scripts/reprise-site-liste-noire.mjs --ecrire         (ecrit)
//   node scripts/reprise-site-liste-noire.mjs --lot=10 --ecrire
import 'dotenv/config'
import { getDb, close } from '../lib/surreal.js'
// Module FEUILLE, sans aucune dependance : c'est sa raison d'etre. Le script lit
// exactement les memes fonctions que le filtre d'ecriture, si bien qu'une fiche
// reprise ici est une fiche que le filtre aurait refusee, sans aucune chance de
// divergence entre les deux lectures d'hote.
import { hostBlacklisted, hoteDeSite, champReseauPourHote } from '../server/services/hotes-exclus.js'
import { checkBlocklistBatch } from '../server/services/optout.js'

const ECRIRE = process.argv.includes('--ecrire')
const argLot = process.argv.find(a => a.startsWith('--lot='))
const LOT = Math.max(1, Number(argLot ? argLot.slice(6) : 25) || 25)

// Pagination de la LECTURE. L'instance est petite : pas d'agregat serveur, pas de
// SELECT sans borne. Le champ website etant rare (833 fiches sur le referentiel),
// la population entiere tient en memoire.
const PAS = 5000

const first = (r) => (Array.isArray(r) ? r[0] : r) || []
const t = (v) => String(v == null ? '' : v).trim()
// Identifiant local du record. La cle du referentiel est le SIRET ; selon le
// pilote, id revient en objet {tb, id} ou en chaine "referentiel_societes:xxx".
const localId = (id) => (id && typeof id === 'object' && id.id != null ? String(id.id) : String(id || ''))
  .replace(/^referentiel_societes:/, '').replace(/^⟨+/, '').replace(/⟩+$/, '')

try {
  const db = await getDb()

  // ── 1. Population, lue en entier AVANT toute ecriture ──
  // Lire et ecrire en alternance sur une pagination START/LIMIT ferait glisser la
  // fenetre sous nos pieds : chaque fiche videe sort du WHERE et decale les
  // suivantes, qui seraient sautees. La lecture est donc close avant que la
  // premiere ecriture ne parte.
  const population = []
  let lues = 0
  for (let start = 0; ; start += PAS) {
    const lignes = first(await db.query(
      'SELECT id, siret, website, societe_facebook, societe_instagram, societe_linkedin ' +
      "FROM referentiel_societes WHERE website != NONE AND website != '' " +
      `LIMIT ${PAS} START ${start}`
    ))
    if (!lignes.length) break
    lues += lignes.length
    for (const f of lignes) {
      const site = t(f.website)
      if (!site) continue
      const hote = hoteDeSite(site)
      // hostBlacklisted('') vaut true : un website illisible tombe par la meme
      // porte que la liste noire, fail-closed, exactement comme a l'ecriture.
      if (!hostBlacklisted(hote)) continue
      population.push({ f, site, hote, champ: champReseauPourHote(hote) })
    }
    if (lignes.length < PAS) break
  }

  console.log(
    '\n' + (ECRIRE ? 'ECRITURE' : 'A BLANC') +
    '   fiches avec site ' + lues +
    '   population ' + population.length +
    '   lots de ' + LOT + '\n'
  )

  // ── 2. Traitement par lots ──
  const total = { deplacees: 0, perdues: 0, occupees: 0, opposition: 0, ecartees: 0 }
  const parHote = new Map()

  for (let i = 0; i < population.length; i += LOT) {
    const lot = population.slice(i, i + LOT)
    const noLot = Math.floor(i / LOT) + 1
    const nbLots = Math.ceil(population.length / LOT)
    console.log('LOT ' + noLot + '/' + nbLots + '   fiches ' + (i + 1) + ' a ' + (i + lot.length))

    // Rempart opt-out, un appel par lot. FAIL-CLOSED en amont : toute erreur DB
    // fait rendre a checkBlocklistBatch le lot entier comme bloque, donc rien ne
    // s'ecrit. C'est le comportement voulu.
    const bloques = await checkBlocklistBatch(lot.map(x => t(x.f.siret) || localId(x.f.id)))

    const lotCr = { deplacees: 0, perdues: 0, occupees: 0, opposition: 0, ecartees: 0 }
    for (const { f, site, hote, champ } of lot) {
      const id = localId(f.id)
      const siret = t(f.siret) || id
      const cle = (hote || '(illisible)')
      parHote.set(cle, (parHote.get(cle) || 0) + 1)

      if (bloques.has(siret)) {
        lotCr.opposition++
        console.log('  OPPOSITION  ' + cle.padEnd(34) + ' ' + siret + '   sous opt-out, aucune ecriture')
        continue
      }

      // Etat du champ d'accueil AU MOMENT DE LA LECTURE. Le verdict imprime est
      // celui-ci ; la relecture ci-dessous ne fait que couvrir la course.
      const accueilOccupe = champ ? !!t(f[champ]) : false
      const verdict = !champ ? 'PERDUE' : (accueilOccupe ? 'OCCUPEE' : 'DEPLACEE')
      const dit =
        verdict === 'DEPLACEE' ? 'site -> ' + champ + ', site vide'
        : verdict === 'OCCUPEE' ? champ + ' deja rempli (« ' + t(f[champ]) + ' »), valeur perdue, site vide'
        : 'aucun champ d\'accueil, valeur perdue, site vide'

      if (ECRIRE) {
        // Relecture juste avant l'ecriture : le website juge est-il toujours
        // celui en base ? Une saisie abonne survenue entre la lecture de la
        // population et maintenant prime, et la fiche est laissee intacte.
        const frais = first(await db.query(
          'SELECT website, societe_facebook, societe_instagram, societe_linkedin ' +
          'FROM type::record("referentiel_societes", $id)', { id }
        ))[0]
        if (!frais || t(frais.website) !== site) {
          lotCr.ecartees++
          console.log('  ECARTEE     ' + cle.padEnd(34) + ' ' + siret + '   le site a change depuis la lecture, la saisie prime')
          continue
        }
        // UPDATE cible sur l'identifiant, une fiche a la fois, jamais un WHERE de
        // masse. Le champ d'accueil garde le remplissage-si-vide SurrealQL du
        // referentiel : un remplissage concurrent gagne, et seul website est vide
        // inconditionnellement. Record absent -> 0 ligne modifiee, no-op.
        if (champ && !t(frais[champ])) {
          await db.query(
            'UPDATE type::record("referentiel_societes", $id) SET ' +
            `${champ} = IF ${champ} = NONE OR ${champ} = '' THEN $v ELSE ${champ} END, ` +
            "website = ''",
            { id, v: site }
          )
        } else {
          await db.query('UPDATE type::record("referentiel_societes", $id) SET website = \'\'', { id })
        }
      }

      if (verdict === 'DEPLACEE') lotCr.deplacees++
      else if (verdict === 'OCCUPEE') lotCr.occupees++
      else lotCr.perdues++
      console.log(
        '  ' + (ECRIRE ? verdict.padEnd(11) : ('A ' + verdict).padEnd(11)) + ' ' +
        cle.padEnd(34) + ' ' + siret + '\n' +
        '              « ' + site +' »\n' +
        '              ' + dit
      )
    }

    console.log(
      '  --- lot ' + noLot + ' : deplacees ' + lotCr.deplacees +
      '   perdues ' + lotCr.perdues +
      '   accueil occupe ' + lotCr.occupees +
      '   opposition ' + lotCr.opposition +
      '   ecartees ' + lotCr.ecartees + '\n'
    )
    for (const k of Object.keys(total)) total[k] += lotCr[k]
  }

  // ── 3. Compte rendu ──
  console.log('par hote')
  for (const [h, n] of [...parHote.entries()].sort((a, b) => b[1] - a[1])) {
    console.log('  ' + h.padEnd(40) + String(n).padStart(5))
  }
  console.log(
    '\nTOTAL ' + (ECRIRE ? '' : '(a blanc, rien n\'a ete ecrit) ') +
    'sur ' + population.length + ' fiche(s)\n' +
    '  deplacees vers un champ de reseau : ' + total.deplacees + '\n' +
    '  perdues, aucun champ d\'accueil    : ' + total.perdues + '\n' +
    '  perdues, accueil deja occupe      : ' + total.occupees + '\n' +
    '  non ecrites, opposition opt-out   : ' + total.opposition + '\n' +
    '  non ecrites, site change entretemps : ' + total.ecartees
  )

  if (ECRIRE) {
    // Controle de sortie : la population est recomptee sur l'etat courant. Ce qui
    // reste est exactement ce qui n'a pas ete ecrit (opposition + ecartees).
    let reste = 0
    for (let start = 0; ; start += PAS) {
      const lignes = first(await db.query(
        "SELECT website FROM referentiel_societes WHERE website != NONE AND website != '' " +
        `LIMIT ${PAS} START ${start}`
      ))
      if (!lignes.length) break
      for (const f of lignes) if (t(f.website) && hostBlacklisted(hoteDeSite(t(f.website)))) reste++
      if (lignes.length < PAS) break
    }
    console.log('\npopulation restante apres ecriture : ' + reste +
      '   (attendu ' + (total.opposition + total.ecartees) + ')')
  } else {
    console.log('\nAUCUNE ECRITURE : relancer avec --ecrire pour appliquer.')
  }
} finally { await close() }
