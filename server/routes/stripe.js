// Routes Stripe — souscription, gestion d'abonnement, webhooks.
//
// Endpoints :
//   POST /api/stripe/create-checkout-session  body { plan, billing_cycle, siret?, raison_sociale?, billing_address? }
//   POST /api/stripe/create-portal-session    body {}
//   POST /api/stripe/webhook                  raw body (signature Stripe)
//
// Le webhook est raw body — il DOIT être enregistré AVANT express.json()
// global dans server.js. Les 2 autres endpoints utilisent JSON normal.
//
// Routes /api/stripe/* sont exemptées :
//   - de la gate auth (webhook public, signature fait foi)
//   - de la gate subscription (un user expiré doit pouvoir payer)
// Mais create-checkout-session et create-portal-session exigent quand même
// req.userId — on appelle requireAuth en route-level pour ces 2 là.

import express from 'express'
import Stripe from 'stripe'
import { getDb } from '../../lib/surreal.js'
import { getPriceId, isValidPlan, isValidBillingCycle, PLAN_LABELS, PLAN_PRICES_DISPLAY, PRICE_TO_PLAN } from '../../lib/stripe-config.js'
import { requireAuth } from '../middleware/requireAuth.js'
import { invalidateSessionCacheByUserId } from '../auth/surreal-adapter.js'
import {
  sendSubscriptionActivated, sendSubscriptionChanged,
  sendSubscriptionCanceled, sendSubscriptionGraceStart, sendPaymentFailed
} from '../services/email.js'

let stripeClient = null
function getStripe() {
  if (stripeClient) return stripeClient
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('STRIPE_SECRET_KEY non configurée')
  stripeClient = new Stripe(key, { apiVersion: '2024-06-20' })
  return stripeClient
}

function appUrl() {
  return (process.env.APP_URL || 'https://movup.io').replace(/\/+$/, '')
}

function cleanUserId(raw) {
  return String(raw || '').replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')
}

// Convertit un timestamp Unix Stripe (secondes) en ISO datetime.
function toIsoDate(unixSeconds) {
  if (!unixSeconds) return null
  return new Date(unixSeconds * 1000).toISOString()
}

// Stripe API 2026-04-22.dahlia : current_period_end migré du niveau racine
// Subscription vers Subscription.items.data[].current_period_end. Fallback
// racine pour rétro-compat avec les events sérialisés en 2024-06-20
// (client SDK figé 2024-06-20, webhook endpoint en 2026-04-22.dahlia —
// incohérence connue, neutralisée fonctionnellement par ce fallback).
function extractCurrentPeriodEnd(subscription) {
  return subscription?.items?.data?.[0]?.current_period_end
      ?? subscription?.current_period_end
      ?? null
}

// Cherche un user par stripe_customer_id (utilisé par les webhooks).
async function findUserByStripeCustomerId(customerId) {
  if (!customerId) return null
  const db = await getDb()
  const r = await db.query(
    `SELECT * FROM user WHERE stripe_customer_id = $cid LIMIT 1`,
    { cid: customerId }
  )
  return r?.[0]?.[0] || null
}

// Met à jour un user via record id propre + body. Datetimes via SurrealQL
// pour éviter le problème de coercion (cf. fix b219bf7).
async function updateUserFields(userId, fields, currentPeriodEndUnix) {
  const db = await getDb()
  const id = cleanUserId(userId)
  // Premier UPDATE : champs simples (string, bool)
  if (Object.keys(fields).length > 0) {
    const sets = Object.keys(fields).map((k, i) => `${k} = $v${i}`).join(', ')
    const params = { id }
    Object.keys(fields).forEach((k, i) => { params['v' + i] = fields[k] })
    await db.query(`UPDATE type::record('user', $id) SET ${sets}`, params)
  }
  // Second UPDATE : current_period_end via SurrealQL si fourni
  if (currentPeriodEndUnix) {
    const seconds = Number(currentPeriodEndUnix)
    if (Number.isFinite(seconds)) {
      // SurrealDB v3 : time::from_secs(int) → datetime (underscore obligatoire — la forme avec scope :: n'existe pas, rejetée par le parser avec « did you maybe mean time::from_secs »)
      try {
        await db.query(
          `UPDATE type::record('user', $id) SET current_period_end = time::from_secs($s)`,
          { id, s: seconds }
        )
      } catch (e) {
        console.warn('[stripe] current_period_end set échec :', e.message)
      }
    }
  }
}

export const router = express.Router()

