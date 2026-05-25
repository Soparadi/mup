# Registre des activités de traitement — Article 30 RGPD

**Responsable de traitement** : Benoît Fouquet — Entrepreneur Individuel So Paradi
**SIRET** : 453 388 456 00031
**Adresse** : 18 place du Marchix, 22100 Dinan, France
**Contact DPO** : dpo@movup.io

**Document** : Registre des activités de traitement
**Référence interne** : RAT-MOVUP-001
**Version** : 1.0
**Date de rédaction** : 25 mai 2026
**Date d'effet** : 1er juin 2026 (lancement commercial MovUP)
**Prochaine revue** : 1er décembre 2026 (revue semestrielle systématique)
**Cadre méthodologique** : Modèle CNIL de registre des activités de traitement (édition 2024)

---

## Préambule

Le présent document constitue le **registre des activités de traitement** prévu à l'article 30 du Règlement (UE) 2016/679 (RGPD), tenu sous la responsabilité du responsable de traitement conformément au principe d'**accountability** posé à l'article 5.2 RGPD.

Il documente, pour chaque finalité de traitement mise en œuvre par MovUP, les éléments requis par l'article 30.1 :

- nom et coordonnées du responsable de traitement,
- finalités du traitement,
- description des catégories de personnes concernées et des catégories de données,
- catégories de destinataires,
- transferts vers un pays tiers ou organisation internationale,
- délais d'effacement,
- description générale des mesures de sécurité techniques et organisationnelles.

Ce document est **opposable** : il peut être produit à toute autorité de contrôle compétente (CNIL, APD belge, PFPDT suisse, CAI Québec).

Il est articulé avec :

- la balance test intérêt légitime (LIA-MOVUP-001 v1.1) — fondement juridique des traitements basés sur l'article 6.1.f,
- l'analyse d'impact relative à la protection des données (AIPD-MOVUP-001) — analyse de risque,
- la cartographie des sous-traitants (CST-MOVUP-001) — chaîne de sous-traitance détaillée,
- le journal technique `docs/PHASE_6_RGPD_COMPLETE.md` (tag git `v1.0.0-rgpd`) — état du système.

---

## Identification commune du responsable de traitement

Cette identification s'applique à l'ensemble des fiches de traitement du présent registre.

| Élément | Valeur |
|---|---|
| Dénomination | Benoît Fouquet — Entrepreneur Individuel So Paradi |
| Nom commercial | So Paradi |
| Forme juridique | Entreprise individuelle |
| SIRET | 453 388 456 00031 |
| Adresse | 18 place du Marchix, 22100 Dinan, France |
| Représentant légal | Benoît Fouquet |
| Contact DPO | dpo@movup.io |
| Activité concernée | MovUP — SaaS pipeline management B2B (movup.io) |
| Autres marques sous responsabilité commune | Graphic Factor (graphicfactor.io), Nouvelle Vagues (nouvellevagu.es), Menorca Agenda (menorca-agenda.com) — traitements distincts non couverts par le présent registre, document dédié à venir si nécessaire |

---

## Vue d'ensemble — Liste des activités de traitement MovUP

| N° | Activité de traitement | Base légale | Volumétrie | Risque |
|---|---|---|---|---|
| T1 | Gestion des comptes utilisateurs (abonnés MovUP) | Art. 6.1.b (exécution contrat) | Croissance progressive | Standard |
| T2 | Prospection commerciale par cold mail | Art. 6.1.f (intérêt légitime) — LIA-MOVUP-001 | ~25 envois/jour | Élevé (AIPD requise) |
| T3 | Enrichissement de fiches prospects par moteur de recherche interne | Art. 6.1.f (intérêt légitime) — LIA-MOVUP-001 | ~500 fiches/jour | Élevé (AIPD requise) |
| T4 | Traitement des demandes d'opt-out (art. 21) | Art. 6.1.c (obligation légale) | Variable | Standard |
| T5 | Gestion de la facturation et des paiements | Art. 6.1.b (exécution contrat) + 6.1.c (obligation légale) | Selon nombre d'abonnés | Standard |
| T6 | Support utilisateur et communications transactionnelles | Art. 6.1.b (exécution contrat) | Selon volume support | Standard |
| T7 | Sécurité et journalisation technique (logs) | Art. 6.1.f (intérêt légitime sécurité) | Continu | Faible |
| T8 | Conservation des archives comptables | Art. 6.1.c (obligation légale art. L123-22 Code commerce) | 10 ans | Faible |

**8 activités de traitement** documentées. Les fiches détaillées suivent ci-dessous.

---

# Fiche T1 — Gestion des comptes utilisateurs (abonnés MovUP)

## Identification

