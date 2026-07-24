# Stripe — Configuration manuelle MovUP

Ce document décrit la configuration **côté Stripe Dashboard** nécessaire pour que
le code mergé en commit `be01674` fonctionne en prod.

Le code couvre : Checkout en mode `subscription`, gestion d'abonnement via
Customer Portal, webhook signé/idempotent, 4 emails transactionnels Resend,
schéma SurrealDB et middleware de bascule trial → converted.

Toutes les actions ci-dessous sont à faire dans le Dashboard Stripe.

---

## 1. Pricing figé (à respecter à l'identique)

| Plan | Mensuel | Annuel/mois (-15 %) | Annuel total |
|---|---|---|---|
| Essentiel | 19,00 € | 16,00 € | 192,00 € |
| Régulier | 29,00 € | 25,00 € | 300,00 € |
| Intensif | 39,00 € | 33,00 € | 396,00 € |

Cible : auto-entrepreneur français en franchise TVA art. 293 B du CGI.
**Pas de TVA collectée**. Les montants Stripe sont saisis en TTC=HT (le
`tax_id_collection` est activé pour la conformité facture).

---

## 2. Création des 6 produits

Dans **Products → Add product**, créer **3 produits** (Essentiel, Régulier,
Intensif). Pour chacun, ajouter **2 prix** (mensuel + annuel) en EUR.

### Produit 1 — Essentiel

- **Name** : `MovUP Essentiel`
- **Description** : `Plan Essentiel MovUP — pour lancer son activité.`
- **Tax behavior** : Inclusive (ou laisser par défaut, sans TVA)
- **Metadata produit** : `plan=demarrage`

Prix à ajouter :

| Type | Montant | Currency | Billing | Metadata |
|---|---|---|---|---|
| Recurring | 19,00 | EUR | Monthly | `plan=demarrage`, `cycle=monthly` |
| Recurring | 192,00 | EUR | Yearly | `plan=demarrage`, `cycle=annual` |

Noter les `price_id` retournés (commencent par `price_`).

### Produit 2 — Régulier

- **Name** : `MovUP Régulier`
- **Description** : `Plan Régulier MovUP — pour prospecter chaque semaine.`
- **Metadata produit** : `plan=activite`

| Type | Montant | Currency | Billing | Metadata |
|---|---|---|---|---|
| Recurring | 29,00 | EUR | Monthly | `plan=activite`, `cycle=monthly` |
| Recurring | 300,00 | EUR | Yearly | `plan=activite`, `cycle=annual` |

### Produit 3 — Intensif

- **Name** : `MovUP Intensif`
- **Description** : `Plan Intensif MovUP — pour piloter une activité installée.`
- **Metadata produit** : `plan=croisiere`

| Type | Montant | Currency | Billing | Metadata |
|---|---|---|---|---|
| Recurring | 39,00 | EUR | Monthly | `plan=croisiere`, `cycle=monthly` |
| Recurring | 396,00 | EUR | Yearly | `plan=croisiere`, `cycle=annual` |

> **Note metadata** : les metadata Stripe servent à la traçabilité dans le
> Dashboard. Le code MovUP ne s'en sert pas pour identifier le plan — il
> utilise le mapping `lib/stripe-config.js` qui lit les `STRIPE_PRICE_*`
> depuis Railway. Renseigner les metadata reste utile pour l'inspection
> humaine côté Stripe.

---

## 3. Variables d'environnement Railway

Renseigner les **8 variables** ci-dessous dans **Railway → Project → Variables**.

### Clés Stripe

| Variable | Source |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe Dashboard → Developers → API keys → Secret key (`sk_test_...` ou `sk_live_...`) |
| `STRIPE_WEBHOOK_SECRET` | Récupéré à la création du webhook (étape 4). Format `whsec_...` |

### 6 Price IDs

| Variable | Récupéré depuis le produit/prix |
|---|---|
| `STRIPE_PRICE_DEMARRAGE_MONTHLY` | Essentiel → prix mensuel 19 € |
| `STRIPE_PRICE_DEMARRAGE_ANNUAL` | Essentiel → prix annuel 192 € |
| `STRIPE_PRICE_ACTIVITE_MONTHLY` | Régulier → prix mensuel 29 € |
| `STRIPE_PRICE_ACTIVITE_ANNUAL` | Régulier → prix annuel 300 € |
| `STRIPE_PRICE_CROISIERE_MONTHLY` | Intensif → prix mensuel 39 € |
| `STRIPE_PRICE_CROISIERE_ANNUAL` | Intensif → prix annuel 396 € |

