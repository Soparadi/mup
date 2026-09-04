// PASSE D APPARIEMENT OVERTURE, sur le couple departement / NAF que porte le tirage.
//
// TROIS MODES, l ecriture n est jamais le defaut :
//   (defaut)    blanc   : appariement, resolution, comptes. Aucun UPDATE.
//   --valider           : blanc, plus UNE transaction ANNULEE sur une seule fiche.
//                         SurrealDB n offre ni preparation ni execution a blanc ;
//                         BEGIN … CANCEL execute puis annule, et c est la seule
//                         facon de lever le doute sur le rejet SCHEMAFULL, qui est
//                         silencieux (enrichReferentielActionnable avale ses echecs).
//   --ecrire            : la passe reelle, sequentielle, pause de 150 ms.
//
// LA REGLE : candidats Overture du departement a 100 m, Dice sur bigrammes de
// chaines normalisees par normaliserSociete, QUATRE cles cote fiche, score retenu =
// le maximum, aucun plancher de longueur, seuil 0,85.
//
// LES QUATRE CLES NE SONT PAS ECRITES ICI : clesAppariement les rend, depuis
// lib/societes.js, qui en est l adresse unique et qui porte la mesure du 4 septembre
// 2026 (la quatrieme, le contenu de la derniere parenthese, vaut +13 appariements
// sur le 75 / 73.11Z et +3 sur le 15 / 74.20Z, pour un seul perdu). Ce script ne
// redecoupe aucun nom.
//
// SURVIVANT UNIQUE DES DEUX COTES. Cote fiche : une fiche qui retient plusieurs
// lignes est ecartee. Cote ligne : une ligne retenue par plusieurs fiches est
// ecartee POUR TOUTES. Mesure du 4 septembre 2026 sur le 75 / 73.11Z, a quatre
// cles : 214 fiches retenues cote fiche, six d entre elles tombant sur trois lignes
// que plusieurs fiches reclamaient, 208 appariements au bout. Un depart a 0,058 d
// ecart de score n est pas une certitude, et on ne remplit que le certain ; le
// crawl reprendra ces fiches.
//
// L ECRITURE PASSE PAR enrichReferentielActionnable, ET PAR ELLE SEULE : filtre d
// hote sur le site, garde d opposition RGPD, remplissage-si-vide par champ, et la
// tracabilite dans le meme UPDATE. Ce script ne reecrit aucune de ces regles.
//
// LE MARQUAGE DE LA LIGNE OVERTURE SE FAIT DANS LA MEME BOUCLE, juste apres l
// UPDATE de la fiche : une ligne consommee sans marque serait rejouee au mois
// suivant. Si le marquage echoue apres une fiche pourvue, la ligne repart non
// marquee et l appariement se rejoue : le remplissage-si-vide n ecrira rien.
//
// USAGE
//   node scripts/passe-overture-couple.mjs <tirage.json> [<recoupement.json>] [--lot <f>|--valider|--ecrire]

import 'dotenv/config'
import { readFileSync, writeFileSync } from 'node:fs'
import { normaliserSociete, distKm, clesAppariement } from '../lib/societes.js'
import { hostBlacklisted, hoteDeSite, champReseauPourHote } from '../server/services/hotes-exclus.js'
import { enrichReferentielActionnable } from '../server/services/referentiel.js'
import { checkBlocklistBatch } from '../server/services/optout.js'
import { getDb, close } from '../lib/surreal.js'

const argv = process.argv.slice(2)
// Les positionnels se lisent hors drapeaux ET hors valeur de --lot : sans quoi
// « tirage.json --lot sortie.json » prend « --lot » pour le recoupement.
const positionnels = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--lot')
const SOURCE = positionnels[0]
const RECOUPEMENT = positionnels[1]
const VALIDER = argv.includes('--valider')
const LOT_SORTIE = (argv.includes('--lot') ? argv[argv.indexOf('--lot') + 1] : '')
const ECRIRE = argv.includes('--ecrire')
const JOURNAL = `${SOURCE.replace(/\.json$/, '')}-journal.json`

const SEUIL = 0.85
const ORIGINE = 'overture'
const PAUSE_MS = 150
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const d = JSON.parse(readFileSync(SOURCE, 'utf8'))
const RAYON = d.rayon_km
const t0 = Date.now()

const str = (v) => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()))
const plein = (v) => str(v) !== ''

