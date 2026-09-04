// Appariement de fiches : les normalisations et le bornage géographique que
// partagent toutes les passes de rapprochement.
//
// Aucun de ces quatre noms n'est propre à une source. Ils vivaient dans les deux
// modules OpenStreetMap parce que c'est là que le premier appariement a été
// écrit ; ils sont lus aujourd'hui par le crawl mentions légales, la recherche
// web, la composition de domaines, l'opposition RGPD, le rapprochement Atout
// France et le balayage de position des cartes.
//
//   normText            appariement nom + ville, concordance de faisceau
//   normaliserDomaine   appariement par le site, hôte nu
//   corroborerSiret     appariement par identifiant légal
//   DEPT_BBOX           bornage départemental des chargements
//
// Le module ne dépend de RIEN : aucun import, aucun accès base, aucun appel
// réseau. Quatre helpers purs et une table de constantes.

// Coercition string sûre (calque referentiel.js / referentiel-read.js).
const str = v => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()))

// Normalisation texte pour l'appariement nom/ville :
// minuscule, sans accents, ponctuation → espace, espaces compactés.
export function normText(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}


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

// ---------------------------------------------------------------------------
// corroborerSiret(poi, sirenCible) : fonction pure.
// true si le POI porte le SIREN cible, soit directement, soit via son SIRET.
// ---------------------------------------------------------------------------
export function corroborerSiret(poi, sirenCible) {
  const cible = String(sirenCible || '').replace(/\s+/g, '')
  if (!cible) return false
  const sirenPoi = poi?.siren || poi?.siret?.slice(0, 9) || null
  return sirenPoi === cible
}


