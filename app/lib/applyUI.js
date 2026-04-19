// Apply tab renderer + orchestration.
//
// This is the last step before any save mutation. It runs strict pre-flight
// checks, performs the mutation in-memory, encodes to bytes, re-decodes and
// verifies integrity on touched containers, regenerates the matching mf_save.hg,
// and only then offers the user three output destinations:
//
//   DOWNLOAD .HG       — browser download of save.hg + mf_save.hg (always safe)
//   WRITE NEW SLOT     — POST both files to the next free saveN.hg slot in the NMS save folder
//   OVERWRITE ORIGINAL — POST both files back to the loaded path, replacing the originals
//
// Every successful apply also POSTs an audit JSON to the local server so a permanent
// record exists under nms_organizer/backups/.

import { applyPlanToJson, resolveContainerNode } from './apply.js';
import { encodeSaveBytes, decodeSaveBytes, sha256Hex } from './codec.js';
import { validatePlan } from './validate.js';
import { parsePayload, serializePayload, clonePayload } from './payload.js';
import { regenerateManifest } from './manifest.js';
import { slotForManifestFilename } from './xxtea.js';

// ── public API ─────────────────────────────────────────────────────────────────────

export function renderApplyTab(rootEl, state, onLog) {
  const { loaded, plan } = state;
  rootEl.innerHTML = '';

  // No plan loaded yet → empty-state placeholder
  if (!plan) {
    rootEl.innerHTML = `
      <div class="empty-state">
        <div class="glyph">⚠</div>
        <div class="msg">Apply plan to save</div>
        <div class="hint">Generate a plan in the Layout tab and review it in Preview, then return here to write it.</div>
      </div>`;
    return;
  }
  if (!loaded) {
    rootEl.innerHTML = `
      <div class="empty-state">
        <div class="glyph">⚠</div>
        <div class="msg">Save no longer in memory</div>
        <div class="hint">Re-open your save with ▸ OPEN SAVE before applying.</div>
      </div>`;
    return;
  }

  const validation = plan.validation || validatePlan(plan);
  plan.validation = validation;

  rootEl.appendChild(buildHeader(loaded, plan, validation));
  rootEl.appendChild(buildPreflightPanel(loaded, plan, validation));
  rootEl.appendChild(buildOutputPanel(loaded, plan, validation, state, onLog));
  rootEl.appendChild(buildResultPanel());
}

// ── markup builders ────────────────────────────────────────────────────────────────

function buildHeader(loaded, plan, validation) {
  const el = document.createElement('div');
  el.className = 'apply-header';
  const okClass = validation.ok ? 'cat-components' : 'cat-contraband';
  const okLabel = validation.ok ? 'VALIDATION PASS' : `VALIDATION FAIL · ${validation.errors.length}`;
  el.innerHTML = `
    <div class="apply-header-row">
      <span class="layout-stat">APPLY</span>
      <span class="apply-meta">save: <b>${esc(loaded.fileName || 'save.hg')}</b> · sha <code>${esc((loaded.sha256 || '').slice(0,16))}</code></span>
      <span class="audit-spacer"></span>
      <span class="cat-badge ${okClass}">${okLabel}</span>
    </div>
    <div class="apply-header-row">
      <span class="apply-meta">plan: <b>${esc(plan.preset_label || plan.preset_id || '—')}</b> · ${plan.summary.stacks_placed.toLocaleString()} stacks across ${plan.summary.destinations_used} container(s) · ${plan.summary.total_amount_in.toLocaleString()} units in transit</span>
    </div>`;
  return el;
}

