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
