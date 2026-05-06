// Tracking historique des recherches Leads.
// Écriture asynchrone (fire-and-forget côté caller) — ne doit JAMAIS bloquer
// la réponse au front ni faire échouer une recherche utilisateur.
//
// Schéma de la table lead_search défini ci-dessous (runLeadSearchMigration),
// joué au boot du serveur de manière idempotente (DEFINE … IF NOT EXISTS).

import { getDb } from '../../lib/surreal.js'

// ── helpers ──
function normalizeId(prefix, raw) {
  if (!raw) return null
  const s = String(raw)
  if (s.startsWith(prefix + ':')) return s.slice(prefix.length + 1).replace(/^⟨+|⟩+$/g, '')
  return s.replace(/^⟨+|⟩+$/g, '')
}

// Format INSEE strict : 4 chiffres + 1 lettre majuscule (ex. "4778A", "1071C").
// Le format pointé "47.78A" est aussi accepté (le serveur /api/search le génère
// pour l'API gouv et le passe tel quel au tracker).
function isValidNafCode(code) {
  if (typeof code !== 'string') return false
  const c = code.trim()
  return /^\d{4}[A-Z]$/.test(c) || /^\d{2}\.\d{2}[A-Z]$/.test(c)
}

// ── migration idempotente ──
export async function runLeadSearchMigration() {
  const db = await getDb()
  const queries = [
    'DEFINE TABLE IF NOT EXISTS lead_search SCHEMAFULL',
    'DEFINE FIELD IF NOT EXISTS user_id ON lead_search TYPE record<user>',
    'DEFINE FIELD IF NOT EXISTS naf_code ON lead_search TYPE string',
    'DEFINE FIELD IF NOT EXISTS naf_label ON lead_search TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS region_code ON lead_search TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS region_name ON lead_search TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS department_code ON lead_search TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS department_name ON lead_search TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS city_name ON lead_search TYPE option<string>',
    'DEFINE FIELD IF NOT EXISTS results_count ON lead_search TYPE number DEFAULT 0',
    'DEFINE FIELD IF NOT EXISTS fiches_completes_filter ON lead_search TYPE bool DEFAULT false',
    'DEFINE FIELD IF NOT EXISTS searched_at ON lead_search TYPE datetime DEFAULT time::now()',
    'DEFINE INDEX IF NOT EXISTS idx_lead_search_user ON lead_search FIELDS user_id',
    'DEFINE INDEX IF NOT EXISTS idx_lead_search_user_date ON lead_search FIELDS user_id, searched_at',
    'DEFINE INDEX IF NOT EXISTS idx_lead_search_naf ON lead_search FIELDS naf_code'
  ]
  for (const q of queries) {
    try { await db.query(q) } catch (e) { console.warn('[lead_search-migration]', q.slice(0, 80), '→', e.message) }
  }
}

// ── insertion d'une recherche ──
// Tous les champs optionnels acceptent null sans planter.
// Échec silencieux : journalise un warning, ne propage jamais.
export async function trackLeadSearch({
  userId,
  nafCode,
  nafLabel,
  regionCode,
  regionName,
  departmentCode,
  departmentName,
  cityName,
  resultsCount,
  fichesCompletesFilter
}) {
  // Garde-fou strict : seules les recherches avec un code NAF au format INSEE
  // sont enregistrées. Les recherches en texte libre (?q=…) sont ignorées —
  // évite de polluer la table avec des requêtes inexploitables pour les
  // relances commerciales et l'analytics.
  if (!userId || !isValidNafCode(nafCode)) return
  try {
    const db = await getDb()
    const cleanUserId = normalizeId('user', userId)
    // Normalisation au format compact (sans point) — cohérence des requêtes
    // analytics : "47.78A" et "4778A" deviennent tous les deux "4778A" en base.
    const normalizedNafCode = String(nafCode).replace('.', '')
    // searched_at calculé côté SurrealQL (time::now()) pour rester en datetime
    // natif (cf. fix b219bf7 sur les coercions).
    await db.query(
      `CREATE lead_search SET
        user_id = type::record('user', $uid),
        naf_code = $nafCode,
        naf_label = $nafLabel,
        region_code = $regionCode,
        region_name = $regionName,
        department_code = $departmentCode,
        department_name = $departmentName,
        city_name = $cityName,
        results_count = $resultsCount,
        fiches_completes_filter = $fichesCompletesFilter,
        searched_at = time::now()`,
      {
        uid: cleanUserId,
        nafCode: normalizedNafCode,
        nafLabel: nafLabel || null,
        regionCode: regionCode || null,
        regionName: regionName || null,
        departmentCode: departmentCode || null,
        departmentName: departmentName || null,
        cityName: cityName || null,
        resultsCount: Number(resultsCount) || 0,
        fichesCompletesFilter: !!fichesCompletesFilter
      }
    )
  } catch (e) {
    console.warn('[search-tracker] échec insertion :', e.message)
  }
}

// ── lecture de l'historique pour un user ──
// Retourne { total, history[] } — utilisé par GET /api/user/search-history.
export async function getSearchHistory(userId, { limit = 10, offset = 0 } = {}) {
  if (!userId) return { total: 0, history: [] }
  const db = await getDb()
  const cleanUserId = normalizeId('user', userId)
  const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 10, 100))
  const safeOffset = Math.max(0, parseInt(offset, 10) || 0)

  let total = 0
  try {
    const totalResult = await db.query(
      "SELECT count() AS total FROM lead_search WHERE user_id = type::record('user', $uid) GROUP ALL",
      { uid: cleanUserId }
    )
    total = totalResult?.[0]?.[0]?.total || 0
  } catch (e) {
    console.warn('[search-history] count error:', e.message)
  }

  let history = []
  try {
    const historyResult = await db.query(
      `SELECT id, naf_code, naf_label, region_code, region_name,
              department_code, department_name, city_name,
              results_count, fiches_completes_filter, searched_at
       FROM lead_search
       WHERE user_id = type::record('user', $uid)
       ORDER BY searched_at DESC
       LIMIT ${safeLimit} START ${safeOffset}`,
      { uid: cleanUserId }
    )
    history = (historyResult?.[0] || []).map(row => ({
      ...row,
      id: typeof row.id === 'object' ? String(row.id) : row.id
    }))
  } catch (e) {
    console.warn('[search-history] list error:', e.message)
  }

  return { total, limit: safeLimit, offset: safeOffset, history }
}
