/* ————————————————————————————————————————————————
   MUPFiche — panneau latéral droit (380px) vers /pipeline?fiche=ID
   Réutilise la fiche Pipeline depuis Visio + Contacts.
   ———————————————————————————————————————————————— */
(function(){
  if(window.MUPFiche) return;

  var backdrop = null;
  var iframe = null;
  var lastTrigger = null;

  function ensureUI(){
    if(iframe) return;

    backdrop = document.createElement('div');
    backdrop.id = 'mup-fiche-backdrop';
    backdrop.style.cssText = 'position:fixed;inset:0;z-index:9000;'
      + 'background:rgba(0,0,0,.30);display:none;opacity:0;'
      + 'transition:opacity .18s ease;';
    backdrop.addEventListener('click', function(e){
      if(e.target === backdrop) MUPFiche.close();
    });
    document.body.appendChild(backdrop);

    iframe = document.createElement('iframe');
    iframe.id = 'mup-fiche-iframe';
    iframe.setAttribute('title', 'Fiche client');
    iframe.style.cssText = 'position:fixed;right:0;top:0;bottom:0;'
      + 'width:380px;height:100vh;background:#FFFFFF;border:none;'
      + 'border-left:1px solid #E8E8ED;z-index:9001;display:none;'
      + 'transform:translateX(100%);transition:transform .25s ease;'
      + 'box-shadow:-8px 0 24px rgba(0,0,0,.10);';
    document.body.appendChild(iframe);
  }

  function show(){
    ensureUI();
    backdrop.style.display = 'block';
    iframe.style.display = 'block';
    requestAnimationFrame(function(){
      backdrop.style.opacity = '1';
      iframe.style.transform = 'translateX(0)';
    });
  }

  function hide(){
    if(!iframe) return;
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

  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape' && iframe && iframe.style.display === 'block'){
      MUPFiche.close();
    }
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
      ensureUI();
      lastTrigger = (opts && opts.trigger) || null;
      iframe.src = '/pipeline?fiche=' + encodeURIComponent(id) + '&embed=panel';
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
