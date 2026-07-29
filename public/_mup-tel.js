/* ─────────────────────────────────────────────────────────────────
   MUPTel — composition unifiée d'un numéro de téléphone.
   Une seule règle, appliquée PARTOUT où l'abonné lit ou saisit un
   numéro : à l'affichage il se rend en groupes de deux chiffres
   séparés par des espaces — « 06 80 94 56 64 » ; pour un lien tel:
   il se rend nu, séparateurs retirés, préfixe international conservé.

   Aucune migration : le formateur digère les formes stockées (collé,
   espacé, pointé, tireté, international) et rend toujours la même
   sortie. Aucune surface ne formate plus elle-même. Script classique
   attaché à window (pas de bundler côté MUP), sur le modèle de
   _mup-nom.js.
   ───────────────────────────────────────────────────────────────── */
(function (global) {
  if (global.MUPTel) return;

  function _s(v) {
    return String(v == null ? '' : v).trim();
  }

  // Regroupe une suite de chiffres en paires séparées d'espaces. L'espace
  // n'est posé qu'après une paire SUIVIE d'un chiffre ; un reliquat impair
  // reste seul en fin. « 0680945664 » -> « 06 80 94 56 64 ».
  function _paires(digits) {
    return digits.replace(/(\d{2})(?=\d)/g, '$1 ');
  }

  // Sépare l'entrée en { intl, digits }. Le préfixe international est reconnu
  // via '+' OU '00' (préfixe d'accès E.123) ; dans les deux cas `digits` ne
  // contient plus que l'indicatif pays + le numéro, sans le préfixe.
  function _parse(raw) {
    var s = _s(raw);
    var digits = s.replace(/\D/g, '');
    if (s.charAt(0) === '+') return { intl: true, digits: digits };
    if (/^00\d/.test(digits)) return { intl: true, digits: digits.slice(2) };
    return { intl: false, digits: digits };
  }

  // Forme NUE pour href tel: — ne garde que les chiffres et un '+' en tête.
  // Le préfixe international est CONSERVÉ (un +49 reste +49, un 0033 devient
  // +33) : contrairement à normaliserTel (lib/import.js) qui rabat +33 -> 0
  // pour l'appariement OSM, ici on ne mutile pas un numéro étranger, le lien
  // doit rester composable.
  function lien(raw) {
    var p = _parse(raw);
    if (!p.digits) return '';
    return (p.intl ? '+' : '') + p.digits;
  }

  // Forme LISIBLE pour l'affichage — groupes de deux chiffres.
  function format(raw) {
    var p = _parse(raw);
    if (!p.digits) return _s(raw); // rien d'exploitable : entrée rendue telle quelle
    var digits = p.digits;

    // Cas 1 — FR national : 0X puis 8 chiffres (10 au total).
    // Règle française : paires « 06 80 94 56 64 ».
    if (!p.intl && /^0\d{9}$/.test(digits)) {
      return _paires(digits);
    }

    // Cas 2 — FR international : indicatif 33 puis 9 chiffres significatifs.
    // Règle : on garde +33 ; le 0 national étant absent, le premier chiffre
    // reste seul puis 4 paires -> « +33 6 80 94 56 64 ».
    if (p.intl && /^33\d{9}$/.test(digits)) {
      var n = digits.slice(2);
      return '+33 ' + n.charAt(0) + ' ' + _paires(n.slice(1));
    }

    // Cas 3 — autre international (+CC…). La longueur de l'indicatif est
    // inconnue : on ne le mutile pas dans un moule français. On garde le +
    // et on regroupe le reste par paires -> « +49 15 12 34 56 78 9 ».
    if (p.intl) {
      return '+' + _paires(digits);
    }

    // Cas 4 — national non standard (longueur inattendue, numéro spécial…).
    // On applique le regroupement par paires sans rien perdre du numéro.
    return _paires(digits);
  }

  global.MUPTel = { format: format, lien: lien };
})(window);
