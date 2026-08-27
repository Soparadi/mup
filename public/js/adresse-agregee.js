// Miroir NAVIGATEUR de decouperAdresseAgregee (lib/societes.js, source de
// vérité côté serveur). Le front MUP est en scripts classiques (pas de bundler,
// pas d'import ESM), d'où cette copie attachée à window. GARDER SYNCHRONISÉ
// avec lib/societes.js.
//
// Une adresse agrégée (l'`address` monobloc d'une carte pipeline, une adresse
// Etalab, un libellé BAN) se découpe en TROIS parties : la voie telle quelle,
// le code postal, la ville.
//
// DOCTRINE, la même des deux côtés : L'ANCRE EST EN FIN. Le code postal est le
// DERNIER bloc de cinq chiffres de la chaîne. Tout bloc de cinq chiffres situé
// AVANT le dernier est un code de service (CS, BP, TSA, numéro de local,
// cedex), JAMAIS un code postal. L'agrégat porte son code postal en fin, suivi
// de la ville quand elle y est : c'est ce qui INTERDIT d'ancrer au début. Une
// découpe ancrée au début coupe sur « CS 20101 » et laisse « 35270 COMBOURG »
// dans la voie.
//
// La ville est FACULTATIVE. Sans aucun bloc de cinq chiffres, tout part dans la
// voie et les deux autres parties restent vides : rien n'est fabriqué, aucune
// valeur n'est inventée. La ponctuation qui borde le code postal est tolérée
// des deux côtés.
//
//   '12 RUE DES LILAS 75011 PARIS' -> { voie:'12 RUE DES LILAS', code_postal:'75011', ville:'PARIS' }
//   'CS 20101 35270 COMBOURG'      -> { voie:'CS 20101', code_postal:'35270', ville:'COMBOURG' }
//   '28 RUE DE LA ROUELLE 35120'   -> { voie:'28 RUE DE LA ROUELLE', code_postal:'35120', ville:'' }
//   'LIEU DIT LES PINS'            -> { voie:'LIEU DIT LES PINS', code_postal:'', ville:'' }
//
// Le jumeau ne porte QUE la découpe : la canonisation de voie
// (normaliserVoie / parserAdresseAgregee) sert au rapprochement, qui vit
// entièrement côté serveur. Le navigateur, lui, affiche et remplit des champs :
// il veut le texte tel quel.
(function (global) {
  function decouperAdresseAgregee(adresse) {
    var raw = String(adresse == null ? '' : adresse).trim();
    if (!raw) return { voie: '', code_postal: '', ville: '' };
    // `(.*)` GLOUTON : le moteur recule depuis la FIN, le premier bloc de cinq
    // chiffres qu'il rencontre est donc le DERNIER de la chaîne. La doctrine
    // tient dans ce seul quantificateur ; le rendre paresseux la retournerait.
    var m = raw.match(/^(.*)[\s,;]*\b(\d{5})\b[\s,;]*(.*)$/);
    if (!m) return { voie: raw, code_postal: '', ville: '' };
    return {
      voie: m[1].trim().replace(/[\s,;]+$/, ''),
      code_postal: m[2],
      ville: m[3].trim()
    };
  }

  global.decouperAdresseAgregee = decouperAdresseAgregee;
})(typeof window !== 'undefined' ? window : this);
