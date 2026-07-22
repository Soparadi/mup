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
  pass: 'passage',
  fg: 'faubourg'
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
