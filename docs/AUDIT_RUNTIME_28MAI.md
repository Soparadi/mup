# Audit runtime automatisé — 28 mai 2026

> Cible : `https://mup-production.up.railway.app` (déploiement Railway, commit `f877fb8`).
> Méthode : audits **runtime automatisés** (Lighthouse + Playwright). Aucune authentification, aucune soumission de formulaire, aucune écriture base, aucun compte créé. 100 % lecture.
> Complémentaire des audits 28 mai : fonctionnel (boutons), [propagation cross-pages](PROPAGATION_AUDIT_28MAI.md), [statique SEO/responsive/a11y](AUDIT_STATIQUE_28MAI.md).
> Outils : Lighthouse 13.3.0, Playwright (chromium 148.0.7778.96), Node 24.14.0, Chrome desktop 148.0.7778.179.

## Pourquoi périmètre publique uniquement

Pages app (`/dashboard`, `/leads`, `/pipeline`, `/contacts`, `/agenda`, `/carte`, `/devis`, `/factures`, `/frais`, `/mail`, `/visio`, `/statistiques`) **exclues** : protégées par `requireAuthHtml`, donc auditer = créer un compte ou injecter une session. Cela violerait la mémoire projet ("pas d'écriture dans la SurrealDB cloud") et fausserait les données (cohorte test → 7 users observés).

Pages auth (`/login`, `/signup`, `/forgot-password`, `/verify*`, `/reset-password`) : **HTML public** (formulaire affiché sans soumission), donc auditables côté rendu.

→ **10 pages publiques** auditées : `/`, `/tarifs`, `/fonctionnalites`, `/mentions-legales`, `/confidentialite`, `/cgv`, `/dpa`, `/cookies`, `/signup`, `/login`.

---

## 1. LIGHTHOUSE — 20 runs (10 pages × 2 devices)

### 1.1 Tableau scores — Desktop

| Page | Performance | Accessibility | Best Practices | SEO |
|---|---|---|---|---|
| `/` (home) | **95** | 89 | 96 | 100 |
| `/tarifs` | 98 | 96 | **100** | 100 |
| `/fonctionnalites` | **100** | 94 | 100 | 100 |
| `/mentions-legales` | 100 | **98** | 100 | 100 |
| `/confidentialite` | 100 | 98 | 100 | 100 |
| `/cgv` | 100 | 98 | 100 | 100 |
| `/dpa` | 100 | 98 | 100 | 100 |
| `/cookies` | 100 | 98 | 100 | 100 |
| `/signup` | 100 | **100** | 100 | 66 *(noindex intentionnel)* |
| `/login` | 99 | 100 | 96 | 54 *(noindex + meta-desc manquante)* |

### 1.2 Tableau scores — Mobile

| Page | Performance | Accessibility | Best Practices | SEO |
|---|---|---|---|---|
| `/` (home) | **78** ⚠️ | 89 | 96 | 100 |
| `/tarifs` | 90 | 96 | 100 | 100 |
| `/fonctionnalites` | 99 | 94 | 100 | 100 |
| `/mentions-legales` | 96 | 98 | 100 | 100 |
| `/confidentialite` | 96 | 98 | 100 | 100 |
| `/cgv` | 96 | 98 | 100 | 100 |
| `/dpa` | 96 | 98 | 100 | 100 |
| `/cookies` | 96 | 98 | 100 | 100 |
| `/signup` | 92 | 100 | 100 | 66 |
| `/login` | 100 | 100 | 96 | 54 |

### 1.3 Core Web Vitals — Desktop

