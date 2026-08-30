/* ————————————————————————————————————————————————
   LA SALLE MovUP — le seul demandeur de /api/visio/rooms
   ————————————————————————————————————————————————
   Une salle Whereby ne se demande QUE d'ici. La page Visio en a deux besoins —
   la création d'un rendez-vous, et sa modification quand le créneau sort de la
   fenêtre de vie de la salle — et deux appelantes qui composeraient chacune sa
   date de fin finiraient par ne plus poser la même.

   CE MODULE NE JUGE PAS DE L'OPPORTUNITÉ. Chaque salle créée consomme une
   réunion du quota facturé du compte MovUP : c'est l'appelante qui décide
   qu'il en faut une — un rendez-vous tenu sur un lien tiers n'en demande
   aucune. Ici, on demande et on rend le verdict.

   IL NE LÈVE JAMAIS. Comme le service serveur qu'il appelle, il rend un objet
   dans tous les cas : { ok:true, roomUrl, hostRoomUrl, fin } ou
   { ok:false, motif, message }. Le message est prêt à être affiché tel quel,
   sauf sur 'mur', où il est vide — le mur payant est déjà à l'écran et la page
   n'a pas à doubler ce qu'il dit. */
(function(){
  'use strict';

  /* LE BATTEMENT. La salle meurt à la date de fin qu'on lui donne : passée
     cette date, l'URL ne s'ouvre plus, y compris pour ceux qui sont dedans.
     La caler sur la fin annoncée du rendez-vous tuerait la salle pendant les
     débordements, qui sont la règle et non l'exception. Quatre heures : de quoi
     laisser une visio d'une demi-heure durer trois fois plus sans que rien ne
     se referme, sans laisser vivre chez un prospect, pendant des jours, un lien
     qui n'a plus d'objet. */
  var BATTEMENT_H = 4;

  /* Les cinq refus, dans les mots de l'abonné. 'mur' se tait : l'essai expiré
     fait paraître le mur payant, qui parle seul. */
  var MESSAGES = {
    mur:     '',
    requete: 'Le créneau de ce rendez-vous est illisible.',
    config:  "La visioconférence n'est pas configurée. Aucun rendez-vous n'a été créé.",
    amont:   "La salle de visioconférence n'a pas pu être créée. Réessayez dans un instant.",
    reseau:  "Le réseau n'a pas répondu. Réessayez."
  };

  /* La date de mort de la salle : début du rendez-vous + sa durée + le
     battement. Rend null sur un créneau illisible, et l'appelante s'arrête là,
     avant tout appel réseau. */
  function finDeSalle(debut, dureeMin){
    var d = (debut instanceof Date) ? debut : new Date(debut);
    if(isNaN(d.getTime())) return null;
    var minutes = Number(dureeMin);
    if(!isFinite(minutes) || minutes <= 0) minutes = 30;
    return new Date(d.getTime() + (minutes + BATTEMENT_H * 60) * 60000);
  }

  async function demanderSalle(params){
    var p = params || {};
    var fin = finDeSalle(p.debut, p.duree);
    if(!fin) return { ok:false, motif:'requete', message:MESSAGES.requete };

    var r;
    try {
      r = await fetch('/api/visio/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endDate: fin.toISOString() })
      });
    } catch(e){
      console.warn('[visio-salle] réseau', e);
      return { ok:false, motif:'reseau', message:MESSAGES.reseau };
    }

    /* Le mur payant AVANT tout le reste : sur 402 la route n'a même pas été
       atteinte, aucune réunion n'a été consommée, et le mur est déjà peint. */
    if(r.status === 402) return { ok:false, motif:'mur', message:'' };
    if(r.status === 503) return { ok:false, motif:'config', message:MESSAGES.config };
    if(!r.ok){
      console.warn('[visio-salle] refus', r.status);
      return { ok:false, motif:'amont', message:MESSAGES.amont };
    }

    var data;
    try { data = await r.json(); }
    catch(e){ return { ok:false, motif:'amont', message:MESSAGES.amont }; }
    if(!data || !data.roomUrl) return { ok:false, motif:'amont', message:MESSAGES.amont };

    /* La porte de l'hôte se replie sur celle de l'invité. Sans hostRoomUrl,
       l'abonné entre dans sa propre salle en invité et frappe à sa porte —
       c'est inconfortable, mais c'est encore une visio ; refuser le rendez-vous
       pour cela gaspillerait la réunion qu'on vient de payer.
       La date de fin rendue est celle que Whereby CONFIRME : c'est elle qui
       gouverne la mort de l'URL, et c'est donc elle qu'on garde. */
    return {
      ok: true,
      roomUrl: String(data.roomUrl),
      hostRoomUrl: String(data.hostRoomUrl || data.roomUrl),
      fin: String(data.endDate || fin.toISOString())
    };
  }

  window.MUPSalle = {
    BATTEMENT_H: BATTEMENT_H,
    finDeSalle: finDeSalle,
    demanderSalle: demanderSalle
  };
})();
