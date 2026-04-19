// High-level save loader for the browser.
// Decodes save.hg → JSON → walks every inventory container → returns a
// structured representation with chest/freighter/ship/exosuit grouping
// and full slot data per container.

import { decodeSaveBytes, sha256Hex } from './codec.js';
import { parsePayload } from './payload.js';
import { K } from './keys.js';

// Mapping is loaded once and cached. The full obfuscated→clear key dictionary
// is fetched from /data/mapping.json (MBINCompiler-derived, ~3500 entries).
// loadSave() awaits this so that any consumer can rely on the mapping being
// resident before they walk the JSON.
let mappingPromise = null;
let mappingByObf = null;

async function loadMapping() {
  if (mappingByObf) return mappingByObf;
  const r = await fetch('data/mapping.json');
  if (!r.ok) throw new Error(`mapping.json fetch failed: ${r.status}`);
  const data = await r.json();
  mappingByObf = {};
  for (const m of data.Mapping) mappingByObf[m.Key] = m.Value;
  return mappingByObf;
}
function getMappingPromise() {
  if (!mappingPromise) mappingPromise = loadMapping();
  return mappingPromise;
}

function isInventoryContainer(o) {
  return o && typeof o === 'object'
    && Array.isArray(o[K.slots])
    && o[K.ssgWrap] && typeof o[K.ssgWrap][K.ssgKey] === 'string';
}

// Map a ship's MODELS/COMMON/SPACECRAFT/<TYPE>/... path to a friendly type name.
// Sourced from observed model paths in real saves; null when unrecognized.
function deriveShipType(modelPath) {
  if (!modelPath) return null;
  const p = modelPath.toUpperCase();
  if (p.includes('SENTINELSHIP'))   return 'Sentinel Interceptor';
  if (p.includes('BIOSHIP') || p.includes('BIOPARTS')) return 'Living Ship';
  if (p.includes('SAILSHIP'))       return 'Solar Ship';
  if (p.includes('SPOOKSHIP'))      return 'Pirate Ship';
  if (p.includes('CORVETTE'))       return 'Corvette';
  if (p.includes('DROPSHIP'))       return 'Hauler';
  if (p.includes('SHUTTLE'))        return 'Shuttle';
  if (p.includes('SCIENTIFIC'))     return 'Explorer';
  if (p.includes('ROYAL'))          return 'Exotic';
  if (p.includes('FIGHTERS'))       return 'Fighter';
  if (p.includes('INDUSTRIAL'))     return 'Industrial';
  return null;
}

function classifySlot(slot) {
  return {
    id: slot[K.slotId] || null,
    amount: slot[K.slotAmount] || 0,
    max:    slot[K.slotMax] || 0,
    type:   (slot[K.slotTypeWrap] && slot[K.slotTypeWrap][K.slotTypeKey]) || null,
    x:      (slot[K.slotIndexWrap] && slot[K.slotIndexWrap][K.slotIndexX]) || 0,
    y:      (slot[K.slotIndexWrap] && slot[K.slotIndexWrap][K.slotIndexY]) || 0,
    damage: slot[K.slotDamage] || 0,
    installed: slot[K.slotInstalled] === true,
    seed:   slot[K.slotSeed] || null,
  };
}

function snapshotContainer(node, path) {
  const slots = node[K.slots].filter(s => s && s[K.slotId]).map(classifySlot);
  return {
    path,
    name:   node[K.name] || null,
    cls:    (node[K.classWrap] && node[K.classWrap][K.classKey]) || null,
    ssg:    node[K.ssgWrap][K.ssgKey],
    width:  node[K.width] || null,
    height: node[K.height] || null,
    capacity: Array.isArray(node[K.validSlots]) ? node[K.validSlots].length : null,
    slots,
  };
}

// Walk every inventory container in a parsed save, return a flat list with paths.
export function walkContainers(save) {
  const out = [];
  function walk(o, path) {
    if (!o || typeof o !== 'object') return;
    if (isInventoryContainer(o)) {
      out.push(snapshotContainer(o, path));
      return;
    }
    if (Array.isArray(o)) {
      for (let i = 0; i < o.length; i++) walk(o[i], `${path}[${i}]`);
      return;
    }
    for (const k of Object.keys(o)) walk(o[k], `${path}.${k}`);
  }
  walk(save, '');
  return out;
}