// ── Dice sur les bigrammes de caracteres ────────────────────────────────────
function bigrammes(s) {
  const m = new Map()
  for (let i = 0; i < s.length - 1; i++) {
    const b = s.slice(i, i + 2)
    m.set(b, (m.get(b) || 0) + 1)
  }
  return m
}
function dice(a, b) {
  if (!a || !b) return 0
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0
  const A = bigrammes(a), B = bigrammes(b)
  let commun = 0, na = 0, nb = 0
  for (const v of A.values()) na += v
  for (const v of B.values()) nb += v
  for (const [k, v] of A) commun += Math.min(v, B.get(k) || 0)
  return (2 * commun) / (na + nb)
}

// ── Appariement, cote fiche ─────────────────────────────────────────────────
const fiches = d.fiches.map((f) => ({ f, cles: clesAppariement(f) }))
const overture = d.overture.map((o) => ({ o, norm: normaliserSociete(o.nom) }))

const MAILLE_LAT = 0.001
const MAILLE_LNG = 0.0015
const grille = new Map()
for (const c of overture) {
  if (typeof c.o.lat !== 'number' || typeof c.o.lng !== 'number') continue
  const k = `${Math.floor(c.o.lat / MAILLE_LAT)}|${Math.floor(c.o.lng / MAILLE_LNG)}`
  let b = grille.get(k)
  if (!b) { b = []; grille.set(k, b) }
  b.push(c)
}

const bilan = { retenues: [], multiples: 0, sansCandidat: 0, sansRecevable: 0, cleVidee: 0 }
for (const x of fiches) {
  if (!x.cles.length) { bilan.cleVidee++; continue }
  const candidats = []
  const i0 = Math.floor(x.f.lat / MAILLE_LAT)
  const j0 = Math.floor(x.f.lng / MAILLE_LNG)
  for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) {
    const b = grille.get(`${i}|${j}`)
    if (!b) continue
    for (const c of b) {
      const km = distKm(x.f.lat, x.f.lng, c.o.lat, c.o.lng)
      if (km <= RAYON) candidats.push({ c, km })
    }
  }
  if (!candidats.length) { bilan.sansCandidat++; continue }
  const recevables = []
  for (const k of candidats) {
    if (!k.c.norm) continue
    let best = 0, gagnante = null
    for (const cle of x.cles) {
      const s = dice(k.c.norm, cle.norm)
      if (s > best) { best = s; gagnante = cle }
    }
    if (best >= SEUIL) recevables.push({ k, score: best, cle: gagnante })
  }
  if (recevables.length === 0) bilan.sansRecevable++
  else if (recevables.length > 1) bilan.multiples++
  else bilan.retenues.push({ x, ...recevables[0] })
}

// ── Survivant unique COTE LIGNE ─────────────────────────────────────────────
const parLigne = new Map()
for (const m of bilan.retenues) {
  const k = str(m.k.c.o.cle)
  const l = parLigne.get(k)
  if (l) l.push(m); else parLigne.set(k, [m])
}
const collisions = [...parLigne.values()].filter((l) => l.length > 1)
const ecarteesParCollision = collisions.reduce((a, l) => a + l.length, 0)
const appariees = bilan.retenues.filter((m) => parLigne.get(str(m.k.c.o.cle)).length === 1)

// ── Resolution des champs a poser ───────────────────────────────────────────
const CHAMPS = ['website', 'societe_email', 'societe_tel', 'societe_linkedin', 'societe_facebook', 'societe_instagram']

function entrantsDe(o) {
  // Le contrat d entree de enrichReferentielActionnable. Le filtre d hote n est PAS
  // rejoue ici : il est pose dans la fonction. On le simule uniquement pour savoir
  // ce que le journal doit annoncer, jamais pour decider de l ecriture.
  return {
    website: str(o.site), societe_email: str(o.email), societe_tel: str(o.telephone),
    societe_linkedin: str(o.linkedin), societe_facebook: str(o.facebook), societe_instagram: str(o.instagram)
  }
}
function apresFiltreHote(e) {
  const c = { ...e }
  const site = str(c.website)
  if (!site) return c
  const hote = hoteDeSite(site)
  if (!hostBlacklisted(hote)) return c
  delete c.website
  const champ = champReseauPourHote(hote)
  if (champ && !str(c[champ])) c[champ] = site
  return c
}

const recoupes = new Map()
if (RECOUPEMENT) {
  for (const r of JSON.parse(readFileSync(RECOUPEMENT, 'utf8'))) {
    recoupes.set(str(r.siret), !r.joignable ? 'muet'
      : (r.tel_trouve && r.nom_trouve) ? 'tel_et_nom'
      : r.tel_trouve ? 'tel_seul'
      : r.nom_trouve ? 'nom_seul' : 'aucun')
  }
}

