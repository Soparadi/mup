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
  // Premier UPDATE : champs simples (string, bool, etc.).
  // SurrealDB v3 : les champs option<...> rejettent NULL littéral
  // (« Expected none | string but found NULL »). Pour vider un champ
  // option, il faut SET k = NONE inline (pas de binding $vX null).
  // Pattern de référence : scripts/reset-stripe-customer-ids.js l.53
  // (SET stripe_customer_id = NONE). Conséquence pour les callers :
  // passer `null` ou `undefined` pour un champ option déclenche un
  // UNSET propre via NONE ; toute autre valeur reste bindée comme avant.
  if (Object.keys(fields).length > 0) {
    const params = { id }
    const sets = Object.keys(fields).map((k, i) => {
      const v = fields[k]
      if (v === null || v === undefined) return `${k} = NONE`
      params['v' + i] = v
      return `${k} = $v${i}`
    }).join(', ')
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

// ── POST /api/stripe/create-portal-session ──
router.post('/create-portal-session', requireAuth, async (req, res) => {
  try {
    const user = req.authUser
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    const customerId = user.stripe_customer_id
    if (!customerId) {
      return res.status(410).json({
        error: 'stale_or_missing',
        redirect_url: '/tarifs',
        message: 'Aucun abonnement actif. Choisissez un plan.'
      })
    }
    const stripe = getStripe()
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: appUrl() + '/account/billing'
    })
    res.json({ url: portal.url })
  } catch (err) {
    const code = err?.code || err?.raw?.code
    if (code === 'resource_missing') {
      // Customer Stripe périmé (bascule Test→Live / suppression admin) :
      // purge best-effort des champs Stripe, puis redirect vers /tarifs.
      const au = req.authUser
      if (au && au.id) {
        try {
          const uid = cleanUserId(au.id)
          await updateUserFields(uid, {
            stripe_customer_id: null,
            stripe_subscription_id: null,
            subscription_status: null,
            current_period_end: null,
            trial_status: null
          })
          invalidateSessionCacheByUserId(uid)
        } catch (e) {
          console.warn('[stripe:create-portal-session] purge customer périmé échec:', e.message)
        }
      }
      console.warn('[stripe:create-portal-session] customer périmé purgé:', err.message)
      return res.status(410).json({
        error: 'stale_or_missing',
        redirect_url: '/tarifs',
        message: 'Abonnement à renouveler.'
      })
    }
    console.error('[stripe:create-portal-session]', err.message)
    res.status(500).json({ error: 'portal_failed', message: 'Ouverture du portail impossible.' })
  }
})

