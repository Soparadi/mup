/* ══════════════════════════════════════════════════════════════════
   FENÊTRE DE CONFIRMATION MOVUP — comportement partagé
   ------------------------------------------------------------------
   Deux fonctions pour un seul vêtement, toutes deux servies par le
   même constructeur privé fenetre() :

     mupConfirm() — question fermée, deux boutons, promesse résolue à
     vrai (validation) ou à faux (les trois renoncements). Elle
     remplace window.confirm().

     mupAlert() — information, un seul bouton, promesse résolue à la
     fermeture quelle qu'en soit la voie. Elle remplace window.alert().

   Elles ne connaissent aucune page : ni identifiant, ni variable, ni
   fonction d'appelant. Elles fabriquent leur propre balisage à
   l'ouverture et le retirent à la fermeture, écouteurs compris.

   Habillage : /styles/mup-confirm.css, à charger par la page hôte.

     var ok = await mupConfirm(
       'Ajouter 240 fiches au pipeline ?',
       ['Première phrase.', 'Seconde phrase.'],
       'Ajouter', 'Annuler'
     );

     await mupAlert('Import impossible', 'Le fichier est illisible.', 'Fermer');

   Le corps accepte une chaîne (un paragraphe) ou un tableau de
   chaînes (un paragraphe par entrée). Le texte est posé en
   textContent : rien de ce qui vient de l'appelant n'est interprété
   comme du balisage.
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var CROIX = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">'
            + '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  // Constructeur unique. `avecAnnuler` dit si le pied porte le second
  // bouton : c'est la seule différence entre une question et une
  // information. Tout le reste — bandeau, corps, sorties, nettoyage —
  // est commun aux deux.
  function fenetre(titre, corps, libelleValider, libelleAnnuler, avecAnnuler) {
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.className = 'mupc-overlay';

      var modal = document.createElement('div');
      modal.className = 'mupc-modal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');

      // ── Bandeau : la question, puis la croix de fermeture ──────────
      var head = document.createElement('div');
      head.className = 'mupc-head';
      var titreEl = document.createElement('span');
      titreEl.className = 'mupc-title';
      titreEl.textContent = titre == null ? '' : String(titre);
      var titreId = 'mupc-title-' + Math.random().toString(36).slice(2, 10);
      titreEl.id = titreId;
      modal.setAttribute('aria-labelledby', titreId);
      var croix = document.createElement('button');
      croix.type = 'button';
      croix.className = 'mupc-close';
      croix.setAttribute('aria-label', 'Fermer');
      croix.innerHTML = CROIX;
      head.appendChild(titreEl);
      head.appendChild(croix);

      // ── Corps : un paragraphe par phrase confiée ───────────────────
      var body = document.createElement('div');
      body.className = 'mupc-body';
      var phrases = Array.isArray(corps) ? corps : (corps == null ? [] : [corps]);
      phrases.forEach(function (phrase) {
        if (phrase == null || phrase === '') return;
        var p = document.createElement('p');
        p.textContent = String(phrase);
        body.appendChild(p);
      });

      // ── Pied : renoncement à gauche, validation à droite ───────────
      var foot = document.createElement('div');
      foot.className = 'mupc-foot';
      var btnAnnuler = document.createElement('button');
      btnAnnuler.type = 'button';
      btnAnnuler.className = 'mupc-btn mupc-btn-outline mupc-btn-sm';
      btnAnnuler.textContent = libelleAnnuler || 'Annuler';
      var btnValider = document.createElement('button');
      btnValider.type = 'button';
      btnValider.className = 'mupc-btn mupc-btn-dark mupc-btn-sm';
      btnValider.textContent = libelleValider || 'Confirmer';
      if (avecAnnuler) foot.appendChild(btnAnnuler);
      foot.appendChild(btnValider);

      modal.appendChild(head);
      modal.appendChild(body);
      modal.appendChild(foot);
      overlay.appendChild(modal);

      // ── Les quatre sorties ─────────────────────────────────────────
      // Croix, bouton d'annulation, clic sur le fond et touche Échap
      // rendent faux ; le bouton de validation rend vrai. Aucune
      // d'elles ne laisse la promesse en suspens, et toutes passent
      // par fermer(), qui retire les écouteurs et le balisage.
      var clos = false;
      function fermer(reponse) {
        if (clos) return;
        clos = true;
        document.removeEventListener('keydown', surTouche, true);
        croix.removeEventListener('click', surCroix);
        btnAnnuler.removeEventListener('click', surAnnuler);
        btnValider.removeEventListener('click', surValider);
        overlay.removeEventListener('mousedown', surFond);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(reponse);
      }
      function surCroix()   { fermer(false); }
      function surAnnuler() { fermer(false); }
      function surValider() { fermer(true); }
      function surFond(e)   { if (e.target === overlay) fermer(false); }
      function surTouche(e) {
        if (e.key === 'Escape' || e.key === 'Esc') {
          e.preventDefault();
          e.stopPropagation();
          fermer(false);
        }
      }

      croix.addEventListener('click', surCroix);
      btnAnnuler.addEventListener('click', surAnnuler);
      btnValider.addEventListener('click', surValider);
      overlay.addEventListener('mousedown', surFond);
      document.addEventListener('keydown', surTouche, true);

      document.body.appendChild(overlay);
      overlay.classList.add('open');
      btnValider.focus();
    });
  }

  // Question fermée : deux boutons, vrai ou faux.
  function mupConfirm(titre, corps, libelleValider, libelleAnnuler) {
    return fenetre(titre, corps, libelleValider || 'Confirmer', libelleAnnuler || 'Annuler', true);
  }

  // Information : un seul bouton. Les quatre sorties rendent faux,
  // la validation rend vrai ; ni l'un ni l'autre ne dit rien ici, et
  // l'appelante n'a que la fermeture à attendre.
  function mupAlert(titre, corps, libelleFermer) {
    return fenetre(titre, corps, libelleFermer || 'Fermer', null, false).then(function () {});
  }

  window.mupConfirm = mupConfirm;
  window.mupAlert = mupAlert;
})();
