/**
 * Source unique de vérité pricing MovUP.
 * Toute modification ici impacte CGV, tarifs.html, stripe-config.js, plan-quotas.js.
 * Voir capture doctrine du 15 mai 2026.
 */

export const PLANS_ORDER = ['demarrage', 'activite', 'croisiere']

export const PLANS = {
  demarrage: {
    slug: 'demarrage',
    label: 'Démarrage',
    tagline: 'Vous lancez votre activité. Vous voulez sortir du bouche-à-oreille et trouver vos premiers clients.',
    priceMonthly: 24,
    priceAnnual: 20,
    priceAnnualTotal: 240,
    highlighted: false,
    color: '#0BBCD4'
  },
  activite: {
    slug: 'activite',
    label: 'Activité',
    tagline: 'Vous prospectez chaque semaine. Vous signez régulièrement. Vous voulez gagner du temps et professionnaliser vos échanges.',
    priceMonthly: 34,
    priceAnnual: 28,
    priceAnnualTotal: 340,
    highlighted: true,
    color: '#1D8348'
  },
  croisiere: {
    slug: 'croisiere',
    label: 'Croisière',
    tagline: 'Vous avez une activité installée. Vous gérez des clients réguliers et vous voulez piloter votre chiffre d’affaires sereinement.',
    priceMonthly: 44,
    priceAnnual: 37,
    priceAnnualTotal: 440,
    highlighted: false,
    color: '#1D8348'
  }
}

export const PLAN_FEATURES = {
  demarrage: [
    'Trouvez vos prospects par métier et région',
    'Suivez chaque échange dans un tableau clair',
    'N’oubliez plus aucune relance',
    'Visualisez vos rendez-vous sur une carte',
    'Devis et factures sans limite',
    'Gardez vos notes de frais en photo',
    'Une boîte mail connectée à votre compte'
  ],
  activite: [
    'Exportez vos données quand vous voulez',
    'Mettez vos relances en pilote automatique',
    'Lancez une visio en un clic depuis MovUP',
    'Envoyez vos campagnes de prospection par email',
    'Personnalisez vos modèles de devis',
    'Voyez où vous perdez vos prospects',
    'Importez et fusionnez vos contacts existants'
  ],
  croisiere: [
    'Facturez vos clients récurrents automatiquement',
    'Relancez les impayés sans y penser',
    'Suivez votre chiffre d’affaires en temps réel',
    'Anticipez votre chiffre d’affaires des 3 mois à venir',
    'Transmettez à votre comptable en un fichier mensuel',
    'Imprimez vos devis à votre logo et vos couleurs',
    'Une session d’accompagnement de 30 minutes offerte'
  ]
}

export const TRIAL = {
  durationDays: 14,
  requiresCreditCard: false,
  engagement: false
}

export function getFeaturesForPlan(slug) {
  if (!isValidPlan(slug)) return []
  const stopIndex = PLANS_ORDER.indexOf(slug)
  const features = []
  for (let i = 0; i <= stopIndex; i++) {
    features.push(...PLAN_FEATURES[PLANS_ORDER[i]])
  }
  return features
}

export function getPlan(slug) {
  return PLANS[slug] || null
}

export function isValidPlan(slug) {
  return PLANS_ORDER.includes(slug)
}