// ── POST /api/stripe/create-checkout-session ──
router.post('/create-checkout-session', requireAuth, async (req, res) => {
  try {
    const user = req.authUser
    if (!user) return res.status(401).json({ error: 'unauthorized' })

    const { plan, billing_cycle, siret, raison_sociale, billing_address } = req.body || {}
    if (!isValidPlan(plan)) return res.status(400).json({ error: 'invalid_plan', message: 'Plan invalide' })
    if (!isValidBillingCycle(billing_cycle)) return res.status(400).json({ error: 'invalid_billing_cycle', message: 'Cycle invalide' })

    // Empêche un user déjà abonné de relancer un Checkout (il doit passer par
    // le Customer Portal pour changer de plan).
    if (user.subscription_status === 'active' || user.subscription_status === 'trialing') {
      return res.status(400).json({
        error: 'already_subscribed',
        message: 'Abonnement déjà actif. Utilisez la gestion de l\'abonnement pour changer de plan.'
      })
    }

    const priceId = getPriceId(plan, billing_cycle)
    if (!priceId) {
      return res.status(503).json({
        error: 'stripe_not_configured',
        message: 'Tarif Stripe indisponible — vérifier les variables STRIPE_PRICE_*.'
      })
    }

    const stripe = getStripe()
    const userId = cleanUserId(user.id)

    // Persiste les infos de facturation envoyées par le front avant Checkout
    // (siret + raison_sociale + billing_address). Si non fournies, on garde
    // ce qu'il y a déjà en base.
    const billingFieldsToSave = {}
    if (typeof siret === 'string' && /^\d{14}$/.test(siret.replace(/\s+/g, ''))) {
      billingFieldsToSave.siret = siret.replace(/\s+/g, '')
    }
    if (typeof raison_sociale === 'string' && raison_sociale.trim()) {
      billingFieldsToSave.raison_sociale = raison_sociale.trim().slice(0, 200)
    }
    if (billing_address && typeof billing_address === 'object') {
      billingFieldsToSave.billing_address = billing_address
    }
    if (Object.keys(billingFieldsToSave).length > 0) {
      await updateUserFields(userId, billingFieldsToSave)
    }

    // Crée le Customer Stripe si absent.
    let customerId = user.stripe_customer_id
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: (raison_sociale || user.raison_sociale || user.name || '').trim() || undefined,
        metadata: { user_id: userId },
        ...(billing_address ? {
          address: {
            line1: billing_address.line1 || '',
            line2: billing_address.line2 || undefined,
            postal_code: billing_address.postal_code || '',
            city: billing_address.city || '',
            country: (billing_address.country || 'FR').toUpperCase()
          }
        } : {})
      })
      customerId = customer.id
      await updateUserFields(userId, { stripe_customer_id: customerId })
    }

    // Invalidation cache session : un seul appel après les 2 UPDATE potentiels
    // de ce bloc (billingFields + stripe_customer_id). Le prochain getSession
    // du user re-fetch l'objet user à jour (sinon désynchro 30s avec billing.html).
    invalidateSessionCacheByUserId(userId)

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: appUrl() + '/account/billing?success=true&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: appUrl() + '/account/upgrade?canceled=true&plan=' + encodeURIComponent(plan),
      metadata: { user_id: userId, plan, billing_cycle },
      subscription_data: { metadata: { user_id: userId, plan, billing_cycle } },
      locale: 'fr',
      billing_address_collection: 'required',
      customer_update: { address: 'auto', name: 'auto' },
      tax_id_collection: { enabled: true },
      allow_promotion_codes: true,
      custom_text: {
        submit: { message: 'TVA non applicable, art. 293 B du CGI.' }
      }
    })

    res.json({ url: session.url })
  } catch (err) {
    console.error('[stripe:create-checkout-session]', err.message)
    res.status(500).json({ error: 'checkout_failed', message: 'Création de la session Stripe impossible.' })
  }
})

// ── POST /api/stripe/create-portal-session ──
router.post('/create-portal-session', requireAuth, async (req, res) => {
  try {
    const user = req.authUser
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    const customerId = user.stripe_customer_id
    if (!customerId) {
      return res.status(400).json({
        error: 'no_stripe_customer',
        message: 'Aucun abonnement Stripe associé. Choisissez d\'abord un plan.'
      })
    }
    const stripe = getStripe()
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: appUrl() + '/account/billing'
    })
    res.json({ url: portal.url })
  } catch (err) {
    console.error('[stripe:create-portal-session]', err.message)
    res.status(500).json({ error: 'portal_failed', message: 'Ouverture du portail impossible.' })
  }
})