function buildPreflightPanel(loaded, plan, validation) {
  const el = document.createElement('div');
  el.className = 'apply-section';
  const checks = [
    {
      ok: !!loaded.bytes,
      label: 'Original save bytes retained in memory',
      detail: loaded.bytes ? `${loaded.bytes.length.toLocaleString()} bytes` : 'missing — re-open the save',
    },
    {
      ok: !!loaded.backupPath,
      label: 'Auto-backup written at load time',
      detail: loaded.backupPath ? loaded.backupPath : 'NOT BACKED UP — refuse apply',
    },
    {
      ok: validation.ok,
      label: `Plan validation (${validation.summary.pass}/${validation.summary.total} checks)`,
      detail: validation.ok ? 'all invariants hold' : validation.errors.map(e => e.detail || e.label).slice(0, 3).join(' · '),
    },
    {
      ok: plan.summary.invariant_ok,
      label: 'Item-amount invariant (in === out + overflow)',
      detail: `in=${plan.summary.total_amount_in.toLocaleString()} out=${plan.summary.total_amount_out.toLocaleString()} overflow=${plan.summary.total_amount_overflowed.toLocaleString()}`,
    },
  ];
  el.innerHTML = `
    <div class="apply-section-title">PRE-FLIGHT</div>
    <ul class="apply-check-list">
      ${checks.map(c => `<li class="apply-check ${c.ok ? 'ok' : 'fail'}">
        <span class="ck-icon">${c.ok ? '✓' : '✗'}</span>
        <span class="ck-label">${esc(c.label)}</span>
        <span class="ck-detail">${esc(c.detail)}</span>
      </li>`).join('')}
    </ul>`;
  return el;
}

function buildOutputPanel(loaded, plan, validation, state, onLog) {
  const el = document.createElement('div');
  el.className = 'apply-section';
  const allClear   = validation.ok && plan.summary.invariant_ok && loaded.bytes && loaded.backupPath;
  const haveMf     = !!loaded.manifestBytes;
  const noMfHint   = haveMf ? '' : ` title="No mf_${esc(loaded.fileName||'save.hg')} was loaded — re-open the save with both files selected to enable manifest regeneration."`;

  el.innerHTML = `
    <div class="apply-section-title">OUTPUT</div>
    <div class="apply-output-buttons">
      <button class="btn primary apply-out-btn" data-apply-out="download" ${allClear ? '' : 'disabled'}>
        ⬇ DOWNLOAD BOTH FILES
        <span class="btn-sub">Browser-downloads <code>${esc(loaded.fileName||'save.hg')}</code> + <code>mf_${esc(loaded.fileName||'save.hg')}</code>. Originals untouched.</span>
      </button>
      <button class="btn apply-out-btn" data-apply-out="new-slot" ${allClear && haveMf ? '' : 'disabled'}${noMfHint}>
        ◇ WRITE NEW SLOT
        <span class="btn-sub">Writes the new save + manifest to the next free <code>saveN.hg</code> in your NMS save folder. Existing slots untouched.</span>
      </button>
      <button class="btn warn apply-out-btn" data-apply-out="overwrite" ${allClear && haveMf ? '' : 'disabled'}${noMfHint}>
        ! OVERWRITE ORIGINAL
        <span class="btn-sub">Replaces <code>${esc(loaded.fileName||'save.hg')}</code> + <code>mf_${esc(loaded.fileName||'save.hg')}</code> in place. Original is auto-backed-up to <code>backups/</code>. Requires typed confirm.</span>
      </button>
    </div>
    <div class="apply-help">
      Every NMS save is two files: <code>save.hg</code> (your data) and <code>mf_save.hg</code> (an integrity manifest). They MUST be installed as a pair — replacing only one breaks NomNom's compatibility check and may make the game refuse to load. All three output modes always emit BOTH files.
    </div>`;

  el.querySelector('[data-apply-out="download"]').addEventListener('click', () => runApply(state, 'download', onLog));
  const newSlotBtn   = el.querySelector('[data-apply-out="new-slot"]');
  const overwriteBtn = el.querySelector('[data-apply-out="overwrite"]');
  if (newSlotBtn   && !newSlotBtn.disabled)   newSlotBtn.addEventListener('click', () => runApply(state, 'new-slot', onLog));
  if (overwriteBtn && !overwriteBtn.disabled) overwriteBtn.addEventListener('click', () => runApply(state, 'overwrite', onLog));
  return el;
}

function buildResultPanel() {
  const el = document.createElement('div');
  el.className = 'apply-section apply-result';
  el.dataset.applyResult = '1';
  el.innerHTML = `<div class="apply-section-title">RESULT</div><div class="apply-result-body"><div class="apply-result-empty">No apply performed yet.</div></div>`;
  return el;
}

// ── core apply orchestration ───────────────────────────────────────────────────────

