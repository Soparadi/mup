# Audit propagation CRUD agenda — Phase 1

> Photo état au commit `b12b6a5` (11 mai 2026), branche `main`.
> Audit lecture seule, aucune modification applicative.

## A. Synthèse exécutive

- **24 cellules CRUD/canal/cible auditées** (4 opérations × 6 types × 8 canaux/cibles, hors n/a).
- **Conformes : ~25 %** — uniquement le couple `pipeline → agenda` (CREATE) et `agenda → agenda` (CRUD complet).
- **Cassées 🔴 : 50 %** — pas de listener `storage` sur pipeline/dashboard/carte/contacts/devis/mail. Cmd+R requis pour voir un RDV créé ailleurs.
- **Partiel 🟡 : ~15 %** — visio.html POST `/api/agenda` avec un schéma incompatible (`start: dateISO` au lieu de `date + start` séparés).
- **Hors scope 🟢 : ~10 %** — UPDATE/DELETE depuis un canal autre que `/agenda` n'existe simplement pas.

**Top 3 risques bloquants Stripe Live + beta-test** :

1. 🔴 **Aucun rafraîchissement cross-onglet hors `/agenda`** — un RDV créé dans `/pipeline` n'apparaît pas dans `/dashboard` ouvert dans un autre onglet (et inversement). Le user doit Cmd+R pour synchroniser.
2. 🔴 **`/visio` envoie un payload agenda incompatible** (`start: dateISO`, `prospectId` au lieu de `ficheId`, pas de `end`) → events visio invisibles dans `/agenda`, dans la timeline `/pipeline`, sur `/carte`, sur `/dashboard`.
3. 🔴 **UPDATE/DELETE agenda mono-canal** — un user qui veut décaler un RDV doit obligatoirement aller dans `/agenda`. Aucun bouton "Modifier" ni "Annuler" depuis la fiche `/pipeline`, depuis `/visio`, depuis le panneau `/carte`.

---

## B. Matrice CREATE — qui crée quoi (canal × type)

