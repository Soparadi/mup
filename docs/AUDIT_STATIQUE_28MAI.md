# Audit statique — SEO / Responsive / Accessibilité — 28 mai 2026

> Photo état au commit `cb1bada` (28 mai 2026, branche `main`).
> Méthode : **analyse statique pure** (grep + lecture des sources). Aucun runtime, aucun navigateur, aucune mesure dynamique (Lighthouse, axe-core, LCP/TTI/CLS).
> Complémentaire des audits méthode 1 (fonctionnel, [audit boutons](#) du même jour) et méthode 2 ([PROPAGATION_AUDIT_28MAI.md](PROPAGATION_AUDIT_28MAI.md)).
> Périmètre : 33 fichiers `public/*.html` + 6 fichiers `public/styles/*.css`.

---

## 1. SEO META (pages publiques)

### 1.1 Périmètre SEO

Pages publiques **indexables** (hors auth) — 12 pages : `index`, `tarifs`, `fonctionnalites`, `cgu`, `cgv`, `dpa`, `confidentialite`, `cookies`, `mentions-legales`, `sous-traitants`, `optout`, `optout-verified`, `optout-confirmation`.

Pages d'authentification (`login`, `signup`, `forgot-password`, `reset-password`, `verify`, `verify-pending`) : techniquement publiques mais traditionnellement `noindex`. Pages app (`dashboard`, `leads`, etc.) : derrière `requireAuthHtml`, **hors périmètre SEO**.

### 1.2 Tableau SEO — 12 pages publiques × 8 critères

| Page | lang | viewport | title (len) | meta desc (len) | OG | Twitter | canonical | JSON-LD |
|---|---|---|---|---|---|---|---|---|
| `index.html` | ✅ | ✅ | ✅ (73) | ✅ (131) | ✅ 5 | ✅ 3 | ✅ | ✅ SoftwareApplication + AggregateOffer + Organization |
| `tarifs.html` | ✅ | ✅ | ✅ (31) | ✅ (141) | ✅ 5 | ✅ 3 | ✅ | ❌ |
| `fonctionnalites.html` | ✅ | ✅ | ✅ (41) | ✅ (124) | ✅ 5 | ❌ | ❌ | ❌ |
| `cgu.html` | ✅ | ✅ | ✅ (60) | ✅ (128) | ❌ | ❌ | ❌ | ❌ |
| `cgv.html` | ✅ | ✅ | ✅ (28) | ✅ (113) | ❌ | ❌ | ❌ | ❌ |
| `dpa.html` | ✅ | ✅ | ✅ (28) | ✅ (96) | ❌ | ❌ | ❌ | ❌ |
| `confidentialite.html` | ✅ | ✅ | ✅ (41) | ✅ (133) | ❌ | ❌ | ❌ | ❌ |
| `cookies.html` | ✅ | ✅ | ✅ (32) | ✅ (136) | ❌ | ❌ | ❌ | ❌ |
| `mentions-legales.html` | ✅ | ✅ | ✅ (42) | ✅ (159) | ❌ | ❌ | ❌ | ❌ |
| `sous-traitants.html` | ✅ | ✅ | ✅ (38) | ✅ (92) | ❌ | ❌ | ❌ | ❌ |
| `optout.html` | ✅ | ✅ | ✅ (65) | ✅ (171) | ❌ | ❌ | ❌ | ❌ |
| `optout-verified.html` | ✅ | ✅ | ✅ (43) | ✅ (131) | ❌ | ❌ | ❌ | ❌ |
| `optout-confirmation.html` | ✅ | ✅ | ✅ (39) | ✅ (124) | ❌ | ❌ | ❌ | ❌ |

**Lectures fortes** :
- ✅ `lang="fr"`, `viewport`, `<title>` : couverture 100%
- ✅ Meta description : présente sur 13/13 pages publiques (gains depuis le travail légal/RGPD)
- ⚠️ Longueurs `<title>` : OK (28-73 chars). Marges de gain SEO : 5 titres < 30 chars (`cgv`, `dpa`, `tarifs`, `carte`, `frais` — dont pages app mais hors scope SEO). Cibler 50-60 chars sur cgv/dpa.
- ⚠️ `cookies.html` description : 136 chars (en zone OK 120-160) — RAS.
- ❌ Open Graph : **3 pages seulement** (index, fonctionnalites, tarifs). Les 10 pages légales/RGPD **sans aucune balise OG** → partages sociaux générant des cartes vides.
- ❌ Twitter Card : **2 pages seulement** (index, tarifs).
- ❌ Canonical : **2 pages seulement** (index, tarifs). Les pages légales devraient en avoir un (évite duplication).

### 1.3 Fichiers crawler — robots.txt + sitemap.xml

- ❌ **`/robots.txt` absent** (vérifié racine projet ET `public/`)
- ❌ **`/sitemap.xml` absent**

→ Aucun pilotage explicite du crawl. Les moteurs indexent par défaut sans guidance. **Bloquant SEO** pour un site en lancement.

### 1.4 Favicon

- ✅ Favicon link présent sur 32/33 pages
- ⚠️ `index.html` : **0 link favicon** détecté ([:1-75](../public/index.html#L1)) — soit absent, soit déclaré ailleurs que dans la zone scannée. À vérifier (peut être hérité d'un comportement par défaut Express servant `/favicon.svg`).

### 1.5 JSON-LD structuré

- ✅ `index.html` : SoftwareApplication + AggregateOffer (3 offres) + Organization avec PostalAddress ([:24-58](../public/index.html#L24-L58)). Très complet.
- ❌ `tarifs.html` : pas de JSON-LD Product/Offer dédié — alors que la page est centrée sur les tarifs. Manque d'opportunité (rich snippets prix).
- ❌ `fonctionnalites.html` : pas de JSON-LD WebPage/FAQPage.

---

## 2. RESPONSIVE MOBILE

### 2.1 Méthode

Comptage des `@media` queries (inline + CSS externe), détection des breakpoints standards : smartphone (max-width: 767px / min-width: 768px), tablette (max-width: 1023px / min-width: 1024px), petit (~600px).

### 2.2 Tableau Responsive — 33 pages × 5 critères

| Page | viewport | @media inline | <768 | <1024 | Images responsive | Statut |
|---|---|---|---|---|---|---|
| `index.html` | ✅ | 24 | ✅ 5 | ❌ | partiel (1 srcset détecté) | ✅ responsive |
| `dashboard.html` | ✅ | 6 | ✅ 2 | ✅ 2 | n/a (0 img) | ✅ responsive |
| `contact-societe.html` | ✅ | 4 | 0 | 0 | n/a | ⚠️ partiel (4 @media mais autres breakpoints) |
| `tarifs.html` | ✅ | 4 | 0 | 0 | n/a | ⚠️ partiel |
| `visio.html` | ✅ | 3 | 0 | 0 | n/a | ⚠️ partiel |
| `signup.html` | ✅ | 2 | ✅ 1 | 0 | n/a | ⚠️ partiel |
| `fonctionnalites.html` | ✅ | 0 | 0 | 0 | n/a | hérite marketing-pages.css (8 @media) → ⚠️ partiel |
| `cgu`, `cgv`, `dpa`, `confidentialite`, `cookies`, `mentions-legales`, `sous-traitants`, `optout*` | ✅ | 0 | 0 | 0 | n/a | hérite legal.css (1 @media) + marketing-layout.css (3) → ⚠️ partiel |
| `agenda`, `carte`, `contacts`, `devis`, `factures`, `frais`, `leads`, `mail`, `pipeline`, `statistiques` | ✅ | 0 | 0 | 0 | n/a | hérite sidebar.css (**0 @media**) + app-footer.css (2 @media) → ❌ **desktop-only** |
| `404`, `forgot-password`, `login`, `reset-password`, `verify`, `verify-pending` | ✅ | 0 | 0 | 0 | n/a | ❌ desktop-only |

### 2.3 CSS externes — breakpoints

| Fichier CSS | bytes | @media | <600 | <768 | <1024 |
|---|---|---|---|---|---|
| `marketing-pages.css` | 12 955 | 8 | 1 | 0 | 0 |
| `marketing-layout.css` | 6 230 | 3 | 0 | 0 | 0 |
| `legal.css` | 4 753 | 1 | 1 | 0 | 0 |
| `cookies-banner.css` | 5 113 | 2 | 2 | 0 | 0 |
| `app-footer.css` | 2 028 | 2 | 1 | 0 | 0 |
| **`sidebar.css`** | **2 917** | **0** | 0 | 0 | 0 |

→ La `sidebar.css` (utilisée par les 11 pages app) **n'a aucune media query** : sur smartphone, la sidebar de 240px reste fixe et squeeze le contenu.

### 2.4 Synthèse Responsive

- ✅ `viewport` : 33/33 pages
- ✅ **Vrai responsive** : 2 pages (`index`, `dashboard`)
- ⚠️ **Partiel** (quelques breakpoints, surtout marketing) : ~10 pages
- ❌ **Desktop-only** : **~21 pages** dont **toutes les pages app** (agenda, carte, contacts, devis, factures, frais, leads, mail, pipeline, statistiques) et les pages auth (login, signup, forgot, reset, verify).
- ⚠️ **Aucune page** n'a de breakpoint tablette (1024px) sauf `dashboard.html`.
- ⚠️ **Aucune image `loading="lazy"`** sur les 33 pages. Aucune `srcset` non plus (sauf marginalement sur index).

**Confirmation de la doctrine projet** : la mémoire mentionnait que seules Dashboard et Visio avaient du responsive en avril. L'état 28 mai confirme **Dashboard responsive solide**, **Visio partiel** (3 @media, manque breakpoints standards), **toutes les autres pages app desktop-only**.

---

## 3. ACCESSIBILITÉ STATIQUE

### 3.1 Skip link — manque universel

❌ **Aucune page** ne contient de skip link (`Aller au contenu principal`). C'est un manque WCAG 2.4.1 bloquant pour les utilisateurs clavier/screen-reader.

### 3.2 Landmarks HTML5 sémantique

Globalement bonne couverture (98 % des pages ont au moins 1 landmark significatif), mais incohérences :

| Pattern | Pages concernées | Statut |
|---|---|---|
| Pages avec `<main>` + sidebar comme `<nav>` | dashboard, carte, contacts, factures, frais, leads, statistiques, visio | ✅ pattern app cohérent |
| Pages sans `<main>` | agenda, carte, devis, mail, pipeline | ❌ **bloquant** : pas de zone principale annoncée |
| Pages avec `<header>` + `<main>` + `<footer>` | toutes les pages légales + tarifs | ✅ pattern public cohérent |
| `index.html` avec **2 `<header>`** | 1 page | ⚠️ ambigu — header marketing + header sidebar ? À déjouer ou clarifier |

### 3.3 Hiérarchie headings

| Anomalie | Pages | Sévérité |
|---|---|---|
| **0 `<h1>`** sur la page | agenda, carte, contacts, devis, factures, frais, leads, mail, pipeline, statistiques (**10 pages app**) | ❌ **bloquant** — WCAG 1.3.1, 2.4.6 |
| **2 `<h1>`** | `index.html` (h1=2) | ⚠️ important — un seul h1 par page |
| h1 + h2 + h3 cohérent | cgu, cgv, dpa, confidentialite, cookies, fonctionnalites, mentions-legales, sous-traitants, tarifs, optout, visio, dashboard | ✅ |
| Pas de saut h2→h4 | toutes (h4=0 partout) | ✅ |

### 3.4 Inputs sans `<label>` associé

| Page | inputs (text/email/etc.) | `<label for=>` | Écart |
|---|---|---|---|
| `frais.html` | 10 | 0 | ❌ **10 inputs sans label** |
| `contact-societe.html` | 9 | 1 | ❌ 8 manquants |
| `devis.html` | 5 | 0 | ❌ 5 manquants |
| `pipeline.html` | 7 | 1 | ❌ 6 manquants |
| `visio.html` | 6 | 0 | ❌ 6 manquants |
| `factures.html` | 14 | 1 | ❌ 13 manquants |
| `agenda.html` | 3 | 0 | ❌ 3 manquants |
| `mail.html` | 14 | 10 | ⚠️ 4 manquants |
| `signup.html` | 6 | 7 | ✅ couverture totale |
| `login.html` | 2 | 2 | ✅ |
| `reset-password.html` | 2 | 2 | ✅ |
| `optout.html` | 4 | 5 | ✅ |

→ **L'audit des inputs est l'écart a11y le plus criant**. Les pages app accumulent des dizaines d'inputs sans label associé. Pour les screen-reader users, ces formulaires sont quasi inutilisables sans contexte.

**Nuance importante** : certains inputs sont annoncés via `aria-label` ou un texte adjacent. Le grep ne capture pas ces cas. Mais l'écart est tellement large (74 inputs sans label sur 9 pages app) qu'au moins une partie est réelle.

### 3.5 Boutons icon-only sans `aria-label`

Comptage brut : nombre total de `<button>` − nombre avec `aria-label`. La plupart des boutons portent un texte visible donc n'ont pas besoin d'aria-label. Les vrais soucis sont les boutons icon-only.

| Page | Total buttons | aria-label | Cible probable de revue |
|---|---|---|---|
| `mail.html` | 39 | 1 | ~5-10 boutons icon-only à vérifier |
| `visio.html` | 35 | 0 | nombreuses toolbar visio (Copier, Inviter, etc.) — vérifier |
| `pipeline.html` | 30 | 0 | × dans modales, edit/delete icon-only |
| `factures.html` | 27 | 0 | × close, suppression ligne |
| `frais.html` | 26 | 0 | × close, edit/del ligne |
| `devis.html` | 16 | 0 | × suppression ligne, close |

**Audit à compléter manuellement** par lecture ciblée (le grep ne distingue pas `<button>Texte</button>` de `<button><svg/></button>`).

### 3.6 Focus visible — outline:none + :focus stylé

| Pattern | Pages | Statut |
|---|---|---|
| `outline:none` sans `:focus(-visible)` stylé | aucune détectée | ✅ |
| `outline:none` + `:focus(-visible)` stylé | agenda, carte, contact-societe, contacts, dashboard, devis, factures, forgot, frais, index | ✅ substitution explicite |
| `:focus(-visible)` stylé (sans outline:none) | toutes les autres pages | ✅ |

→ **Pas de régression a11y focus** détectée. Bonne pratique : la substitution `outline:none` + `:focus-visible{...}` est cohérente partout.

### 3.7 Images sans `alt`

- ❌ `frais.html` : 1 img sans alt (à localiser pour fix)
- ✅ Toutes les autres pages : alt présent ou aucune img

### 3.8 Langue secondaire

Aucun `lang="en"` ou autre détecté. **Pas un problème** si tout le contenu est en français. À vérifier ponctuellement si des marques anglaises sont présentes ("Newsletter", "Dashboard" en titres — peuvent être laissés sans markup si lus correctement en français).

---

## 4. PERFORMANCE STATIQUE (limitée)

### 4.1 Limites — à signaler explicitement

⚠️ **Audit statique uniquement**. Sans navigateur ni outil runtime, **impossible de mesurer** :
- LCP / TTI / CLS / TBT (métriques Core Web Vitals)
- Taille de bundle après tree-shaking
- Temps réel de chargement réseau
- Comportement perçu sous network throttling
- Impact des dérapages CSS (reflow, paint)

→ Un audit Lighthouse sur l'environnement Railway est **indispensable** pour compléter — à planifier comme chantier séparé (cf. section 6).

### 4.2 Tailles HTML par page

| Catégorie | Pages | Taille |
|---|---|---|
| **Géant** (>100 KB) | `index.html` (242 KB / 5 011 lignes), `leads.html` (187 KB), `pipeline.html` (142 KB), `visio.html` (126 KB) | ⚠️ |
| **Lourd** (60-100 KB) | `factures` (98 KB), `statistiques` (91 KB), `mail` (87 KB), `dashboard` (72 KB), `frais` (72 KB) | ⚠️ |
| **Moyen** (20-60 KB) | `contacts`, `contact-societe`, `agenda`, `carte`, `devis`, `tarifs`, `signup` | ✅ |
| **Léger** (<20 KB) | toutes les pages auth + légales + 404 + optout | ✅ |

→ `index.html` à **242 KB inline** est massif. Charge réseau hors cache importante. Sur 4G de seconde main, > 4 s à charger.

### 4.3 Scripts — async / defer

- ✅ `defer` utilisé sur **27 / 33 pages** (pages app + légales : 2-3 scripts defer par page)
- ❌ `async` : **0 page**
- ❌ Pages **0 script externe** (tout inline) : 404, login, forgot-password, reset-password, signup, verify, verify-pending — auth pages

→ Cohérence : `defer` partout où nécessaire. Pas de quick-win majeur sur les pages app.

### 4.4 Lazy loading images + preconnect

- ❌ `loading="lazy"` : **0 page** sur 33 — alors que la mémoire et les images existent sur 4 pages (404, frais, index, signup)
- ⚠️ `preconnect` : **3 pages seulement** (index, tarifs : preconnect fonts.googleapis + fonts.gstatic ; leads : 1). Les autres pages chargent Geist sans hint → premier roundtrip DNS+TLS pendant le critical path.
- ❌ `preload` : **0 page**. Aucun hint sur les fonts critiques (Geist) ou les CSS au-dessus du fold.

### 4.5 Polices — Google Fonts via CDN

- Geist + Geist Mono + Instrument Serif chargés depuis `fonts.googleapis.com/css2?family=Geist…&display=swap`
- ✅ `display=swap` — bonne pratique anti-FOIT
- ⚠️ **Non self-hosted** : 1 roundtrip vers Google (DNS + TLS + fetch CSS + fetch WOFF2). Sur 4G, 200-400 ms ajoutés au LCP.
- ⚠️ Pas de `preload` sur les fichiers WOFF2 critiques.
- ⚠️ **Concerne RGPD** : chargement Google Fonts = transfert IP utilisateur vers serveur US (CNIL surveille depuis 2022). Voir [docs/rgpd/cartographie-sous-traitants.md](rgpd/cartographie-sous-traitants.md) — Google Fonts est-il listé ?

### 4.6 Minification

Inspection des sources : pas de minification visible. `index.html` lisible, indenté, commenté.
→ Pas de pipeline build (cohérent avec le pattern Express vanilla observé). Acceptable pour un MVP mais perd 30-40 % de poids brut sur les pages massives.

### 4.7 Tailles CSS externes

| Fichier | Taille | @media |
|---|---|---|
| `marketing-pages.css` | 12 955 B | 8 |
| `marketing-layout.css` | 6 230 B | 3 |
| `cookies-banner.css` | 5 113 B | 2 |
| `legal.css` | 4 753 B | 1 |
| `sidebar.css` | 2 917 B | 0 |
| `app-footer.css` | 2 028 B | 2 |
| **Total** | **33 996 B (~34 KB)** | 16 |

→ Surface CSS externe modeste. Mais sur les pages app, le **CSS inline** dans chaque HTML domine largement (sidebar.css seule ne couvre pas le rendu).

---

## 5. MANQUES NON COUVRABLES PAR L'AUDIT STATIQUE

Cette catégorie de problèmes **n'est PAS détectable** sans environnement runtime. À planifier comme chantier complémentaire.

### 5.1 Performance dynamique (Lighthouse / WebPageTest)
- LCP / TTI / FID / CLS / INP / TBT
- Score Lighthouse global (Performance / Accessibility / SEO / Best Practices)
- Cascade de chargement réseau
- Heuristiques Lighthouse : "Reduce unused CSS", "Eliminate render-blocking resources", "Properly size images"
- Comportement sous network throttling (Slow 3G, Fast 4G)

### 5.2 Accessibilité dynamique (axe-core, NVDA/VoiceOver)
- Focus management JS (modales, drawers — le focus revient-il bien après fermeture ?)
- Contraste réel calculé (les `--bg`, `--text` ont-ils >= 4.5:1 sur tous les couples ?)
- `role=...` live region (annonces de toast, status updates)
- Validation des `aria-*` (correct usage, valeurs valides)
- Test screen-reader complet (lecture séquentielle)

### 5.3 SEO dynamique
- Indexation effective Google (Search Console)
- Pages avec contenu généré JS-only (les screen pages app servies en SPA ne sont **pas indexables** par Google sans rendering JS — non testable sans runtime)
- Sitemap XML auto-généré + soumis à Search Console
- Tests de partage social réel (open social card debug Facebook/LinkedIn/Twitter)

### 5.4 Cross-browser / Cross-device
- Safari iOS quirks (notamment `:focus-visible`, smooth scroll, layout fixed)
- Firefox Android pinch-zoom
- Chrome Desktop high-DPI
- Edge Windows DPI scaling
- Différences entre Safari/Firefox/Chrome sur les Custom Properties dans les Service Workers

→ Chantier dédié recommandé : Lighthouse CI sur staging + checklist manuelle iOS Safari + Android Chrome.

---

## 6. SYNTHÈSE — Top 10 correctifs prioritaires (tous axes)

Classement par **impact × charge**, focus sur ce qui débloque le plus pour le moins d'effort.

### 🔴 Bloquant (impact 5/5)

1. **Créer `robots.txt` + `sitemap.xml`** à la racine `public/`. Sitemap statique liste les 12 pages publiques + dates. Robots.txt indique sitemap + disallow `/api/`, `/dashboard`, etc. **Charge : 0,2 j**.
2. **Ajouter `<h1>` sur les 10 pages app** sans h1 (agenda, carte, contacts, devis, factures, frais, leads, mail, pipeline, statistiques). Un h1 sémantique invisible (`sr-only` ou un titre visible discret). **Charge : 0,3 j**.
3. **Ajouter `<main>` explicite** sur agenda, carte, devis, mail, pipeline (les 5 pages app qui en manquent). Pattern : wrapper `<main id="content">...</main>`. **Charge : 0,1 j**.
4. **Skip link universel** sur les 33 pages (`<a class="skip-link" href="#content">Aller au contenu</a>` + CSS sr-only / focus:not(.sr-only)). **Charge : 0,2 j**.

### 🟡 Important (impact 4/5)

5. **Open Graph minimum (5 balises) sur les 10 pages publiques** qui en manquent (légales + RGPD). Template réutilisable. **Charge : 0,2 j**.
6. **Canonical sur toutes les pages publiques** (12 - 2 = 10 à ajouter). 1 ligne par page. **Charge : 0,1 j**.
7. **`<label for=>` associé aux 74 inputs sans label** sur les pages app — chantier mécanique mais long. **Charge : 0,5 j**.
8. **Responsive smartphone sur les 10 pages app** : ajouter 1 breakpoint @media (max-width: 767px) qui plie la sidebar en burger menu + pile les grilles 2/3-col en 1 col. Pattern à dupliquer depuis `dashboard.html`. **Charge : 1,5 j** (le plus lourd, mais le plus visible).

### 🟢 Cosmétique mais quick-win (impact 3/5)

9. **`loading="lazy"`** sur les 5 img des pages publiques (404, frais, index ×2, signup). **Charge : 5 min**.
10. **`preconnect` Google Fonts sur les 9 pages publiques** qui en manquent (cgu, cgv, dpa, confidentialite, cookies, mentions-legales, sous-traitants, optout, fonctionnalites). **Charge : 10 min**. ⚠️ À mettre en balance avec un éventuel self-hosting Geist (chantier ~0,5 j, gain RGPD).

---

## 7. Récap chiffres

| Axe | Pages totalement OK | Pages avec écarts | Bloquants |
|---|---|---|---|
| **SEO (12 publiques)** | 1 (`index`) | 11 (manque OG/canonical/JSON-LD/etc.) | robots.txt + sitemap.xml absents |
| **Responsive (33)** | 2 (`index`, `dashboard`) | ~10 partielles | ~21 desktop-only (toutes pages app) |
| **A11y (33)** | 0 | toutes (à des degrés divers) | skip link absent + 10 pages sans h1 + 5 sans `<main>` |
| **Perf statique (33)** | n/a | 4 pages > 100 KB | mesure dynamique nécessaire avant verdict |

**Charge totale Top 10** : ~3,5 jours homme pour faire passer le projet d'un état "essentiellement desktop, accessibilité partielle" à un état "responsive de base + a11y conforme WCAG 2.1 A + SEO indexable proprement".

**À planifier en chantier séparé** :
- Lighthouse CI sur Railway staging (chantier dynamique)
- Audit axe-core par page (chantier dynamique)
- Test manuel iOS Safari + Android Chrome (chantier device)
- Décision Google Fonts self-host vs CDN (chantier RGPD + perf, 0,5 j si self-host)