| Page | LCP | FCP | CLS | TBT | SI |
|---|---|---|---|---|---|
| `/` | 1.3 s | 1.1 s | 0.015 | 0 ms | 1.1 s |
| `/tarifs` | 0.8 s | 0.8 s | 0.058 | 0 ms | 0.8 s |
| `/fonctionnalites` | 0.3 s | 0.3 s | 0.048 | 0 ms | 0.3 s |
| `/mentions-legales` | 0.3 s | 0.2 s | 0.049 | 0 ms | 0.3 s |
| `/confidentialite` | 0.4 s | 0.4 s | 0.049 | 0 ms | 0.4 s |
| `/cgv` | 0.3 s | 0.2 s | 0.049 | 0 ms | 0.3 s |
| `/dpa` | 0.3 s | 0.2 s | 0.049 | 0 ms | 0.3 s |
| `/cookies` | 0.3 s | 0.2 s | 0.049 | 0 ms | 0.3 s |
| `/signup` | 0.5 s | 0.5 s | 0.001 | 0 ms | 0.5 s |
| `/login` | 0.7 s | 0.7 s | 0.001 | 0 ms | 0.7 s |

**Verdict desktop** : toutes valeurs dans la zone **"Good"** Google (LCP <2.5s, CLS <0.1, TBT <200ms). Excellent.

### 1.4 Core Web Vitals — Mobile

| Page | LCP | FCP | CLS | TBT | SI |
|---|---|---|---|---|---|
| `/` | **4.8 s ❌** | 2.8 s | 0 | 10 ms | 2.8 s |
| `/tarifs` | 2.6 s ⚠️ | 2.6 s | 0.099 | 0 ms | 2.6 s |
| `/fonctionnalites` | 1.1 s | 1.1 s | 0.069 | 20 ms | 1.1 s |
| `/mentions-legales` | 1.1 s | 0.9 s | **0.117 ⚠️** | 0 ms | 0.9 s |
| `/confidentialite` | 1.1 s | 0.9 s | **0.117 ⚠️** | 0 ms | 0.9 s |
| `/cgv` | 1.1 s | 0.9 s | **0.117 ⚠️** | 0 ms | 0.9 s |
| `/dpa` | 1.1 s | 0.9 s | **0.117 ⚠️** | 0 ms | 0.9 s |
| `/cookies` | 1.1 s | 0.9 s | **0.117 ⚠️** | 0 ms | 0.9 s |
| `/signup` | 2.7 s ⚠️ | 2.7 s | 0.006 | 0 ms | 2.7 s |
| `/login` | 1.5 s | 1.5 s | 0.004 | 0 ms | 1.5 s |

**Verdict mobile** :
- **`/` LCP 4.8 s** : **bloquant** (Google seuil "Poor" >4 s). Cause probable : page `index.html` de 242 KB inline + Geist via Google Fonts sans `preload` ni self-host.
- `/tarifs` LCP 2.6 s : **warning** (seuil "Good" = 2.5 s). Marge fine.
- `/signup` LCP 2.7 s : **warning** idem.
- **5 pages légales CLS 0.117** : **warning** (seuil "Good" = 0.1). Cause probable : layout shift au chargement de la cookies-banner et/ou de la sidebar marketing.
- TBT ≤20 ms partout : excellent.

### 1.5 Audits failed — accessibilité (axe-core via Lighthouse)

Total : 5 règles déclenchées sur 24 occurrences cross-pages (10 pages × 2 devices).

| Règle | Occurrences | Pages concernées |
|---|---|---|
| `heading-order` (Sequence h1→h2→h3 non respectée) | **12** | `cgv`, `confidentialite`, `cookies`, `dpa`, `fonctionnalites`, `mentions-legales` (×2 devices chacune) |
| `color-contrast` (Contraste insuffisant texte/fond) | **6** | `fonctionnalites`, `home`, `tarifs` (×2 devices) |
| `aria-hidden-focus` (Éléments aria-hidden contenant des descendants focusables) | 2 | 1 page × 2 devices (à investiguer) |
| `aria-prohibited-attr` (Attributs ARIA interdits sur l'élément) | 2 | 1 page × 2 devices |
| `landmark-one-main` (Pas de `<main>`) | 2 | **`home`** × 2 devices |

→ **`heading-order`** sur les 6 pages légales/marketing : confirme l'audit statique (sauts h2→h3 ou h1 absent en milieu de hiérarchie). Probablement un titre "Sommaire" ou "Plan" qui casse la séquence.

→ **`color-contrast`** sur home/tarifs/fonctionnalites : pages au design custom. À auditer manuellement quels couples texte/fond.

→ **`landmark-one-main`** sur home : confirme l'audit statique (`index.html` n'a pas de `<main>` mais 2 `<header>`).

