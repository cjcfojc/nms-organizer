// Plan validator — proves a generated plan is internally consistent and would not
// destroy or invent any items if applied. Runs against the plan object only (no JSON
// mutation). The apply pipeline runs additional POST-write integrity checks separately.
//
// Returns { ok: boolean, checks: [{ id, label, ok, detail, evidence? }], errors: [], warnings: [] }
// Each check is independent — a failure in one doesn't short-circuit the others.
//
// CRITICAL: this is a safety gate. Treat any failure as "do not apply".

export function validatePlan(plan) {
  const checks = [];

  checks.push(checkTotalAmountInvariant(plan));
  checks.push(checkPerIdInvariant(plan));
  checks.push(checkDestinationPositionBounds(plan));
  checks.push(checkNoDuplicatePositions(plan));
  checks.push(checkStackSizesRespected(plan));
  checks.push(checkNoUncategorizedMoved(plan));
  checks.push(checkOverflowResolutions(plan));

  const errors   = checks.filter(c => !c.ok);
  const warnings = checks.filter(c => c.ok && c.warning);

  return {
    ok: errors.length === 0,
    checks,
    errors,
    warnings,
    summary: {
      pass: checks.filter(c => c.ok).length,
      fail: errors.length,
      warn: warnings.length,
      total: checks.length,
    },
  };
}

// ── individual checks ─────────────────────────────────────────────────────────────

// 1. Total amount invariant: amount_in === amount_out + amount_overflowed.
//    Already computed by plan.js but we re-verify here as the safety gate.
function checkTotalAmountInvariant(plan) {
  const s = plan.summary;
  const lhs = s.total_amount_in;
  const rhs = s.total_amount_out + s.total_amount_overflowed;
  const diff = lhs - rhs;
  return {
    id: 'invariant_total_amount',
    label: 'Item totals balance (in = out + overflow)',
    ok: diff === 0,
    detail: diff === 0
      ? `${lhs.toLocaleString()} units accounted for`
      : `OFF BY ${diff.toLocaleString()}: in=${lhs.toLocaleString()}, out=${s.total_amount_out.toLocaleString()}, overflow=${s.total_amount_overflowed.toLocaleString()}`,
  };
}

// 2. Per-id amount invariant: each item id moved or overflowed equals what was pulled.
//    Tighter than the total check — catches cases where one item compensates another's loss.
function checkPerIdInvariant(plan) {
  const pulled = new Map();   // id → amount pulled from sources
  for (const src of plan.sources || []) {
    const beforeMap = new Map();
    for (const sb of src.slots_before || []) addAmount(beforeMap, sb.id, sb.amount);
    const afterMap = new Map();
    for (const sa of src.slots_after  || []) addAmount(afterMap,  sa.id, sa.amount);
    for (const [id, before] of beforeMap.entries()) {
      const kept = afterMap.get(id) || 0;
      const moved = before - kept;
      if (moved > 0) addAmount(pulled, id, moved);
    }
  }
  const placed = new Map();   // id → amount placed in destinations
  for (const d of plan.destinations || []) {
    for (const sa of d.slots_after || []) addAmount(placed, sa.id, sa.amount);
  }
  const overflowed = new Map();
  for (const o of plan.overflow || []) addAmount(overflowed, o.id, o.amount || 0);

  const allIds = new Set([...pulled.keys(), ...placed.keys(), ...overflowed.keys()]);
  const offenders = [];
  for (const id of allIds) {
    const inAmt  = pulled.get(id) || 0;
    const outAmt = (placed.get(id) || 0) + (overflowed.get(id) || 0);
    if (inAmt !== outAmt) offenders.push({ id, in: inAmt, out: outAmt, diff: inAmt - outAmt });
  }
  return {
    id: 'invariant_per_id',
    label: 'Per-item invariant (every id balances)',
    ok: offenders.length === 0,
    detail: offenders.length === 0
      ? `${allIds.size} distinct ids checked, all balanced`
      : `${offenders.length} id(s) imbalanced — first 3: ${offenders.slice(0,3).map(o => `${o.id} (${o.in}→${o.out})`).join(', ')}`,
    evidence: offenders.length ? { offenders: offenders.slice(0, 20) } : null,
  };
}

