// Plan generator. Pure function: takes a structured save + a layout config and returns
// a plan object describing the proposed changes WITHOUT mutating the save in any way.
//
// Consumers:
//   - Preview tab (lib/preview.js)  — renders before/after diffs
//   - Validator   (lib/validate.js) — proves no items are lost
//   - Apply       (lib/apply.js)    — translates moves into save mutations
//
// Hard guarantees:
//   - Total amount of every item id is preserved (input == output + left_in_source + overflow)
//   - Items classified as Uncategorized or InstalledTech are NEVER moved (skipped with reason)
//   - Procedural items (seeded / garbled name) are not consolidated — each source slot becomes
//     exactly one destination slot to preserve seed identity
//   - Operational reserves are kept in their original locations up to the configured stack count

import { classify } from './classify.js';

export function generatePlan(structured, config) {
  if (!structured) throw new Error('generatePlan: missing structured save');
  if (!config)     throw new Error('generatePlan: missing config');

  const plan = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    preset_id: config.id || null,
    preset_label: config.label || null,
    sources: [],
    destinations: [],
    overflow: [],
    skipped: [],
    summary: {
      sources_walked: 0,
      slots_pulled: 0,
      slots_kept_as_reserve: 0,
      destinations_used: 0,
      stacks_placed: 0,
      overflow_entries: 0,
      skipped_entries: 0,
      total_amount_in: 0,
      total_amount_out: 0,
      total_amount_overflowed: 0,
      total_amount_left_in_source: 0,
      invariant_ok: false,
      warnings: [],
    },
  };

  // ── Step 1: assemble the list of source containers we're allowed to pull from ─────
  const sourceContainers = collectSourceContainers(structured, config);
  plan.summary.sources_walked = sourceContainers.length;

  // ── Step 2: classify every slot, partition into pulled vs kept-as-reserve ─────────
  const pulledItems = [];   // [{ id, type, amount, perStackMax, srcPath, srcKind, srcLabel, slotMeta, classification }]
  for (const sc of sourceContainers) {
    const cap = sc.container.capacity || (sc.container.width && sc.container.height ? sc.container.width * sc.container.height : sc.container.slots.length);
    const sourceReport = {
      path: sc.path, kind: sc.kind, label: sc.label,
      capacity: cap,
      width: sc.container.width || 10,
      height: sc.container.height || 5,
      slots_total: cap,
      slots_used_before: sc.container.slots.length,
      slots_kept: 0, slots_pulled: 0,
      kept_items: [],
      // Full positional snapshots for the Preview diff renderer
      slots_before: sc.container.slots.map(s => ({ id: s.id, amount: s.amount, x: s.x, y: s.y })),
      slots_after: [],   // filled below — same as slots_before minus pulled positions
    };

    const reserves = pickReservesForLocation(config, sc.kind);
    const reserveLeftToKeep = new Map();      // id → stacks remaining to keep
    for (const r of reserves) reserveLeftToKeep.set(r.id, r.stacks || 1);

    for (const slot of sc.container.slots) {
      const rawId = slot.id;
      if (!rawId) continue;
      const cls = classify(rawId, slot.type);

      // Never move installed tech or uncategorized items (per rules)
      if (cls.classification === 'InstalledTech') {
        sourceReport.slots_kept++;
        sourceReport.kept_items.push({ id: rawId, amount: slot.amount, reason: 'InstalledTech' });
        sourceReport.slots_after.push({ id: slot.id, amount: slot.amount, x: slot.x, y: slot.y });
        continue;
      }
      if (cls.classification === 'Uncategorized') {
        sourceReport.slots_kept++;
        sourceReport.kept_items.push({ id: rawId, amount: slot.amount, reason: 'Uncategorized' });
        sourceReport.slots_after.push({ id: slot.id, amount: slot.amount, x: slot.x, y: slot.y });
        plan.skipped.push({ id: rawId, amount: slot.amount, source_path: sc.path, reason: cls.reason || 'Uncategorized' });
        continue;
      }

      // Operational reserve check — preserve up to N stacks of this id at this location
      const idBare = rawId.startsWith('^') ? rawId.slice(1) : rawId;
      const remainingReserve = reserveLeftToKeep.get(idBare) || 0;
      if (remainingReserve > 0) {
        reserveLeftToKeep.set(idBare, remainingReserve - 1);
        sourceReport.slots_kept++;
        sourceReport.kept_items.push({ id: rawId, amount: slot.amount, reason: 'reserve' });
        sourceReport.slots_after.push({ id: slot.id, amount: slot.amount, x: slot.x, y: slot.y });
        continue;
      }

      // This slot gets pulled (does NOT go into slots_after)
      pulledItems.push({
        id: rawId,
        type: slot.type,
        amount: slot.amount,
        perStackMax: slot.max || 9999,
        srcPath: sc.path, srcKind: sc.kind, srcLabel: sc.label,
        slotMeta: { x: slot.x, y: slot.y, damage: slot.damage, installed: slot.installed, seed: slot.seed },
        classification: cls,
      });
      sourceReport.slots_pulled++;
      plan.summary.total_amount_in += slot.amount;
    }

    plan.summary.slots_pulled += sourceReport.slots_pulled;
    plan.summary.slots_kept_as_reserve += sourceReport.slots_kept;
    plan.sources.push(sourceReport);
  }

  // ── Step 3: bucket items, optionally consolidating same-id stacks (non-procedural only) ──
  // Each entry in bucketPools[bucket] becomes a "placement candidate".
  // Procedural items keep their original slot shape (one entry per source slot, can't merge).
  const bucketPools = new Map();   // bucket → [{ id, amount, perStackMax, isProcedural, isContraband, sources: [{srcPath, slotMeta}] }]
  const consolidate = config.consolidate_stacks !== false;

  for (const item of pulledItems) {
    const bucket = item.classification.classification;
    if (!bucketPools.has(bucket)) bucketPools.set(bucket, []);
    const pool = bucketPools.get(bucket);
    const isProcedural = !!item.classification.procedural;

    if (consolidate && !isProcedural) {
      // Find an existing pool entry for this id and merge
      const existing = pool.find(e => e.id === item.id && !e.isProcedural);
      if (existing) {
        existing.amount += item.amount;
        existing.sources.push({ srcPath: item.srcPath, srcKind: item.srcKind, srcLabel: item.srcLabel, amount: item.amount });
        continue;
      }
    }
    pool.push({
      id: item.id,
      type: item.type,
      amount: item.amount,
      perStackMax: item.perStackMax,
      isProcedural,
      slotMeta: item.slotMeta,
      sources: [{ srcPath: item.srcPath, srcKind: item.srcKind, srcLabel: item.srcLabel, amount: item.amount }],
    });
  }

  // ── Step 4: pack each bucket's items into the target chests ─────────────────────────
  // For each bucket, find target chests (in preset.chests order) whose `buckets` array contains that bucket.
  // Pack: for each item, generate stacks (ceil(amount/perStackMax)), respect cap, place into chests.

  // Build a writable destination ledger: chestIndex → { meta + slotsRemaining list }
  const destinations = new Map();
  for (const c of (config.chests || [])) {
    const live = (structured.chests || []).find(x => x.index === c.index);
    if (!live || !live.present) continue;   // skip not-built containers
    const cap = live.capacity || (live.width && live.height ? live.width * live.height : 50);
    destinations.set(c.index, {
      chest_index: c.index,
      chest_name: c.name,
      buckets: Array.isArray(c.buckets) ? c.buckets.slice() : [],
      capacity: cap,
      width: live.width || 10,
      height: live.height || 5,
      slots_before: live.slots.map(s => ({ id: s.id, amount: s.amount, x: s.x, y: s.y })),
      slots_after: [],   // filled by packing
      stacks_added: 0,
      total_amount_added: 0,
    });
  }

  const overflowChestIdx = config.overflow_strategy === 'spill_to_overflow_chest' ? config.overflow_chest_index : null;
  const overflowChest = overflowChestIdx ? destinations.get(overflowChestIdx) : null;

  for (const [bucket, pool] of bucketPools.entries()) {
    const targetChests = [...destinations.values()].filter(d => d.buckets.includes(bucket));
    if (targetChests.length === 0) {
      // Nothing in the layout accepts this bucket; route everything to overflow handler
      for (const entry of pool) {
        routeOverflow(plan, entry, `bucket "${bucket}" has no destination storage container in this layout`, overflowChest, config);
      }
      continue;
    }

    const cap = (config.bucket_stack_caps && bucket in config.bucket_stack_caps && config.bucket_stack_caps[bucket] !== null)
      ? Number(config.bucket_stack_caps[bucket]) : Infinity;

    // Sort pool: highest amount first → fills bigger items into chests first (better visual + packing)
    pool.sort((a, b) => b.amount - a.amount);

    for (const entry of pool) {
      const stacks = makeStacksForEntry(entry);   // [{ amount, slotMeta }] — at most cap stacks (rest is overflow)
      let stacksToPlace = stacks;
      if (stacks.length > cap) {
        stacksToPlace = stacks.slice(0, cap);
        const overflowStacks = stacks.slice(cap);
        const overflowAmount = overflowStacks.reduce((a, s) => a + s.amount, 0);
        routeOverflow(plan, { ...entry, amount: overflowAmount }, `stack cap (${cap}) reached for ${entry.id}`, overflowChest, config);
      }

      // Place stacks into target chests in order
      for (const stk of stacksToPlace) {
        const placedIn = placeStackIntoChests(stk, entry, targetChests);
        if (!placedIn) {
          // No room anywhere in this bucket's chests — overflow
          routeOverflow(plan, { ...entry, amount: stk.amount }, `bucket "${bucket}" — all storage containers assigned to this bucket are full`, overflowChest, config);
        }
      }
    }
  }

  // ── Step 5: tally summary stats + invariant check ──────────────────────────────────
  for (const d of destinations.values()) {
    d.stacks_added = d.slots_after.length;
    d.total_amount_added = d.slots_after.reduce((a, s) => a + s.amount, 0);
    plan.summary.stacks_placed += d.stacks_added;
    plan.summary.total_amount_out += d.total_amount_added;
    if (d.stacks_added > 0) plan.summary.destinations_used++;
    plan.destinations.push(d);
  }
  plan.summary.overflow_entries = plan.overflow.length;
  plan.summary.skipped_entries = plan.skipped.length;
  plan.summary.total_amount_overflowed = plan.overflow.reduce((a, o) => a + (o.amount || 0), 0);
  plan.summary.total_amount_left_in_source = plan.summary.total_amount_in
                                             - plan.summary.total_amount_out
                                             - plan.summary.total_amount_overflowed;

  // Invariant: nothing destroyed. amount_in === amount_out + amount_overflowed (left_in_source must be 0
  // because we explicitly chose not to pull those items — they never entered the "in" total).
  // Total bookkeeping: the only items in `total_amount_in` were ones we pulled. The only outputs are
  // amount_out (placed in dest) + amount_overflowed (still in source per overflow strategy).
  const lossCount = plan.summary.total_amount_in - plan.summary.total_amount_out - plan.summary.total_amount_overflowed;
  plan.summary.invariant_ok = (lossCount === 0);
  if (!plan.summary.invariant_ok) {
    plan.summary.warnings.push(`INVARIANT FAIL: ${lossCount} units of items unaccounted for (in=${plan.summary.total_amount_in}, out=${plan.summary.total_amount_out}, overflow=${plan.summary.total_amount_overflowed})`);
  }
  if (plan.skipped.length > 0) {
    plan.summary.warnings.push(`${plan.skipped.length} item(s) skipped — uncategorized or untouchable. They stay in source as-is.`);
  }
  if (plan.overflow.length > 0 && config.overflow_strategy === 'fail') {
    plan.summary.warnings.push(`Overflow strategy is "fail" and ${plan.overflow.length} item(s) overflowed — plan will not be applyable.`);
  }

  return plan;
}

