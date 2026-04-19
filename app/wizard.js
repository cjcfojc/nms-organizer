// First-run setup wizard.
// Drives the six-step flow in wizard.html: confirms the save folder, locates
// the NMS install, locates hgpaktool, optionally runs icon extraction, then
// writes nmsorganizer.config.json. After the final LAUNCH APP click we POST
// setup_completed=true and reload `/` so the server serves the real app.

const STEPS = ['welcome', 'save', 'install', 'hgpaktool', 'icons', 'done'];

const state = {
  status:   null,        // /setup/status response
  chosen: {              // resolved paths per step (what goes into config)
    nms_save_root:  null,
    nms_install:    null,
    hgpaktool:      null,
  },
  extractStarted: false,
  extractSucceeded: false,
};

document.addEventListener('DOMContentLoaded', async () => {
  // Environment badges
  document.querySelector('[data-platform]').textContent = navigator.platform || navigator.userAgentData?.platform || 'browser';
  document.querySelector('[data-node-version]').textContent = 'server';  // the real Node version is in the server's boot log

  initBrandMark();
  await refreshStatus();
  wireStepButtons();
  renderSaveStep();
  renderInstallStep();
  renderHgpaktoolStep();
  renderIconsStep();
  wireManualInputs();
  wireLaunch();
  showStep('welcome');
});

async function refreshStatus() {
  const r = await fetch('/setup/status');
  state.status = await r.json();
  Log.info('setup', 'status fetched', {
    configured: state.status.configured,
    nms_save_root: state.status.detected.nms_save_root,
    nms_install:   state.status.detected.nms_install,
    hgpaktool:     state.status.detected.hgpaktool,
    icons:         state.status.icons_extracted,
  });
  // Preload any paths the server already detected into state.chosen
  state.chosen.nms_save_root = state.status.detected.nms_save_root;
  state.chosen.nms_install   = state.status.detected.nms_install || (state.status.config?.nms_install ?? null);
  state.chosen.hgpaktool     = state.status.detected.hgpaktool   || (state.status.config?.hgpaktool   ?? null);
}

// ── Navigation ─────────────────────────────────────────────────────────────

function wireStepButtons() {
  document.body.addEventListener('click', e => {
    const next = e.target.closest('[data-next]');
    if (next) {
      if (!canAdvanceFrom(currentStep(), next)) return;
      showStep(next.dataset.next);
    }
    const prev = e.target.closest('[data-prev]');
    if (prev) showStep(prev.dataset.prev);
  });
}

function canAdvanceFrom(fromStep, btn) {
  const gate = btn.dataset.stepNeeds;
  if (!gate) return true;
  if (gate === 'save')      return !!state.chosen.nms_save_root;
  if (gate === 'install')   return !!state.chosen.nms_install;
  if (gate === 'hgpaktool') return !!state.chosen.hgpaktool;
  return true;
}

function currentStep() {
  for (const s of STEPS) {
    const pane = document.querySelector(`[data-pane="${s}"]`);
    if (pane && !pane.hidden) return s;
  }
  return STEPS[0];
}

function showStep(id) {
  for (const s of STEPS) {
    const pane = document.querySelector(`[data-pane="${s}"]`);
    if (pane) pane.hidden = (s !== id);
    const step = document.querySelector(`[data-step="${s}"]`);
    if (step) step.classList.toggle('active', s === id);
  }
}

// ── Step renderers ─────────────────────────────────────────────────────────

function renderSaveStep() {
  const el = document.querySelector('[data-save-result]');
  if (!state.chosen.nms_save_root) {
    el.classList.add('bad');
    el.innerHTML = `
      <b>NOT FOUND</b> — expected <code>%APPDATA%/HelloGames/NMS</code> (Windows) or equivalent.
      The server couldn't auto-detect your save folder. You can still run the app, but OPEN SAVE
      will fall back to the OS file picker and the WRITE-TO-NMS features won't work.`;
    return;
  }
  el.classList.add('good');
  el.innerHTML = `<b>FOUND</b> → <code>${esc(state.chosen.nms_save_root)}</code>`;
}

function renderInstallStep() {
  const el = document.querySelector('[data-install-result]');
  if (!state.chosen.nms_install) {
    el.classList.add('bad');
    el.innerHTML = `<b>NOT FOUND</b> — Steam library scan didn't locate <code>No Man's Sky</code>. Set it manually below.`;
    return;
  }
  el.classList.remove('bad');
  el.classList.add('good');
  el.innerHTML = `<b>FOUND</b> → <code>${esc(state.chosen.nms_install)}</code>`;
}

function renderHgpaktoolStep() {
  const el = document.querySelector('[data-hgpaktool-result]');
  if (!state.chosen.hgpaktool) {
    el.classList.add('bad');
    el.innerHTML = `<b>NOT FOUND</b> — checked your AMUMSS install directories and <code>tools/</code>. Pick one of the options below, or skip icons entirely.`;
    return;
  }
  el.classList.remove('bad');
  el.classList.add('good');
  el.innerHTML = `<b>FOUND</b> → <code>${esc(state.chosen.hgpaktool)}</code>`;
}

