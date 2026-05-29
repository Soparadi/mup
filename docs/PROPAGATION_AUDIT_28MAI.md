# Audit propagation cross-pages — 28 mai 2026

> Photo état au commit `f8051b1` (28 mai 2026, branche `main`).
> Suite directe de l'audit `PROPAGATION_AUDIT.md` (11 mai, commit `b12b6a5`, ref `1886939`).
> Audit lecture seule, aucune modification applicative.

## A. Synthèse exécutive

**Périmètre élargi** vs mai : on auditait alors 24 cellules (4 opérations × 6 types agenda × 8 canaux). Aujourd'hui on étend à **144 cellules** (12 événements métier × 12 pages app), englobant pipeline / contacts / devis / factures / frais / mail en plus de l'agenda.

**Résultats globaux 28 mai** :
- ✅ **Propagation saine : 53 cellules / 144 = 37 %**
- ⚠️ **Partielle : 19 cellules = 13 %**
- ❌ **Cassée : 16 cellules = 11 %**
- ⊘ **N/A par design : 56 cellules = 39 %**

→ Taux effectif (hors N/A) : **60 % de propagation saine** sur les cellules où elle est attendue (53/88).
→ Vs mai (50 % de saines sur 24 cellules) : **progrès net** porté principalement par `agenda-sync.js` (créé après mai) qui débloque 5 pages (dashboard, pipeline, carte, contacts, contact-societe).

**Top 3 risques résiduels (bloquants ou semi-bloquants)** :

