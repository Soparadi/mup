(function() {
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
    { label:'Devis & Factures', href:'/devis', bg:'background:rgba(29,131,72,.12);color:#1D8348', svg:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>' },
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
    + '<span class="sb-logo-name">MUP</span>'
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

  el.innerHTML = html;
})();
