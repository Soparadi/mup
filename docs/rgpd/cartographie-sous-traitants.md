# Cartographie des sous-traitants — Article 28 RGPD

**Responsable de traitement** : Benoît Fouquet — Entrepreneur Individuel So Paradi
**SIRET** : 453 388 456 00031
**Adresse** : 18 place du Marchix, 22100 Dinan, France
**Contact DPO** : dpo@movup.io
**Activité concernée** : MovUP — Pipeline management SaaS B2B (movup.io)

**Document** : Cartographie des sous-traitants
**Référence interne** : CST-MOVUP-001
**Version** : 1.0
**Date de rédaction** : 25 mai 2026
**Date d'effet** : 1er juin 2026 (lancement commercial MovUP)
**Prochaine revue** : 1er décembre 2026 (revue semestrielle systématique)
**Cadre méthodologique** : Article 28 RGPD + Lignes directrices EDPB 07/2020 sur les concepts de responsable de traitement et sous-traitant

---

## Préambule

Le présent document constitue la **cartographie des sous-traitants** au sens de l'article 28 du Règlement (UE) 2016/679 (RGPD), tenue sous la responsabilité du responsable de traitement conformément au principe d'**accountability** posé à l'article 5.2 RGPD.

Il documente, pour chaque sous-traitant intervenant dans l'écosystème MovUP, les éléments requis par l'article 28.3 RGPD :

- objet et durée du traitement sous-traité,
- nature et finalité du traitement,
- type de données à caractère personnel et catégories de personnes concernées,
- obligations et droits du responsable de traitement,
- garanties apportées par le sous-traitant.

Ce document est **opposable** : il peut être produit à toute autorité de contrôle compétente (CNIL, APD belge, PFPDT suisse, CAI Québec).

Il est articulé avec :

- la balance test intérêt légitime (LIA-MOVUP-001 v1.1) — fondement juridique des traitements basés sur l'article 6.1.f,
- le registre des activités de traitement (RAT-MOVUP-001 v1.0) — liste des 8 activités de traitement,
- l'analyse d'impact relative à la protection des données (AIPD-MOVUP-001) — analyse de risque,
- le journal technique `docs/PHASE_6_RGPD_COMPLETE.md` (tag git `v1.0.0-rgpd`) — état du système.

## Principe directeur — Souveraineté technique et hébergement européen

La cartographie suivante respecte strictement la **Doctrine 9 de la balance test (LIA-MOVUP-001 v1.1) — Souveraineté technique** :

- **Aucun prestataire tiers de scraping** (ScrapingBee, Scrapfly, Bright Data, Apify, etc.) n'est mobilisé.
- **Aucun agrégateur de données B2B** (Pappers, Société.com, Manageo, etc.) n'est mobilisé.
- **Aucun fournisseur de bases de contacts enrichies** (Dropcontact, Apollo, Lusha, ZoomInfo, Hunter.io, etc.) n'est mobilisé.
- **Hébergement européen exclusif** à la date d'effet du présent document (Railway europe-west4, SurrealDB Cloud AWS eu-west-1 Dublin, Resend eu-west-1 Dublin).
- **Stripe transferts hors UE** encadrés par les clauses contractuelles types adoptées par la Commission européenne (décision 2021/914).

---

## Vue d'ensemble — Liste des 9 sous-traitants MovUP

| N° | Sous-traitant | Fonction | Localisation | Transfert hors UE | DPA |
|---|---|---|---|---|---|
| S1 | Railway Corporation | Hébergement applicatif et logs | europe-west4 (Belgique) | Non | À contre-signer |
| S2 | SurrealDB Labs (Cloud) | Base de données managée | AWS eu-west-1 (Dublin) | Non | À contre-signer |
| S3 | Stripe Payments Europe Ltd | Paiements, abonnements, facturation | Dublin (Irlande) | Oui (Stripe Inc. US, CCT 2021/914) | Acquis |
| S4 | Resend Inc. (Ireland) | Envoi des emails transactionnels et de prospection | eu-west-1 (Dublin) | Non | À contre-signer |
| S5 | Google Ireland Ltd | OAuth Gmail + Workspace bonjour@movup.io | UE + monde (Google) | Oui (CCT + DPF) | Acquis |
| S6 | Cloudflare Ireland Ltd | CDN, HTTPS, protection DDoS | UE + monde (anycast) | Oui (CCT + DPF) | Acquis |
| S7 | Gandi SAS | Registrar DNS et hébergement email | Paris (France) | Non | Acquis (DPA standard) |
| S8 | ipapi (Kloudend Inc.) | Géolocalisation IP à l'inscription | États-Unis | Oui (CCT 2021/914) | À vérifier ou substituer |
| S9 | INSEE / DINUM Etalab | Sources publiques officielles (SIRENE, API recherche-entreprises, API BAN) | Paris (France) | Non | Sans objet (organisme public) |

**9 sous-traitants** au total. Les fiches détaillées suivent.

**Le point d'attention** porte sur S8 (ipapi) — fournisseur basé aux États-Unis, dont la pertinence opérationnelle (géolocalisation IP au signup) est à mettre en balance avec le risque de transfert. Voir fiche S8 et recommandation.

