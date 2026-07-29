/* ─────────────────────────────────────────────────────────────────
   MUPNom — composition unifiée du nom d'entreprise.
   Une seule règle, appliquée PARTOUT où l'abonné lit une fiche société :
     titre     = enseigne si elle existe, sinon nom juridique
     sousTitre = nom juridique quand il diffère du titre, sinon ''
   Aucune surface ne compose plus elle-même : contacts, pipeline,
   fiche société et cartes prospection passent toutes par ici.
   Script classique attaché à window (pas de bundler côté MUP).
   ───────────────────────────────────────────────────────────────── */
(function (global) {
  if (global.MUPNom) return;

  function _clean(s) {
    return String(s == null ? '' : s).trim();
  }

  // { enseigne, nomJuridique } -> { titre, sousTitre }
  function compose(data) {
    data = data || {};
    var enseigne = _clean(data.enseigne);
    var juridique = _clean(data.nomJuridique);
    var titre = enseigne || juridique;
    var sousTitre = (juridique && juridique.toLowerCase() !== titre.toLowerCase())
      ? juridique
      : '';
    return { titre: titre, sousTitre: sousTitre };
  }

  global.MUPNom = { compose: compose };
})(window);
