// Helpers société — purs, sans dépendance ni I/O.
// Réutilisables par les routes /api/societes ET le futur moteur d'import
// (le rapprochement d'un import se fera sur cle_normalisee).

// Suffixes juridiques + ville retirés en FIN de raison sociale pour le
// rapprochement. L'ordre n'importe pas : retrait répété tant qu'un suffixe
// final matche (gère "X SARL Paris" -> "x").
const SUFFIXES_FIN = ['sarl', 'sasu', 'eurl', 'sas', 'sci', 'sa', 'sl', 'paris']

// raison sociale -> clé normalisée stable pour dédoublonnage / rapprochement.
//   minuscules · accents retirés (NFD) · ponctuation -> espace ·
//   suffixes/ville en fin retirés · espaces compressés · trim
//   "BETC Paris"        -> "betc"
//   "Studio Riou SARL"  -> "studio riou"
export function normaliserSociete(raison) {
  if (!raison || typeof raison !== 'string') return ''
  let s = raison
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // accents
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')    // ponctuation -> espace
    .replace(/\s+/g, ' ')
    .trim()
  let changed = true
  while (changed && s) {
    changed = false
    for (const suf of SUFFIXES_FIN) {
      if (s === suf) { s = ''; changed = true; break }
      if (s.endsWith(' ' + suf)) {
        s = s.slice(0, -(suf.length + 1)).trim()
        changed = true
        break
      }
    }
  }
  return s
}

// ── Rapprochement d'ADRESSE (pont OSM nom+adresse) ──────────────────────────
// Purs, sans I/O. Réduisent l'asymétrie de représentation de la voie :
//   société = voie ÉCLATÉE (numero_voie / type_voie / libelle_voie),
//   OSM     = `street` en CHAÎNE UNIQUE + `housenumber` séparé.

// Types de voie → forme canonique unique. Applique token par token APRÈS
// normalisation, pour que l'abréviation Etalab (RUE, AV, BD…) et la forme pleine
// OSM (Rue, Avenue, Boulevard…) convergent vers la même clé. Couvre les codes
// type_voie Etalab courants.
const TYPES_VOIE = {
  av: 'avenue', ave: 'avenue',
  bd: 'boulevard', bld: 'boulevard',
  r: 'rue',
  pl: 'place',
  imp: 'impasse',
  che: 'chemin', chem: 'chemin',
  all: 'allee',
  sq: 'square',
  rte: 'route',
  crs: 'cours',
  pass: 'passage', pas: 'passage',
  fg: 'faubourg',
  // Codes type_voie Etalab/AFNOR complémentaires (l'agrégat adresse abrège en
  // MAJUSCULES, ex. "CRS", "RPT", "QU"). Convergent vers la même clé que la forme
  // pleine OSM ("Cours", "Rond-Point", "Quai").
  car: 'carrefour', crf: 'carrefour',
  chs: 'chaussee',
  cite: 'cite',
  dsc: 'descente',
  esp: 'esplanade',
  ham: 'hameau',
  lot: 'lotissement',
  mte: 'montee',
  prom: 'promenade',
  prv: 'parvis',
  qu: 'quai', quai: 'quai',
  res: 'residence',
  rle: 'ruelle',
  rpt: 'rond point',
  sen: 'sente',
  tra: 'traverse',
  vla: 'villa',
  vlge: 'village',
  // Abréviations de LIBELLÉ fréquentes (dédicataire de voie) : l'agrégat Etalab
  // abrège ("MAL LECLERC", "GAL DE GAULLE") là où OSM écrit en toutes lettres
  // ("Maréchal Leclerc", "Général de Gaulle"). Mappées pour converger.
  mal: 'marechal',
  gal: 'general',
  cdt: 'commandant', cmdt: 'commandant',
  pdt: 'president',
  dr: 'docteur',
  st: 'saint', ste: 'sainte'
}

// Mots-outils non discriminants, retirés SYMÉTRIQUEMENT des deux sources : sans
// ça "rue des lilas" (OSM, article présent) ≠ "rue lilas" (société, article omis).
const MOTS_OUTILS_VOIE = new Set(['de', 'des', 'du', 'la', 'le', 'les', 'l', 'd'])

