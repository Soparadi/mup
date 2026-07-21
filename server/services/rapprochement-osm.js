// Rapprochement OSM ↔ référentiel sociétés — moteur SEUL (aucun importeur).
//
// La réserve nationale referentiel_osm (~685 k lignes OSM, déjà peuplée) porte
// des coordonnées de contact (téléphone, email, site, réseaux sociaux) que les
// fiches referentiel_societes n'ont pas. Ce module rapproche les deux tables sur
// un FAISCEAU de signaux (SIRET, SIREN, domaine, téléphone, email, nom+ville) et
// enrichit referentiel_societes en fill-if-empty via enrichReferentielActionnable.
//
// LECTURE SEULE de referentiel_osm : JAMAIS d'écriture dans cette table. La seule
// écriture est l'enrichissement additif de referentiel_societes (jamais d'écrasement).
//
// NON BRANCHÉ au boot : piloté à la main sur un département d'abord.

import { getDb } from '../../lib/surreal.js'
import { normaliserTel } from '../../lib/import.js'
import { normaliserSociete } from '../../lib/societes.js'
import { corroborerSiret, normText, DEPT_BBOX } from './overpass.js'
import { enrichReferentielActionnable } from './referentiel.js'

// Coercition string sûre (calque referentiel.js / referentiel-read.js).
const str = v => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()))