---

# Fiche S1 — Railway Corporation

## Identification

| Champ | Valeur |
|---|---|
| Dénomination | Railway Corporation |
| Forme juridique | Société américaine (Delaware C-Corporation) |
| Entité contractante | Railway Corporation |
| Adresse | 2261 Market Street, San Francisco, CA 94114, USA |
| Représentant UE | Non désigné à la date d'effet |
| URL | https://railway.app |
| Contact DPO | privacy@railway.app |
| URL DPA | https://railway.app/legal/dpa |

## Fonction et objet du traitement sous-traité

**Fonction** : hébergement applicatif et infrastructure de logs.

**Description** : exécution du code applicatif MovUP (serveur Express, cron jobs, batchs quotidiens), exposition HTTPS, agrégation des logs applicatifs, redéploiement automatique sur push GitHub.

**Activités de traitement concernées** (cf. registre RAT-MOVUP-001) : T1 (comptes), T2 (prospection cold mail), T3 (enrichissement moteur interne), T4 (opt-out), T5 (facturation), T6 (support), T7 (logs sécurité), T8 (archives comptables).

## Nature et catégories de données traitées

L'ensemble des données opérationnelles MovUP transitent par l'infrastructure Railway en exécution applicative. Aucune donnée n'est stockée durablement par Railway (Railway = compute, pas storage) sauf les logs applicatifs.

**Données accessibles à Railway en exécution** : toutes catégories MovUP en mémoire applicative.

**Données conservées par Railway en logs** : URL, méthode HTTP, code de réponse, timestamp, latence, IP hashée, user-agent, logs applicatifs (erreurs, alertes cron). 12 mois de rétention.

## Localisation et transferts

| Élément | Valeur |
|---|---|
| Région de traitement | europe-west4 (Belgique) |
| Datacenters | Google Cloud Platform europe-west4 |
| Transferts hors UE | Non en exécution applicative. Personnel Railway US peut accéder aux logs en cas d'incident technique. |
| Base de transfert | Clauses contractuelles types 2021/914 (à confirmer dans DPA contre-signé) |

## Garanties art. 28 RGPD

- DPA standard publié : https://railway.app/legal/dpa
- Engagements de confidentialité du personnel
- Sous-traitants ultérieurs : Google Cloud Platform (GCP), AWS — encadrés
- Mesures techniques : chiffrement au repos et en transit, contrôle d'accès, journaux d'accès
- Notification de violation : sans retard injustifié

## Statut DPA

**À contre-signer** : DPA standard Railway disponible publiquement, contre-signature formelle à effectuer avant lancement commercial. Acceptation des CGU Railway = acceptation tacite du DPA, mais une trace écrite de la contre-signature est recommandée au titre de l'accountability.

## Durée du traitement

Durée de l'abonnement Railway, renouvelée mensuellement, résiliable à tout moment.

## Mesures de réversibilité

- Code source intégralement maintenu dans le dépôt GitHub Soparadi/mup (responsable de traitement)
- Configuration Railway exportable
- Migration possible vers tout autre hébergeur en quelques heures (architecture Express portable)

---

# Fiche S2 — SurrealDB Labs (SurrealDB Cloud)

## Identification

| Champ | Valeur |
|---|---|
| Dénomination | SurrealDB Labs Ltd |
| Forme juridique | Société britannique (Ltd) |
| Entité contractante | SurrealDB Labs Ltd |
| Adresse | Londres, Royaume-Uni |
| Représentant UE | À identifier dans le DPA |
| URL | https://surrealdb.com/cloud |
| Contact DPO | privacy@surrealdb.com |
| URL DPA | https://surrealdb.com/legal/dpa |

## Fonction et objet du traitement sous-traité

**Fonction** : base de données managée multi-modèle.

**Description** : hébergement de la base de données SurrealDB (namespace `soparadi`, database `movup`), exécution des requêtes SurrealQL, sauvegardes automatiques, haute disponibilité.

**Activités de traitement concernées** : T1, T2, T3, T4, T5, T6, T7, T8.

## Nature et catégories de données traitées

L'ensemble des données persistées par MovUP est stocké chez SurrealDB Cloud. À la date d'effet du présent document (1er juin 2026), les tables actives en production incluent notamment :

- Comptes utilisateurs (avec champs Stripe associés)
- Fiches pipeline, contacts, devis, factures, frais, agenda, mail, visio
- Tables opt-out (request + blocklist)
- Audit log, lead_search history, mailbox_credentials (tokens OAuth chiffrés AES-256-GCM)
- Idempotence Stripe (stripe_events_processed)
- Journal d'export RGPD (privacy_export_log)

