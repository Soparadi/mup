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
    overlay = document.createElement('div');
    overlay.id = 'mup-fiche-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.45);'
      + 'display:none;align-items:stretch;justify-content:center;padding:0;'
      + 'opacity:0;transition:opacity .18s ease;';
    overlay.addEventListener('click', function(e){
      if(e.target === overlay) MUPFiche.close();
    });
    iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:100%;max-width:780px;height:100%;border:none;'
      + 'background:#FFFFFF;box-shadow:0 16px 48px rgba(0,0,0,.18);';
    iframe.setAttribute('title', 'Fiche client');
    overlay.appendChild(iframe);
    document.body.appendChild(overlay);
    return overlay;
  }

  function showOverlay(){
    var o = ensureOverlay();
    o.style.display = 'flex';
    requestAnimationFrame(function(){ o.style.opacity = '1'; });
    document.body.style.overflow = 'hidden';
  }

  function hideOverlay(){
    if(!overlay) return;
    overlay.style.opacity = '0';
    setTimeout(function(){
      if(overlay) overlay.style.display = 'none';
      if(iframe) iframe.src = 'about:blank';
      document.body.style.overflow = '';
    }, 180);
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