// ── GET /api/stripe/quick-checkout ──
// Route GET pour redirect direct vers Stripe Checkout depuis les modales
// (trial-expired-modal, leads plafond, etc.). Pas de form intermédiaire —
// raison sociale + adresse facturation collectées par Stripe Checkout en
// natif via billing_address_collection:'required' + customer_update:'auto'.
// SIRET capté plus tard au 1er devis (tax_id_collection désactivé).
router.get('/quick-checkout', requireAuth, async (req, res) => {
  try {
    const user = req.authUser
    if (!user) return res.redirect(302, '/login')

    const userId = cleanUserId(user.id)
    const plan = String(req.query.plan || '').toLowerCase()
    const cycle = String(req.query.cycle || '').toLowerCase()

    const VALID_PLANS = ['demarrage', 'activite', 'croisiere']
    const VALID_CYCLES = ['monthly', 'annual']
    if (!VALID_PLANS.includes(plan) || !VALID_CYCLES.includes(cycle)) {
      return res.redirect(302, '/account/billing?error=invalid_plan')
    }

    if (user.subscription_status === 'active' || user.subscription_status === 'trialing') {
      return res.redirect(302, '/account/billing')
    }

    const priceId = getPriceId(plan, cycle)
    if (!priceId) {
      return res.redirect(302, '/account/billing?error=stripe_not_configured')
    }

    const stripe = getStripe()

    let customerId = user.stripe_customer_id
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { user_id: userId }
      })
      customerId = customer.id
      await updateUserFields(userId, { stripe_customer_id: customerId })
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: appUrl() + '/account/billing?success=true&session_id={CHECKOUT_SESSION_ID}',
      cancel_url:  appUrl() + '/account/billing?canceled=true&plan=' + encodeURIComponent(plan),
      metadata: { user_id: userId, plan, billing_cycle: cycle },
      subscription_data: { metadata: { user_id: userId, plan, billing_cycle: cycle } },
      locale: 'fr',
      billing_address_collection: 'required',
      customer_update: { address: 'auto', name: 'auto' },
      tax_id_collection: { enabled: false },
      allow_promotion_codes: true,
      custom_text: { submit: { message: 'TVA non applicable, art. 293 B du CGI.' } }
    })

    return res.redirect(303, session.url)
  } catch (err) {
    const code = err?.code || err?.raw?.code
    if (code === 'resource_missing') {
      // Customer Stripe périmé : purge best-effort, puis redirect vers /tarifs
      // (re-choix de plan → nouveau customer Live créé au prochain Checkout).
      const au = req.authUser
      if (au && au.id) {
        try {
          const uid = cleanUserId(au.id)
          await updateUserFields(uid, {
            stripe_customer_id: null,
            stripe_subscription_id: null,
            subscription_status: null,
            current_period_end: null,
            trial_status: null
          })
          invalidateSessionCacheByUserId(uid)
        } catch (e) {
          console.warn('[quick-checkout] purge customer périmé échec:', e.message)
        }
      }
      console.warn('[quick-checkout] customer périmé purgé:', err.message)
      return res.redirect(302, '/tarifs')
    }
    console.error('[quick-checkout]', err)
    return res.redirect(302, '/account/billing?error=checkout_failed')
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

          // SELECT user pré-update : sert à la fois (1) au garde-fou
          // « ne pas écraser raison_sociale/billing_address déjà saisis
          // manuellement » lors de l'extraction Customer Stripe ci-dessous,
          // et (2) à l'email confirmation plus bas (factorisation — un seul
          // SELECT au lieu de deux).
          const r = await db.query(`SELECT * FROM type::record('user', $id)`, { id: cleanUserId(userId) })
          const u = r?.[0]?.[0]
          if (!u) {
            console.warn('[stripe:webhook] user introuvable pour checkout.completed', userId)
            return
          }

          // Extraction Customer Stripe (raison_sociale + billing_address) en
          // try/catch SÉPARÉ du updateUserFields : si stripe.customers.retrieve
          // plante (rate limit, network, Customer supprimé via Dashboard), le
          // webhook continue et l'abonnement reste actif. raison_sociale +
          // billing_address restent vides, captés au 1er devis ultérieurement.
          // Garde priorité au manuel : on n'écrase pas un champ déjà rempli
          // côté user.
          const fieldsFromStripe = {}
          try {
            const customer = await stripe.customers.retrieve(session.customer)
            if (customer.name && customer.name.trim() && !u.raison_sociale) {
              fieldsFromStripe.raison_sociale = customer.name.trim().slice(0, 200)
            }
            if (customer.address && customer.address.line1 && !u.billing_address) {
              const addr = customer.address
              fieldsFromStripe.billing_address = {
                line1: addr.line1 || '',
                line2: addr.line2 || undefined,
                postal_code: addr.postal_code || '',
                city: addr.city || '',
                country: (addr.country || 'FR').toUpperCase()
              }
            }
            if (Object.keys(fieldsFromStripe).length > 0) {
              console.log('[stripe:webhook] checkout.completed Customer fields extracted:', Object.keys(fieldsFromStripe).join(', '))
            }
          } catch (e) {
            console.warn('[stripe:webhook] extraction Customer échouée :', e.message)
          }

          await updateUserFields(userId, {
            stripe_subscription_id: subscription.id,
            stripe_customer_id: session.customer,
            subscription_status: subscription.status || 'active',
            plan,
            plan_billing_cycle: billing_cycle,
            trial_status: 'converted',
            ...fieldsFromStripe
          }, extractCurrentPeriodEnd(subscription))

          // Invalidation cache session : webhook hors session HTTP, mais le
          // userId vient de session.metadata.user_id. Sans ça, le user revient
          // sur /account/billing post-checkout et voit l'ancien snapshot (sans
          // stripe_customer_id) → redirect vers /account/billing en boucle.
          invalidateSessionCacheByUserId(userId)

          // Email confirmation (utilise u déjà chargé plus haut — factorisé).
          try {
            if (u.email) {
              await sendSubscriptionActivated({
                email: u.email,
                prenom: u.prenom,
                nom: u.nom,
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
                nom: user.nom,
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
                nom: user.nom,
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
                nom: user.nom,
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

          // GARDE 1 — 3DS/SCA en cours : le PaymentIntent est en attente
          // d'authentification, ce n'est pas un échec réel.
          if (invoice.payment_intent) {
            try {
              const stripe = getStripe()
              const pi = await stripe.paymentIntents.retrieve(invoice.payment_intent)
              if (pi.status === 'requires_action' || pi.status === 'requires_confirmation') {
                console.log('[stripe:webhook] invoice.payment_failed skipped: 3DS in progress', {
                  invoice_id: invoice.id,
                  payment_intent_id: invoice.payment_intent,
                  pi_status: pi.status
                })
                return
              }
            } catch (err) {
              console.warn('[stripe:webhook] invoice.payment_failed: could not retrieve payment_intent', {
                invoice_id: invoice.id,
                error: err.message
              })
              // On continue les autres gardes
            }
          }

          // GARDE 2 — Première tentative avec retry Stripe programmé :
          // pas un échec définitif, Stripe retentera automatiquement.
          if (invoice.attempt_count === 1 && invoice.next_payment_attempt !== null) {
            console.log('[stripe:webhook] invoice.payment_failed skipped: first attempt with retry scheduled', {
              invoice_id: invoice.id,
              attempt_count: invoice.attempt_count,
              next_payment_attempt: invoice.next_payment_attempt
            })
            return
          }

          // GARDE 3 — Subscription parent encore active ou incomplete :
          // l'échec n'est pas encore confirmé côté Stripe.
          if (invoice.subscription) {
            try {
              const stripe = getStripe()
              const sub = await stripe.subscriptions.retrieve(invoice.subscription)
              if (sub.status === 'active' || sub.status === 'incomplete') {
                console.log('[stripe:webhook] invoice.payment_failed skipped: subscription not yet past_due', {
                  invoice_id: invoice.id,
                  subscription_id: invoice.subscription,
                  sub_status: sub.status
                })
                return
              }
            } catch (err) {
              console.warn('[stripe:webhook] invoice.payment_failed: could not retrieve subscription', {
                invoice_id: invoice.id,
                error: err.message
              })
              // On continue le traitement normal (échec confirmé)
            }
          }

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
                nom: user.nom,
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
