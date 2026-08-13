/* ─────────────────────────────────────────────────────────────────
   MUPFil — résolution de lecture du fil d'activité.
   Une note appartient à l'entreprise, pas au record par lequel elle
   est entrée. Une même entreprise porte pourtant plusieurs records :
   sa carte de board et sa fiche contact, parfois plusieurs contacts.
   Cette fonction rend, depuis un id de départ, l'ensemble des ids
   sous lesquels le fil de cette entreprise a pu être ancré.
   LECTURE SEULE : elle n'écrit rien, ni en base ni sur un record.
   Rien de ce qu'elle calcule n'est stocké nulle part.
   Script classique attaché à window (pas de bundler côté MUP).
   ───────────────────────────────────────────────────────────────── */
(function (global) {
  if (global.MUPFil) return;

  // Id local d'un record : préfixe de table retiré. « contacts:abc » et
  // « pipeline:abc » sont le même objet — doctrine posée par la fiche
  // société, appliquée à l'identique par la fusion de contacts.html.
  function localId(v) {
    var raw = (v && typeof v === 'object' && v.id != null) ? v.id : v;
    return String(raw == null ? '' : raw).replace(/^[a-z_]+:/i, '').trim();
  }

  var _cache = null;
  var _cacheTime = 0;

  // Charge les deux tables qui portent des records d'entreprise. Un échec
  // ne fait pas échouer la résolution : elle retombe sur le seul id de
  // départ, donc sur le fil du record ouvert. Moins large, jamais faux.
  function _charger() {
    if (_cache && (Date.now() - _cacheTime < 30000)) return Promise.resolve(_cache);
    function lire(url) {
      return fetch(url)
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (d) { return Array.isArray(d) ? d : []; })
        .catch(function () { return []; });
    }
    return Promise.all([lire('/api/contacts'), lire('/api/pipeline')]).then(function (r) {
      _cache = { contacts: r[0], pipeline: r[1] };
      _cacheTime = Date.now();
      return _cache;
    });
  }

  function invaliderCache() { _cache = null; _cacheTime = 0; }

  // Rend la liste des ids locaux équivalents à `idDepart`, celui-ci compris.
  // Trois liens, ceux-là et pas d'autres :
  //   — id local commun : la carte de board partage l'id de son contact ;
  //   — contact_id : la carte née d'un import de factures ne partage ni
  //     suffixe ni societe_id avec son contact, elle ne le désigne que là ;
  //   — societe_id : les records d'une même entreprise le partagent.
  // `sources` (facultatif) évite un aller-retour à qui a déjà les records
  // en mémoire : { contacts: [...], pipeline: [...] }.
  function idsEquivalents(idDepart, sources) {
    var depart = localId(idDepart);
    if (!depart) return Promise.resolve([]);
    var p = sources ? Promise.resolve(sources) : _charger();
    return p.then(function (src) {
      var records = [].concat(
        (src && src.contacts) || [],
        (src && src.pipeline) || []
      );

      // Composantes connexes par union-find. La clé société vit dans un
      // espace de noms séparé (« soc: ») : elle relie des records entre eux
      // sans jamais sortir comme ancrage — un id de la table societes ne
      // désigne aucune des deux surfaces qui écrivent le fil.
      var parent = {};
      function trouver(x) {
        if (parent[x] === undefined) { parent[x] = x; return x; }
        while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
        return x;
      }
      function unir(a, b) {
        if (!a || !b) return;
        var ra = trouver(a), rb = trouver(b);
        if (ra !== rb) parent[ra] = rb;
      }

      trouver(depart);
      records.forEach(function (rec) {
        if (!rec) return;
        var cle = localId(rec.id);
        if (!cle) return;
        trouver(cle);
        var vers = localId(rec.contact_id);
        if (vers) unir(cle, vers);
        var sid = localId(rec.societe_id);
        if (sid) unir(cle, 'soc:' + sid);
      });

      var racine = trouver(depart);
      var ids = [];
      Object.keys(parent).forEach(function (k) {
        if (k.indexOf('soc:') === 0) return;
        if (trouver(k) === racine && ids.indexOf(k) === -1) ids.push(k);
      });
      if (ids.indexOf(depart) === -1) ids.push(depart);
      return ids;
    });
  }

  // ── LECTURE DU FIL ──

  // Une date n'est retenue que si elle se parse ET tombe après 2020. Même
  // borne que dateValide() du Pipeline : elle écarte les 1970 fabriqués par
  // un repli sur zéro et les identifiants numériques pris pour des
  // millisecondes.
  function dateValide(v) {
    if (!v) return null;
    var d = new Date(v);
    return (!isNaN(d.getTime()) && d.getFullYear() >= 2020) ? d : null;
  }

  // Vocabulaire commun aux deux surfaces, celui de la fiche contact.
  var TYPES = ['note', 'phone', 'visio', 'rdv', 'mail', 'devis'];
  var ALIAS = {
    mailing: 'mail', email: 'mail',
    phoning: 'phone', appel: 'phone', tel: 'phone',
    move: 'note', deplacement: 'note'
  };

  // Les entrées d'activity[] d'avant le champ `type` n'en portent pas : leur
  // nature se devine du texte, comme le faisait le panneau du Pipeline.
  function deduireType(txt) {
    var t = String(txt || '').toLowerCase();
    if (t.indexOf('devis') !== -1) return 'devis';
    if (t.indexOf('mail') !== -1) return 'mail';
    if (t.indexOf('appel') !== -1 || t.indexOf('phoning') !== -1) return 'phone';
    if (t.indexOf('visio') !== -1) return 'visio';
    if (t.indexOf('rdv') !== -1) return 'rdv';
    return 'note';
  }

  function normType(brut, txt) {
    var t = String(brut == null ? '' : brut).toLowerCase().trim();
    if (ALIAS[t]) t = ALIAS[t];
    if (TYPES.indexOf(t) !== -1) return t;
    return deduireType(txt);
  }

  function lireActivites(ids) {
    if (!ids.length) return Promise.resolve([]);
    return fetch('/api/activites?ancrage=' + encodeURIComponent(ids.join(',')))
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (d) { return Array.isArray(d) ? d : []; })
      .catch(function () { return []; });
  }

  // Tous les records de l'entreprise dont les tableaux internes seront lus en
  // repli, ceux chargés comme ceux déjà en mémoire côté appelant — qui portent
  // l'état le plus frais, celui d'après la dernière saisie. Un même record
  // peut donc entrer deux fois ; ce sont les ENTRÉES qui se dédoublonnent, en
  // aval, sur leur contenu. Départager les records eux-mêmes demanderait de
  // savoir de quelle table vient chaque copie, et une erreur d'appariement
  // afficherait tout le fil en double.
  function _recordsDuFil(src, ids) {
    return [].concat(
      (src && src.contacts) || [],
      (src && src.pipeline) || [],
      (src && src.local) || []
    ).filter(function (r) {
      var k = r && localId(r.id);
      return !!k && ids.indexOf(k) !== -1;
    });
  }

  // Rend le fil d'une entreprise, du plus récent au plus ancien.
  // Trois sources, réunies et triées ensemble :
  //   — la table activites, ancrée sur les ids équivalents ;
  //   — activity[] et noteEntries[], lus DANS les records en repli. Ils ne
  //     sont ni réécrits ni migrés : l'existant reste où il est.
  // Chaque élément : { type, text, ts } — la forme qu'attend rendre().
  // `opts.local` : records déjà en mémoire côté appelant, prioritaires.
  // `opts.extra` : entrées déjà formées, à trier avec le reste — une ligne
  // calculée à l'affichage y entre sans être écrite nulle part.
  function lire(idDepart, opts) {
    var depart = localId(idDepart);
    if (!depart) return Promise.resolve([]);
    var o = opts || {};
    var pSrc = (o.contacts || o.pipeline)
      ? Promise.resolve(o)
      : _charger().then(function (s) { return { contacts: s.contacts, pipeline: s.pipeline, local: o.local }; });

    return pSrc.then(function (src) {
      return idsEquivalents(depart, src).then(function (ids) {
        return lireActivites(ids).then(function (activites) {
          var items = [];

          (o.extra || []).forEach(function (e) {
            if (e) items.push({ type: normType(e.type, e.text), text: e.text || '', ts: e.ts || null, source: 'extra' });
          });

          activites.forEach(function (a) {
            if (!a) return;
            items.push({
              type: normType(a.type, a.texte || a.text),
              text: a.texte != null ? a.texte : (a.text || ''),
              ts: a.ts || a.createdAt || a.date || null,
              source: 'activites'
            });
          });

          _recordsDuFil(src, ids).forEach(function (rec) {
            // activity[].date est une chaîne d'affichage française qui ne se
            // parse pas ; seul .ts porte un horodatage lisible.
            (rec.activity || []).forEach(function (a) {
              if (!a) return;
              items.push({ type: normType(a.type, a.txt), text: a.txt || '', ts: a.ts || null, source: 'activity' });
            });
            (rec.noteEntries || []).forEach(function (n) {
              if (!n) return;
              items.push({
                type: normType(n.type, n.text),
                text: n.text || '',
                ts: n.createdAt || n.ts || n.date || null,
                source: 'noteEntries'
              });
            });
          });

          // Une même entrée peut arriver deux fois : le record qui la porte a
          // été lu depuis l'API ET fourni en mémoire par la surface. Deux
          // entrées de même nature, même horodatage et même texte sont la même
          // — deux saisies distinctes ne partagent pas la milliseconde.
          var vues = {};
          items = items.filter(function (it) {
            var cle = it.type + '|' + String(it.ts) + '|' + it.text;
            if (vues[cle]) return false;
            vues[cle] = true;
            return true;
          });

          // Tri commun sur l'horodatage, décroissant. Les entrées sans date
          // exploitable ferment la liste dans leur ordre d'arrivée plutôt que
          // de remonter en tête sur un 1970.
          var dates = items.map(function (it) { return dateValide(it.ts); });
          return items
            .map(function (it, i) { return { it: it, d: dates[i], i: i }; })
            .sort(function (a, b) {
              if (a.d && b.d) return b.d - a.d;
              if (a.d) return -1;
              if (b.d) return 1;
              return a.i - b.i;
            })
            .map(function (x) { return x.it; });
        });
      });
    });
  }

  // ── ÉCRITURE ──

  // Pose une entrée dans le fil. Quatre portes l'appellent — panneau du
  // Pipeline, fiche contact, agenda, visio — et chacune fournit la même chose :
  // l'id du record d'où part la saisie, la nature du geste, le texte.
  // L'ancrage n'est PAS résolu à l'écriture : l'entrée se pose sur le record
  // de départ et c'est la lecture qui rassemble. Une entreprise dont la
  // composition change plus tard n'a ainsi rien à rattraper.
  // Rend l'enregistrement créé, ou null si l'écriture a échoué — l'appelant
  // doit pouvoir ne pas annoncer ce qui n'a pas eu lieu.
  function ecrire(entree) {
    var e = entree || {};
    var ancrage = localId(e.ancrage);
    if (!ancrage) return Promise.resolve(null);
    var corps = {
      ancrage: ancrage,
      type: normType(e.type, e.texte),
      texte: String(e.texte == null ? '' : e.texte),
      ts: e.ts || new Date().toISOString()
    };
    return fetch('/api/activites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corps)
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  // ── RENDU ──
  // Icônes, libellés et balisage repris tels quels de renderTimeline() de la
  // fiche contact : un fil unique se lit pareil des deux côtés.

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  var LIBELLES = { note: 'Note', phone: 'Appel', visio: 'Visio', rdv: 'RDV', mail: 'Mail', devis: 'Devis' };
  var ICONES = {
    note: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
    phone: '<svg viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72"/></svg>',
    visio: '<svg viewBox="0 0 24 24"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>',
    rdv: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    mail: '<svg viewBox="0 0 24 24"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>',
    devis: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>'
  };

  // Les intitulés d'un compte-rendu structuré ressortent en gras, comme le
  // faisait le panneau du Pipeline. Appliqué APRÈS échappement.
  var TITRES = /^(Compte-rendu — [^\n]+|Contexte|Besoins exprimés|Freins \/ objections|Budget|Décisions|Prochaines étapes|Autres points)$/gm;

  // Rend le HTML du fil. Chaîne vide si le fil est vide : chaque surface garde
  // son propre message d'absence, ils ne disent pas la même chose.
  function rendre(items) {
    if (!items || !items.length) return '';
    return items.map(function (e) {
      var type = normType(e.type, e.text);
      var d = dateValide(e.ts);
      var dateBlock = d
        ? d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
          + '<br>' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
        : '—';
      var text = _esc(e.text).replace(TITRES, '<strong>$1</strong>');
      return '<div class="timeline-item">'
        + '<div class="timeline-date">' + dateBlock + '</div>'
        + '<div class="timeline-content">'
        +   '<div class="timeline-icon" data-type="' + type + '">' + ICONES[type] + '</div>'
        +   '<div class="timeline-body">'
        +     '<div class="timeline-event">' + LIBELLES[type] + '</div>'
        +     (text ? '<div class="timeline-note">' + text + '</div>' : '')
        +   '</div>'
        + '</div>'
        + '</div>';
    }).join('');
  }

  global.MUPFil = {
    localId: localId,
    idsEquivalents: idsEquivalents,
    invaliderCache: invaliderCache,
    lire: lire,
    ecrire: ecrire,
    rendre: rendre
  };
})(window);