// Bbox départementales : [latMin, lonMin, latMax, lonMax] (sud, ouest, nord, est).
// Structure extensible, ajouter un département = ajouter une ligne.
// Source : france-geojson (contours IGN ADMIN EXPRESS), bbox calculée en local.
export const DEPT_BBOX = {
  '01': [45.61, 4.72, 46.52, 6.18],
  '02': [48.83, 2.95, 50.07, 4.26],
  '03': [45.93, 2.27, 46.81, 4.01],
  '04': [43.66, 5.49, 44.66, 6.97],
  '05': [44.18, 5.41, 45.13, 7.08],
  '06': [43.48, 6.63, 44.37, 7.72],
  '07': [44.26, 3.86, 45.37, 4.89],
  '08': [49.22, 4.02, 50.17, 5.4],
  '09': [42.57, 0.82, 43.32, 2.18],
  '10': [47.92, 3.38, 48.72, 4.87],
  '11': [42.64, 1.68, 43.47, 3.25],
  '12': [43.69, 1.83, 44.95, 3.46],
  '13': [43.15, 4.23, 43.93, 5.82],
  '14': [48.75, -1.16, 49.43, 0.45],
  '15': [44.61, 2.06, 45.49, 3.38],
  '16': [45.19, -0.47, 46.15, 0.95],
  '17': [45.08, -1.57, 46.38, 0.01],
  '18': [46.42, 1.77, 47.63, 3.08],
  '19': [44.92, 1.22, 45.77, 2.53],
  '2A': [41.33, 8.53, 42.39, 9.41],
  '2B': [41.83, 8.57, 43.03, 9.56],
  '21': [46.9, 4.06, 48.04, 5.52],
  '22': [48.03, -3.67, 48.91, -1.9],
  '23': [45.66, 1.37, 46.46, 2.62],
  '24': [44.57, -0.05, 45.72, 1.45],
  '25': [46.55, 5.69, 47.58, 7.07],
  '26': [44.11, 4.64, 45.35, 5.84],
  '27': [48.66, 0.29, 49.49, 1.81],
  '28': [47.95, 0.75, 48.95, 2],
  '29': [47.7, -5.15, 48.76, -3.38],
  '30': [43.46, 3.26, 44.46, 4.85],
  '31': [42.68, 0.44, 43.93, 2.05],
  '32': [43.31, -0.29, 44.08, 1.21],
  '33': [44.19, -1.27, 45.58, 0.32],
  '34': [43.21, 2.54, 43.98, 4.2],
  '35': [47.63, -2.29, 48.72, -1.01],
  '36': [46.34, 0.86, 47.28, 2.21],
  '37': [46.73, 0.05, 47.71, 1.37],
  '38': [44.69, 4.74, 45.89, 6.36],
  '39': [46.26, 5.25, 47.31, 6.21],
  '40': [43.48, -1.53, 44.54, 0.14],
  '41': [47.18, 0.58, 48.14, 2.25],
  '42': [45.23, 3.68, 46.28, 4.77],
  '43': [44.74, 3.08, 45.43, 4.5],
  '44': [46.86, -2.63, 47.84, -0.94],
  '45': [47.48, 1.51, 48.35, 3.13],
  '46': [44.2, 0.98, 45.05, 2.22],
  '47': [43.97, -0.15, 44.77, 1.08],
  '48': [44.1, 2.98, 44.98, 4],
  '49': [46.96, -1.36, 47.82, 0.24],
  '50': [48.45, -1.95, 49.73, -0.73],
  '51': [48.51, 3.39, 49.41, 5.04],
  '52': [47.57, 4.62, 48.69, 5.9],
  '53': [47.73, -1.24, 48.57, -0.04],
  '54': [48.34, 5.42, 49.57, 7.13],
  '55': [48.4, 4.88, 49.62, 5.86],
  '56': [47.27, -3.74, 48.22, -2.03],
  '57': [48.52, 5.89, 49.52, 7.65],
  '58': [46.65, 2.84, 47.59, 4.24],
  '59': [49.96, 2.06, 51.09, 4.24],
  '60': [49.06, 1.68, 49.77, 3.17],
  '61': [48.17, -0.87, 48.98, 0.98],
  '62': [50.01, 1.55, 51.01, 3.19],
  '63': [45.28, 2.38, 46.26, 3.99],
  '64': [42.77, -1.8, 43.6, 0.03],
  '65': [42.67, -0.33, 43.62, 0.65],
  '66': [42.33, 1.72, 42.92, 3.18],
  '67': [48.12, 6.94, 49.08, 8.24],
  '68': [47.42, 6.84, 48.32, 7.63],
  '69': [45.45, 4.24, 46.31, 5.17],
  '70': [47.25, 5.36, 48.03, 6.83],
  '71': [46.15, 3.62, 47.16, 5.47],
  '72': [47.56, -0.45, 48.49, 0.92],
  '73': [45.05, 5.62, 45.94, 7.19],
  '74': [45.68, 5.8, 46.41, 7.05],
  '75': [48.81, 2.22, 48.91, 2.47],
  '76': [49.25, 0.06, 50.08, 1.8],
  '77': [48.12, 2.39, 49.12, 3.56],
  '78': [48.43, 1.44, 49.09, 2.23],
  '79': [45.96, -0.91, 47.11, 0.23],
  '80': [49.57, 1.38, 50.37, 3.21],
  '81': [43.38, 1.53, 44.21, 2.94],
  '82': [43.76, 0.73, 44.4, 2.01],
  '83': [42.98, 5.65, 43.81, 6.94],
  '84': [43.65, 4.64, 44.44, 5.76],
  '85': [46.26, -2.41, 47.09, -0.53],
  '86': [46.04, -0.11, 47.18, 1.22],
  '87': [45.43, 0.62, 46.41, 1.92],
  '88': [47.81, 5.39, 48.52, 7.2],
  '89': [47.31, 2.84, 48.4, 4.35],
  '90': [47.43, 6.75, 47.83, 7.15],
  '91': [48.28, 1.91, 48.78, 2.59],
  '92': [48.72, 2.14, 48.96, 2.34],
  '93': [48.8, 2.28, 49.02, 2.61],
  '94': [48.68, 2.3, 48.87, 2.62],
  '95': [48.9, 1.6, 49.25, 2.6]
}
