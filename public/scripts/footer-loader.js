/* ================================================================== */
/* MovUP FOOTER LOADER — injecte /components/footer.html dans le slot  */
/* À placer juste avant </body>, idempotent, vanilla JS                */
/* ================================================================== */

(async function () {
  const slot = document.getElementById('mup-footer-slot');
  if (!slot) return;
  // Évite double-chargement si le script est inclus deux fois
  if (slot.dataset.mupFooterLoaded === '1') return;
  slot.dataset.mupFooterLoaded = '1';
  try {
    const res = await fetch('/components/footer.html');
    if (!res.ok) return;
    slot.innerHTML = await res.text();
  } catch (e) {
    console.warn('Footer load failed', e);
  }
})();
