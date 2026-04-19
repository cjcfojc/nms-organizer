// Save picker — list-based load flow.
//
// When the local server detects an NMS save folder on this machine, the OPEN SAVE
// button shows a modal listing the user's actual save slots (with friendly summary
// text from each manifest's SaveSummary field). One click loads BOTH save<N>.hg
// AND mf_save<N>.hg into the app — no OS file picker, no need to know which file
// is which.
//
// When NMS isn't detected, callers should fall back to the OS file picker.

// Pick a save from the list. Resolves with:
//   { source: 'list', folder, save: <slotEntry>, saveBytes, manifestBytes }
//   { source: 'cancel' }
//   { source: 'fallback' }   — user chose "Open from disk instead"
export async function pickSaveFromNmsFolder() {
  const folderInfo = await fetchJson('/nms/folder');
  if (!folderInfo.detected || !folderInfo.accounts || folderInfo.accounts.length === 0) {
    return { source: 'fallback' };
  }

  const account = folderInfo.accounts.length === 1
    ? folderInfo.accounts[0].name
    : await chooseAccount(folderInfo.accounts);
  if (!account) return { source: 'cancel' };

  const slots = await fetchJson(`/nms/slots?folder=${encodeURIComponent(account)}`);
  if (slots.error) throw new Error(`failed to list slots: ${slots.error}`);

  const chosen = await chooseSlot(account, slots.saves);
  if (chosen === 'fallback') return { source: 'fallback' };
  if (!chosen) return { source: 'cancel' };

  if (!chosen.manifest) {
    throw new Error(`${chosen.name} has no matching manifest (mf_${chosen.name}); cannot load`);
  }

  const [saveBytes, manifestBytes] = await Promise.all([
    fetchBytes(`/nms/read?folder=${encodeURIComponent(account)}&filename=${encodeURIComponent(chosen.name)}`),
    fetchBytes(`/nms/read?folder=${encodeURIComponent(account)}&filename=${encodeURIComponent(chosen.manifest)}`),
  ]);

  return {
    source: 'list',
    folder: account,
    save: chosen,
    saveBytes,
    manifestBytes,
  };
}

// ── account picker (only shown when >1 st_<steamid> folder exists) ────────────

function chooseAccount(accounts) {
  return openModal({
    title: 'SELECT NMS ACCOUNT',
    body:  `<p>Multiple NMS accounts found in your save folder. Pick which one to load from:</p>
            <ul class="modal-list">
              ${accounts.map((a, i) => `<li>
                <button class="btn" data-pick="${i}">
                  <code>${esc(a.name)}</code>
                  <span class="ar-k">last touched ${formatRelative(a.mtime)}</span>
                </button>
              </li>`).join('')}
            </ul>`,
    actions: [{ label: 'Cancel', value: null, kind: 'warn' }],
    onPick: (i) => accounts[Number(i)].name,
  });
}

// ── slot picker — friendly listing with SaveSummary + slot indexes ────────────

function chooseSlot(account, saves) {
  const slotsByIndex = new Map();
  for (const s of saves) {
    if (!slotsByIndex.has(s.slot_index)) slotsByIndex.set(s.slot_index, { auto: null, manual: null });
    slotsByIndex.get(s.slot_index)[s.slot_kind] = s;
  }
  const slotIndexes = [...slotsByIndex.keys()].sort((a, b) => a - b);

  // For each slot, NMS uses whichever of {auto, manual} was written most recently.
  // We surface that one as the "current" load target.
  const items = slotIndexes.map(idx => {
    const pair = slotsByIndex.get(idx);
    const newer = pickNewer(pair.auto, pair.manual);
    return { idx, pair, newer };
  });

  return openModal({
    title: `SELECT SAVE — ${esc(account)}`,
    body:  `<p>${items.length} slot${items.length === 1 ? '' : 's'} on disk. Click a slot to load both <code>save</code> and <code>mf_save</code> together.</p>
            <ul class="modal-list">
              ${items.map((it, i) => `<li>
                <button class="btn slot-pick" data-pick="${i}">
                  <span class="slot-pick-row">
                    <span class="slot-pick-num">SLOT ${it.idx}</span>
                    <span class="slot-pick-summary">${esc(it.newer.summary || '(no summary)')}</span>
                  </span>
                  <span class="slot-pick-row sub">
                    <span class="ar-k">${esc(it.newer.name)} · ${(it.newer.bytes / 1024).toFixed(0)} KB</span>
                    <span class="ar-k">${esc(it.newer.slot_kind)} · ${formatRelative(it.newer.last_write_unix * 1000)}</span>
                  </span>
                </button>
              </li>`).join('')}
            </ul>`,
    actions: [
      { label: 'Open from disk instead…', value: 'fallback' },
      { label: 'Cancel', value: null, kind: 'warn' },
    ],
    onPick: (i) => items[Number(i)].newer,
  });
}

// ── helpers ───────────────────────────────────────────────────────────────────

// Generic modal: returns the chosen value (whatever onPick returns) OR an action's value.
function openModal({ title, body, actions, onPick }) {
  return new Promise(resolve => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
      <div class="modal-card">
        <div class="modal-title">${title}</div>
        <div class="modal-body">${body}</div>
        <div class="modal-actions">
          ${actions.map((a, i) => `<button class="btn ${a.kind || ''}" data-action="${i}">${esc(a.label)}</button>`).join('')}
        </div>
      </div>`;
    document.body.appendChild(back);
    function done(v) { back.remove(); resolve(v); }
    back.addEventListener('click', e => {
      if (e.target === back) return done(null);
      const pick = e.target.closest('[data-pick]');
      if (pick) return done(onPick(pick.dataset.pick));
      const action = e.target.closest('[data-action]');
      if (action) return done(actions[Number(action.dataset.action)].value);
    });
  });
}

function pickNewer(a, b) {
  if (!a) return b;
  if (!b) return a;
  return (b.last_write_unix || b.mtime / 1000) > (a.last_write_unix || a.mtime / 1000) ? b : a;
}

function formatRelative(timestampMs) {
  if (!timestampMs) return 'unknown';
  const dt = Date.now() - timestampMs;
  if (dt < 60_000)        return 'just now';
  if (dt < 3_600_000)     return `${Math.round(dt / 60_000)} min ago`;
  if (dt < 86_400_000)    return `${Math.round(dt / 3_600_000)} hr ago`;
  if (dt < 30 * 86_400_000) return `${Math.round(dt / 86_400_000)} days ago`;
  return new Date(timestampMs).toISOString().slice(0, 10);
}

async function fetchJson(url) {
  const r = await fetch(url);
  return r.json();
}

async function fetchBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} → HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
