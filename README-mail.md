# MUP — Mail double track (OAuth/IMAP + Resend)

Ce document décrit l'architecture mail de MUP et les étapes de provisionnement
externes nécessaires avant que les sessions 2-9 puissent être exécutées.

## Architecture en 2 tracks

### Track 1 — Boîte personnelle (1:1)
- **Usage** : répondre aux prospects, envoyer un devis, conversation directe.
- **Méthodes** : OAuth Google (Gmail), OAuth Microsoft (Outlook/365), IMAP fallback (tous autres).
- **Volume** : faible (quelques dizaines/jour).
- **Expéditeur visible** : adresse réelle de l'utilisateur.
- **Service backend** : `lib/mail-service.js` → `sendOne(db, userId, opts)`.

### Track 2 — Cold mailing campagnes
- **Usage** : prospection masse, séquences automatisées.
- **Méthode** : API Resend avec domaine vérifié de l'utilisateur (DKIM, SPF, DMARC).
- **Volume** : élevé (centaines à milliers/jour selon plan Resend).
- **Service backend** : à venir session 7 — `lib/mail-service.js` → `sendCampaign(db, userId, campaignId, opts)`.

Cette séparation reflète les standards Lemlist / Apollo / Smartlead.

## État de la session 1 (déjà livré)

- 3 nouvelles tables SurrealDB : `domains_resend`, `campaigns`, `campaign_events` (boot block, SCHEMALESS).
- `lib/mail-service.js` : `sendOne` avec branche `imap` fonctionnelle, `google`/`microsoft` lèvent une erreur explicite.
- Routes `/api/v2/mail/*` :
  - `GET /api/v2/mail/status` — état de la boîte du user (provider, email, connected).
  - `POST /api/v2/mail/imap/test` — validation IMAP+SMTP avant sauvegarde.
  - `POST /api/v2/mail/imap/connect` — sauvegarde chiffrée (AES-256-GCM, IV par enregistrement).
  - `POST /api/v2/mail/disconnect` — révoque la boîte connectée.
  - `POST /api/v2/mail/send` — envoi 1:1 unifié (route sur le bon provider, IMAP en session 1).
- Stubs `/auth/google`, `/auth/google/callback`, `/auth/microsoft`, `/auth/microsoft/callback` retournent 501.
- `public/js/provider-presets.json` : 14 fournisseurs (FR + internationaux), domaines courants mappés.
- `public/mail.html` : refonte complète avec 3 sous-onglets (Boîte de réception, Campagnes, Paramètres) + modale IMAP autodetect.

Routes héritées `/api/mail/*` (anciennes) **conservées** pour rollback. À déprécier plus tard.

## Variables d'environnement à provisionner

Ajouter dans `.env` (dev) et dans Railway (prod) :

```
# Track 1 — OAuth Google (session 2)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI_PROD=https://movup.io/auth/google/callback
GOOGLE_REDIRECT_URI_DEV=http://localhost:3000/auth/google/callback

# Track 1 — OAuth Microsoft (session 3)
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
MICROSOFT_REDIRECT_URI_PROD=https://movup.io/auth/microsoft/callback
MICROSOFT_REDIRECT_URI_DEV=http://localhost:3000/auth/microsoft/callback

# Track 2 — Resend (sessions 6-8)
RESEND_API_KEY=
RESEND_WEBHOOK_SECRET=

# Note : SECRET_KEY (32 bytes hex) déjà active — réutilisée pour le chiffrement IMAP
# (AES-256-GCM, IV 12 bytes, tag 16 bytes, IV par enregistrement).
```

## Setup Google Cloud Console (avant session 2)

1. Aller sur <https://console.cloud.google.com>.
2. Créer un nouveau projet (`MUP Mail` ou similaire).
3. **APIs et services** → **Bibliothèque** → activer :
   - Gmail API
