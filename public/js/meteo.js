// Météo de l'abonné — acquisition commune au tableau de bord et à l'agenda.
//
// La position ne vient PLUS d'une ville en dur : elle est résolue côté serveur
// par /api/meteo/position, qui applique la cascade réglage → compte → adresse
// réseau (server/services/meteo-position.js). Ce module ne fait que deux
// choses : demander cette position, puis interroger Open-Meteo dessus. Le rendu
// reste à chaque page, qui a sa propre charte et son propre gabarit.
//
// AUCUN APPEL À navigator.geolocation : on ne demande pas une permission de
// géolocalisation pour afficher une température.
window.MupMeteo = (function () {
  'use strict';

  // Le réglage vers lequel pointe le libellé de lieu, et vers lequel invite le
  // composant quand aucune position n'est connue.
  var REGLAGE = '/account/profil#adresse-depart';

  // Mention portée quand la position vient du rang 3 (adresse réseau captée à
  // l'inscription) : l'abonné doit pouvoir comprendre pourquoi la ville
  // affichée n'est pas la sienne, et où la corriger.
  var MENTION_RESEAU = 'd’après votre connexion';

  var INVITATION = 'Renseigner mon adresse de départ';

  // Rend une promesse toujours tenue, jamais rejetée :
  //   { etat:'ok',      temp, code, ville, source, approx }
  //   { etat:'absent' } → aucune position connue, ne PAS afficher de météo
  //   { etat:'erreur' } → position ou service météo indisponible
  // La distinction compte : « absent » appelle une invitation, « erreur » un
  // simple constat d'indisponibilité. Les confondre reviendrait à reprocher à
  // l'abonné une panne de réseau.
  function charger(timeoutMs) {
    var t = timeoutMs || 6000;
    return fetch('/api/meteo/position', {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(t)
    })
      .then(function (r) {
        if (!r.ok) throw new Error('position ' + r.status);
        return r.json();
      })
      .then(function (pos) {
        if (!pos || !pos.source) return { etat: 'absent' };
        var url = 'https://api.open-meteo.com/v1/forecast'
          + '?latitude=' + encodeURIComponent(pos.lat)
          + '&longitude=' + encodeURIComponent(pos.lon)
          + '&current=temperature_2m,weathercode'
          // La position n'est plus forcément française : le fuseau suit le point
          // interrogé au lieu d'être figé sur Europe/Paris.
          + '&timezone=auto';
        return fetch(url, { signal: AbortSignal.timeout(t) })
          .then(function (r) {
            if (!r.ok) throw new Error('meteo ' + r.status);
            return r.json();
          })
          .then(function (d) {
            var c = d && d.current;
            if (!c || typeof c.temperature_2m !== 'number') throw new Error('meteo vide');
            return {
              etat: 'ok',
              temp: Math.round(c.temperature_2m),
              code: Number(c.weathercode),
              ville: pos.ville || '',
              source: pos.source,
              approx: pos.source === 'reseau'
            };
          });
      })
      .catch(function () { return { etat: 'erreur' }; });
  }

  // Libellé du lieu : le nom de la source retenue, suivi de la mention de repli
  // quand la position vient de l'adresse réseau. Sans nom de ville exploitable
  // (le rang 1 peut n'avoir que des coordonnées), on invite plutôt que
  // d'afficher un vide.
  function libelleLieu(r) {
    if (!r || r.etat !== 'ok' || !r.ville) return INVITATION;
    return r.approx ? (r.ville + ' · ' + MENTION_RESEAU) : r.ville;
  }

  return {
    charger: charger,
    libelleLieu: libelleLieu,
    REGLAGE: REGLAGE,
    INVITATION: INVITATION
  };
})();