### Variable optionnelle

`STRIPE_PUBLISHABLE_KEY` — **non utilisée** par le code actuel (Checkout en
subscription tourne 100 % server-side). À renseigner si vous prévoyez
Stripe Elements / embedded checkout dans une passe ultérieure.

> **Important** : aucune clé entre guillemets dans Railway. Format brut.
> Redémarrage Railway automatique après mise à jour des vars.

---

## 4. Webhook endpoint

Dans **Developers → Webhooks → Add endpoint**.

- **Endpoint URL** : `https://movup.io/api/stripe/webhook`
- **Description** : `MovUP — bascule trial→converted, gestion abonnement`
- **API version** : laisser le défaut (le code spécifie `apiVersion: '2024-06-20'`)
- **Events to send** : sélectionner exactement ces **4 events** :
  - `checkout.session.completed`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.payment_failed`

Après création :
1. **Reveal** le **Signing secret** (`whsec_...`)
2. Le copier dans Railway → `STRIPE_WEBHOOK_SECRET`
3. Redéployer Railway si nécessaire (auto sur push)

> Le code vérifie la signature via `stripe.webhooks.constructEvent(req.body,
> sig, secret)` (raw body parser appliqué AVANT `express.json` global,
> cf. `server.js`). Une signature invalide retourne 400 sans traitement.

> Idempotence : chaque event est inséré dans la table SurrealDB
> `stripe_events_processed` avec UNIQUE INDEX sur `event_id`. Une 2e
> livraison du même event est skippée silencieusement.

---

## 5. Customer Portal

Dans **Settings → Billing → Customer Portal → Configure**.

### Branding

- **Business name** : `MovUP`
- **Logo** : uploader `public/favicon.svg` (ou un logo dédié si disponible)
- **Privacy policy URL** : `https://movup.io/confidentialite`
- **Terms of service URL** : `https://movup.io/cgu`

### Functionality (à activer)

- [x] **Invoice history** — laisser actif (les utilisateurs téléchargent
      leurs factures)