const lot = []
for (const m of appariees) {
  const f = m.x.f
  const champs = entrantsDe(m.k.c.o)
  const apres = apresFiltreHote(champs)
  const pose = {}
  for (const c of CHAMPS) if (plein(apres[c]) && !plein(f[c])) pose[c] = str(apres[c])
  const trace = {
    contact_origine: ORIGINE,
    contact_nom_score: Number(m.score.toFixed(3)),
    contact_distance_m: Math.round(m.k.km * 1000)
  }
  const r = recoupes.get(str(f.siret))
  if (r) trace.contact_site_recoupe = r
  // LA CONDITION D ECRITURE. N est ecrit que ce que le site de l entreprise
  // confirme : telephone trouve sur le site, ou societe nommee. Tout le reste est
  // laisse au crawl, champs vides.
  //   sans_site  : la ligne Overture ne porte aucun site, rien a visiter.
  //   muet       : site injoignable ou refuse par ses robots.
  //   aucun      : site lu, ni le telephone ni le nom ne s y trouvent.
  const site = str(apres.website)
  const verdict = !site ? 'sans_site' : (r || 'non_visite')
  const confirme = verdict === 'tel_et_nom' || verdict === 'tel_seul' || verdict === 'nom_seul'
  lot.push({
    verdict, confirme, enseigne: f.enseigne, site,
    telephone: str(m.k.c.o.telephone), cle_gagnante: m.cle.norm,
    siret: str(f.siret).replace(/\s+/g, ''), raison_sociale: f.raison_sociale,
    overture_cle: str(m.k.c.o.cle), overture_nom: m.k.c.o.nom,
    cle_origine: m.cle.origine, score: m.score, metres: trace.contact_distance_m,
    champs, pose, trace
  })
}
const totalPose = lot.reduce((a, x) => a + Object.keys(x.pose).length, 0)

if (LOT_SORTIE) {
  const aVisiter = lot.filter((x) => x.site)
  writeFileSync(LOT_SORTIE, JSON.stringify({
    perimetre: `${d.dept}/${d.naf}`, seuil: SEUIL,
    lot: aVisiter.map((x) => ({
      siret: x.siret, raison_sociale: x.raison_sociale, enseigne: x.enseigne,
      site: x.site, telephone: x.telephone, cle_gagnante: x.cle_gagnante
    }))
  }, null, 1))
  console.log(`appariees : ${lot.length}   ·   a visiter (site en main) : ${aVisiter.length}` +
    `   ·   sans site, non recoupables : ${lot.length - aVisiter.length}`)
  console.log(`lot ecrit : ${LOT_SORTIE}`)
  process.exit(0)
}

// ── Rendu ───────────────────────────────────────────────────────────────────
function tableau(titre, entetes, lignes) {
  console.log(`\n${titre}`)
  const cols = entetes.map((h, i) => Math.max(String(h).length, ...lignes.map((l) => String(l[i] ?? '').length)))
  const ligne = (l) => '  ' + l.map((v, i) => (i === 0 ? String(v ?? '').padEnd(cols[i]) : String(v ?? '').padStart(cols[i]))).join('  ')
  console.log(ligne(entetes))
  console.log('  ' + cols.map((c) => '-'.repeat(c)).join('  '))
  for (const l of lignes) console.log(ligne(l))
}

console.log('='.repeat(78))
console.log(`PASSE OVERTURE ${d.dept} / ${d.naf}  ·  MODE ${ECRIRE ? 'ECRITURE' : VALIDER ? 'VALIDATION' : 'BLANC'}`)
console.log('='.repeat(78))
console.log(`\ntirage : ${SOURCE}`)
console.log(`fiches : ${fiches.length}   ·   lignes Overture lues : ${overture.length}`)

tableau('1. APPARIEMENT, SURVIVANT UNIQUE DES DEUX COTES',
  ['issue', 'fiches'],
  [
    ['perimetre', fiches.length],
    ['retenues cote fiche', bilan.retenues.length],
    ['ecartees : ligne reclamee par plusieurs fiches', ecarteesParCollision],
    ['APPARIEES', appariees.length],
    ['lignes Overture distinctes', appariees.length],
    ['lignes en collision, ecartees', collisions.length]
  ])