| Canal             | RDV       | Visio     | Mailing   | Phoning   | Devis     | Perso    |
|-------------------|-----------|-----------|-----------|-----------|-----------|----------|
| `/pipeline`       | ✅ `saveRdv()` [pipeline.html:1655](public/pipeline.html#L1655) + détection vocale [pipeline.html:2785](public/pipeline.html#L2785) | ✅ même fonction (`type=visio`) | ✅ même fonction (`type=mail`) | ❌ pas de type "phoning" exposé | ✅ même fonction (`type=devis`) | ❌ |
| `/agenda`         | ✅ `saveEvent()` [agenda.html:737](public/agenda.html#L737) | ✅ idem (4 type-pills) | ✅ idem | ❌ idem (pas de type) | ✅ idem | ✅ unique canal qui supporte `perso` |
| `/contacts`       | ❌ aucun POST agenda | ❌ | ❌ | ❌ | ❌ | ❌ |
| `/carte`          | ❌ aucun POST agenda | ❌ | ❌ | ❌ | ❌ | ❌ |
| `/mail`           | ❌ ne touche pas `/api/agenda` | ❌ | ❌ | ❌ | ❌ | ❌ |
| `/devis`          | ❌ ne touche pas `/api/agenda` | ❌ | ❌ | ❌ | ❌ | ❌ |
| `/visio`          | ❌ | ⚠️ POST [visio.html:2402](public/visio.html#L2402) avec **schéma incompatible** (voir G.2) | ❌ | ❌ | ❌ | ❌ |

---

## C. Matrice READ — qui affiche quoi (vue × type)

| Vue cible        | RDV | Visio | Mailing | Phoning | Devis | Perso |
|------------------|-----|-------|---------|---------|-------|-------|
| `/pipeline` (timeline fiche) | ✅ via `loadAgendaForFiche(ficheId)` filtre sur `?ficheId=` ([pipeline.html:843](public/pipeline.html#L843)) | ✅ même filtre, type ignoré | ✅ idem | ✅ idem | ✅ idem | ⚠️ events `perso` n'ont jamais de `ficheId` → invisibles |
| `/agenda` (grille mois + jour) | ✅ tous types, source `/api/agenda` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `/carte` (panneau latéral) | ⚠️ uniquement events avec `ficheId` rempli ET fiche géolocalisée ([carte.html:204](public/carte.html#L204)) | ⚠️ idem | ⚠️ idem | ⚠️ idem | ⚠️ idem | ❌ events `perso` exclus |
| `/dashboard` (prochain RDV / KPIs) | ✅ source `/api/agenda` cache 30 s ([dashboard.html:706](public/dashboard.html#L706)) | ✅ | ✅ | ✅ | ✅ | ✅ |
| `/visio` (liste visios) | ❌ filtre `type=visio` uniquement | ✅ | ❌ | ❌ | ❌ | ❌ |
| `/mail` (historique) | ❌ ne lit pas agenda | ❌ | ❌ | ❌ | ❌ | ❌ |
| `/devis` (liste) | ❌ ne lit pas agenda | ❌ | ❌ | ❌ | ❌ | ❌ |
| `/contacts` (timeline contact) | ❌ aucun fetch agenda | ❌ | ❌ | ❌ | ❌ | ❌ |

> **Symptôme** : le contrat produit "tous les events visibles partout selon leur type" est tenu uniquement sur `/agenda` et partiellement sur `/pipeline` (filtre ficheId).

---

## D. Matrices UPDATE et DELETE

### UPDATE (PUT `/api/agenda/:id`)

| Canal mutant      | Cibles propagées sans Cmd+R | Cibles cassées |
|-------------------|------------------------------|----------------|
| `/agenda` (modale édit + drag&drop) | `/agenda` ✅ (même page, listener storage) | `/pipeline`, `/dashboard`, `/carte`, `/visio`, `/contacts` 🔴 |
| `/pipeline`       | ❌ aucun PUT agenda existe sur cette page | n/a — modification impossible depuis fiche |
| autres canaux     | ❌ idem | n/a |

### DELETE (DELETE `/api/agenda/:id`)

| Canal mutant      | Cibles propagées sans Cmd+R | Cibles cassées |
|-------------------|------------------------------|----------------|
| `/agenda` (`deleteEvent()`) | `/agenda` ✅ | `/pipeline`, `/dashboard`, `/carte`, `/visio`, `/contacts` 🔴 |
| `/pipeline`       | ❌ aucun DELETE agenda existe | n/a — annulation impossible depuis fiche |
| `/visio`          | ❌ idem | n/a — annulation visio impossible depuis liste |
| autres canaux     | ❌ idem | n/a |

---

## E. Sous-tableaux par type — détail CRUD

### Type RDV — Opération CREATE

|              | Pipeline | Agenda | Carte | Dashboard | Visio | Mail | Devis | Contacts |
|--------------|----------|--------|-------|-----------|-------|------|-------|----------|
| `/pipeline`  | ✅ POST + `loadAgendaForFiche` immédiat | ⚠️ dispatch `mup_agenda` mais **`/agenda` doit être ouvert** | ⚠️ dispatch reçu seulement si `/carte` ouvert ET listener (or `/carte` n'a PAS de listener) → ❌ | 🔴 même problème | n/a | n/a | n/a | 🔴 contacts.html ignore mup_agenda |
| `/agenda`    | 🔴 pas de listener pipeline | ✅ render local + storage | 🔴 pas de listener carte | 🔴 pas de listener dashboard | 🟡 listener visio existe mais filtre `type=visio` | n/a | n/a | 🔴 |
| `/contacts`  | n/a (pas de POST) | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| `/carte`     | n/a (pas de POST) | n/a | n/a | n/a | n/a | n/a | n/a | n/a |

### Type RDV — Opération UPDATE

|              | Pipeline | Agenda | Carte | Dashboard | Visio | Mail | Devis | Contacts |
|--------------|----------|--------|-------|-----------|-------|------|-------|----------|
| `/pipeline`  | n/a (pas de PUT) | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| `/agenda`    | 🔴 | ✅ | 🔴 | 🔴 | 🔴 | n/a | n/a | 🔴 |
| autres       | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |

### Type RDV — Opération DELETE

|              | Pipeline | Agenda | Carte | Dashboard | Visio | Mail | Devis | Contacts |
|--------------|----------|--------|-------|-----------|-------|------|-------|----------|
| `/agenda`    | 🔴 | ✅ | 🔴 | 🔴 | 🔴 | n/a | n/a | 🔴 |
| autres       | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |

### Type Visio — Opération CREATE

|              | Pipeline | Agenda | Carte | Dashboard | Visio | Mail | Devis | Contacts |
|--------------|----------|--------|-------|-----------|-------|------|-------|----------|
| `/pipeline`  | ✅ POST `type=visio` | ⚠️ event valide mais visible dans `/agenda` seulement à reload | 🔴 | 🔴 | 🟡 listener storage écoute LS.AGENDA → re-render mais event peut être absent si filtre type strict | n/a | n/a | 🔴 |
| `/agenda`    | 🔴 | ✅ | 🔴 | 🔴 | 🟡 | n/a | n/a | 🔴 |
| `/visio`     | 🔴 schéma cassé (cf G.2) — event n'apparaît PAS dans `/pipeline` (manque `ficheId`) | 🔴 schéma cassé — pas de `date` ni `end`, juste `start: dateISO` → invisible dans grille | 🔴 | 🔴 | ✅ render local immédiat | n/a | n/a | 🔴 |

### Type Mailing — Opération CREATE

|              | Pipeline | Agenda | Carte | Dashboard | Visio | Mail | Devis | Contacts |
|--------------|----------|--------|-------|-----------|-------|------|-------|----------|
| `/pipeline`  | ✅ POST `type=mail` | 🔴 reload requis | 🔴 | 🔴 | n/a | 🔴 (`/mail` ne lit pas `/api/agenda`) | n/a | 🔴 |
| `/agenda`    | 🔴 | ✅ | 🔴 | 🔴 | n/a | 🔴 | n/a | 🔴 |
| `/mail`      | n/a (pas de POST agenda) | n/a | n/a | n/a | n/a | n/a | n/a | n/a |

### Type Phoning — Opération CREATE

❌ **type "phoning" n'existe pas dans le code**. Aucune type-pill, aucun POST. Hors scope V1.1.

### Type Devis — Opération CREATE

|              | Pipeline | Agenda | Carte | Dashboard | Visio | Mail | Devis | Contacts |
|--------------|----------|--------|-------|-----------|-------|------|-------|----------|
| `/pipeline`  | ✅ POST `type=devis` | 🔴 | 🔴 | 🔴 | n/a | n/a | 🔴 (`/devis` ne lit pas `/api/agenda`) | 🔴 |
| `/agenda`    | 🔴 | ✅ | 🔴 | 🔴 | n/a | n/a | 🔴 | 🔴 |
| `/devis`     | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |

### Type Perso — Opération CREATE

|              | Pipeline | Agenda | Carte | Dashboard | Visio | Mail | Devis | Contacts |
|--------------|----------|--------|-------|-----------|-------|------|-------|----------|
| `/pipeline`  | ❌ pas de type "perso" exposé (la fiche force un `ficheId`) | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| `/agenda`    | 🟢 `perso` n'a JAMAIS de `ficheId` → invisible sur `/pipeline` (par design) | ✅ | 🟢 invisible (par design) | ✅ visible dashboard | n/a | n/a | n/a | 🟢 |

---

## F. Audit des mécanismes transverses

### 5 mécanismes × 8 pages

| Page          | Dispatch storage `mup_agenda` | Écoute storage `mup_agenda` | Écoute focus / visibilitychange | Invalidation cache locale | Re-render lit source fraîche |
|---------------|-------------------------------|-----------------------------|--------------------------------|---------------------------|------------------------------|
| `/pipeline`   | ✅ après `saveRdv()` + détection vocale (lignes [1736](public/pipeline.html#L1736), [2819](public/pipeline.html#L2819)) | 🔴 **AUCUN listener storage** | 🔴 absent | ✅ `loadAgendaForFiche()` ré-appelé après mutation | ✅ via `loadAgendaForFiche` |
| `/agenda`     | ✅ après save/update/delete (lignes [805](public/agenda.html#L805), [831](public/agenda.html#L831), [972](public/agenda.html#L972)) | ✅ [agenda.html:903](public/agenda.html#L903) | 🔴 absent | ✅ `_agendaCache=null` partout après mutation | ✅ `_loadAgenda()` refetch |
| `/carte`      | ❌ ne mute pas | 🔴 **AUCUN listener** | 🔴 absent | ❌ pas d'invalidation `agendaByFiche` | ❌ `loadAllAgenda()` chargé une seule fois au boot |
| `/dashboard`  | ❌ ne mute pas | 🔴 **AUCUN listener storage** | 🔴 absent | ❌ pas d'invalidation `_agendaCache` | ⚠️ cache 30 s reste actif → données rances |
| `/visio`      | ⚠️ POST sans dispatch storage cross-clé | ✅ [visio.html:2684](public/visio.html#L2684) écoute LS.AGENDA | 🔴 absent | n/a | ✅ `renderRdvList()` après storage event |
| `/mail`       | ❌ ne mute pas | 🔴 absent | 🔴 absent | n/a | n/a |
| `/devis`      | ❌ ne mute pas | 🔴 absent | 🔴 absent | n/a | n/a |
| `/contacts`   | ❌ ne mute pas | ⚠️ listener existe ([contacts.html:1409](public/contacts.html#L1409)) **mais filtre rejette `mup_agenda`** (uniquement `mup_pipeline` + `mup_contacts`) | 🔴 absent | n/a | ❌ |

### Récap déficiences

- **6 / 8 pages SANS listener `mup_agenda`** : `/pipeline`, `/carte`, `/dashboard`, `/mail`, `/devis`, `/contacts` (filtre rejette).
- **8 / 8 pages SANS listener `focus` / `visibilitychange`** — aucun rafraîchissement au retour d'onglet (le seul `addEventListener('focus')` du repo est dans [js/sector-autocomplete.js](public/js/sector-autocomplete.js#L284), sans rapport).
- **Cache `_agendaCache` 30 s sur `/dashboard` jamais invalidé** depuis l'extérieur : si le user crée un RDV ailleurs, dashboard renverra du stale pendant 30 s même sans listener.
- **Cache `agendaByFiche` `/carte` chargé 1 seule fois au boot** : aucun rafraîchissement après création/update/delete agenda.

---

## G. Causes root classées par sévérité

### 🔴 Cassantes (contrat produit non tenu)

#### G.1 — Aucun listener `storage` sur 6 pages cibles
- **Fichiers** : pipeline.html, carte.html, dashboard.html, mail.html, devis.html, contacts.html
- **Description** : `agenda.html`, `pipeline.html` et `visio.html` dispatchent bien `StorageEvent('storage', { key: 'mup_agenda' })` après mutation, mais aucune des 6 pages cibles ne l'écoute. `contacts.html` a un listener qui filtre uniquement `mup_pipeline` + `mup_contacts`.
- **Conséquence user** : ouvrir `/dashboard` dans un onglet, créer un RDV dans un autre onglet `/agenda` → le dashboard ne se met pas à jour, Cmd+R requis.

#### G.2 — `/visio` POST `/api/agenda` avec schéma incompatible
- **Fichier** : [visio.html:2393-2402](public/visio.html#L2393-L2402)
- **Payload envoyé** : `{ id, type:'visio', title, societe, prospectId, email, start: dateISO, duree, provider, link, sujet, status, createdAt }`
- **Schéma attendu** (cf agenda.html:737, pipeline.html:1691) : `{ date: 'YYYY-MM-DD', start: 'HH:MM', end: 'HH:MM', title, contact, type, notes, ficheId }`
- **Différences cassantes** :
  - Pas de champ `date` séparé → `/agenda` filtre `events.find(e => e.date === ...)` ne match pas
  - Pas de `end` → le bloc visuel n'a pas de durée
  - `prospectId` au lieu de `ficheId` → invisible sur `/pipeline` (filtre `?ficheId=`) ET sur `/carte` (lookup `agendaByFiche[c.id]`)
  - `contact` absent
  - `id` envoyé côté client → mais SurrealDB retourne un `agenda:xxx` propre (le client n'utilise pas le retour pour réassigner)
- **Conséquence user** : crée une visio depuis `/visio` → invisible dans `/agenda`, `/pipeline`, `/dashboard`, `/carte`. Symétriquement la timeline pipeline ne montre pas la visio créée.

#### G.3 — UPDATE / DELETE agenda mono-canal
- **Fichiers** : agenda.html (seul à muter via PUT/DELETE)
- **Description** : aucune autre page ne propose `Modifier` / `Annuler` un event agenda. Pas de PUT/DELETE depuis `/pipeline` (la fiche), `/visio`, `/carte`.
- **Conséquence user** : pour décaler un RDV de 14h à 16h, il faut quitter la fiche pipeline, aller dans `/agenda`, retrouver l'event, l'éditer.

#### G.4 — Cache `_agendaCache` 30 s `/dashboard` non invalidé
- **Fichier** : [dashboard.html:698-716](public/dashboard.html#L698-L716)
- **Description** : `_loadAgenda()` retourne le cache si `Date.now() - _agendaCacheTime < 30000`. Mais aucun setter d'invalidation depuis storage event ou autre.
- **Conséquence user** : KPIs et "prochain RDV" du dashboard restent rances pendant 30 s après une création/modif ailleurs.

#### G.5 — Cache `agendaByFiche` `/carte` chargé 1 seule fois
- **Fichier** : [carte.html:184-198](public/carte.html#L184-L198)
- **Description** : `loadAllAgenda()` n'est appelé qu'au boot et dans `calcTour()`. Pas de re-fetch sur storage event (et pas de listener).
- **Conséquence user** : créer un RDV ailleurs → la carte ne s'enrichit pas du nouveau pin RDV ni n'auto-ouvre le panneau.

### 🟡 Partiels

#### G.6 — Filtre type strict sur `/visio`
- **Fichier** : visio.html `renderRdvList()` filtre `type === 'visio'`
- **Description** : événements `mail`, `phoning`, `devis` ignorés (par design). RAS si scope V1.1 = afficher uniquement les visios.

#### G.7 — Héritage `address` / `contactId` non automatique
- **Fichiers** : pipeline.html:1691 (saveRdv), agenda.html:766 (target build)
- **Description** : POST agenda envoie `ficheId` et `contact` (nom string) mais jamais `address` ni `contactId` (ID record). `/carte` re-déduit l'address en regardant `markers[ficheId].latlng` → fonctionne mais redondant. Si la fiche est déplacée d'adresse APRÈS création de l'event, l'event ne contient pas l'historique.
- **Conséquence user** : moindre — pas bloquant mais limite les fonctionnalités futures (ex: route OSRM avec adresse exacte au moment de la prise de RDV).

### 🟢 Hors scope V1.1

- Type "phoning" pas implémenté
- `/mail`, `/devis`, `/contacts` ne lisent pas l'agenda (par design — vues métier focalisées)
- Création agenda depuis `/carte` (popup pin) inexistante
- Édition d'event depuis n'importe quel canal hors `/agenda`

---

## H. Schéma table agenda actuel

### Champs réellement persistés (déduits des POST observés)

| Champ           | Présent | Source POST                                  | Notes |
|-----------------|---------|----------------------------------------------|-------|
| `id`            | ✅ auto-généré côté serveur | upsertRecord ou CREATE auto-id | `agenda:xxx` |
| `userId`        | ✅ injecté serveur | server.js:686 force `userId` | scoping multi-tenant |
| `date`          | ✅ depuis `/pipeline` + `/agenda` | `'YYYY-MM-DD'` | ❌ absent du POST `/visio` |
| `start`         | ✅ depuis `/pipeline` + `/agenda` | `'HH:MM'` | ⚠️ `/visio` envoie un ISO complet |
| `end`           | ✅ depuis `/pipeline` + `/agenda` | `'HH:MM'` | ❌ absent `/visio` |
| `title`         | ✅ partout | string libre | |
| `contact`       | ✅ depuis `/pipeline` + `/agenda` | string nom | ❌ pas de `contactId` record |
| `type`          | ✅ partout | `rdv` / `visio` / `mail` / `devis` / `perso` | "phoning" jamais émis |
| `notes`         | ✅ depuis `/pipeline` + `/agenda` | string libre | |
| `ficheId`       | ✅ depuis `/pipeline` + `/agenda` (optionnel pour perso) | string id pipeline | ❌ `/visio` envoie `prospectId` (champ différent) |
| `address`       | ❌ jamais envoyé | — | déduit côté lecture via lookup fiche |
| `contactId`     | ❌ jamais envoyé | — | seulement nom string |
| `createdAt`     | ⚠️ envoyé seulement par `/visio` | — | pas systématique |
| `updatedAt`     | ❌ jamais envoyé | — | |

### DEFINE TABLE / DEFINE FIELD

`grep` sur `server.js` + `lib/*.js` pour `DEFINE.*agenda` → **0 résultat**.

→ Table SurrealDB `agenda` est en **SCHEMALESS** (default). Aucune validation côté DB. Risque de typo silencieuse (déjà observé G.2 : `prospectId` vs `ficheId`).

---

## I. Recommandations Phase 2 (par bloc, classées impact × charge)

| # | Bloc | Impact (1-5) | Charge estimée | Mutualisation possible |
|---|------|--------------|----------------|------------------------|
| 1 | **Listeners `storage` `mup_agenda` + re-fetch** sur `/pipeline`, `/dashboard`, `/carte`, `/contacts` | 5 (résout G.1, G.4, G.5 d'un coup) | 0,5 j (5 listeners + 5 re-fetch helpers) | ✅ snippet réutilisable `attachAgendaSync(reloadFn)` |
| 2 | **Normaliser le payload `/visio`** pour matcher schéma agenda canonique (date+start+end+ficheId) | 5 (résout G.2 + visio invisible partout) | 0,5 j | — propre à visio.html |
| 3 | **Listener `visibilitychange`** global qui invalide `_agendaCache` au retour d'onglet | 4 | 0,2 j | ✅ snippet partagé dans un `app-bootstrap.js` |
| 4 | **Boutons `Modifier` / `Annuler`** sur fiche pipeline + ligne visio (PUT + DELETE `/api/agenda/:id`) | 4 (G.3) | 1 j (modale réutilisable + 2 wirings) | ✅ extraire la modale agenda en composant |
| 5 | **DEFINE TABLE agenda** SCHEMAFULL avec champs typés + `addressSnapshot` + `contactId` | 3 (G.7 + sécurité) | 0,5 j + migration | — backend pur |
| 6 | **Middleware héritage backend** : POST `/api/agenda` lookup automatique fiche → injecte `address`, `contactName`, `contactId` si absents du body | 3 (G.7) | 0,5 j | ✅ DRY — sert tous les canaux POST |
| 7 | **Type "phoning" + pill UI** sur `/agenda` + `/pipeline` modale | 2 (cohérence) | 0,2 j | — symbolique |
| 8 | **Listener storage `mup_agenda` sur `/contacts`** + ajout timeline contact (lecture filtrée par contactId) | 3 | 0,5 j (dépend du #5 pour contactId) | dépend de #5 |

### Ordre suggéré d'exécution

1. **Bloc #2** (visio schéma) — impact 5, demi-jour, dette technique évidente
2. **Bloc #1** (listeners storage) — impact 5, demi-jour, débloque tous les onglets
3. **Bloc #3** (visibilitychange) — impact 4, 2h, complète #1 pour l'UX retour-onglet
4. **Bloc #5** (SCHEMAFULL + champs étendus) — impact 3, demi-jour, prérequis pour #6 et #8
5. **Bloc #6** (middleware héritage) — impact 3, demi-jour, mutualise pour tous les POST
6. **Bloc #4** (UPDATE/DELETE multi-canal) — impact 4, 1 jour, après stabilisation backend
7. **Bloc #8** (timeline contacts) — impact 3, demi-jour, après #5
8. **Bloc #7** (phoning) — impact 2, 2h, cosmétique

**Charge totale estimée Phase 2** : ~4,5 jours homme.

**Mutualisations clé** :
- Snippet `attachAgendaSync(reloadFn)` réutilisable dans 5 pages
- Modale agenda (création/édition) extraite en composant pour `/pipeline` + `/visio` + futurs canaux
- Middleware backend héritage : un seul lookup côté server.js bénéficie à tous les POST agenda actuels et futurs