async function runApply(state, mode, onLog) {
  const log = (lvl, msg, data) => onLog && onLog(lvl, 'apply', msg, data);
  const resultBody = document.querySelector('[data-apply-result] .apply-result-body');
  if (resultBody) resultBody.innerHTML = `<div class="apply-result-empty">Working…</div>`;

  try {
    const { loaded, plan, structured } = state;
    if (!loaded || !loaded.bytes)  throw new Error('no save in memory');
    if (!plan)                     throw new Error('no plan generated');
    if (!loaded.backupPath)        throw new Error('refuse — no auto-backup recorded for this save');

    // 1. Re-validate plan against the latest in-memory structured save.
    log('info', 'pre-flight: re-running plan validator');
    const validation = validatePlan(plan);
    plan.validation = validation;
    if (!validation.ok) throw new Error(`plan validation failed: ${validation.errors.length} error(s)`);

    // 2. Float-aware deep clone so we never mutate state.loaded.json AND we
    //    preserve Float wrapper instances (structuredClone strips class identity).
    log('info', 'cloning save payload (Float-aware)');
    const t0 = performance.now();
    const jsonClone = clonePayload(loaded.json);
    log('debug', `clone in ${(performance.now() - t0).toFixed(1)}ms`);

    // 3. Apply the plan — direct JS object mutation (no splicing). Writes
    //    BOTH chest names (NKm) AND slot arrays (:No).
    log('info', 'applying plan');
    const tApply = performance.now();
    const result = applyPlanToJson(jsonClone, plan, structured);
    log('success', `apply OK in ${(performance.now() - tApply).toFixed(1)}ms`, result.summary);

    // 4. Serialize the mutated payload back to JSON text. Floats round-trip
    //    byte-identical via the Float wrapper's preserved source text.
    log('info', 'serializing payload');
    const tSer = performance.now();
    const newText = serializePayload(jsonClone);
    log('success', `serialize OK in ${(performance.now() - tSer).toFixed(1)}ms`, { bytes: newText.length });

    log('info', 'encoding to LZ4 chunks');
    const tEnc = performance.now();
    const payload = utf8encode(newText);
    const newBytes = encodeSaveBytes(payload);
    log('success', `encoded in ${(performance.now() - tEnc).toFixed(1)}ms`, {
      payload_bytes: payload.length,
      file_bytes:    newBytes.length,
    });

    // 5. Post-write integrity check: round-trip decode and verify our touched
    //    containers match what we wrote.
    log('info', 'post-write integrity: decoding the newly-written bytes');
    const decoded = decodeSaveBytes(newBytes);
    let decodedText = new TextDecoder('utf-8').decode(decoded);
    decodedText = decodedText.replace(/\u0000+$/g, '').replace(/\s+$/g, '');
    const reparsed = parsePayload(decodedText);
    log('success', 'post-write decode + parse OK');

    const integrity = verifyTouchedContainers(reparsed, jsonClone, result.touchedPaths);
    if (!integrity.ok) throw new Error(`post-write integrity FAIL: ${integrity.detail}`);
    log('success', `post-write integrity OK on ${result.touchedPaths.length} container(s)`);

    // 6. Resolve src + dst filenames + slots for manifest regeneration. For DOWNLOAD
    //    and OVERWRITE the destination matches the source. For WRITE NEW SLOT we
    //    discover the next free saveN.hg in the NMS folder and re-encrypt with that
    //    slot's key.
    const dst = await resolveDestination(mode, loaded, log);
    if (!dst.ok) throw new Error(dst.error);

    // 7. Generate the matching manifest (always — the apply pipeline refuses to
    //    proceed without manifestBytes to avoid emitting an orphan save.hg).
    if (!loaded.manifestBytes) throw new Error('no manifest bytes on loaded save — re-open with both save.hg + mf_save.hg selected');
    const srcSlot = slotForManifestFilename('mf_' + loaded.fileName);
    if (srcSlot == null) throw new Error(`cannot map source filename "${loaded.fileName}" to a manifest slot`);
    const dstSlot = slotForManifestFilename('mf_' + dst.saveFilename);
    if (dstSlot == null) throw new Error(`cannot map destination filename "${dst.saveFilename}" to a manifest slot`);
    log('info', `regenerating manifest (srcSlot=${srcSlot} → dstSlot=${dstSlot})`);
    const newMfBytes = regenerateManifest(loaded.manifestBytes, srcSlot, dstSlot, payload.length, newBytes.length);
    log('success', `manifest regenerated: ${newMfBytes.length} bytes`);

    // 8. Dispatch to the chosen output sink.
    const newSha = await sha256Hex(newBytes);
    let resultMeta = null;

    if (mode === 'download') {
      triggerDownload(newBytes, dst.saveFilename);
      setTimeout(() => triggerDownload(newMfBytes, dst.manifestFilename), 250);
      log('success', `downloaded ${dst.saveFilename} + ${dst.manifestFilename}`);
      resultMeta = { mode, saveFilename: dst.saveFilename, manifestFilename: dst.manifestFilename };
    } else if (mode === 'new-slot' || mode === 'overwrite') {
      log('info', `posting save → ${dst.folder}/${dst.saveFilename}`);
      await postNmsWrite(dst.folder, dst.saveFilename, newBytes, /*replace*/ mode === 'overwrite', log);
      log('info', `posting manifest → ${dst.folder}/${dst.manifestFilename}`);
      await postNmsWrite(dst.folder, dst.manifestFilename, newMfBytes, /*replace*/ mode === 'overwrite', log);
      log('success', `wrote both files into ${dst.folder}`);
      resultMeta = { mode, saveFilename: dst.saveFilename, manifestFilename: dst.manifestFilename, folder: dst.folder, slotIndex: dst.slotIndex };
    } else {
      throw new Error(`unknown output mode "${mode}"`);
    }

    await postAuditLog({
      mode,
      original_filename:         loaded.fileName,
      original_sha256:           loaded.sha256,
      applied_save_filename:     dst.saveFilename,
      applied_manifest_filename: dst.manifestFilename,
      applied_folder:            dst.folder || null,
      applied_save_sha256:       newSha,
      applied_save_bytes:        newBytes.length,
      applied_manifest_bytes:    newMfBytes.length,
      manifest_src_slot:         srcSlot,
      manifest_dst_slot:         dstSlot,
      plan_summary:              plan.summary,
      validation_summary:        validation.summary,
      containers_touched:        result.touchedPaths,
      backup_path:               loaded.backupPath,
    }, log);

    renderResult(resultBody, { ok: true, ...resultMeta, newSha, bytes: newBytes.length, plan });
  } catch (err) {
    log('error', `apply FAILED: ${err.message}`);
    if (resultBody) {
      resultBody.innerHTML = `<div class="apply-result-fail"><div class="ar-title">APPLY FAILED</div><div class="ar-msg">${esc(err.message)}</div><div class="ar-help">No file was written. Your original save is unchanged.</div></div>`;
    }
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────────

function utf8encode(s) {
  return new TextEncoder().encode(s);
}

// Compare each touched container's slots BEFORE encoding vs AFTER re-decoding.
// Asserts: same slot count, same id/amount/x/y in the same order.
function verifyTouchedContainers(reparsedRoot, expectedRoot, paths) {
  for (const path of paths) {
    const expectedNode = resolveContainerNode(expectedRoot, path);
    const actualNode   = resolveContainerNode(reparsedRoot, path);
    if (!expectedNode || !actualNode)
      return { ok: false, detail: `container ${path} missing on one side` };

    const exp = expectedNode[':No'];
    const act = actualNode[':No'];
    if (!Array.isArray(exp) || !Array.isArray(act))
      return { ok: false, detail: `container ${path} slots non-array` };
    if (exp.length !== act.length)
      return { ok: false, detail: `container ${path} slot count drift: expected ${exp.length}, got ${act.length}` };

    for (let i = 0; i < exp.length; i++) {
      const e = exp[i], a = act[i];
      if (e['b2n'] !== a['b2n'])
        return { ok: false, detail: `container ${path} slot[${i}] id drift: ${e['b2n']} → ${a['b2n']}` };
      if (e['1o9'] !== a['1o9'])
        return { ok: false, detail: `container ${path} slot[${i}] amount drift: ${e['1o9']} → ${a['1o9']}` };
      if ((e['3ZH'] && e['3ZH']['>Qh']) !== (a['3ZH'] && a['3ZH']['>Qh']))
        return { ok: false, detail: `container ${path} slot[${i}] x drift` };
      if ((e['3ZH'] && e['3ZH']['XJ>']) !== (a['3ZH'] && a['3ZH']['XJ>']))
        return { ok: false, detail: `container ${path} slot[${i}] y drift` };
    }
  }
  return { ok: true };
}

// Decide where the new save + manifest should go for a given output mode.
// Returns { ok, saveFilename, manifestFilename, folder?, slotIndex?, error? }.
async function resolveDestination(mode, loaded, log) {
  if (mode === 'download') {
    const stem = (loaded.fileName || 'save.hg').replace(/\.hg$/i, '');
    const ts   = new Date().toISOString().replace(/[T:.]/g, '-').replace(/Z$/, '').slice(0, 19);
    const saveFilename = `${stem}.organized.${ts}.hg`;
    return { ok: true, saveFilename, manifestFilename: 'mf_' + saveFilename };
  }

  if (mode === 'overwrite') {
    if (!loaded.fileName)     return { ok: false, error: 'no original filename to overwrite' };
    if (!loaded.manifestName) return { ok: false, error: 'no original manifest filename to overwrite' };
    const folder = await pickNmsFolderForOverwrite(loaded, log);
    if (!folder) return { ok: false, error: 'overwrite cancelled — no NMS folder selected or detected' };
    const confirmed = await confirmOverwrite(loaded);
    if (!confirmed) return { ok: false, error: 'overwrite cancelled by user' };
    return { ok: true, saveFilename: loaded.fileName, manifestFilename: loaded.manifestName, folder };
  }

  if (mode === 'new-slot') {
    const folder = await pickNmsFolderForOverwrite(loaded, log);
    if (!folder) return { ok: false, error: 'new-slot write cancelled — no NMS folder selected or detected' };
    const slots = await fetchJson(`/nms/slots?folder=${encodeURIComponent(folder)}`);
    if (slots.error) return { ok: false, error: `slot-listing failed: ${slots.error}` };
    log('info', `next free slot in ${folder}: ${slots.next_free_name} (slot index ${slots.next_free_slot})`);
    return {
      ok: true,
      saveFilename:     slots.next_free_name,
      manifestFilename: 'mf_' + slots.next_free_name,
      folder,
      slotIndex:        slots.next_free_slot,
    };
  }

  return { ok: false, error: `unknown mode "${mode}"` };
}

// Pick the NMS folder for write/overwrite. Strategy:
//   1. If only one st_<steamid> account exists in NMS_ROOT, use it.
//   2. Else prompt the user (simple modal listing the candidates by mtime).
async function pickNmsFolderForOverwrite(loaded, log) {
  const info = await fetchJson('/nms/folder');
  if (!info.detected) {
    log('error', 'NMS save folder not detected on this OS — only DOWNLOAD output works here.');
    return null;
  }
  if (!info.accounts || info.accounts.length === 0) {
    log('error', `NMS root found at ${info.root} but no st_<steamid> subfolders inside.`);
    return null;
  }
  if (info.accounts.length === 1) return info.accounts[0].name;
  return chooseAccountFolder(info.accounts);
}

// Modal: list st_<steamid> folders and let the user pick. Returns the chosen name or null.
function chooseAccountFolder(accounts) {
  return new Promise(resolve => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
      <div class="modal-card">
        <div class="modal-title">SELECT NMS ACCOUNT FOLDER</div>
        <div class="modal-body">
          <p>Multiple Steam accounts have NMS save folders. Pick which one to write to:</p>
          <ul class="modal-list">
            ${accounts.map((a, i) => `<li><button class="btn" data-folder-idx="${i}"><code>${esc(a.name)}</code> <span class="ar-k">last modified ${new Date(a.mtime).toISOString().slice(0, 16).replace('T', ' ')}</span></button></li>`).join('')}
          </ul>
        </div>
        <div class="modal-actions"><button class="btn warn" data-cancel>Cancel</button></div>
      </div>`;
    document.body.appendChild(back);
    back.addEventListener('click', e => {
      if (e.target.matches('[data-cancel]') || e.target === back) { back.remove(); resolve(null); return; }
      const btn = e.target.closest('[data-folder-idx]');
      if (btn) { back.remove(); resolve(accounts[Number(btn.dataset.folderIdx)].name); }
    });
  });
}

// Typed-confirm modal for OVERWRITE ORIGINAL. Returns true only if the user
// types the save filename exactly.
function confirmOverwrite(loaded) {
  return new Promise(resolve => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
      <div class="modal-card">
        <div class="modal-title warn">OVERWRITE ORIGINAL?</div>
        <div class="modal-body">
          <p>This will replace <code>${esc(loaded.fileName)}</code> AND <code>${esc(loaded.manifestName || 'mf_' + loaded.fileName)}</code> in your NMS save folder.</p>
          <p>The originals will be backed up to <code>backups/</code> first. Auto-backup at load time is also still on disk: <code>${esc(loaded.backupPath || '(none)')}</code>.</p>
          <p>Type the save filename exactly to confirm:</p>
          <input type="text" class="modal-input" data-confirm-input placeholder="${esc(loaded.fileName)}" autofocus />
        </div>
        <div class="modal-actions">
          <button class="btn" data-cancel>Cancel</button>
          <button class="btn warn" data-confirm disabled>Overwrite</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    const input = back.querySelector('[data-confirm-input]');
    const okBtn = back.querySelector('[data-confirm]');
    input.addEventListener('input', () => {
      okBtn.disabled = input.value !== loaded.fileName;
    });
    back.addEventListener('click', e => {
      if (e.target.matches('[data-cancel]') || e.target === back) { back.remove(); resolve(false); }
      else if (e.target.matches('[data-confirm]')) { back.remove(); resolve(true); }
    });
    setTimeout(() => input.focus(), 0);
  });
}

// POST raw bytes to /nms/write. `replace=true` allows overwriting an existing file
// (server backs the existing one up first).
async function postNmsWrite(folder, filename, bytes, replace, log) {
  const qs = `folder=${encodeURIComponent(folder)}&filename=${encodeURIComponent(filename)}`;
  const r = await fetch(`/nms/write?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...(replace ? { 'X-NMSO-Replace': '1' } : {}) },
    body: bytes,
  });
  const meta = await r.json();
  if (!r.ok) throw new Error(`write to ${filename} failed: ${meta.error || `HTTP ${r.status}`}`);
  if (meta.pre_overwrite_backup) log('info', `pre-overwrite backup saved: ${meta.pre_overwrite_backup}`);
  return meta;
}