// ── POST /api/stripe/webhook ──
// IMPORTANT : raw body parser appliqué côté server.js avant express.json
// global. Ici on reçoit un Buffer qu'on passe à stripe.webhooks.constructEvent.
//
// Idempotence via la table stripe_events_processed (UNIQUE INDEX sur event_id).
// Si l'INSERT plante avec violation d'unicité, on skippe le traitement.
//
// Toujours répondre 200 OK rapidement (Stripe attend < 5s, sinon retry).
export async function webhookHandler(req, res) {
  const sig = req.headers['stripe-signature']
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!sig || !secret) {
    console.warn('[stripe:webhook] signature ou secret absent')
    return res.status(400).send('signature absente')
  }

  let event
  try {
    const stripe = getStripe()
    event = stripe.webhooks.constructEvent(req.body, sig, secret)
  } catch (err) {
    console.error('[stripe:webhook] signature invalide :', err.message)
    return res.status(400).send('signature invalide')
  }

  // Réponse rapide à Stripe — le traitement effectif est asynchrone.
  res.status(200).json({ received: true })

  // Traitement async (errors loggés mais non propagés)
  ;(async () => {
    try {
      const db = await getDb()

      // Idempotence — on tente d'insérer event_id (UNIQUE), si échec on skip.
      try {
        await db.query(
          `CREATE stripe_events_processed SET event_id = $eid, event_type = $etype`,
          { eid: event.id, etype: event.type }
        )
      } catch (e) {
        // Violation d'unicité = déjà traité, on skip silencieusement.
        console.log('[stripe:webhook] event déjà traité, skip :', event.id)
        return
      }

      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object
          const stripe = getStripe()
          const userId = session.metadata?.user_id
          const plan = session.metadata?.plan
          const billing_cycle = session.metadata?.billing_cycle
          if (!userId || !plan) {
            console.warn('[stripe:webhook] checkout.completed sans metadata user_id/plan')
            return
          }
          const subscription = await stripe.subscriptions.retrieve(session.subscription)
          await updateUserFields(userId, {
            stripe_subscription_id: subscription.id,
            stripe_customer_id: session.customer,
            subscription_status: subscription.status || 'active',
            plan,
            plan_billing_cycle: billing_cycle,
            trial_status: 'converted'
          }, extractCurrentPeriodEnd(subscription))

          // Invalidation cache session : webhook hors session HTTP, mais le
          // userId vient de session.metadata.user_id. Sans ça, le user revient
          // sur /account/billing post-checkout et voit l'ancien snapshot (sans
          // stripe_customer_id) → redirect vers /account/upgrade en boucle.
          invalidateSessionCacheByUserId(userId)

          // Email confirmation
          try {
            const r = await db.query(`SELECT * FROM type::record('user', $id)`, { id: cleanUserId(userId) })
            const u = r?.[0]?.[0]
            if (u?.email) {
              await sendSubscriptionActivated({
                email: u.email,
                prenom: u.prenom,
                plan_label: PLAN_LABELS[plan] || plan,
                cycle: billing_cycle,
                price_display: PLAN_PRICES_DISPLAY[plan]?.[billing_cycle] || '',
                current_period_end: toIsoDate(extractCurrentPeriodEnd(subscription))
              })
            }
          } catch (e) { console.warn('[stripe:webhook] email activated échoué :', e.message) }
          break
        }

        case 'customer.subscription.updated': {
          const subscription = event.data.object
          const user = await findUserByStripeCustomerId(subscription.customer)
          if (!user) {
            console.warn('[stripe:webhook] subscription.updated : user introuvable pour customer', subscription.customer)
            return
          }
          const userId = cleanUserId(user.id)
          // Détection du nouveau plan via le price_id de l'item courant
          const currentPriceId = subscription.items?.data?.[0]?.price?.id
          const mapped = currentPriceId ? PRICE_TO_PLAN[currentPriceId] : null
          const oldPlan = user.plan
          const newPlan = mapped?.plan || user.plan
          const newCycle = mapped?.billing_cycle || user.plan_billing_cycle
          // Détection transition cancel_at_period_end (cf. bloc email H2b après l.343).
          const prevCancel = user.cancel_at_period_end === true
          const newCancel = subscription.cancel_at_period_end === true

          await updateUserFields(userId, {
            subscription_status: subscription.status || 'active',
            plan: newPlan,
            plan_billing_cycle: newCycle,
            cancel_at_period_end: newCancel
          }, extractCurrentPeriodEnd(subscription))

          // Invalidation cache session : plan / cycle peuvent changer via
          // Customer Portal Stripe — la lecture suivante de window.__USER__
          // ou /api/user/me doit refléter le nouveau plan immédiatement.
          invalidateSessionCacheByUserId(userId)

          // Email si changement de plan
          if (mapped && oldPlan && oldPlan !== newPlan && user.email) {
            try {
              await sendSubscriptionChanged({
                email: user.email,
                prenom: user.prenom,
                old_plan_label: PLAN_LABELS[oldPlan] || oldPlan,
                new_plan_label: PLAN_LABELS[newPlan] || newPlan,
                cycle: newCycle,
                price_display: PLAN_PRICES_DISPLAY[newPlan]?.[newCycle] || ''
              })
            } catch (e) { console.warn('[stripe:webhook] email changed échoué :', e.message) }
          }

          // Email 1 cycle résiliation (H2b) : transition cancel_at_period_end
          // false→true = demande de résiliation utilisateur. EXCLUSION : un
          // changement de plan simultané est une CONTINUITÉ d'abonnement
          // (artefact Stripe proration/scheduling), pas une résiliation —
          // l'email cancel ne part pas dans ce cas. Transition true→false
          // (réactivation Portal "Don't cancel") : aucun email, l'UPDATE
          // ci-dessus a déjà reset cancel_at_period_end=false (silencieux
          // volontaire).
          const planChanged = mapped && oldPlan && oldPlan !== newPlan
          if (prevCancel !== newCancel && newCancel === true && !planChanged && user.email) {
            try {
              await sendSubscriptionCanceled({
                email: user.email,
                prenom: user.prenom,
                plan_label: PLAN_LABELS[user.plan] || user.plan || 'Démarrage',
                period_end: toIsoDate(extractCurrentPeriodEnd(subscription))
              })
            } catch (e) { console.warn('[stripe:webhook] email cancel échoué :', e.message) }
          }
          break
        }

        case 'customer.subscription.deleted': {
          const subscription = event.data.object
          const user = await findUserByStripeCustomerId(subscription.customer)
          if (!user) {
            console.warn('[stripe:webhook] subscription.deleted : user introuvable')
            return
          }
          const userId = cleanUserId(user.id)
          // H2b : trial_status n'est plus mis à 'expired' ici (la doctrine
          // grâce 7j sera gouvernée par subscription_status='canceled' +
          // current_period_end+7d via le middleware H3). cancel_at_period_end
          // non reset volontairement — son résiduel à true post-deleted est
          // sans effet, H3 se basera sur subscription_status.
          await updateUserFields(userId, {
            subscription_status: 'canceled',
            stripe_subscription_id: null
          })

          // Invalidation cache session : la bascule subscription_status →
          // 'canceled' doit être vue immédiatement par billing.html et le
          // middleware grâce 7j (H3) qui lit subscription_status depuis user.
          invalidateSessionCacheByUserId(userId)

          if (user.email) {
            try {
              // Email 2 cycle résiliation (H2b) : entrée en grâce 7j, CTA
              // export RGPD. grace_until_date = current_period_end + 7d
              // (non formaté — le helper applique formatDateFR).
              const gracePlus7d = new Date(new Date(user.current_period_end).getTime() + 7 * 24 * 3600 * 1000).toISOString()
              await sendSubscriptionGraceStart({
                email: user.email,
                prenom: user.prenom,
                plan_label: PLAN_LABELS[user.plan] || user.plan || 'Démarrage',
                grace_until_date: gracePlus7d,
                privacy_url: appUrl() + '/account/privacy'
              })
            } catch (e) { console.warn('[stripe:webhook] email grace-start échoué :', e.message) }
          }
          break
        }

        case 'invoice.payment_failed': {
          const invoice = event.data.object
          const user = await findUserByStripeCustomerId(invoice.customer)
          if (!user) {
            console.warn('[stripe:webhook] payment_failed : user introuvable')
            return
          }
          const userId = cleanUserId(user.id)
          await updateUserFields(userId, { subscription_status: 'past_due' })

          // Invalidation cache session : billing.html doit voir l'état
          // 'past_due' immédiatement pour afficher le bandeau "Action requise".
          invalidateSessionCacheByUserId(userId)

          if (user.email) {
            try {
              const stripe = getStripe()
              const portal = await stripe.billingPortal.sessions.create({
                customer: invoice.customer,
                return_url: appUrl() + '/account/billing'
              }).catch(() => null)
              await sendPaymentFailed({
                email: user.email,
                prenom: user.prenom,
                plan_label: PLAN_LABELS[user.plan] || user.plan || 'Démarrage',
                portal_url: portal?.url || null
              })
            } catch (e) { console.warn('[stripe:webhook] email payment_failed échoué :', e.message) }
          }
          break
        }

        default:
          console.log('[stripe:webhook] event ignoré :', event.type)
      }
    } catch (e) {
      console.error('[stripe:webhook] traitement échec :', e.message)
    }
  })()
}
