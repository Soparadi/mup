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

  // ── Barre latérale ──────────────────────────────────────────────────────
  // Trois états 100 % CSS (cf. sidebar.css) : barre dépliée ≥1441px, bande
  // d'icônes 641-1440px, tiroir ≤640px. La largeur est gouvernée par la seule
  // media query via var(--sidebar-w) ; le JS ne pose PLUS aucun état de repli.
  // Le seul état piloté ici est l'ouverture du tiroir mobile (body.sidebar-open,
  // cf. plus bas), sans persistance.

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
    + '<div id="sb-user-menu" role="menu" hidden style="position:fixed;width:180px;background-color:#FFFFFF;opacity:1;border:1px solid #E8E8ED;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.10);padding:4px;z-index:99999;">'
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
  // Rattaché à <body>, hors du rail. aside#sidebar est position:sticky (et
  // position:fixed en tiroir mobile) : il crée un CONTEXTE D'EMPILEMENT. Tant
  // que le menu vivait dedans, son z-index:99999 y restait confiné — le rail a
  // lui-même z-index:auto — si bien que tout contenu de page du contexte racine
  // (footer fixe z-index:5, carte Leaflet, grille d'agenda, cartes du dashboard)
  // passait AU-DESSUS du menu malgré son 99999. position:fixed lui fait échapper
  // au clip d'overflow du rail, mais pas à cet empilement. Sorti du rail, le menu
  // n'a plus d'ancêtre à contexte d'empilement et son z-index redevient effectif
  // au niveau racine — comme #sb-rail-flyout, déjà dans <body> pour la même
  // raison. Correctif global (un seul fichier), aucune page touchée, sticky non
  // levé. Les handlers plus bas réfèrent le menu par variable/id : valables après
  // déplacement. Placé AVANT la création du flyout → le flyout, ajouté après, le
  // suit dans le DOM ; sans effet, la garde d'exclusion (menu ouvert → pas de
  // flyout) interdit qu'ils coexistent.
  if (menu) document.body.appendChild(menu);
  // Menu fixé au viewport, ancré au bouton : il échappe au clip d'overflow du
  // rail (overflow-y:auto rend l'axe horizontal clippant) sans qu'on ait à
  // lever ce clip — donc valable aussi sur les six pages qui le redéclarent
  // inline. Ouverture vers le haut, coordonnées calculées à chaque ouverture.
  function positionMenu() {
    if (!btn || !menu) return;
    var r = btn.getBoundingClientRect();
    menu.style.left = Math.round(r.left) + 'px';
    // -6 : chevauche le haut du bouton de 6px, comme l'ancien calc(100% - 6px).
    menu.style.bottom = Math.round(window.innerHeight - r.top - 6) + 'px';
  }
  function setMenuOpen(open) {
    if (!btn || !menu) return;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) positionMenu();
    menu.hidden = !open;
  }
  window.addEventListener('resize', function(){ if (menu && !menu.hidden) positionMenu(); });
  // Fermeture au défilement : le menu est fixé au viewport mais son ancre (le
  // bouton) défile avec le rail (overflow-y:auto). Plutôt que repositionner à
  // chaque frame, on ferme — comportement usuel des menus déroulants. Écoute en
  // CAPTURE sur le document : un scroll de conteneur ne bulle pas jusqu'à
  // window, une écoute sur window seule serait inopérante.
  document.addEventListener('scroll', function(){
    if (menu && !menu.hidden) setMenuOpen(false);
  }, true);
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

  // ── Révélation des libellés au survol — mode bande (641-1440px) seulement ─
  // En bande, les items ne montrent qu'une icône (libellé écrasé par
  // font-size:0). Au survol on affiche le libellé en surimpression À DROITE de
  // la bande, dans un flyout injecté dans <body>, position:fixed piloté par le
  // rect de l'item — même principe qu'au menu compte, seul moyen d'échapper au
  // clip overflow-x du rail. Surimpression STRICTE : --sidebar-w ne bouge pas,
  // le contenu ne se décale pas. Les title= natifs restent le repli tactile.
  // Aucun état persistant, aucune classe mémorisée ; le clic reste la nav.
  var bandMq = window.matchMedia('(min-width: 641px) and (max-width: 1440px)');
  var flyout = document.createElement('div');
  flyout.id = 'sb-rail-flyout';
  flyout.setAttribute('aria-hidden', 'true');
  document.body.appendChild(flyout);

  function hideFlyout() { flyout.style.display = 'none'; }
  function showFlyoutFor(item) {
    if (!bandMq.matches) return;
    // Menu compte ouvert : il s'ouvre vers le haut depuis le même bord droit ;
    // un flyout d'item du bas s'y superposerait (même z-index). On s'efface.
    if (menu && !menu.hidden) return;
    var label = item.getAttribute('title') || '';
    if (!label) return;
    var r = item.getBoundingClientRect();
    flyout.textContent = label;
    flyout.style.top = Math.round(r.top + r.height / 2) + 'px';
    flyout.style.left = Math.round(r.right + 8) + 'px';
    flyout.style.display = 'block';
  }
  el.addEventListener('mouseover', function(e){
    var item = e.target && e.target.closest ? e.target.closest('a.sb-item') : null;
    if (item) showFlyoutFor(item); else hideFlyout();
  });
  el.addEventListener('mouseleave', hideFlyout);
  window.addEventListener('scroll', hideFlyout, true);
  if (bandMq.addEventListener) bandMq.addEventListener('change', hideFlyout);
  else if (bandMq.addListener) bandMq.addListener(hideFlyout);

  // ── Tiroir mobile (≤640px) : bouton d'ouverture + voile injectés ─────────
  // Pas d'ancrage HTML commun aux pages : on injecte nous-mêmes dans <body>.
  // Les éléments restent dans le DOM à toute largeur ; c'est la media query de
  // sidebar.css qui les masque au-dessus de 640px (display:none). Aucune
  // persistance : body.sidebar-open n'est jamais mémorisée, le tiroir repart
  // fermé à chaque page.
  var OPEN_CLASS = 'sidebar-open';

  var toggle = document.createElement('button');
  toggle.id = 'sb-drawer-toggle';
  toggle.type = 'button';
  toggle.setAttribute('aria-label', 'Ouvrir le menu');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'sidebar');
  toggle.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" '
    + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">'
    + '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/>'
    + '<line x1="3" y1="18" x2="21" y2="18"/></svg>';

  var scrim = document.createElement('div');
  scrim.id = 'sb-drawer-scrim';

  document.body.appendChild(toggle);
  document.body.appendChild(scrim);

  function drawerOpen() { return document.body.classList.contains(OPEN_CLASS); }
  function setDrawer(open) {
    document.body.classList.toggle(OPEN_CLASS, open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  toggle.addEventListener('click', function(){ setDrawer(!drawerOpen()); });
  scrim.addEventListener('click', function(){ setDrawer(false); });
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape' && drawerOpen()) setDrawer(false);
  });
  // Ferme à la navigation : un clic sur un lien de la barre bascule de page.
  el.addEventListener('click', function(e){
    if (e.target && e.target.closest && e.target.closest('a.sb-item, .sb-logo-link')) {
      setDrawer(false);
    }
  });

})();