// Pipeline texte commun (calque de normText, inliné pour garder lib/societes.js
// sans dépendance) : minuscules · accents NFD retirés · non-alphanum → espace ·
// espaces compactés · trim. Retourne la liste des tokens (vide si rien).
function _tokensVoie(s) {
  const t = String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  return t ? t.split(' ') : []
}

// type + libelle → clé canonique du LIBELLÉ de voie, NUMÉRO EXCLU. Côté OSM :
// passer `street` entier en `libelle`, `type` vide (le type y est déjà dans la
// chaîne). Côté société : les 3 champs éclatés (numero_voie N'entre PAS ici).
//   normaliserVoie('RUE', 'DES LILAS')  -> 'rue lilas'
//   normaliserVoie('', 'Rue des Lilas') -> 'rue lilas'
// Retourne '' si vide (→ jamais de clé voie vide, pas de faux match L3). PUR.
export function normaliserVoie(type, libelle) {
  const tokens = _tokensVoie(`${type || ''} ${libelle || ''}`)
  const out = []
  for (const tok of tokens) {
    if (MOTS_OUTILS_VOIE.has(tok)) continue        // article/préposition → retiré
    out.push(TYPES_VOIE[tok] || tok)               // abréviation → forme pleine, sinon inchangé
  }
  return out.join(' ')
}

// Concordance de numéro de voie. OSM `housenumber` peut valoir '12 bis', '12-14' ;
// société `numero_voie` est en principe purement numérique. On compare le PREMIER
// groupe de chiffres de chaque côté. Numéro absent d'un côté → false (non
// concordant : dégrade L3→L2, jamais un rejet). PUR.
export function comparerNumero(numSoc, housenumberOsm) {
  const a = String(numSoc || '').match(/\d+/)
  const b = String(housenumberOsm || '').match(/\d+/)
  if (!a || !b) return false
  return a[0] === b[0]
}

// Adresse Etalab AGRÉGÉE → { numero, voie }. Etalab ne peuple JAMAIS type_voie /
// libelle_voie éclatés, mais le champ libre `adresse` l'est ("<num> <type>
// <libellé> <CP> <ville>"). On en dérive numéro + libellé de voie pour rouvrir le
// L3 (sans quoi voieSoc est vide → jamais de match d'adresse exact).
//   "12 RUE DES LILAS 75011 PARIS"        -> { numero:'12', voie:'rue lilas' }
//   "BAT A 3 AV DU GAL DE GAULLE 69003 …" -> { numero:'3',  voie:'avenue general gaulle' }
// Étapes : (a) retire "<CP 5 chiffres> <ville>" en FIN ; (b) 1er groupe de chiffres
// du reste = numéro, le SUFFIXE après ce groupe = voie brute (un complément en
// tête, AVANT le numéro, est donc écarté) ; (c) voie = normaliserVoie('', brut).
// { numero:'', voie:'' } si l'entrée est vide/inexploitable. PUR, testable hors DB.
export function parserAdresseAgregee(adresse) {
  const vide = { numero: '', voie: '' }
  const raw = String(adresse || '').trim()
  if (!raw) return vide
  // (a) CP 5 chiffres + ville retirés en fin ; le reste = numéro + voie éventuels.
  const corps = raw.replace(/\s+\d{5}\s+.+$/, '').trim()
  if (!corps) return vide
  // (b) 1er groupe de chiffres = numéro ; ce qui SUIT ce groupe = voie brute.
  const m = corps.match(/\d+/)
  if (m) {
    let brut = corps.slice(m.index + m[0].length)
    // Indice de répétition accolé au numéro ("12 BIS", "3 TER", "5 B") : côté OSM
    // il vit dans housenumber, PAS dans street — on le retire du libellé de voie,
    // sinon "bis rue paradis" ≠ "rue paradis" et le L3 casse sur les adresses bis.
    brut = brut.replace(/^\s*(bis|ter|quater|quinquies|[a-z])\b/i, ' ')
    return { numero: m[0], voie: normaliserVoie('', brut) }
  }
  // (c) pas de numéro : tout le corps est le libellé de voie.
  return { numero: '', voie: normaliserVoie('', corps) }
}