async function fetchJson(url) {
  const r = await fetch(url);
  return r.json();
}

function triggerDownload(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
}

async function postAuditLog(audit, log) {
  try {
    const r = await fetch('/apply/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-NMSO-Filename': audit.original_filename || 'save.hg' },
      body: JSON.stringify(audit, null, 2),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const meta = await r.json();
    log('success', `audit log written: ${meta.relative_path}`);
  } catch (err) {
    log('warn', `audit log POST failed: ${err.message} — file still downloaded successfully`);
  }
}

function renderResult(rootEl, r) {
  if (!r.ok) return;
  let title, help;
  if (r.mode === 'download') {
    title = 'DOWNLOAD READY';
    help  = 'Both files are in your Downloads folder. Drop them BOTH into your NMS save folder (replacing the originals — back them up first). They must be installed as a pair.';
  } else if (r.mode === 'new-slot') {
    title = `WRITTEN TO SLOT ${r.slotIndex}`;
    help  = `Both files are in your NMS save folder under <code>${esc(r.folder)}/</code>. Launch NMS — the new save should appear as slot ${r.slotIndex} in the Load Game menu. Your existing slots are untouched.`;
  } else if (r.mode === 'overwrite') {
    title = 'ORIGINAL OVERWRITTEN';
    help  = `The loaded save and its manifest were replaced in place. Pre-overwrite backups were written to <code>backups/</code> alongside the load-time backup. NMS will load the new contents next time you select this slot.`;
  }
  rootEl.innerHTML = `
    <div class="apply-result-ok">
      <div class="ar-title">${title}</div>
      <div class="ar-row"><span class="ar-k">save</span><span class="ar-v"><code>${esc(r.saveFilename)}</code> (${r.bytes.toLocaleString()} B)</span></div>
      <div class="ar-row"><span class="ar-k">manifest</span><span class="ar-v"><code>${esc(r.manifestFilename)}</code></span></div>
      ${r.folder ? `<div class="ar-row"><span class="ar-k">folder</span><span class="ar-v"><code>${esc(r.folder)}</code></span></div>` : ''}
      <div class="ar-row"><span class="ar-k">sha-256</span><span class="ar-v"><code>${esc(r.newSha)}</code></span></div>
      <div class="ar-row"><span class="ar-k">stacks placed</span><span class="ar-v">${r.plan.summary.stacks_placed.toLocaleString()}</span></div>
      <div class="ar-help">${help}</div>
    </div>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[ch]));
}
