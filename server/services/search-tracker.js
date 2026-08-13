// Tracking historique de l'usage Leads : les recherches (lead_search), les
// modifications de contact (lead_contact_edit) et les tentatives
// d'enrichissement (lead_enrichment).
// Écriture asynchrone (fire-and-forget côté caller) — ne doit JAMAIS bloquer
// la réponse au front ni faire échouer un geste utilisateur.
//
// Schéma des trois tables défini ci-dessous (runLeadSearchMigration), joué au
// boot du serveur de manière idempotente (DEFINE … IF NOT EXISTS). Aucune
// reprise du passé : un champ ajouté ne l'est que pour les lignes à venir.
//
// LE LIEN ENTRE LES TROIS, c'est `search_id` — un identifiant minté par la page
// au lancement d'une recherche, porté sur chaque appel /api/search (donc écrit
// sur chaque page de lead_search) et sur le corps de from-lead (donc posé sur
// la société, ses contacts et sa carte). Les deux tables d'usage le recopient à
// leur tour. Rien n'est corrélé par horodatage : tant que le lien n'est pas
// écrit, il vaut chaîne vide et la donnée sort à tiret.

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

// Identifiant de recherche, tel qu'il arrive de la page (query string ou corps
// de requête) : un jeton court en minuscules et chiffres, jamais autre chose.
// Ce qui ne ressemble pas à ça ne rattache rien — chaîne vide, pas d'erreur.
export function nettoyerSearchId(raw) {
  return String(raw ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32)
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
    // fiches_completes_filter : plus jamais écrit — la page n'envoie plus le
    // filtre, la valeur était false partout. Le champ reste défini (aucune
    // migration ne défait le passé) et les lignes neuves prennent son DEFAULT.
    'DEFINE FIELD IF NOT EXISTS fiches_completes_filter ON lead_search TYPE bool DEFAULT false',
    // search_id — même recherche, autant de lignes que de pages parcourues.
    // Les lignes antérieures à sa mise en service ne l'ont pas : elles sont
    // lues à l'absent, jamais réécrites.
    'DEFINE FIELD IF NOT EXISTS search_id ON lead_search TYPE string DEFAULT ""',
    'DEFINE FIELD IF NOT EXISTS searched_at ON lead_search TYPE datetime DEFAULT time::now()',
    'DEFINE INDEX IF NOT EXISTS idx_lead_search_user ON lead_search FIELDS user_id',
    'DEFINE INDEX IF NOT EXISTS idx_lead_search_user_date ON lead_search FIELDS user_id, searched_at',
    'DEFINE INDEX IF NOT EXISTS idx_lead_search_naf ON lead_search FIELDS naf_code',

    // ── lead_contact_edit — une ligne par MODIFICATION réelle d'un contact ──
    // Écriture serveur seule, jamais rendue à l'abonnée : ni route de lecture,
    // ni route de suppression. Seule la fiche superadmin la compte.
    'DEFINE TABLE IF NOT EXISTS lead_contact_edit SCHEMAFULL',
    'DEFINE FIELD IF NOT EXISTS user_id ON lead_contact_edit TYPE record<user>',
    'DEFINE FIELD IF NOT EXISTS search_id ON lead_contact_edit TYPE string DEFAULT ""',
    'DEFINE FIELD IF NOT EXISTS contact_table ON lead_contact_edit TYPE string DEFAULT ""',
    'DEFINE FIELD IF NOT EXISTS contact_id ON lead_contact_edit TYPE string DEFAULT ""',
    'DEFINE FIELD IF NOT EXISTS changed_fields ON lead_contact_edit TYPE array<string> DEFAULT []',
    'DEFINE FIELD IF NOT EXISTS edited_at ON lead_contact_edit TYPE datetime DEFAULT time::now()',
    'DEFINE INDEX IF NOT EXISTS idx_lead_contact_edit_user ON lead_contact_edit FIELDS user_id',
    'DEFINE INDEX IF NOT EXISTS idx_lead_contact_edit_search ON lead_contact_edit FIELDS user_id, search_id',

    // ── lead_enrichment — une ligne par TENTATIVE d'enrichissement ──
    // Toutes les sorties de POST /api/enrich/:siret y passent, chacune avec son
    // issue. Mêmes règles : écriture serveur seule, aucune route exposée.
    'DEFINE TABLE IF NOT EXISTS lead_enrichment SCHEMAFULL',
    'DEFINE FIELD IF NOT EXISTS user_id ON lead_enrichment TYPE record<user>',
    'DEFINE FIELD IF NOT EXISTS search_id ON lead_enrichment TYPE string DEFAULT ""',
    'DEFINE FIELD IF NOT EXISTS siret ON lead_enrichment TYPE string DEFAULT ""',
    'DEFINE FIELD IF NOT EXISTS issue ON lead_enrichment TYPE string DEFAULT ""',
    'DEFINE FIELD IF NOT EXISTS attempted_at ON lead_enrichment TYPE datetime DEFAULT time::now()',
    'DEFINE INDEX IF NOT EXISTS idx_lead_enrichment_user ON lead_enrichment FIELDS user_id',
    'DEFINE INDEX IF NOT EXISTS idx_lead_enrichment_search ON lead_enrichment FIELDS user_id, search_id'
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
  searchId
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
        search_id = $searchId,
        searched_at = time::now()`,
      {
        uid: cleanUserId,
        nafCode: normalizedNafCode,
        nafLabel: nafLabel || '',
        regionCode: regionCode || '',
        regionName: regionName || '',
        departmentCode: departmentCode || '',
        departmentName: departmentName || '',
        cityName: cityName || '',
        resultsCount: Number(resultsCount) || 0,
        searchId: nettoyerSearchId(searchId)
      }
    )
  } catch (e) {
    console.warn('[search-tracker] échec insertion :', e.message)
  }
}

// ── insertion d'une modification de contact ──
// UNE LIGNE PAR MODIFICATION RÉELLE. C'est l'appelant qui compare l'avant et
// l'après ; une liste de champs vide n'écrit rien. La fiche société enregistre
// à chaque frappe (autosave débounçé) : sans cette condition, la table porterait
// une ligne par frappe et ne compterait plus des modifications.
// Échec silencieux, comme trackLeadSearch : jamais de propagation.
export async function trackContactEdit({ userId, searchId, contactTable, contactId, champs }) {
  if (!userId || !Array.isArray(champs) || champs.length === 0) return
  try {
    const db = await getDb()
    await db.query(
      `CREATE lead_contact_edit SET
        user_id = type::record('user', $uid),
        search_id = $searchId,
        contact_table = $contactTable,
        contact_id = $contactId,
        changed_fields = $champs,
        edited_at = time::now()`,
      {
        uid: normalizeId('user', userId),
        searchId: nettoyerSearchId(searchId),
        contactTable: String(contactTable || ''),
        contactId: String(contactId || ''),
        champs: champs.map(String)
      }
    )
  } catch (e) {
    console.warn('[contact-edit-tracker] échec insertion :', e.message)
  }
}

// Les quatre issues d'une tentative d'enrichissement, et rien d'autre : une
// issue inconnue n'écrit pas de ligne plutôt que d'en écrire une illisible.
const ISSUES_ENRICHISSEMENT = new Set(['livre', 'sans_resultat', 'refus_opposition', 'refus_quota'])

// ── insertion d'une tentative d'enrichissement ──
// Appelée à CHAQUE sortie de POST /api/enrich/:siret, y compris les refus :
// c'est la tentative qu'on compte, pas la réussite.
//
// RATTACHEMENT À LA RECHERCHE. La route ne connaît qu'un SIRET ; c'est la
// société matérialisée depuis la Prospection qui porte le search_id. On le
// relit ici (lecture indexée par siret, idx_societes_siret), donc APRÈS que la
// route a répondu — l'appel est fire-and-forget. Société inconnue ou antérieure
// au lien : chaîne vide, la ligne s'écrit quand même sans rattachement.
export async function trackEnrichAttempt({ userId, siret, issue }) {
  if (!userId || !ISSUES_ENRICHISSEMENT.has(issue)) return
  try {
    const db = await getDb()
    const uid = normalizeId('user', userId)
    const cleanSiret = String(siret || '').replace(/\s+/g, '')
    let searchId = ''
    if (cleanSiret) {
      try {
        const r = await db.query(
          'SELECT search_id FROM societes WHERE siret = $siret AND userId = $uid LIMIT 1',
          { siret: cleanSiret, uid }
        )
        searchId = nettoyerSearchId(r?.[0]?.[0]?.search_id)
      } catch (e) {
        console.warn('[enrich-tracker] rattachement impossible :', e.message)
      }
    }
    await db.query(
      `CREATE lead_enrichment SET
        user_id = type::record('user', $uid),
        search_id = $searchId,
        siret = $siret,
        issue = $issue,
        attempted_at = time::now()`,
      { uid, searchId, siret: cleanSiret, issue }
    )
  } catch (e) {
    console.warn('[enrich-tracker] échec insertion :', e.message)
  }
}

// ── regroupement : des PAGES aux RECHERCHES ──
// lead_search porte une ligne par page parcourue ; une recherche en compte
// souvent des dizaines. Compter les lignes, c'est compter des pages.
//
// DEUX RÈGLES, et la seconde n'est qu'un repli. Une ligne qui porte un
// search_id rejoint les autres lignes du même identifiant, sans condition de
// temps ni de critères : c'est le lien exact, écrit par la page au lancement.
// Une ligne qui n'en porte pas — toutes celles d'avant sa mise en service —
// retombe sur l'ancienne approximation : mêmes critères, et moins de cinq
// minutes depuis la page précédente du même groupe. Jamais l'inverse : une
// ligne identifiée ne se fait pas rattraper par la fenêtre.
//
// Entrée : les lignes du user, de la plus récente à la plus ancienne.
// Sortie : les groupes dans le même ordre, chacun daté de son LANCEMENT (sa
// ligne la plus ancienne) et portant les critères de sa ligne la plus récente.
const FENETRE_REPLI_MS = 5 * 60 * 1000
export function grouperRecherches(lignes) {
  const ms = (v) => {
    if (v === undefined || v === null || v === '') return null
    const d = v instanceof Date ? v : new Date(v)
    return Number.isNaN(d.getTime()) ? null : d.getTime()
  }
  // Clé du repli — les critères de la recherche, et rien d'autre.
  // fiches_completes_filter n'en fait plus partie : le filtre n'existe plus.
  const cleRepli = (l) => [
    l.naf_code, l.region_code, l.department_code, l.city_name
  ].map(v => String(v ?? '')).join('|')

  const groupes = []
  const parId = new Map()
  const parCle = new Map()
  for (const l of lignes) {
    const t = ms(l.searched_at)
    const sid = nettoyerSearchId(l.search_id)
    const ouvrir = () => {
      const g = {
        search_id: sid,
        naf_code: l.naf_code, naf_label: l.naf_label,
        region_name: l.region_name,
        department_code: l.department_code, department_name: l.department_name,
        city_name: l.city_name,
        debut: t, pages: 1
      }
      groupes.push(g)
      return g
    }
    if (sid) {
      const g = parId.get(sid)
      if (g) { g.pages++; if (t !== null && (g.debut === null || t < g.debut)) g.debut = t }
      else parId.set(sid, ouvrir())
      continue
    }
    const cle = cleRepli(l)
    const g = parCle.get(cle)
    // Chaînage sur la ligne la plus ancienne du groupe : les pages d'un même
    // déroulement se suivent de quelques secondes, la recherche entière peut
    // durer bien plus de cinq minutes.
    if (g && t !== null && g.debut !== null && (g.debut - t) <= FENETRE_REPLI_MS) {
      g.pages++
      g.debut = t
    } else {
      parCle.set(cle, ouvrir())
    }
  }
  return groupes
}

// ── compteurs d'usage rattachés à des recherches ──
// Pour un lot d'identifiants de recherche, ce que chacune a produit du côté
// des deux tables d'usage. Lecture bornée aux identifiants demandés (les vingt
// de la fiche), jamais un balayage de table.
// Retourne deux Map search_id → nombre ; une recherche sans ligne n'y figure
// pas, et vaut zéro pour l'appelant.
export async function compterUsageParRecherche(userId, searchIds) {
  const vide = { contactsModifies: new Map(), enrichissements: new Map() }
  const ids = [...new Set((searchIds || []).map(nettoyerSearchId).filter(Boolean))]
  if (!userId || ids.length === 0) return vide
  const db = await getDb()
  const uid = normalizeId('user', userId)
  const compter = async (table, etiquette) => {
    const m = new Map()
    try {
      const r = await db.query(
        `SELECT search_id, count() AS n FROM ${table}
          WHERE user_id = type::record('user', $uid) AND search_id IN $ids
          GROUP BY search_id`,
        { uid, ids }
      )
      for (const ligne of (r?.[0] || [])) {
        m.set(String(ligne.search_id || ''), Number(ligne.n) || 0)
      }
    } catch (e) {
      console.warn(`[${etiquette}] comptage impossible :`, e.message)
    }
    return m
  }
  return {
    contactsModifies: await compter('lead_contact_edit', 'contact-edit-tracker'),
    enrichissements: await compter('lead_enrichment', 'enrich-tracker')
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
