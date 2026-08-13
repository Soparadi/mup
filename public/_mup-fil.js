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

  global.MUPFil = {
    localId: localId,
    idsEquivalents: idsEquivalents,
    invaliderCache: invaliderCache
  };
})(window);
