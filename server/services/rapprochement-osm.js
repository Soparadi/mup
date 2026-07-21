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

// Lit referentiel_osm en UNE passe et construit 5 index JS (Map) pour un
// rapprochement O(1) par signal. Valeur de chaque Map = LISTE de lignes OSM
// partageant la clé (plusieurs objets OSM peuvent porter le même téléphone,
// domaine, etc.). Clés vides ignorées (jamais d'entrée '').
//   bySiret   : SIRET nettoyé (espaces retirés)
//   bySiren   : SIREN nettoyé, à défaut dérivé du SIRET (9 premiers chiffres)
//   byTel     : normaliserTel(phone) — forme nationale 0X
//   byEmail   : email lower/trim
//   byDomaine : normaliserDomaine(website)
// LECTURE SEULE, FAIL-SAFE : toute erreur → 5 Map vides, ne throw JAMAIS.
export async function chargerOsmIndexe() {
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
    const db = await getDb()
    const r = await db.query(
      'SELECT osm_id, nom, siret, siren, phone, email, website, ' +
      'facebook, instagram, linkedin, city FROM referentiel_osm'
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
