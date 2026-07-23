// Mapping des price_id Stripe par plan + cycle de facturation.
// Lu depuis les env vars Railway (STRIPE_PRICE_*). Le reverse mapping
// price_id → { plan, billing_cycle } sert au handler webhook pour détecter
// les changements de plan via Customer Portal.

export const PRICE_IDS = {
  demarrage: {
    monthly: process.env.STRIPE_PRICE_DEMARRAGE_MONTHLY || null,
    annual: process.env.STRIPE_PRICE_DEMARRAGE_ANNUAL || null
  },
  activite: {
    monthly: process.env.STRIPE_PRICE_ACTIVITE_MONTHLY || null,
    annual: process.env.STRIPE_PRICE_ACTIVITE_ANNUAL || null
  },
  croisiere: {
    monthly: process.env.STRIPE_PRICE_CROISIERE_MONTHLY || null,
    annual: process.env.STRIPE_PRICE_CROISIERE_ANNUAL || null
  }
}

// Construit le reverse map au chargement du module.
// Skippe les valeurs null (env vars non posées) pour ne pas écraser de vrais
// price IDs avec un mapping → null.
function buildReverseMap() {
  const out = {}
  for (const plan of Object.keys(PRICE_IDS)) {
    for (const cycle of Object.keys(PRICE_IDS[plan])) {
      const id = PRICE_IDS[plan][cycle]
      if (id) out[id] = { plan, billing_cycle: cycle }
    }
  }
  return out
}
export const PRICE_TO_PLAN = buildReverseMap()

export function getPriceId(plan, billingCycle) {
  return PRICE_IDS[plan]?.[billingCycle] || null
}

// Plans valides pour validation côté handler.
export const VALID_PLANS = ['demarrage', 'activite', 'croisiere']
export const VALID_BILLING_CYCLES = ['monthly', 'annual']

export function isValidPlan(plan) {
  return typeof plan === 'string' && VALID_PLANS.includes(plan)
}
export function isValidBillingCycle(cycle) {
  return typeof cycle === 'string' && VALID_BILLING_CYCLES.includes(cycle)
}

// Labels affichés dans les emails Resend.
export const PLAN_LABELS = {
  demarrage: 'Essentiel',
  activite: 'Régulier',
  croisiere: 'Intensif'
}
export const PLAN_PRICES_DISPLAY = {
  demarrage: { monthly: '24 €', annual: '240 €' },
  activite: { monthly: '34 €', annual: '340 €' },
  croisiere: { monthly: '44 €', annual: '440 €' }
}