// Higher-level structure: chest map (1..10 by index match) + ships + freighter + exosuit
export function structureSave(save) {
  const containers = walkContainers(save);
  const psd = save[K.baseContext] && save[K.baseContext][K.playerStateData];

  // Chest containers — exactly 10 named Chest1Inventory..Chest10Inventory live directly under PSD.
  // The obfuscated keys for these (per mapping.json):
  //   Chest1Inventory=3Nc, Chest2=IDc, Chest3=M=:, Chest4=iYp, Chest5=<IP,
  //   Chest6=qYJ, Chest7=@e5, Chest8=5uh, Chest9=5Tg, Chest10=Bq<
  const chestKeys = ['3Nc','IDc','M=:','iYp','<IP','qYJ','@e5','5uh','5Tg','Bq<'];
  const chests = chestKeys.map((key, i) => {
    const node = psd && psd[key];
    if (!node || !isInventoryContainer(node)) return { index: i+1, key, present: false };
    const snap = snapshotContainer(node, `PSD.${key}`);
    return { index: i+1, key, present: true, ...snap };
  });

  // Snapshot a child inventory of a parent object if present.
  const childInv = (parent, key, path) =>
    isInventoryContainer(parent?.[key]) ? snapshotContainer(parent[key], path) : null;

  // Ships — under PSD.@Cs (ShipOwnership). Each entry has its own NKm + NTx.@EL[1] (seed)
  // and three child inventories. Ship type is derived from NTx.93M (model path).
  const ships = (psd?.[K.ships] || []).map((shipObj, i) => {
    const ntx = shipObj?.[K.shipResource];
    const seedField = ntx?.[K.slotSeed];
    const modelPath = ntx?.[K.shipModelPath] || '';
    return {
      index: i,
      name:  shipObj[K.name] || null,
      seed:  Array.isArray(seedField) ? seedField[1] : null,
      modelPath,
      shipType:  deriveShipType(modelPath),
      inventory: childInv(shipObj, K.shipInventory, `PSD.@Cs[${i}].${K.shipInventory}`),
      cargo:     childInv(shipObj, K.shipCargo,     `PSD.@Cs[${i}].${K.shipCargo}`),
      tech:      childInv(shipObj, K.shipTech,      `PSD.@Cs[${i}].${K.shipTech}`),
    };
  });

  const freighter = {
    inventory: childInv(psd, K.freighterInv,   `PSD.${K.freighterInv}`),
    cargo:     childInv(psd, K.freighterCargo, `PSD.${K.freighterCargo}`),
    tech:      childInv(psd, K.freighterTech,  `PSD.${K.freighterTech}`),
  };

  // Exosuit — uses the same generic Inventory keys (`;l5`, `gan`, `PMT`)
  // attached directly to PSD instead of nested under a record.
  const exosuit = {
    inventory: childInv(psd, K.shipInventory, `PSD.${K.shipInventory}`),
    cargo:     childInv(psd, K.shipCargo,     `PSD.${K.shipCargo}`),
    tech:      childInv(psd, K.shipTech,      `PSD.${K.shipTech}`),
  };

  // Multi-tool weapon mods — surfaced for inspection only, never moved.
  const weapon = childInv(psd, K.weaponInv, `PSD.${K.weaponInv}`);

  // Exocrafts — same shape as ships minus the cargo inventory.
  const vehicles = (psd?.[K.vehicles] || []).map((vObj, i) => ({
    index: i,
    name:  vObj[K.name] || null,
    inventory: childInv(vObj, K.shipInventory, `PSD.${K.vehicles}[${i}].${K.shipInventory}`),
    tech:      childInv(vObj, K.shipTech,      `PSD.${K.vehicles}[${i}].${K.shipTech}`),
  }));

  return { chests, ships, vehicles, freighter, exosuit, weapon, allContainers: containers };
}

// Top-level entry point: take a Uint8Array save file, return parsed JSON + structured view.
// Uses parsePayload (custom JSON I/O) so every numeric token that was a float in the
// source — eVk:0.0, qLk:[0.0,...], etc. — comes back as a Float wrapper instance and
// round-trips byte-identically through serializePayload. That's what makes direct JS
// object mutation safe; without it, JSON.stringify would strip every ".0" and corrupt
// the save (libNOM would error "save is empty after deserializing").
export async function loadSave(bytes) {
  await getMappingPromise();
  const sha = await sha256Hex(bytes);
  const payload = decodeSaveBytes(bytes);
  let text = new TextDecoder('utf-8').decode(payload);
  text = text.replace(/\u0000+$/g, '').replace(/\s+$/g, '');
  const json = parsePayload(text);
  const structured = structureSave(json);
  return {
    bytes_size: bytes.length,
    payload_size: payload.length,
    sha256: sha,
    json,
    structured,
  };
}
