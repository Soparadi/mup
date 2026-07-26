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

  // Styles sidebar : externalisés dans /styles/sidebar.css (chargé en <head> par chaque page app).

  const ITEMS = [
    { label:'Dashboard', href:'/dashboard', bg:'background:var(--text);color:#fff', svg:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>' },
    { label:'Prospection', href:'/prospection', bg:'background:rgba(255,165,0,.12);color:#E67E00', svg:'<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>' },
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

  // ── Barre latérale escamotable ──────────────────────────────────────────
  // Largeur pilotée en CSS par var(--sidebar-w). Ici on ne gère que la CLASSE
  // sur <body> qui décide de l'état visuel (bande d'icônes) et sert de repli
  // de largeur. Source de vérité = localStorage.mup_sidebar_collapsed :
  //   'true'  → replié explicite      (classe sidebar-collapsed)
  //   'false' → déplié explicite      (classe sidebar-expanded, prime media query)
  //   absent  → auto : la media query gouverne (classe sidebar-collapsed posée
  //             en mode auto étroit pour que les libellés s'effacent aussi).
  var COLLAPSE_KEY = 'mup_sidebar_collapsed';
  var AUTO_QUERY = '(max-width: 1440px)';
  function collapseStored() {
    try { return localStorage.getItem(COLLAPSE_KEY); } catch (e) { return null; }
  }
  function autoCollapsed() {
    try { return !!(window.matchMedia && window.matchMedia(AUTO_QUERY).matches); }
    catch (e) { return false; }
  }
  // state : 'collapsed' | 'expanded' | 'auto-expanded' (aucune classe).
  function applyState(state) {
    var b = document.body;
    if (!b) return;
    b.classList.remove('sidebar-collapsed', 'sidebar-expanded');
    if (state === 'collapsed') b.classList.add('sidebar-collapsed');
    else if (state === 'expanded') b.classList.add('sidebar-expanded');
    // 'auto-expanded' → aucune classe, la media query gouverne la largeur.
  }
  function initialState() {
    var s = collapseStored();
    if (s === 'true') return 'collapsed';
    if (s === 'false') return 'expanded';
    return autoCollapsed() ? 'collapsed' : 'auto-expanded';
  }
  function isCollapsedNow() {
    return document.body.classList.contains('sidebar-collapsed');
  }
  // AVANT le premier rendu de la barre — sinon la page scintille au chargement.
  applyState(initialState());

  var html = '<a href="/dashboard" class="sb-logo-link" aria-label="Accueil MovUP">'
    + '<img src="/logo-v7-movup-court.svg" alt="MovUP" class="sb-logo-img sb-logo-img--full">'
    + '<img src="/movup-mark.svg" alt="" aria-hidden="true" class="sb-logo-img sb-logo-img--mark">'
    + '</a>'
    + '<div class="sb-label">Navigation</div>';

  for (var i = 0; i < ITEMS.length; i++) {
    var it = ITEMS[i];
    var active = (path === it.href) ? ' active' : '';
    html += '<a class="sb-item' + active + '" href="' + it.href + '" title="' + it.label + '">'
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

  // ── Entrée Superadmin — CONFORT D'AFFICHAGE, PAS LA SÉCURITÉ ──
  // Dessinée UNIQUEMENT si le compte connecté est dev@soparadi.com (comparaison
  // normalisée lowercase+trim). Pour tout autre compte ou si __USER__ est absent,
  // l'entrée n'est pas générée du tout (absente du DOM). La vraie barrière reste
  // le 403 serveur sur /api/admin/comptes — ce lien ne fait qu'éviter d'exposer
  // /superadmin aux abonnés.
  var suEmail = window.__USER__ && window.__USER__.email
    ? String(window.__USER__.email).toLowerCase().trim() : '';
  if (suEmail === 'dev@soparadi.com') {
    var suActive = (path === '/superadmin') ? ' active' : '';
    html += '<a class="sb-item' + suActive + '" href="/superadmin" title="Superadmin">'
      + '<div class="sb-icon" style="background:rgba(29,29,31,.08);color:#1D1D1F">'
      + '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>'
      + '</div>'
      + 'Superadmin'
      + '</a>';
  }

  // Stack en bas de sidebar : bloc utilisateur (tout en bas absolu).
  // Le lien "Légal" a été retiré (redondant avec le footer légal de chaque page app).
  // Wrapper avec margin-top:auto pour garantir position bottom indépendamment du
  // contenu. Pattern Stripe/Linear/Notion : user identity = dernier élément vertical.
  html += '<div id="sb-bottom-stack" style="margin-top:auto;display:flex;flex-direction:column;">';

  // ── Bouton de repli — même patron que #sb-user-btn (bouton + aria-expanded).
  // aria-expanded = true quand la barre est dépliée. Le chevron pointe « ‹ »
  // (replier) ; il est inversé en CSS à l'état replié pour pointer « › ».
  html += '<button id="sb-collapse-btn" type="button" aria-expanded="' + (isCollapsedNow() ? 'false' : 'true') + '" '
    +   'aria-label="' + (isCollapsedNow() ? 'Déplier la barre latérale' : 'Replier la barre latérale') + '" '
    +   'style="width:100%;display:flex;align-items:center;gap:9px;padding:8px 10px;margin:0 0 4px;background:transparent;border:1px solid transparent;border-radius:9px;cursor:pointer;font-family:inherit;font-size:12.5px;font-weight:500;color:#6E6E73;text-align:left;transition:background .15s,border-color .15s;">'
    +   '<span class="sb-icon" aria-hidden="true" style="background:rgba(29,29,31,.08);color:#6E6E73;">'
    +     '<svg id="sb-collapse-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="transition:transform .2s ease;"><polyline points="15 18 9 12 15 6"/></svg>'
    +   '</span>'
    +   '<span id="sb-collapse-label">Replier</span>'
    + '</button>';

  // ── Bloc utilisateur — DERNIER élément de la sidebar, collé en bas absolu.
  // Lit window.__USER__ injecté serveur-side. Avatar 36×36 noir + nom + email
  // tronqué. TOUT le bouton est cliquable (avatar/nom/email/zone vide), feedback
  // hover visible. Au clic : menu vers le haut avec "Mon compte" + "Déconnexion".
  html += '<div id="sb-user-wrap" style="border-top:0.5px solid rgba(0,0,0,0.08);padding:10px;position:relative;">'
    + '<button id="sb-user-btn" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Compte utilisateur" style="width:100%;display:flex;align-items:center;gap:10px;padding:8px 10px;background:transparent;border:1px solid transparent;border-radius:9px;cursor:pointer;font-family:inherit;text-align:left;transition:background .15s,border-color .15s;">'
    +   '<span id="sb-user-avatar" aria-hidden="true" style="flex-shrink:0;width:36px;height:36px;background:#1D1D1F;color:#fff;border-radius:8px;display:flex;align-items:center;justify-content:center;font-family:Geist,-apple-system,sans-serif;font-weight:700;font-size:13px;letter-spacing:.2px;"></span>'
    +   '<span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;">'
    +     '<span id="sb-user-name" style="font-family:Geist,-apple-system,sans-serif;font-weight:500;font-size:12.5px;color:#1D1D1F;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></span>'
    +     '<span id="sb-user-email" style="font-family:Geist,-apple-system,sans-serif;font-weight:400;font-size:10.5px;color:#6E6E73;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></span>'
    +   '</span>'
    + '</button>'
    + '<div id="sb-user-menu" role="menu" hidden style="position:absolute;left:10px;right:10px;bottom:calc(100% - 6px);background-color:#FFFFFF;opacity:1;border:1px solid #E8E8ED;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.10);padding:4px;z-index:99999;">'
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

  // Hover bloc user : visible (fond gris + bordure) pour signaler interactivité.
  // État ouvert : même style. Items menu : hover gris très clair.
  var userStyle = document.createElement('style');
  userStyle.textContent = ''
    + '#sb-user-btn:hover{background:#E8E8ED!important;border-color:#D1D1D6!important;}'
    + '#sb-user-btn:focus-visible{outline:none;background:#E8E8ED!important;border-color:#1D1D1F!important;box-shadow:0 0 0 2px rgba(29,29,31,.12);}'
    + '#sb-user-btn[aria-expanded="true"]{background:#E8E8ED!important;border-color:#D1D1D6!important;}'
    + '#sb-user-menu{display:flex;flex-direction:column;gap:2px;}'
    + '#sb-user-menu[hidden]{display:none!important;}'
    + '.sb-user-menu-item:hover{background:#F5F5F7!important;}'
    + '#sb-collapse-btn:hover{background:#EBEBF0!important;color:#1D1D1F!important;}'
    + '#sb-collapse-btn:focus-visible{outline:none;background:#EBEBF0!important;border-color:#1D1D1F!important;box-shadow:0 0 0 2px rgba(29,29,31,.12);}';
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
  function setMenuOpen(open) {
    if (!btn || !menu) return;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    menu.hidden = !open;
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

  // ── Bouton de repli : bascule + persistance du choix explicite ──
  var collapseBtn = document.getElementById('sb-collapse-btn');
  function refreshCollapseBtn() {
    if (!collapseBtn) return;
    var collapsed = isCollapsedNow();
    collapseBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    collapseBtn.setAttribute('aria-label', collapsed ? 'Déplier la barre latérale' : 'Replier la barre latérale');
  }
  if (collapseBtn) {
    collapseBtn.addEventListener('click', function(){
      var next = !isCollapsedNow();                       // état visé
      applyState(next ? 'collapsed' : 'expanded');        // choix EXPLICITE
      try { localStorage.setItem(COLLAPSE_KEY, next ? 'true' : 'false'); } catch (e) {}
      refreshCollapseBtn();
    });
  }
  // En mode auto (aucun choix explicite), suit la media query au redimensionnement.
  try {
    var mq = window.matchMedia(AUTO_QUERY);
    var onAutoChange = function(){
      if (collapseStored() !== null) return;              // choix explicite → on n'y touche pas
      applyState(mq.matches ? 'collapsed' : 'auto-expanded');
      refreshCollapseBtn();
    };
    if (mq.addEventListener) mq.addEventListener('change', onAutoChange);
    else if (mq.addListener) mq.addListener(onAutoChange);
  } catch (e) {}

})();