4. **APIs et services** → **Écran de consentement OAuth** :
   - Type : **External**
   - Nom de l'application : `MUP`
   - Email de support utilisateur : adresse admin
   - Domaines autorisés : `movup.io`
   - Email du développeur : adresse admin
   - **Scopes** : ajouter
     - `https://www.googleapis.com/auth/gmail.send`
     - `https://www.googleapis.com/auth/gmail.readonly`
     - `https://www.googleapis.com/auth/userinfo.email`
     - `openid`
   - Utilisateurs de test : ajouter votre adresse Gmail le temps de la validation Google (l'app sera en mode `Testing` jusqu'à validation — limite 100 users, suffit pour les tests).
5. **APIs et services** → **Identifiants** → **Créer des identifiants** → **ID client OAuth 2.0** :
   - Type : **Application web**
   - Nom : `MUP Web Client`
   - Origines JavaScript autorisées : `https://movup.io`, `http://localhost:3000`
   - URI de redirection autorisés :
     - `https://movup.io/auth/google/callback`
     - `http://localhost:3000/auth/google/callback`
6. Récupérer **Client ID** et **Client Secret**, les coller dans `.env` local + Railway.
7. Pour passer en `Production` (au-delà de 100 users) : soumettre l'application à la validation Google (1-2 semaines, requiert vidéo de démo, politique de confidentialité publique, conditions d'utilisation).

## Setup Microsoft Azure AD (avant session 3)

1. Aller sur <https://portal.azure.com>.
2. **Microsoft Entra ID** (anciennement Azure AD) → **Inscriptions d'applications** → **Nouvelle inscription**.
3. Nom : `MUP Mail`. Types de comptes pris en charge : **Comptes dans n'importe quel annuaire organisationnel et comptes Microsoft personnels** (multi-tenant + perso).
4. URI de redirection : type **Web**, URL : `https://movup.io/auth/microsoft/callback`. Ajouter aussi `http://localhost:3000/auth/microsoft/callback` après création.
5. Récupérer le **ID d'application (client)** = `MICROSOFT_CLIENT_ID`.
6. **Certificats et secrets** → **Nouveau secret client** → durée 24 mois. Copier la valeur immédiatement = `MICROSOFT_CLIENT_SECRET`.
7. **Autorisations API** → **Ajouter une autorisation** → **Microsoft Graph** → **Autorisations déléguées** :
   - `Mail.Send`
   - `Mail.Read`
   - `User.Read`
   - `offline_access` (pour refresh tokens)
8. **Accorder le consentement administrateur** pour le tenant.
9. Coller les valeurs dans `.env` + Railway.

## Setup Resend (avant session 6)

1. Aller sur <https://resend.com> et créer un compte avec l'adresse pro.
2. **API Keys** → **Create API Key** → permission `Full access`. Copier = `RESEND_API_KEY`. **Note** : la clé n'est affichée qu'une seule fois.
3. **Domains** → **Add Domain** → entrer `movup.io` (déjà vérifié sur Gandi côté DKIM/SPF/DMARC).
   - Resend affiche les enregistrements DNS à vérifier — comparer avec ceux déjà actifs sur Gandi.
   - Si tout est déjà en place, Resend bascule le domaine en `verified` automatiquement (peut prendre quelques minutes).
4. **Webhooks** → **Add Webhook** :
   - Endpoint : `https://movup.io/webhooks/resend`
   - Événements : `email.delivered`, `email.opened`, `email.clicked`, `email.bounced`, `email.complained`, `email.unsubscribed`.
   - Récupérer le `Signing Secret` = `RESEND_WEBHOOK_SECRET`.

### Plans Resend — recommandation

| Plan        | Volume                | Prix       | Domaines | Recommandé pour                    |
|-------------|-----------------------|------------|----------|------------------------------------|
| Free        | 100/jour, 3 000/mois  | 0 €        | 1        | Validation tests, tout début       |
| Pro         | 50 000/mois           | ~20 $/mois | 10       | **Lancement commercial**           |
| Scale       | 100 000/mois          | ~90 $/mois | Illimité | Mid-stage, plusieurs clients actifs|
| Enterprise  | Volume sur mesure     | Sur devis  | Illimité | Stade scale-up                     |

