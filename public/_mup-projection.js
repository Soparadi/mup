/* ─────────────────────────────────────────────────────────────────
   MUPProjection — lire une coordonnée d'entreprise sans confondre
   ce que l'abonnée a saisi et ce que le référentiel mutualisé sait.

   /api/contacts et /api/pipeline rendent la donnée mutualisée dans un
   sous-objet dédié — `referentiel` — jointe à la lecture sur la clé
   SIRET, jamais recopiée sur l'enregistrement. Rien n'est écrit ici ;
   une valeur projetée ne devient jamais une valeur de la fiche, elle
   s'affiche et disparaît avec la page.

   ORDRE DE LECTURE, le même partout : la SAISIE d'abord — coordonnée
   de la personne, puis coordonnée de la société portée par
   l'enregistrement — et la projection en dernier, en repli. Une
   valeur projetée ne masque donc jamais une saisie, même vieille,
   même moins bonne : l'enregistrement de l'abonnée fait autorité chez
   elle.

   Le sous-objet peut être ABSENT sans que ce soit une anomalie :
   enregistrement sans SIRET, SIRET inconnu du référentiel, référentiel
   injoignable (la projection est fail-open), ou coordonnée décomptable
   non encore payée — le serveur ne projette email et téléphone qu'au
   SIRET déjà payé. Ces quatre cas se lisent pareil : pas de repli, la
   surface affiche ce que la fiche porte, et rien de plus.

   Script classique attaché à window (pas de bundler côté MUP), sur le
   modèle de _mup-tel.js.
   ───────────────────────────────────────────────────────────────── */
(function (global) {
  if (global.MUPProjection) return;

  function _s(v) {
    return String(v == null ? '' : v).trim();
  }

  // Première valeur non vide de la liste, '' si toutes le sont.
  function _premier(vals) {
    for (var i = 0; i < vals.length; i++) {
      var v = _s(vals[i]);
      if (v) return v;
    }
    return '';
  }

  // Le sous-objet projeté, ou un objet vide — jamais null, pour que les
  // appelants n'aient pas à se garder.
  function projection(rec) {
    var p = rec && rec.referentiel;
    return (p && typeof p === 'object') ? p : {};
  }

  // Adresse à laquelle écrire. `email` est celle de la PERSONNE, `societe_email`
  // celle de l'entreprise portée par la fiche ; la projection ferme la marche.
  function email(rec) {
    var r = rec || {};
    return _premier([r.email, r.societe_email, r.mail, r.contactEmail, projection(r).societe_email]);
  }

  // Numéro à appeler. `tel` / `phone` sont ceux de la PERSONNE, `societe_tel`
  // celui de l'entreprise portée par la fiche. Rendu brut : c'est MUPTel qui
  // décide de la mise en forme et du lien.
  function tel(rec) {
    var r = rec || {};
    return _premier([r.tel, r.phone, r.societe_tel, projection(r).societe_tel]);
  }

  // Site de l'entreprise. Non décomptable : la projection le rend sans
  // condition de paiement, dès que le référentiel le connaît.
  function site(rec) {
    var r = rec || {};
    return _premier([r.website, projection(r).website]);
  }

  global.MUPProjection = {
    projection: projection,
    email: email,
    tel: tel,
    site: site
  };
})(window);
