/* ══════════════════════════════════════════════════════════════════
   ENCART DE LECTURE INTERROMPUE, comportement partagé
   ------------------------------------------------------------------
   Une seule fonction, sur le patron de mupConfirm / mupAlert :

     await mupLecture(lire);

   `lire` est la lecture de la page hôte, confiée telle quelle : une
   fonction qui rend vrai quand la lecture a abouti, faux ou une
   exception sinon. Elle est appelée TOUT DE SUITE. Tant qu'elle
   échoue, l'encart tient la page et la promesse reste en suspens ; le
   bouton « Réessayer » rappelle la MÊME fonction, sur place, sans
   recharger quoi que ce soit. La promesse ne se résout que sur une
   lecture aboutie : l'appelante n'a donc jamais à se demander si ce
   qu'elle tient est vrai.

   POURQUOI CET ENCART EXISTE. Une lecture échouée laissait la page
   poser une liste vide et écrire « Aucun document » : l'écran EXACT
   d'un compte neuf. L'abonné croit avoir tout perdu. Pire, s'il crée
   un document dans la foulée, il l'écrit dans une base dont la page
   ignore le contenu, sous une référence qui peut déjà exister.

   AUCUNE SORTIE. Ni croix, ni clic sur le fond, ni Échap. Ce n'est pas
   une question posée à l'abonné, c'est une page qui n'a rien à
   montrer, et qui n'aura rien à montrer tant que la lecture n'aura pas
   abouti. Aucune écriture ne part pendant ce temps, exactement comme
   le panneau de mise en service tient la page Visio.

   TEXTE ARRÊTÉ, et il ne s'allonge pas. Pas de titre en bandeau, pas
   de seconde phrase : toute réassurance sur les données soulèverait
   une inquiétude que personne n'avait avant de la lire. C'est la
   raison pour laquelle l'encart n'a PAS de .mupc-head : le vêtement en
   prévoit un, et il porterait un mot de plus.

   Habillage : /styles/mup-confirm.css, dont le vêtement est repris
   classe pour classe, ET /styles/mup-lecture.css. Les deux sont à
   charger par la page hôte, comme mup-confirm.js le fait de la sienne.

     await mupLecture(loadDocs);   // loadDocs rend true ou false

   La pièce ne connaît aucune page : ni identifiant, ni variable, ni
   fonction d'appelant. Elle fabrique son balisage à l'ouverture et le
   retire à la fermeture, écouteurs compris.
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // Le texte, arrêté. Il vit ici et nulle part ailleurs : une page qui
  // le recopierait pourrait le laisser diverger.
  var PHRASE = 'La lecture est interrompue, réessayez dans un instant. Cela peut prendre quelques minutes.';
  var BOUTON = 'Réessayer';

  // Le balisage, fabriqué à la demande. Corps et pied seulement, dans le
  // vêtement de la fenêtre de confirmation.
  function fabrique() {
    var overlay = document.createElement('div');
    overlay.className = 'mupc-overlay';

    var modal = document.createElement('div');
    modal.className = 'mupc-modal';
    // alertdialog et non dialog : rien n'est demandé à l'abonné, on lui
    // signale un état.
    modal.setAttribute('role', 'alertdialog');
    modal.setAttribute('aria-modal', 'true');

    var body = document.createElement('div');
    body.className = 'mupc-body';
    var p = document.createElement('p');
    p.textContent = PHRASE;
    // Sans bandeau, c'est la phrase elle-même qui nomme la fenêtre : le
    // lecteur d'écran annonce ce que l'écran montre, mot pour mot, et
    // aucun libellé de plus n'est inventé pour lui seul.
    var phraseId = 'mupl-phrase-' + Math.random().toString(36).slice(2, 10);
    p.id = phraseId;
    modal.setAttribute('aria-labelledby', phraseId);
    body.appendChild(p);

    var foot = document.createElement('div');
    foot.className = 'mupc-foot';
    var bouton = document.createElement('button');
    bouton.type = 'button';
    bouton.className = 'mupc-btn mupc-btn-dark mupc-btn-sm mupl-btn';
    bouton.textContent = BOUTON;
    foot.appendChild(bouton);

    modal.appendChild(body);
    modal.appendChild(foot);
    overlay.appendChild(modal);
    return { overlay: overlay, bouton: bouton };
  }

  function mupLecture(lire) {
    return new Promise(function (resolve) {
      // Ce qui est posé à l'écran, ou null tant que la lecture n'a pas
      // échoué : une lecture qui aboutit du premier coup ne fabrique
      // rien du tout.
      var pose = null;
      // Une lecture à la fois. Sans cette garde, deux clics lanceraient
      // deux lectures et l'on ne saurait plus laquelle a rendu la liste.
      var encours = false;

      function tenter() {
        if (encours) return;
        encours = true;
        if (pose) pose.bouton.disabled = true;
        // Promise.resolve() enveloppe une `lire` synchrone comme une
        // lecture qui voyage : la pièce n'impose rien à l'appelante.
        Promise.resolve()
          .then(function () { return lire(); })
          .then(function (abouti) {
            if (abouti) { retirer(); resolve(abouti); return; }
            echec();
          })
          .catch(function (e) {
            console.warn('[mup-lecture] la lecture a échoué', e);
            echec();
          });
      }

      function echec() {
        encours = false;
        if (!pose) poser();
        pose.bouton.disabled = false;
      }

      function poser() {
        pose = fabrique();
        pose.bouton.addEventListener('click', tenter);
        document.addEventListener('keydown', surTouche, true);
        document.body.appendChild(pose.overlay);
        pose.overlay.classList.add('open');
        pose.bouton.focus();
      }

      function retirer() {
        if (!pose) return;
        document.removeEventListener('keydown', surTouche, true);
        pose.bouton.removeEventListener('click', tenter);
        if (pose.overlay.parentNode) pose.overlay.parentNode.removeChild(pose.overlay);
        pose = null;
      }

      // Échap ne ferme rien ici, et surtout n'atteint pas la page
      // derrière : elle y refermerait des panneaux que l'abonné ne voit
      // même pas, et le clavier donnerait le sentiment d'agir.
      function surTouche(e) {
        if (e.key === 'Escape' || e.key === 'Esc') {
          e.preventDefault();
          e.stopPropagation();
        }
      }

      tenter();
    });
  }

  window.mupLecture = mupLecture;
})();
