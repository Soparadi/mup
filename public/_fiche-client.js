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

  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape' && iframe && iframe.style.display === 'block'){
      MUPFiche.close();
    }
  });

  window.addEventListener('message', function(e){
    if(!e.data || typeof e.data !== 'object') return;
    if(e.data.type === 'mup-fiche-close' || e.data.type === 'mup-fiche-not-found'){
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
