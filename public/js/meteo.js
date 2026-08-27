// Météo de l'abonné — acquisition commune au tableau de bord et à l'agenda.
//
// La position ne vient PLUS d'une ville en dur : elle est résolue côté serveur
// par /api/meteo/position, qui applique la cascade adresse de départ → compte →
// adresse réseau (server/services/meteo-position.js). Ce module y intercale UN
// RANG QUI N'EXISTE QU'ICI — le relevé de position de la Carte, écrit en
// mémoire locale — puis interroge Open-Meteo sur ce qui a gagné. Le rendu reste
// à chaque page, qui a sa propre charte et son propre gabarit.
//
// AUCUN APPEL À navigator.geolocation : on ne demande pas une permission de
// géolocalisation pour afficher une température. Le relevé du rang 2 n'en est
// pas un non plus — c'est la Carte qui l'a pris, sur un geste, et ce module ne
// fait que le relire.
window.MupMeteo = (function () {
  'use strict';

  // AUCUNE DESTINATION DE RÉGLAGE. Le libellé de lieu pointait vers l'adresse
  // de départ de /account/profil ; cet écran est revenu à la seule identité de
  // connexion et la carte a disparu. Le libellé reste une mention neutre : tant
  // que le réglage n'a pas de nouvelle adresse, un lien mort vaudrait moins que
  // du texte.

  // Mention portée quand la position vient du rang 4 (adresse réseau captée à
  // l'inscription) : l'abonné doit pouvoir comprendre pourquoi la ville
  // affichée n'est pas la sienne.
  var MENTION_RESEAU = 'd’après votre connexion';

  var INVITATION = 'Renseigner mon adresse de départ';

  // ── RANG 2 — LE RELEVÉ DE POSITION DE LA CARTE ──
  // Écrit par carte.html quand l'abonné s'y géolocalise (poserPosition), commune
  // déjà résolue. Un CONSTAT : il passe derrière l'adresse de départ, la seule
  // position que l'abonné ait lui-même déclarée, et devant le compte et
  // l'adresse réseau, qui datent tous deux de l'inscription et ne bougent plus.
  //
  // ÂGE GLISSANT DE VINGT-QUATRE HEURES depuis l'horodatage, jamais une clef de
  // jour : un relevé de 23 h ne doit pas mourir à minuit. L'entrée périmée est
  // IGNORÉE à la lecture, et le relevé suivant la remplace — rien à effacer,
  // aucune purge à écrire.
  //
  // LA BASCULE EST MUETTE. La météo suit la position sans la commenter : pas de
  // mention portée sur ce rang, pas un mot sur le changement de ville d'un jour
  // à l'autre. Le libellé est le nom de la commune, comme pour le rang 1.
  var MEMOIRE_POSITION = 'mup_meteo_position';
  var AGE_MAX_MS = 24 * 60 * 60 * 1000;

  function releveCarte() {
    try {
      var brut = localStorage.getItem(MEMOIRE_POSITION);
      if (!brut) return null;
      var e = JSON.parse(brut);
      if (!e || typeof e.ts !== 'number') return null;
      if (Date.now() - e.ts > AGE_MAX_MS) return null;
      if (typeof e.lat !== 'number' || typeof e.lon !== 'number' || !e.ville) return null;
      return { lat: e.lat, lon: e.lon, ville: String(e.ville), source: 'carte' };
    } catch (err) {
      return null;
    }
  }

  // Rend une promesse toujours tenue, jamais rejetée :
  //   { etat:'ok',      temp, code, ville, source, approx }
  //   { etat:'absent' } → aucune position connue, ne PAS afficher de météo
  //   { etat:'erreur' } → position ou service météo indisponible
  // La distinction compte : « absent » appelle une invitation, « erreur » un
  // simple constat d'indisponibilité. Les confondre reviendrait à reprocher à
  // l'abonné une panne de réseau.
  function charger(timeoutMs) {
    var t = timeoutMs || 6000;
    // Lu UNE FOIS, avant tout appel : le rang 2 ne dépend d'aucun réseau, et il
    // sert aussi bien à coiffer la cascade serveur qu'à la remplacer si elle ne
    // répond pas.
    var releve = releveCarte();

    // DEUX ÉCHECS À NE PAS CONFONDRE, d'où les deux filets séparés qui suivent.
    // Celui-ci ne couvre que L'OBTENTION DE LA POSITION : quand la cascade
    // serveur jette ou répond en erreur, il ne manque que la cascade, et un
    // relevé frais est un point parfaitement valable — l'appel météo part
    // dessus. Sans relevé exploitable on relance l'échec : c'est une panne, et
    // elle sort en 'erreur' comme aujourd'hui, on ne l'habille pas.
    var position = fetch('/api/meteo/position', {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(t)
    })
      .then(function (r) {
        if (!r.ok) throw new Error('position ' + r.status);
        return r.json();
      })
      .catch(function (err) {
        if (releve) return releve;
        throw err;
      });

    return position
      .then(function (pos) {
        // La cascade se referme ici. Le rang 1 est le seul à passer devant le
        // relevé : une position déclarée prime sur un constat, y compris sur un
        // constat plus récent. Tous les autres rangs passent derrière, y compris
        // le silence — un relevé frais vaut mieux qu'une invitation.
        if (releve && (!pos || pos.source !== 'depart')) pos = releve;
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
      // Le second filet. Une PANNE D'OPEN-METEO reste une panne, quel que soit
      // le rang qui a fourni le point : aucun rattrapage ici, rien à substituer
      // à une température qu'on n'a pas. Il recueille aussi le rejet relancé
      // plus haut, position injoignable et sans relevé.
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
    INVITATION: INVITATION
  };
})();