Source : <https://resend.com/pricing>. Chiffres à valider à la souscription.

**Action commerciale** : passer en Pro avant le lancement public — Free ne suffit pas pour un lancement.

### Tunnel dev pour les webhooks Resend

Resend exige une URL HTTPS publique pour les webhooks. En dev local :

**Option recommandée — ngrok** (à lancer manuellement, ne pas automatiser dans le code) :

```bash
brew install --cask ngrok          # macOS
ngrok config add-authtoken <token> # compte gratuit ngrok.com
ngrok http 3013                    # ou le port utilisé en dev
```

ngrok renvoie une URL `https://xxxx.ngrok-free.app`. La coller temporairement
dans le webhook Resend (paramètres compte Resend, pas dans `.env`) le temps de
la session de test. Une fois la session terminée, restaurer `https://movup.io/webhooks/resend`.

**Alternatives** :
- `cloudflared tunnel` (plus stable, free, requiert compte Cloudflare).
- `webhook.site` en pass-through (utile pour inspecter les payloads sans relai).

En session 8, les webhooks seront simulés via tests automatisés sans dépendre du tunnel — le tunnel servira uniquement à valider de bout en bout sur une vraie campagne.

## Chiffrement

- Algorithme : **AES-256-GCM**
- IV : 12 bytes aléatoires par enregistrement
- Tag : 16 bytes
- Format stocké : `base64(IV || TAG || CIPHERTEXT)`
- Clé : `process.env.SECRET_KEY` (32 bytes hex, doit faire 64 caractères en hex).

Implémentation : `lib/crypto.js` (déjà actif en prod). Réutilisé pour :
- `mail_settings.smtp_pass_encrypted` (legacy SMTP de session 0)
- `mail_settings.imap_password_encrypted` (Track 1 IMAP, session 1)
- `mail_settings.oauth_access_token_encrypted` (Track 1 OAuth, sessions 2/3)
- `mail_settings.oauth_refresh_token_encrypted` (sessions 2/3)

Les enregistrements existants avec `smtp_pass_encrypted` mais sans `provider`
sont automatiquement traités comme `provider:'imap'` à la lecture (rétrocompatibilité).

## Schéma SurrealDB

Tables existantes (étendues progressivement) :
- `mail_settings:userId` (1 record par user, SCHEMALESS) — étendue avec champs OAuth, IMAP, provider, needs_reconnect.
- `mail` — emails reçus/envoyés (table existante, structure conservée).

Nouvelles tables session 1 :
- `domains_resend` — { userId, domain_name, resend_domain_id, status, dns_records[], verified_at }
- `campaigns` — { userId, name, template_id, recipients_list, status, scheduled_at, sent_at, stats }
- `campaign_events` — { campaign_id, recipient_email, event_type, timestamp, metadata }

`event_type` ∈ `delivered | opened | clicked | bounced | complained | unsubscribed`.

## Routes — état actuel et planning

| Route                                       | Session  | Statut    |
|---------------------------------------------|----------|-----------|
| `GET  /api/v2/mail/status`                  | 1        | Live      |
| `POST /api/v2/mail/imap/test`               | 1        | Live      |
| `POST /api/v2/mail/imap/connect`            | 1        | Live      |
| `POST /api/v2/mail/disconnect`              | 1        | Live      |
| `POST /api/v2/mail/send`                    | 1        | Live (IMAP only) |
| `GET  /auth/google`                         | 2        | Stub 501  |
| `GET  /auth/google/callback`                | 2        | Stub 501  |
| `GET  /auth/microsoft`                      | 3        | Stub 501  |
| `GET  /auth/microsoft/callback`             | 3        | Stub 501  |
| `GET  /api/v2/mail/inbox`                   | 4        | À écrire  |
| `POST /api/v2/campaigns/domain/verify`      | 6+7+8    | **Live**  |
| `GET  /api/v2/campaigns/domain/status`      | 6+7+8    | **Live**  |
| `GET  /api/v2/campaigns/domain/list`        | 6+7+8    | **Live**  |
| `POST /api/v2/campaigns/create`             | 6+7+8    | **Live**  |
| `POST /api/v2/campaigns/:id/send`           | 6+7+8    | **Live**  |
| `GET  /api/v2/campaigns`                    | 6+7+8    | **Live**  |
| `GET  /api/v2/campaigns/:id`                | 6+7+8    | **Live**  |
| `GET  /api/v2/campaigns/:id/stats`          | 6+7+8    | **Live**  |
| `DELETE /api/v2/campaigns/:id`              | 6+7+8    | **Live**  |
| `POST /api/v2/webhooks/resend`              | 6+7+8    | **Live**  |