// ── helpers ───────────────────────────────────────────────────────────────────────────

// Walk the structured save, return a flat list of containers we should pull from per the config.
// Each entry: { path, kind, label, container }
function collectSourceContainers(structured, config) {
  const out = [];
  const src = config.sources || {};
  const excluded = new Set(((config.exclude_ships_by_seed) || []).map(s => s.toLowerCase()));

  // Storage containers (the destinations are also valid sources — items can be moved between them)
  if (src.chests === 'all') {
    for (const ch of structured.chests || []) {
      if (!ch.present) continue;
      out.push({ path: ch.path, kind: 'STORAGE', label: ch.name || `Storage Container ${ch.index}`, container: ch });
    }
  }

  // Freighter
  if (src.freighter_inventory && structured.freighter && structured.freighter.inventory) {
    out.push({ path: structured.freighter.inventory.path, kind: 'FREIGHTER', label: 'Freighter Inventory', container: structured.freighter.inventory });
  }
  if (src.freighter_cargo && structured.freighter && structured.freighter.cargo) {
    out.push({ path: structured.freighter.cargo.path, kind: 'FREIGHTER', label: 'Freighter Cargo', container: structured.freighter.cargo });
  }

  // Ships (Inventory + Cargo, never Tech)
  if (src.ships === 'all') {
    for (const ship of structured.ships || []) {
      const hasName = ship.name && ship.name.trim();
      const hasSeed = ship.seed && ship.seed !== '0x0';
      if (!hasName && !hasSeed) continue;
      if (excluded.has((ship.seed || '').toLowerCase())) continue;
      const baseName = hasName ? ship.name : `Ship slot ${ship.index} (unclaimed)`;
      const label = ship.shipType ? `${baseName} · ${ship.shipType}` : baseName;
      if (ship.inventory) out.push({ path: ship.inventory.path, kind: 'SHIP', label: `${label} — Inventory`, container: ship.inventory });
      if (ship.cargo)     out.push({ path: ship.cargo.path,     kind: 'SHIP', label: `${label} — Cargo`,     container: ship.cargo });
    }
  }

  // Exocrafts (Inventory only)
  if (src.vehicles === 'all') {
    for (const v of structured.vehicles || []) {
      if (!v.inventory) continue;
      const label = v.name && v.name.trim() ? v.name : `Exocraft ${v.index + 1}`;
      out.push({ path: v.inventory.path, kind: 'VEHICLE', label, container: v.inventory });
    }
  }

  // Exosuit (off by default per rules)
  if (src.exosuit_general && structured.exosuit && structured.exosuit.inventory) {
    out.push({ path: structured.exosuit.inventory.path, kind: 'EXOSUIT', label: 'Exosuit General', container: structured.exosuit.inventory });
  }
  if (src.exosuit_cargo && structured.exosuit && structured.exosuit.cargo) {
    out.push({ path: structured.exosuit.cargo.path, kind: 'EXOSUIT', label: 'Exosuit Cargo', container: structured.exosuit.cargo });
  }
  return out;
}

