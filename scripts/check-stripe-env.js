// scripts/check-stripe-env.js
//
// Valide que les 8 variables d'environnement Stripe sont posées et au bon
// format. Sortie : tableau ASCII + exit 0 (tout OK) ou exit 1 (manque/format).
//
// Usage local : node scripts/check-stripe-env.js
// Usage Railway : ajouter en hook predeploy ou lancer après mise à jour vars.
// Lit .env si présent (mode local). En prod Railway, les vars sont déjà
// dans process.env.

import 'dotenv/config'

const CHECKS = [
  { name: 'STRIPE_SECRET_KEY',                prefixes: ['sk_test_', 'sk_live_'], required: true },
  { name: 'STRIPE_WEBHOOK_SECRET',            prefixes: ['whsec_'],               required: true },
  { name: 'STRIPE_PRICE_DEMARRAGE_MONTHLY',   prefixes: ['price_'],               required: true },
  { name: 'STRIPE_PRICE_DEMARRAGE_ANNUAL',    prefixes: ['price_'],               required: true },
  { name: 'STRIPE_PRICE_ACTIVITE_MONTHLY',    prefixes: ['price_'],               required: true },
  { name: 'STRIPE_PRICE_ACTIVITE_ANNUAL',     prefixes: ['price_'],               required: true },
  { name: 'STRIPE_PRICE_CROISIERE_MONTHLY',   prefixes: ['price_'],               required: true },
  { name: 'STRIPE_PRICE_CROISIERE_ANNUAL',    prefixes: ['price_'],               required: true }
]

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length) }

const NAME_W = 36
const STAT_W = 8
const FMT_W = 12

console.log('| ' + pad('Variable', NAME_W) + ' | ' + pad('Statut', STAT_W) + ' | ' + pad('Format', FMT_W) + ' |')
console.log('|' + '-'.repeat(NAME_W + 2) + '|' + '-'.repeat(STAT_W + 2) + '|' + '-'.repeat(FMT_W + 2) + '|')

let hasError = false
for (const c of CHECKS) {
  const value = process.env[c.name]
  let status, format
  if (!value || value.trim() === '') {
    status = 'MANQUE'
    format = '—'
    if (c.required) hasError = true
  } else {
    const prefixOk = c.prefixes.some(p => value.startsWith(p))
    if (!prefixOk) {
      status = 'PRÉSENT'
      format = 'FORMAT KO'
      hasError = true
    } else {
      // Vérif minimale : assez long pour être plausible (price_ Stripe ~26+,
      // sk_test_ ~32+, whsec_ ~32+).
      const minLen = c.prefixes[0].length + 8
      if (value.length < minLen) {
        status = 'PRÉSENT'
        format = 'TROP COURT'
        hasError = true
      } else {
        status = 'OK'
        format = c.prefixes.length > 1
          ? (value.startsWith('sk_test_') ? 'TEST' : 'LIVE')
          : 'OK'
      }
    }
  }
  console.log('| ' + pad(c.name, NAME_W) + ' | ' + pad(status, STAT_W) + ' | ' + pad(format, FMT_W) + ' |')
}

console.log('')

// Vérif optionnelle : cohérence Test/Live entre clé secrète et webhook.
const sk = process.env.STRIPE_SECRET_KEY || ''
const whsec = process.env.STRIPE_WEBHOOK_SECRET || ''
if (sk.startsWith('sk_test_') && whsec.startsWith('whsec_')) {
  console.log('Mode détecté : TEST (sk_test_*).')
} else if (sk.startsWith('sk_live_') && whsec.startsWith('whsec_')) {
  console.log('Mode détecté : LIVE (sk_live_*). Vérifier que le webhook a été créé en Live.')
}

// STRIPE_PUBLISHABLE_KEY non utilisée par le code actuel — info uniquement.
const pk = process.env.STRIPE_PUBLISHABLE_KEY
if (pk) {
  console.log('Note : STRIPE_PUBLISHABLE_KEY présente mais non lue par le code (Checkout server-side).')
}

if (hasError) {
  console.error('\nÉCHEC : variables manquantes ou mal formatées. Voir le tableau ci-dessus.')
  process.exit(1)
}
console.log('\nSUCCÈS : 8 variables Stripe correctement configurées.')
process.exit(0)
