// Miroir NAVIGATEUR de lib/person-fields.js (source de vérité côté serveur).
// Le front MUP est en scripts classiques (pas de bundler / pas d'import ESM),
// d'où cette copie attachée à window. GARDER SYNCHRONISÉ avec lib/person-fields.js.
//
// Distinction des deux « noms » :
//   nom          → RAISON SOCIALE (face société) — jamais écrasée
//   nom_personne → PATRONYME seul de la personne
//   contact_nom  → "Prénom Nom" complet (legacy, conservé pour compat)
(function (global) {
  var PERSON_FIELDS = [
    'civilite', 'prenom', 'nom_personne', 'contact_nom', 'poste', 'anniversaire',
    'emails', 'email', 'telephones', 'phone',
    'linkedin', 'instagram_perso', 'facebook_perso',
    'note_personne', 'rgpd_consent_personne'
  ];

  function cleanList(value, fallback) {
    var arr = Array.isArray(value) ? value : [];
    arr = arr.map(function (s) { return String(s == null ? '' : s).trim(); })
            .filter(Boolean);
    if (!arr.length && typeof fallback === 'string' && fallback.trim()) {
      arr = [fallback.trim()];
    }
    // dédoublonnage en conservant l'ordre
    var seen = {}, out = [];
    for (var i = 0; i < arr.length; i++) {
      if (!seen[arr[i]]) { seen[arr[i]] = true; out.push(arr[i]); }
    }
    return out;
  }

  // Additif et non destructif : ne touche jamais aux champs société/techniques.
  function normalizePersonFields(rec) {
    var r = Object.assign({}, rec || {});

    if (typeof r.civilite !== 'string') r.civilite = '';
    if (typeof r.prenom !== 'string') r.prenom = '';
    if (typeof r.nom_personne !== 'string') r.nom_personne = '';
    if (typeof r.contact_nom !== 'string') r.contact_nom = '';
    if (typeof r.poste !== 'string') r.poste = '';
    if (typeof r.anniversaire !== 'string') r.anniversaire = '';

    var emails = cleanList(r.emails, r.email);
    r.emails = emails;
    r.email = emails[0] || '';

    var telephones = cleanList(r.telephones, r.phone);
    r.telephones = telephones;
    r.phone = telephones[0] || '';

    if (typeof r.linkedin !== 'string') r.linkedin = '';
    if (typeof r.instagram_perso !== 'string') r.instagram_perso = '';
    if (typeof r.facebook_perso !== 'string') r.facebook_perso = '';

    if (typeof r.note_personne !== 'string') r.note_personne = '';
    r.rgpd_consent_personne = !!r.rgpd_consent_personne;

    return r;
  }

  global.PERSON_FIELDS = PERSON_FIELDS;
  global.normalizePersonFields = normalizePersonFields;
})(window);
