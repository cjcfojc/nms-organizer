// Lightweight MXML parser for NMS GC*Table.MXML files (MBINCompiler 6.x output).
// MXML structure: a tree of <Property name="X" [value="Y"] [_id="Z"]> elements,
// each either self-closing or containing nested <Property> children.
//
// Key observation: MBINCompiler emits one element per line with consistent indentation.
// We parse line-by-line, attribute-by-regex. No external XML lib needed.

const fs = require('fs');

function parseMXMLFile(path) {
  const text = fs.readFileSync(path, 'utf8');
  const lines = text.split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0
      && !l.startsWith('<?xml')
      && !l.startsWith('<!--')
      && !l.startsWith('<Data')
      && l !== '</Data>');

  let i = 0;
  function parseProp() {
    const line = lines[i++];
    if (!line.startsWith('<Property')) throw new Error(`expected <Property at line ${i}, got: ${line}`);
    const selfClose = line.endsWith('/>');
    const attrs = {};
    for (const m of line.matchAll(/(\w+)="([^"]*)"/g)) attrs[m[1]] = m[2];
    const node = { name: attrs.name || null, value: attrs.value || null, id: attrs._id || null, children: [] };
    if (selfClose) return node;
    while (i < lines.length && lines[i] !== '</Property>') {
      node.children.push(parseProp());
    }
    if (lines[i] === '</Property>') i++;
    return node;
  }

  // Outermost: <Property name="Table"> wrapping the items array
  return parseProp();
}

// Convert a property node into a flat-ish JS object.
// Rules:
//   - Leaf (no children): scalar string
//   - Wrapper around single child whose name differs (e.g. Category → SubstanceCategory):
//     collapse to the inner leaf's value
//   - Multi-child leaves (e.g. Colour {R,G,B,A}): nested object of leaves
//   - Repeated child name (array — e.g. Requirements with multiple Requirements children): array of subtrees
function nodeToObject(node) {
  if (node.children.length === 0) return node.value;

  // Detect array: when all children share the same name (and there are 2+ of them)
  const childNames = node.children.map(c => c.name);
  const allSame = childNames.length >= 2 && childNames.every(n => n === childNames[0]);
  if (allSame) return node.children.map(nodeToObject);

  // Special collapse: GcX wrapper around exactly one leaf — extract that leaf's value
  // (NMS uses pattern: <Property name="Rarity" value="GcRarity"><Property name="Rarity" value="Common"/></Property>)
  if (node.value && /^Gc/.test(node.value)
      && node.children.length === 1
      && node.children[0].children.length === 0) {
    return node.children[0].value;
  }

  // General: object of children by name
  const out = {};
  for (const c of node.children) {
    if (c.name === null) continue;
    out[c.name] = nodeToObject(c);
  }
  // Preserve _id if present (item identifier)
  if (node.id) out._id = node.id;
  return out;
}

// Top-level helper: parse a Table.MXML and return its array of items.
// Each item is a Property name="Table" value="<DataType>" _id="...".
function loadTable(path) {
  const root = parseMXMLFile(path);
  // root is <Property name="Table"> (the outer); its children are the actual item rows.
  if (root.name !== 'Table') throw new Error(`expected outer Property name="Table", got "${root.name}"`);
  return root.children.map(nodeToObject);
}

module.exports = { parseMXMLFile, nodeToObject, loadTable };