## Migration soft des utilisateurs existants

Un utilisateur ayant utilisé l'ancienne page `mail.html` (SMTP générique) a un
record `mail_settings:userId` avec `smtp_pass_encrypted` mais sans `provider`.
À la première lecture, `mail-service.js` renvoie `provider:'imap'` par défaut
et le marque `needs_reconnect: false` (la config existante reste valide).

Si on souhaite forcer la reconnexion (par ex. pour basculer vers OAuth) :
exécuter un PATCH unique qui marque `needs_reconnect: true` sur tous les
records — l'UI affiche alors un bandeau « Veuillez reconnecter votre boîte ».

## Provider presets — couverture FR

`public/js/provider-presets.json` mappe ces domaines :

- **OAuth recommandé** : gmail.com, googlemail.com, outlook.com, hotmail.com, hotmail.fr, live.com, live.fr, msn.com
- **IMAP App Password requis** : icloud.com, me.com, mac.com, yahoo.fr, yahoo.com, ymail.com, rocketmail.com, aol.com
- **IMAP standard FR** : orange.fr, wanadoo.fr, sfr.fr, neuf.fr, cegetel.net, free.fr, laposte.net, gandi.net, ovh.com, ovh.net, ovhcloud.com, infomaniak.com, ik.me, etik.com, ktipmail.com, bbox.fr, bouyguestelecom.fr, mailo.com, net-c.com, netcourrier.com
- **IMAP Bridge** : protonmail.com, proton.me, pm.me (le pont local doit tourner sur le poste utilisateur)
- **Custom** : `_default` → saisie manuelle

Si un fournisseur manque, l'ajouter au JSON et redéployer (pas de redémarrage requis).

## Configuration webhook Resend Dashboard (sessions 6+7+8 — déployées)

L'endpoint webhook est `POST /api/v2/webhooks/resend`. Il valide la signature
HMAC SHA-256 (format Svix) à chaque requête et refuse 401 si invalide.

### Étapes Dashboard Resend

1. Aller sur <https://resend.com/webhooks> → **Add Webhook**.
2. **Endpoint URL** : `https://movup.io/api/v2/webhooks/resend` (prod).
3. **Events to send** : cocher
   - `email.delivered`
   - `email.opened`
   - `email.clicked`
   - `email.bounced`
   - `email.complained`
   - (`email.unsubscribed` si activé sur votre compte)
4. **Signing Secret** : Resend génère une clé `whsec_...`. Copier la valeur.
5. La coller dans Railway en tant que `RESEND_WEBHOOK_SECRET` (préfixe `whsec_` inclus, le code le strippe automatiquement).
6. Cliquer **Test Webhook** dans Resend → vérifier dans les logs Railway que le webhook a été reçu (200 OK).

### Format du signing secret

Resend délivre le secret en format Svix :
- Préfixe : `whsec_`
- Corps : 32+ bytes encodés base64 standard

Le code (`lib/mail-service.js:verifyResendSignature`) :
- Strippe le préfixe `whsec_`
- Décode le base64
- Calcule HMAC SHA-256 sur `${svix-id}.${svix-timestamp}.${rawBody}`
- Compare en `timingSafeEqual` à toute signature `v1,...` du header `svix-signature`

