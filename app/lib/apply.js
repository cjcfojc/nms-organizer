// Apply pipeline: mutate the parsed save payload per a validated plan.
//
// CONTRACT:
//   Pure-ish: mutates the `jsonRoot` object in place. Caller is expected to pass
//   in a clone via clonePayload() if it wants to preserve the original.
//
// WHAT IT WRITES:
//   For every destination in the plan, this sets two fields on the container:
//     1. `NKm` (chest name, the value from the preset like "Raw — Stellar Metals")
//     2. `:No` (the slots array, freshly built from plan.destinations[i].slots_after
//        merged with plan.sources[i].slots_after for containers that are both)
//
//   Non-destination containers are NOT touched. Slot fields outside the wire
//   format (InstalledTech etc.) are preserved by the plan generator's slots_after
//   arrays — apply.js trusts those.
//
// FLOAT HANDLING:
//   New slots' `eVk` (damage) field is the only float in the slot wire format.
//   We wrap it in `new Float(...)` so the serializer emits "0.0" not "0". For
//   procedural items copied from a source slot, we inherit the original Float
//   instance (and its source text) so the value survives byte-identical.

import { Float } from './payload.js';
import { K } from './keys.js';

// Resolve a save path like "PSD.3Nc" or "PSD.@Cs[3].;l5" to its container node.
// "PSD" expands to vLc.6f= (BaseContext.PlayerStateData).
export function resolveContainerNode(jsonRoot, path) {
  if (!path || typeof path !== 'string') return null;
  if (!path.startsWith('PSD')) throw new Error(`apply: cannot resolve non-PSD path "${path}"`);
  let node = jsonRoot[K.baseContext] && jsonRoot[K.baseContext][K.playerStateData];
  if (!node) throw new Error('apply: PlayerStateData missing from save');
  const rest = path.slice(3);
  let i = 0;
  while (i < rest.length) {
    if (rest[i] === '.') {
      let j = i + 1;
      while (j < rest.length && rest[j] !== '.' && rest[j] !== '[') j++;
      const key = rest.slice(i + 1, j);
      node = node[key];
      i = j;
    } else if (rest[i] === '[') {
      const close = rest.indexOf(']', i);
      const idx = Number(rest.slice(i + 1, close));
      node = node[idx];
      i = close + 1;
    } else throw new Error(`apply: unexpected char "${rest[i]}" in path "${path}"`);
    if (node == null) return null;
  }
  return node;
}

// Index every original source slot by id so destination placements can copy
// preserved fields (seed, damage, installed, type) when they're holding the
// same id. Procedural items consume their templates one-per-call so each
// procedural placement gets its own unique seed.
function indexSourceSlotsById(jsonRoot, plan) {
  const byId = new Map();
  for (const src of plan.sources || []) {
    const node = resolveContainerNode(jsonRoot, src.path);
    if (!node || !Array.isArray(node[K.slots])) continue;
    for (const s of node[K.slots]) {
      const id = s[K.slotId];
      if (!id) continue;
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(s);
    }
  }
  return byId;
}