// Pick the operational reserves list for the source kind.
// Reserves come from config.operational_reserves and are keyed by location-type (lowercase).
function pickReservesForLocation(config, kind) {
  const map = {
    SHIP: 'ship', FREIGHTER: 'freighter', VEHICLE: 'vehicle', EXOSUIT: 'exosuit',
    STORAGE: null,    // storage containers don't have a notion of operational reserves
  };
  const key = map[kind];
  if (!key) return [];
  const list = (config.operational_reserves && config.operational_reserves[key]) || [];
  return list.filter(r => r && typeof r.id === 'string' && r.id);
}

// Convert a bucket-pool entry into a list of stacks ready for placement.
// Procedural entries: one stack per original source slot (preserves seed identity).
// Non-procedural: ceil(amount/perStackMax) stacks of perStackMax (last stack is the remainder).
function makeStacksForEntry(entry) {
  if (entry.isProcedural) {
    return entry.sources.map(s => ({ amount: s.amount, slotMeta: { ...entry.slotMeta }, srcPath: s.srcPath }));
  }
  const stacks = [];
  let remaining = entry.amount;
  while (remaining > 0) {
    const take = Math.min(remaining, entry.perStackMax);
    stacks.push({ amount: take, slotMeta: null, srcPath: null });
    remaining -= take;
  }
  return stacks;
}

