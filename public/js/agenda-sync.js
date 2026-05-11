// Infra propagation cross-tab pour la table agenda.
// Câble 3 listeners (storage / visibilitychange / focus) + debounce
// → trigger options.invalidateCacheFn() puis options.reloadFn() au bon moment.
//
// Usage type :
//   attachAgendaSync({
//     reloadFn: async () => { await loadXyz(); render(); },
//     invalidateCacheFn: () => { _cache = null; },
//     debounceMs: 150
//   });
//
// Garanties :
// - Idempotent : un seul appel par page suffit. Le debounce 150 ms absorbe
//   le double-trigger storage + visibilitychange qui surviennent ensemble.
// - Safe : un throw dans reloadFn ne casse pas la page (try/catch).
// - 3 triggers : storage (cross-tab), visibilitychange (retour onglet),
//   focus (backup pour Safari/iOS qui ne fire pas toujours visibilitychange).

(function () {
  window.attachAgendaSync = function attachAgendaSync(options) {
    var reloadFn = options && options.reloadFn;
    var invalidateCacheFn = options && options.invalidateCacheFn;
    var debounceMs = (options && typeof options.debounceMs === 'number') ? options.debounceMs : 150;
    if (typeof reloadFn !== 'function') return;

    var pending = null;
    function trigger() {
      if (pending) return;
      pending = setTimeout(async function () {
        pending = null;
        try { if (invalidateCacheFn) invalidateCacheFn(); } catch (e) { console.warn('[agenda-sync] invalidateCacheFn', e); }
        try { await reloadFn(); } catch (e) { console.warn('[agenda-sync] reloadFn', e); }
      }, debounceMs);
    }

    window.addEventListener('storage', function (e) {
      if (e && e.key === 'mup_agenda') trigger();
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') trigger();
    });
    window.addEventListener('focus', function () { trigger(); });
  };
})();