function renderIconsStep() {
  const status = document.querySelector('[data-extract-status]');
  if (state.status.icons_extracted && !state.extractStarted) {
    status.textContent = 'Already extracted — skip or re-run to refresh.';
    state.extractSucceeded = true;
    document.querySelector('[data-extract-allow-next]').disabled = false;
  }
}

// ── Manual overrides (NMS install / hgpaktool) ─────────────────────────────

function wireManualInputs() {
  document.querySelector('[data-install-test]').addEventListener('click', async () => {
    const p = document.querySelector('[data-install-input]').value.trim();
    if (!p) return;
    const ok = await verifyInstall(p);
    const el = document.querySelector('[data-install-result]');
    if (ok) {
      state.chosen.nms_install = p;
      el.classList.remove('bad'); el.classList.add('good');
      el.innerHTML = `<b>VERIFIED</b> → <code>${esc(p)}</code>`;
    } else {
      el.classList.remove('good'); el.classList.add('bad');
      el.innerHTML = `<b>NOT VALID</b> — <code>${esc(p)}/GAMEDATA/PCBANKS/NMSARC.TexUI.pak</code> not found.`;
    }
  });

  document.querySelector('[data-hgpaktool-test]').addEventListener('click', async () => {
    const p = document.querySelector('[data-hgpaktool-input]').value.trim();
    if (!p) return;
    // We can't stat a path from the browser — ask the server to confirm.
    const r = await fetch('/setup/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hgpaktool_test: p }),
    });
    const j = await r.json();
    // Re-fetch status to re-run auto-detection with the new config
    await refreshStatus();
    renderHgpaktoolStep();
  });
}

// Verify by pinging the server's auto-detect with the path folded into config.
// The detect helpers return null if the pak isn't actually there, so we can
// POST nms_install and re-read /setup/status to see if it was accepted.
async function verifyInstall(p) {
  await fetch('/setup/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nms_install: p }),
  });
  await refreshStatus();
  return state.chosen.nms_install === p;
}

// ── Icon extraction (SSE stream) ───────────────────────────────────────────

document.addEventListener('click', e => {
  if (e.target.closest('[data-extract-start]')) startExtraction();
});

function startExtraction() {
  if (state.extractStarted) return;
  state.extractStarted = true;
  const status = document.querySelector('[data-extract-status]');
  const log = document.querySelector('[data-extract-log]');
  const nextBtn = document.querySelector('[data-extract-allow-next]');
  log.textContent = '';
  status.textContent = 'starting…';
  status.className = 'wizard-extract-status running';

  // First persist the paths we have so the child process picks them up
  fetch('/setup/config', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ nms_install: state.chosen.nms_install, hgpaktool: state.chosen.hgpaktool }),
  }).then(() => {
    const es = new EventSource('/setup/extract-icons-stream');
    es.addEventListener('start',  e => {
      const d = JSON.parse(e.data);
      append(log, `$ ${['node', ...d.args].join(' ')}\n`);
    });
    es.addEventListener('stdout', e => append(log, JSON.parse(e.data).line + '\n'));
    es.addEventListener('stderr', e => append(log, '!! ' + JSON.parse(e.data).line + '\n'));
    es.addEventListener('done',   e => {
      const d = JSON.parse(e.data);
      es.close();
      if (d.code === 0) {
        status.textContent = 'EXTRACTION COMPLETE ✓';
        status.className = 'wizard-extract-status good';
        state.extractSucceeded = true;
        nextBtn.disabled = false;
      } else {
        status.textContent = `extraction failed — exit code ${d.code}. Check the log above.`;
        status.className = 'wizard-extract-status bad';
        state.extractStarted = false;   // allow retry
      }
    });
  });
}

function append(pre, text) {
  pre.textContent += text;
  pre.scrollTop = pre.scrollHeight;
}

// ── Finish ────────────────────────────────────────────────────────────────

function wireLaunch() {
  document.querySelector('[data-launch]').addEventListener('click', async () => {
    // Persist final config with setup_completed flag
    await fetch('/setup/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nms_install:     state.chosen.nms_install,
        hgpaktool:       state.chosen.hgpaktool,
        setup_completed: true,
        setup_completed_at: new Date().toISOString(),
      }),
    });
    window.location.href = '/';
  });
}

// ── Tiny helpers ──────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Cycle one of the banner images into the brand mark (same as main app does).
function initBrandMark() {
  const mark = document.querySelector('[data-brand-mark]');
  if (!mark) return;
  const candidates = [
    'assets/welcome_banner_1.png',
    'assets/welcome_banner_2.png',
    'assets/welcome_banner_3.png',
    'assets/welcome_banner.png',
  ];
  mark.src = candidates[Math.floor(Math.random() * candidates.length)];
  mark.onerror = () => {
    const fallback = mark.parentElement.querySelector('.brand-fallback');
    mark.remove();
    if (fallback) fallback.style.display = 'flex';
  };
}
