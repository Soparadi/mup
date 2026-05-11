(function() {
  // Migration silencieuse : entity_origine 'neox' → 'ei'
  try {
    ['mup_factures','mup_contacts','mup_pipeline','mup_devis','mup_agenda'].forEach(function(key){
      var raw = localStorage.getItem(key);
      if(!raw) return;
      var data;
      try { data = JSON.parse(raw); } catch(e){ return; }
      if(!Array.isArray(data)) return;
      var updated = false;
      data.forEach(function(item){
        if(item && item.entity_origine === 'neox'){ item.entity_origine = 'ei'; updated = true; }
      });
      if(updated) localStorage.setItem(key, JSON.stringify(data));
    });
  } catch(e){}

  // Inject unified sidebar styles with high specificity
  var ss = document.createElement('style');
  ss.textContent = ''
    + 'aside#sidebar.sidebar{width:clamp(200px,16vw,280px)!important;background:var(--surface,#F5F5F7)!important;border-right:1px solid var(--border,#E8E8ED)!important;display:flex!important;flex-direction:column!important;padding:16px 10px!important;flex-shrink:0!important;height:100vh!important;overflow-y:auto!important;box-sizing:border-box!important}'
    + 'aside#sidebar .sb-logo-link{text-decoration:none!important;display:flex!important;align-items:center!important;gap:10px!important;padding:12px 8px 14px!important;border-bottom:1px solid var(--border,#E8E8ED)!important;margin-bottom:8px!important}'
    + 'aside#sidebar .sb-logo-icon{width:28px!important;height:28px!important;background:var(--text,#1D1D1F)!important;border-radius:8px!important;display:flex!important;align-items:center!important;justify-content:center!important;flex-shrink:0!important}'
    + 'aside#sidebar .sb-logo-name{font-size:14px!important;font-weight:800!important;color:var(--text,#1D1D1F)!important;letter-spacing:-.3px!important}'
    + 'aside#sidebar .sb-label{font-size:9px!important;font-weight:700!important;letter-spacing:2px!important;text-transform:uppercase!important;color:var(--muted2,#AEAEB2)!important;padding:10px 8px 5px!important;margin-top:6px!important}'
    + 'aside#sidebar a.sb-item{display:flex!important;align-items:center!important;gap:9px!important;padding:8px 10px!important;border-radius:9px!important;font-size:12.5px!important;font-weight:500!important;color:var(--muted,#6E6E73)!important;transition:all .12s!important;text-decoration:none!important;cursor:pointer!important;border:1px solid transparent!important}'
    + 'aside#sidebar a.sb-item:hover{color:var(--text,#1D1D1F)!important;background:var(--surface2,#EBEBF0)!important}'
    + 'aside#sidebar a.sb-item.active{color:var(--text,#1D1D1F)!important;background:var(--card,#FFFFFF)!important;font-weight:600!important;border:1px solid var(--border,#E8E8ED)!important}'
    + 'aside#sidebar .sb-icon{width:22px!important;height:22px!important;border-radius:7px!important;display:flex!important;align-items:center!important;justify-content:center!important;flex-shrink:0!important}'
    + 'aside#sidebar .sb-badge{margin-left:auto!important;font-size:9px!important;font-weight:800!important;font-family:var(--mono,"Geist Mono",monospace)!important;background:var(--text,#1D1D1F)!important;color:#fff!important;border-radius:6px!important;padding:1px 6px!important}';
  document.head.appendChild(ss);

  const ITEMS = [
    { label:'Dashboard', href:'/dashboard', bg:'background:var(--text);color:#fff', svg:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>' },
    { label:'Leads', href:'/leads', bg:'background:rgba(255,165,0,.12);color:#E67E00', svg:'<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>' },
    { label:'Pipeline', href:'/pipeline', bg:'background:rgba(67,56,202,.12);color:#4338CA', svg:'<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>' },
    { label:'Agenda', href:'/agenda', bg:'background:rgba(29,131,72,.12);color:#1D8348', svg:'<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>' },
    { label:'Mail', href:'/mail', bg:'background:rgba(184,76,0,.12);color:#B84C00', svg:'<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>', badge: parseInt(localStorage.getItem('mup_mail_unread') || '0', 10) || null, badgeStyle:'background:var(--blue)' },
    { label:'Visio', href:'/visio', bg:'background:rgba(124,58,237,.12);color:#7C3AED', svg:'<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>' },
    { label:'Carte', href:'/carte', bg:'background:rgba(11,188,212,.12);color:#0BBCD4', svg:'<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>' },
    { label:'Contacts', href:'/contacts', bg:'background:rgba(10,102,194,.12);color:#0A66C2', svg:'<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>', badge: parseInt(localStorage.getItem('mup_contacts_count') || '0', 10) || null },
    { label:'Devis', href:'/devis', bg:'background:rgba(29,131,72,.12);color:#1D8348', svg:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>' },
    { label:'Factures', href:'/factures', bg:'background:rgba(245,158,11,.12);color:#F59E0B', svg:'<rect x="4" y="3" width="16" height="18" rx="2"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="12" y2="16"/>' },
    { label:'Frais', href:'/frais', bg:'background:rgba(184,76,0,.12);color:#B84C00', svg:'<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>' },
    { label:'Statistiques', href:'/statistiques', bg:'background:rgba(67,56,202,.12);color:#4338CA', svg:'<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>' }
  ];

  var path = window.location.pathname.replace(/\/+$/, '') || '/dashboard';
  if (path === '/') path = '/dashboard';

  var el = document.getElementById('sidebar');
  if (!el) return;

  var html = '<a href="/dashboard" class="sb-logo-link">'
    + '<div class="sb-logo-icon">'
    + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/></svg>'
    + '</div>'
    + '<span class="sb-logo-name">MovUP</span>'
    + '</a>'
    + '<div class="sb-label">Navigation</div>';

  for (var i = 0; i < ITEMS.length; i++) {
    var it = ITEMS[i];
    var active = (path === it.href) ? ' active' : '';
    html += '<a class="sb-item' + active + '" href="' + it.href + '">'
      + '<div class="sb-icon" style="' + it.bg + '">'
      + '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">' + it.svg + '</svg>'
      + '</div>'
      + it.label;
    if (it.badge) {
      var bs = it.badgeStyle ? ' style="' + it.badgeStyle + '"' : '';
      html += '<span class="sb-badge"' + bs + '>' + it.badge + '</span>';
    }
    html += '</a>';
  }

  // Stack en bas de sidebar : bouton Reset PUIS bloc utilisateur (tout en bas absolu).
  // Le lien "Légal" a été retiré (redondant avec le footer légal de chaque page app).
  // Wrapper avec margin-top:auto pour garantir position bottom indépendamment du
  // contenu. Pattern Stripe/Linear/Notion : user identity = dernier élément vertical.
  html += '<div id="sb-bottom-stack" style="margin-top:auto;display:flex;flex-direction:column;">'
    + '<div style="padding:8px 10px 12px;border-top:0.5px solid rgba(0,0,0,0.08);display:flex;flex-direction:column;gap:8px;">'
    +   '<button id="reset-mup-btn" style="width:100%;padding:8px 12px;background:transparent;border:0.5px solid rgba(220,50,50,0.3);border-radius:6px;color:#A32D2D;font-family:inherit;font-size:12px;cursor:pointer;transition:all .12s;">Réinitialiser MovUP</button>'
    + '</div>';

  // ── Bloc utilisateur — DERNIER élément de la sidebar, collé en bas absolu.
  // Lit window.__USER__ injecté serveur-side. Avatar 36×36 noir + nom + email
  // tronqué + chevron. Au clic : menu vers le haut avec "Mon compte" + "Déconnexion".
  html += '<div id="sb-user-wrap" style="border-top:0.5px solid rgba(0,0,0,0.08);padding:10px;position:relative;">'
    + '<button id="sb-user-btn" type="button" aria-haspopup="true" aria-expanded="false" style="width:100%;display:flex;align-items:center;gap:10px;padding:6px 8px;background:transparent;border:1px solid transparent;border-radius:9px;cursor:pointer;font-family:inherit;text-align:left;transition:background .12s,border-color .12s;">'
    +   '<span id="sb-user-avatar" aria-hidden="true" style="flex-shrink:0;width:36px;height:36px;background:#1D1D1F;color:#fff;border-radius:8px;display:flex;align-items:center;justify-content:center;font-family:Geist,-apple-system,sans-serif;font-weight:700;font-size:13px;letter-spacing:.2px;"></span>'
    +   '<span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;">'
    +     '<span id="sb-user-name" style="font-family:Geist,-apple-system,sans-serif;font-weight:500;font-size:12.5px;color:#1D1D1F;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></span>'
    +     '<span id="sb-user-email" style="font-family:Geist,-apple-system,sans-serif;font-weight:400;font-size:10.5px;color:#6E6E73;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></span>'
    +   '</span>'
    +   '<svg id="sb-user-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6E6E73" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;transition:transform .15s;"><polyline points="6 9 12 15 18 9"/></svg>'
    + '</button>'
    + '<div id="sb-user-menu" role="menu" hidden style="position:absolute;left:10px;right:10px;bottom:calc(100% - 6px);background-color:#FFFFFF;opacity:1;border:1px solid #E8E8ED;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.10);padding:4px;z-index:99999;display:flex;flex-direction:column;gap:2px;">'
    +   '<a href="/account/billing" role="menuitem" class="sb-user-menu-item" style="display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:7px;text-decoration:none;color:#1D1D1F;font-family:inherit;font-size:12.5px;font-weight:500;transition:background .12s;">'
    +     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'
    +     'Mon compte'
    +   '</a>'
    +   '<button id="sb-logout-btn" type="button" role="menuitem" class="sb-user-menu-item" style="display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:7px;background:transparent;border:none;color:#1D1D1F;font-family:inherit;font-size:12.5px;font-weight:500;cursor:pointer;text-align:left;transition:background .12s;">'
    +     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>'
    +     'Déconnexion'
    +   '</button>'
    + '</div>'
    + '</div>'
    + '</div>'; // close sb-bottom-stack

  el.innerHTML = html;

  // Hover styles pour items menu user (cohérent sidebar : fond gris clair)
  var userStyle = document.createElement('style');
  userStyle.textContent = ''
    + '#sb-user-btn:hover{background:#EBEBF0!important;}'
    + '#sb-user-btn[aria-expanded="true"]{background:#EBEBF0!important;border-color:#E8E8ED!important;}'
    + '.sb-user-menu-item:hover{background:#F5F5F7!important;}';
  document.head.appendChild(userStyle);

  // ── Hydratation depuis window.__USER__ (injecté serveur-side, pas de fetch) ──
  function userInitials(u) {
    if (!u) return '?';
    var src = (u.prenom && u.nom) ? (u.prenom + ' ' + u.nom)
            : (u.name || u.prenom || u.nom || u.email || '?');
    var parts = String(src).trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  function userDisplayName(u) {
    if (!u) return '';
    if (u.prenom && u.nom) return u.prenom + ' ' + u.nom;
    return u.name || u.prenom || u.nom || (u.email ? u.email.split('@')[0] : '');
  }
  var u = window.__USER__ || null;
  var avatarEl = document.getElementById('sb-user-avatar');
  var nameEl = document.getElementById('sb-user-name');
  var emailEl = document.getElementById('sb-user-email');
  if (avatarEl) avatarEl.textContent = userInitials(u);
  if (nameEl) nameEl.textContent = userDisplayName(u) || '—';
  if (emailEl) emailEl.textContent = (u && u.email) || '';

  // ── Menu déroulant : ouvre vers le haut, ferme au clic outside / Escape ──
  var btn = document.getElementById('sb-user-btn');
  var menu = document.getElementById('sb-user-menu');
  var chev = document.getElementById('sb-user-chev');
  function setMenuOpen(open) {
    if (!btn || !menu) return;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    menu.hidden = !open;
    if (chev) chev.style.transform = open ? 'rotate(180deg)' : '';
  }
  if (btn) {
    btn.addEventListener('click', function(e){
      e.stopPropagation();
      setMenuOpen(menu.hidden);
    });
  }
  document.addEventListener('click', function(e){
    if (!menu || menu.hidden) return;
    if (e.target && (e.target === btn || (btn && btn.contains(e.target)))) return;
    if (e.target && menu.contains(e.target)) return;
    setMenuOpen(false);
  });
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape' && menu && !menu.hidden) setMenuOpen(false);
  });

  // ── Logout : POST /api/auth/logout puis redirect /login ──
  var logoutBtn = document.getElementById('sb-logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', function(){
      logoutBtn.disabled = true;
      fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
        .finally(function(){ window.location.href = '/login'; });
    });
  }

  // ── PURGE LOGIC ──
  // 1. DELETE /api/reset-all → purge SurrealDB scopé userId (pipeline, agenda, contacts, devis,
  //    factures, frais, mail, visio, user_plan, user_settings, counter, etc.)
  // 2. Purge localStorage (préférences UI, caches obsolètes)
  // 3. Reload pour repartir d'un état vierge.
  // Si la route API échoue → alerte utilisateur, localStorage non purgé (état cohérent).
  async function resetMUP(){
    try {
      var res = await fetch('/api/reset-all', {
        method: 'DELETE',
        headers: { 'x-user-id': 'default' }
      });
      if (!res.ok) {
        var errBody = null;
        try { errBody = await res.json(); } catch(e){}
        alert('Erreur reset backend (HTTP ' + res.status + ')' + (errBody && errBody.error ? ' : ' + errBody.error : '') + '. Annulé.');
        return;
      }
      var data = await res.json();
      console.log('[reset]', data.deleted);
      // Purge localStorage (mup_*) après succès API
      var keysToDelete = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf('mup_') === 0) keysToDelete.push(k);
      }
      keysToDelete.forEach(function(k){ localStorage.removeItem(k); });
      // Compte total purgé côté SurrealDB pour feedback utilisateur
      var totalDb = 0;
      Object.keys(data.deleted || {}).forEach(function(t){
        var v = data.deleted[t];
        if (typeof v === 'number') totalDb += v;
      });
      alert('Réinitialisation effectuée. ' + totalDb + ' record(s) supprimé(s) en base · ' + keysToDelete.length + ' clé(s) localStorage purgée(s).');
      location.reload();
    } catch (e) {
      console.error('[reset]', e);
      alert('Erreur reset : ' + e.message);
    }
  }
  // Exposer globalement pour debug console
  window.MUP_RESET = function(){
    if(confirm('Réinitialiser MovUP ? (factures conservées)')) resetMUP();
  };

  // ── MODALE DOUBLE CONFIRMATION ──
  function openResetModal(){
    var existing = document.getElementById('reset-mup-overlay');
    if(existing) existing.remove();
    var ov = document.createElement('div');
    ov.id = 'reset-mup-overlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:99999;font-family:Geist,-apple-system,sans-serif;';
    ov.innerHTML = '<div id="reset-mup-card" style="background:#fff;border-radius:14px;padding:26px;width:480px;max-width:92vw;">'
      +'<div id="reset-step-1">'
      +'<div style="font-size:17px;font-weight:800;letter-spacing:-.3px;margin-bottom:10px;">Réinitialiser MovUP</div>'
      +'<div style="font-size:13px;color:#6E6E73;line-height:1.5;margin-bottom:18px;">Cette action va supprimer tous les prospects, RDV, leads, contacts, devis, agenda. Les <strong>factures réelles seront conservées</strong>.</div>'
      +'<div style="display:flex;gap:8px;justify-content:flex-end;">'
      +'<button id="rmu-cancel-1" style="padding:9px 16px;border:1px solid #E8E8ED;background:#fff;color:#1D1D1F;border-radius:8px;font-family:inherit;font-weight:600;font-size:12.5px;cursor:pointer;">Annuler</button>'
      +'<button id="rmu-continue" style="padding:9px 16px;border:none;background:#A32D2D;color:#fff;border-radius:8px;font-family:inherit;font-weight:700;font-size:12.5px;cursor:pointer;">Continuer</button>'
      +'</div></div>'
      +'<div id="reset-step-2" style="display:none;">'
      +'<div style="font-size:17px;font-weight:800;letter-spacing:-.3px;margin-bottom:10px;color:#A32D2D;">Confirmation finale</div>'
      +'<div style="font-size:13px;color:#6E6E73;line-height:1.5;margin-bottom:14px;">Tape exactement <strong style="font-family:Geist Mono,monospace;background:#F5F5F7;padding:2px 6px;border-radius:4px;">RESET</strong> ci-dessous pour confirmer la réinitialisation.</div>'
      +'<input id="rmu-input" type="text" placeholder="RESET" style="width:100%;padding:10px 12px;border:1px solid #E8E8ED;border-radius:8px;font-family:Geist Mono,monospace;font-size:14px;font-weight:600;letter-spacing:1px;margin-bottom:14px;text-align:center;text-transform:uppercase;" />'
      +'<div style="display:flex;gap:8px;justify-content:flex-end;">'
      +'<button id="rmu-cancel-2" style="padding:9px 16px;border:1px solid #E8E8ED;background:#fff;color:#1D1D1F;border-radius:8px;font-family:inherit;font-weight:600;font-size:12.5px;cursor:pointer;">Annuler</button>'
      +'<button id="rmu-confirm" disabled style="padding:9px 16px;border:none;background:#A32D2D;color:#fff;border-radius:8px;font-family:inherit;font-weight:700;font-size:12.5px;cursor:pointer;opacity:.4;">Réinitialiser</button>'
      +'</div></div>'
      +'</div>';
    document.body.appendChild(ov);
    var close = function(){ ov.remove(); };
    document.getElementById('rmu-cancel-1').onclick = close;
    document.getElementById('rmu-cancel-2').onclick = close;
    ov.addEventListener('click', function(e){ if(e.target === ov) close(); });
    document.getElementById('rmu-continue').onclick = function(){
      document.getElementById('reset-step-1').style.display = 'none';
      document.getElementById('reset-step-2').style.display = 'block';
      document.getElementById('rmu-input').focus();
    };
    var input = document.getElementById('rmu-input');
    var confirmBtn = document.getElementById('rmu-confirm');
    input.addEventListener('input', function(){
      var ok = this.value.trim().toUpperCase() === 'RESET';
      confirmBtn.disabled = !ok;
      confirmBtn.style.opacity = ok ? 1 : .4;
      confirmBtn.style.cursor = ok ? 'pointer' : 'not-allowed';
    });
    input.addEventListener('keydown', function(e){
      if(e.key === 'Enter' && !confirmBtn.disabled) confirmBtn.click();
    });
    confirmBtn.onclick = function(){ close(); resetMUP(); };
  }

  var resetBtn = document.getElementById('reset-mup-btn');
  if(resetBtn) resetBtn.addEventListener('click', openResetModal);

  // ── DETECTION DONNÉES DE TEST ──
  function detectTestData(){
    var pipeline = [];
    try { pipeline = JSON.parse(localStorage.getItem('mup_pipeline') || '[]'); } catch(e){}
    var testNames = ['BUFFALO GRILL','CERCLE MIXTE DE LA MARINE','EUREST SPORTS','INGESS INGENIERIE','RESDIDA','FM3G','FNB CONCEPT','NEW COURT','SERARE','SODEXO SPORTS','CASTEL TERRA','BREIZH CAFE','CHRISTIAN CHAVATTE','3 BRASSEURS'];
    var hasTestData = pipeline.some(function(p){
      var label = ((p.nom||'') + ' ' + (p.societe||'') + ' ' + (p.co||'') + ' ' + (p.name||'')).toUpperCase();
      return testNames.some(function(n){ return label.indexOf(n) !== -1; });
    });
    if(hasTestData) showResetBanner();
  }
  function showResetBanner(){
    if(document.getElementById('mup-test-banner')) return;
    var banner = document.createElement('div');
    banner.id = 'mup-test-banner';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#A32D2D;color:#fff;padding:12px 20px;text-align:center;z-index:9999;font-size:13px;font-family:Geist,-apple-system,sans-serif;';
    banner.innerHTML = 'Données de démonstration détectées dans MUP. '
      +'<button id="mup-banner-reset" style="margin-left:12px;padding:5px 14px;background:#fff;color:#A32D2D;border:none;border-radius:5px;cursor:pointer;font-weight:600;font-family:inherit;font-size:12px;">Vider maintenant (factures préservées)</button>'
      +'<button id="mup-banner-later" style="margin-left:8px;padding:5px 14px;background:transparent;color:#fff;border:0.5px solid #fff;border-radius:5px;cursor:pointer;font-family:inherit;font-size:12px;">Plus tard</button>';
    document.body.appendChild(banner);
    document.getElementById('mup-banner-reset').onclick = openResetModal;
    document.getElementById('mup-banner-later').onclick = function(){ banner.remove(); };
  }
  detectTestData();
})();
