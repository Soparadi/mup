// Normalise un id reçu côté client pour le passer à `type::record($table, $id)`.
// SurrealDB encode automatiquement les ids numériques (⟨…⟩) via type::record(),
// donc pas besoin de préfixe 'c' artificiel.
//
// Cas couverts :
//   "pipeline:abc"        → "abc"
//   "pipeline:⟨abc⟩"      → "abc"
//   "pipeline:⟨⟨abc⟩⟩"   → "abc" (corruption éventuelle de chevrons imbriqués)
//   "0abc123def"          → "0abc123def" (auto-id SurrealDB, retourné tel quel)
//   "c1777717736262"      → "c1777717736262" (id legacy avec préfixe c, intact)
//   ""                    → null
//   undefined / non-string → null
export function cleanRecordId(table, rawId) {
  if (!rawId || typeof rawId !== 'string') return null
  const tablePrefix = new RegExp('^' + table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':')
  const clean = rawId
    .replace(tablePrefix, '')
    .replace(/^⟨+/, '')
    .replace(/\\?⟩+$/, '')
    .replace(/\\/g, '')
    .trim()
  return clean || null
}
