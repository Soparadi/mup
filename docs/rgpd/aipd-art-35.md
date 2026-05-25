# Analyse d'impact relative à la protection des données — Article 35 RGPD

**Responsable de traitement** : Benoît Fouquet — Entrepreneur Individuel So Paradi
**SIRET** : 453 388 456 00031
**Adresse** : Combourg, Bretagne, France
**Contact DPO** : dpo@movup.io
**Activité concernée** : MovUP — Pipeline management SaaS B2B (movup.io)

**Document** : Analyse d'impact relative à la protection des données (AIPD / DPIA)
**Référence interne** : AIPD-MOVUP-001
**Version** : 1.0
**Date de rédaction** : 25 mai 2026
**Date d'effet** : 1er juin 2026 (lancement commercial MovUP)
**Prochaine revue** : 1er décembre 2026 (revue semestrielle systématique)
**Cadre méthodologique** : Méthode PIA CNIL v4 + Lignes directrices EDPB wp248rev.01 + ISO/IEC 29134:2017

---

## Préambule — Pourquoi cette AIPD

L'article 35 du Règlement (UE) 2016/679 (RGPD) impose au responsable de traitement la réalisation d'une analyse d'impact relative à la protection des données (AIPD) **lorsque le traitement est susceptible d'engendrer un risque élevé pour les droits et libertés des personnes physiques**.

Trois critères croisés (lignes directrices EDPB wp248rev.01) déclenchent l'obligation d'AIPD pour MovUP :

