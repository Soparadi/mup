# Balance test intérêt légitime — Article 6.1.f RGPD

**Responsable de traitement** : Benoît Fouquet — Entrepreneur Individuel So Paradi
**SIRET** : 453 388 456 00031
**Adresse** : 18 place du Marchix, 22100 Dinan, France
**Contact DPO** : dpo@movup.io
**Activité concernée** : MovUP — Pipeline management SaaS B2B (movup.io)

**Document** : Balance test intérêt légitime
**Référence interne** : LIA-MOVUP-001
**Version** : 1.2
**Date de rédaction** : 25 mai 2026
**Date de révision** : 23 juillet 2026 (révision exceptionnelle — admission encadrée du processor UE Dataforseo OÜ pour l'accès à la fiche publique Google My Business, cf. Doctrine 9 amendée)
**Date d'effet** : 1er juin 2026 (lancement commercial MovUP)
**Prochaine revue** : 1er décembre 2026 (revue semestrielle systématique)
**Cadre méthodologique** : Lignes directrices CNIL sur l'intérêt légitime + WP29 Opinion 06/2014 + EDPB Guidelines 01/2025

---

## Préambule — Portée et finalité du document

Le présent document constitue le **test de mise en balance (Legitimate Interest Assessment, LIA)** prévu à l'article 6.1.f du Règlement (UE) 2016/679 (RGPD), formalisant l'analyse préalable au traitement de données à caractère personnel de prospects professionnels mené dans le cadre de l'activité de prospection commerciale de MovUP.

Il est rédigé conformément au principe d'**accountability** posé à l'article 5.2 RGPD et complète le registre des activités de traitement (article 30), l'analyse d'impact relative à la protection des données (article 35) et la cartographie des sous-traitants (article 28).

Ce document est **opposable** : il peut être produit à toute autorité de contrôle compétente (CNIL, APD belge, PFPDT suisse, Commission d'accès à l'information du Québec) ou à toute personne concernée exerçant ses droits.

---

## Section 1 — Identification de la finalité poursuivie

### 1.1 Finalité explicite

**Prospection commerciale B2B à destination de professionnels indépendants francophones**, aux fins de présenter l'outil MovUP — solution SaaS de gestion de pipeline commercial développée et commercialisée par l'entreprise individuelle So Paradi.

### 1.2 Cible commerciale

Personnes physiques exerçant une activité professionnelle indépendante (auto-entrepreneurs, micro-entrepreneurs, entrepreneurs individuels, travailleurs autonomes au Québec, indépendants au sens des régimes belge, suisse et québécois) inscrites dans des registres publics professionnels :

- France : répertoire SIRENE (INSEE)
- Belgique : Banque-Carrefour des Entreprises (BCE) — perspective expansion future
- Suisse : registres cantonaux du commerce — perspective expansion future
- Québec : registre des entreprises CIDREQ — perspective expansion future

À la date d'effet du présent document, le périmètre opérationnel est limité au marché français (SIRENE/INSEE). Les marchés belge, suisse et québécois sont des perspectives d'expansion ultérieure, soumises à une mise à jour du présent document avant activation.

### 1.3 Caractère licite, déterminé et explicite de la finalité

- **Licite** : l'activité de prospection commerciale B2B est expressément autorisée en France par la délibération CNIL n°2020-091 du 17 septembre 2020, par la doctrine constante de la CNIL en matière de prospection professionnelle, et par les régimes équivalents en Belgique (loi belge transposant le RGPD + LCE), en Suisse (nLPD entrée en vigueur le 1er septembre 2023) et au Québec (Loi 25 entrée en vigueur le 22 septembre 2023).
- **Déterminé** : la finalité ne couvre **que** la prise de contact commerciale initiale, sa qualification et son éventuelle conversion en client. Elle exclut toute autre exploitation (revente, profilage automatisé, scoring tiers, transfert hors finalité).
- **Explicite** : la finalité est communiquée à chaque prospect dans le pied de page de toute communication, conformément à l'article 14 RGPD.

### 1.4 Activités de traitement couvertes

**Architecture à la date d'effet du présent document (1er juin 2026)** : MovUP fonctionne en architecture proxy pass-through. Les fiches SIRENE sont collectées en temps réel depuis les API publiques et transmises directement au frontend, sans stockage en base de données. Aucune table de fiches d'entreprise n'existe dans la base de données MovUP. Les tables actuellement actives en production sont limitées à l'authentification (`user`, `session`), à la gestion opt-out (`optout_request`, `optout_blocklist`), au journal d'audit (`audit_log`), au journal d'export RGPD (`privacy_export_log`) et à l'idempotence Stripe (`stripe_events_processed`).

**Architecture cible V1.0 (déploiement programmé fin juin 2026)** : mise en service du moteur de recherche interne souverain MovUP avec stockage en base. Les activités de traitement cibles, telles qu'elles seront opérantes à compter de la V1.0, sont les suivantes :

1. **Collecte initiale** depuis SIRENE via deux canaux complémentaires opérés directement par MovUP, sans intermédiaire tiers :
   - API publique recherche-entreprises.api.gouv.fr (service Etalab),
   - API SIRENE INSEE V3 (authentification OAuth2 directe).
2. **Enrichissement** des fiches par la consultation de sources publiques, **sans recours à aucun prestataire tiers de scraping ni d'agrégation commerciale de données B2B**, via deux canaux complémentaires :
   - le **moteur de recherche interne MovUP**, opéré entièrement sur l'infrastructure du responsable de traitement (Railway europe-west4), qui consulte uniquement les sites web officiels des entreprises ciblées, à la racine du domaine et sur les pages de mentions légales / contact publiquement accessibles ;
   - à défaut de résultat par ce premier canal, l'accès à la **fiche publique Google My Business** de l'entreprise via le processor européen **Dataforseo OÜ** (Estonie, UE), sous clauses contractuelles types 2021/914, avec une requête minimisée (nom de l'entreprise + ville) et un appel strictement subsidiaire (cf. Section 9, Doctrine 9 amendée).
3. **Stockage** dans la base de données MovUP (SurrealDB Cloud, région AWS eu-west-1 Dublin) selon une **architecture à double cache** :
   - cache `company_public` partagé entre abonnés MovUP (données publiques d'entreprise uniquement),
   - cache `company_enrichment_user` privé par abonné (notes commerciales personnelles, jamais partagées).
4. **Envoi de communications de prospection commerciale** (cold mail) via le prestataire Resend (région eu-west-1 Dublin).
5. **Suivi des interactions** (ouverture, réponse, opt-out) limité au strict nécessaire à la gestion de la relation et au respect du droit d'opposition.
6. **Archivage et purge** selon les durées de conservation définies à la Section 5.

**Pour la période transitoire du 1er juin au déploiement V1.0**, seules les étapes 1, 4, 5 et 6 sont actives. L'étape 2 (enrichissement) et l'étape 3 (stockage) ne sont pas opérantes : les destinataires des communications de prospection (étape 4) sont sélectionnés directement depuis les résultats des API SIRENE par l'utilisateur abonné, sans transit par un cache mutualisé.

---

## Section 2 — Démonstration de la nécessité du traitement

### 2.1 Articulation à trois branches (méthodologie WP29 / EDPB)

Conformément à la jurisprudence constante de la Cour de Justice de l'Union européenne (notamment CJUE C-708/18 Asociaţia de Proprietari et CJUE C-13/16 Rīgas satiksme) et aux lignes directrices EDPB 01/2025, le recours à l'intérêt légitime suppose la démonstration cumulative de trois conditions :

1. **Intérêt légitime poursuivi** par le responsable de traitement (Section 2.2).
2. **Nécessité du traitement** pour atteindre la finalité (Section 2.3).
3. **Absence de prévalence** des droits et libertés fondamentaux des personnes concernées (Section 4).

### 2.2 Intérêt légitime poursuivi

L'intérêt poursuivi par So Paradi est **le développement de l'activité économique de l'entreprise individuelle MovUP**, à savoir :

- l'identification de prospects qualifiés correspondant à la cible métier (auto-entrepreneurs francophones B2B service),
- la prise de contact commerciale auprès de ces prospects pour leur présenter l'outil,
- la conversion d'une partie de ces contacts en clients payants.

Cet intérêt est **réel** (l'activité est effectivement exercée, la solution est techniquement opérationnelle, le lancement commercial est programmé), **présent** (et non hypothétique ou futur), et **légitime** (conforme à l'ordre juridique, à la déontologie commerciale, et à l'attente sociale en matière de prospection B2B).

La doctrine constante de la CNIL (fiche pratique prospection commerciale, mise à jour février 2025) reconnaît expressément que **la prospection commerciale B2B vers une adresse électronique professionnelle générique ou nominative en lien avec la fonction du destinataire peut être fondée sur l'intérêt légitime**, sous réserve du respect des conditions encadrant ce fondement.

### 2.3 Nécessité du traitement

Le traitement est **nécessaire** à la poursuite de la finalité au sens où aucun moyen moins intrusif ne permettrait d'atteindre l'objectif avec une efficacité équivalente :

- **L'obtention d'un consentement préalable** est techniquement impossible en phase de découverte commerciale : il n'existe aucun canal antérieur à la prise de contact qui permettrait de recueillir un consentement informé.
- **L'acquisition de leads via achat de fichiers tiers** présenterait un degré d'intrusion supérieur (chaîne de responsabilité opaque, fiabilité du consentement amont incertaine, exposition à des données obtenues dans des conditions inconnues) et est explicitement écartée par la doctrine interne du responsable de traitement.
- **Le recours à un prestataire tiers de scraping ou d'agrégation commerciale de données B2B** (de type ScrapingBee, Bright Data, Pappers, Apollo, Lusha) présenterait des risques de chaîne de sous-traitance opaques, des transferts de données potentiellement hors UE non maîtrisés, et une moindre maîtrise de la conformité. So Paradi a délibérément écarté cette option (cf. Section 9, Doctrine 9 — Souveraineté technique). En revanche, l'**accès à une source publique déterminée** — la fiche Google My Business publiée par le professionnel lui-même — via un **processor européen sous SCC** (Dataforseo OÜ) ne relève pas de cette agrégation commerciale prohibée : il est assimilé aux autres canaux de sources publiques déjà mobilisés (SIRENE/INSEE, Etalab, BAN, mentions légales LCEN) et admis à ce titre, dans les conditions et limites posées par la Doctrine 9 amendée.
- **La publicité ciblée payante** (Google Ads, LinkedIn Ads) repose elle-même sur des traitements de profilage et un ciblage publicitaire qui présentent un degré d'intrusion équivalent ou supérieur à la prospection directe, sans permettre la qualification individuelle nécessaire à la conversion B2B.
- **Le bouche-à-oreille et le réseau personnel** sont par nature non scalables et ne permettent pas l'atteinte de la cible commerciale à l'échelle requise pour la viabilité économique du projet.

Le périmètre du traitement est par ailleurs **strictement limité au nécessaire** : seules les données professionnelles publiquement accessibles sont collectées, dans les volumes définis par les quotas commerciaux du produit lui-même (cf. Section 5 — Minimisation).

---

## Section 3 — Catégories de données traitées et leur source

### 3.1 Données collectées

Les données traitées sont exclusivement issues de sources publiques professionnelles, collectées et traitées **directement par MovUP sans intermédiaire tiers** :

| Catégorie de données | Source | Caractère public | Mode de collecte |
|---|---|---|---|
| Dénomination sociale | SIRENE (INSEE) | Diffusion légale obligatoire | API Etalab + API INSEE V3 directes |
| SIRET / SIREN | SIRENE (INSEE) | Diffusion légale obligatoire | API Etalab + API INSEE V3 directes |
| Code NAF / APE | SIRENE (INSEE) | Diffusion légale obligatoire | API Etalab + API INSEE V3 directes |
| Adresse postale du siège | SIRENE (INSEE) | Diffusion légale obligatoire | API Etalab + API INSEE V3 directes |
| Date de création | SIRENE (INSEE) | Diffusion légale obligatoire | API Etalab + API INSEE V3 directes |
| Tranche d'effectifs | SIRENE (INSEE) | Diffusion légale obligatoire | API Etalab + API INSEE V3 directes |
| Nom et prénom du dirigeant (EI uniquement) | SIRENE (INSEE) | Diffusion légale obligatoire | API Etalab + API INSEE V3 directes |
| Statut actif / radié / liquidation | SIRENE (INSEE) | Diffusion légale obligatoire | API Etalab + API INSEE V3 directes |
| Coordonnées GPS (géocodage) | API BAN (data.gouv.fr) | Service public ouvert | API BAN directe |
| Site web de l'entreprise | SIRENE quand renseigné, mentions légales LCEN, fiche Google My Business | Diffusion volontaire professionnelle | Moteur de recherche interne MovUP ; à défaut, fiche GMB via processor UE (Dataforseo OÜ, SCC) |
| Adresse électronique professionnelle générique (contact@, info@, commercial@, bonjour@) | Mentions légales publiées sur sites web professionnels, fiche Google My Business | Diffusion volontaire professionnelle | Moteur de recherche interne MovUP ; à défaut, fiche GMB via processor UE (Dataforseo OÜ, SCC) |
| Téléphone professionnel | Mentions légales publiées sur sites web professionnels, fiche Google My Business | Diffusion volontaire professionnelle | Moteur de recherche interne MovUP ; à défaut, fiche GMB via processor UE (Dataforseo OÜ, SCC) |

### 3.2 Données exclues du traitement

So Paradi s'engage à **ne pas traiter** dans le cadre de la prospection MovUP :

- les données issues de personnes physiques n'exerçant pas d'activité professionnelle indépendante,
- les **adresses email nominatives de type `prenom.nom@domaine.fr`** (filtrage défensif appliqué à l'écriture par le moteur de recherche interne — rejet silencieux),
- les données issues de **LinkedIn ou de tout réseau social personnel** (interdiction explicite des CGU LinkedIn 2024 et exclusion doctrinale),
- les données de contact privées (adresses email personnelles, téléphones personnels) lorsqu'elles sont identifiables comme telles,
- les catégories particulières de données visées à l'article 9 RGPD (origine raciale ou ethnique, opinions politiques, convictions religieuses ou philosophiques, appartenance syndicale, données génétiques, données biométriques, données concernant la santé, données concernant la vie sexuelle ou l'orientation sexuelle d'une personne physique),
- les données relatives aux condamnations pénales et aux infractions visées à l'article 10 RGPD,
- les données concernant des mineurs (les auto-entrepreneurs étant par définition majeurs).

### 3.3 Sources tierces et chaîne de responsabilité

- **SIRENE** : la diffusion publique des données SIRENE est régie par la loi pour une République numérique (loi n°2016-1321 du 7 octobre 2016, art. 1) et l'arrêté du 22 juin 2017. Les données diffusées sont expressément qualifiées de **publiques** par l'INSEE et leur réutilisation est autorisée sous réserve de respecter le droit d'opposition prévu à l'article L. 1 du code des relations entre le public et l'administration.
- **Recherche-entreprises.api.gouv.fr** : service public Etalab opéré par la DINUM, accès libre et gratuit, conditions générales de réutilisation Etalab 2.0.
- **API BAN** : service public d'adresse opéré par data.gouv.fr, accès libre et gratuit.
- **Mentions légales sites professionnels** : la publication de mentions légales conformes au décret n°2007-451 du 25 mars 2007 et à l'article 19 de la LCEN constitue une diffusion volontaire des coordonnées professionnelles à des fins de contact.
- **Fiche Google My Business (GMB)** : la fiche d'établissement Google My Business est renseignée et publiée volontairement par le professionnel lui-même, à des fins de visibilité et de contact commercial. Sa consultation constitue l'accès à une donnée professionnelle publique, au même titre que les mentions légales. MovUP y accède **uniquement en dernier ressort**, lorsque les canaux gratuits n'ont rien restitué, via l'API Business Data / Google My Business Info du processor européen **Dataforseo OÜ** (Tallinn, Estonie, UE ; Company No. 14502291 ; ISO 27001 ; DPO Nick Chernets, info@dataforseo.com), agissant comme sous-traitant au sens de l'article 28 RGPD sous clauses contractuelles types 2021/914. La requête est strictement minimisée (nom de l'entreprise + ville). Cf. cartographie des sous-traitants (fiche dédiée) et Section 9, Doctrine 9 amendée.

**Aucun prestataire tiers de scraping ou d'agrégation commerciale de données B2B n'est utilisé** dans le périmètre du présent document. L'accès aux sources publiques via un processor UE sous SCC — en l'espèce Dataforseo OÜ, pour la seule consultation de la fiche Google My Business publiée par le professionnel — est en revanche admis, au même régime que les autres sources publiques (SIRENE, Etalab, BAN, mentions légales LCEN), cf. Section 9, Doctrine 9 amendée.

### 3.4 Le moteur de recherche interne MovUP

Le moteur de recherche interne MovUP constitue, dans l'architecture cible V1.0 (déploiement programmé fin juin 2026), l'**outil principal d'enrichissement complémentaire** mobilisé en aval de la collecte initiale SIRENE / Etalab. Un canal subsidiaire d'accès à la fiche publique Google My Business, via le processor européen Dataforseo OÜ (sous SCC), n'est mobilisé qu'en dernier ressort lorsque le moteur interne n'a rien restitué (cf. Section 9, Doctrine 9 amendée). À la date d'effet du présent document (1er juin 2026), ce moteur n'est pas encore en service : aucun enrichissement automatisé n'a lieu, les destinataires de la prospection commerciale sont sélectionnés directement par l'utilisateur abonné depuis les résultats des API SIRENE et recherche-entreprises Etalab. Les caractéristiques techniques et doctrinales du moteur, telles qu'elles seront opérantes à compter de la V1.0, sont les suivantes :

**Opérateur** : So Paradi (responsable de traitement), exécution sur infrastructure Railway europe-west4, code source maintenu en interne dans le dépôt Soparadi/mup.

**Périmètre fonctionnel** : pour une entreprise donnée identifiée par son SIRET, le moteur consulte le site web officiel de l'entreprise (URL fournie par SIRENE ou découverte par recherche), récupère la page d'accueil et les pages de mentions légales / contact publiquement accessibles, et extrait par expression régulière trois catégories d'information :

- adresse email professionnelle générique (motifs `contact@`, `info@`, `commercial@`, `bonjour@`, `hello@`, et variantes),
- téléphone professionnel,
- liens vers réseaux sociaux professionnels de l'entreprise (page entreprise, jamais profil personnel).

**Filtres défensifs appliqués à l'écriture** :

- Rejet silencieux de tout email nominatif identifié par le motif `[a-z]+\.[a-z]+@` (Ligne rouge n°1).
- Rejet de toute URL de réseau social pointant vers un profil personnel (Ligne rouge n°2).
- Cache mutualisé séparé entre données publiques d'entreprise et notes commerciales personnelles (Ligne rouge n°3).
- Expiration automatique des données enrichies après 24 mois (Ligne rouge n°4).
- Propagation instantanée de l'opt-out sur l'ensemble de la base partagée (Ligne rouge n°5).

**Respect du robots.txt** : le moteur consulte et respecte le fichier robots.txt de chaque domaine consulté. Les domaines refusant l'accès sont exclus.

**Volumétrie maîtrisée** : exécution en cron quotidien, plafond opérationnel volontairement limité (~500 fiches/jour à la date d'effet du présent document), respect d'un délai minimum entre requêtes successives sur un même domaine.

**Métadonnées par champ** : chaque donnée enrichie est associée à un horodatage de collecte et à une source identifiée (site officiel, mentions légales LCEN), permettant traçabilité complète en cas de demande d'accès art. 15 RGPD.

**Indisponibilité tolérée** : le moteur tolère structurellement l'absence de résultat. Une fiche partielle (avec seulement statut SIRENE + adresse postale) reste valide. L'enrichissement n'est jamais un prérequis à l'existence d'une fiche dans la base.

---

## Section 4 — Mise en balance des intérêts et des droits

### 4.1 Méthodologie d'évaluation

L'évaluation suit la grille en huit critères recommandée par la CNIL et l'EDPB :

1. Caractère raisonnable des attentes des personnes concernées
2. Nature des données traitées
3. Caractère public ou privé du contexte de collecte
4. Lien entre la personne concernée et le responsable de traitement
5. Conséquences potentielles pour les personnes concernées
6. Mesures de protection mises en place
7. Possibilité effective d'exercer les droits
8. Position de la personne concernée dans la relation

### 4.2 Critère 1 — Attentes raisonnables des personnes concernées

Les prospects ciblés sont des **personnes physiques exerçant une activité économique indépendante** ayant volontairement :

- déclaré leur activité auprès d'un registre public (URSSAF, INSEE),
- publié leur entreprise dans un répertoire public diffusé à des fins de réutilisation,
- mis en ligne des mentions légales contenant leurs coordonnées professionnelles,
- exposé une activité commerciale ouverte à la sollicitation B2B (c'est la définition même de l'activité d'auto-entrepreneur en service).

Il est **raisonnablement attendu** par une personne physique exerçant une activité commerciale indépendante et ayant rendu ses coordonnées publiques dans un cadre professionnel qu'elle puisse être sollicitée par d'autres acteurs économiques dans le cadre de propositions commerciales pertinentes.

Cette attente raisonnable est expressément reconnue par le considérant 47 du RGPD :
> *« Les intérêts légitimes d'un responsable du traitement [...] peuvent constituer une base juridique pour le traitement [...]. Le traitement de données à caractère personnel à des fins de prospection commerciale peut être considéré comme étant réalisé pour répondre à un intérêt légitime. »*

### 4.3 Critère 2 — Nature des données traitées

Les données traitées sont exclusivement **professionnelles et publiques** (cf. Section 3). Aucune donnée sensible, aucune donnée privée, aucune catégorie particulière au sens de l'article 9 RGPD n'est concernée. Aucune adresse email nominative n'est admise dans la base (filtre défensif Ligne rouge n°1).

**Évaluation** : risque faible.

### 4.4 Critère 3 — Caractère public ou privé du contexte de collecte

Les données sont collectées dans un **contexte exclusivement professionnel**, depuis des **sources publiques officielles** dont la diffusion est expressément autorisée par la loi (SIRENE) ou volontaire et destinée à un usage professionnel (mentions légales LCEN sur sites officiels d'entreprise).

**Évaluation** : risque faible.

### 4.5 Critère 4 — Lien entre la personne concernée et le responsable de traitement

Il n'existe **aucune relation préexistante** entre So Paradi et les prospects ciblés. Le traitement constitue une prise de contact commerciale initiale.

Cette absence de lien préexistant est compensée par :

- la pertinence sectorielle stricte du ciblage (codes NAF correspondant à l'activité de la cible MovUP),
- le caractère professionnel de la sollicitation,
- la facilité d'opposition (cf. Section 5),
- le caractère raisonnablement attendu de la sollicitation (cf. Section 4.2).

**Évaluation** : risque mesuré, atténué par les mesures protectrices.

### 4.6 Critère 5 — Conséquences potentielles pour les personnes concernées

Les conséquences pour les prospects ciblés sont **limitées et de faible intensité** :

- réception d'un courrier électronique de prospection commerciale au sein de leur messagerie professionnelle,
- éventuelles communications de relance dans la limite de 2 messages maximum par prospect en l'absence de réponse,
- inscription en base de données MovUP jusqu'à exercice du droit d'opposition ou expiration de la durée de conservation.

**Aucune conséquence n'est de nature** :

- à exposer le prospect à une décision automatisée produisant des effets juridiques ou similairement significatifs (article 22 RGPD),
- à produire un effet discriminatoire,
- à porter atteinte à la réputation professionnelle ou à la vie privée,
- à entraîner un préjudice matériel ou moral identifiable.

**Évaluation** : risque faible.

### 4.7 Critère 6 — Mesures de protection mises en place

So Paradi a mis en œuvre l'ensemble des mesures protectrices détaillées en Section 5 ci-après, parmi lesquelles, à titre principal :

- minimisation systématique des données collectées,
- pseudonymisation par hachage SHA-256 des identifiants opt-out,
- tunnel d'opposition en deux étapes avec magic link à expiration courte,
- mécanisme d'opt-out à double rempart (filtrage upstream silencieux + refus dur en aval) avec propagation instantanée sur la base partagée,
- footer d'information sur chaque communication conforme article 14 RGPD,
- portabilité art. 20 RGPD disponible à vie via /account/privacy,
- effacement art. 17 RGPD avec délai d'annulation de 7 jours,
- rate-limiting anti-énumération et anti-flood,
- chiffrement AES-256-GCM des credentials sensibles,
- principe **fail-open** sur le filtrage opt-out scraping délibérément assumé en faveur des personnes concernées (toute erreur technique aboutit à l'exclusion du contact, jamais à son inclusion erronée),
- moteur de recherche interne souverain sans recours à un prestataire tiers de scraping ni d'agrégation commerciale B2B ; recours au seul processor UE Dataforseo OÜ (sous SCC), en dernier ressort, pour la consultation de la fiche publique Google My Business (architecture cible V1.0 — déploiement fin juin 2026),
- filtres défensifs à l'écriture (anti email nominatif, anti réseaux sociaux personnels),
- expiration automatique 24 mois des données enrichies,
- séparation stricte entre cache mutualisé public et notes commerciales privées par abonné (architecture cible V1.0 — déploiement fin juin 2026),
- pour la période transitoire du 1er juin 2026 au déploiement V1.0 : architecture proxy pass-through sans enrichissement ni cache mutualisé, sélection des destinataires de prospection directement par l'utilisateur abonné depuis les résultats des API SIRENE et recherche-entreprises Etalab.

### 4.8 Critère 7 — Possibilité effective d'exercer les droits

Le présent dispositif rend les droits **effectivement exerçables** par :

- la mise à disposition d'un **tunnel d'opt-out public** accessible sans authentification sur trois pages (/optout, /optout-confirmation, /optout-verified) propagé sur l'ensemble des sites de l'écosystème So Paradi,
- la **présence obligatoire du lien opt-out personnalisé** dans le footer de chaque communication de prospection (injection côté serveur, anti-bypass DOM),
- la **propagation instantanée** de l'opt-out sur l'ensemble de la base partagée entre tous les abonnés MovUP (Ligne rouge n°5) : une fois l'identifiant en blocklist, plus aucun abonné ne peut le voir, le contacter, ou l'enrichir,
- l'**absence de toute exigence de motivation** : le droit d'opposition s'exerce sans justification (conformité art. 21.2 RGPD pour la prospection commerciale, droit d'opposition absolu),
- un **délai de traitement encadré** : prise d'effet dans un délai inférieur à 24 heures après confirmation par magic link,
- une **information claire et accessible** sur les modalités d'exercice des droits dans chaque communication,
- un **canal DPO distinct** (dpo@movup.io) pour les demandes complexes ou contestées.

### 4.9 Critère 8 — Position relative des parties

Le prospect cible est **un professionnel indépendant** exerçant une activité commerciale, juridiquement et économiquement autonome, agissant dans un cadre professionnel. So Paradi est une entreprise individuelle en phase de lancement, sans position dominante, sans pouvoir d'influence disproportionné.

Il n'existe **aucune relation de dépendance, de vulnérabilité, ni de déséquilibre structurel** entre les parties susceptible d'altérer la liberté de la personne concernée d'exercer ses droits.

### 4.10 Synthèse de la mise en balance

| Critère | Évaluation |
|---|---|
| 1 — Attentes raisonnables | Favorable (sollicitation prévisible en contexte B2B public) |
| 2 — Nature des données | Favorable (professionnelles publiques uniquement, anti-nominatif) |
| 3 — Contexte de collecte | Favorable (sources publiques officielles + moteur souverain) |
| 4 — Lien préexistant | Neutre (absence de lien, mais atténuation forte) |
| 5 — Conséquences potentielles | Favorable (impact faible, pas de décision auto) |
| 6 — Mesures de protection | Très favorable (dispositif complet documenté + souveraineté technique) |
| 7 — Effectivité des droits | Très favorable (tunnel public, propagation instantanée sur base partagée) |
| 8 — Position des parties | Favorable (B2B entre professionnels autonomes) |

L'introduction, dans l'architecture cible V1.0, du canal subsidiaire d'accès à la fiche publique Google My Business via le processor européen Dataforseo OÜ (sous SCC) **ne modifie pas cette conclusion** : la finalité reste identique (contact professionnel publiquement diffusé par le professionnel lui-même), la donnée demeure professionnelle et non sensible, la collecte est minimisée (requête nom + ville, appel en dernier ressort après échec des canaux gratuits), et la restitution DataForSEO, limitée par construction aux seuls champs de société (website, societe_tel) et excluant toute donnée nominative, écarte toute restitution d'une coordonnée de personne physique comme contact de la société. La balance demeure favorable (cf. Section 9, Doctrine 9 amendée).

**Conclusion du test de mise en balance** : **les droits et libertés fondamentaux des personnes concernées ne prévalent pas sur l'intérêt légitime poursuivi par So Paradi**, sous réserve du maintien effectif de l'ensemble des mesures protectrices détaillées en Section 5.

Le traitement est en conséquence **licite** au sens de l'article 6.1.f RGPD.

---

## Section 5 — Mesures protectrices effectivement mises en place

Cette section documente l'ensemble des mesures techniques et organisationnelles mises en œuvre pour protéger les droits des personnes concernées. Elle constitue le cœur opérationnel de la conformité et fonde la balance favorable établie en Section 4.

### 5.1 Mesures de minimisation (article 5.1.c RGPD)

- **Hachage SHA-256** systématique des identifiants opt-out (email, téléphone) avant stockage en base. Normalisation `.trim()` préalable.
- **Suppression du champ « motif »** dans le formulaire d'opt-out (collecte limitée à l'identifiant strictement nécessaire à la mise en œuvre du droit d'opposition).
- **IP hashée** dans les logs (pas de stockage en clair).
- **Aucune donnée sensible** collectée (cf. Section 3.2).
- **Aucune adresse email nominative** admise dans la base (filtre défensif Ligne rouge n°1, application à l'écriture par le moteur de recherche interne).
- **Quotas commerciaux du produit** limitant mécaniquement le volume traité : 30 prospects actifs sur le plan Démarrage, 120 sur Activité, illimités sur Croisière.
- **Plafond opérationnel du moteur de recherche interne** : ~500 fiches enrichies par jour à la date d'effet du présent document, paramètre maîtrisé par le responsable de traitement.
- **Requête minimisée au processor GMB** : lorsqu'il est sollicité en dernier ressort, l'accès à la fiche Google My Business via le processor Dataforseo OÜ n'emporte transmission que du nom de l'entreprise et de la ville (clé de recherche), à l'exclusion de toute autre donnée de la personne concernée.

### 5.2 Mesures d'information (articles 13 et 14 RGPD)

- **Footer art. 14 sur chaque communication** : injection serveur (anti-bypass DOM), lien opt-out personnalisé par destinataire, mention de la base légale (intérêt légitime art. 6.1.f), identification du responsable de traitement, mention du canal DPO.
- **Pages publiques d'information** : /optout, /optout-confirmation, /optout-verified, /mentions-legales, /confidentialite, /cookies.
- **Pré-remplissage transparent** du formulaire opt-out (paramètres GET `from` et `email` permettant un parcours optimisé depuis le lien dans le footer).
- **Métadonnées par champ** dans chaque fiche enrichie (source identifiée, horodatage de collecte) permettant réponse complète en cas de demande d'accès art. 15 RGPD.

### 5.3 Mesures d'opposition effective (article 21 RGPD)

**Tunnel opt-out à deux étapes** :

1. Soumission du formulaire `/optout` (saisie email + question logique anti-bot, pas de CAPTCHA tiers non-UE conformément à la doctrine bon père de famille).
2. Envoi d'un **magic link** signé à expiration courte (24h) sur l'adresse soumise.
3. Validation par clic sur le lien → insertion en blocklist (hash SHA-256) + accusé de réception.
4. Idempotence UX-level : tout clic ultérieur sur le même lien produit la même réponse silencieuse (anti-énumération).

**Double rempart de filtrage** :

- **Upstream silencieux** : filtrage en amont sur `/api/search` et `/api/sirene/search`. Les fiches concernées sont exclues des résultats sans signal visible (anti-revelation).
- **Refus dur en aval** : `POST /api/pipeline` retourne 403 si l'identifiant cible est en blocklist (verrou de dernier ressort).

**Propagation instantanée sur base partagée** (Ligne rouge n°5) : l'insertion d'un identifiant dans la blocklist est immédiatement effective pour **tous les abonnés** MovUP. À la date d'effet du présent document (1er juin 2026), la blocklist filtre les requêtes API SIRENE en temps réel : l'identifiant disparaît des résultats de recherche et ne peut plus être inséré en pipeline par quelque abonné que ce soit. À compter du déploiement V1.0 (fin juin 2026), la même blocklist exclura également l'identifiant du cache mutualisé `company_public` et bloquera tout enrichissement par le moteur de recherche interne.

**Fail-open assumé** : une erreur de la base de données blocklist ne bloque jamais le scraping, mais elle est tracée dans les logs et fait l'objet d'une alerte. **Le tradeoff est délibérément en faveur des personnes concernées** : en cas de doute technique, l'enrichissement s'interrompt plutôt que de risquer une inclusion erronée.

**Rate-limiting** : 3 demandes opt-out maximum par tranche de 24h par IP (anti-flood, anti-énumération).

### 5.4 Mesures d'effacement (article 17 RGPD)

- **Suppression de compte** accessible depuis `/account/privacy`.
- **Délai d'annulation de 7 jours** avant exécution effective (protection contre la suppression accidentelle ou contrainte).
- **Hard delete** des données personnelles à l'échéance, par cron quotidien 08:00 Europe/Paris.
- **Anonymisation** de la table audit_log (préservation traçabilité technique, sans identifiabilité).
- **Conservation comptable** des seuls éléments imposés par le Code de commerce art. L123-22 (factures, comptables, fiscaux) sur 10 ans, conformément à l'obligation légale (article 6.1.c RGPD comme base distincte pour cette conservation).
- **Refus 409** si abonnement Stripe actif (résolution préalable requise).
- **Expiration automatique 24 mois** des données enrichies par le moteur de recherche interne (Ligne rouge n°4).

### 5.5 Mesures de portabilité (article 20 RGPD)

- **Export JSON** accessible à vie depuis `/account/privacy` (y compris après expiration du trial, après désabonnement, après suppression du compte tant que la fenêtre comptable n'est pas close).
- **Format structuré et lisible par machine** (JSON UTF-8).
- **Rate-limiting** : 5 exports par tranche de 24h.

### 5.6 Mesures de rectification (article 16 RGPD)

- **Modification directe** depuis l'interface utilisateur pour les données opérationnelles.
- **Canal DPO** (dpo@movup.io) pour les demandes complexes ou contestées.

### 5.7 Mesures de sécurité techniques (article 32 RGPD)

- **Chiffrement AES-256-GCM** des credentials sensibles (mailbox OAuth tokens).
- **HTTPS obligatoire** sur l'ensemble des routes (HSTS Cloudflare).
- **Authentification** par middleware `requireAuthHtml` avec whitelist explicite de 14 routes applicatives.
- **Multi-tenant scoping** par `userId` sur l'ensemble des routes business (12 pages migrées).
- **Séparation stricte cache mutualisé / notes privées** (Ligne rouge n°3, architecture cible V1.0 — déploiement fin juin 2026) : table `company_public` partagée entre abonnés ne contiendra que des données publiques d'entreprise, table `company_enrichment_user` privée par abonné contiendra les notes commerciales personnelles, aucune fuite possible entre les deux. À la date d'effet du présent document (1er juin 2026), ces deux tables ne sont pas encore présentes en base de production : aucune fiche d'entreprise n'est stockée par MovUP, les notes commerciales des abonnés sont rattachées aux entités existantes (`pipeline`, `contacts`) avec multi-tenant scoping par `userId`.
- **Respect du robots.txt** par le moteur de recherche interne sur chaque domaine consulté.
- **Webhook Stripe** vérifié par signature `STRIPE_WEBHOOK_SECRET`.
- **Idempotence** sur événements Stripe (table dédiée).
- **Pas de stockage de données de carte bancaire** (sous-traité à Stripe, PCI-DSS Level 1).

### 5.8 Mesures organisationnelles

- **Souveraineté technique** : pas de recours à un prestataire tiers de scraping ni d'agrégation commerciale de données B2B (ScrapingBee, Bright Data, Pappers, Apollo, Lusha…). Seul est admis l'accès aux sources publiques via un processor UE sous SCC — en l'espèce Dataforseo OÜ, pour la consultation de la fiche Google My Business publiée par le professionnel (cf. Section 9, Doctrine 9 amendée).
- **Sous-traitants encadrés** par contrats art. 28 RGPD (cf. cartographie sous-traitants — infrastructure, services techniques essentiels et accès à sources publiques via processor UE sous SCC, à l'exclusion de tout agrégateur commercial de données B2B).
- **Hébergement européen exclusif** (Railway europe-west4, SurrealDB Cloud AWS eu-west-1 Dublin, Resend eu-west-1 Dublin).
- **Pas de transfert hors UE** à la date d'effet du présent document.
- **Documentation** : présent document + registre art. 30 + AIPD art. 35 + PHASE_6_RGPD_COMPLETE.md (journal technique).
- **Revue semestrielle** de la balance test (prochaine revue : 1er décembre 2026).

### 5.9 Mesures procédurales en cas de violation (article 33-34 RGPD)

- **Notification à la CNIL** sous 72h en cas de violation de données présentant un risque pour les droits et libertés des personnes.
- **Communication aux personnes concernées** sans délai en cas de risque élevé.
- **Registre interne** des violations (article 33.5 RGPD).

---

## Section 6 — Durées de conservation

| Catégorie de donnée | Durée de conservation | Base légale |
|---|---|---|
| Prospect non contacté | 3 ans à compter de la collecte | Doctrine CNIL prospection commerciale |
| Prospect contacté sans réponse | 3 ans à compter du dernier contact | Doctrine CNIL prospection commerciale |
| Données enrichies par moteur interne | 24 mois à compter de la dernière mise à jour | Doctrine interne (Ligne rouge n°4) |
| Prospect ayant exercé son droit d'opposition (blocklist) | Conservation pérenne du hash SHA-256 | Démonstration du respect de l'opposition (art. 5.2) |
| Compte utilisateur actif | Durée de la relation contractuelle | Article 6.1.b RGPD |
| Compte utilisateur clôturé (données comptables) | 10 ans | Code de commerce art. L123-22 |
| Logs techniques | 12 mois | Article 6.1.f RGPD (intérêt légitime sécurité) |
| Tokens OAuth | Durée de validité Google + refresh, révocation immédiate sur disconnect | Article 6.1.b RGPD |

---

## Section 7 — Droits des personnes concernées

Les personnes concernées disposent des droits suivants, exerçables auprès du DPO (dpo@movup.io) :

- **Droit d'accès** (article 15 RGPD) — réponse sous 1 mois (incluant les métadonnées par champ : source, horodatage de collecte)
- **Droit de rectification** (article 16 RGPD) — réponse sous 1 mois
- **Droit à l'effacement** (article 17 RGPD) — réponse sous 1 mois
- **Droit à la limitation** (article 18 RGPD) — réponse sous 1 mois
- **Droit à la portabilité** (article 20 RGPD) — disponible à vie via /account/privacy
- **Droit d'opposition** (article 21 RGPD) — prise d'effet sous 24h via /optout, propagation instantanée sur base partagée
- **Droit de ne pas faire l'objet d'une décision automatisée** (article 22 RGPD) — sans objet, aucun profilage automatisé
- **Droit d'introduire une réclamation** auprès de la CNIL (www.cnil.fr) ou de toute autre autorité de contrôle compétente

---

## Section 8 — Cadre juridique applicable

### 8.1 France

- Règlement (UE) 2016/679 (RGPD)
- Loi n°78-17 du 6 janvier 1978 modifiée (Informatique et Libertés)
- Délibération CNIL n°2020-091 du 17 septembre 2020 (cookies et autres traceurs)
- Doctrine CNIL prospection commerciale (mise à jour février 2025)
- Code de la consommation art. L121-1 et L121-2 (pratiques commerciales)
- Code de commerce art. L123-22 (conservation comptable)
- Loi n°2016-1321 du 7 octobre 2016 (République numérique, données SIRENE)
- Article L342-3 du Code de la propriété intellectuelle (protection des bases de données) — respect par limitation aux mentions légales LCEN volontairement publiées et au respect du robots.txt
- Article 19 de la LCEN (loi n°2004-575 du 21 juin 2004 pour la confiance dans l'économie numérique) — fondement de la publication des mentions légales d'entreprise

### 8.2 Belgique (expansion future)

- Règlement (UE) 2016/679 (RGPD)
- Loi du 30 juillet 2018 relative à la protection des personnes physiques à l'égard du traitement de données à caractère personnel
- Code de droit économique, livre VI (pratiques du marché)
- Loi du 11 mars 2003 sur les services de la société de l'information

### 8.3 Suisse (expansion future)

- Loi fédérale sur la protection des données du 25 septembre 2020 (nLPD, en vigueur depuis le 1er septembre 2023)
- Ordonnance sur la protection des données du 31 août 2022 (OPDo)

### 8.4 Québec (expansion future)

- Loi modernisant des dispositions législatives en matière de protection des renseignements personnels (Loi 25, en vigueur depuis le 22 septembre 2023)
- Loi sur la protection des renseignements personnels dans le secteur privé

---

## Section 9 — Doctrine interne et arbitrages

Les arbitrages techniques et organisationnels suivants, formalisés au cours de la Phase 6 RGPD (mai 2026), constituent la doctrine interne de So Paradi en matière de prospection commerciale. Ils sont opposables à toute évolution du dispositif sans révision préalable du présent document.

### Doctrine 1 — Filtrage opt-out à double rempart

Le filtrage des contacts ayant exercé leur droit d'opposition est mis en œuvre à **deux niveaux** :

- **Upstream silencieux** : exclusion des résultats sur `/api/search` et `/api/sirene/search` sans signal visible (anti-revelation). Aucune fiche masquée n'est signalée à l'utilisateur, empêchant toute énumération.
- **Refus dur en aval** : `POST /api/pipeline` retourne 403 si l'identifiant cible est en blocklist, garantissant qu'aucune fiche en blocklist ne peut être insérée même par contournement du filtrage upstream.

Cette architecture est délibérée et constitue un verrou de dernier ressort.

### Doctrine 2 — Fail-open assumé en faveur des personnes concernées

En cas d'erreur technique de la base de données blocklist, le système est conçu pour **interrompre l'enrichissement** plutôt que de risquer une inclusion erronée d'un contact en opposition. Le tradeoff est délibérément en faveur des personnes concernées.

Toute occurrence est tracée dans les logs et fait l'objet d'une alerte interne.

### Doctrine 3 — Hachage SHA-256 systématique

Tous les identifiants opt-out (email, téléphone) sont **hachés en SHA-256 hex** avant stockage. Une normalisation `.trim()` est appliquée avant hachage pour neutraliser les espaces parasites.

Cette mesure protège l'identifiant en clair tout en permettant la vérification d'appartenance à la blocklist.

### Doctrine 4 — Suppression compte : hard delete + conservation comptable + anonymisation audit

Lors d'une suppression de compte (art. 17 RGPD) :

- **Hard delete** des données personnelles opérationnelles,
- **Conservation comptable** sur 10 ans des seuls éléments imposés par le Code de commerce art. L123-22 (factures, écritures comptables, frais),
- **Anonymisation** de la table audit_log (préservation de la traçabilité technique sans identifiabilité),
- **Délai d'annulation de 7 jours** avant exécution effective,
- **Refus 409** si abonnement Stripe actif.

### Doctrine 5 — Footer art. 14 par sur-inclusion

Le footer d'information art. 14 RGPD est injecté **sur toutes les campagnes** (sur-inclusion délibérée), **côté serveur** (anti-bypass DOM), avec un **lien opt-out personnalisé par destinataire**.

Aucune exception n'est admise. Toute communication de prospection sortante comporte le footer.

### Doctrine 6 — Idempotence opt-out UX-level

L'idempotence du tunnel opt-out est gérée au niveau **UX** : tout clic ultérieur sur un magic link déjà consommé produit la même réponse silencieuse, sans information sur l'état réel de la demande (anti-énumération).

Le flood est borné par un rate-limit de 3 demandes par tranche de 24h par IP.

### Doctrine 7 — Bon père de famille préventif > défensif

Le visible (CTA, wording, formulaires publics) prime sur le caché (CGU, mentions légales). Les CTA d'essai gratuit sont unifiés sur un wording neutre (« Commencer l'essai gratuit ») avant que les CGU soient invoquées en défense, garantissant la conformité à l'article L121-1 du Code de la consommation (pratique du professionnel diligent).

### Doctrine 8 — Refus des sous-traitants tiers non-UE par défaut

La protection anti-bot des formulaires publics utilise un **honeypot et une question logique** plutôt qu'un CAPTCHA tiers non-UE (type reCAPTCHA Google), afin de limiter les transferts de données hors UE.

### Doctrine 9 — Souveraineté technique : exclusion du scraping et de l'agrégation commerciale B2B ; admission encadrée de l'accès aux sources publiques via processor UE sous SCC

**Principe — la souveraineté reste la règle.** L'enrichissement des fiches prospects est assuré **à titre principal par un moteur de recherche interne** opéré sur l'infrastructure du responsable de traitement. So Paradi écarte **par principe** le recours à tout prestataire tiers de **scraping** ou d'**agrégation commerciale de données B2B**, y compris :

- ScrapingBee, Scrapfly, Bright Data, Apify et tout autre fournisseur de scraping en marque blanche,
- Pappers, Société.com, Manageo et tout autre agrégateur de données B2B,
- Dropcontact, Apollo, Lusha, ZoomInfo, Hunter.io et tout autre fournisseur de bases de contacts enrichies,
- toute API d'enrichissement commercial reposant sur des bases agrégées par des tiers.

Ces prestataires **demeurent exclus**. Le fondement de cette exclusion est inchangé :

- la maîtrise complète de la chaîne de traitement (article 5.2 accountability),
- la limitation des transferts de données hors UE non maîtrisés (articles 44-49 RGPD),
- la prévention des risques de responsabilité conjointe (CJUE C-40/17 Fashion ID),
- la lisibilité totale du périmètre traité pour les personnes concernées exerçant leur droit d'accès,
- la cohérence avec la doctrine du responsable de traitement exprimée de manière constante depuis avril 2026.

**Exception motivée et bornée — l'accès à une source publique via un processor UE sous SCC.** La présente doctrine distingue deux réalités que sa rédaction initiale confondait :

1. l'**agrégation commerciale B2B** — constitution et revente, par un tiers, de bases de contacts dont la chaîne de consentement amont est opaque : **prohibée**, cf. ci-dessus ;
2. l'**accès à une source publique déterminée** — une donnée professionnelle publiée par le professionnel lui-même — opéré par un simple prestataire technique agissant comme processor : **admis**, au même régime que les autres sources publiques déjà mobilisées (SIRENE/INSEE, Etalab, BAN, Overpass, mentions légales LCEN).

À ce second titre, et **à ce seul titre**, So Paradi admet le recours au processor **Dataforseo OÜ** (Vesivärava tn 50-201, Kesklinna linnaosa, Tallinn, Harju maakond, Estonie 10152 ; Company No. 14502291 ; ISO 27001 ; DPO Nick Chernets, info@dataforseo.com) pour la consultation de la **fiche publique Google My Business** de l'entreprise ciblée, via l'API Business Data / Google My Business Info (live).

Cette exception est **bornée** par les garanties suivantes, cumulatives :

- **Nature de la source** : donnée professionnelle publique, renseignée et diffusée volontairement par le professionnel lui-même sur sa fiche Google My Business à des fins de contact commercial. Il ne s'agit pas d'une base agrégée par un tiers, mais d'une source déterminée et publique.
- **Rôle du prestataire** : Dataforseo OÜ agit comme **processor** (sous-traitant art. 28 RGPD), non comme fournisseur de données propriétaires ; MovUP demeure **controller**. Le DPA DataForSEO (https://dataforseo.com/wp-content/uploads/2022/09/DataForSEO_DPA.pdf) formalise cette répartition (SCC processor→controller).
- **Localisation et transferts** : prestataire établi en Estonie (UE). L'infrastructure sous-traitante (Google LLC, Microsoft Azure, US) est encadrée par les clauses contractuelles types UE 2021/914 (4 juin 2021). Aucune donnée sensible n'est transférée — uniquement des *contact information appearing on a SERP*, à l'exclusion de tout numéro de sécurité sociale, mot de passe ou identifiant.
- **Minimisation** : le paramètre de requête est réduit au strict nécessaire (nom de l'entreprise + ville). Aucune donnée de la personne concernée n'est transmise au processor au-delà de cette clé de recherche.
- **Subsidiarité** : l'appel au processor n'a lieu **qu'en dernier ressort**, lorsque les canaux gratuits (moteur interne sur site officiel, mentions légales) n'ont rien restitué. Il n'est jamais un canal de premier rang.
- **Restitution limitée aux champs de société** : le canal DataForSEO n'écrit que website et societe_tel, en fill-if-empty, sur la fiche de l'établissement. Aucune donnée nominative n'est restituée — pas de nom, pas d'email personnel ; le dirigeant_nom, lorsqu'il existe, sert uniquement de validateur de concordance et n'est jamais écrit ni exposé. La coordonnée publiée par l'exploitant sur sa fiche publique GMB est traitée comme coordonnée professionnelle par destination, quelle que soit sa forme.
- **Rétention côté processor** : SERP 31 jours, HTML 7 jours, pingback/postback 6 mois, tâches / résultats / payload 12 mois (durées contractuelles DataForSEO).

Cette exception **ne rouvre pas** la porte à l'agrégation commerciale : elle est strictement limitée à l'accès aux sources publiques via un processor UE sous SCC. Tout autre prestataire — et en particulier tout agrégateur ou fournisseur de bases B2B — demeure soumis à l'exclusion de principe.

Toute évolution de cette doctrine (introduction d'un prestataire de scraping ou d'agrégation commerciale, ou extension de l'accès à d'autres sources via un processor tiers) impose une **révision préalable du présent document** et une nouvelle balance test.

### Doctrine 10 — Cinq lignes rouges du moteur de recherche interne

Le moteur de recherche interne MovUP, dans l'architecture cible V1.0 (déploiement programmé fin juin 2026), fonctionnera sous cinq lignes rouges non négociables. Ces lignes rouges sont posées dès la présente date d'effet (1er juin 2026) comme contrainte de conception, opposable à toute évolution future. À la date d'effet, le moteur n'est pas encore en service.

1. **Rejet de l'email nominatif** : tout email correspondant au motif `[a-z]+\.[a-z]+@` (typiquement `prenom.nom@`) est rejeté silencieusement à l'écriture. Seuls les emails génériques d'entreprise sont admis.
2. **Refus de LinkedIn et réseaux sociaux personnels** : aucune donnée n'est collectée depuis LinkedIn (CGU 2024) ni depuis un profil personnel sur quelque plateforme que ce soit. Seules les pages entreprises publiques sur sites officiels sont consultées.
3. **Séparation stricte cache mutualisé / notes privées** : à compter de la V1.0, la table `company_public` partagée entre abonnés ne contiendra que des données publiques d'entreprise. La table `company_enrichment_user` privée par abonné contiendra les notes commerciales personnelles. Aucune fuite possible entre les deux.
4. **Expiration automatique 24 mois** : toute donnée enrichie par le moteur de recherche interne expire automatiquement 24 mois après sa dernière mise à jour. Au-delà, soit la donnée est re-vérifiée, soit elle est purgée.
5. **Propagation instantanée de l'opt-out sur base partagée** : l'insertion d'un identifiant en blocklist est immédiatement effective pour tous les abonnés MovUP. À la date d'effet du présent document (1er juin 2026), l'identifiant disparaît des résultats des API SIRENE et ne peut plus être inséré en pipeline. À compter de la V1.0, il disparaîtra également du cache mutualisé et ne pourra plus être enrichi par le moteur de recherche interne.

---

## Section 10 — Validité, opposabilité et revue

### 10.1 Validité

Le présent document est **valide à compter du 1er juin 2026** (date d'effet correspondant au lancement commercial MovUP) et **demeure valide jusqu'à révision** formelle dans les conditions définies au point 10.3 ci-après.

### 10.2 Opposabilité

Le présent document est **opposable** :

- à toute autorité de contrôle compétente (CNIL, APD belge, PFPDT suisse, CAI Québec),
- à toute personne concernée exerçant ses droits,
- à toute juridiction saisie d'un litige relatif au traitement.

Il peut être communiqué sur simple demande adressée au DPO.

### 10.3 Revue et mise à jour

Le présent document fait l'objet d'une **revue semestrielle systématique** (prochaine revue : 1er décembre 2026).

Une **revue exceptionnelle** est déclenchée en cas de :

- modification substantielle des finalités ou des moyens du traitement,
- évolution du cadre juridique applicable (jurisprudence, lignes directrices CNIL ou EDPB, modification réglementaire),
- ajout d'un sous-traitant ou d'un transfert de données hors UE,
- **introduction de tout prestataire tiers de scraping ou d'enrichissement commercial** (réserve expresse de la Doctrine 9),
- extension géographique du périmètre opérationnel (Belgique, Suisse, Québec),
- violation de données impactant le traitement,
- introduction de fonctionnalités d'IA (à documenter spécifiquement),
- demande formelle d'une autorité de contrôle.

### 10.4 Conservation et archivage

Le présent document et ses versions antérieures sont **conservés sans limitation de durée** au titre de l'accountability (article 5.2 RGPD), dans le répertoire `docs/rgpd/` du dépôt source Soparadi/mup, avec horodatage Git assurant l'intégrité temporelle.

---

## Section 11 — Signature et engagement

Le présent document est établi sous la responsabilité de Benoît Fouquet, en sa qualité de responsable de traitement, et engage l'entreprise individuelle So Paradi (SIRET 453 388 456 00031) au titre de l'ensemble de son activité de prospection commerciale dans le cadre de MovUP.

L'ensemble des mesures protectrices documentées en Section 5 est **effectivement mis en œuvre** à la date d'effet du présent document, conformément à l'état du système consigné dans le document `docs/PHASE_6_RGPD_COMPLETE.md` (tag git `v1.0.0-rgpd`, HEAD prod `583b380`), à l'exception du moteur de recherche interne dont la mise en service technique est concomitante à l'activation commerciale du 1er juin 2026.

**Fait à Dinan, le 25 mai 2026**

**Benoît Fouquet**
Responsable de traitement — So Paradi (EI)
SIRET 453 388 456 00031
dpo@movup.io

---

*Document de référence interne — LIA-MOVUP-001 v1.1 — Conformité art. 5.2 + 6.1.f RGPD*

*Historique des versions :*
*— v1.0 (25 mai 2026, matin) : version initiale, mention prématurée de ScrapingBee en V1.1, retirée en v1.1.*
*— v1.1 (25 mai 2026, après-midi) : Doctrine 9 « Souveraineté technique » intégrée. Doctrine 10 « Cinq lignes rouges du moteur de recherche interne » ajoutée. Moteur de recherche interne MovUP documenté en Section 3.4. Toutes mentions ScrapingBee, Pappers, Dropcontact, Qwant, Brave Search en tant que sous-traitants retirées. V1.0 du moteur de recherche interne (incluant scraper maison cheerio) confirmée comme partie intégrante du lancement 1er juin 2026.*
*— v1.2 (23 juillet 2026, révision exceptionnelle) : Doctrine 9 amendée — la souveraineté reste la règle et exclut le scraping et l'agrégation commerciale B2B ; une exception motivée et bornée admet l'accès à la fiche publique Google My Business via le processor UE Dataforseo OÜ (sous SCC processor→controller), au même régime que les autres sources publiques. Intégration de ce canal subsidiaire au raisonnement de la balance (Sections 1.4, 2.3, 3.1, 3.3, 3.4, 4.7, 4.10, 5.1, 5.8). La balance demeure favorable.*