// Place a stack into the first chest with available capacity. Returns the chest, or null if none.
function placeStackIntoChests(stack, entry, chests) {
  for (const chest of chests) {
    if (chest.slots_after.length >= chest.capacity) continue;
    const idx = chest.slots_after.length;
    const x = idx % chest.width;
    const y = Math.floor(idx / chest.width);
    chest.slots_after.push({
      id: entry.id,
      amount: stack.amount,
      x, y,
      maxAmount: entry.perStackMax,
      type: entry.type,
      meta: stack.slotMeta || null,
      sourceTrace: stack.srcPath || null,
    });
    return chest;
  }
  return null;
}

// Route a "couldn't place" entry to the configured overflow handler.
// 'leave_in_source' — record but don't actually move; subtract from totals so invariant holds
// 'spill_to_overflow_chest' — place in overflow chest if there's room, else fall through to leave_in_source
// 'fail' — just record the overflow and let summary.warnings flag it
function routeOverflow(plan, entry, reason, overflowChest, config) {
  const strategy = config.overflow_strategy || 'leave_in_source';
  const overflowEntry = {
    id: entry.id,
    amount: entry.amount,
    reason,
    strategy,
    resolution: null,
  };

  if (strategy === 'spill_to_overflow_chest' && overflowChest && overflowChest.slots_after.length < overflowChest.capacity) {
    const idx = overflowChest.slots_after.length;
    overflowChest.slots_after.push({
      id: entry.id,
      amount: entry.amount,
      x: idx % overflowChest.width,
      y: Math.floor(idx / overflowChest.width),
      maxAmount: entry.perStackMax,
      type: entry.type,
      sourceTrace: 'overflow',
    });
    overflowEntry.resolution = `spilled to storage container ${overflowChest.chest_index}`;
    plan.overflow.push(overflowEntry);
    return;
  }

  // leave_in_source / fail / spill-but-no-room — item stays where it was. We previously counted it in
  // `total_amount_in`. To preserve the invariant, we'd subtract from in… but a cleaner accounting is
  // to leave `in` as-is and reflect it as overflowed (still-in-source). The user sees both amount and
  // resolution explicitly.
  overflowEntry.resolution = (strategy === 'fail') ? 'plan will fail to apply' : 'left in source';
  plan.overflow.push(overflowEntry);
}