1. **Évaluation ou notation** : qualification commerciale des prospects (intérêt sectoriel, statut SIRENE, scoring de pertinence).
2. **Collecte de données à grande échelle** : traitement potentiel de plusieurs millions de fiches SIRENE actives en France (~4,1 millions d'auto-entrepreneurs).
3. **Croisement de données** : combinaison entre données SIRENE (officielles) et données issues de sites web professionnels (enrichissement par moteur interne).

La doctrine constante de la CNIL (liste des traitements pour lesquels une AIPD est requise, délibération n°2018-327 du 11 octobre 2018) confirme que **la prospection commerciale à grande échelle avec enrichissement** entre dans le champ obligatoire de l'AIPD.

So Paradi a en conséquence rédigé la présente AIPD **préalablement à la mise en œuvre du traitement** (1er juin 2026), conformément à l'article 35.1 RGPD.

Le présent document s'articule avec :

- la balance test intérêt légitime (LIA-MOVUP-001 v1.1) — fondement juridique,
- le registre des activités de traitement (RAT-MOVUP-001 v1.0) — liste des 8 traitements,
- la cartographie des sous-traitants (CST-MOVUP-001 v1.0) — chaîne de sous-traitance,
- le journal technique `docs/PHASE_6_RGPD_COMPLETE.md` (tag git `v1.0.0-rgpd`) — état du système.

Ce document est **opposable** : il peut être produit à la CNIL ou à toute autorité de contrôle compétente.

---

## Section 1 — Description générale du traitement

### 1.1 Vue d'ensemble

**MovUP** est un SaaS de gestion de pipeline commercial conçu pour les auto-entrepreneurs francophones. Il couvre le cycle complet de la prospection à la facturation : Lead → Carte terrain → Pipeline → Mail → Visio → Devis → Facture → Statistiques.

Deux activités de traitement sont visées par la présente AIPD au titre de leur caractère susceptible d'engendrer un risque élevé :

- **T2** — Prospection commerciale par cold mail (utilisée par Ben pour acquisition des Founders #001-100, et **mise à disposition des abonnés MovUP** pour leur propre prospection).
- **T3** — Enrichissement de fiches prospects par moteur de recherche interne.

Les autres traitements (T1 comptes, T4 opt-out, T5 facturation, T6 support, T7 logs, T8 archives) ne franchissent pas le seuil de risque élevé au sens de l'article 35 RGPD et ne sont pas couverts par la présente AIPD.

### 1.2 Périmètre fonctionnel détaillé

**Collecte initiale** (sans risque élevé en soi, mais documentée par cohérence) :

- Consultation de l'API recherche-entreprises Etalab (publique).
- Consultation de l'API SIRENE INSEE V3 (authentification OAuth2 directe).
- Géocodage des adresses via API BAN data.gouv.fr.
- **Filtrage du champ `statut_diffusion`** (à intégrer avant lancement) — exclusion des entrepreneurs ayant exercé leur droit d'opposition à la diffusion auprès de l'INSEE.
- Filtrage en amont des fiches en blocklist opt-out (anti-revelation).

**Enrichissement par moteur de recherche interne** (T3) :

- Pour chaque entreprise SIRENE identifiée, consultation de son site web officiel et de ses pages de mentions légales / contact.
- Extraction par expression régulière de : email professionnel générique (`contact@`, `info@`, `commercial@`, `bonjour@`, `hello@`), téléphone, URL réseaux sociaux entreprise.
- Application des **5 lignes rouges** (Doctrine 10 LIA) : rejet email nominatif, refus LinkedIn et réseaux personnels, séparation cache mutualisé / notes privées, expiration 24 mois, propagation instantanée opt-out.
- Respect du fichier robots.txt de chaque domaine.
- Plafond opérationnel ~500 fiches/jour.

**Stockage** :

- Cache mutualisé `company_public` partagé entre abonnés MovUP (données publiques entreprise uniquement).
- Notes privées `company_enrichment_user` par abonné (commentaires commerciaux personnels, jamais partagés).
- Hébergement SurrealDB Cloud AWS eu-west-1 Dublin.

**Envoi de communications de prospection** (T2) :

- Cold mail via prestataire Resend (eu-west-1 Dublin).
- Footer art. 14 injecté côté serveur sur chaque envoi (anti-bypass DOM).
- Lien opt-out personnalisé par destinataire.
- Plafond Ben en propre : ~25 envois/jour (croissance progressive maîtrisée).
- Les abonnés MovUP utilisent leur propre boîte (OAuth Gmail ou IMAP) pour leur prospection — limites de volume tributaires de leur propre fournisseur.

**Gestion du droit d'opposition** :

- Tunnel `/optout` à deux étapes (formulaire + magic link signé 24h).
- Hash SHA-256 des identifiants en blocklist.
- Propagation instantanée sur la base partagée.
- Double rempart de filtrage en aval.

### 1.3 Acteurs

| Rôle | Identité |
|---|---|
| Responsable de traitement | Benoît Fouquet — EI So Paradi |
| DPO (cumulé de facto) | Benoît Fouquet — dpo@movup.io |
| Sous-traitants | 9 sous-traitants documentés dans CST-MOVUP-001 v1.0 |
| Personnes concernées | Prospects professionnels indépendants francophones |
| Bénéficiaires | Abonnés MovUP (utilisateurs du service) |

### 1.4 Bases légales

- **T2 (prospection cold mail)** : article 6.1.f RGPD — intérêt légitime (LIA-MOVUP-001 v1.1).
- **T3 (enrichissement)** : article 6.1.f RGPD — intérêt légitime (LIA-MOVUP-001 v1.1).

### 1.5 Volumétrie attendue

**Données collectées (T3, base mutualisée)** :

- Phase de démarrage (M+1 à M+6) : ~10 000 à ~50 000 fiches enrichies cumulées.
- Phase de croisière (M+12) : ~100 000 à ~300 000 fiches enrichies cumulées (en fonction du nombre d'abonnés).
- Plafond théorique : ~4 100 000 fiches (population auto-entrepreneurs France URSSAF T4 2024).

**Données envoyées (T2, prospection Ben)** :

- Phase de démarrage : ~25 emails/jour × 25 jours ouvrés = ~625 envois/mois.
- Cible Founders #001-100 : ~3 000 envois cumulés sur 4 mois (juin à septembre 2026).

**Données envoyées (T2, prospection abonnés)** : tributaire de chaque abonné, plafonnée par les quotas du produit (30/120/illimités prospects actifs) et par les limites de leur propre fournisseur email.

### 1.6 Durées de conservation

(Cf. RAT-MOVUP-001 Sections T2 et T3)

| Donnée | Durée |
|---|---|
| Prospect non contacté | 3 ans à compter de la collecte |
| Prospect contacté sans réponse | 3 ans à compter du dernier contact |
| Données enrichies par moteur interne | 24 mois à compter de la dernière mise à jour |
| Prospect ayant exercé son droit d'opposition (hash) | Conservation pérenne |
| Historique des envois | 3 ans |

---

## Section 2 — Évaluation de la nécessité et de la proportionnalité

### 2.1 Caractère licite, déterminé et explicite de la finalité

La finalité est **licite, déterminée et explicite** au sens de l'article 5.1.b RGPD. Démonstration détaillée dans LIA-MOVUP-001 v1.1, Section 1.3.

**Synthèse** :

- **Licéité** : prospection B2B fondée sur intérêt légitime (art. 6.1.f), considérant 47 RGPD, doctrine constante CNIL.
- **Détermination** : prise de contact commerciale initiale, qualification, conversion. Exclusion explicite de toute autre exploitation (revente, profilage automatisé, transferts hors finalité).
- **Explicite** : la finalité est communiquée à chaque destinataire dans le footer art. 14 de chaque envoi.

### 2.2 Données adéquates, pertinentes et limitées (minimisation art. 5.1.c)

| Mesure | Effectivité |
|---|---|
| Données issues de sources publiques uniquement | Effective — SIRENE, mentions légales LCEN, BAN |
| Exclusion email nominatif | Effective — filtre regex `[a-z]+\.[a-z]+@` à l'écriture |
| Exclusion LinkedIn et réseaux personnels | Effective — Doctrine 10 LIA Ligne rouge n°2 |
| Exclusion catégories particulières (art. 9 et 10) | Effective — par construction, non collectées |
| Hachage SHA-256 des identifiants opt-out | Effective — code Phase 6 Étape 4 (commit `3e1e07b`) |
| IP hashée dans les logs | Effective — pas de stockage IP en clair |
| Suppression champ « motif » formulaire opt-out | Effective — Phase 6 |
| Plafond quotidien moteur ~500 fiches/jour | Effective — paramétré dans le cron |
| Quotas commerciaux produits (30/120/illimités) | Effective — limites mécaniques par plan |

**Évaluation** : minimisation effective et documentée.

### 2.3 Exactitude (art. 5.1.d)

| Mesure | Effectivité |
|---|---|
| Mise à jour des fiches par re-vérification 24 mois | Effective — Doctrine 10 Ligne rouge n°4 |
| Métadonnées source + horodatage par champ | Effective — fiches enrichies tracent leur origine |
| Droit de rectification (art. 16) | Effective — canal DPO dpo@movup.io |
| Statut SIRENE actif/radié/liquidation | Effective — consulté à chaque envoi |

**Évaluation** : exactitude assurée par les processus de mise à jour et le respect du droit de rectification.

### 2.4 Durées de conservation limitées (art. 5.1.e)

Durées explicitement définies, justifiées et opérationnelles (cf. Section 1.6 et RAT-MOVUP-001).

**Évaluation** : limitation effective et documentée.

### 2.5 Information des personnes concernées (art. 13 et 14)

| Mesure | Effectivité |
|---|---|
| Footer art. 14 sur chaque envoi | Effective — injection serveur (anti-bypass DOM), helper `buildColdMailFooter` |
| Pré-check SIRET avec autocomplete SIRENE | Effective — Phase 6 Étape 14 (commit `62e2c0e`) |
| Pages publiques d'information (/optout, /mentions-legales, /confidentialite, /cookies) | Effective — Phase 6 Étape 7 (commit `501f197`) |
| Mention de la base légale art. 6.1.f dans le footer | Effective — wording verbatim acté |
| Identification du responsable de traitement | Effective — nom, SIRET, adresse |
| Mention du canal DPO | Effective — dpo@movup.io |
| Pré-remplissage `/optout?from=&email=` | Effective — Phase 6 Étape 8 |

**Évaluation** : information complète et documentée.

### 2.6 Recueil du consentement (le cas échéant)

Le traitement étant fondé sur l'article 6.1.f (intérêt légitime), aucun consentement préalable n'est requis pour la prospection B2B. Le **droit d'opposition** (art. 21) constitue la garantie équivalente.

### 2.7 Exercice des droits

| Droit | Modalité | Délai |
|---|---|---|
| Accès (art. 15) | dpo@movup.io | 1 mois |
| Rectification (art. 16) | dpo@movup.io ou interface | 1 mois |
| Effacement (art. 17) | dpo@movup.io ou `/account/privacy` ou `/optout` | 1 mois |
| Limitation (art. 18) | dpo@movup.io | 1 mois |
| Portabilité (art. 20) | `/account/privacy` (export JSON, à vie) | Immédiat |
| Opposition (art. 21) | `/optout` (tunnel public, magic link 24h) | < 24h |
| Décision automatisée (art. 22) | Sans objet | — |

**Évaluation** : droits effectivement exerçables, documentés, opérationnels.

### 2.8 Sous-traitants et chaîne de responsabilité

9 sous-traitants documentés dans CST-MOVUP-001 v1.0. Hébergement européen exclusif (sauf S8 ipapi en cours de substitution).

**Aucun prestataire tiers de scraping ni d'enrichissement commercial** (Doctrine 9 LIA — Souveraineté technique).

**Évaluation** : chaîne de sous-traitance maîtrisée et documentée.

### 2.9 Transferts hors UE

- **S3 Stripe** : transferts vers Stripe Inc. US encadrés par clauses contractuelles types 2021/914 + adhésion DPF.
- **S5 Google** : transferts vers Google LLC US encadrés par CCT + DPF.
- **S6 Cloudflare** : réseau anycast mondial encadré par CCT + DPF.
- **S8 ipapi (à substituer)** : seul transfert hors UE non strictement encadré à la date d'effet → substitution par MaxMind GeoLite2 self-hosted en V1.0.x.

**Évaluation** : transferts maîtrisés sauf S8 (action de mitigation programmée).

---

## Section 3 — Évaluation des risques pour les personnes concernées

Cette section identifie les risques redoutés, leur gravité et leur vraisemblance, conformément à la méthode PIA CNIL v4.

### 3.1 Méthodologie d'évaluation

Chaque risque est évalué selon deux axes :

- **Gravité** (1 négligeable / 2 limitée / 3 importante / 4 maximale)
- **Vraisemblance** (1 négligeable / 2 limitée / 3 importante / 4 maximale)

Le **niveau de risque résiduel** (après mesures protectrices) est qualifié de :

- **Faible** : gravité × vraisemblance ≤ 4
- **Modéré** : gravité × vraisemblance entre 5 et 9
- **Élevé** : gravité × vraisemblance ≥ 10

### 3.2 Risques identifiés et évalués

#### Risque R1 — Accès illégitime aux données par un tiers (cyber-attaque)

**Description** : un attaquant externe accède à la base de données MovUP (cache mutualisé `company_public`, comptes utilisateurs, données comptables) par exploitation d'une vulnérabilité.

**Impact potentiel** :
- Divulgation des coordonnées professionnelles enrichies (publiquement disponibles par ailleurs, mais agrégées = valeur ajoutée pour spammeurs).
- Divulgation des notes commerciales privées des abonnés (rupture de confidentialité).
- Atteinte à la réputation de MovUP et de So Paradi.

**Sources de risque** :
- Vulnérabilité applicative (faille de code, injection SQL, XSS).
- Fuite de credentials (tokens API, secrets Stripe/Resend/Google).
- Compromission d'un compte administrateur.
- Compromission d'un sous-traitant (Railway, SurrealDB Cloud, Stripe).

**Mesures existantes** :
- HTTPS obligatoire (HSTS Cloudflare).
- Authentification par middleware `requireAuthHtml` avec whitelist explicite.
- Multi-tenant scoping par `userId` sur toutes les routes business.
- Chiffrement AES-256-GCM des tokens OAuth.
- Hash bcrypt (coût ≥ 12) des mots de passe.
- Webhook Stripe signé (`STRIPE_WEBHOOK_SECRET`).
- Idempotence Stripe (table dédiée).
- Sauvegardes automatiques SurrealDB Cloud.
- Sous-traitants certifiés (Stripe PCI-DSS Level 1, Google ISO 27001/27018, Cloudflare ISO 27001, SurrealDB chiffrement AES-256 au repos).

**Gravité** : 3 (importante — notes commerciales privées sont sensibles, données publiques agrégées ont une valeur)
**Vraisemblance** : 2 (limitée — mesures techniques solides, surface d'attaque limitée pour un solo founder)
**Niveau de risque résiduel** : **Modéré (6)**

**Mesures complémentaires recommandées** :
- M1.1 — Audit de sécurité par tiers (post-Phase 6-bis avocat, financé par CA premiers abonnés).
- M1.2 — Monitoring d'alertes Railway + SurrealDB Cloud (logs d'accès anormaux).
- M1.3 — Rotation périodique des secrets (Stripe webhook, Resend API, Google OAuth).

#### Risque R2 — Sollicitation non désirée d'une personne ayant exercé son droit d'opposition

**Description** : malgré l'opt-out, une personne reçoit un email de prospection MovUP ou figure dans une fiche enrichie par le moteur.

**Impact potentiel** :
- Atteinte au droit d'opposition (art. 21 RGPD).
- Grief direct, possible plainte CNIL.
- Atteinte à la réputation de MovUP.

**Sources de risque** :
- Bug du filtre opt-out upstream (`/api/search` et `/api/sirene/search`).
- Désynchronisation entre blocklist et cache mutualisé.
- Erreur de la base de données blocklist non détectée.
- Insertion forgée par requête malveillante contournant le filtre.
- Hash SHA-256 collision (probabilité négligeable).

**Mesures existantes** :
- **Double rempart de filtrage** (Doctrine 1 LIA) : upstream silencieux + refus dur 403 en aval.
- **Propagation instantanée** sur base partagée (Doctrine 10 Ligne rouge n°5).
- **Fail-open** assumé en faveur des personnes concernées (Doctrine 2 LIA) : toute erreur DB interrompt l'enrichissement.
- Hash SHA-256 systématique avec normalisation `.trim()`.
- Test runtime à valider (Étape 8 Phase 6, pending validation hotspot iPhone).
- Logs d'alerte sur erreurs blocklist.

**Gravité** : 3 (importante — grief direct, exposition CNIL)
**Vraisemblance** : 2 (limitée — double rempart + fail-open)
**Niveau de risque résiduel** : **Modéré (6)**

**Mesures complémentaires recommandées** :
- M2.1 — Validation runtime complète du tunnel opt-out (Étape 8 pending) avant lancement.
- M2.2 — Monitoring du taux de fail-open (alerte si >0).
- M2.3 — Test périodique semestriel du double rempart avec compte de test dédié.

#### Risque R3 — Détournement des données enrichies par un abonné MovUP

**Description** : un abonné MovUP exporte les fiches enrichies (via export CSV plan Activité/Croisière) et les utilise hors finalité MovUP (revente, prospection abusive, transfert à un tiers).

**Impact potentiel** :
- Détournement de finalité.
- Multiplication des sollicitations sur les personnes concernées.
- Responsabilité conjointe potentielle de So Paradi.

**Sources de risque** :
- CGU MovUP non respectées par un abonné mal intentionné.
- Absence de mécanisme technique empêchant l'export massif.

**Mesures existantes** :
- CGU MovUP encadrant l'usage (à renforcer Phase 6-bis avocat).
- Quotas commerciaux produits (30/120/illimités prospects actifs) limitant le volume.
- Export CSV réservé aux plans payants (Activité et Croisière) — pas en plan Démarrage ni en essai.
- Audit log conservé pour traçabilité.

**Gravité** : 3 (importante — atteinte aux droits des personnes)
**Vraisemblance** : 2 (limitée — auto-entrepreneurs solo, faible incitation au détournement massif)
**Niveau de risque résiduel** : **Modéré (6)**

**Mesures complémentaires recommandées** :
- M3.1 — Renforcement de la clause d'usage des données dans les CGV/CGU (Phase 6-bis avocat).
- M3.2 — Détection comportementale d'export massif (alerte si export CSV > N fiches dans une fenêtre temporelle).
- M3.3 — Possibilité de suspension de compte en cas d'usage abusif documenté.

#### Risque R4 — Mauvaise qualification d'un contact (faux email nominatif passé à travers le filtre)

**Description** : un email nominatif type `prenom.nom@` échappe au filtre regex (variante non couverte) et est inséré dans la base.

**Impact potentiel** :
- Sollicitation d'une personne identifiée nominativement.
- Atteinte à la vie privée professionnelle.
- Grief possible.

**Sources de risque** :
- Variantes regex non couvertes (ex. `prenom-nom@`, `pnom@`, `prenom_nom@`, accents).
- Email générique mal classé (ex. `direction@` souvent associé à une personne unique en EI).

**Mesures existantes** :
- Filtre regex `[a-z]+\.[a-z]+@` (Doctrine 10 Ligne rouge n°1).
- Doctrine bon père de famille : rejet silencieux par défaut.

**Gravité** : 2 (limitée — pas de divulgation de données privées, juste sollicitation non souhaitée)
**Vraisemblance** : 3 (importante — variantes regex possibles non couvertes initialement)
**Niveau de risque résiduel** : **Modéré (6)**

**Mesures complémentaires recommandées** :
- M4.1 — Élargir le filtre regex pour couvrir variantes courantes (`-`, `_`, sans séparateur clair).
- M4.2 — Audit trimestriel par échantillonnage des emails effectivement insérés (vérification manuelle ~50 fiches).
- M4.3 — Réflexion sur l'exclusion de certains préfixes (`direction@`, `gerant@`, `patron@`) souvent associés à une personne unique en EI.

#### Risque R5 — Atteinte à la disponibilité du tunnel opt-out

**Description** : le service `/optout` ou le système d'envoi du magic link est indisponible, empêchant une personne d'exercer son droit d'opposition.

**Impact potentiel** :
- Atteinte effective au droit d'opposition.
- Grief direct, possible plainte CNIL.

**Sources de risque** :
- Indisponibilité Railway (hébergement applicatif).
- Indisponibilité Resend (envoi du magic link).
- Indisponibilité SurrealDB Cloud (stockage de la demande).
- Erreur applicative du tunnel.

**Mesures existantes** :
- Cloudflare en frontal (résilience CDN).
- SurrealDB Cloud avec haute disponibilité.
- Resend avec SLA standard.
- Page `/optout` en front pur (HTML statique, peu sensible aux pannes back-end).
- Soumission peut être renouvelée à tout moment.

**Gravité** : 2 (limitée — délai d'opt-out 24h tolère un retard mineur)
**Vraisemblance** : 2 (limitée — SLA sous-traitants standards)
**Niveau de risque résiduel** : **Faible (4)**

**Mesures complémentaires recommandées** :
- M5.1 — Canal alternatif documenté : email dpo@movup.io comme voie de secours en cas d'indisponibilité du tunnel.

#### Risque R6 — Conservation excessive des données

**Description** : les données enrichies ou les hash opt-out sont conservés au-delà des durées légitimes.

**Impact potentiel** :
- Violation de l'article 5.1.e RGPD.
- Données obsolètes pouvant nuire à l'exactitude (R7).

**Sources de risque** :
- Cron de purge défaillant.
- Mauvaise configuration des durées.

**Mesures existantes** :
- Cron quotidien de purge 30 jours post grace_expired (`2d265d1`).
- Expiration automatique 24 mois des données enrichies (Doctrine 10 Ligne rouge n°4) — **à implémenter** (cron de re-vérification ou de purge).
- Durées de conservation explicitement documentées (RAT-MOVUP-001).

**Gravité** : 1 (négligeable — pas d'impact direct sur les personnes, atteinte formelle au RGPD)
**Vraisemblance** : 3 (importante — la mécanique d'expiration 24 mois des données enrichies n'est pas encore codée à la date d'effet)
**Niveau de risque résiduel** : **Modéré (5)**

**Mesures complémentaires recommandées** :
- M6.1 — Implémenter le cron d'expiration 24 mois des données enrichies (V1.0.x, semaine 1-2 post-lancement).
- M6.2 — Monitoring du cron de purge (alerte si non-exécution).
- M6.3 — Audit semestriel des durées effectives (échantillonnage).

#### Risque R7 — Exactitude défaillante des données enrichies

**Description** : une fiche enrichie contient des données obsolètes (entreprise radiée non détectée, email plus actif, téléphone changé) entraînant des sollicitations erronées.

**Impact potentiel** :
- Sollicitations sans pertinence.
- Mauvaise image de marque.
- Risque d'erreur sur l'identité de la cible.

**Sources de risque** :
- Re-vérification 24 mois trop espacée.
- Données SIRENE non mises à jour en temps réel (statut radié/liquidation).

**Mesures existantes** :
- Consultation du statut SIRENE actif à chaque envoi (Doctrine T2).
- Re-vérification 24 mois maximum.
- Métadonnées source + horodatage par champ.

**Gravité** : 1 (négligeable — désagrément, pas atteinte aux droits)
**Vraisemblance** : 3 (importante — données web par nature volatiles)
**Niveau de risque résiduel** : **Modéré (5)**

**Mesures complémentaires recommandées** :
- M7.1 — Fréquence de re-vérification accélérée pour les fiches enrichies les plus consultées (12 mois au lieu de 24 mois pour le top 10 % en interactions).
- M7.2 — Mécanisme de signalement par les abonnés (bouton « fiche obsolète »).

#### Risque R8 — Détournement de la fonction d'enrichissement à des fins de stalking ou de surveillance ciblée

**Description** : un abonné MovUP utilise la fonction d'enrichissement et la consultation de fiches pour traquer une personne spécifique en dehors de la finalité commerciale légitime.

**Impact potentiel** :
- Atteinte grave à la vie privée d'une personne ciblée.
- Risque réputationnel majeur pour MovUP.
- Responsabilité conjointe possible.

**Sources de risque** :
- Absence de mécanisme empêchant la consultation ciblée d'une personne précise.
- Anonymat relatif de l'abonné dans l'utilisation de la fonction recherche.

**Mesures existantes** :
- Quotas commerciaux limitant le volume de consultations.
- Audit log conservé pour traçabilité.
- CGU encadrant l'usage commercial uniquement.
- Restriction aux données B2B publiques (pas de données privées dans la base).
- Architecture base mutualisée : seules les données B2B sont partagées entre abonnés, les notes privées de chaque abonné restent privées.

**Gravité** : 4 (maximale — atteinte à la vie privée, risque de harcèlement)
**Vraisemblance** : 1 (négligeable — auto-entrepreneurs solo en prospection B2B, cible improbable pour stalking, données B2B publiques par nature)
**Niveau de risque résiduel** : **Faible (4)**

**Mesures complémentaires recommandées** :
- M8.1 — Détection comportementale : alerte si un abonné consulte la même fiche de manière anormalement répétée.
- M8.2 — Renforcement CGU avec clause anti-stalking explicite (Phase 6-bis avocat).
- M8.3 — Procédure de suspension de compte en cas de suspicion documentée.

#### Risque R9 — Non-conformité des sources mentions légales LCEN

**Description** : un site web professionnel publie des mentions légales non conformes (faux nom, fausse adresse, données d'un tiers usurpé). L'enrichissement collecte de fausses données ou des données rattachées à une mauvaise personne.

**Impact potentiel** :
- Atteinte à une personne non concernée (usurpation d'identité tierce).
- Difficulté à exercer ses droits pour la personne réellement affectée.

**Sources de risque** :
- Fraude amont sur le site source.
- Erreur de publication.

**Mesures existantes** :
- Croisement avec SIRENE (correspondance dénomination/SIRET).
- Statut SIRENE actif vérifié.
- Droit de rectification et d'opposition exerçables.

**Gravité** : 2 (limitée — situation rare, droit de rectification disponible)
**Vraisemblance** : 1 (négligeable — fraude amont rare, croisement SIRENE filtre la plupart des cas)
**Niveau de risque résiduel** : **Faible (2)**

**Mesures complémentaires recommandées** :
- Aucune mesure complémentaire spécifique. Le risque est inhérent et résiduel.

#### Risque R10 — Saturation par flood de demandes opt-out

**Description** : une attaque par flood envoie massivement des demandes opt-out (avec des emails arbitraires), saturant Resend (envois magic link) et la base de données.

**Impact potentiel** :
- Indisponibilité du service.
- Coût Resend accru.
- Pollution de la base avec des demandes pending non validées.

**Sources de risque** :
- Bot malveillant.
- Concurrent souhaitant nuire.

**Mesures existantes** :
- Rate-limiting 3 demandes opt-out / 24h / IP hashée.
- Honeypot + question logique anti-bot.
- Idempotence UX-level.
- Expiration 24h des demandes pending.

**Gravité** : 1 (négligeable — pas d'impact sur les droits des personnes, simple coût opérationnel)
**Vraisemblance** : 2 (limitée — mesures anti-flood en place)
**Niveau de risque résiduel** : **Faible (2)**

**Mesures complémentaires recommandées** :
- M10.1 — Monitoring du taux de demandes opt-out / heure (alerte si pic anormal).

### 3.3 Synthèse de l'évaluation des risques

| Risque | Gravité | Vraisemblance | Niveau résiduel |
|---|---|---|---|
| R1 — Accès illégitime (cyber-attaque) | 3 | 2 | **Modéré (6)** |
| R2 — Sollicitation post opt-out | 3 | 2 | **Modéré (6)** |
| R3 — Détournement par abonné | 3 | 2 | **Modéré (6)** |
| R4 — Faux email nominatif passé filtre | 2 | 3 | **Modéré (6)** |
| R5 — Indisponibilité tunnel opt-out | 2 | 2 | **Faible (4)** |
| R6 — Conservation excessive | 1 | 3 | **Modéré (5)** |
| R7 — Exactitude défaillante | 1 | 3 | **Modéré (5)** |
| R8 — Détournement stalking | 4 | 1 | **Faible (4)** |
| R9 — Mentions légales frauduleuses | 2 | 1 | **Faible (2)** |
| R10 — Flood demandes opt-out | 1 | 2 | **Faible (2)** |

**Aucun risque résiduel n'atteint le niveau « Élevé »** (≥ 10) après application des mesures protectrices. Cinq risques sont qualifiés de **Modéré**, cinq de **Faible**.

### 3.4 Conclusion sur l'acceptabilité du risque

À l'issue de l'évaluation, le niveau de risque résiduel global est **acceptable** au sens de l'article 35 RGPD :

- Aucun risque ne dépasse le seuil « Élevé ».
- Les risques « Modéré » sont assortis de mesures complémentaires programmées (M1.1 à M7.2).
- L'arbitrage gravité × vraisemblance fait apparaître que les risques de gravité maximale (R8 stalking) ont une vraisemblance négligeable, et que les risques de vraisemblance importante (R4, R6, R7) ont une gravité limitée à négligeable.

**Conclusion** : So Paradi peut **mettre en œuvre le traitement** sans consultation préalable de la CNIL (art. 36 RGPD), sous réserve de l'application effective des mesures complémentaires programmées.

---

## Section 4 — Plan d'action consolidé

Cette section consolide les **mesures complémentaires** identifiées dans la Section 3, classées par échéance et priorité.

### 4.1 Mesures à fermer avant le 1er juin 2026 (lancement commercial)

| Référence | Mesure | Effort | Source |
|---|---|---|---|
| M2.1 | Validation runtime complète Étape 8 tunnel opt-out (hotspot iPhone) | 15 min | R2 |
| Pre-lancement-1 | Audit champ `statut_diffusion` SIRENE et intégration au filtre amont | ~1h | Audit balance test + AIPD |
| Pre-lancement-2 | Contre-signature DPA Railway, SurrealDB Cloud, Resend | ~30 min | CST-MOVUP-001 |
| Pre-lancement-3 | Test runtime Stripe Live carte Ben (24€ + remboursement Customer Portal) | 30-45 min | RAT-MOVUP-001 T5 |

**Total** : ~2h30 cumulées avant lancement.

### 4.2 Mesures à fermer en V1.0.x (semaine 1-2 post-lancement)

| Référence | Mesure | Effort | Source |
|---|---|---|---|
| M6.1 | Implémenter cron expiration 24 mois données enrichies | ~2h | R6 |
| M6.2 | Monitoring du cron de purge (alerte si non-exécution) | ~1h | R6 |
| M5.1 | Documentation du canal alternatif dpo@movup.io en cas d'indisponibilité tunnel | 30 min | R5 |
| CST-S8 | Substitution ipapi par MaxMind GeoLite2 self-hosted | ~3h | CST-MOVUP-001 S8 |
| M4.1 | Élargir filtre regex anti-email nominatif (variantes `-`, `_`) | ~1h | R4 |
| M10.1 | Monitoring du taux de demandes opt-out / heure | ~1h | R10 |

**Total** : ~8h cumulées sur 1-2 semaines post-lancement.

### 4.3 Mesures à fermer en V1.1 (M+1 à M+3 post-lancement)

| Référence | Mesure | Effort | Source |
|---|---|---|---|
| M1.2 | Monitoring d'alertes Railway + SurrealDB Cloud (logs anormaux) | ~3h | R1 |
| M1.3 | Procédure de rotation périodique des secrets (Stripe webhook, Resend, Google OAuth) | ~2h | R1 |
| M2.2 | Monitoring du taux de fail-open blocklist | ~2h | R2 |
| M3.2 | Détection comportementale d'export massif CSV | ~3h | R3 |
| M4.2 | Procédure d'audit trimestriel par échantillonnage des emails insérés | ~1h documentation | R4 |
| M7.1 | Fréquence de re-vérification accélérée pour fiches top 10 % | ~2h | R7 |
| M7.2 | Bouton « fiche obsolète » côté abonné | ~2h | R7 |
| M8.1 | Détection comportementale anti-stalking | ~3h | R8 |

**Total** : ~18h cumulées sur 3 mois post-lancement.

### 4.4 Mesures à fermer en Phase 6-bis avocat (post premiers abonnés, financement par CA)

| Référence | Mesure | Source |
|---|---|---|
| M1.1 | Audit de sécurité par tiers indépendant | R1 |
| M2.3 | Test périodique semestriel double rempart opt-out | R2 |
| M3.1 | Renforcement clause d'usage des données dans CGV/CGU | R3 |
| M3.3 | Procédure formelle de suspension de compte en cas d'usage abusif | R3 |
| M4.3 | Réflexion sur l'exclusion de préfixes type `direction@`, `gerant@` | R4 |
| M8.2 | Clause anti-stalking dans CGU | R8 |
| M8.3 | Procédure formelle de suspension en cas de suspicion stalking | R8 |
| Audit DPA | Revue formelle des DPA par avocat RGPD spécialisé | CST-MOVUP-001 |
| Designation DPO | Désignation formelle ou externalisation du DPO | CST-MOVUP-001 |

**Coût estimé Phase 6-bis avocat** : 1500-3000€ TTC, financé par CA premiers abonnés.

---

## Section 5 — Consultation des parties prenantes

### 5.1 Consultation du DPO

Le DPO de So Paradi est, à la date d'effet du présent document, cumulé avec la fonction de responsable de traitement (Benoît Fouquet). La présente AIPD a été **rédigée et auto-validée** par le responsable de traitement en cette double qualité.

Une **désignation formelle d'un DPO externe** est programmée en Phase 6-bis avocat (cf. Section 4.4).

### 5.2 Consultation des personnes concernées

La consultation directe des personnes concernées n'est pas matériellement possible avant le lancement (les prospects ne sont pas identifiés en amont). En revanche, le présent document est **opposable** à toute personne concernée exerçant ses droits, et peut lui être communiqué sur simple demande à dpo@movup.io.

Une consultation pourra être organisée à l'occasion des premiers retours des Founders #001-100 si des griefs émergent.

### 5.3 Consultation de la CNIL

**Non requise** (art. 36 RGPD) : le risque résiduel est qualifié de Modéré au plus haut, après application des mesures protectrices. Aucun risque ne dépasse le seuil « Élevé » qui imposerait une consultation préalable.

So Paradi se réserve la possibilité d'une consultation volontaire de la CNIL à l'occasion de futures évolutions substantielles du traitement (ex. ouverture à l'expansion francophone Belgique/Suisse/Québec, introduction de fonctionnalités d'IA).

---

## Section 6 — Validité, opposabilité et revue

### 6.1 Validité

Le présent document est **valide à compter du 1er juin 2026** et demeure valide jusqu'à révision formelle.

### 6.2 Opposabilité

Le présent document est **opposable** :

- à la CNIL (article 35.1 RGPD : mise à disposition de l'autorité de contrôle sur demande),
- à toute autorité de contrôle compétente (APD belge, PFPDT suisse, CAI Québec en cas d'expansion),
- à toute personne concernée exerçant ses droits,
- à toute juridiction saisie d'un litige relatif au traitement.

### 6.3 Revue et mise à jour

Revue **semestrielle** systématique (prochaine : 1er décembre 2026).

Revue **exceptionnelle** en cas de :

- modification substantielle du traitement (nouvelles finalités, nouvelle volumétrie significative),
- introduction d'un nouveau sous-traitant ou d'un transfert de données hors UE,
- introduction de fonctionnalités d'IA (révision de l'AIPD pour intégrer les risques spécifiques IA),
- extension géographique du périmètre (Belgique, Suisse, Québec),
- violation de données impactant le traitement,
- évolution réglementaire ou jurisprudentielle significative,
- demande formelle d'une autorité de contrôle.

### 6.4 Conservation et archivage

Le présent document et ses versions antérieures sont conservés sans limitation de durée dans `docs/rgpd/` du dépôt source Soparadi/mup, avec horodatage Git.

---

## Section 7 — Signature et engagement

Le présent document est établi sous la responsabilité de Benoît Fouquet, en sa qualité de responsable de traitement, et engage l'entreprise individuelle So Paradi (SIRET 453 388 456 00031).

L'ensemble des mesures protectrices existantes est **effectivement mis en œuvre** à la date d'effet du présent document, conformément à l'état du système consigné dans `docs/PHASE_6_RGPD_COMPLETE.md` (tag git `v1.0.0-rgpd`, HEAD prod `583b380`).

L'ensemble des mesures complémentaires programmées en Section 4 est assorti d'un calendrier de mise en œuvre opposable, dont le suivi est intégré au journal technique du projet.

**Conclusion finale** : le traitement objet de la présente AIPD est **autorisé à être mis en œuvre** à compter du 1er juin 2026, sous la responsabilité du responsable de traitement, sans consultation préalable de la CNIL.

**Fait à Combourg, le 25 mai 2026**

**Benoît Fouquet**
Responsable de traitement — So Paradi (EI)
SIRET 453 388 456 00031
dpo@movup.io

---

*Document de référence interne — AIPD-MOVUP-001 v1.0 — Conformité art. 35 RGPD*
