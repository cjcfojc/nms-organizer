// Hand-curated subset of the obfuscated→clear key map used on hot paths.
//
// We don't deobfuscate the full 7 MB JSON tree at load time (slow, and the
// runtime mapping table from data/mapping.json has ~3,500 entries). Instead,
// every place we walk the save reads keys directly from this constant.
//
// Single source of truth — save.js (structure walk), apply.js (mutation) and
// any future module all import from here. Verified against mapping.json; see
// project memory for the full field map.
//
// Naming note: the "ship*" inventory keys (`;l5`/`gan`/`PMT`) are NOT
// ship-specific. The save schema reuses these generic Inventory /
// Inventory_Cargo / Inventory_TechOnly keys across ships, vehicles, and the
// exosuit. Named with the ship prefix here only because that's the most
// common context — same keys, three usages.

export const K = {
  // Top-level
  baseContext:     'vLc',         // BaseContext
  playerStateData: '6f=',         // PlayerStateData

  // Inventory container
  slots:           ':No',         // Slots
  validSlots:      'hl?',         // ValidSlotIndices
  width:           '=Tb',
  height:          'N9>',
  name:            'NKm',
  classWrap:       'B@N',         // Class
  classKey:        '1o6',         // InventoryClass — item class letter (C/B/A/S)
  ssgWrap:         'WA4',         // StackSizeGroup
  ssgKey:          'rri',         // InventoryStackSizeGroup (Chest/Suit/Ship/etc.)

  // Slot fields
  slotTypeWrap:    'Vn8',         // Type
  slotTypeKey:     'elv',         // InventoryType (Substance/Product/Technology)
  slotId:          'b2n',         // Id (e.g. "^OXYGEN")
  slotAmount:      '1o9',
  slotMax:         'F9q',
  slotDamage:      'eVk',
  slotIndexWrap:   '3ZH',
  slotIndexX:      '>Qh',
  slotIndexY:      'XJ>',
  slotInstalled:   'b76',
  slotAuto:        '5tH',
  slotSeed:        '@EL',

  // Ship records
  ships:           '@Cs',         // ShipOwnership (array of ship records)
  shipResource:    'NTx',         // Resource (contains @EL seed + 93M model path)
  shipModelPath:   '93M',         // Filename (MODELS/COMMON/SPACECRAFT/...)
  shipInventory:   ';l5',         // generic Inventory (also used by vehicle/exosuit)
  shipCargo:       'gan',         // generic Inventory_Cargo
  shipTech:        'PMT',         // generic Inventory_TechOnly

  // Vehicle records
  vehicles:        'P;m',         // VehicleOwnership (exocraft records — no cargo)

  // Freighter inventories
  freighterInv:    '8ZP',
  freighterCargo:  'FdP',
  freighterTech:   '0wS',

  // Multi-tool weapons (installed mods, not loose items)
  weaponInv:       'Kgt',
};