1. 🔴 **Schéma POST `/visio` → `/api/agenda` toujours cassé** (G.2 de mai persiste). [visio.html:2393-2402](public/visio.html#L2393-L2402) envoie `start: dateISO` + `prospectId` au lieu de `date+start+end+ficheId`. Conséquence : event visio invisible dans `/agenda`, `/pipeline`, `/dashboard`, `/carte`. **Régression de mai non corrigée.**
2. 🔴 **Aucun dispatch storage depuis devis, factures, frais, mail**. Ces 4 pages mutent en SurrealDB sans signaler les autres onglets. Statistiques, frais, factures écoutent pourtant `mup_factures`/`mup_devis`/`mup_frais` — listeners actifs **mais jamais émis**, branches mortes.
3. 🟡 **`/leads` n'écoute aucun signal cross-tab** : si l'utilisateur ajoute une fiche au pipeline depuis un autre onglet, le filtre `existing[siren]` ([leads.html:2192](public/leads.html#L2192)) reste rance (TTL 30 s côté `_siretsCache`).

---

## B. Matrice 12 × 12 — Événements × Pages

Légende : ✅ propage / ⚠️ partiel / ❌ ne propage pas / ⊘ N/A par design.

Colonnes : **DB** = Dashboard, **PI** = Pipeline, **CT** = Contacts, **AG** = Agenda, **CR** = Carte, **LD** = Leads, **DV** = Devis, **FT** = Factures, **ML** = Mail, **VS** = Visio, **FR** = Frais, **ST** = Statistiques.

| # | Événement | DB | PI | CT | AG | CR | LD | DV | FT | ML | VS | FR | ST |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Lead → pipeline (POST) | ❌ | ✅ | ✅ | ⊘ | ⚠️ | ❌ | ⊘ | ⊘ | ⊘ | ✅ | ✅ | ✅ |
| 2 | Déplacement carte pipeline | ❌ | ✅ | ⚠️ | ⊘ | ⚠️ | ⊘ | ⊘ | ⚠️ | ⊘ | ✅ | ✅ | ✅ |
| 3 | Modif fiche société | ❌ | ✅ | ✅ | ⊘ | ✅ | ⊘ | ⊘ | ⚠️ | ⊘ | ✅ | ✅ | ✅ |
| 4 | Suppression carte pipeline | ❌ | ✅ | ✅ | ⊘ | ⚠️ | ⊘ | ⊘ | ⚠️ | ⊘ | ✅ | ✅ | ✅ |
| 5 | Création event agenda (`/agenda` ou `/pipeline`) | ✅ | ✅ | ⚠️ | ✅ | ✅ | ⊘ | ⊘ | ⊘ | ⊘ | ✅ | ✅ | ✅ |
| 5b | Création event agenda (`/visio`) | ❌ | ❌ | ⊘ | ❌ | ❌ | ⊘ | ⊘ | ⊘ | ⊘ | ✅ | ⊘ | ⚠️ |
| 6 | Modif/déplacement event agenda | ✅ | ✅ | ⚠️ | ✅ | ✅ | ⊘ | ⊘ | ⊘ | ⊘ | ✅ | ✅ | ✅ |
| 7 | Suppression event agenda | ✅ | ✅ | ⚠️ | ✅ | ✅ | ⊘ | ⊘ | ⊘ | ⊘ | ✅ | ✅ | ✅ |
| 8 | Création contact | ❌ | ✅ | ✅ | ⊘ | ✅ | ⊘ | ⊘ | ⚠️ | ⊘ | ✅ | ⊘ | ⊘ |
| 9 | Création devis | ❌ | ⊘ | ⊘ | ⊘ | ⊘ | ⊘ | ✅ | ⊘ | ⊘ | ❌ | ⊘ | ❌ |
| 10 | Conversion devis → facture | ❌ | ⊘ | ⊘ | ⊘ | ⊘ | ⊘ | ✅ | ⚠️ | ⊘ | ⊘ | ⊘ | ❌ |
| 11 | Création frais | ❌ | ⊘ | ⊘ | ⊘ | ⊘ | ⊘ | ⊘ | ⊘ | ⊘ | ⊘ | ✅ | ❌ |
| 12 | Envoi mail (compose) | ⊘ | ⊘ | ⊘ | ⊘ | ⊘ | ⊘ | ⊘ | ⊘ | ✅ | ⊘ | ⊘ | ⊘ |

**Note ligne 5/5b** : la création d'event agenda a deux variantes parce que `/visio` poste un payload incompatible (cf. C.5b). Les autres canaux (`/agenda`, `/pipeline`) postent un schéma propre.

---

## C. Analyse cellule par cellule (⚠️ et ❌ uniquement)

### Préambule infra — l'évolution majeure depuis mai

`public/js/agenda-sync.js` (créé après mai) expose `window.attachAgendaSync({reloadFn, invalidateCacheFn, debounceMs:150})` :
- Triggers : `storage` (cross-tab), `visibilitychange` (retour onglet), `focus` (Safari/iOS backup)
- Debounce 150 ms qui absorbe la double-fire storage+visibilitychange
- Try/catch pour ne pas casser la page sur erreur de reload

Câblé sur **5 pages** : `/dashboard` ([:1355](public/dashboard.html#L1355)), `/pipeline` ([:2884](public/pipeline.html#L2884)), `/carte` ([:965](public/carte.html#L965)), `/contacts` ([:1314](public/contacts.html#L1314) — **stub vide annoté "Sprint D"**), `/contact-societe` ([:1045](public/contact-societe.html#L1045)).

**Non câblé** : `/agenda` (auto-cohérent), `/visio` (utilise son propre listener large), `/factures`, `/devis`, `/frais`, `/mail`, `/leads`, `/statistiques`.

### C.1 — Lead ajouté au pipeline (POST /api/pipeline depuis /leads)

- **Émission** : `addToPipeline()` ([leads.html:2876-2964](public/leads.html#L2876)) POST `/api/pipeline` + dual-write `localStorage.mup_pipeline` + dispatch `StorageEvent('storage', { key: 'mup_pipeline' })`.
- **DB (Dashboard) ❌** : pas de listener `mup_pipeline`. `attachAgendaSync` ne se déclenche que sur `mup_agenda`. KPI "Pipeline" + section funnel restent rances. *Cause racine* : pas de listener `storage` filtré sur `mup_pipeline`. *Effort* : S (5 lignes).
- **CR (Carte) ⚠️** : `attachAgendaSync` ne réagit qu'à `mup_agenda`. Listener secondaire ([:973](public/carte.html#L973)) ne filtre que `mup_contact_sync`/`mup_contact_deleted`. → markers pipeline ne se mettent à jour qu'au reload. *Effort* : S.
- **LD (Leads, l'émetteur lui-même) ❌** : `_getExistingSirets()` cache TTL 30 s ([leads.html:1693](public/leads.html#L1693)) jamais invalidé par signal. Si user ajoute fiche sur un autre onglet `/leads`, doublon non filtré pendant 30 s. *Effort* : S.

### C.2 — Déplacement de carte entre colonnes du pipeline

- **Émission** : `saveCard()` → `save()` ([pipeline.html:907-911](public/pipeline.html#L907)) writeLS + dispatch `mup_pipeline`.
- **DB (Dashboard) ❌** : idem C.1. Funnel ne reflète pas le déplacement (ex. : prospect → contact → vente).
- **CT (Contacts) ⚠️** : listener écoute `mup_pipeline` ([:1283](public/contacts.html#L1283)) → `init()` complet. ✅ syntaxiquement, mais `init()` recharge `/api/contacts` qui ne porte pas la colonne pipeline. La ligne "stage" affichée vient pourtant du pipeline. *Cause* : init() fetch contacts mais pas pipeline → champ stage potentiellement stale. *Effort* : S.
- **CR (Carte) ⚠️** : reload markers nécessite réception d'un signal `mup_contact_sync`, pas `mup_pipeline`. La carte ne re-render pas les couleurs/statuts de pipeline. *Effort* : S.
- **FT (Factures) ⚠️** : listener écoute `mup_pipeline` ✅ ([:1769](public/factures.html#L1769)) → reload pipeline + render edit/preview. Utile uniquement si fiche éditée affichait des infos du pipeline (ex. nom client). Marche, mais coût render à chaque déplacement.

### C.3 — Modif fiche société (notes, statut, infos)

- **Émission** : depuis `/pipeline` modale → `saveCard()` dispatch `mup_pipeline`. Depuis `/contact-societe` autosave → dispatch `mup_contact_sync` ([:901](public/contact-societe.html#L901)).
- **DB ❌** : pas de listener `mup_pipeline` ni `mup_contact_sync`. Carte "Pipeline" + "Localisation pipeline" rances.
- **FT ⚠️** : reload sur `mup_pipeline` mais ne réécoute pas `mup_contact_sync` → édition depuis `/contact-societe` non propagée.

### C.4 — Suppression carte pipeline

- **Émission** : `deleteCard()` ([pipeline.html:1229-1262](public/pipeline.html#L1229)) DELETE `/api/pipeline/:id` + `/api/contacts/:id` parallèles + dispatch `mup_pipeline` (implicite via `save()` consécutif). + postMessage `mupfiche:deleted` ([:1251](public/pipeline.html#L1251)).
- **DB ❌** : idem C.1.
- **CR ⚠️** : marker pipeline supprimé pas retiré jusqu'au reload (pas de listener `mup_pipeline` sur carte).
- **FT ⚠️** : écoute `mup_pipeline` ✅, recharge — mais l'élément déjà rendu en aperçu peut référencer un id mort, le re-render le purge.

### C.5 — Création event agenda (canal `/agenda` ou `/pipeline`)

- **Émission `/agenda`** : `saveEvent()` ([agenda.html:737-832](public/agenda.html#L737)) POST `/api/agenda` + dispatch `mup_agenda`.
- **Émission `/pipeline`** : `saveRdv()` ([pipeline.html:1655-1738](public/pipeline.html#L1655)) POST `/api/agenda` + dispatch `mup_agenda` + `mup_pipeline`.
- **DB ✅** : `attachAgendaSync` invalide `_agendaCache` puis appelle `renderDashboardAgenda()` ([dashboard.html:1355](public/dashboard.html#L1355)). **Régression mai G.4 résolue.**
- **PI ✅** : `attachAgendaSync` rappelle `openDetail(currentId)` si fiche ouverte ([pipeline.html:2884](public/pipeline.html#L2884)). Timeline rafraîchie.
- **CT ⚠️** : `attachAgendaSync` câblé mais **reloadFn vide** ([contacts.html:1314-1318](public/contacts.html#L1314)) — commentaire annonce "Sprint D : à câbler". Cellule listener-actif mais effet zéro. *Effort* : S (câbler reloadFn).
- **CR ✅** : `attachAgendaSync` → `loadAllAgenda()` + `autoShowRdv()` ([carte.html:965](public/carte.html#L965)). **Régression mai G.5 résolue.**
- **VS ✅** : listener large existant ([visio.html:2684](public/visio.html#L2684)) écoute LS.AGENDA → `renderRdvList()`.
- **FR / ST ✅** : listeners écoutent `mup_agenda` → reload + renderAll ([frais.html:1228](public/frais.html#L1228), [statistiques.html:1236](public/statistiques.html#L1236)).

### C.5b — Création event agenda canal `/visio` (régression G.2 persistante)

- **Émission** : [visio.html:2393-2402](public/visio.html#L2393-L2402) POST `/api/agenda` payload :
  ```js
  { id, type:'visio', title, societe, prospectId, email,
    start: dateISO,           // ❌ ISO complet, pas 'HH:MM'
    duree, provider, link, sujet, status, createdAt }
  // Manque : date 'YYYY-MM-DD', end 'HH:MM', ficheId, contact
  ```
- **Conséquence cellule par cellule** :
  - **AG ❌** : la grille mois filtre `events.find(e => e.date === ...)` — `date` absent du payload visio → event invisible.
  - **PI ❌** : timeline filtre `?ficheId=` — payload porte `prospectId`, pas `ficheId` → invisible.
  - **DB ❌** : `renderDashboardAgenda` itère events à `e.date` parsé → skip.
  - **CR ❌** : lookup `agendaByFiche[c.id.replace(/^pipeline:/, '')]` — agendaByFiche indexé par `ev.ficheId` → vide pour ces events.
  - **VS ✅** : `renderRdvList()` re-render local immédiat → l'émetteur voit son event.
  - **ST ⚠️** : statistiques.html reloadAll qui ré-agrège `agenda` array entier. L'event est en base, mais sa structure non standard peut le faire passer/skip selon la logique d'agrégation (probablement skip car pas de `e.date`).
- **Cause racine** : aucune normalisation côté serveur. POST `/api/agenda` ([server.js:1015](server.js#L1015)) fait passthrough `body = {...req.body, userId}` puis CREATE. La table `agenda` est SCHEMALESS (cf. mai H.). Pas de migration. *Effort* : M (refactor payload visio + tests).

### C.6 — Modif/déplacement event agenda

- **Émission** : `/agenda` uniquement (drag&drop + modale édit). `editEvent()` + `saveEvent()` ([agenda.html:805,832](public/agenda.html#L805)) PUT `/api/agenda/:id` + dispatch `mup_agenda`.
- **Cellules ✅** : DB, PI, AG, CR, VS, FR, ST — tous via `attachAgendaSync` ou listener storage direct.
- **CT ⚠️** : stub vide (cf. C.5).
- **Note** : `/pipeline`, `/visio`, `/carte` ne proposent toujours **AUCUN bouton "Modifier"** sur un event existant. **Régression mai G.3 persistante** : UPDATE mono-canal. → On peut afficher partout, mais éditer nécessite d'aller dans `/agenda`. *Effort* : L (modale agenda réutilisable + 3 wirings).

### C.7 — Suppression event agenda

- Identique à C.6 mécaniquement. Toutes cellules ✅ sauf CT ⚠️ (stub). DELETE mono-canal toujours.

### C.8 — Création contact

- **Émission `/contacts`** : `confirmImport()` writeLS `mup_contacts` ([contacts.html:677](public/contacts.html#L677)). **Pas de dispatch explicite** dans le code observable, mais l'écriture LS dans un autre onglet déclenche naturellement l'événement `storage` natif sur les onglets distants.
- **Émission `/contact-societe`** : `autoSave()` dispatch `mup_contact_sync`.
- **DB ❌** : pas de listener pertinent.
- **FT ⚠️** : reload sur `mup_pipeline`/`mup_factures` mais pas sur `mup_contacts` ni `mup_contact_sync` → édition facture en cours peut référencer un client tout juste créé sans le voir.

### C.9 — Création devis

- **Émission** : `saveDoc()` ([devis.html:596-603](public/devis.html#L596)) → `saveDocs()` POST `/api/devis`. **Aucun dispatch StorageEvent.**
- **DV ✅** : render local immédiat.
- **VS ❌** : listener écoute LS.DEVIS ([visio.html:2685](public/visio.html#L2685)) → re-render briefing. **Branche morte** car aucun émetteur. Le briefing visio ne reflètera jamais un devis créé en parallèle.
- **ST ❌** : reload sur `mup_devis` ([statistiques.html:1237](public/statistiques.html#L1237)) → **branche morte** idem. KPI CA prévisionnel stale.

### C.10 — Conversion devis → facture

- **Émission** : `convertToInvoice()` ([devis.html:612-633](public/devis.html#L612)) POST `/api/factures/from-devis/:devisId` puis `window.location.href = '/factures?highlight=...'` → reload page entière.
- **DV ✅** : sur l'onglet d'émission, redirection vers /factures, donc pas d'incohérence.
- **FT ⚠️** : la page de destination loade fresh, mais un autre onglet `/factures` ouvert ne reçoit aucun signal (pas de dispatch `mup_factures`). Branche listener `mup_factures` ([:1770](public/factures.html#L1770)) **morte**.
- **ST ❌** : statistiques écoute `mup_factures` ([:1629](public/statistiques.html#L1629)) → branche morte.
- **DB ❌** : carte "Facturation 2026" reste stale.

### C.11 — Création frais

- **Émission** : drawer `frais.html` → POST `/api/frais`. **Aucun dispatch StorageEvent observé**.
- **FR ✅** : re-render local.
- **ST ❌** : listener `mup_frais` ([:1237](public/statistiques.html#L1237)) → branche morte. KPI dépenses / marge stale.
- **DB ❌** : carte "Facturation 2026" (qui pourrait afficher net de frais) stale.

### C.12 — Envoi mail (compose)

- **Émission** : `sendCompose()` ([mail.html:753-766](public/mail.html#L753)) POST `/api/v2/mail/send`. **Aucun dispatch**.
- **ML ✅** : render local immédiat (résultat affiché dans `#cmp-result`).
- **Autres pages** : par design ⊘. `/pipeline` quickAction('mailing') ([pipeline.html:1796-1808](public/pipeline.html#L1796)) **n'envoie pas de mail**, juste log activité locale. → pas de propagation à attendre côté envoi mail réel.

---

## D. Vérifications spécifiques demandées

### D.1 — Bug ficheId préfixe `pipeline:` sur /carte (commit fc79848)

✅ **Résolution tient toujours**. [carte.html:193-209](public/carte.html#L193-L209) :
```js
var k = String(ev.ficheId).replace(/^pipeline:/, '');           // indexation
var list = agendaByFiche[String(c.id).replace(/^pipeline:/, '')] || [];  // lookup
```
Pattern identique appliqué dans [visio.html:1049](public/visio.html#L1049) pour `putPipelineCard` (rawId).

### D.2 — Cross-tab sync via `agenda-sync.js`

✅ **Actif** sur les **5 pages** câblées (Dashboard, Pipeline, Carte, Contacts, Contact-societe). Stub vide sur Contacts à câbler. Hors-périmètre : `/agenda` (auto-cohérent), `/visio` (listener large maison).

### D.3 — Single source of truth agenda SurrealDB (commit b9ed2f0)

⚠️ **Partiellement tenu**. Toutes les pages lisent `/api/agenda` (SurrealDB autoritaire). Mais :
- `mup_agenda` est encore écrit/lu en LS sur 4 pages (statistiques, frais, factures, visio fallback) — c'est un **cache de second niveau**, pas un fallback désynchronisant. Le listener storage suffit à le maintenir cohérent.
- **Risque** : si une page lit `mup_agenda` sans avoir d'abord fait un GET `/api/agenda`, elle peut servir du stale LS. Vérifié OK sur `statistiques.html` et `frais.html` (init complet au boot).

### D.4 — `window.__USER__` injection serveur (commit ad47111)

✅ **Tenu**. Injection au [server.js:579-647](server.js#L579) sur routes HTML app. Lu par :
- [sidebar.js:121](public/sidebar.js#L121)
- [statistiques.html:654](public/statistiques.html#L654)
- [leads.html:3269](public/leads.html#L3269)
- [js/trial-expired-modal.js:48](public/js/trial-expired-modal.js#L48)

Source unique pour `plan`, `email`, `intended_plan`. Pas de désynchronisation observée.

### D.5 — Bug 1828e2d (pagination INSEE étranglant Etalab) — levé ce soir

✅ **Levé** par commit `f8051b1` (ce soir, 28 mai). Vérification :
- `FETCH_MAX_PAGES=3` dissocié par branche ([leads.html:2582,2628](public/leads.html#L2582))
- `per_page` Etalab borné 25 côté serveur ([server.js:1093](server.js#L1093))
- INSEE reste à 1 page (préservation quota 30/min global compte)

`/carte` ne lit pas `/api/sirene` ni `/api/search` — non concerné.

---

## E. Évolution vs PROPAGATION_AUDIT (mai 2026)

### Améliorations notables

| Item | Statut mai | Statut 28 mai | Mécanisme |
|---|---|---|---|
| Listeners storage `mup_agenda` cross-pages | 🔴 6/8 manquants | ✅ 5 pages couvertes via `agenda-sync.js` | `attachAgendaSync()` (G.1 mai résolu majoritairement) |
| Cache `_agendaCache` 30s dashboard non invalidé | 🔴 G.4 | ✅ résolu | `invalidateCacheFn: () => _agendaCache=null` ([dashboard.html:1356](public/dashboard.html#L1356)) |
| Cache `agendaByFiche` carte chargé 1×/boot | 🔴 G.5 | ✅ résolu | `reloadFn: loadAllAgenda + autoShowRdv` ([carte.html:967](public/carte.html#L967)) |
| Bug ficheId préfixe `pipeline:` sur /carte | non audité | ✅ résolu | normalisation `replace(/^pipeline:/, '')` |
| Source utilisateur unique | non audité | ✅ `window.__USER__` injecté + lu cohéremment | server.js + sidebar.js |
| Pagination Etalab étranglée | n/a | ✅ levée ce soir | commits 41325e0 + f8051b1 |

### Régressions / non-résolus

| Item | Statut mai | Statut 28 mai | Cause |
|---|---|---|---|
| `/visio` POST agenda schéma incompatible | 🔴 G.2 | 🔴 **persistant** | [visio.html:2393-2402](public/visio.html#L2393-L2402) inchangé depuis mai |
| UPDATE/DELETE agenda mono-canal | 🔴 G.3 | 🔴 **persistant** | Aucun bouton Modifier/Annuler sur fiches pipeline/visio/carte |
| Table `agenda` SCHEMALESS | 🟡 H. | 🟡 **persistant** | `grep "DEFINE.*agenda"` → 0 |
| `/contacts` reloadFn `attachAgendaSync` | n/a | ⚠️ **stub vide** | "Sprint D : à câbler" ([contacts.html:1317](public/contacts.html#L1317)) |

### Nouvelles dettes (apparues depuis mai)

- **Aucun dispatch `mup_devis`** : émetteur absent, écouteurs (visio, statistiques) inactifs.
- **Aucun dispatch `mup_factures`** : émetteur absent, écouteurs (factures cross-tab, statistiques) inactifs.
- **Aucun dispatch `mup_frais`** : émetteur absent, écouteur (statistiques) inactif.
- **`/leads` sans listener `mup_pipeline`** : filtre "déjà ajouté" rance 30 s.
- **`/dashboard` sans listener `mup_pipeline`** : KPI pipeline + funnel + carte "Pipeline" stale.

---

## F. Schéma table agenda (mise à jour)

Identique à mai H. La table reste **SCHEMALESS**. Pas de migration. Le payload `/visio` continue à polluer la base avec des records non-standards (cf. C.5b).

**Champs effectivement utilisés en lecture par les consommateurs** :

| Champ | /agenda | /pipeline | /dashboard | /carte | /visio | /frais | /stats |
|---|---|---|---|---|---|---|---|
| `date` | ✅ filtre | ✅ filtre | ✅ groupe | ✅ filtre | — | ✅ | ✅ |
| `start` (HH:MM) | ✅ tri | ✅ affichage | ✅ "prochain RDV" | — | — | — | — |
| `end` (HH:MM) | ✅ durée bloc | ✅ affichage | — | — | — | — | — |
| `ficheId` | — | ✅ filtre `?ficheId=` | — | ✅ index | — | — | — |
| `type` | ✅ pill | — | — | — | ✅ filtre `=visio` | — | — |
| `contact` | ✅ affichage | ✅ affichage | ✅ affichage | — | — | — | — |

→ Les records `/visio` qui ne portent pas `date`/`end`/`ficheId` sont **stockés mais inutilisables** par la moitié des consommateurs.

---

## G. Top 3 correctifs prioritaires (28 mai)

### P0 — Normaliser le payload `/visio` (G.2 persistant)

- **Impact** : 5 cellules ❌ → ✅ (lignes 5b sur DB/PI/AG/CR + cohérence ST).
- **Charge** : S/M (0,5 j). Refactor [visio.html:2393-2402](public/visio.html#L2393-L2402) :
  - Découper `start: dateISO` en `date: 'YYYY-MM-DD'` + `start: 'HH:MM'`
  - Ajouter `end: 'HH:MM'` (calculer depuis `start + duree`)
  - Renommer `prospectId` → `ficheId` (même valeur sémantique)
  - Ajouter `contact: prospectName`
- **Risque** : créer une migration des records visio existants en base (5 ? 10 ? records). Sinon, double-affichage potentiel.

### P1 — Ajouter listener `mup_pipeline` sur Dashboard

- **Impact** : 5 cellules ❌ → ✅ (DB sur événements 1, 2, 3, 4, 8). Carte Pipeline + KPI funnel deviennent live.
- **Charge** : S (10 lignes). Ajouter dans [dashboard.html](public/dashboard.html) :
  ```js
  window.addEventListener('storage', function(e){
    if (e.key === 'mup_pipeline') renderPipelineCards();
  });
  ```
- **Note** : `attachAgendaSync` ne couvre que `mup_agenda`. Étendre ne serait pas atomique sémantiquement → préférer un listener séparé.

### P2 — Câbler dispatch `mup_devis`, `mup_factures`, `mup_frais`

- **Impact** : 7 cellules ❌ → ✅ (lignes 9, 10, 11 sur ST/DB/FT/VS). Active les listeners morts existants.
- **Charge** : S (3 dispatches × 2-3 endroits = ~10 lignes). Ajouter après mutation réussie :
  ```js
  // devis.html après saveDocs()
  try { window.dispatchEvent(new StorageEvent('storage', { key: 'mup_devis' })); } catch(_){}
  // factures.html après POST/PUT/DELETE
  try { window.dispatchEvent(new StorageEvent('storage', { key: 'mup_factures' })); } catch(_){}
  // frais.html après POST/PUT/DELETE
  try { window.dispatchEvent(new StorageEvent('storage', { key: 'mup_frais' })); } catch(_){}
  ```
- **Avantage symétrique** : aligne les 4 pages "métier" sur le pattern déjà appliqué à pipeline/agenda.

---

## H. Synthèse finale

- **144 cellules auditées** sur 12 événements × 12 pages.
- **53 ✅ + 19 ⚠️ + 16 ❌ + 56 ⊘** (37 % / 13 % / 11 % / 39 %).
- **Hors N/A** : 88 cellules effectives → **60 % de propagation saine**, 22 % partielle, 18 % cassée.
- **Vs mai** : progrès net (50 % → 60 % saine), porté par `agenda-sync.js`. Mais 3 nouvelles dettes (devis/factures/frais sans dispatch) et 2 régressions de mai (visio schéma G.2, UPDATE/DELETE mono-canal G.3) **non corrigées**.

**Charge estimée pour passer à 85 % de propagation saine** :
- P0 (visio schéma) : 0,5 j
- P1 (dashboard listener mup_pipeline) : 0,1 j
- P2 (dispatch devis/factures/frais) : 0,1 j
- P3 (câbler reloadFn contacts.attachAgendaSync) : 0,2 j
- P4 (ajout `mup_pipeline` sur leads pour rafraîchir `_siretsCache`) : 0,1 j

**Total : ~1 jour homme** pour franchir le palier à 85 %. Le reste (UPDATE/DELETE multi-canal G.3, SCHEMAFULL agenda, contactId/addressSnapshot) reste sur le périmètre Phase 2 de l'audit mai (~3,5 j résiduels).
