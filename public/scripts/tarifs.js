/* ================================================================== */
/* MovUP /tarifs — toggle Mensuel/Annuel                              */
/* Met à jour les 4 prix simultanément via data-monthly / data-yearly */
/* ================================================================== */

(function () {
  'use strict';

  const toggle = document.getElementById('mk-toggle');
  if (!toggle) return;

  const buttons = toggle.querySelectorAll('button[data-period]');
  const priceEls = document.querySelectorAll('[data-price]');
  const periodNotes = document.querySelectorAll('[data-period-note]');

  function format(value) {
    // Supporte décimales virgule (24,65) ou entier (29)
    return value;
  }

  function setPeriod(period) {
    buttons.forEach((b) => {
      const active = b.dataset.period === period;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    priceEls.forEach((el) => {
      const monthly = el.dataset.monthly;
      const yearly = el.dataset.yearly;
      const next = period === 'yearly' ? yearly : monthly;
      if (next) el.textContent = format(next);
    });
    periodNotes.forEach((el) => {
      const monthlyNote = el.dataset.noteMonthly || '';
      const yearlyNote = el.dataset.noteYearly || '';
      el.textContent = period === 'yearly' ? yearlyNote : monthlyNote;
    });
  }

  buttons.forEach((b) => {
    b.addEventListener('click', () => {
      setPeriod(b.dataset.period);
    });
  });

  // Init mensuel par défaut
  setPeriod('monthly');
})();
