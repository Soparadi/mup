/* ══════════════════════════════════════════════════════════════════
   FENÊTRE DE CONFIRMATION MOVUP — comportement partagé
   ------------------------------------------------------------------
   Trois fonctions pour un seul vêtement, toutes servies par le
   même constructeur privé fenetre() :

     mupConfirm() — question fermée, deux boutons, promesse résolue à
     vrai (validation) ou à faux (les trois renoncements). Elle
     remplace window.confirm().

     mupAlert() — information, un seul bouton, promesse résolue à la
     fermeture quelle qu'en soit la voie. Elle remplace window.alert().

     mupChoix() : question à TROIS issues, trois boutons, promesse
     résolue à 'valider', 'tiers' ou 'retour'. Elle existe pour les
     questions où RENONCER N'EST PAS UNE RÉPONSE : les quatre
     renoncements (croix, Échap, fond, bouton d'annulation) y
     rendent tous 'retour', c'est-à-dire « je reste où j'étais », et
     jamais l'une des deux issues qui font quelque chose. Un booléen
     ne peut pas porter cela : son faux confondrait le renoncement
     avec la seconde issue, et l'appelante prendrait une touche Échap
     pour un choix.

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

     var issue = await mupChoix(
       'Ce devis n\'est pas enregistré',
       'Vos modifications seront perdues.',
       'Enregistrer et quitter', 'Quitter sans enregistrer', 'Annuler'
     );   // 'valider' | 'tiers' | 'retour'

   Le corps accepte une chaîne (un paragraphe) ou un tableau de
   chaînes (un paragraphe par entrée). Le texte est posé en
   textContent : rien de ce qui vient de l'appelant n'est interprété
   comme du balisage.
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var CROIX = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">'
            + '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  // Constructeur unique. Deux paramètres, et deux seulement, séparent
  // les trois fenêtres : `avecAnnuler` dit si le pied porte le bouton de
  // renoncement, `libelleTiers` s'il porte une TROISIÈME issue. Tout le
  // reste (bandeau, corps, sorties, nettoyage) leur est commun.
  //
  // LE CONTRAT DES DEUX ANCIENNES N'A PAS BOUGÉ D'UN BIT. La promesse rend
  // ce que fermer() reçoit : true pour la validation, false pour les quatre
  // renoncements, 'tiers' pour la troisième issue. mupConfirm et mupAlert
  // n'ouvrent jamais cette troisième porte : elles appellent avec cinq
  // arguments, `libelleTiers` reste indéfini, le bouton n'est pas posé, et
  // elles ne voient donc jamais autre chose qu'un booléen.
  function fenetre(titre, corps, libelleValider, libelleAnnuler, avecAnnuler, libelleTiers) {
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
      // Sans phrase à porter, le bloc n'est PAS construit : il s'affichait
      // alors en bande blanche vide entre le bandeau et les boutons, sur
      // toutes les confirmations appelées sans corps — la suppression d'un
      // évènement d'agenda comme le retrait d'une fiche du Pipeline.
      var body = document.createElement('div');
      body.className = 'mupc-body';
      var phrases = Array.isArray(corps) ? corps : (corps == null ? [] : [corps]);
      phrases.forEach(function (phrase) {
        if (phrase == null || phrase === '') return;
        var p = document.createElement('p');
        p.textContent = String(phrase);
        body.appendChild(p);
      });

      // ── Pied : l'issue qui PERD DU TRAVAIL à gauche, puis le couple
      // annuler-valider tenu ensemble à droite. Trois boutons dans cet
      // ordre : la troisième issue, le renoncement, la validation.
      //
      // POURQUOI LA DESTRUCTRICE N'EST PAS AU MILIEU. Voisine immédiate du
      // bouton qu'on recommande, elle se prend sur un clic de travers, et
      // ce clic-là coûte le document. À gauche, le bouton qui ne fait rien
      // la sépare de la validation : le geste manqué ne perd plus que la
      // fenêtre. C'est la convention établie pour ce cas.
      //
      // Le bouton de gauche porte le même outline que l'annulation : ce
      // n'est pas une validation, et le noir plein reste à celle-ci.
      // AUCUNE RÈGLE DE CSS N'EST AJOUTÉE pour lui, .mupc-foot étant déjà
      // en flex avec sa gouttière : trois boutons s'y rangent comme deux.
      //
      // btnTiers est CONSTRUIT dans tous les cas, comme btnAnnuler l'est
      // déjà, et seulement APPENDU quand le pied le porte : c'est ce qui
      // laisse fermer() retirer les trois écouteurs sans avoir à savoir
      // laquelle des trois fenêtres il referme.
      var foot = document.createElement('div');
      foot.className = 'mupc-foot';
      var btnAnnuler = document.createElement('button');
      btnAnnuler.type = 'button';
      btnAnnuler.className = 'mupc-btn mupc-btn-outline mupc-btn-sm';
      btnAnnuler.textContent = libelleAnnuler || 'Annuler';
      var btnTiers = document.createElement('button');
      btnTiers.type = 'button';
      btnTiers.className = 'mupc-btn mupc-btn-outline mupc-btn-sm';
      btnTiers.textContent = libelleTiers || '';
      var btnValider = document.createElement('button');
      btnValider.type = 'button';
      btnValider.className = 'mupc-btn mupc-btn-dark mupc-btn-sm';
      btnValider.textContent = libelleValider || 'Confirmer';
      if (libelleTiers) foot.appendChild(btnTiers);
      if (avecAnnuler) foot.appendChild(btnAnnuler);
      foot.appendChild(btnValider);

      modal.appendChild(head);
      if (body.childNodes.length) modal.appendChild(body);
      modal.appendChild(foot);
      overlay.appendChild(modal);

      // ── Les sorties ────────────────────────────────────────────────
      // Croix, bouton d'annulation, clic sur le fond et touche Échap
      // rendent faux ; le bouton de validation rend vrai ; la troisième
      // issue, quand le pied la porte, rend 'tiers'. Aucune d'elles ne
      // laisse la promesse en suspens, et toutes passent par fermer(),
      // qui retire les écouteurs et le balisage.
      var clos = false;
      function fermer(reponse) {
        if (clos) return;
        clos = true;
        document.removeEventListener('keydown', surTouche, true);
        croix.removeEventListener('click', surCroix);
        btnAnnuler.removeEventListener('click', surAnnuler);
        btnTiers.removeEventListener('click', surTiers);
        btnValider.removeEventListener('click', surValider);
        overlay.removeEventListener('mousedown', surFond);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(reponse);
      }
      function surCroix()   { fermer(false); }
      function surAnnuler() { fermer(false); }
      function surTiers()   { fermer('tiers'); }
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
      btnTiers.addEventListener('click', surTiers);
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

  // Question à TROIS issues. Le pied porte, de gauche à droite, la
  // troisième issue, le renoncement et la validation ; la promesse rend
  // 'valider', 'tiers' ou 'retour'.
  //
  // L'ORDRE DES ARGUMENTS suit celui de mupConfirm sur ses trois premiers,
  // puis pose le libellé de la troisième issue avant celui de l'annulation :
  // on décrit ce qu'on ajoute avant ce qui existait déjà et dont le repli
  // est connu. Il ne dit rien de la place des boutons dans le pied, qui est
  // celle du § ci-dessus : troisième issue, renoncement, validation.
  //
  // 'retour' est la réponse des QUATRE renoncements, et c'est la raison
  // d'être de cette fonction : l'appelante ramène l'abonné exactement là
  // où il était, et ne prendra jamais une touche Échap pour le choix de
  // la seconde issue.
  function mupChoix(titre, corps, libelleValider, libelleTiers, libelleAnnuler) {
    return fenetre(
      titre, corps,
      libelleValider || 'Confirmer',
      libelleAnnuler || 'Annuler',
      true,
      libelleTiers || 'Continuer'
    ).then(function (reponse) {
      if (reponse === true) return 'valider';
      if (reponse === 'tiers') return 'tiers';
      return 'retour';
    });
  }

  window.mupConfirm = mupConfirm;
  window.mupAlert = mupAlert;
  window.mupChoix = mupChoix;
})();