### Anti-replay

Le webhook refuse les requêtes dont `svix-timestamp` s'écarte de plus de 5 minutes
de l'heure serveur courante. Cela bloque les rejeux après capture d'un payload.

### Webhook en dev local (ngrok)

Pour tester les webhooks Resend en local, exposer le serveur dev via tunnel HTTPS :

```bash
brew install --cask ngrok
ngrok config add-authtoken <token>   # compte gratuit ngrok.com
ngrok http 3013                       # ou le port utilisé en dev
```

ngrok renvoie une URL `https://xxxx.ngrok-free.app`. La coller temporairement
dans le webhook Resend (Dashboard → ouvrir le webhook → Edit) le temps de la
session de test. Restaurer `https://movup.io/api/v2/webhooks/resend` après.

**Alternative sans tunnel** : lancer un test direct sur la route `/api/v2/webhooks/resend`
avec un payload signé manuellement (uniquement pour tests automatisés du HMAC) — voir
fichier `scripts/sign_resend_event.mjs` (à créer si besoin).

## Tests session 1

Smoke tests local (à compléter en sessions ultérieures avec OAuth/Resend) :

1. `GET /api/v2/mail/status` user neuf → `{ connected:false, provider:null, email:null }`
2. `POST /api/v2/mail/imap/test` avec credentials valides → `{ imap_ok:true, smtp_ok:true }`
3. `POST /api/v2/mail/imap/test` avec password faux → `{ imap_ok:false, smtp_ok:false, errors:{...} }`
4. `POST /api/v2/mail/imap/connect` → 201 + record en base avec `imap_password_encrypted`
5. `GET /api/v2/mail/status` après connect → `{ connected:true, provider:'imap', email:... }`
6. `POST /api/v2/mail/disconnect` → 200, record supprimé
7. Isolation user A / user B sur tous les endpoints
8. Front : 3 sous-onglets navigables, modale IMAP s'ouvre, autodetect via blur sur l'email
9. Stubs OAuth → 501 avec message explicite

Tests réels avec credentials externes : sessions 2 et suivantes.

## Tests sessions 6+7+8 (Track 2 Resend — Live)

Smoke test local **sans** `RESEND_API_KEY` (vérifie que les routes répondent 503
proprement) :

1. `POST /api/v2/campaigns/domain/verify` sans clé → 503 `RESEND_API_KEY non configurée`
2. `POST /api/v2/campaigns/create` (avec data minimale) → 201 (la création ne dépend pas de Resend)
3. `POST /api/v2/campaigns/:id/send` sans clé → 503
4. `GET /api/v2/campaigns` user neuf → `[]`
5. `POST /api/v2/webhooks/resend` sans signature → 401
6. `POST /api/v2/webhooks/resend` avec signature factice → 401
7. Front : onglet Campagnes affiche écran "Vérifier mon domaine"
8. Champ domaine accepte un nom valide, refuse les invalides

Smoke test prod **avec** `RESEND_API_KEY` :

1. `POST /api/v2/campaigns/domain/verify { domain_name:"movup.io" }` → 200, `existing:true`, `status:"verified"`
2. `GET /api/v2/campaigns/domain/list` → 1 entrée locale
3. Création campagne avec 3 destinataires de test (votre adresse perso, X 3 alias) → 201
4. `POST /campaigns/:id/send` → 200, `sent_count:3`
5. Réception des 3 mails → ouverture → webhook `email.opened` → stats remontent
6. Clic sur un lien → webhook `email.clicked` → stats incrémentées
7. `GET /campaigns/:id/stats` retourne agrégats à jour

Ces tests prod nécessitent :
- Variables Railway en place (`RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`)
- Webhook configuré sur Resend Dashboard pointant vers `https://movup.io/api/v2/webhooks/resend`
- 3 adresses email de test distinctes avec accès au contenu reçu