| Champ | Valeur |
|---|---|
| Identifiant | T1-MOVUP |
| Intitulé | Gestion des comptes utilisateurs abonnés MovUP |
| Finalité principale | Permettre à l'abonné d'accéder au service MovUP, gérer son compte, son abonnement et ses données opérationnelles |
| Finalités secondaires | Authentification, gestion du cycle de vie de l'abonnement (essai, paiement, résiliation), exercice des droits RGPD |
| Date de mise en œuvre | 1er juin 2026 |

## Base légale (art. 6 RGPD)

**Article 6.1.b — Exécution d'un contrat** auquel la personne concernée est partie (contrat d'abonnement MovUP, accepté lors de l'inscription via CGV/CGU).

## Personnes concernées

Abonnés MovUP — personnes physiques exerçant une activité professionnelle indépendante en France (auto-entrepreneurs, micro-entrepreneurs, entrepreneurs individuels) souscrivant un compte sur movup.io.

Trois statuts coexistent :

- comptes en essai gratuit 14 jours (`trial_active`),
- comptes payants actifs (`active` sur l'un des trois plans : Démarrage 24€, Activité 34€, Croisière 44€),
- comptes en période de grâce ou expirés (`grace_active`, `grace_expired`).

## Catégories de données traitées

| Catégorie | Champs | Provenance |
|---|---|---|
| Identification | Email, nom, prénom | Saisie utilisateur à l'inscription |
| Authentification | Hash bcrypt mot de passe, session token | Généré système |
| Identité professionnelle | SIRET (optionnel, capté au 1er devis ou via popup setup) | Saisie utilisateur |
| Localisation | IP géolocalisée à l'inscription (ipapi.co), pays, région | Détection automatique |
| Préférences | Plan choisi (intended_plan), opt-in marketing RGPD | Saisie utilisateur |
| Cycle de vie compte | trial_status, subscription_status, current_period_end, deletion_requested_at, deletion_scheduled_at | Système |
| Données opérationnelles | Fiches pipeline, contacts, devis, factures, frais, agenda, mail (tokens OAuth chiffrés), visio | Saisie utilisateur ou import |
| Historique | lead_search history, audit_log | Système |

## Catégories de destinataires

**Internes** : aucun (responsable de traitement = entreprise individuelle solo).

**Sous-traitants** (cf. cartographie CST-MOVUP-001) :

- Railway Inc. — hébergement applicatif (europe-west4)
- SurrealDB Cloud — base de données (AWS eu-west-1 Dublin)
- Resend Ireland Ltd — envoi des emails transactionnels (eu-west-1 Dublin)
- Stripe Payments Europe Ltd — paiements et facturation (Dublin)
- Google Ireland Ltd — OAuth Gmail (uniquement pour les comptes connectés au mail OAuth)
- Cloudflare Ireland Ltd — CDN, HTTPS, protection DDoS
- Gandi SAS — registrar DNS et hébergement email bonjour@movup.io

**Aucun transfert commercial** vers des tiers (pas de revente, pas de partage marketing).

## Transferts hors UE

**Aucun transfert hors UE** à la date d'effet du présent document. Tous les sous-traitants sont établis dans l'Union européenne ou ont leur entité de traitement européenne. Une éventuelle exception (Stripe US pour traitement back-end) est encadrée par les clauses contractuelles types adoptées par la Commission européenne (décision 2021/914).

## Durée de conservation

| Donnée | Durée | Déclencheur |
|---|---|---|
| Compte actif | Durée de la relation contractuelle | Inscription |
| Compte après résiliation | Suppression sur demande (art. 17) ou inactivité 3 ans | Résiliation Stripe |
| Données comptables (factures) | 10 ans | Conservation légale (cf. T8) |
| Audit log | Anonymisé à la suppression du compte, conservé techniquement | Suppression compte |
| Tokens OAuth Gmail | Durée de validité Google + refresh, révocation immédiate sur disconnect | Disconnect ou suppression compte |

## Mesures de sécurité

- Chiffrement bcrypt des mots de passe (coût ≥ 12)
- Chiffrement AES-256-GCM des tokens OAuth
- HTTPS obligatoire (HSTS Cloudflare)
- Authentification par middleware `requireAuthHtml` avec whitelist de 14 routes applicatives
- Multi-tenant scoping par `userId` sur l'ensemble des routes business (12 pages migrées)
- Session token signé, expiration et renouvellement
- Webhook Stripe vérifié par signature `STRIPE_WEBHOOK_SECRET`
- Idempotence sur événements Stripe (table dédiée)
- Sauvegardes automatiques SurrealDB Cloud
- Logs d'authentification + tentatives échouées

## Exercice des droits

- **Accès (art. 15)** : sur demande à dpo@movup.io, réponse sous 1 mois.
- **Rectification (art. 16)** : modification directe depuis l'interface utilisateur ou via DPO.
- **Effacement (art. 17)** : tunnel `/account/privacy` avec délai d'annulation 7 jours, hard delete + anonymisation audit_log, conservation comptable préservée.
- **Limitation (art. 18)** : sur demande à dpo@movup.io.
- **Portabilité (art. 20)** : export JSON disponible à vie depuis `/account/privacy`, rate-limité 5/24h.
- **Opposition (art. 21)** : sans objet pour ce traitement (base contractuelle).
- **Décision automatisée (art. 22)** : sans objet, aucun profilage automatisé.

---

# Fiche T2 — Prospection commerciale par cold mail

## Identification

| Champ | Valeur |
|---|---|
| Identifiant | T2-MOVUP |
| Intitulé | Prospection commerciale B2B par cold mail |
| Finalité principale | Présenter l'outil MovUP à des prospects qualifiés et les convertir en abonnés |
| Finalités secondaires | Qualification commerciale, suivi des interactions, gestion du droit d'opposition |
| Date de mise en œuvre | 1er juin 2026 |

## Base légale (art. 6 RGPD)

**Article 6.1.f — Intérêt légitime** du responsable de traitement, démontré par le test de mise en balance LIA-MOVUP-001 v1.1.

Considérant 47 RGPD : la prospection commerciale est expressément reconnue comme finalité légitime sous réserve des conditions encadrant ce fondement.

## Personnes concernées

Prospects professionnels indépendants francophones inscrits dans des registres publics (auto-entrepreneurs, micro-entrepreneurs, entrepreneurs individuels). À la date d'effet du présent document, périmètre limité à la France (répertoire SIRENE).

Les prospects sont par construction :

- des personnes physiques exerçant une activité économique indépendante,
- inscrites dans un registre public à diffusion légale (SIRENE),
- ayant publié volontairement des coordonnées professionnelles (mentions légales LCEN sur sites officiels).

## Catégories de données traitées

| Catégorie | Champs | Provenance |
|---|---|---|
| Identification professionnelle | Dénomination sociale, SIRET, SIREN, code NAF, date de création, tranche d'effectifs | API recherche-entreprises Etalab + API SIRENE INSEE V3 |
| Identification dirigeant (EI uniquement) | Nom, prénom | API SIRENE INSEE V3 |
| Localisation | Adresse postale du siège, coordonnées GPS | API SIRENE + API BAN data.gouv.fr |
| Contact professionnel | Site web, email professionnel générique (contact@, info@, commercial@, bonjour@, hello@), téléphone professionnel | Moteur de recherche interne MovUP (cf. T3) |
| Statut juridique | Actif, radié, en liquidation | API SIRENE |
| Historique commercial | Date d'envoi, statut ouverture, statut réponse, statut opt-out | Système MovUP |

**Données exclues** (filtres défensifs à l'écriture) :

- adresses email nominatives type `prenom.nom@` (rejet silencieux),
- profils LinkedIn ou réseaux sociaux personnels,
- catégories particulières art. 9 et 10 RGPD,
- toute donnée privée identifiable.

## Catégories de destinataires

**Internes** : aucun.

**Sous-traitants** :

- Resend Ireland Ltd — envoi des emails de prospection (eu-west-1 Dublin)
- SurrealDB Cloud — stockage des fiches prospects (AWS eu-west-1 Dublin)
- Railway Inc. — hébergement applicatif (europe-west4)

**Pas de revente, pas de partage** des données prospects avec un tiers commercial.

## Transferts hors UE

**Aucun transfert hors UE.**

## Durée de conservation

| Donnée | Durée | Déclencheur |
|---|---|---|
| Prospect non contacté | 3 ans à compter de la collecte | Collecte |
| Prospect contacté sans réponse | 3 ans à compter du dernier contact | Dernier envoi |
| Prospect ayant exercé son droit d'opposition | Hash SHA-256 conservé pérennement | Validation opt-out |
| Historique des envois | 3 ans | Envoi |

## Mesures de sécurité

- Footer art. 14 sur chaque communication (injection serveur anti-bypass DOM)
- Lien opt-out personnalisé par destinataire dans chaque envoi
- Tunnel `/optout` à deux étapes avec magic link signé à expiration courte (24h)
- Double rempart de filtrage opt-out (upstream silencieux + refus dur en aval)
- Propagation instantanée de l'opt-out sur la base partagée entre tous les abonnés
- Hash SHA-256 des identifiants opt-out
- Rate-limiting 3 demandes opt-out / 24h / IP
- Plafond opérationnel d'envoi : ~25 emails/jour à la date d'effet (croissance progressive maîtrisée)
- Multi-tenant scoping par `userId`

## Exercice des droits

- **Accès (art. 15)** : sur demande à dpo@movup.io, réponse sous 1 mois, incluant métadonnées par champ (source, horodatage).
- **Rectification (art. 16)** : sur demande à dpo@movup.io.
- **Effacement (art. 17)** : sur demande à dpo@movup.io ou via `/optout` (équivalent fonctionnel).
- **Opposition (art. 21)** : tunnel public `/optout` accessible sans authentification, prise d'effet sous 24h après confirmation magic link, propagation instantanée.
- **Décision automatisée (art. 22)** : sans objet, aucun profilage automatisé.

---

# Fiche T3 — Enrichissement de fiches prospects par moteur de recherche interne

## Identification

| Champ | Valeur |
|---|---|
| Identifiant | T3-MOVUP |
| Intitulé | Enrichissement de fiches prospects par moteur de recherche interne |
| Finalité principale | Compléter les fiches issues de SIRENE avec les coordonnées de contact professionnel publiquement publiées par les entreprises elles-mêmes |
| Finalités secondaires | Maintien à jour de la base partagée mutualisée entre abonnés MovUP |
| Date de mise en œuvre | 1er juin 2026 |

## Base légale (art. 6 RGPD)

**Article 6.1.f — Intérêt légitime** du responsable de traitement, démontré par le test de mise en balance LIA-MOVUP-001 v1.1 (notamment Section 3.4 et Doctrine 10 — Cinq lignes rouges).

## Personnes concernées

Personnes physiques exerçant une activité professionnelle indépendante ayant publié des mentions légales conformes à l'article 19 de la LCEN sur leur site web professionnel.

La collecte n'a lieu que sur des sites web :

- accessibles publiquement,
- respectant la directive `robots.txt`,
- relevant d'une entreprise identifiée dans le répertoire SIRENE,
- non inscrite en blocklist MovUP.

## Catégories de données traitées

| Catégorie | Champs | Provenance |
|---|---|---|
| Contact professionnel | Email professionnel générique (contact@, info@, commercial@, bonjour@, hello@), téléphone professionnel, URL réseaux sociaux entreprise | Page d'accueil + page mentions légales / contact du site officiel |
| Métadonnées | Horodatage de collecte, source identifiée (URL exacte de la page consultée) | Système |

**Données strictement exclues** (Doctrine 10 — Cinq lignes rouges) :

- email nominatif type `prenom.nom@` (rejet silencieux à l'écriture, regex `[a-z]+\.[a-z]+@`),
- URL profil personnel sur réseau social,
- toute donnée issue de LinkedIn (CGU 2024),
- toute donnée privée.

## Catégories de destinataires

**Internes** : aucun.

**Sous-traitants** :

- SurrealDB Cloud — stockage du cache mutualisé `company_public` (AWS eu-west-1 Dublin)
- Railway Inc. — exécution du moteur (europe-west4)

**Aucun prestataire tiers de scraping** (cf. LIA-MOVUP-001 v1.1, Doctrine 9 — Souveraineté technique).

## Transferts hors UE

**Aucun transfert hors UE.**

## Durée de conservation

| Donnée | Durée | Déclencheur |
|---|---|---|
| Données enrichies | 24 mois à compter de la dernière mise à jour | Collecte ou re-vérification |
| Au-delà | Re-vérification automatique ou purge | Cron quotidien |

## Mesures de sécurité

- Moteur opéré exclusivement sur infrastructure du responsable de traitement (Railway europe-west4)
- Respect du fichier robots.txt de chaque domaine consulté
- Plafond opérationnel ~500 fiches/jour
- Délai minimum entre requêtes successives sur un même domaine
- Filtres défensifs à l'écriture (anti-email nominatif, anti-réseaux sociaux personnels)
- Architecture à double cache : `company_public` partagé (données publiques uniquement) / `company_enrichment_user` privé par abonné (notes commerciales personnelles)
- Aucune fuite possible entre cache mutualisé et notes privées
- Propagation instantanée de l'opt-out : un identifiant en blocklist disparaît du cache mutualisé
- Fail-open en faveur des personnes concernées : toute erreur technique interrompt l'enrichissement

## Exercice des droits

- **Accès (art. 15)** : sur demande à dpo@movup.io, réponse sous 1 mois incluant les métadonnées (source, horodatage).
- **Rectification (art. 16)** : sur demande à dpo@movup.io.
- **Effacement (art. 17)** : sur demande à dpo@movup.io ou via `/optout` (équivalent fonctionnel — supprime la donnée du cache mutualisé).
- **Opposition (art. 21)** : tunnel `/optout` (propagation instantanée).

---

# Fiche T4 — Traitement des demandes d'opt-out (art. 21 RGPD)

## Identification

| Champ | Valeur |
|---|---|
| Identifiant | T4-MOVUP |
| Intitulé | Gestion des demandes d'opposition au traitement (art. 21 RGPD) |
| Finalité principale | Permettre l'exercice effectif du droit d'opposition par toute personne concernée |
| Finalités secondaires | Démontrer le respect de l'opposition (art. 5.2 accountability), prévenir toute sollicitation ultérieure |
| Date de mise en œuvre | 25 mai 2026 (Phase 6 RGPD close, tag `v1.0.0-rgpd`) |

## Base légale (art. 6 RGPD)

**Article 6.1.c — Obligation légale** : respect du droit d'opposition art. 21 RGPD.

## Personnes concernées

Toute personne physique (qu'elle soit prospect en base, abonné, ou tiers) souhaitant exercer son droit d'opposition à la prospection MovUP.

## Catégories de données traitées

| Catégorie | Champs | Provenance |
|---|---|---|
| Identifiant en clair (éphémère) | Email saisi dans le formulaire, traité en mémoire le temps du hash, jamais persisté en clair | Saisie utilisateur sur `/optout` |
| Identifiant hashé (persistant) | Hash SHA-256 de l'email normalisé (`.trim()` + lowercase) | Calculé système |
| Métadonnées de demande | Date de soumission, date de validation par magic link, statut (pending / verified) | Système |
| IP hashée | Hash SHA-256 de l'IP du demandeur (anti-flood, jamais en clair) | Détection système |

## Catégories de destinataires

**Internes** : aucun.

**Sous-traitants** :

- Resend Ireland Ltd — envoi du magic link de vérification (eu-west-1 Dublin)
- SurrealDB Cloud — stockage de la blocklist (AWS eu-west-1 Dublin)

## Transferts hors UE

**Aucun transfert hors UE.**

## Durée de conservation

| Donnée | Durée | Justification |
|---|---|---|
| Identifiant en clair | Mémoire éphémère uniquement, jamais persisté | Minimisation art. 5.1.c |
| Hash SHA-256 (blocklist) | Conservation pérenne | Démonstration art. 5.2 accountability |
| Demandes pending non validées | 24h (expiration du magic link) | Sécurité |
| Logs de demande | 12 mois (anti-fraude) | Sécurité |

## Mesures de sécurité

- Tunnel à deux étapes : soumission + validation magic link signé (24h d'expiration)
- Question logique anti-bot + honeypot (pas de CAPTCHA tiers non-UE)
- Hash SHA-256 systématique des identifiants
- Idempotence UX-level : réponse identique sur clic répété (anti-énumération)
- Rate-limiting 3 demandes / 24h / IP hashée
- Double rempart de filtrage en aval (upstream silencieux + refus dur)
- Propagation instantanée sur base partagée entre tous les abonnés MovUP
- Fail-open : erreur DB interrompt l'enrichissement plutôt que de risquer une inclusion erronée

## Exercice des droits

- **Accès (art. 15)** : sur demande à dpo@movup.io. La personne peut vérifier la présence de son hash en blocklist.
- **Effacement (art. 17)** : la blocklist est en elle-même la mise en œuvre du droit. Une demande de retrait de la blocklist (réintégration dans les bases) est exceptionnelle et traitée au cas par cas.
- **Décision automatisée (art. 22)** : sans objet.

---

# Fiche T5 — Gestion de la facturation et des paiements

## Identification

| Champ | Valeur |
|---|---|
| Identifiant | T5-MOVUP |
| Intitulé | Gestion des paiements, abonnements et facturation |
| Finalité principale | Encaisser les abonnements MovUP, émettre les factures, gérer le cycle de vie de l'abonnement |
| Finalités secondaires | Conservation comptable légale (cf. T8), gestion des incidents de paiement, remboursements |
| Date de mise en œuvre | 1er juin 2026 |

## Base légale (art. 6 RGPD)

- **Article 6.1.b — Exécution d'un contrat** : abonnement MovUP.
- **Article 6.1.c — Obligation légale** : émission de factures conformes (Code commerce, Code général des impôts).

## Personnes concernées

Abonnés MovUP ayant souscrit un plan payant (Démarrage 24€, Activité 34€, Croisière 44€) ou ayant été facturés (paiement à l'usage exceptionnel, remboursement).

## Catégories de données traitées

| Catégorie | Champs | Provenance |
|---|---|---|
| Identité de facturation | Email, nom, prénom, SIRET (capté au 1er devis ou via popup setup) | Saisie utilisateur |
| Adresse de facturation | Adresse postale, ville, code postal, pays | Saisie utilisateur |
| Données de paiement | Token Stripe (jamais le numéro de carte en clair), 4 derniers chiffres de la carte, marque (Visa, Mastercard, etc.) | Stripe (PCI-DSS Level 1) |
| Données d'abonnement | stripe_customer_id, stripe_subscription_id, subscription_status, current_period_end, plan_billing_cycle | Stripe + système |
| Historique transactionnel | Date de paiement, montant, statut, numéro de facture (préfixe MOVUP, sequence à partir de 19) | Système |
| Mentions légales | « TVA non applicable, art. 293 B du CGI. / Benoît Fouquet — SIRET 453 388 456 00031 » sur chaque facture | Système |

**Données de carte bancaire** : So Paradi **ne stocke jamais** les numéros de carte. Le traitement est intégralement sous-traité à Stripe Payments Europe Ltd (certifié PCI-DSS Level 1).

## Catégories de destinataires

**Internes** : aucun.

**Sous-traitants** :

- Stripe Payments Europe Ltd — traitement complet du paiement (Dublin, Irlande)
- SurrealDB Cloud — stockage des références transactionnelles (AWS eu-west-1 Dublin)
- Resend Ireland Ltd — envoi des factures et emails transactionnels (eu-west-1 Dublin)

**Destinataires institutionnels** :

- Administration fiscale française (DGFiP) : factures sur demande, dans le cadre d'un contrôle.

## Transferts hors UE

Stripe Payments Europe Ltd est établi à Dublin. Stripe Inc. (entité mère US) peut accéder aux données dans le cadre du traitement back-end. Ce transfert est encadré par les **clauses contractuelles types** adoptées par la Commission européenne (décision 2021/914) et par les politiques internes Stripe documentées dans son DPA.

## Durée de conservation

| Donnée | Durée | Justification |
|---|---|---|
| Données de paiement actives | Durée de l'abonnement | Article 6.1.b |
| Factures et écritures comptables | 10 ans | Code de commerce art. L123-22 |
| Historique transactionnel Stripe | Selon politique Stripe (généralement 7 ans minimum) | Stripe DPA |

## Mesures de sécurité

- Aucun stockage de carte bancaire chez So Paradi (PCI-DSS scope = zéro)
- Webhook Stripe signé vérifié par `STRIPE_WEBHOOK_SECRET`
- Idempotence Stripe (table dédiée pour éviter double traitement)
- 4 événements Stripe whitelistés : `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`
- Customer Portal Stripe pour la gestion des moyens de paiement et résiliations
- Pré-check SIRET avec autocomplete SIRENE pour les comptes Activité et Croisière
- Factures émises au format PDF, séquence numérique continue (préfixe MOVUP)

## Exercice des droits

- **Accès (art. 15)** : sur demande à dpo@movup.io, et directement via Customer Portal Stripe.
- **Rectification (art. 16)** : via interface utilisateur ou DPO. Données de carte modifiables via Customer Portal.
- **Effacement (art. 17)** : suppression du compte respecte la conservation comptable légale (10 ans).
- **Portabilité (art. 20)** : export disponible via Customer Portal Stripe + export JSON MovUP.

---

# Fiche T6 — Support utilisateur et communications transactionnelles

## Identification

| Champ | Valeur |
|---|---|
| Identifiant | T6-MOVUP |
| Intitulé | Support utilisateur et envoi de communications transactionnelles |
| Finalité principale | Répondre aux demandes d'assistance des abonnés, envoyer les emails transactionnels nécessaires à l'exécution du contrat |
| Finalités secondaires | Welcome email à l'inscription, confirmation OAuth, accusé de réception opt-out, notifications de cycle de vie compte |
| Date de mise en œuvre | 1er juin 2026 |

## Base légale (art. 6 RGPD)

**Article 6.1.b — Exécution d'un contrat** (communications nécessaires au service MovUP).

## Personnes concernées

Abonnés MovUP, prospects ayant initié une demande d'opt-out, toute personne ayant écrit à support@movup.io ou dpo@movup.io.

## Catégories de données traitées

| Catégorie | Champs | Provenance |
|---|---|---|
| Identification | Email, nom, prénom | Saisie utilisateur |
| Contenu de la demande | Texte libre, pièces jointes éventuelles | Saisie utilisateur |
| Métadonnées de support | Date de demande, statut, date de résolution | Système |

## Catégories de destinataires

**Internes** : aucun (responsable de traitement = entreprise individuelle solo).

**Sous-traitants** :

- Resend Ireland Ltd — envoi des emails (eu-west-1 Dublin)
- Google Ireland Ltd — boîte de réception Workspace bonjour@movup.io et ses 4 alias (contact@, dpo@, noreply@, support@)
- Gandi SAS — registrar et gestion DNS (Paris, France)

## Transferts hors UE

**Aucun transfert hors UE** (Google Workspace contractualisé sur entité Ireland Ltd).

## Durée de conservation

| Donnée | Durée |
|---|---|
| Échanges de support liés au compte | Durée de la relation + 3 ans après clôture (preuve) |
| Boîte support (Google Workspace) | Selon politique de rétention (purge manuelle annuelle) |

## Mesures de sécurité

- Domaine `movup.io` configuré avec SPF, DKIM, DMARC
- Resend en mode warming progressif (14 jours minimum)
- 5 templates Resend distincts : optout-verify, optout-acknowledged, optout-internal-notification, account-deletion-scheduled, account-deletion-confirmed (+ welcome OAuth)
- Authentification 2FA Google Workspace
- Pas de transfert ni d'archivage tiers des emails support

## Exercice des droits

- **Accès (art. 15)** : sur demande à dpo@movup.io, restitution des échanges.
- **Effacement (art. 17)** : suppression sur demande, sauf pour les échanges nécessaires à la conservation de preuves contractuelles.

---

# Fiche T7 — Sécurité et journalisation technique (logs)

## Identification

| Champ | Valeur |
|---|---|
| Identifiant | T7-MOVUP |
| Intitulé | Journalisation technique à fin de sécurité, audit et anti-fraude |
| Finalité principale | Détecter les incidents de sécurité, prévenir les abus, assurer la traçabilité technique |
| Finalités secondaires | Diagnostic des incidents techniques, optimisation performance |
| Date de mise en œuvre | 1er juin 2026 |

## Base légale (art. 6 RGPD)

**Article 6.1.f — Intérêt légitime** : sécurité du système et prévention de la fraude. Considérant 49 RGPD : la sécurité du réseau et de l'information constitue un intérêt légitime du responsable de traitement.

## Personnes concernées

Toute personne accédant au service MovUP (abonnés authentifiés, visiteurs anonymes, requêtes API).

## Catégories de données traitées

| Catégorie | Champs |
|---|---|
| Logs HTTP | URL, méthode, code de réponse, timestamp, latence |
| Logs d'authentification | Tentatives de connexion (succès / échec), userId associé |
| IP | Hashée SHA-256, jamais stockée en clair |
| User-Agent | Stocké en clair (information technique non personnelle isolément) |
| Logs applicatifs | Erreurs, exceptions, alertes de purge, alertes blocklist |
| Logs cron | Exécutions des batchs quotidiens (purge, footer, etc.) |

## Catégories de destinataires

**Internes** : aucun.

**Sous-traitants** :

- Railway Inc. — agrégation et conservation des logs applicatifs (europe-west4)

## Transferts hors UE

**Aucun transfert hors UE.**

## Durée de conservation

| Donnée | Durée |
|---|---|
| Logs applicatifs Railway | 12 mois |
| Logs d'authentification | 12 mois |
| Logs cron | 12 mois |
| Logs d'erreur | 12 mois |

## Mesures de sécurité

- IP systématiquement hashée
- Pas de log de données métier sensibles (jamais le contenu des fiches prospects, jamais les tokens OAuth)
- Accès aux logs limité au responsable de traitement
- Rotation automatique Railway

## Exercice des droits

- **Accès (art. 15)** : sur demande à dpo@movup.io.
- **Effacement (art. 17)** : difficilement applicable aux logs techniques agrégés ; les logs concernant un utilisateur identifié sont anonymisés à la suppression du compte.

---

# Fiche T8 — Conservation des archives comptables

## Identification

| Champ | Valeur |
|---|---|
| Identifiant | T8-MOVUP |
| Intitulé | Conservation des archives comptables (factures, écritures, frais) |
| Finalité principale | Respect de l'obligation légale de conservation des documents comptables |
| Finalités secondaires | Réponse aux contrôles fiscaux et sociaux |
| Date de mise en œuvre | 1er juin 2026 |

## Base légale (art. 6 RGPD)

**Article 6.1.c — Obligation légale** : article L123-22 du Code de commerce (conservation des documents et pièces comptables pendant 10 ans).

## Personnes concernées

Abonnés ayant été facturés, ainsi que les éventuelles contreparties commerciales du responsable de traitement.

## Catégories de données traitées

| Catégorie | Champs |
|---|---|
| Identité de facturation | Email, nom, prénom, SIRET, adresse |
| Données de transaction | Date, montant, plan, numéro de facture, statut paiement |
| Écritures comptables | Recettes, frais (frais et frais_recurrents), fichier audit |

## Catégories de destinataires

**Internes** : aucun.

**Sous-traitants** :

- SurrealDB Cloud — stockage (AWS eu-west-1 Dublin)
- Stripe Payments Europe Ltd — données transactionnelles miroir

**Destinataires institutionnels** :

- DGFiP, URSSAF, expert-comptable éventuel — sur demande, dans le cadre d'un contrôle.

## Transferts hors UE

**Aucun transfert hors UE direct.** Transfert Stripe Inc. (US) éventuel encadré par clauses contractuelles types (cf. T5).

## Durée de conservation

**10 ans** à compter de la clôture de l'exercice comptable, conformément à l'article L123-22 du Code de commerce.

**Cas particulier suppression de compte** (art. 17 RGPD) : la suppression hard delete préserve les éléments comptables nécessaires à l'obligation légale. La table audit_log est anonymisée. Les factures et écritures sont conservées tant que l'obligation légale court.

## Mesures de sécurité

- Stockage chiffré SurrealDB Cloud
- Sauvegardes automatiques
- Accès limité au responsable de traitement
- Préservation lors des suppressions de compte (hard delete sélectif)

## Exercice des droits

- **Accès (art. 15)** : sur demande à dpo@movup.io.
- **Effacement (art. 17)** : limité par l'obligation légale 10 ans.
- **Rectification (art. 16)** : possible pour les seules données non encore inscrites en comptabilité définitive.

---

## Section finale — Mesures transversales communes à toutes les fiches

Les mesures suivantes s'appliquent **à l'ensemble** des activités de traitement documentées dans le présent registre :

### Sécurité technique transversale

- HTTPS obligatoire sur l'ensemble des routes (HSTS Cloudflare)
- Hébergement européen exclusif (Railway europe-west4, SurrealDB Cloud AWS eu-west-1 Dublin, Resend eu-west-1 Dublin)
- Chiffrement AES-256-GCM des credentials sensibles
- Authentification par middleware `requireAuthHtml` avec whitelist de 14 routes
- Multi-tenant scoping par `userId` sur les 12 pages business
- Sauvegardes automatiques SurrealDB Cloud

### Mesures organisationnelles transversales

- DPO désigné : dpo@movup.io (canal dédié)
- Souveraineté technique : pas de prestataire tiers de scraping ou d'enrichissement commercial (LIA Doctrine 9)
- Pas de transfert commercial des données vers des tiers
- Revue semestrielle du présent registre (prochaine : 1er décembre 2026)
- Documentation associée : LIA-MOVUP-001 v1.1, AIPD-MOVUP-001, CST-MOVUP-001, `docs/PHASE_6_RGPD_COMPLETE.md`

### Procédures en cas de violation (art. 33-34 RGPD)

- Notification à la CNIL sous 72h en cas de violation présentant un risque
- Communication aux personnes concernées sans délai en cas de risque élevé
- Registre interne des violations conservé (art. 33.5)

### Cookies et traceurs

Le présent registre ne couvre pas l'analyse des cookies déposés sur movup.io, graphicfactor.io et nouvellevagu.es. Cette analyse fait l'objet d'un document distinct conforme à la délibération CNIL n°2020-091 du 17 septembre 2020.

---

## Validité, opposabilité et revue

### Validité

Le présent registre est **valide à compter du 1er juin 2026** et demeure valide jusqu'à révision formelle.

### Opposabilité

Le présent registre est **opposable** :

- à toute autorité de contrôle (CNIL en premier lieu, art. 30.4 RGPD : le registre est mis à la disposition de l'autorité de contrôle sur demande),
- à toute personne concernée exerçant ses droits (production des fiches concernant ses traitements),
- à toute juridiction saisie.

### Revue et mise à jour

Revue **semestrielle** systématique (prochaine : 1er décembre 2026).

Revue **exceptionnelle** en cas de :

- ajout, suppression ou modification substantielle d'une activité de traitement,
- changement de sous-traitant,
- transfert de données hors UE non prévu au présent registre,
- évolution réglementaire,
- introduction de fonctionnalités d'IA,
- extension géographique (Belgique, Suisse, Québec).

### Conservation et archivage

Le présent registre et ses versions antérieures sont conservés sans limitation de durée dans `docs/rgpd/` du dépôt source Soparadi/mup, avec horodatage Git.

---

## Signature

Le présent registre est établi sous la responsabilité de Benoît Fouquet, en sa qualité de responsable de traitement, et engage l'entreprise individuelle So Paradi (SIRET 453 388 456 00031).

**Fait à Dinan, le 25 mai 2026**

**Benoît Fouquet**
Responsable de traitement — So Paradi (EI)
SIRET 453 388 456 00031
dpo@movup.io

---

*Document de référence interne — RAT-MOVUP-001 v1.0 — Conformité art. 30 RGPD*