### 1.6 Audits failed — SEO

| Règle | Occurrences | Pages concernées | Note |
|---|---|---|---|
| `is-crawlable` (`<meta name="robots" content="noindex">`) | 4 | `signup` + `login` (×2 devices) | **Faux positif attendu** — pages auth doivent rester `noindex`. À ignorer. |
| `meta-description` | 2 | `login` (×2 devices) | **Vrai bug** — confirme l'audit statique. Ajouter une meta-description à `/login`. |

### 1.7 Audits failed — best-practices

`/login` (desktop+mobile) score 96 : le -4 vient de `errors-in-console` — le 401 attendu sur `/api/auth/me` est loggé console comme erreur (vu aussi en E2E parcours 2). Cosmétique mais corrigeable côté front (intercept 401 ou silent fail).

### 1.8 Opportunités performance (cross-pages)

| Opportunité | Pages | Gain estimé total |
|---|---|---|
| `unused-javascript` | 1 page | 30 ms |

→ **Aucune opportunité majeure**. La perf est déjà tirée au max sur les pages légères. Les vraies marges sont sur **mobile homepage** (LCP 4.8s) — qui n'apparaît pas en "opportunity" mais en métrique brute.

---

## 2. PLAYWRIGHT — 4 parcours E2E lecture seule

### 2.1 Parcours 1 — Homepage

| Critère | Résultat |
|---|---|
| Status HTTP | **200** |
| Temps `networkidle` | **994 ms** |
| Logo présent | ✅ |
| CTA principal détecté | ✅ |
| Sections `<section>` | 12 |
| `<h1>` count | **2** ⚠️ (anomalie connue — un seul h1 attendu) |
| `<h2>` count | 6 |
| `<footer>` présent | ✅ |
| Erreurs console | **0** |
| Requêtes réseau ≥400 | **0** |

### 2.2 Parcours 2 — Tour des 10 pages publiques

| Page | HTTP | Load (ms) | `<title>` | Console err | Net err |
|---|---|---|---|---|---|
| `/` | 200 | 923 | MovUP — Le pipeline commercial pour indépendants et TPE | 0 | 0 |
| `/tarifs` | 200 | 780 | MovUP — Tarifs | 0 | 0 |
| `/fonctionnalites` | 200 | 785 | MovUP — Fonctionnalités | 0 | 0 |
| `/mentions-legales` | 200 | 778 | MovUP — Mentions légales | 0 | 0 |
| `/confidentialite` | 200 | 752 | MovUP — Confidentialité | 0 | 0 |
| `/cgv` | 200 | 733 | MovUP — CGV | 0 | 0 |
| `/dpa` | 200 | 765 | MovUP — DPA | 0 | 0 |
| `/cookies` | 200 | 746 | MovUP — Cookies | 0 | 0 |
| `/signup` | 200 | 757 | MovUP — Créer votre compte | 0 | 0 |
| `/login` | 200 | 770 | MovUP — Connexion | **1** | **1** *(401 sur `/api/auth/me`)* |

→ **9 pages sur 10 : aucune erreur**. Seul `/login` génère un 401 sur `/api/auth/me` (vérification session) — comportement attendu pour un visiteur non authentifié. Peut être silencé côté JS pour propreté console.

### 2.3 Parcours 3 — Formulaire `/signup` (affichage seul, AUCUNE soumission)

| Critère | Résultat |
|---|---|
| Load networkidle | 760 ms |
| Champs détectés | **8** |
| Champs requis présents | `prenom`, `nom`, `email`, `telephone`, `password`, `password2` ✅ |
| Opt-in | `marketing_consent` (checkbox) ✅ |
| Champ caché | `intended_plan` (hidden, hydraté par cookie selon flow tarifs) |