for (const l of collisions) {
  console.log(`\n  ecartee : « ${l[0].k.c.o.nom} » (${l[0].k.c.o.cle}) reclamee par ${l.length} fiches`)
  for (const m of l) console.log(`    ${m.x.f.siret}  ${m.x.f.raison_sociale}  score ${m.score.toFixed(3)}  ${Math.round(m.k.km * 1000)} m`)
}

const parChamp = Object.fromEntries(CHAMPS.map((c) => [c, lot.filter((x) => x.pose[c]).length]))
tableau('2. CHAMPS A POSER',
  ['champ', 'a poser'],
  [...CHAMPS.map((c) => [c, parChamp[c]]), ['TOTAL', totalPose]])

const db = await getDb()
const compte = async (sirets) => {
  const out = Object.fromEntries([...CHAMPS, 'contact_origine'].map((c) => [c, 0]))
  for (let i = 0; i < sirets.length; i += 100) {
    const r = await db.query(
      `SELECT ${CHAMPS.join(', ')}, contact_origine FROM referentiel_societes WHERE siret IN $s`,
      { s: sirets.slice(i, i + 100) })
    for (const row of (r[0] || [])) for (const c of Object.keys(out)) if (plein(row[c])) out[c]++
  }
  return out
}
const sirets = lot.map((x) => x.siret)

