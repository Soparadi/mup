// Matrice features par plan — utilisée par le helper hasFeature() pour
// gater les features avancées (export CSV, mailing séquencé, stats avancées,
// facturation récurrente, etc.) selon le plan actif de l'utilisateur.
//
// Pendant l'essai 14 jours (trial_status === 'active'), l'utilisateur a le
// plan 'essai' = mode basique. Aucune feature avancée. C'est intentionnel :
// l'essai sert à découvrir le pipeline + les contacts + l'agenda, pas à
// utiliser les features qui justifient l'upgrade.
//
// Après conversion (trial_status === 'converted'), c'est user.plan qui pilote.
//
// NOTE : ce helper n'est WIRED nulle part dans cette passe. Les routes API
// existantes ne contrôlent pas les features. À brancher progressivement sur
// les routes concernées (ex. GET /api/contacts/export → if (!hasFeature(user,
// 'export_csv')) return 403).

export const PLAN_QUOTAS = {
  essai: {
    // Mode basique pendant les 14 jours (équivalent Démarrage moins l'export)
    export_csv: false,
    mailing_sequencer: false,
    advanced_stats: false,
    recurring_invoices: false,
    urssaf_tracking: false,
    custom_quote_logo: false,
    accompaniment_session: false
  },
  demarrage: {
    export_csv: false, // levier upgrade vers Activité
    mailing_sequencer: false,
    advanced_stats: false,
    recurring_invoices: false,
    urssaf_tracking: false,
    custom_quote_logo: false,
    accompaniment_session: false
  },
  activite: {
    export_csv: true,
    mailing_sequencer: true,
    advanced_stats: true,
    recurring_invoices: false,
    urssaf_tracking: false,
    custom_quote_logo: false,
    accompaniment_session: false
  },
  croisiere: {
    export_csv: true,
    mailing_sequencer: true,
    advanced_stats: true,
    recurring_invoices: true,
    urssaf_tracking: true,
    custom_quote_logo: true,
    accompaniment_session: true
  }
}

// Helper de feature flag.
// - Si user en essai actif → plan = 'essai' (matrice basique).
// - Si user converti (Stripe) → plan = user.plan ('demarrage', 'activite', 'croisiere').
// - Si feature inconnue ou plan inconnu → false (fail closed).
export function hasFeature(user, feature) {
  if (!user || !feature) return false
  const plan = user.trial_status === 'converted' ? (user.plan || 'demarrage') : 'essai'
  const quotas = PLAN_QUOTAS[plan]
  if (!quotas) return false
  return quotas[feature] === true
}

// ──────────────────────────────────────────────────────────────────────────
// Lead quotas (Phase 2 roadmap, commit 1 — autorité serveur)
// ──────────────────────────────────────────────────────────────────────────
// PLAN_QUOTAS ci-dessus = matrice feature flags (export_csv, mailing_sequencer,
// etc.). PLAN_LEAD_LIMITS ci-dessous = plafond NUMÉRIQUE d'ajouts au pipeline
// depuis la page Leads (body.source === 'SIRENE'). Deux préoccupations
// distinctes, voisinage volontaire sans collision de nom.

// Plafond d'ajouts au pipeline depuis Leads, par plan effectif.
// Essai = 30 SEC (aucun reset pendant les 14 jours, compteur cumulatif).
// Payant = mensuel calendaire (reset 1er du mois UTC, lazy).
// Grille verrouillée 30 / 60 / 120 : tous les plans ont un plafond numérique
// côté décompte, croisiere compris (plus d'Infinity).
export const PLAN_LEAD_LIMITS = {
  essai: 30,
  demarrage: 30,
  activite: 60,
  croisiere: 120
}

// ISO date-only "YYYY-MM-DD" du 1er du mois courant en UTC.
// Déplacé depuis server.js pour cohabitation avec applyMonthlyReset.
export function firstOfMonthIsoUTC() {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10)
}

// Reset lazy du compteur mensuel sur user_plan : si lastResetDate < 1er du
// mois courant UTC, remet leadsConsumedThisMonth à 0 et persiste. Idempotent
// (no-op si déjà reset). Reçoit user pour bail-out essai (doctrine non
// négociable : essai = 30 sec sans reset sur les 14j). Source de vérité du
// plan = getEffectivePlan(user), pas rec.plan (qui peut être stale en cas
// de divergence webhook Stripe / record user_plan). Déplacé depuis server.js
// pour rester dans le module dédié aux quotas.
export async function applyMonthlyReset(db, userId, rec, user) {
  // Bail-out essai : doctrine non négociable, le compteur essai est cumulatif
  // sur les 14j et ne doit JAMAIS être reset. Garde-fou contre les callers
  // qui appelleraient applyMonthlyReset sans condition amont (cf régression
  // GET /api/user-plan post-9f6460c).
  if (getEffectivePlan(user) === 'essai') return rec
  const firstIso = firstOfMonthIsoUTC()
  if (rec.lastResetDate && new Date(rec.lastResetDate) >= new Date(firstIso)) return rec
  const updatedAt = new Date().toISOString()
  await db.query(
    'UPDATE type::record("user_plan", $id) MERGE $body',
    { id: userId, body: { leadsConsumedThisMonth: 0, lastResetDate: firstIso, updatedAt } }
  )
  return { ...rec, leadsConsumedThisMonth: 0, lastResetDate: firstIso, updatedAt }
}

// Résolution du plan effectif d'un utilisateur. Factorise la règle déjà
// présente dans hasFeature() ci-dessus (et autres sites). Source unique.
// - trial_status === 'converted' → user.plan (demarrage/activite/croisiere)
// - sinon (essai actif / expiré / null pre-migration) → 'essai'
// Note grâce 7j : un user en grace_active garde trial_status='converted'
// résiduel → considéré payant ici, mais le middleware grâce bloque déjà
// les mutations en 402 en amont, donc pas de doublon nécessaire.
export function getEffectivePlan(user) {
  if (!user) return 'essai'
  return user.trial_status === 'converted' ? (user.plan || 'demarrage') : 'essai'
}

// Plafond d'ajouts au pipeline pour ce user (selon plan effectif).
export function getLeadLimit(user) {
  const plan = getEffectivePlan(user)
  return PLAN_LEAD_LIMITS[plan] ?? PLAN_LEAD_LIMITS.demarrage
}

// Lecture du compteur leadsConsumedThisMonth pour ce user, AVEC ou SANS
// reset selon le statut :
// - Essai : lecture SÈCHE, aucun reset (doctrine non négociable — compteur
//   cumulatif sur les 14j d'essai, jamais remis à 0).
// - Payant : applique le reset lazy (1er du mois UTC) avant lecture.
// Retourne un entier (≥ 0).
export async function getLeadsConsumed(db, userId, rec, user) {
  if (!rec) return 0
  const plan = getEffectivePlan(user)
  if (plan === 'essai') return rec.leadsConsumedThisMonth || 0
  const fresh = await applyMonthlyReset(db, userId, rec, user)
  return fresh.leadsConsumedThisMonth || 0
}
