# Auth Phase 1 — Architecture

Système d'authentification email + mot de passe pour MUP, avec vérification email
bloquante et inscription par SIRET (pré-remplissage INSEE + géocodage BAN).

## Périmètre Phase 1

- Inscription email + mot de passe + SIRET obligatoire
- Vérification email bloquante (login refusé tant que `email_verified=false`)
- Connexion / déconnexion avec session cookie httpOnly 30 jours
- Réinitialisation de mot de passe par email (lien 1h)
- Audit log de tous les événements d'auth
- Rate limit 5 tentatives / 15 min sur signup, login, forgot-password

## Hors périmètre Phase 1

- Multi-utilisateur par compte (équipes)
- 2FA / TOTP / passkeys
- OAuth/SSO (Google, Microsoft)
- Invitations par email
- Récupération via téléphone

## Stack

- **Hash mot de passe** : argon2id (OWASP 2024 — memory 19456 KiB, time 2, parallel 1)
- **Sessions** : token aléatoire 32 octets (base64url), hashé SHA-256 en base, cookie
  `mup_session` httpOnly + sameSite=Lax (+ Secure en prod). TTL 30 jours.
- **Tokens vérification / reset** : token aléatoire 32 octets, hashé SHA-256 en base.
  TTL 24h pour `email_verify`, 1h pour `password_reset`. `used=true` après usage.
- **Stockage** : SurrealDB Cloud — namespace `soparadi`, database `movup`. Tables
  `user`, `session`, `verification_token`, `audit_log` (voir `migrations/001_auth_tables.surql`).
- **Email** : Resend — `bonjour@movup.io`. Templates HTML inline dans `server/templates/`.
- **INSEE Sirene v3.11** : OAuth2 client_credentials, token caché en mémoire jusqu'à expiration.
- **BAN** : `https://api-adresse.data.gouv.fr/search/`, sans clef.

## Fichiers

| Fichier | Rôle |
|---|---|
| `server/auth/routes.js` | Routes Express `/api/auth/*` |
| `server/auth/surreal-adapter.js` | CRUD user/session/verification_token + audit + migration |
| `server/middleware/requireAuth.js` | Middleware Express bloquant 401 |
| `server/services/insee.js` | `lookupSiret(siret)` |
| `server/services/ban.js` | `geocode({ adresse, code_postal, ville })` |
| `server/services/email.js` | `sendWelcomeVerify`, `sendPasswordReset`, `sendRelanceJ12` |
| `server/templates/*.html` | Templates email transactionnels |
| `migrations/001_auth_tables.surql` | Schéma SurrealDB (idempotent, joué au boot) |

## Routes `/api/auth/*`

Toutes publiques (pas de `requireAuth`). `/me` et `/logout` exigent un cookie session valide.

| Méthode | Chemin | Body / Query | Réponse |
|---|---|---|---|
| POST | `/api/auth/lookup-siret` | `{ siret }` | `{ raison_sociale, adresse, code_postal, ville, code_naf, lat, lng }` |
| POST | `/api/auth/signup` | `{ email, password, siret }` | `201 { ok, user }` |
| POST | `/api/auth/login` | `{ email, password }` | `200 { ok, user }` + cookie session |
| GET | `/api/auth/verify` | `?token=…` | redirect `/login?verified=1` ou `/verify?status=error` |
| POST | `/api/auth/forgot-password` | `{ email }` | `200 { ok, message }` (réponse identique si compte inexistant) |
| POST | `/api/auth/reset-password` | `{ token, new_password }` | `200 { ok }` |
| POST | `/api/auth/logout` | (cookie) | `200 { ok }` + cookie effacé |
| GET | `/api/auth/me` | (cookie) | `{ user }` ou `401` |

## Flux

### Inscription

1. Client `POST /api/auth/lookup-siret { siret }` (optionnel — preview UX)
2. Client `POST /api/auth/signup { email, password, siret }`
3. Serveur : check email/SIRET non utilisés → INSEE lookup → BAN geocode → argon2 hash
   → `CREATE user` → `CREATE verification_token (email_verify, 24h)` → Resend `sendWelcomeVerify`
4. Audit `signup`
5. User reçoit email, clique → `GET /api/auth/verify?token=…` → `email_verified=true`
   → redirect `/login?verified=1`
6. Audit `email_verified`

### Connexion

