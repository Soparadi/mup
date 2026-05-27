// scripts/check-resend-deliveries.js
//
// One-shot LECTURE SEULE — liste les derniers envois Resend et leur dernier
// événement (delivered / bounced / complained …) pour diagnostiquer la
// livraison des emails opt-out (Phase 6 Étape 8c). Aucun envoi, aucune
// modification : GET uniquement.
//
// Usage : node scripts/check-resend-deliveries.js

import 'dotenv/config'

const key = process.env.RESEND_API_KEY
if (!key) {
  console.error('RESEND_API_KEY manquante dans .env')
  process.exit(1)
}
const H = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }

const r = await fetch('https://api.resend.com/emails', { headers: H })
if (!r.ok) {
  console.error('Resend list error', r.status, (await r.text()).slice(0, 400))
  process.exit(1)
}
const payload = await r.json()
const items = Array.isArray(payload) ? payload : (payload.data || [])
console.log('Envois renvoyés par /emails :', items.length, '\n')

// Le détail /emails/:id est la source fiable pour from/to/subject/last_event
// (la liste peut renvoyer des objets partiels). GET en lecture seule.
const recent = items.slice(0, 10)
for (const it of recent) {
  let e = it
  if (it.id) {
    try {
      const d = await fetch('https://api.resend.com/emails/' + it.id, { headers: H })
      if (d.ok) e = await d.json()
    } catch (_) {}
  }
  console.log(JSON.stringify({
    id: e.id,
    from: e.from,
    to: e.to,
    subject: e.subject,
    created_at: e.created_at,
    last_event: e.last_event ?? null
  }))
}
