// scripts/inventaire-comptes.js
//
// LECTURE SEULE (DB + Stripe). Aucune écriture, aucune création/résiliation.
// Produit l'inventaire nominatif de tous les comptes MovUP :
//   user + user_plan + nb fiches pipeline + état abonnement Stripe (read-only).
//
// Usage : railway run node scripts/inventaire-comptes.js
//
// Garanties : uniquement SELECT côté SurrealDB et list/retrieve côté Stripe.

import { Surreal } from 'surrealdb'
import Stripe from 'stripe'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const norm = (id) => String(id ?? '').replace(/^user:/, '').replace(/^user_plan:/, '').replace(/^⟨+|⟩+$/g, '')
const pad = (s, n) => { s = String(s ?? ''); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length) }
const fmtDate = (d) => {
  if (!d) return ''
  try { return new Date(d).toISOString().slice(0, 10) } catch { return String(d).slice(0, 10) }
}

// ── SurrealDB ──
const url = process.env.SURREAL_URL
const ns = process.env.SURREAL_NAMESPACE
const dbName = process.env.SURREAL_DATABASE
const dbUser = process.env.SURREAL_USER
const dbPass = process.env.SURREAL_PASS
if (!url || !ns || !dbName || !dbUser || !dbPass) {
  console.error('Variables SURREAL_* manquantes'); process.exit(1)
}

// ── Stripe ──
const stripeKey = process.env.STRIPE_SECRET_KEY
const stripe = stripeKey ? new Stripe(stripeKey, { apiVersion: '2024-06-20' }) : null
const stripeMode = !stripeKey ? 'ABSENT'
  : stripeKey.startsWith('sk_live_') ? 'LIVE'
  : stripeKey.startsWith('sk_test_') ? 'TEST' : 'INCONNU'

const db = new Surreal()
await db.connect(url, {
  namespace: ns, database: dbName,
  authentication: { namespace: ns, username: dbUser, password: dbPass }
})
console.error(`[db] connecté ${url} · ns=${ns} db=${dbName}`)
console.error(`[stripe] clé mode ${stripeMode}\n`)

// ── 1. Tous les comptes ──
const usersRes = await db.query('SELECT * FROM user ORDER BY created_at')
const users = usersRes[0] || []

// ── 2. user_plan ──
const planRes = await db.query('SELECT * FROM user_plan')
const plans = planRes[0] || []
const planById = new Map()
for (const p of plans) planById.set(norm(p.userId || p.id), p)

// ── 3. fiches pipeline par compte ──
const pipeRes = await db.query('SELECT userId, count() AS n FROM pipeline GROUP BY userId')
const pipeRows = pipeRes[0] || []
const fichesById = new Map()
for (const r of pipeRows) fichesById.set(norm(r.userId), r.n)

// ── 4. Stripe read-only : subscriptions actives + customers liés ──
const stripeActiveByCustomer = new Map()   // customerId -> [subs]
const stripeSubById = new Map()             // subId -> sub
const stripeActiveSubIds = new Set()
let stripeError = null
if (stripe) {
  try {
    // subscriptions actives (toutes)
    for (const status of ['active', 'trialing', 'past_due', 'unpaid']) {
      let starting_after
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const page = await stripe.subscriptions.list({ status, limit: 100, starting_after })
        for (const s of page.data) {
          stripeSubById.set(s.id, s)
          if (s.status === 'active' || s.status === 'trialing') stripeActiveSubIds.add(s.id)
          const cust = typeof s.customer === 'string' ? s.customer : s.customer?.id
          if (!stripeActiveByCustomer.has(cust)) stripeActiveByCustomer.set(cust, [])
          stripeActiveByCustomer.get(cust).push(s)
        }
        if (!page.has_more) break
        starting_after = page.data[page.data.length - 1].id
        await sleep(120)
      }
    }
  } catch (e) {
    stripeError = e.message
  }
}

// ── Construction du tableau ──
function userField(u, plan, key) {
  if (u[key] !== undefined && u[key] !== null && u[key] !== '') return u[key]
  if (plan && plan[key] !== undefined && plan[key] !== null && plan[key] !== '') return plan[key]
  return null
}