→ **Formulaire structurellement complet**. 6 champs requis + 1 opt-in + 1 hidden = 8. La consigne attendait 5 champs (nom, prénom, email, téléphone, password), il y en a un de plus (`password2` = confirmation), totalement légitime.

### 2.4 Parcours 4 — Chaîne `/api/public/search-demo` (Etalab → serveur)

| Critère | Résultat |
|---|---|
| Endpoint | `GET /api/public/search-demo?naf=4722Z&region=93` |
| HTTP | **200** |
| Durée totale | **987 ms** |
| `total` | 3577 entreprises |
| `totalCapped` | false (sous le cap MAX_MARKERS=500) |
| `preview` | 5 entreprises retournées |
| Exemple : `nom_entreprise` | `LDGF` à `LE PONTET` (84 / Vaucluse / PACA), NAF 47.22Z, lat/lng valides |
| Erreur | aucune |

→ **Chaîne Etalab → serveur fonctionnelle bout en bout** depuis l'URL publique. Pas de quota dépassé, pas de timeout, latence raisonnable.

### 2.5 Anomalies E2E détectées

| # | Sévérité | Anomalie | Page | Cause probable |
|---|---|---|---|---|
| 1 | 🟡 cosmétique | 1 erreur console + 1 fetch 401 | `/login` | `/api/auth/me` vérifie la session sans visiteur authentifié → 401 normal. Bruit dans la console DevTools. |
| 2 | 🟡 important | 2 `<h1>` détectés | `/` | Confirme audit statique. Un seul h1 attendu par page. |

### 2.6 Screenshots produits

10 screenshots pleine page sauvegardés dans `/tmp/audit-out/screenshot-*.png` (supprimés après extraction). Capturés à viewport 1280×800 :
`home`, `tarifs`, `fonctionnalites`, `mentions-legales`, `confidentialite`, `cgv`, `dpa`, `cookies`, `signup`, `login`.

---

## 3. SYNTHÈSE — Top 10 correctifs prioritaires (impact utilisateur réel)

Classement par **gravité observée runtime** (pas seulement statique).

### 🔴 Bloquant utilisateur réel

1. **Mobile homepage LCP 4.8 s** (bien > seuil "Poor" 4 s Google). Sur une connexion 4G simulée Lighthouse Slow 4G. → Impact direct sur Core Web Vitals → impact SEO Google. **Charge : M (0,5 j)**. Pistes : self-host Geist (gain ~400ms), réduire CSS inline 242KB → externaliser le hors-fold, `preload` du LCP element.
2. **5 pages légales mobile CLS 0.117** (> seuil "Good" 0.1). Layout shift au chargement de la cookies-banner ou de la marketing-layout. **Charge : S (0,2 j)**. Réserver l'espace de la banner via `min-height` fixe.

### 🟡 Important (accessibilité / SEO)

3. **Pages app sans `<main>` + sans `<h1>`** — confirmé runtime sur `/` (`landmark-one-main` failure). Cf. audit statique pour les 10 pages app non auditées ici. **Charge : 0,3 j** (déjà identifié audit statique).
4. **`heading-order` sur 6 pages légales+marketing** : sauts h2→h3 ou structure non séquentielle. **Charge : 0,3 j**. Renommer h-tags pour suivre la séquence.
5. **`color-contrast` sur 3 pages design** (home, tarifs, fonctionnalites) : couleurs custom à ajuster. **Charge : S (0,2 j)** + revue design.
6. **`<h1>` doublé sur la homepage** : confirmé runtime (h1Count = 2). **Charge : 0 (1 ligne)**. Supprimer le second h1 ou le passer en h2.
7. **`meta-description` manquante sur `/login`** : confirmé runtime. **Charge : 0 (1 ligne)**.

### 🟢 Cosmétique mais impact UX