try {
  const avant = await compte(sirets)

  // ── Validation serveur par transaction ANNULEE, sur UNE fiche ─────────────
  if (VALIDER) {
    const x = lot[0]
    const assigns = []
    const params = { id: x.siret, cle: x.overture_cle, siret: x.siret }
    const apres = apresFiltreHote(x.champs)
    for (const c of CHAMPS) {
      const v = str(apres[c])
      if (!v) continue
      assigns.push(`${c} = IF ${c} = NONE OR ${c} = '' THEN $${c} ELSE ${c} END`)
      params[c] = v
    }
    for (const [k, v] of Object.entries(x.trace)) { assigns.push(`${k} = $${k}`); params[k] = v }
    const sql =
      'BEGIN TRANSACTION;\n' +
      `UPDATE type::record("referentiel_societes", $id) SET ${assigns.join(', ')};\n` +
      'UPDATE type::record("referentiel_overture", $cle) SET consomme_le = time::now(), consomme_siret = $siret;\n' +
      'CANCEL TRANSACTION;'
    console.log(`\n3. VALIDATION SERVEUR, TRANSACTION ANNULEE SUR ${x.siret}`)
    console.log('\n' + sql)
    let verdict = 'ACCEPTE'
    try { await db.query(sql, params) }
    catch (e) { verdict = `REJET : ${String(e?.message || e).slice(0, 200)}` }
    console.log(`\n  verdict du serveur : ${verdict}`)
    const r = await db.query(
      'SELECT website, societe_tel, contact_origine FROM referentiel_societes WHERE siret = $s LIMIT 1', { s: x.siret })
    const o = await db.query('SELECT consomme_le, consomme_siret FROM referentiel_overture WHERE cle = $c LIMIT 1', { c: x.overture_cle })
    console.log(`  fiche apres annulation   : ${JSON.stringify((r[0] || [])[0] || {})}`)
    console.log(`  ligne apres annulation   : ${JSON.stringify((o[0] || [])[0] || {})}`)
    console.log('  la transaction est annulee : rien ne doit avoir change ci-dessus.')

    // Le message d une transaction annulee est le MEME que les statements aient ete
    // acceptes ou non : sans temoin, le verdict ci-dessus ne prouve rien. On rejoue
    // donc la meme transaction annulee avec UN CHAMP QUI N EXISTE PAS au schema. Si
    // le serveur rend un message DIFFERENT, c est qu il valide bien le SET avant de
    // le cancel, et que la premiere transaction a donc ete acceptee.
    const sqlTemoin =
      'BEGIN TRANSACTION;\n' +
      `UPDATE type::record("referentiel_societes", $id) SET champ_qui_n_existe_pas = 'x';\n` +
      'CANCEL TRANSACTION;'
    let temoin = 'ACCEPTE (le schema ne rejette rien, le controle ne vaut pas)'
    try { await db.query(sqlTemoin, { id: x.siret }) }
    catch (e) { temoin = `REJET : ${String(e?.message || e).slice(0, 200)}` }
    console.log(`\n  temoin, champ inexistant : ${temoin}`)
  }

  // ── L ECRITURE ────────────────────────────────────────────────────────────
  const journal = []
  let ecrites = 0, marquees = 0, sautees = 0, echecsMarquage = 0
  const ecartes = new Map()
  if (ECRIRE) {
    const bloques = await checkBlocklistBatch(sirets)
    console.log(`\n4. ECRITURE SEQUENTIELLE, PAUSE ${PAUSE_MS} ms`)
    console.log(`   ${lot.length} fiches, dont ${bloques.size} opposees et sautees\n`)
    for (const [i, x] of lot.entries()) {
      if (bloques.has(x.siret)) {
        sautees++
        journal.push({ siret: x.siret, issue: 'saute_rgpd' })
        console.log(`  ${String(i + 1).padStart(3)}. ${x.siret}  SAUTE, opposition RGPD`)
        continue
      }
      if (!x.confirme) {
        ecartes.set(x.verdict, (ecartes.get(x.verdict) || 0) + 1)
        journal.push({ siret: x.siret, issue: 'ecarte', motif: x.verdict })
        console.log(`  ${String(i + 1).padStart(3)}. ${x.siret}  ECARTE, ${x.verdict}  ·  champs laisses vides`)
        continue
      }
      // La porte unique : filtre d hote, blocklist, remplissage-si-vide, tracabilite.
      await enrichReferentielActionnable(x.siret, x.champs, x.trace)
      ecrites++
      let marque = 'ok'
      try {
        await db.query(
          'UPDATE type::record("referentiel_overture", $cle) SET consomme_le = time::now(), consomme_siret = $siret',
          { cle: x.overture_cle, siret: x.siret })
        marquees++
      } catch (e) {
        marque = `ECHEC ${String(e?.message || e).slice(0, 80)}`
        echecsMarquage++
      }
      journal.push({ siret: x.siret, raison_sociale: x.raison_sociale, pose: x.pose, trace: x.trace, overture_cle: x.overture_cle, marque })
      console.log(`  ${String(i + 1).padStart(3)}. ${x.siret}  ${Object.keys(x.pose).join(' ') || '(rien a poser)'}` +
        `  ·  score ${x.score.toFixed(3)} ${x.metres} m ${x.trace.contact_site_recoupe || 'sans-visite'}  ·  marque ${marque}`)
      await sleep(PAUSE_MS)
    }
    writeFileSync(JOURNAL, JSON.stringify(journal, null, 1))
    console.log(`\n  journal ecrit : ${JOURNAL}`)
  }

  const apres = ECRIRE ? await compte(sirets) : avant
  tableau(ECRIRE ? '5. COMPTE AVANT ET APRES, RELU EN BASE' : '3. COMPTE AVANT, RELU EN BASE',
    ['champ', 'avant', 'apres', 'ecart', 'attendu'],
    [...CHAMPS.map((c) => [c, avant[c], apres[c], apres[c] - avant[c], parChamp[c]]),
      ['contact_origine', avant.contact_origine, apres.contact_origine, apres.contact_origine - avant.contact_origine, ECRIRE ? lot.length - sautees : 0]])

  if (ECRIRE) {
    const total = CHAMPS.reduce((a, c) => a + (apres[c] - avant[c]), 0)
    console.log(`\n  champs ecrits, relus en base : ${total}   ·   annonces : ${totalPose}`)
    console.log(`  echecs de marquage : ${echecsMarquage}`)
    console.log('\n' + '='.repeat(78))
    console.log('COMPTE DE FIN DE TOUR')
    console.log('='.repeat(78))
    console.log(`  couple                     departement ${d.dept}, NAF ${d.naf}`)
    console.log(`  fiches du perimetre        ${fiches.length}`)
    console.log(`  fiches appariees           ${lot.length}`)
    console.log(`  confirmees par le site     ${lot.filter((x) => x.confirme).length}`)
    for (const [m, n] of [...ecartes].sort((a, b) => b[1] - a[1]))
      console.log(`  ecartees, ${String(m).padEnd(16)} ${n}`)
    console.log(`  champs ecrits              ${total}   (relu en base)`)
    console.log(`  fiches sautees RGPD        ${sautees}`)
    console.log(`  lignes Overture marquees   ${marquees}`)
    console.log(`  lignes Overture lues       ${overture.length}`)
    console.log(`  lignes Overture restantes  ${overture.length - marquees}`)
  }
} finally {
  await close().catch(() => {})
}
console.log(`\nduree : ${Math.round((Date.now() - t0) / 1000)} s`)
if (!ECRIRE) console.log('AUCUNE ECRITURE DURABLE.')
