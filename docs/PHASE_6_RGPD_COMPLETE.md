# Phase 6 — Conformité RGPD : clôture

**Version** : v1.0.0-rgpd
**Date de clôture** : 25 mai 2026
**HEAD** : 97f31c6
**Statut** : livré en production (origin/main). Validations runtime human-in-the-loop en cours (voir section Validations).

## Résumé

Phase 6 met MovUP en conformité RGPD bout en bout sur la prospection
commerciale fondée sur l'intérêt légitime (art. 6.1.f) à partir de
données publiques INSEE/SIRENE. Elle couvre : l'opt-out des tiers
prospects (art. 21), l'information obligatoire en cold mail (art. 14),
et les droits de l'abonné (accès/portabilité art. 20, rectification
art. 16, effacement art. 17).

## Articles RGPD couverts

| Article | Objet | Implémentation |
|---------|-------|----------------|
| 5.1.c | Minimisation | Hash SHA-256 des identifiants ; IP hashée ; champ « motif » retiré du formulaire opt-out |
| 5.2 | Accountability | Commentaire doctrinal d'exclusion de purge (purge-expired.js) |
| 6.1.f | Intérêt légitime | Base légale mentionnée dans le footer cold mail |
| 12.3 | Délai de traitement | 1 mois extensible à 3 mois — accusé opt-out + suppression compte |
| 14 | Information prospection | Footer automatique par destinataire sur toutes les campagnes |
| 16 | Rectification | Bloc /account/privacy (contact DPO) |
| 17 | Effacement | Suppression de compte avec délai d'annulation 7 jours + cron |
| 20 | Portabilité | Export JSON (préexistant, conservé) |
| 21 | Opposition | Tunnel /optout (formulaire -> magic link 24h -> blocklist) |

## Journal des étapes

| Étape | Commit | Objet |
|-------|--------|-------|
| 4 | 3e1e07b | Tables optout (request + blocklist + 9 index) |
| 5 | 21849e0 | Filtrage opt-out scraping INSEE (double rempart) |
| 6 | 9bfda0e | Doc exclusion purge RGPD (purge-expired.js) |
| 7 | 501f197 | 3 pages publiques opt-out (front pur) |
| 8 | f799707 | Routes API opt-out + verify + 1er template |
| 8c.1 | 90711c7 | Whitelist publique /api/optout (gates auth + subscription) |
| 9 | deeb932 | Templates Resend accusé + notification interne |
| 10 | (construction) | Pages opt-out publiques par défaut (gate HTML opt-in) |
| 11-12 | (intégré 13) | Ligne footer RGPD leads.html |
| 13 | a6c31c3 / 31f95c8 | Suppression compte art. 17 (backend cron + cascade) + privacy.html 4 blocs |
| 14 | 62e2c0e / 97f31c6 | Footer cold mail art. 14 + pré-check SIRET + route profil + popup |
| 16 | (audit) | Safety check global : 12/12 OK code, 0 bloquant |
| 17 | (ce commit) | Clôture : doc + tag v1.0.0-rgpd |

## Architecture livrée

- **Tables** (SurrealDB) : `optout_request` (file des demandes, conservation 5 ans, `short_ref` MUP-OPT-XXXXXX), `optout_blocklist` (hash persistants). +2 champs user : `deletion_requested_at`, `deletion_scheduled_at`.
- **Service opt-out** (`server/services/optout.js`) : `hashIdentifier`, `checkBlocklistBatch`/`One`, `generateVerifyToken`, `findPendingRequest`, `insertOptoutRequest`, `verifyOptoutToken`.
- **Cascade suppression** (`server/services/purge-expired.js`) : `deleteUserCascade` factorisée (réutilisée par la purge trial ET l'effacement art. 17) — préserve facture/counter/frais/frais_recurrents/stripe_events (Code commerce L123-22), anonymise audit_log.
- **Footer art. 14** (`lib/mail-service.js`) : `buildColdMailFooter`, injecté par destinataire dans `sendCampaign`.
- **Routes API** : `POST /api/optout`, `GET /api/optout/verify/:token` (publiques) ; `POST /api/account/profile`, `POST`/`DELETE /api/account/delete`, `GET /api/account/deletion-status` (auth).
- **Cron** : `runStep('account_deletion')` dans le batch quotidien 08:00 Europe/Paris.
- **Templates Resend** (5) : optout-verify, optout-acknowledged, optout-internal-notification, account-deletion-scheduled, account-deletion-confirmed.
- **Pages** : /optout, /optout-confirmation, /optout-verified, /account/privacy (refonte 4 blocs).

## Doctrines tranchées

- **Filtrage opt-out** : double rempart (upstream silencieux /api/search + /api/sirene/search ; refus dur POST /api/pipeline 403). Anti-revelation : aucune fiche masquée signalée.
- **Fail-open blocklist** : une erreur DB ne bloque pas le scraping (visible dans les logs). Tradeoff acté.
- **Hash** : SHA-256 hex, normalisation .trim() avant hash.
- **Suppression compte** : hard delete + conservation comptable + anonymisation audit, délai d'annulation 7 jours. Refus 409 si abonnement actif.
- **Footer art. 14** : sur-inclusion (toutes les campagnes), injection serveur (anti-bypass DOM), lien opt-out personnalisé par destinataire.
- **Idempotence opt-out** : UX-level (réponse identique, anti-énumération) ; flood borné par rate-limit 3/24h/IP.

## Validations

- **Audit code (Étape 16a)** : 12/12 points OK ; 0 anomalie bloquante ; 1 cosmétique (commentaire « Export RGPD art. 20 » mal positionné dans server.js).
- **Runtime public** : pages opt-out (200), verify token invalide (302), pré-remplissage /optout?from=&email= — OK.
- **REPORTÉ (human-in-the-loop, validation à venir)** : tunnel opt-out complet email (verify -> accusé), envoi cold mail réel avec footer reçu, popup SIRET, suppression compte sur compte de test, rendu authentifié privacy.html / footer leads.

## Dette connue

- Commentaire cosmétique mal positionné (server.js, routes /api/account/*) — sans impact fonctionnel.
- `body.source` côté pipeline reste contournable par requête forgée (durcissement futur, hors Phase 6).
- SIRET utilisateur rarement peuplé automatiquement (capté au 1er devis ou via popup setup).