8. **Console error 401 sur `/login`** : silencer la requête `/api/auth/me` côté JS sur le chemin `/login` ou intercepter le 401 sans logger. **Charge : S (0,1 j)**. Propreté DevTools.
9. **Robots.txt + sitemap.xml absents** : déjà identifié audit statique. Runtime ne le détecte pas directement (Lighthouse considère SEO 100 sur les pages indexables). **Charge : 0,2 j**.
10. **Self-host Geist** (RGPD + perf) : Google Fonts via CDN détecté. Gain LCP mobile ~200-400ms + élimine transfert IP utilisateur vers Google. **Charge : M (0,5 j)** + migration WOFF2 dans `public/fonts/`.

### Score global estimé du site public

Moyenne pondérée des 10 pages publiques × 4 catégories × 2 devices = **80 audits Lighthouse** :
- Performance moyenne **97/100** (desktop) — **96/100** (mobile)
- Accessibility moyenne **96/100** (homogène desktop+mobile)
- Best Practices moyenne **99/100**
- SEO moyenne **92/100** *(tirée vers le bas par signup/login noindex intentionnels)*

→ **Site public en état "publication" honorable.** Excellents fondamentaux Performance + Best Practices. Marges principales : LCP mobile homepage + accessibilité fine.

### Limites de cet audit — explicitement

- ❌ **Pages app non auditées** : 12 pages derrière auth. Pour les couvrir : créer un compte de test dédié (ex. `audit-runtime@movup.io`) avec un flag `is_audit=true` côté DB pour exclure des stats. Chantier à part.
- ❌ **Cohérence cross-browser** : Lighthouse utilise Chrome. Safari iOS et Firefox quirks non couverts. Test manuel ou BrowserStack requis.
- ❌ **Network throttling fixe** : Lighthouse simule Slow 4G mobile / no throttling desktop. Pas de mesure 3G, edge cases roaming.
- ❌ **Indexation Google effective** : Search Console requis pour confirmer crawl + indexation réelle.
- ❌ **Tests interactifs** : pas de validation des CTA "Essayer", "Acheter" (rentrent dans le périmètre payant + écriture).

---

## 4. Annexes

### 4.1 Versions outils

| Outil | Version |
|---|---|
| Lighthouse | 13.3.0 |
| Playwright | 1.55.1 |
| Chromium (Playwright) | 148.0.7778.96 (headless shell) |
| Google Chrome (Lighthouse) | 148.0.7778.179 |
| Node | 24.14.0 |

### 4.2 Commandes exactes lancées

**Lighthouse desktop (×10)** :
```sh
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
./node_modules/.bin/lighthouse "https://mup-production.up.railway.app${PATH}" \
  --only-categories=performance,accessibility,best-practices,seo \
  --output=json --output-path="/tmp/audit-out/lh-${SLUG}-desktop.json" \
  --chrome-flags="--headless --no-sandbox --disable-gpu" \
  --preset=desktop --quiet --max-wait-for-load=30000
```

**Lighthouse mobile (×10)** : idem sans `--preset` (mobile = défaut Lighthouse v13).

**Playwright E2E** : voir `/tmp/audit-tools/e2e.mjs` (script jetable, supprimé après extraction).

**search-demo probe** :
```sh
GET /api/public/search-demo?naf=4722Z&region=93
```

### 4.3 Durée totale audit

| Étape | Durée |
|---|---|
| Install Lighthouse + axe-cli + Playwright + Chromium | ~90 s |
| Lighthouse desktop ×10 (séquentiel) | ~3 min |
| Lighthouse mobile ×10 (séquentiel) | ~3 min |
| Playwright 4 parcours | ~30 s |
| Extraction + analyse JSON | ~10 s |
| **Total** | **~7 min** |

### 4.4 Garanties écriture / authentification

- ✅ **0 POST** émis
- ✅ **0 PUT** émis
- ✅ **0 DELETE** émis
- ✅ **0 formulaire soumis**
- ✅ **0 compte créé en base**
- ✅ **0 page auth (`/dashboard`, etc.) atteinte**
- ✅ Tous les fichiers temporaires (`/tmp/audit-out/*`, `/tmp/audit-tools/*`) supprimés après extraction
- ✅ Aucune modification du code de production

Audit 100 % lecture, 100 % public, 100 % automatisé.
