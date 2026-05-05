/* ================================================================== */
/* MovUP MARKETING LAYOUT LOADER                                      */
/* Injecte header-marketing.html + breadcrumb.html dans les slots     */
/* Initialise le toggle hamburger mobile                              */
/* ================================================================== */

(async function () {
  'use strict';

  async function inject(slotId, url) {
    const slot = document.getElementById(slotId);
    if (!slot) return null;
    if (slot.dataset.mupLoaded === '1') return slot;
    slot.dataset.mupLoaded = '1';
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      slot.innerHTML = await res.text();
      return slot;
    } catch (e) {
      console.warn('[marketing-layout] load failed:', url, e);
      return null;
    }
  }

  // 1. Header marketing
  const headerSlot = await inject('mup-mk-header-slot', '/components/header-marketing.html');

  // 2. Breadcrumb (uniquement si slot présent)
  const breadcrumbSlot = await inject('mup-mk-breadcrumb-slot', '/components/breadcrumb.html');
  if (breadcrumbSlot) {
    const title = breadcrumbSlot.dataset.pageTitle || document.title.split('·')[0].trim() || 'Page légale';
    const currentEl = breadcrumbSlot.querySelector('[data-mup-current]');
    if (currentEl) currentEl.textContent = title;
  }

  // 3. Toggle hamburger mobile
  if (headerSlot) {
    const toggle = headerSlot.querySelector('#mup-mk-toggle');
    const drawer = headerSlot.querySelector('#mup-mk-drawer');
    if (toggle && drawer) {
      toggle.addEventListener('click', () => {
        const open = drawer.classList.toggle('open');
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      // Ferme le drawer si clic sur un lien
      drawer.querySelectorAll('a').forEach((a) => {
        a.addEventListener('click', () => {
          drawer.classList.remove('open');
          toggle.setAttribute('aria-expanded', 'false');
        });
      });
      // Ferme si resize au-dessus du breakpoint
      window.addEventListener('resize', () => {
        if (window.innerWidth > 768 && drawer.classList.contains('open')) {
          drawer.classList.remove('open');
          toggle.setAttribute('aria-expanded', 'false');
        }
      });
    }
  }
})();
