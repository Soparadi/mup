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
// Le jumeau ne porte QUE la découpe et ce qui s'en déduit : la canonisation de
// voie (normaliserVoie / parserAdresseAgregee) sert au rapprochement, qui vit
// entièrement côté serveur. Le navigateur, lui, affiche et remplit des champs :
// il veut le texte tel quel.
//
// Trois fonctions, et TOUTES LES PAGES LISENT CELLES-CI, aucune n'en réécrit de
// variante : decouperAdresseAgregee découpe un agrégat, casesAdresse rend les
// trois cases d'un enregistrement (découpe sous garde comprise), adresseComposee
// rend la ligne d'adresse à afficher. Les deux dernières sont écrites au bas du
// fichier, à l'endroit où elles sont attachées à window.
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

  // ── LES TROIS CASES D'UN ENREGISTREMENT, TELLES QU'IL FAUT LES LIRE ──
  // Une fiche ou une carte porte son adresse en trois cases, `adresse` (la
  // voie), `zip`, `ville`. Les anciennes ne portent que l'agrégat monobloc
  // `address` (alias ancien `location`) : leurs cases se tirent de sa découpe.
  //
  // LA GARDE EST STRICTE : la découpe ne joue QUE si les TROIS cases sont vides.
  // Un enregistrement portant déjà un code postal ou une ville n'est JAMAIS
  // redécoupé, sans quoi une correction manuelle serait écrasée par une
  // déduction. C'est mot pour mot la garde du serveur.
  //
  // LECTURE PURE : rien n'est posé sur l'enregistrement. Ce qui n'est pas
  // corrigé n'est pas écrit, et une déduction ne devient pas une saisie.
  function casesAdresse(rec) {
    var r = rec || {};
    var voie = String(r.adresse == null ? '' : r.adresse).trim();
    var zip = String(r.zip == null ? '' : r.zip).trim();
    var ville = String(r.ville == null ? '' : r.ville).trim();
    if (voie || zip || ville) return { adresse: voie, zip: zip, ville: ville };
    var agregat = String((r.address || r.location) == null ? '' : (r.address || r.location)).trim();
    if (!agregat) return { adresse: '', zip: '', ville: '' };
    var d = decouperAdresseAgregee(agregat);
    return { adresse: d.voie, zip: d.code_postal, ville: d.ville };
  }

  // ── LA LIGNE D'ADRESSE, UNE SEULE COMPOSITION POUR TOUTES LES SURFACES ──
  // Les trois cases jointes dans l'ordre postal, les vides sautées. C'est ce
  // qu'un écran affiche, ce qu'un document imprime, ce qu'une liste cherche.
  //
  // SANS VOIE CONNUE, L'AGRÉGAT RESTE MAÎTRE, et c'est la règle du serveur mot
  // pour mot : quand la voie ne vit que dans l'agrégat, composer rendrait
  // « 04000 DIGNE-LES-BAINS » là où l'agrégat porte « LE PEAGE ROUTE DE NICE
  // 04000 DIGNE-LES-BAINS ». On rend alors l'agrégat, entier.
  //
  // Le jumeau côté serveur est recomposerAdresseAgregee (server.js), qui compose
  // la MÊME ligne pour l'ÉCRIRE dans l'agrégat. Une seule règle, deux emplois :
  // ici on lit, là-bas on écrit.
  function adresseComposee(rec) {
    var t = casesAdresse(rec);
    var compose = [t.adresse, t.zip, t.ville].filter(Boolean).join(' ');
    if (t.adresse) return compose;
    var r = rec || {};
    var agregat = String((r.address || r.location) == null ? '' : (r.address || r.location)).trim();
    return agregat || compose;
  }

  global.decouperAdresseAgregee = decouperAdresseAgregee;
  global.casesAdresse = casesAdresse;
  global.adresseComposee = adresseComposee;
})(typeof window !== 'undefined' ? window : this);
