// Entry point: load persisted state, hand it to the UI, keep it saved.

import { exportCSV, exportJSON, parseImportedJSON } from './exporters.js';
import { flushSave, getStorageWarning, loadState, saveState } from './state.js';
import { mount, render, showStorageWarning } from './ui.js';

const ctx = {
  state: loadState(),
  requestSave() {
    saveState(ctx.state, showStorageWarning);
  },
  actions: {
    exportCSV: () => exportCSV(ctx.state, ctx.state.activePeriodStart),
    exportJSON: () => exportJSON(ctx.state, ctx.state.activePeriodStart),
    importJSON(text) {
      const result = parseImportedJSON(text);
      if (!result.ok) return result;
      ctx.state = result.state;
      flushSave(ctx.state);
      showStorageWarning(getStorageWarning());
      return { ok: true };
    },
  },
};

mount(ctx);
showStorageWarning(getStorageWarning());

// A debounced save can still be pending when the tab goes away.
window.addEventListener('pagehide', () => flushSave(ctx.state));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushSave(ctx.state);
});

// Re-render if another tab edits the same data, so the two don't diverge.
window.addEventListener('storage', (event) => {
  if (event.key !== 'timecard-tracker/v1') return;
  ctx.state = loadState();
  render();
});
