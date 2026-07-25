// quota-kpi.js — KPI « Contacts enrichis » servi par l'autorité serveur.
//
// Le plafond de leads n'est JAMAIS porté en dur par le front : il vient du
// serveur via GET /api/user-plan (quotaLimit), lui-même dérivé des
// PLAN_LEAD_LIMITS côté serveur (getLeadLimit). Le module se contente
// d'afficher ce que le serveur renvoie.
//
// Sémantique de quotaLimit :
//   undefined → fetch échoué côté serveur   → afficher '—'
//   null      → illimité (VIP)              → afficher le seul consommé
//   nombre    → plafond                     → afficher consommé/plafond
//
// Module autonome, sans dépendance, défensif : s'il ne trouve pas sa cible,
// il sort sans bruit ; toute erreur réseau se résout en '—', jamais en
// exception remontée à l'utilisateur.
(function () {
  var el = document.getElementById('kpi-contacts-enrichi');
  if (!el) return;

  fetch('/api/user-plan')
    .then(function (res) {
      if (!res.ok) { el.textContent = '—'; return; }
      return res.json().then(function (data) {
        var consumed = data.leadsConsumedThisMonth || 0;
        var quota = data.quotaLimit;
        if (quota === undefined) {
          el.textContent = '—';
        } else if (quota === null) {
          el.textContent = String(consumed);
        } else {
          el.textContent = consumed + '/' + quota;
        }
      });
    })
    .catch(function () { el.textContent = '—'; });
})();
