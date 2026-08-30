/* ————————————————————————————————————————————————
   MUPFiche — la fiche /pipeline?fiche=ID rendue hors de Pipeline.
   Deux modes, choisis par l'APPELANT :
     · calque (défaut) — panneau fixe à droite, voile, glissement ;
     · ancré — open(id, {hote}) pose la fiche EN FLUX dans l'élément
       fourni, sans voile ni z-index. C'est /visio qui s'en sert pour
       en faire sa troisième colonne.
   Aucun appelant existant ne passe `hote` : leur comportement est
   inchangé.
   ———————————————————————————————————————————————— */
(function(){
  if(window.MUPFiche) return;

  var backdrop = null;
  var iframe = null;
  var lastTrigger = null;
  // L'élément d'accueil en mode ancré, null en mode calque. C'est la seule
  // variable qui distingue les deux modes : tout le reste en découle.
  var hote = null;
  // Ce que la source PORTE en ce moment : la fiche chargée, et l'élément qui la
  // tient. Lus par open pour savoir si une réassignation de src a lieu d'être,
  // remis à zéro par hide, qui repasse la source à about:blank.
  var ficheChargee = null;
  var hoteCharge = null;

  function ensureBackdrop(){
    if(backdrop) return;
    backdrop = document.createElement('div');
    backdrop.id = 'mup-fiche-backdrop';
    backdrop.style.cssText = 'position:fixed;inset:0;z-index:9000;'
      + 'background:rgba(0,0,0,.30);display:none;opacity:0;'
      + 'transition:opacity .18s ease;';
    backdrop.addEventListener('click', function(e){
      if(e.target === backdrop) MUPFiche.close();
    });
    document.body.appendChild(backdrop);
  }

  function ensureIframe(){
    if(iframe) return;
    iframe = document.createElement('iframe');
    iframe.id = 'mup-fiche-iframe';
    iframe.setAttribute('title', 'Fiche client');
  }

  // Les deux géométries, chacune entière et lisible d'un bloc. Elles ne se
  // concatènent pas : un panneau flottant et une colonne en flux n'ont aucune
  // déclaration en commun qu'on gagnerait à factoriser.
  function geometrieCalque(el){
    el.style.cssText = 'position:fixed;right:0;top:0;bottom:0;'
      + 'width:380px;height:100vh;background:#FFFFFF;border:none;'
      + 'border-left:1px solid #E8E8ED;z-index:9001;display:none;'
      + 'transform:translateX(100%);transition:transform .25s ease;'
      + 'box-shadow:-8px 0 24px rgba(0,0,0,.10);';
  }
  function geometrieAncree(el){
    el.style.cssText = 'position:static;width:100%;height:100%;'
      + 'background:#FFFFFF;border:none;border-left:1px solid #E8E8ED;'
      + 'display:none;';
  }

  function show(){
    if(hote){
      // Une colonne permanente ne glisse pas : elle est là.
      iframe.style.display = 'block';
      return;
    }
    ensureBackdrop();
    backdrop.style.display = 'block';
    iframe.style.display = 'block';
    requestAnimationFrame(function(){
      backdrop.style.opacity = '1';
      iframe.style.transform = 'translateX(0)';
    });
  }

  function hide(){
    if(!iframe) return;
    ficheChargee = null;
    hoteCharge = null;
    if(hote){
      // Rien à attendre : sans animation, le délai de 250 ms n'aurait plus
      // d'objet que de laisser une iframe morte dans la colonne.
      iframe.style.display = 'none';
      iframe.src = 'about:blank';
      if(iframe.parentNode) iframe.parentNode.removeChild(iframe);
      hote = null;
      return;
    }
    backdrop.style.opacity = '0';
    iframe.style.transform = 'translateX(100%)';
    setTimeout(function(){
      backdrop.style.display = 'none';
      iframe.style.display = 'none';
      iframe.src = 'about:blank';
    }, 250);
  }

  // Un panneau qui se referme tout seul, sans un mot, se lit comme un clic qui
  // n'a rien fait. Ce bandeau est le seul cas où la fiche a quelque chose à dire
  // à la page qui l'a ouverte : la carte demandée n'existe pas.
  var messageTimer = null;
  function dire(texte){
    var el = document.getElementById('mup-fiche-message');
    if(!el){
      el = document.createElement('div');
      el.id = 'mup-fiche-message';
      el.setAttribute('role', 'status');
      el.style.cssText = 'position:fixed;left:50%;bottom:24px;'
        + 'transform:translateX(-50%);z-index:9002;max-width:min(420px,90vw);'
        + 'padding:12px 18px;border-radius:10px;background:#1C1C1E;color:#FFFFFF;'
        + 'font:500 14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;'
        + 'box-shadow:0 8px 24px rgba(0,0,0,.24);text-align:center;';
      document.body.appendChild(el);
    }
    el.textContent = texte;
    el.style.display = 'block';
    clearTimeout(messageTimer);
    messageTimer = setTimeout(function(){ el.style.display = 'none'; }, 4500);
  }

  // Échap ne referme QUE le calque. En mode ancré la colonne est permanente :
  // il n'y a rien à replier, et la touche appartient à la page.
  // La propagation est coupée sur la frappe qui a servi : ce script est chargé
  // avant le script inline de /visio, donc son écouteur passe le premier, et
  // sans cette coupure la même frappe refermait la fiche PUIS terminait le
  // rendez-vous en cours. Coupure immédiate et non simple stopPropagation :
  // les deux écouteurs sont posés sur `document`, et seul
  // stopImmediatePropagation empêche le second de s'exécuter sur ce nœud.
  document.addEventListener('keydown', function(e){
    if(e.key !== 'Escape') return;
    if(hote) return;
    if(!iframe || iframe.style.display !== 'block') return;
    MUPFiche.close();
    e.stopImmediatePropagation();
  });

  // Ce que fait cet écouteur, vérifié : sur les deux messages il appelle
  // MUPFiche.close(), qui replie le panneau, remet l'iframe à about:blank, rend
  // le focus au bouton d'origine et rafraîchit la page. La fermeture est donc
  // propre — ce qui manquait, c'est la PAROLE sur 'mup-fiche-not-found' : le
  // panneau disparaissait sans rien dire. Ce message n'était jamais reçu jusqu'à
  // présent (la sonde qui l'émettait concluait toujours « trouvée ») ; il l'est
  // désormais pour de bon, donc il doit s'expliquer.
  // La provenance est vérifiée : sans ce contrôle, n'importe quel cadre de la
  // page pouvait refermer la fiche d'un simple postMessage.
  window.addEventListener('message', function(e){
    if(!e.data || typeof e.data !== 'object') return;
    if(!iframe || e.source !== iframe.contentWindow) return;
    if(e.data.type === 'mup-fiche-not-found'){
      dire("Cette fiche n'existe plus dans votre pipeline.");
      MUPFiche.close();
      return;
    }
    if(e.data.type === 'mup-fiche-close'){
      MUPFiche.close();
    }
  });

  window.MUPFiche = {
    open: function(id, opts){
      if(!id) return;
      ensureIframe();
      var accueil = (opts && opts.hote) || null;
      if(accueil){
        hote = accueil;
        geometrieAncree(iframe);
        if(iframe.parentNode !== hote) hote.appendChild(iframe);
        // Un appel ancré après un appel calque : le voile ne doit pas survivre
        // au changement de mode.
        if(backdrop){ backdrop.style.opacity = '0'; backdrop.style.display = 'none'; }
      } else {
        hote = null;
        ensureBackdrop();
        geometrieCalque(iframe);
        if(iframe.parentNode !== document.body) document.body.appendChild(iframe);
      }
      lastTrigger = (opts && opts.trigger) || null;
      // Réassigner src RECHARGE la fiche, et ce qui s'y écrit part avec : une
      // note en cours de frappe disparaissait au deuxième clic sur la carte déjà
      // sélectionnée. La garde vit ici et non chez les appelants, le défaut
      // étant le même depuis /agenda et depuis /visio.
      // Le changement d'hôte, lui, est un vrai changement : /visio franchit son
      // seuil en cours de séance et passe du calque à la colonne ancrée, la
      // fiche doit alors recharger dans son nouveau cadre.
      if(ficheChargee !== String(id) || hoteCharge !== hote){
        ficheChargee = String(id);
        hoteCharge = hote;
        iframe.src = '/pipeline?fiche=' + encodeURIComponent(id) + '&embed=panel';
      }
      show();
    },
    close: function(){
      hide();
      if(lastTrigger && typeof lastTrigger.focus === 'function'){
        try { lastTrigger.focus(); } catch(_){}
      }
      lastTrigger = null;
      try { window.dispatchEvent(new StorageEvent('storage', { key: 'mup_pipeline' })); } catch(_){}
    }
  };
})();