1. `POST /api/auth/login { email, password }`
2. Serveur : `getUserByEmail` → `argon2.verify` → check `email_verified=true`
3. Si OK : `deleteAllSessionsForUser` (rotation) → `createSession` → cookie `mup_session`
4. Audit `login_success` ou `login_failed`

### Réinitialisation mot de passe

1. `POST /api/auth/forgot-password { email }`
2. Serveur : `getUserByEmail` → si trouvé : `createVerificationToken (password_reset, 1h)` → Resend
3. Réponse identique que l'email existe ou non (anti-énumération)
4. Audit `password_reset_requested`
5. User clique → `/reset-password?token=…` (page publique HTML)
6. `POST /api/auth/reset-password { token, new_password }` → argon2 hash → `updatePassword`
   → `markTokenUsed` → `deleteAllSessionsForUser` (force re-login)
7. Audit `password_reset_completed`

### Déconnexion

1. `POST /api/auth/logout` (cookie)
2. Serveur : `deleteSessionByToken` → cookie effacé
3. Audit `logout`

## Protection des routes `/api/*`

Dans `server.js`, après le mount de `/api/auth` :

```js
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/') || req.path === '/health') return next()
  if (req.path.startsWith('/v2/webhooks/')) return next()  // webhook Resend (HMAC)
  return requireAuth(req, res, next)
})
```

`requireAuth` lit le cookie `mup_session`, valide la session via SurrealDB,
remplit `req.userId` + `req.session.userId` (compat avec `lib/auth.js getUserId`)
et passe `next()`. Sinon `401`.

## Audit log

Événements enregistrés dans la table `audit_log` :
`signup`, `login_success`, `login_failed` (raison : `no_user`, `bad_password`, `not_verified`),
`email_verified`, `password_reset_requested`, `password_reset_completed`, `logout`.

Champs : `user_id` (option), `event`, `ip`, `user_agent`, `metadata`, `created_at`.

## Variables d'environnement

| Variable | Usage |
|---|---|
| `SURREAL_URL` / `SURREAL_NAMESPACE` / `SURREAL_DATABASE` / `SURREAL_USER` / `SURREAL_PASS` | Connexion DB |
| `RESEND_API_KEY` | Envoi emails transactionnels |
| `RESEND_FROM_EMAIL` | Adresse expéditeur (par défaut `bonjour@movup.io`) |
| `INSEE_CLIENT_ID` / `INSEE_CLIENT_SECRET` | OAuth2 INSEE Sirene |
| `INSEE_API_KEY` | Optionnel — `X-Gravitee-Api-Key` |
| `APP_URL` | Base URL pour les liens dans les emails (par défaut `https://movup.io`) |
| `SESSION_SECRET` | Réservé — non utilisé en Phase 1 (token DB-side only) |
| `NODE_ENV` | `production` active le flag `Secure` sur le cookie |

## Migration

Au démarrage du serveur, `runAuthMigration()` joue idempotemment toutes les
définitions de `migrations/001_auth_tables.surql` (via `DEFINE … IF NOT EXISTS`).

Pour rejouer manuellement le schéma sur SurrealDB Cloud :

```sh
cat migrations/001_auth_tables.surql | surreal sql \
  --endpoint $SURREAL_URL --namespace soparadi --database movup \
  --username $SURREAL_USER --password $SURREAL_PASS
```

## Sécurité

- Mots de passe jamais stockés en clair, hash argon2id paramètres OWASP 2024
- Cookies session `HttpOnly; Path=/; SameSite=Lax` (+ `Secure` en prod)
- Tokens (session, verify, reset) hashés SHA-256 en base — un dump de la base
  ne révèle aucun token exploitable
- Rotation de session à chaque login : invalidation des sessions précédentes
- Rate limiting 5/15min par IP sur signup, login, forgot-password
- Réponse identique à `forgot-password` que le compte existe ou non
- Vérification email bloquante : pas d'accès au pipeline tant que non vérifié
- Reset password invalide toutes les sessions actives

## Tests manuels

Voir checklist dans le PR. Points clés :
- Signup avec SIRET valide pré-remplit l'entreprise et géocode l'adresse
- Login refusé (403 `email_not_verified`) tant que l'email n'est pas validé
- Email de vérification arrive depuis `bonjour@movup.io`
- Reset password fonctionne end-to-end
- Logout détruit la session (cookie effacé, GET `/api/auth/me` → 401)
- 6e tentative de login en 15 min → 429
- `GET /api/contacts` sans cookie → 401