- [x] **Update payment method** — actif
- [x] **Update billing information** — actif (nom + adresse + numéro fiscal)
- [x] **Cancel subscription** — actif, mode `End of period`
      (l'utilisateur garde l'accès jusqu'à `current_period_end`)
- [ ] **Pause subscription** — **désactivé** (pas pertinent pour MovUP)
- [x] **Switch plans** — actif. Sélectionner les **3 produits MovUP**
      (Essentiel / Régulier / Intensif). Permettre changement entre les
      6 prix (3 plans × 2 cycles).

### Cancellation

- **Cancellation reason** : actif (collecter feedback)
- **Cancellation message** : laisser le défaut Stripe ou personnaliser :
  `Vos données restent accessibles en lecture jusqu'à la fin de la période en cours, et téléchargeables à vie via votre espace MovUP.`

### Save changes

Le Customer Portal est partagé entre Test et Live — la configuration
s'applique aux deux. Pas de bascule à faire au passage en Live.

---

## 6. Procédure de bascule Test → Live

### Avant la bascule

- [ ] Tests e2e validés en mode Test (cf. section 7)
- [ ] Compte Stripe activé en Live (vérification KYB So Paradi : SIRET,
      IBAN, pièce d'identité, justificatif de domicile — délai 24-72h)
- [ ] CGV mises à jour avec la mention `Paiement sécurisé via Stripe
      Payments Europe Ltd, Irlande`

### Bascule

1. **Stripe Dashboard** : basculer le toggle Test/Live en haut à droite vers **Live**
2. **Recréer les 6 produits/prix** (les Test n'existent pas en Live, IDs
   différents). Suivre la section 2 à l'identique.
3. **Recréer le webhook** en Live avec la même URL et les 4 mêmes events.
   Récupérer le nouveau `whsec_...` Live.
4. **Mettre à jour Railway** avec :
   - `STRIPE_SECRET_KEY` → `sk_live_...`
   - `STRIPE_WEBHOOK_SECRET` → nouveau `whsec_...` Live
   - Les 6 `STRIPE_PRICE_*` → nouveaux IDs Live
5. Redémarrage Railway automatique sur changement de var.
6. **Test final Live** : un signup réel avec une vraie carte (paiement
   minimal de 19 € Essentiel), puis résiliation immédiate via Customer
   Portal pour vérifier que :
   - `subscription.deleted` est bien reçu côté webhook
   - `trial_status` revient à `expired` en SurrealDB
   - Email `subscription_canceled` envoyé via Resend

### Rollback

Si problème en Live :
- Repasser Railway sur les clés Test (les vars sont éditables instantanément)
- Le code n'a pas de logique différenciée Test/Live, il consomme ce que
  l'env donne. Pas de redeploy nécessaire au rollback des vars.

---

## 7. Procédure de test e2e (Test mode)

Voir aussi `scripts/test-stripe-flow.js` pour l'orchestration et la
vérification automatique en base.

### Données de test

- **SIRET valide** : `542065479` (LVMH) — pré-remplit raison sociale + adresse
- **Carte Test Stripe** : `4242 4242 4242 4242`
- **Date** : n'importe quelle date future
- **CVC** : `123`
- **Code postal** : `75001`

### Flow

1. Sur `/signup` créer un compte test (email jetable, ex.
   `movup-test-{timestamp}@example.com`).
2. Aller sur `/account/upgrade?plan=activite`.
3. Saisir SIRET `542065479` → vérifier auto-remplissage raison sociale + adresse.
4. Cliquer **Continuer vers le paiement** → redirection Stripe Checkout.
5. Renseigner carte Test, valider.
6. Redirection sur `/account/billing?success=true` → bandeau succès vert,
   plan Régulier affiché, statut Actif.
7. Vérifier en SurrealDB :
   ```sql
   SELECT email, plan, plan_billing_cycle, subscription_status,
          trial_status, current_period_end, stripe_customer_id, stripe_subscription_id
   FROM user WHERE email = 'movup-test-...@example.com';
   ```
   Attendu : `plan='activite'`, `plan_billing_cycle='monthly'`,
   `subscription_status='active'`, `trial_status='converted'`,
   `current_period_end` à +1 mois, `stripe_customer_id` et
   `stripe_subscription_id` renseignés.
8. Vérifier que l'email `subscription_activated` est arrivé via Resend.
9. Tester le Customer Portal : depuis `/account/billing` cliquer
   **Gérer mon abonnement** → portal Stripe ouvert → tester changement
   de plan vers Intensif → vérifier en base que `plan='croisiere'`.
10. Tester résiliation depuis le portail → vérifier en base que
    `subscription_status='canceled'` et `trial_status='expired'` (popup
    bloquant réapparaît au prochain login).

### Tests carte d'échec (optionnel)

- Carte refusée : `4000 0000 0000 0002` → vérifier que le checkout reste
  sur Stripe sans rediriger vers `success_url`.
- Paiement échoué après abonnement : utiliser
  `4000 0000 0000 0341` lors de la mise à jour CB via portal → vérifier
  webhook `invoice.payment_failed` reçu, `subscription_status='past_due'`,
  email `payment_failed` envoyé.

---

## 8. Vocabulaire et conformité

- **Plan names** : les libellés affichés sont `Essentiel`, `Régulier`,
  `Intensif` (jamais `Starter`, `Pro`, `Business`, ni les anciens
  `Démarrage`, `Activité`, `Croisière`). Les slugs techniques restent
  `demarrage`, `activite`, `croisiere` et ne sont jamais affichés.
- **Mention TVA** : `TVA non applicable, art. 293 B du CGI` — affichée
  sous le bouton Checkout via `custom_text.submit.message`, et dans les
  emails `subscription_activated`.
- **Pas d'engagement** : tous les plans sont sans engagement,
  résiliation depuis Customer Portal effective en fin de période.
- **Sender email** : `bonjour@movup.io` (config Resend, env
  `RESEND_FROM_EMAIL`).

---

## 9. Architecture du flow Stripe (référence)

```
1. /account/upgrade
   ↓ user remplit SIRET + adresse + plan
   ↓ POST /api/stripe/create-checkout-session
2. Server :
   - persist siret/raison_sociale/billing_address en SurrealDB user
   - crée Customer Stripe si stripe_customer_id absent
   - crée session Checkout (mode subscription, locale fr, custom_text 293B)
   - retourne { url }
3. Front : window.location = url
4. User paye sur Stripe Checkout (carte + 3DS si requis)
5. Stripe → success_url = /account/billing?success=true
6. Stripe → POST webhook /api/stripe/webhook (event checkout.session.completed)
   - signature vérifiée (raw body)
   - idempotence vérifiée (stripe_events_processed)
   - UPDATE user : trial_status='converted', plan, cycle, subscription_status='active',
     current_period_end, stripe_subscription_id
   - email subscription_activated via Resend
7. /account/billing
   - GET /api/user/me retourne le nouveau statut
   - bouton Gérer mon abonnement → POST /api/stripe/create-portal-session
   - redirect Customer Portal
```

Fin.
