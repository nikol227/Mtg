import { load, subscribe, backupJSON, restoreJSON, collectionTotals, state } from './store.js';
import { openModal, closeModal, download, toast, esc } from './ui.js';
import * as collectionView from './views/collection.js';
import * as buildView from './views/build.js';
import * as decksView from './views/decks.js';
import * as editorView from './views/editor.js';
import * as combosView from './views/combos.js';
import * as upgradeView from './views/upgrade.js';

const root = document.getElementById('view');

function route() {
  const hash = location.hash || (collectionTotals().total ? '#/decks' : '#/collection');
  const [, page, arg] = hash.split('/');
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === (page === 'deck' ? 'decks' : page)));
  return { page: page || 'collection', arg };
}

let current = null;
function render({ fromRoute = false } = {}) {
  const r = route();
  const key = `${r.page}/${r.arg || ''}`;
  if (fromRoute && current !== key) window.scrollTo(0, 0);
  current = key;
  if (document.getElementById('modal').open && fromRoute) closeModal();
  switch (r.page) {
    case 'build': return buildView.render(root);
    case 'decks': return decksView.render(root);
    case 'deck': return editorView.render(root, decodeURIComponent(r.arg || ''));
    case 'combos': return combosView.render(root);
    case 'upgrade': return upgradeView.render(root);
    default: return collectionView.render(root);
  }
}

window.addEventListener('hashchange', () => render({ fromRoute: true }));

// Re-render list-style views when data changes; the builder and editor manage their own updates.
subscribe(() => {
  const { page } = route();
  if (page === 'collection' || page === 'decks' || page === '') render();
});

document.getElementById('backup-btn').addEventListener('click', () => {
  const t = collectionTotals();
  openModal(`
    <div class="row spread"><h2 style="margin:0">Backup &amp; restore</h2><button class="btn ghost small" data-close>Close</button></div>
    <p class="small muted">Everything is stored in this browser. Download a backup to move to another device or browser, or to keep it safe if you clear site data.</p>
    <div class="stack">
      <div class="row"><button class="btn primary" id="bk-dl">Download backup</button><span class="small muted">${t.total.toLocaleString()} cards · ${state.decks.size} decks</span></div>
      <div>
        <label class="btn" for="bk-file">Restore from backup…</label>
        <input type="file" id="bk-file" accept=".json,application/json" class="hidden">
        <p class="small muted" style="margin-top:6px">Restoring replaces your current collection and decks.</p>
      </div>
    </div>`, (el) => {
    el.querySelector('#bk-dl').addEventListener('click', () => {
      download(`mtg-bulk-backup-${new Date().toISOString().slice(0, 10)}.json`, backupJSON(), 'application/json');
    });
    el.querySelector('#bk-file').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      if (!confirm('Replace your current collection and decks with this backup?')) return;
      try {
        await restoreJSON(await f.text());
        closeModal();
        toast('Backup restored');
        render();
      } catch (err) {
        toast(`Restore failed: ${err.message}`);
      }
    });
  });
});

(async () => {
  root.innerHTML = '<p class="muted"><span class="spinner"></span> Loading your collection…</p>';
  try {
    await load();
  } catch (e) {
    root.innerHTML = `<div class="notice warn">Couldn't open browser storage (${esc(e.message || e)}). Private/incognito windows may block it.</div>`;
    return;
  }
  if (!location.hash) history.replaceState(null, '', collectionTotals().total ? '#/decks' : '#/collection');
  render({ fromRoute: true });
})();
