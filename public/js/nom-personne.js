// Miroir NAVIGATEUR de lib/nom-personne.js (source de vérité côté serveur). Le
// front MUP est en scripts classiques (pas de bundler, pas d'import ESM), d'où
// cette copie attachée à window. GARDER SYNCHRONISÉ avec lib/nom-personne.js,
// comme public/js/adresse-agregee.js et public/js/person-fields.js le sont avec
// les leurs.
//
// Une personne du CRM porte son identité en DEUX CASES qui font autorité,
// `prenom` et `nom_personne`, plus une troisième case à part, `civilite`. La
// chaîne `contact_nom` (« Prénom Nom » d'un seul tenant) est un champ ancien :
// elle reste alimentée pour la compatibilité, elle se DÉRIVE des deux cases, et
// elle ne les commande jamais.
//
// RAPPEL DU PIÈGE DE NOMMAGE, que ce module ne touche pas : sur un record
// `contacts`, `nom` est la RAISON SOCIALE de la société, jamais le patronyme.
// Le patronyme, c'est `nom_personne`.
//
// UN NOM DE PERSONNE N'A PAS D'ANCRE, à la différence d'une adresse dont le code
// postal est cinq chiffres en fin de chaîne. La règle positionnelle ci-dessous
// (premier mot = prénom, tout le reste = nom) est une CONJECTURE, pas une
// lecture : elle rend « Jean Dupont » et « Jean de La Fontaine », elle se trompe
// sur « Jean Pierre Dupont », sur « DUPONT Jean » et sur « Dupont, Jean ».
//
// D'OÙ LA RÈGLE DU LOT : LA DÉCOUPE N'ÉCRIT JAMAIS D'ELLE-MÊME. Une chaîne
// ancienne est découpée À LA LECTURE, pour AMORCER les deux cases d'un écran
// éditable, et elle n'est écrite que si l'abonné touche l'une des deux cases de
// nom. On n'écrit que ce que l'on corrige. Ces fonctions sont pures : elles ne
// posent rien sur l'enregistrement qu'on leur passe.
(function (global) {
  function _texte(v) {
    return String(v == null ? '' : v).trim();
  }

  // Civilité de tête détachée d'une chaîne : « M. Jean Dupont » rend
  // { civilite: 'M.', reste: 'Jean Dupont' }. Deux valeurs seulement, « M. » et
  // « Mme », celles que le sélecteur de la fiche société propose.
  var CIVILITE = /^\s*(mme|madame|mlle|mademoiselle|monsieur|mr|m)\.?\s+/i;

  function detacherCivilite(chaine) {
    var s = _texte(chaine);
    var m = s.match(CIVILITE);
    if (!m) return { civilite: '', reste: s };
    var t = m[1].toLowerCase();
    var civilite = (t === 'mme' || t === 'madame' || t === 'mlle' || t === 'mademoiselle') ? 'Mme' : 'M.';
    return { civilite: civilite, reste: s.slice(m[0].length).trim() };
  }

  // Découpe positionnelle : le PREMIER mot est le prénom, TOUT LE RESTE est le
  // nom. C'est la règle que le produit applique déjà aux colonnes d'un fichier
  // importé (personnesDeLigne, lib/import.js). Le trait d'union tient un prénom
  // composé en un seul mot ; une particule reste au nom, puisque tout ce qui
  // suit le premier mot y va. UN SEUL MOT VA AU NOM, prénom vide : dans un CRM,
  // un mot unique est plus souvent un patronyme qu'un prénom, et une case vide
  // se voit alors qu'une case fausse ne se voit pas. RIEN N'EST FABRIQUÉ.
  function decouperNomComplet(chaine) {
    var d = detacherCivilite(chaine);
    if (!d.reste) return { civilite: d.civilite, prenom: '', nom_personne: '' };
    var mots = d.reste.split(/\s+/).filter(Boolean);
    if (mots.length === 1) return { civilite: d.civilite, prenom: '', nom_personne: mots[0] };
    return { civilite: d.civilite, prenom: mots[0], nom_personne: mots.slice(1).join(' ') };
  }

  // ── LES DEUX CASES D'UN ENREGISTREMENT, TELLES QU'IL FAUT LES LIRE ──
  // Les enregistrements anciens ne portent que la chaîne `contact_nom` : leurs
  // cases se tirent de sa découpe.
  //
  // LA GARDE EST STRICTE : la découpe ne joue QUE si les DEUX cases de nom sont
  // vides. Un enregistrement portant déjà un prénom ou un nom n'est JAMAIS
  // redécoupé, sans quoi une correction manuelle serait écrasée par une
  // déduction. C'est mot pour mot la garde de casesAdresse.
  //
  // LA CIVILITÉ N'ENTRE PAS DANS LA GARDE : elle est une case à part, comme le
  // SIRET à côté de l'adresse. Et la civilité DÉJÀ POSÉE l'emporte sur celle que
  // la découpe détache.
  //
  // LECTURE PURE : rien n'est posé sur l'enregistrement.
  function casesNomPersonne(rec) {
    var r = rec || {};
    var civilite = _texte(r.civilite);
    var prenom = _texte(r.prenom);
    var nom = _texte(r.nom_personne);
    if (prenom || nom) return { civilite: civilite, prenom: prenom, nom_personne: nom };
    var chaine = _texte(r.contact_nom);
    if (!chaine) return { civilite: civilite, prenom: '', nom_personne: '' };
    var d = decouperNomComplet(chaine);
    return { civilite: civilite || d.civilite, prenom: d.prenom, nom_personne: d.nom_personne };
  }

  // ── LA LIGNE DE NOM, UNE SEULE COMPOSITION POUR TOUTES LES SURFACES ──
  // LA CIVILITÉ N'Y EST PAS : la ligne composée est « Jean Dupont », jamais
  // « M. Jean Dupont ». Une surface qui veut la civilité la préfixe elle-même.
  //
  // AUCUN REPLI SUR LA CHAÎNE, à la différence d'adresseComposee où l'agrégat
  // reste maître sans voie connue. La découpe postale ÉCARTE ce qu'elle ne
  // reconnaît pas ; celle-ci PARTITIONNE, tout mot atterrissant dans l'une des
  // deux cases. Recomposer une chaîne amorcée rend donc la chaîne elle-même, aux
  // espaces multiples près, la civilité de tête ayant rejoint sa propre case.
  function nomPersonne(rec) {
    var c = casesNomPersonne(rec);
    return [c.prenom, c.nom_personne].filter(Boolean).join(' ');
  }

  // ── LA CHAÎNE À ÉCRIRE, DÉRIVÉE DES DEUX CASES ──
  // Le jumeau en écriture de nomPersonne. ELLE SE VIDE : les deux cases vidées
  // rendent la chaîne vide, une case vidée étant un geste et non une absence.
  // AUCUNE DÉCOUPE ICI : on compose à partir des deux cases TELLES QU'ELLES
  // SONT, jamais de la découpe de l'ancienne chaîne.
  function composerNomComplet(cases) {
    var c = cases || {};
    return [_texte(c.prenom), _texte(c.nom_personne)].filter(Boolean).join(' ');
  }

  global.detacherCivilite = detacherCivilite;
  global.decouperNomComplet = decouperNomComplet;
  global.casesNomPersonne = casesNomPersonne;
  global.nomPersonne = nomPersonne;
  global.composerNomComplet = composerNomComplet;
})(typeof window !== 'undefined' ? window : this);
