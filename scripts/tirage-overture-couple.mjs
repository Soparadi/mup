// TIRAGE D APPARIEMENT OVERTURE, sur le couple departement / NAF demande. LECTURE
// SEULE : que des SELECT, aucun UPDATE, aucun agregat demande a l instance. Les
// fiches du perimetre d abord, puis les lignes Overture du departement lues PAR
// BANDES DE LATITUDE dans la boite englobante des fiches elargie du rayon. Sa
// sortie JSON est ce que scripts/passe-overture-couple.mjs consomme.
//
// SELECTEUR : fiches actives, REELLEMENT GEOLOCALISEES, DONT LES SIX CHAMPS DE
// CONTACT SONT VIDES. Les fiches que le crawl a deja pourvues sont donc hors
// perimetre, et c est ce que le compte de fin de tour appelle « deja pourvues par
// le crawl ».
//
// LA GARDE DE GEOLOCALISATION N EST PAS ECRITE ICI : estGeolocalisee la porte,
// depuis lib/societes.js, qui en est l adresse unique et qui dit ce que coutent les
// fiches non situees. La clause SQL « lat != NONE AND lng != NONE » ne suffit pas a
// les ecarter, elle ne voit pas l ile nulle ; le filtre se termine donc en memoire,
// juste apres la lecture et AVANT que la boite englobante ne soit calculee.
//
// USAGE
//   node scripts/tirage-overture-couple.mjs <dept> <naf pointe> <sortie.json>

import 'dotenv/config'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { estGeolocalisee } from '../lib/societes.js'
import { getDb, close } from '../lib/surreal.js'

const [dept, naf, sortie] = process.argv.slice(2)
if (!dept || !naf || !sortie) throw new Error('usage: tirage-overture-couple.mjs <dept> <naf> <sortie.json>')
mkdirSync(dirname(sortie), { recursive: true })

const RAYON_KM = 0.1
const PAUSE_MS = 150
const BANDE = 0.05
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const first = (r) => (Array.isArray(r) ? r[0] : r) || []

const SIX = ['website', 'societe_email', 'societe_tel', 'societe_facebook', 'societe_instagram', 'societe_linkedin']
const vide = (c) => `(${c} = NONE OR ${c} = '')`

const CHAMPS_FICHE =
  'siret, raison_sociale, enseigne, adresse, numero_voie, type_voie, libelle_voie, ' +
  'code_postal, ville, lat, lng, website, societe_email, societe_tel, ' +
  'societe_facebook, societe_instagram, societe_linkedin'
const CHAMPS_OVERTURE =
  'cle, nom, marque, categorie, confiance, site, domaine, telephone, email, ' +
  'facebook, instagram, linkedin, social_autre, adresse, code_postal, ville, lat, lng, consomme_le'

const db = await getDb()
const depart = Date.now()
try {
  const base = `FROM referentiel_societes WITH INDEX idx_ref_dept_naf
     WHERE departement = '${dept}' AND naf = '${naf}' AND etat_administratif = 'A'
       AND lat != NONE AND lng != NONE`
  const brut = first(await db.query(`SELECT ${CHAMPS_FICHE} ${base}`))
  // La garde se pose AVANT le calcul de la boite englobante, qui est precisement ce
  // qu une fiche non situee fausse. On l ecarte, et on la compte : le compte de fin
  // de tour doit dire combien de fiches sont sorties a ce titre.
  const geo = brut.filter(estGeolocalisee)
  const nonGeolocalisees = brut.length - geo.length
  const fiches = geo.filter((f) => SIX.every((c) => { const v = f[c]; return v == null || String(v).trim() === '' }))
  const pourvues = geo.length - fiches.length
  console.log(`actives, lat/lng renseignes : ${brut.length}`)
  console.log(`dont non geolocalisees, ecartees : ${nonGeolocalisees}`)
  console.log(`reellement geolocalisees : ${geo.length}`)
  console.log(`deja pourvues (hors perimetre) : ${pourvues}`)
  console.log(`perimetre du tirage : ${fiches.length}`)
  if (!fiches.length) throw new Error('perimetre vide')

  const lats = fiches.map((f) => f.lat), lngs = fiches.map((f) => f.lng)
  const margeLat = RAYON_KM / 111.32
  const margeLng = RAYON_KM / (111.32 * Math.cos((Math.min(...lats) + Math.max(...lats)) * Math.PI / 360))
  const bbox = {
    latMin: Math.min(...lats) - margeLat, latMax: Math.max(...lats) + margeLat,
    lngMin: Math.min(...lngs) - margeLng, lngMax: Math.max(...lngs) + margeLng
  }
  console.log(`bbox elargie : lat ${bbox.latMin.toFixed(5)} .. ${bbox.latMax.toFixed(5)} · lng ${bbox.lngMin.toFixed(5)} .. ${bbox.lngMax.toFixed(5)}`)

  const lignes = []
  let msOverture = 0
  for (let a = bbox.latMin; a < bbox.latMax; a += BANDE) {
    const b = Math.min(a + BANDE, bbox.latMax)
    const t1 = Date.now()
    const rows = first(await db.query(
      `SELECT ${CHAMPS_OVERTURE} FROM referentiel_overture
       WHERE lat >= $a AND lat < $b AND lng >= $x AND lng <= $y AND departement = '${dept}'
         AND consomme_le = NONE`,
      { a: +a.toFixed(6), b: +b.toFixed(6), x: +bbox.lngMin.toFixed(6), y: +bbox.lngMax.toFixed(6) }))
    const ms = Date.now() - t1
    msOverture += ms
    lignes.push(...rows)
    console.log(`  bande ${a.toFixed(4)} .. ${b.toFixed(4)} : ${rows.length} lignes (${ms} ms)`)
    await sleep(PAUSE_MS)
  }
  console.log(`overture lu : ${lignes.length} lignes en ${msOverture} ms`)

  writeFileSync(sortie, JSON.stringify({
    perimetre: `${dept}/${naf}`, dept, naf, rayon_km: RAYON_KM, bbox,
    geolocalisees: geo.length, non_geolocalisees: nonGeolocalisees, deja_pourvues: pourvues,
    ms: { overture: msOverture, total: Date.now() - depart },
    fiches, overture: lignes
  }))
  console.log(`\ntirage ecrit : ${sortie}`)
  console.log('aucune ecriture en base.')
} catch (e) {
  console.error('ECHEC', String(e?.stack || e)); process.exitCode = 1
} finally { await close().catch(() => {}) }
