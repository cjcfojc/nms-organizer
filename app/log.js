// Logging module for No Man's Organizer.
// Self-contained: maintains an in-memory ring of log entries, renders them to the
// terminal pane, supports level/category/text filters, copy + download + clear.
//
// Public API (window.Log):
//   Log.debug   (category, message, data?)
//   Log.info    (category, message, data?)
//   Log.success (category, message, data?)
//   Log.warn    (category, message, data?)
//   Log.error   (category, message, data?)
//   Log.attach(rootEl)        — wire up DOM controls inside rootEl
//   Log.entries()             — read-only snapshot of the entries
//   Log.clear()               — empty the log (UI confirms)
//   Log.download()            — download as .txt
//   Log.copy()                — copy as text to clipboard
//
// Categories are free-form strings; the filter dropdown auto-populates from observed values.

(function () {
  const LEVELS = ['debug', 'info', 'success', 'warn', 'error'];
  const MAX_ENTRIES = 5000;

  const state = {
    entries: [],            // {ts, level, category, message, data}
    filter: { level: 'info', category: 'all', text: '' },
    autoScroll: true,
    listeners: new Set(),   // notified on every write
    bodyEl: null,
    statEl: null,
    levelSelect: null,
    categorySelect: null,
    textInput: null,
  };

  // Two-digit pad
  function pad(n, w = 2) { return String(n).padStart(w, '0'); }
  function fmtTs(d) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  }
  function fmtTsFull(d) {
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${fmtTs(d)}`;
  }

  function levelRank(l) { return LEVELS.indexOf(l); }
  function passesFilter(entry) {
    if (levelRank(entry.level) < levelRank(state.filter.level)) return false;
    if (state.filter.category !== 'all' && entry.category !== state.filter.category) return false;
    if (state.filter.text) {
      const hay = (entry.message + ' ' + (entry.data ? JSON.stringify(entry.data) : '')).toLowerCase();
      if (!hay.includes(state.filter.text.toLowerCase())) return false;
    }
    return true;
  }

  function renderEntry(entry) {
    if (!state.bodyEl) return;
    if (!passesFilter(entry)) return;
    const div = document.createElement('div');
    div.className = `log-line ${entry.level}`;
    div.dataset.ts = entry.ts.toISOString();

    const ts = document.createElement('span'); ts.className = 'ts'; ts.textContent = fmtTs(entry.ts);
    const lvl = document.createElement('span'); lvl.className = 'lvl'; lvl.textContent = entry.level.toUpperCase();
    const cat = document.createElement('span'); cat.className = 'cat'; cat.textContent = entry.category;
    const msg = document.createElement('span'); msg.className = 'msg'; msg.textContent = entry.message;

    div.append(ts, lvl, cat, msg);

    if (entry.data && Object.keys(entry.data).length > 0) {
      const data = document.createElement('div'); data.className = 'data';
      for (const [k, v] of Object.entries(entry.data)) {
        const span = document.createElement('span');
        span.innerHTML = `<span class="k">${k}=</span><span class="v">${escapeHtml(formatVal(v))}</span> `;
        data.appendChild(span);
      }
      div.appendChild(data);
    }

    state.bodyEl.appendChild(div);
    if (state.autoScroll) state.bodyEl.scrollTop = state.bodyEl.scrollHeight;
  }

  function rerenderAll() {
    if (!state.bodyEl) return;
    state.bodyEl.innerHTML = '';
    for (const e of state.entries) renderEntry(e);
    updateStat();
  }

  function updateStat() {
    if (!state.statEl) return;
    const visible = state.entries.filter(passesFilter).length;
    state.statEl.textContent = `${visible}/${state.entries.length}`;
  }

  function refreshCategoryOptions() {
    if (!state.categorySelect) return;
    const cats = new Set(state.entries.map(e => e.category));
    const current = state.categorySelect.value;
    const options = ['all', ...Array.from(cats).sort()];
    state.categorySelect.innerHTML = options
      .map(c => `<option value="${c}">${c}</option>`).join('');
    state.categorySelect.value = options.includes(current) ? current : 'all';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[ch]));
  }
  function formatVal(v) {
    if (v === null || v === undefined) return String(v);
    if (typeof v === 'number') return v.toLocaleString();
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  function write(level, category, message, data) {
    const entry = { ts: new Date(), level, category, message, data: data || null };
    state.entries.push(entry);
    if (state.entries.length > MAX_ENTRIES) state.entries.splice(0, state.entries.length - MAX_ENTRIES);
    renderEntry(entry);
    updateStat();
    state.listeners.forEach(fn => { try { fn(entry); } catch (e) { console.error(e); } });
    refreshCategoryOptions();
    queueRemote(entry);
  }

  // Remote sink: batch entries and POST to /log so the server's session log
  // captures both halves of the conversation. Failures are silent (best-effort)
  // and the in-app terminal is still the source of truth for the UI.
  const remote = {
    queue: [],
    timer: null,
    flushIntervalMs: 1000,
    maxBatch: 100,
  };
  function queueRemote(entry) {
    remote.queue.push({
      ts:       entry.ts.toISOString(),
      level:    entry.level,
      category: entry.category,
      msg:      entry.message,
      data:     entry.data || undefined,
    });
    if (remote.queue.length >= remote.maxBatch) flushRemote();
    else if (!remote.timer) remote.timer = setTimeout(flushRemote, remote.flushIntervalMs);
  }
  async function flushRemote() {
    remote.timer = null;
    if (!remote.queue.length) return;
    const batch = remote.queue.splice(0);
    try {
      await fetch('/log', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ entries: batch }),
        keepalive: true,
      });
    } catch (_) { /* server may be down — entries stay in the in-memory ring */ }
  }
  // Best-effort flush before unload
  window.addEventListener('beforeunload', flushRemote);

  function entriesToText() {
    return state.entries
      .map(e => `${fmtTsFull(e.ts)}  ${e.level.toUpperCase().padEnd(7)}  ${e.category.padEnd(10)}  ${e.message}${e.data ? '  ' + JSON.stringify(e.data) : ''}`)
      .join('\n');
  }

  const Log = {
    debug:   (cat, msg, data) => write('debug', cat, msg, data),
    info:    (cat, msg, data) => write('info', cat, msg, data),
    success: (cat, msg, data) => write('success', cat, msg, data),
    warn:    (cat, msg, data) => write('warn', cat, msg, data),
    error:   (cat, msg, data) => write('error', cat, msg, data),
    entries: () => state.entries.slice(),
    clear() {
      if (!confirm('Clear all log entries?')) return;
      state.entries.length = 0;
      rerenderAll();
      this.info('log', 'Log cleared by user');
    },
    download() {
      const blob = new Blob([entriesToText()], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      a.href = url; a.download = `nms-organizer-log_${ts}.txt`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.info('log', `Downloaded log (${state.entries.length} entries)`);
    },
    async copy() {
      try {
        await navigator.clipboard.writeText(entriesToText());
        this.success('log', `Copied ${state.entries.length} entries to clipboard`);
      } catch (err) {
        this.error('log', 'Failed to copy log to clipboard', { error: err.message });
      }
    },
    onWrite(fn) { state.listeners.add(fn); return () => state.listeners.delete(fn); },
    setFilter(partial) { Object.assign(state.filter, partial); rerenderAll(); },

    attach(rootEl) {
      state.bodyEl = rootEl.querySelector('[data-log-body]');
      state.statEl = rootEl.querySelector('[data-log-stat]');
      state.levelSelect = rootEl.querySelector('[data-log-level]');
      state.categorySelect = rootEl.querySelector('[data-log-category]');
      state.textInput = rootEl.querySelector('[data-log-text]');

      state.levelSelect.innerHTML = LEVELS.map(l =>
        `<option value="${l}"${l === state.filter.level ? ' selected' : ''}>${l.toUpperCase()}+</option>`
      ).join('');
      state.levelSelect.addEventListener('change', e => this.setFilter({ level: e.target.value }));
      state.categorySelect.addEventListener('change', e => this.setFilter({ category: e.target.value }));
      state.textInput.addEventListener('input', e => this.setFilter({ text: e.target.value }));

      rootEl.querySelector('[data-log-copy]').addEventListener('click', () => this.copy());
      rootEl.querySelector('[data-log-download]').addEventListener('click', () => this.download());
      rootEl.querySelector('[data-log-clear]').addEventListener('click', () => this.clear());
      rootEl.querySelector('[data-log-toggle]').addEventListener('click', () => {
        const app = document.querySelector('.app');
        const collapsed = app.dataset.terminal === 'collapsed';
        app.dataset.terminal = collapsed ? 'open' : 'collapsed';
        rootEl.querySelector('[data-log-toggle]').textContent = collapsed ? '▼' : '▲';
      });

      // Pause auto-scroll when user scrolls up; resume when they scroll back down
      state.bodyEl.addEventListener('scroll', () => {
        const atBottom = state.bodyEl.scrollHeight - state.bodyEl.scrollTop - state.bodyEl.clientHeight < 8;
        state.autoScroll = atBottom;
      });

      rerenderAll();
    },
  };

  window.Log = Log;
})();