function takeTemplate(byId, id) {
  const list = byId.get(id);
  if (!list || !list.length) return null;
  if (/[#\u0080-\uffff]/.test(id)) return list.shift();   // procedural: consume
  return list[0];                                         // stackable: peek
}

// Build a single slot object in wire format. Damage (eVk) is wrapped in Float
// so the serializer emits "0.0" not "0".
function buildSlot(spec, tmpl) {
  const slot = {
    [K.slotTypeWrap]:  { [K.slotTypeKey]: spec.type
                         || (tmpl && tmpl[K.slotTypeWrap] && tmpl[K.slotTypeWrap][K.slotTypeKey])
                         || 'Substance' },
    [K.slotId]:        spec.id,
    [K.slotAmount]:    spec.amount | 0,
    [K.slotMax]:       spec.max || (tmpl && tmpl[K.slotMax]) || 9999,
    [K.slotDamage]:    (tmpl && tmpl[K.slotDamage] instanceof Float)
                         ? tmpl[K.slotDamage]                                // preserve original Float (with source text)
                         : new Float(spec.damage != null ? spec.damage : 0),  // safe new float
    [K.slotInstalled]: (spec.installed != null) ? !!spec.installed : !!(tmpl && tmpl[K.slotInstalled]),
    [K.slotAuto]:      !!(tmpl && tmpl[K.slotAuto]),
    [K.slotIndexWrap]: { [K.slotIndexX]: spec.x | 0, [K.slotIndexY]: spec.y | 0 },
  };
  if (spec.seed)                                   slot[K.slotSeed] = spec.seed;
  else if (tmpl && tmpl[K.slotSeed] !== undefined) slot[K.slotSeed] = tmpl[K.slotSeed];
  return slot;
}

// Aggregate plan.sources + plan.destinations by container path. Each entry
// gets one merged write. Plan destinations may carry chest_index instead of a
// full path — we resolve via `structured.chests` here.
function planByPath(plan, structured) {
  const byIndex = new Map();
  for (const ch of structured.chests || []) byIndex.set(ch.index, ch.path);
  const out = new Map();
  for (const src of plan.sources || []) {
    if (!out.has(src.path)) out.set(src.path, { width: src.width, height: src.height, sourceSlotsAfter: null, destSlotsAfter: null, name: null });
    out.get(src.path).sourceSlotsAfter = src.slots_after || [];
    out.get(src.path).width  = src.width;
    out.get(src.path).height = src.height;
  }
  for (const d of plan.destinations || []) {
    const path = d.path || byIndex.get(d.chest_index);
    if (!path) throw new Error(`apply: destination has no path or chest_index resolvable: ${JSON.stringify({path: d.path, chest_index: d.chest_index})}`);
    if (!out.has(path)) out.set(path, { width: d.width, height: d.height, sourceSlotsAfter: null, destSlotsAfter: null, name: null });
    const e = out.get(path);
    e.destSlotsAfter = d.slots_after || [];
    e.width  = d.width;
    e.height = d.height;
    if (d.chest_name) e.name = d.chest_name;
  }
  return out;
}

// Lay down kept-source slots at original positions, then repack destination
// placements into next-free positions so a kept-source at (3,2) is never
// overwritten by a destination placement that the plan tentatively wrote
// to the same coordinate.
function mergeFinalSlotPlacements(entry) {
  const w = entry.width || 10, h = entry.height || 5;
  const finals = [];
  const occupied = new Set();
  const key = (x, y) => `${x},${y}`;

  for (const s of (entry.sourceSlotsAfter || [])) {
    const k = key(s.x, s.y);
    if (occupied.has(k)) continue;
    occupied.add(k);
    finals.push({ ...s });
  }

  for (const d of (entry.destSlotsAfter || [])) {
    let px = d.x, py = d.y;
    if (occupied.has(key(px, py))) {
      let placed = false;
      outer: for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!occupied.has(key(x, y))) { px = x; py = y; placed = true; break outer; }
        }
      }
      if (!placed) throw new Error(`apply: container full while placing ${d.id}`);
    }
    occupied.add(key(px, py));
    finals.push({
      id: d.id, amount: d.amount, x: px, y: py,
      type: d.type, max: d.maxAmount || d.max,
      damage:    d.meta && d.meta.damage,
      installed: d.meta && d.meta.installed,
      seed:      d.meta && d.meta.seed,
    });
  }
  return finals;
}

// ── Public entry point ────────────────────────────────────────────────────────

export function applyPlanToJson(jsonRoot, plan, structured) {
  if (!jsonRoot || typeof jsonRoot !== 'object') throw new Error('apply: invalid jsonRoot');
  if (!plan || !plan.sources || !plan.destinations) throw new Error('apply: invalid plan');
  if (!structured)                                  throw new Error('apply: structured save required');
  if (plan.validation && !plan.validation.ok)       throw new Error('apply: refuse — plan failed validation');

  const sourceTemplates = indexSourceSlotsById(jsonRoot, plan);
  const byPath = planByPath(plan, structured);

  const touched = [];
  let stacksBefore = 0, stacksAfter = 0;

  for (const [path, entry] of byPath) {
    const node = resolveContainerNode(jsonRoot, path);
    if (!node || !Array.isArray(node[K.slots])) {
      throw new Error(`apply: container at "${path}" has no slots array — refuse`);
    }
    stacksBefore += node[K.slots].length;

    const finals = mergeFinalSlotPlacements(entry);
    const newSlots = finals.map(f => buildSlot(f, takeTemplate(sourceTemplates, f.id)));

    node[K.slots] = newSlots;
    if (entry.name != null && entry.name !== node[K.name]) {
      node[K.name] = entry.name;
    }
    stacksAfter += newSlots.length;
    touched.push(path);
  }

  return {
    jsonRoot,
    summary: {
      containers_touched: touched.length,
      stacks_before:      stacksBefore,
      stacks_after:       stacksAfter,
      net_stack_delta:    stacksAfter - stacksBefore,
    },
    touchedPaths: touched,
  };
}