const rows = []
const customerIdsSeen = new Set()
const subIdsSeen = new Set()
for (const u of users) {
  const id = norm(u.id)
  const plan = planById.get(id)
  const email = u.email || ''
  const prenom = u.prenom || u.name || ''
  const planName = userField(u, plan, 'plan') || 'gratuit'
  const subStatus = userField(u, plan, 'subscription_status') || ''
  const trialStatus = userField(u, plan, 'trial_status') || ''
  const custId = userField(u, plan, 'stripe_customer_id')
  const subId = userField(u, plan, 'stripe_subscription_id')
  const cycle = userField(u, plan, 'plan_billing_cycle') || ''
  const periodEnd = userField(u, plan, 'current_period_end')
  const leadsUsed = plan?.leadsConsumedThisMonth ?? u.leadsConsumedThisMonth ?? ''
  const fiches = fichesById.get(id) ?? 0
  if (custId) customerIdsSeen.add(custId)
  if (subId) subIdsSeen.add(subId)

  // abo Stripe actif ?
  let aboActif = 'N'
  if (subId && stripeActiveSubIds.has(subId)) aboActif = 'O'
  else if (custId && (stripeActiveByCustomer.get(custId) || []).some(s => s.status === 'active' || s.status === 'trialing')) aboActif = 'O(cust)'

  rows.push({
    email, prenom, planName, subStatus, trialStatus, aboActif,
    leadsUsed, fiches, created: fmtDate(u.created_at), periodEnd: fmtDate(periodEnd),
    custId, subId, cycle
  })
}

// ── Affichage tableau ──
const H = ['email', 'prenom', 'plan', 'sub_status', 'trial', 'aboStripe', 'leads', 'fiches', 'créé', 'fin_période']
console.log('\n================ INVENTAIRE DES COMPTES (trié par created_at) ================\n')
console.log([pad(H[0], 32), pad(H[1], 12), pad(H[2], 12), pad(H[3], 12), pad(H[4], 10), pad(H[5], 9), pad(H[6], 6), pad(H[7], 7), pad(H[8], 11), pad(H[9], 11)].join(' | '))
console.log('-'.repeat(140))
for (const r of rows) {
  console.log([
    pad(r.email, 32), pad(r.prenom, 12), pad(r.planName, 12), pad(r.subStatus, 12),
    pad(r.trialStatus, 10), pad(r.aboActif, 9), pad(r.leadsUsed, 6), pad(r.fiches, 7),
    pad(r.created, 11), pad(r.periodEnd, 11)
  ].join(' | '))
}

// ── Détail Stripe / customer & sub ids (pour recoupement) ──
console.log('\n---- Détail identifiants Stripe en base (par compte) ----')
for (const r of rows) {
  if (r.custId || r.subId) {
    console.log(`${pad(r.email, 32)} cust=${r.custId || '-'} sub=${r.subId || '-'} cycle=${r.cycle || '-'} aboActif=${r.aboActif}`)
  }
}

// ── Synthèse ──
const totalComptes = users.length
const vraisPayants = rows.filter(r => r.aboActif === 'O' || r.aboActif === 'O(cust)')

// incohérences :
// (i) sub Stripe active sans compte base correspondant
const baseSubIds = subIdsSeen
const baseCustIds = customerIdsSeen
const orphanStripeSubs = []
for (const [subId, s] of stripeSubById) {
  if ((s.status === 'active' || s.status === 'trialing') && !baseSubIds.has(subId)) {
    const cust = typeof s.customer === 'string' ? s.customer : s.customer?.id
    if (!baseCustIds.has(cust)) orphanStripeSubs.push({ subId, cust, status: s.status, email: s.customer_email || '?' })
  }
}
// (ii) compte base avec stripe_subscription_id mais pas d'abo actif côté Stripe (fantôme)
const ghostBase = rows.filter(r => r.subId && r.aboActif === 'N')

console.log('\n================ SYNTHÈSE ================\n')
console.log(`(a) Nombre total de comptes (table user) : ${totalComptes}`)
if (stripe && !stripeError) {
  console.log(`(b) Comptes avec abonnement Stripe ACTIF (vrais payants) : ${vraisPayants.length}`)
  if (vraisPayants.length) for (const r of vraisPayants) console.log(`      → ${r.email} (sub=${r.subId || 'via customer'})`)
  console.log(`    Total subscriptions Stripe actives/trialing côté facturation : ${stripeActiveSubIds.size}`)
} else {
  console.log(`(b) LECTURE STRIPE INDISPONIBLE${stripeError ? ' : ' + stripeError : ' (pas de clé)'} — étape 4 non concluante, aucun abonnement deviné.`)
}
console.log(`(c) Incohérences :`)
console.log(`    - Subscriptions Stripe actives SANS compte base correspondant (orphelines) : ${orphanStripeSubs.length}`)
for (const o of orphanStripeSubs) console.log(`        → sub=${o.subId} cust=${o.cust} email=${o.email} status=${o.status}`)
console.log(`    - Comptes base avec stripe_subscription_id mais SANS abo actif côté Stripe (fantômes) : ${ghostBase.length}`)
for (const g of ghostBase) console.log(`        → ${g.email} sub=${g.subId} sub_status_base=${g.subStatus || '-'}`)
console.log(`\n(d) STOP — aucune modification effectuée. En attente de votre GO.`)

await db.close()
process.exit(0)