// URL → domaine normalisé pour le pont « site web ». URL() (schéma posé par
// défaut si absent) → hostname → www. retiré → minuscules. Repli regex si l'URL
// ne parse pas (host isolé du schéma, du www. et du chemin). Helper PUR.
export function normaliserDomaine(url) {
  const raw = str(url)
  if (!raw) return ''
  const aSchema = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
  try {
    const u = new URL(aSchema ? raw : 'http://' + raw)
    return u.hostname.replace(/^www\./i, '').toLowerCase()
  } catch {
    const host = raw
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // schéma
      .replace(/^www\./i, '')
      .match(/^[^/?#]+/)
    return (host ? host[0] : '').toLowerCase()
  }
}

// Cache module-level PAR DÉPARTEMENT : chaque dept ne charge sa bbox qu'UNE fois
// par process (Map<dept, promise>), la promesse mémorisée est partagée par les
// appels concurrents. Chargement borné par bbox départementale (mémoire) — plus
// de relecture de toute la réserve OSM. Un index VIDE — échec transitoire OU
// tranche pas encore peuplée — n'est PAS mis en cache : on réessaiera au prochain
// appel. Pas de TTL (OSM statique à l'échelle du run). Fail-safe, no-throw.
const _idxByDept = new Map()

export async function chargerOsmIndexe(dept, bbox) {
  const cache = _idxByDept.get(dept)
  if (cache) return cache
  const promise = chargerOsmDepuisDb(bbox)
  _idxByDept.set(dept, promise)
  const idx = await promise
  const vide = !(idx.bySiret.size || idx.bySiren.size || idx.byTel.size ||
                 idx.byEmail.size || idx.byDomaine.size)
  if (vide) _idxByDept.delete(dept)
  return idx
}

// Lit referentiel_osm en UNE passe et construit 5 index JS (Map) pour un
// rapprochement O(1) par signal. Valeur de chaque Map = LISTE de lignes OSM
// partageant la clé (plusieurs objets OSM peuvent porter le même téléphone,
// domaine, etc.). Clés vides ignorées (jamais d'entrée '').
//   bySiret   : SIRET nettoyé (espaces retirés)
//   bySiren   : SIREN nettoyé, à défaut dérivé du SIRET (9 premiers chiffres)
//   byTel     : normaliserTel(phone) — forme nationale 0X
//   byEmail   : email lower/trim
//   byDomaine : normaliserDomaine(website)
// BORNÉ PAR BBOX [latMin, lonMin, latMax, lonMax] : range scan sur lat (index
// idx_osm_lat), lng filtré en base sur le sous-ensemble — le chargement se limite
// à la tranche départementale (mémoire) au lieu des ~685 k lignes nationales.
// LECTURE SEULE, FAIL-SAFE : toute erreur → 5 Map vides, ne throw JAMAIS.
async function chargerOsmDepuisDb(bbox) {
  const vide = () => ({
    bySiret: new Map(), bySiren: new Map(), byTel: new Map(),
    byEmail: new Map(), byDomaine: new Map()
  })
  const push = (map, key, row) => {
    if (!key) return
    const list = map.get(key)
    if (list) list.push(row)
    else map.set(key, [row])
  }
  try {
    const [latMin, lonMin, latMax, lonMax] = bbox
    const db = await getDb()
    const r = await db.query(
      'SELECT osm_id, nom, siret, siren, phone, email, website, ' +
      'facebook, instagram, linkedin, city FROM referentiel_osm ' +
      'WHERE lat >= $latMin AND lat <= $latMax AND lng >= $lonMin AND lng <= $lonMax',
      { latMin, latMax, lonMin, lonMax }
    )
    const rows = r[0] || []
    const idx = vide()
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const siret = str(row.siret).replace(/\s+/g, '')
      const siren = (str(row.siren).replace(/\s+/g, '')) || (siret ? siret.slice(0, 9) : '')
      push(idx.bySiret, siret, row)
      push(idx.bySiren, siren, row)
      push(idx.byTel, normaliserTel(row.phone), row)
      push(idx.byEmail, str(row.email).toLowerCase(), row)
      push(idx.byDomaine, normaliserDomaine(row.website), row)
    }
    return idx
  } catch (e) {
    console.warn('[rapprochement-osm]', String(e?.message || e).slice(0, 80))
    return vide()
  }
}

// Mappe une ligne OSM vers le contrat actionnable de referentiel_societes.
// REMAP identique à getOsmContactBySiret (referentiel-read.js) : phone→societe_tel,
// email→societe_email, website→website, facebook→societe_facebook,
// instagram→societe_instagram, linkedin→societe_linkedin. Valeurs vides tolérées
// (enrichReferentielActionnable ne pose pas les champs vides).
function mapperOsmVersContrat(osm) {
  return {
    website: str(osm.website),
    societe_email: str(osm.email),
    societe_tel: str(osm.phone),
    societe_facebook: str(osm.facebook),
    societe_instagram: str(osm.instagram),
    societe_linkedin: str(osm.linkedin)
  }
}

// Cherche la MEILLEURE ligne OSM concordant avec une société, du signal le plus
// fort au plus faible. Retourne { osm, certitude:'certain'|'presume' } ou null.
// DOCTRINE :
//   • SIRET ou SIREN concordant  → CERTAIN (un identifiant légal ne ment pas).
//   • sinon ≥2 signaux faibles INDÉPENDANTS concordant sur une MÊME ligne OSM
//     parmi {domaine, tel, email, nom+ville} → PRÉSUMÉ.
//   • 1 signal faible isolé → null (REJET, rien écrit).
function trouverMatch(soc, idx) {
  const siret = str(soc.siret).replace(/\s+/g, '')
  const siren = str(soc.siren).replace(/\s+/g, '') || (siret ? siret.slice(0, 9) : '')

  // ── CERTAIN : SIRET, puis SIREN (confirmé par corroborerSiret) ──
  if (siret) {
    const rows = idx.bySiret.get(siret)
    if (rows && rows.length) return { osm: rows[0], certitude: 'certain' }
  }
  if (siren) {
    const rows = idx.bySiren.get(siren) || []
    const ok = rows.find(o => corroborerSiret(o, siren))
    if (ok) return { osm: ok, certitude: 'certain' }
  }

  // ── PRÉSUMÉ : chaque signal faible vote pour les lignes OSM qu'il matche ;
  // on retient une ligne soutenue par ≥2 signaux DISTINCTS (concordance sur un
  // même établissement, pas 2 lignes différentes). ──
  const votes = new Map()   // osm_id → { osm, signaux:Set }
  const voter = (rows, signal) => {
    for (const o of (rows || [])) {
      let e = votes.get(o.osm_id)
      if (!e) { e = { osm: o, signaux: new Set() }; votes.set(o.osm_id, e) }
      e.signaux.add(signal)
    }
  }
  const domaine = normaliserDomaine(soc.website)
  if (domaine) voter(idx.byDomaine.get(domaine), 'domaine')
  const tel = normaliserTel(soc.societe_tel)
  if (tel) voter(idx.byTel.get(tel), 'tel')
  const email = str(soc.societe_email).toLowerCase()
  if (email) voter(idx.byEmail.get(email), 'email')

  // nom+ville : signal de CORROBORATION appliqué aux SEULES lignes déjà surfacées
  // par un autre signal faible. Une ligne matchée UNIQUEMENT par nom+ville reste
  // un signal isolé (→ rejet) : inutile d'indexer les ~685 k noms OSM.
  const nom = normaliserSociete(soc.raison_sociale)
  const ville = normText(soc.ville)
  if (nom && ville) {
    for (const e of votes.values()) {
      if (normaliserSociete(e.osm.nom) === nom && normText(e.osm.city) === ville) {
        e.signaux.add('nomville')
      }
    }
  }

  let best = null
  for (const e of votes.values()) {
    if (e.signaux.size >= 2 && (!best || e.signaux.size > best.signaux.size)) best = e
  }
  return best ? { osm: best.osm, certitude: 'presume' } : null
}

// Rapproche toutes les sociétés d'un département avec la réserve OSM et enrichit
// referentiel_societes en fill-if-empty (jamais d'écrasement). LECTURE SEULE de
// referentiel_osm. Enrichissement SÉQUENTIEL : on ATTEND chaque écriture avant de
// passer à la société suivante (pas de fire-and-forget massif — des milliers
// d'UPDATE concurrents non-awaités satureraient la connexion SurrealDB et
// perdraient des écritures). enrichReferentielActionnable garde son try/catch
// interne : une société en échec n'interrompt jamais la passe. Compteurs read-only
// + log de synthèse. NON BRANCHÉ au boot : piloté à la main sur un département d'abord.
export async function rapprocherDepartement(dept) {
  const d = str(dept)
  const compteurs = { traitees: 0, certain: 0, presume: 0, rejet: 0, champs_ecrits: 0 }
  if (!d) {
    console.warn('[rapprochement-osm] département vide — rien à faire')
    return compteurs
  }

  // Bbox départementale obligatoire : borne le chargement OSM (mémoire). Absente
  // de la table → fail-safe (log + compteurs vides, jamais de throw).
  const bbox = DEPT_BBOX[d]
  if (!bbox) {
    console.warn(`[rapprochement-osm] bbox absente pour dept ${d} — rien à faire`)
    return compteurs
  }

  const idx = await chargerOsmIndexe(d, bbox)

  let societes = []
  try {
    const db = await getDb()
    const r = await db.query(
      'SELECT siret, siren, raison_sociale, ville, website, societe_email, societe_tel ' +
      'FROM referentiel_societes WHERE departement = $d',
      { d }
    )
    societes = r[0] || []
  } catch (e) {
    console.warn('[rapprochement-osm]', String(e?.message || e).slice(0, 80))
    return compteurs
  }

  for (const soc of societes) {
    compteurs.traitees++
    try {
      const match = trouverMatch(soc, idx)
      if (!match) { compteurs.rejet++; continue }
      if (match.certitude === 'certain') compteurs.certain++
      else compteurs.presume++
      const champs = mapperOsmVersContrat(match.osm)
      // champs_ecrits : nombre de champs NON VIDES dispatchés (l'écriture réelle
      // est tranchée en fill-if-empty côté DB — ce compteur ne la mesure pas).
      compteurs.champs_ecrits += Object.values(champs).filter(Boolean).length
      const siret = str(soc.siret).replace(/\s+/g, '')
      // SÉQUENTIEL : on attend l'écriture avant la société suivante. Aucune écriture
      // perdue ; enrichReferentielActionnable avale déjà ses propres échecs (no-throw).
      await enrichReferentielActionnable(siret, champs)
    } catch (e) {
      console.warn('[rapprochement-osm]', String(e?.message || e).slice(0, 80))
    }
  }

  console.log(
    `[rapprochement-osm] dept ${d} — ${compteurs.traitees} sociétés · ` +
    `${compteurs.certain} certain · ${compteurs.presume} présumé · ` +
    `${compteurs.rejet} rejet · ${compteurs.champs_ecrits} champs dispatchés`
  )
  return compteurs
}

// Variante branchée sur la fin de recherche : rapproche le LOT de sociétés
// désignées par un tableau de SIRET (celles réellement parcourues côté front)
// plutôt qu'un département entier. Même doctrine (faisceau, certain/présumé,
// fill-if-empty) et même boucle SÉQUENTIELLE que rapprocherDepartement — seule
// la sélection change (siret IN $sirets). SIRET nettoyés + dédupliqués en amont.
// LECTURE SEULE de referentiel_osm. Fail-safe : ne throw jamais.
export async function rapprocherSirets(sirets) {
  const liste = Array.isArray(sirets)
    ? [...new Set(sirets.map(s => str(s).replace(/\s+/g, '')).filter(Boolean))]
    : []
  const compteurs = { traitees: 0, certain: 0, presume: 0, rejet: 0, champs_ecrits: 0 }
  if (!liste.length) {
    console.warn('[rapprochement-osm] aucun SIRET — rien à faire')
    return compteurs
  }

  const idx = await chargerOsmIndexe()

  let societes = []
  try {
    const db = await getDb()
    const r = await db.query(
      'SELECT siret, siren, raison_sociale, ville, website, societe_email, societe_tel ' +
      'FROM referentiel_societes WHERE siret IN $sirets',
      { sirets: liste }
    )
    societes = r[0] || []
  } catch (e) {
    console.warn('[rapprochement-osm]', String(e?.message || e).slice(0, 80))
    return compteurs
  }

  for (const soc of societes) {
    compteurs.traitees++
    try {
      const match = trouverMatch(soc, idx)
      if (!match) { compteurs.rejet++; continue }
      if (match.certitude === 'certain') compteurs.certain++
      else compteurs.presume++
      const champs = mapperOsmVersContrat(match.osm)
      // champs_ecrits : nombre de champs NON VIDES dispatchés (l'écriture réelle
      // est tranchée en fill-if-empty côté DB — ce compteur ne la mesure pas).
      compteurs.champs_ecrits += Object.values(champs).filter(Boolean).length
      const siret = str(soc.siret).replace(/\s+/g, '')
      // SÉQUENTIEL : on attend l'écriture avant la société suivante. Aucune écriture
      // perdue ; enrichReferentielActionnable avale déjà ses propres échecs (no-throw).
      await enrichReferentielActionnable(siret, champs)
    } catch (e) {
      console.warn('[rapprochement-osm]', String(e?.message || e).slice(0, 80))
    }
  }

  console.log(
    `[rapprochement-osm] ${liste.length} SIRET demandés — ${compteurs.traitees} sociétés · ` +
    `${compteurs.certain} certain · ${compteurs.presume} présumé · ` +
    `${compteurs.rejet} rejet · ${compteurs.champs_ecrits} champs dispatchés`
  )
  return compteurs
}
