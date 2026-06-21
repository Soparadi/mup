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
