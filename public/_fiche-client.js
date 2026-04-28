/* ————————————————————————————————————————————————
   MUPFiche — overlay iframe vers /pipeline?fiche=ID
   Réutilise la fiche détaillée du Pipeline depuis Visio + Contacts
   sans duplication de logique.
   ———————————————————————————————————————————————— */
(function(){
  if(window.MUPFiche) return; // singleton

  var overlay = null;
  var iframe = null;
  var lastTrigger = null;

  function ensureOverlay(){
    if(overlay) return overlay;
    // Backdrop léger (clic ferme la fiche)
    overlay = document.createElement('div');
    overlay.id = 'mup-fiche-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.30);'
      + 'display:none;opacity:0;transition:opacity .18s ease;';
    overlay.addEventListener('click', function(e){
      if(e.target === overlay) MUPFiche.close();
    });
    document.body.appendChild(overlay);

    // Panneau latéral droit (identique à .detail-panel de Pipeline)
    iframe = document.createElement('iframe');
    iframe.id = 'mup-fiche-iframe';
    iframe.style.cssText = 'position:fixed;right:0;top:0;bottom:0;width:380px;'
      + 'background:#FFFFFF;border-left:1px solid #E8E8ED;border:none;z-index:9001;'
      + 'transform:translateX(100%);transition:transform .25s ease;display:block;'
      + 'box-shadow:-8px 0 24px rgba(0,0,0,.10);';
    iframe.setAttribute('title', 'Fiche client');
    document.body.appendChild(iframe);
    return overlay;
  }

  function showOverlay(){
    ensureOverlay();
    overlay.style.display = 'block';
    iframe.style.display = 'block';
    requestAnimationFrame(function(){
      overlay.style.opacity = '1';
      iframe.style.transform = 'translateX(0)';
    });
    // Pas de body overflow:hidden — on veut pouvoir voir la visio derrière
  }

  function hideOverlay(){
    if(!overlay || !iframe) return;
    overlay.style.opacity = '0';
    iframe.style.transform = 'translateX(100%)';
    setTimeout(function(){
      if(overlay) overlay.style.display = 'none';
      if(iframe){
        iframe.style.display = 'none';
        iframe.src = 'about:blank';
      }
    }, 250);
  }

  // ESC ferme l'iframe overlay
  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape' && overlay && overlay.style.display !== 'none'){
      MUPFiche.close();
    }
  });

  // postMessage depuis l'iframe (pipeline.html en mode ?fiche=)
  window.addEventListener('message', function(e){
    if(!e.data || typeof e.data !== 'object') return;
    if(e.data.type === 'mup-fiche-close'){
      MUPFiche.close();
    } else if(e.data.type === 'mup-fiche-not-found'){
      MUPFiche.close();
      try { console.warn('[MUPFiche] introuvable:', e.data.id); } catch(_){}
    }
  });

  window.MUPFiche = {
    open: function(id, opts){
      if(!id) return;
      ensureOverlay();
      lastTrigger = (opts && opts.trigger) || null;
      iframe.src = '/pipeline?fiche=' + encodeURIComponent(id);
      showOverlay();
    },
    close: function(){
      hideOverlay();
      if(lastTrigger && typeof lastTrigger.focus === 'function'){
        try { lastTrigger.focus(); } catch(_){}
      }
      lastTrigger = null;
      // Notifie la page hôte qu'une éventuelle modification a eu lieu
      try { window.dispatchEvent(new StorageEvent('storage', { key: 'mup_pipeline' })); } catch(_){}
    }
  };
})();