// 3. Every destination slot's (x,y) is within the container's grid.
function checkDestinationPositionBounds(plan) {
  const offenders = [];
  for (const d of plan.destinations || []) {
    for (const sa of d.slots_after || []) {
      if (!Number.isInteger(sa.x) || !Number.isInteger(sa.y)) {
        offenders.push({ chest: d.chest_index, id: sa.id, x: sa.x, y: sa.y, why: 'non-integer position' });
        continue;
      }
      if (sa.x < 0 || sa.x >= d.width || sa.y < 0 || sa.y >= d.height) {
        offenders.push({ chest: d.chest_index, id: sa.id, x: sa.x, y: sa.y, why: `outside ${d.width}x${d.height}` });
      }
    }
  }
  return {
    id: 'position_bounds',
    label: 'Slot positions within container grid',
    ok: offenders.length === 0,
    detail: offenders.length === 0
      ? `all destination slots are within bounds`
      : `${offenders.length} out-of-bounds slot(s)`,
    evidence: offenders.length ? { offenders: offenders.slice(0, 20) } : null,
  };
}

// 4. No two destination slots share the same (x,y) in the same container.
function checkNoDuplicatePositions(plan) {
  const offenders = [];
  for (const d of plan.destinations || []) {
    const seen = new Map();
    for (const sa of d.slots_after || []) {
      const k = `${sa.x},${sa.y}`;
      if (seen.has(k)) offenders.push({ chest: d.chest_index, position: k, ids: [seen.get(k), sa.id] });
      else seen.set(k, sa.id);
    }
  }
  return {
    id: 'unique_positions',
    label: 'No duplicate slot positions per container',
    ok: offenders.length === 0,
    detail: offenders.length === 0
      ? 'all positions unique within each container'
      : `${offenders.length} duplicate position(s)`,
    evidence: offenders.length ? { offenders: offenders.slice(0, 20) } : null,
  };
}

// 5. Each placed slot's amount does not exceed its known per-stack maximum.
//    perStackMax was carried through from the source slot during plan generation.
function checkStackSizesRespected(plan) {
  const offenders = [];
  for (const d of plan.destinations || []) {
    for (const sa of d.slots_after || []) {
      const max = sa.maxAmount || 9999;
      if (sa.amount > max) offenders.push({ chest: d.chest_index, id: sa.id, amount: sa.amount, max });
    }
  }
  return {
    id: 'stack_sizes',
    label: 'Stack sizes respect per-item maximums',
    ok: offenders.length === 0,
    detail: offenders.length === 0
      ? 'no over-sized stacks'
      : `${offenders.length} slot(s) exceed max stack size`,
    evidence: offenders.length ? { offenders: offenders.slice(0, 20) } : null,
  };
}

// 6. Items classified Uncategorized/InstalledTech were skipped, never placed.
//    The plan generator already enforces this; this check verifies the contract.
function checkNoUncategorizedMoved(plan) {
  const skippedIds = new Set((plan.skipped || []).map(s => s.id));
  const movedSkipped = [];
  for (const d of plan.destinations || []) {
    for (const sa of d.slots_after || []) {
      if (skippedIds.has(sa.id)) movedSkipped.push({ chest: d.chest_index, id: sa.id });
    }
  }
  return {
    id: 'skipped_not_moved',
    label: 'Skipped items were never placed',
    ok: movedSkipped.length === 0,
    detail: movedSkipped.length === 0
      ? `${(plan.skipped || []).length} skipped item(s) all stayed in source`
      : `${movedSkipped.length} skipped item(s) appear in destinations — generator bug`,
    evidence: movedSkipped.length ? { movedSkipped: movedSkipped.slice(0, 20) } : null,
  };
}

// 7. Every overflow entry has a resolution. (warning only — generator should always set one)
function checkOverflowResolutions(plan) {
  const missing = (plan.overflow || []).filter(o => !o.resolution);
  return {
    id: 'overflow_resolutions',
    label: 'Every overflow entry has a documented resolution',
    ok: missing.length === 0,
    warning: missing.length > 0,
    detail: missing.length === 0
      ? `${(plan.overflow || []).length} overflow entries — all have resolutions`
      : `${missing.length} overflow entry(ies) missing resolution`,
  };
}

function addAmount(map, id, amount) {
  if (!id) return;
  map.set(id, (map.get(id) || 0) + amount);
}