**Architecture cible V1.0 (déploiement programmé fin juin 2026)** : ajout du cache mutualisé `company_public` (données publiques d'entreprise partagées entre abonnés) et de la table `company_enrichment_user` (notes commerciales privées par abonné). À la date d'effet du présent document, ces deux tables ne sont **pas présentes** en base de production : aucune fiche d'entreprise n'est stockée par MovUP en architecture proxy pass-through actuelle.

## Localisation et transferts

| Élément | Valeur |
|---|---|
| Région de traitement | AWS eu-west-1 (Dublin, Irlande) |
| Infrastructure sous-jacente | Amazon Web Services Ireland Ltd |
| Endpoint | `wss://movup-prod-06fnm71lqlp2tfukdsfg07183o.aws-euw1.surreal.cloud/rpc` |
| Transferts hors UE | Non en stockage. Personnel SurrealDB UK peut accéder aux données dans le cadre du support. |
| Base de transfert | Décision d'adéquation Royaume-Uni (Commission européenne, juin 2021) |

**Note importante** : le Royaume-Uni bénéficie d'une **décision d'adéquation** de la Commission européenne (28 juin 2021), valable jusqu'au 27 juin 2027. Le transfert vers le personnel SurrealDB UK est donc juridiquement assimilable à un transfert intra-UE.

## Garanties art. 28 RGPD

- DPA standard publié
- Sous-traitant ultérieur : AWS Ireland Ltd (encadré, hébergement européen)
- Chiffrement au repos (AES-256) et en transit (TLS 1.3)
- Sauvegardes automatiques avec rétention configurable
- Authentification par token Bearer signé
- Isolation namespace + database par client SurrealDB Cloud
- Notification de violation : sans retard injustifié

## Statut DPA

**À contre-signer**. DPA disponible chez SurrealDB Labs, contre-signature formelle à effectuer avant lancement commercial.

## Durée du traitement

Durée de l'abonnement SurrealDB Cloud.

## Mesures de réversibilité

- Schéma SurrealQL maintenu en interne (`docs/db-schema.surql`)
- Exports JSON natifs SurrealDB (commande `surreal export`)
- Migration vers SurrealDB self-hosted possible (même moteur, même langage de requête)
- Sauvegardes téléchargeables

---

# Fiche S3 — Stripe Payments Europe Ltd

## Identification

| Champ | Valeur |
|---|---|
| Dénomination | Stripe Payments Europe Ltd |
| Forme juridique | Société irlandaise (Ltd) |
| Entité contractante | Stripe Payments Europe Ltd |
| Adresse | 1 Grand Canal Street Lower, Grand Canal Dock, Dublin, Irlande |
| Représentant UE | Stripe Payments Europe Ltd (entité UE elle-même) |
| URL | https://stripe.com |
| Contact DPO | dpo@stripe.com |
| URL DPA | https://stripe.com/legal/dpa |
| Numéro de compte MovUP | `acct_1TUUWgGnSpFY8vAv` |

## Fonction et objet du traitement sous-traité

**Fonction** : traitement des paiements, gestion des abonnements récurrents, facturation, Customer Portal.

**Description** : encaissement des paiements par carte bancaire pour les 3 plans MovUP (Démarrage 24€, Activité 34€, Croisière 44€), gestion du cycle de vie de l'abonnement (création, mise à jour, résiliation, échec de paiement), émission des factures (préfixe MOVUP, séquence à partir de 19), gestion des moyens de paiement par les abonnés via Customer Portal.

**Activités de traitement concernées** : T1 (comptes — partiellement via stripe_customer_id), T5 (facturation principale), T8 (archives comptables — données transactionnelles).

**6 Products / Prices** (3 plans × 2 cycles facturation) configurés sur Stripe Live.
**4 événements webhook** souscrits : `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`.

## Nature et catégories de données traitées

- Email, nom, prénom de l'abonné
- Adresse de facturation
- Données de carte bancaire (PAN complet, CVV, date d'expiration) — **traitées exclusivement par Stripe, jamais stockées chez So Paradi**
- 4 derniers chiffres et marque de la carte (Visa, Mastercard) — partagés avec So Paradi pour affichage utilisateur
- SIRET (capté au 1er devis ou via popup setup)
- Historique transactionnel
- IP du payeur (anti-fraude Stripe Radar)

## Localisation et transferts

| Élément | Valeur |
|---|---|
| Entité contractante | Stripe Payments Europe Ltd (Dublin, UE) |
| Traitement principal | UE |
| Transferts hors UE | Oui — Stripe Inc. (San Francisco, USA) pour le back-end opérationnel et la conformité KYB |
| Base de transfert | Clauses contractuelles types adoptées par la Commission européenne (décision 2021/914 du 4 juin 2021) intégrées au DPA Stripe |
| Adhésion DPF | Stripe Inc. est certifiée Data Privacy Framework (UE-US) |

## Garanties art. 28 RGPD

- **DPA contre-signé** (acquis lors de la validation KYB du 7 mai 2026)
- Stripe certifié **PCI-DSS Level 1** (plus haut niveau de certification)
- Stripe certifié **SOC 2 Type II**
- Sous-traitants ultérieurs Stripe documentés et encadrés
- Mesures techniques : chiffrement E2E des données de carte, tokenisation, anti-fraude Stripe Radar
- Notification de violation : sans retard injustifié
- Webhook signé par `STRIPE_WEBHOOK_SECRET` côté MovUP (intégrité du flux entrant)

## Statut DPA

**Acquis** — validation KYB du 7 mai 2026, compte `acct_1TUUWgGnSpFY8vAv` opérationnel en mode Live.

## Durée du traitement

- Données opérationnelles : durée de l'abonnement
- Données comptables et transactionnelles : 7 à 10 ans selon obligations légales croisées (Stripe DPA + Code commerce art. L123-22)

## Mesures de réversibilité

- Export complet via Dashboard Stripe ou API Stripe
- Migration possible vers un autre PSP (Mollie, Adyen, etc.) sous réserve de réémission des paiements récurrents

---

# Fiche S4 — Resend Inc. (entité Ireland)

## Identification

| Champ | Valeur |
|---|---|
| Dénomination | Resend Inc. |
| Forme juridique | Société américaine (Delaware C-Corporation) |
| Entité contractante | Resend Inc. (compte rattaché à l'entité Ireland pour traitement UE) |
| Adresse | San Francisco, CA, USA (siège) ; eu-west-1 (Dublin) pour traitement européen |
| URL | https://resend.com |
| Contact DPO | privacy@resend.com |
| URL DPA | https://resend.com/legal/dpa |

## Fonction et objet du traitement sous-traité

**Fonction** : service d'envoi d'emails transactionnels et de prospection.

**Description** : envoi de tous les emails sortants MovUP — emails transactionnels (welcome, OAuth confirmation, accusés opt-out, notifications cycle de vie), emails de prospection cold mail, emails de support.

**Activités de traitement concernées** : T2 (prospection cold mail), T4 (opt-out — magic link + accusés), T5 (factures), T6 (support et transactionnels).

**5 templates Resend** identifiés : optout-verify, optout-acknowledged, optout-internal-notification, account-deletion-scheduled, account-deletion-confirmed (+ welcome OAuth).

## Nature et catégories de données traitées

- Adresse email du destinataire
- Nom / prénom (pour personnalisation)
- Contenu de l'email (corps + objet)
- Métadonnées d'envoi (timestamp, identifiant Resend, statut delivery, ouverture, clic)

## Localisation et transferts

| Élément | Valeur |
|---|---|
| Région de traitement | eu-west-1 (Dublin) — région explicitement choisie au moment de la création du compte |
| Compte Resend | Rattaché à bonjour@movup.io |
| Domaine vérifié | movup.io (DNS Gandi : SPF, DKIM, DMARC configurés) |
| Transferts hors UE | Possibles vers personnel Resend US dans le cadre du support technique |
| Base de transfert | Clauses contractuelles types 2021/914 |

## Garanties art. 28 RGPD

- DPA standard Resend
- Chiffrement TLS 1.2+ en transit
- Authentification API par token
- Mode warming progressif sur le domaine `movup.io` (14 jours minimum)
- Logs d'envoi conservés selon politique Resend
- Notification de violation : sans retard injustifié

## Statut DPA

**À contre-signer**. DPA disponible chez Resend, contre-signature formelle à effectuer avant lancement commercial.

## Durée du traitement

Durée de l'abonnement Resend.

## Mesures de réversibilité

- Migration vers tout autre prestataire d'email transactionnel (Postmark, Mailgun, SendGrid, Brevo) possible — uniquement reconfiguration DNS + endpoint API
- Templates exportables en HTML/text

---

# Fiche S5 — Google Ireland Ltd

## Identification

| Champ | Valeur |
|---|---|
| Dénomination | Google Ireland Limited |
| Forme juridique | Société irlandaise (Ltd) |
| Entité contractante | Google Ireland Ltd |
| Adresse | Gordon House, Barrow Street, Dublin 4, Irlande |
| URL | https://workspace.google.com / https://cloud.google.com |
| Contact DPO | privacy-eu@google.com |
| URL DPA Workspace | https://workspace.google.com/terms/dpa_terms.html |
| URL DPA Cloud | https://cloud.google.com/terms/data-processing-addendum |

## Fonction et objet du traitement sous-traité

**Fonction** : double — (a) hébergement de la boîte email Workspace bonjour@movup.io et ses 4 alias, (b) authentification OAuth Gmail pour les abonnés MovUP connectant leur boîte mail au service.

**Description** :

- **Google Workspace** : hébergement de bonjour@movup.io (boîte principale) + 4 alias (contact@, dpo@, noreply@, support@) pour les communications support, prospection sortante manuelle de Ben, communications avec DPO.
- **Google OAuth Gmail (movup-mail-oauth)** : flux OAuth permettant aux abonnés MovUP de connecter leur propre boîte Gmail au service. Projet Google Cloud `movup-mail-oauth` (ID 176479830147), Gmail API activée, écran de consentement OAuth External, 5 routes OAuth implémentées, tokens chiffrés AES-256-GCM stockés dans la table `mailbox_credentials`.

**Activités de traitement concernées** : T6 (support et transactionnels via Workspace), T1 (comptes — partiellement via tokens OAuth des abonnés ayant connecté Gmail).

## Nature et catégories de données traitées

**Workspace bonjour@movup.io** :
- Échanges email entrants/sortants de la boîte support, DPO, contact
- Données d'identification des correspondants

**OAuth Gmail (abonnés) — uniquement pour les abonnés ayant volontairement connecté leur boîte** :
- Token d'accès Gmail (chiffré AES-256-GCM)
- Refresh token (chiffré AES-256-GCM)
- Métadonnées de connexion (date, scope, statut)
- Accès en lecture/écriture à la boîte Gmail de l'abonné selon scope autorisé

## Localisation et transferts

| Élément | Valeur |
|---|---|
| Entité contractante | Google Ireland Ltd (UE) |
| Traitement principal | UE + monde (datacenters Google globaux) |
| Transferts hors UE | Oui (Google Inc., Mountain View, USA) |
| Base de transfert | Clauses contractuelles types 2021/914 + adhésion Data Privacy Framework (DPF) de Google LLC |

## Garanties art. 28 RGPD

- **DPA acquis** (acceptation des CGU Google Workspace + Cloud)
- Google certifié **ISO 27001, ISO 27017, ISO 27018, SOC 2 Type II**
- Authentification 2FA obligatoire sur le compte Workspace bonjour@movup.io
- Chiffrement E2E en transit + au repos
- Sous-traitants ultérieurs Google documentés (cloud.google.com/terms/subprocessors)
- Notification de violation : sans retard injustifié
- App OAuth en mode "test" jusqu'à 100 utilisateurs (vérification Google gratuite à demander au-delà)

## Statut DPA

**Acquis** — acceptation lors de la création des comptes Workspace et Google Cloud Platform.

## Durée du traitement

- Workspace : durée de l'abonnement
- OAuth Gmail : durée de la connexion choisie par l'abonné, révocation immédiate sur disconnect côté MovUP

## Mesures de réversibilité

- Workspace : export Google Takeout, migration vers autre fournisseur (Microsoft 365, ProtonMail) possible
- OAuth : remplacement par un mécanisme IMAP générique possible (architecture double track déjà prévue dans MovUP)

---

# Fiche S6 — Cloudflare Ireland Ltd

## Identification

| Champ | Valeur |
|---|---|
| Dénomination | Cloudflare Ireland Limited |
| Forme juridique | Société irlandaise (Ltd) |
| Entité contractante | Cloudflare Ireland Ltd |
| Adresse | County Cork, Irlande |
| URL | https://www.cloudflare.com |
| Contact DPO | dpo@cloudflare.com |
| URL DPA | https://www.cloudflare.com/cloudflare-customer-dpa/ |

## Fonction et objet du traitement sous-traité

**Fonction** : CDN, terminaison HTTPS, protection DDoS, gestion DNS secondaire.

**Description** : Cloudflare est placé en frontal devant les domaines de l'écosystème So Paradi (movup.io, graphicfactor.io, nouvellevagu.es). Il assure la terminaison HTTPS (HSTS), la mise en cache statique, la protection contre les attaques par déni de service, et le routage géographique optimisé.

**Activités de traitement concernées** : transversal — toutes les activités utilisant un canal web.

## Nature et catégories de données traitées

- Adresses IP des visiteurs (transitoires, non stockées durablement par MovUP)
- User-Agent
- En-têtes HTTP standards
- Pas de contenu métier persisté chez Cloudflare (le contenu HTTPS est déchiffré pour terminaison TLS puis re-encapsulé vers le serveur d'origine Railway)

## Localisation et transferts

| Élément | Valeur |
|---|---|
| Entité contractante | Cloudflare Ireland Ltd (UE) |
| Traitement | Réseau anycast mondial — la requête est traitée par le datacenter Cloudflare le plus proche du visiteur |
| Transferts hors UE | Oui (réseau mondial Cloudflare, dont Cloudflare Inc. USA) |
| Base de transfert | Clauses contractuelles types 2021/914 + DPF |

## Garanties art. 28 RGPD

- **DPA acquis** (acceptation des CGU Cloudflare)
- Cloudflare certifié **ISO 27001, ISO 27018, SOC 2 Type II, PCI-DSS**
- Chiffrement TLS 1.3
- Pas de cache de contenu chiffré (HTTPS)
- Notification de violation : sans retard injustifié
- Configuration "Geo Block" disponible si besoin (non activée à la date d'effet)

## Statut DPA

**Acquis** — acceptation des CGU lors de l'inscription Cloudflare.

## Durée du traitement

Durée du compte Cloudflare.

## Mesures de réversibilité

- DNS et HTTPS reconfigurables vers n'importe quel autre CDN (Fastly, Bunny CDN) ou directement vers Railway sans CDN
- Aucun verrouillage technique

---

# Fiche S7 — Gandi SAS

## Identification

| Champ | Valeur |
|---|---|
| Dénomination | Gandi SAS |
| Forme juridique | Société par actions simplifiée (France) |
| Entité contractante | Gandi SAS |
| Adresse | 63-65 boulevard Masséna, 75013 Paris, France |
| URL | https://www.gandi.net |
| Contact DPO | dpo@gandi.net |
| URL CGU | https://www.gandi.net/fr/contracts |

## Fonction et objet du traitement sous-traité

**Fonction** : registrar DNS, hébergement DNS, hébergement email (boîtes secondaires éventuelles, alias).

**Description** : Gandi assure la gestion des noms de domaine de l'écosystème So Paradi (movup.io, graphicfactor.io, nouvellevagu.es, menorca-agenda.com) et la résolution DNS. Configuration des enregistrements DKIM, SPF, DMARC pour la délivrabilité Resend, MX pour acheminer le mail vers Workspace ou Resend.

**Activités de traitement concernées** : transversal infrastructure (pas d'activité de traitement propre).

## Nature et catégories de données traitées

- Données de titulaire du nom de domaine (Benoît Fouquet — données publiques WHOIS partiellement anonymisées via Gandi Privacy)
- Données techniques de configuration DNS

## Localisation et transferts

| Élément | Valeur |
|---|---|
| Entité contractante | Gandi SAS (France) |
| Traitement | France (Paris + Bordeaux) |
| Transferts hors UE | Non |

## Garanties art. 28 RGPD

- Hébergement et registrar français, droit français applicable
- Gandi accrédité ICANN avec engagements WHOIS conformes RGPD
- Service "Gandi Privacy" pour anonymisation WHOIS
- Notification de violation : sans retard injustifié

## Statut DPA

**Acquis** (CGU Gandi intégrant les obligations RGPD du registrar).

## Durée du traitement

Durée de détention des noms de domaine.

## Mesures de réversibilité

- Transfert de domaine vers tout autre registrar accrédité (OVH, Namecheap, etc.) possible — procédure ICANN standard
- Aucun verrouillage technique

---

# Fiche S8 — ipapi (Kloudend Inc.)

## Identification

| Champ | Valeur |
|---|---|
| Dénomination | Kloudend Inc. (opérateur de ipapi.co) |
| Forme juridique | Société américaine |
| Entité contractante | Kloudend Inc. |
| Adresse | États-Unis |
| URL | https://ipapi.co |
| Contact | support@ipapi.co |

## Fonction et objet du traitement sous-traité

**Fonction** : géolocalisation IP à l'inscription d'un nouvel abonné.

**Description** : lors de la création d'un compte MovUP, l'IP du visiteur est transmise à ipapi.co qui retourne le pays, la région et la ville approximatifs. Cette information sert à pré-remplir certains champs et à des fins analytiques internes (répartition géographique des inscriptions).

**Activités de traitement concernées** : T1 (comptes utilisateurs — au moment de l'inscription uniquement).

## Nature et catégories de données traitées

- IP du visiteur (transmise à ipapi pour résolution, **non stockée chez ipapi** selon leur politique sauf en cache court de performance)
- Données retournées : pays, région, ville, fuseau horaire, code ISO

## Localisation et transferts

| Élément | Valeur |
|---|---|
| Entité contractante | Kloudend Inc. (USA) |
| Traitement | USA |
| Transferts hors UE | Oui — par construction (transfert depuis le serveur MovUP UE vers ipapi USA) |
| Base de transfert | Clauses contractuelles types 2021/914 — à vérifier dans CGU ipapi |

## Garanties art. 28 RGPD

**Point d'attention** : ipapi.co est un service américain à coût marginal très faible, dont les garanties contractuelles RGPD sont **moins robustes** que celles des sous-traitants S1 à S7. Le service est utilisé en mode API publique, sans DPA contre-signé formel à la date d'effet.

## Statut DPA

**À vérifier ou substituer**.

**Trois options de mitigation** (à arbitrer avant ou peu après le lancement) :

**Option A — Substitution par un service européen** : remplacer ipapi.co par un service de géolocalisation IP basé en UE (par exemple ipgeolocation.io entité UE, ou une bibliothèque libre comme MaxMind GeoIP2 self-hosted). Effort technique faible (~2h).

**Option B — Substitution par une bibliothèque libre embarquée** : intégrer MaxMind GeoLite2 directement dans l'application Railway, supprimer tout appel externe. Pas de transfert, pas de sous-traitant. Effort ~3h.

**Option C — Suppression pure de la fonctionnalité** : si la géolocalisation IP à l'inscription n'apporte pas de valeur produit clairement identifiée, supprimer purement et simplement l'appel à ipapi. Effort ~30 min.

**Recommandation bon père de famille** : **Option B (MaxMind GeoLite2 self-hosted)** — supprime tout transfert hors UE pour cette finalité, gratuit (licence GeoLite2 gratuite avec mise à jour), aucune dépendance externe. À planifier en V1.0.x post-lancement (semaine 1-2).

## Durée du traitement

Appel transactionnel à chaque inscription, donnée retournée stockée dans la fiche utilisateur tant que le compte existe.

## Mesures de réversibilité

- Substitution triviale par tout autre service ou bibliothèque
- Aucun verrouillage technique

---

# Fiche S9 — INSEE / DINUM Etalab (sources publiques officielles)

## Identification

| Champ | Valeur |
|---|---|
| Dénomination | Institut National de la Statistique et des Études Économiques (INSEE) + Direction interministérielle du numérique (DINUM) Etalab |
| Forme juridique | Organismes publics français |
| URL INSEE | https://api.insee.fr |
| URL Etalab | https://api.gouv.fr/les-api/api-recherche-entreprises |
| URL BAN | https://adresse.data.gouv.fr |
| Contact | Via dispositifs CNIL pour SIRENE, dpd@insee.fr |

## Fonction et objet du traitement sous-traité

**Note importante** : INSEE et DINUM sont des **organismes publics**, **sources officielles de données publiques**, et non des sous-traitants au sens strict de l'article 28 RGPD. Leur inclusion dans la présente cartographie vise la **transparence sur les sources** plutôt qu'une qualification juridique de sous-traitance.

Pour la même raison, **aucun DPA n'est applicable** : la relation est encadrée par la loi (loi n°2016-1321 du 7 octobre 2016, arrêté du 22 juin 2017) et par les conditions générales de réutilisation Etalab 2.0.

**Fonction** :
- **API SIRENE INSEE V3** : consultation du répertoire SIRENE des entreprises (authentification OAuth2 directe).
- **API recherche-entreprises Etalab** : service public Etalab de consultation simplifiée du répertoire SIRENE.
- **API BAN (Base Adresse Nationale) data.gouv.fr** : géocodage des adresses françaises.

**Activités de traitement concernées** : T2 (prospection — collecte initiale), T3 (enrichissement — référencement initial des entreprises ciblées).

## Nature et catégories de données traitées

Données publiquement diffusées par SIRENE :

- Dénomination sociale, SIRET, SIREN, NAF, adresse postale, date de création, tranche d'effectifs, nom et prénom du dirigeant (EI), statut juridique (actif/radié/liquidation), champ `statut_diffusion`.

Données issues de BAN :

- Coordonnées géographiques (latitude, longitude) calculées à partir de l'adresse.

## Localisation et transferts

| Élément | Valeur |
|---|---|
| Entité | Organismes publics français |
| Traitement | France |
| Transferts hors UE | Non |

## Garanties

- Diffusion publique encadrée par la loi pour une République numérique (loi 2016-1321 du 7 octobre 2016)
- Arrêté du 22 juin 2017 fixant les modalités de diffusion SIRENE
- **Champ `statut_diffusion`** consulté pour respecter le droit d'opposition à la diffusion exercé par certains entrepreneurs individuels auprès de l'INSEE
- Conditions générales de réutilisation Etalab 2.0

## Statut DPA

**Sans objet** (relation encadrée par la loi, non contractuelle).

## Durée du traitement

Appel transactionnel à chaque requête. Pas de stockage chez le sous-traitant (le responsable de traitement consulte, ne stocke pas chez l'INSEE).

## Mesures de réversibilité

- Sources publiques par nature, accessibles à tout réutilisateur
- Aucune réversibilité applicable

---

## Section transversale — Sous-traitants explicitement écartés (Doctrine 9 LIA)

Conformément à la **Doctrine 9 de la balance test LIA-MOVUP-001 v1.1 — Souveraineté technique**, les catégories de sous-traitants suivantes sont **explicitement écartées** et ne figurent pas dans la présente cartographie :

### Prestataires de scraping en marque blanche (écartés)

- ScrapingBee
- Scrapfly
- Bright Data
- Apify
- Octoparse

**Motivation** : risque de chaîne de sous-traitance opaque, transferts hors UE difficilement maîtrisables, responsabilité conjointe potentielle (CJUE C-40/17 Fashion ID).

### Agrégateurs de données B2B (écartés)

- Pappers
- Société.com
- Manageo
- Infogreffe (en accès commercial direct)

**Motivation** : la consultation de ces agrégateurs revient à mobiliser des bases agrégées par des tiers dont la conformité n'est pas auditable. So Paradi privilégie la consultation directe des sources publiques (SIRENE, Etalab).

### Fournisseurs de bases de contacts enrichies (écartés)

- Dropcontact
- Apollo
- Lusha
- ZoomInfo
- Hunter.io
- Cognism
- Lemlist (pour la partie database)

**Motivation** : ces fournisseurs reposent sur des agrégations de profils LinkedIn et autres réseaux sociaux dont la conformité est contestable (jurisprudence CNIL et CNIL allemande contre certains acteurs). Le moteur de recherche interne MovUP couvre fonctionnellement ce besoin de manière souveraine (cf. LIA Section 3.4).

### Moteurs de recherche tiers (écartés)

- Qwant Search API
- Brave Search API
- Bing Search API
- Google Custom Search Engine

**Motivation** : la consultation directe des sites officiels d'entreprise par le moteur de recherche interne MovUP rend inutile le recours à un moteur de recherche tiers. Élimination d'un sous-traitant supplémentaire.

### CAPTCHA tiers non-UE (écarté — Doctrine 8 LIA)

- Google reCAPTCHA
- hCaptcha (selon configuration)
- Cloudflare Turnstile (option étudiée mais non retenue à la date d'effet)

**Motivation** : protection anti-bot assurée par un **honeypot + question logique**, conformément à la Doctrine 8 de la balance test. Pas de transfert de comportement utilisateur vers un service tiers.

### Outils d'analytics tiers (écartés par défaut)

- Google Analytics
- Mixpanel
- Hotjar
- Segment

**Motivation** : aucun outil d'analytics tiers n'est intégré à MovUP à la date d'effet du présent document. Les métriques d'usage internes sont calculées en SurrealQL sur les données déjà stockées (page Statistiques). L'introduction future d'un outil d'analytics imposerait une révision préalable du présent document et de la balance test.

---

## Section finale — Tableau de synthèse opérationnel

### Synthèse par statut DPA

| Statut | Sous-traitants | Action requise |
|---|---|---|
| **Acquis** | Stripe (S3), Google (S5), Cloudflare (S6), Gandi (S7) | Aucune action |
| **À contre-signer** | Railway (S1), SurrealDB (S2), Resend (S4) | Contre-signature formelle des DPA standards (≤ 2h) |
| **À substituer ou vérifier** | ipapi (S8) | Remplacement par MaxMind GeoLite2 self-hosted recommandé (≤ 3h) |
| **Sans objet** | INSEE / Etalab (S9) | Aucune action |

### Synthèse par localisation

| Localisation principale | Sous-traitants | Volume de données |
|---|---|---|
| France | Gandi (S7), INSEE/Etalab (S9) | Faible (DNS + sources publiques) |
| Irlande | Stripe (S3), Resend (S4), Google (S5), Cloudflare (S6), SurrealDB (S2 via AWS Dublin) | Élevé (cœur des traitements) |
| Belgique (GCP) | Railway (S1) | Élevé (exécution applicative) |
| Royaume-Uni (adéquation) | SurrealDB Labs (S2 entité) | Faible (administration) |
| États-Unis (CCT 2021/914) | Stripe Inc. (transferts depuis S3), Google LLC (transferts depuis S5), Cloudflare Inc. (transferts depuis S6), Kloudend (S8) | Maîtrisés sauf S8 |

### Synthèse de la chaîne de sous-traitance ultérieure

Les principaux sous-traitants ultérieurs identifiés :

- **Railway** : Google Cloud Platform (europe-west4) + AWS
- **SurrealDB Cloud** : AWS Ireland Ltd (eu-west-1)
- **Stripe** : Stripe Inc. (US), sous-traitants techniques documentés Stripe
- **Resend** : AWS (eu-west-1)
- **Google** : Google LLC + sous-traitants Google
- **Cloudflare** : Cloudflare Inc. + datacenters mondiaux Cloudflare

Tous les sous-traitants ultérieurs sont documentés dans les DPA respectifs des sous-traitants principaux.

---

## Recommandations bon père de famille — Plan d'action avant lancement

**À fermer avant le 1er juin 2026** :

1. Contre-signature formelle des DPA standards Railway, SurrealDB Cloud, Resend (≤ 2h cumulées, opérations purement administratives).
2. Audit du champ `statut_diffusion` SIRENE dans le moteur de collecte initiale (filtrage des entrepreneurs ayant exercé leur droit d'opposition à la diffusion auprès de l'INSEE — cf. recommandation balance test).

**À fermer en V1.0.x (semaine 1-2 post-lancement)** :

3. Substitution de ipapi.co (S8) par MaxMind GeoLite2 self-hosted (Option B, ~3h dev). Élimine le seul transfert hors UE non strictement encadré.

**À reporter Phase 6-bis avocat (post premiers abonnés)** :

4. Revue formelle de tous les DPA par avocat RGPD spécialisé (1500-3000€).
5. Examen approfondi de la chaîne de sous-traitance ultérieure Stripe et Google (transferts US, accès en cas d'incident).
6. Désignation formelle d'un DPO (actuellement Benoît Fouquet cumule responsable de traitement et fonction DPO de facto — à formaliser ou à externaliser).

---

## Validité, opposabilité et revue

### Validité

Le présent document est **valide à compter du 1er juin 2026** et demeure valide jusqu'à révision formelle.

### Opposabilité

Le présent document est **opposable** :

- à toute autorité de contrôle (CNIL en premier lieu),
- à toute personne concernée exerçant ses droits,
- à toute juridiction saisie.

### Revue et mise à jour

Revue **semestrielle** systématique (prochaine : 1er décembre 2026).

Revue **exceptionnelle** en cas de :

- ajout, suppression ou remplacement d'un sous-traitant,
- modification substantielle du DPA d'un sous-traitant existant,
- introduction d'un transfert de données hors UE non documenté,
- changement de localisation d'un sous-traitant existant,
- introduction de fonctionnalités d'IA (révision de la cartographie pour intégrer un éventuel sous-traitant IA),
- évolution réglementaire (notamment fin de la décision d'adéquation Royaume-Uni au 27 juin 2027, fin du Data Privacy Framework),
- violation de données impliquant un sous-traitant,
- demande formelle d'une autorité de contrôle.

### Conservation et archivage

Le présent document et ses versions antérieures sont conservés sans limitation de durée dans `docs/rgpd/` du dépôt source Soparadi/mup, avec horodatage Git.

---

## Signature

Le présent document est établi sous la responsabilité de Benoît Fouquet, en sa qualité de responsable de traitement, et engage l'entreprise individuelle So Paradi (SIRET 453 388 456 00031).

L'ensemble des 9 sous-traitants documentés est mobilisé effectivement à la date d'effet du présent document, sous réserve des contre-signatures DPA pendantes et de la substitution recommandée du sous-traitant S8.

**Fait à Dinan, le 25 mai 2026**

**Benoît Fouquet**
Responsable de traitement — So Paradi (EI)
SIRET 453 388 456 00031
dpo@movup.io

---

*Document de référence interne — CST-MOVUP-001 v1.0 — Conformité art. 28 RGPD*
