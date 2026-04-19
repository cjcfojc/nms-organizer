// Float-preserving JSON I/O for NMS save payloads.
//
// WHY this exists:
//   The NMS save payload is JSON serialized by C# with strict float formatting:
//     "22a":1.0   "yGF":75.0   "qLk":[0.0,0.0,0.0,0.0]
//   JS's JSON.parse normalizes "1.0" and "1" to the same Number value, and
//   JSON.stringify emits whole-number floats as "1" — losing every ".0".
//   The NMS payload has ~58k such floats; round-tripping through the native
//   JSON breaks libNOM's typed deserializer ("save is empty after deserializing")
//   and the game itself rejects the file.
//
// HOW it works:
//   parsePayload() walks the source text once and produces a JS object where
//   every numeric token that contained "." or "e"/"E" is wrapped in a Float()
//   instance. Plain integers stay as regular Numbers.
//   serializePayload() walks the object and emits each Float as "N.0" when N
//   is a whole number, else as String(N). Plain Numbers emit as String(N).
//   Strings, booleans, null, arrays, objects emit per the JSON spec.
//
// MUTATION RULES:
//   - To set a value that should be a float in the output, use `new Float(n)`
//     even if n is a whole number — that's how we preserve the ".0".
//   - To set a value that should be an integer, just assign a plain Number.
//   - When you copy a slot from one container to another, the Float-ness comes
//     along for the ride because we copy the wrapper, not just the underlying
//     Number — no separate bookkeeping required.
//
// SOURCE TEXT PRESERVATION:
//   Floats parsed from the source carry their original text representation
//   in `Float.source`. The serializer emits that exact text — so an unchanged
//   float round-trips byte-identical regardless of how JS would otherwise
//   stringify the same Number. (C# and JS disagree on the 17th significant
//   digit of float-precision doubles; without this, ~half of the file's
//   floats would shift by 1 ULP in their textual rep on every save.)
//   New Float() values created by mutation have source=null and use the
//   default "N.0" / String(N) formatting.
//
// ROUND-TRIP CONTRACT:
//   serializePayload(parsePayload(text)) === text
//   on any well-formed NMS save payload (with no mutations between).

export class Float {
  constructor(value, source) {
    this.value  = +value;
    this.source = source || null;   // original text rep for byte-identical emit
  }
  valueOf()  { return this.value; }
  toString() { return this.source || String(this.value); }
}

// ── Parser ────────────────────────────────────────────────────────────────────

export function parsePayload(text) {
  const ctx = { text, pos: 0 };
  skipWs(ctx);
  const value = parseValue(ctx);
  skipWs(ctx);
  if (ctx.pos < text.length) {
    const tail = text.slice(ctx.pos);
    if (!/^[\s\u0000]*$/.test(tail)) {
      throw new Error(`payload.parse: trailing content at ${ctx.pos}: ${JSON.stringify(tail.slice(0, 20))}`);
    }
  }
  return value;
}

function skipWs(ctx) {
  const t = ctx.text;
  while (ctx.pos < t.length) {
    const c = t.charCodeAt(ctx.pos);
    if (c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0D) ctx.pos++;
    else break;
  }
}

function parseValue(ctx) {
  skipWs(ctx);
  const t = ctx.text;
  if (ctx.pos >= t.length) throw new Error(`payload.parse: unexpected EOF at ${ctx.pos}`);
  const c = t.charCodeAt(ctx.pos);
  if (c === 0x7B) return parseObject(ctx);   // {
  if (c === 0x5B) return parseArray(ctx);    // [
  if (c === 0x22) return parseString(ctx);   // "
  if (c === 0x74) return parseLiteral(ctx, 'true', true);
  if (c === 0x66) return parseLiteral(ctx, 'false', false);
  if (c === 0x6E) return parseLiteral(ctx, 'null', null);
  return parseNumber(ctx);
}

function parseObject(ctx) {
  ctx.pos++; // skip {
  const out = {};
  skipWs(ctx);
  if (ctx.text.charCodeAt(ctx.pos) === 0x7D) { ctx.pos++; return out; }
  while (true) {
    skipWs(ctx);
    if (ctx.text.charCodeAt(ctx.pos) !== 0x22) throw new Error(`payload.parse: expected key string at ${ctx.pos}`);
    const key = parseString(ctx);
    skipWs(ctx);
    if (ctx.text.charCodeAt(ctx.pos) !== 0x3A) throw new Error(`payload.parse: expected ':' after key at ${ctx.pos}`);
    ctx.pos++;
    const value = parseValue(ctx);
    out[key] = value;
    skipWs(ctx);
    const c = ctx.text.charCodeAt(ctx.pos);
    if (c === 0x2C) { ctx.pos++; continue; }
    if (c === 0x7D) { ctx.pos++; return out; }
    throw new Error(`payload.parse: expected ',' or '}' at ${ctx.pos}`);
  }
}

function parseArray(ctx) {
  ctx.pos++; // skip [
  const out = [];
  skipWs(ctx);
  if (ctx.text.charCodeAt(ctx.pos) === 0x5D) { ctx.pos++; return out; }
  while (true) {
    out.push(parseValue(ctx));
    skipWs(ctx);
    const c = ctx.text.charCodeAt(ctx.pos);
    if (c === 0x2C) { ctx.pos++; continue; }
    if (c === 0x5D) { ctx.pos++; return out; }
    throw new Error(`payload.parse: expected ',' or ']' at ${ctx.pos}`);
  }
}

function parseString(ctx) {
  const t = ctx.text;
  if (t.charCodeAt(ctx.pos) !== 0x22) throw new Error(`payload.parse: expected '"' at ${ctx.pos}`);
  ctx.pos++;
  let out = '';
  let chunkStart = ctx.pos;
  while (ctx.pos < t.length) {
    const c = t.charCodeAt(ctx.pos);
    if (c === 0x22) {
      out += t.slice(chunkStart, ctx.pos);
      ctx.pos++;
      return out;
    }
    if (c === 0x5C) {   // backslash
      out += t.slice(chunkStart, ctx.pos);
      ctx.pos++;
      const esc = t.charCodeAt(ctx.pos);
      ctx.pos++;
      switch (esc) {
        case 0x22: out += '"'; break;
        case 0x5C: out += '\\'; break;
        case 0x2F: out += '/'; break;
        case 0x62: out += '\b'; break;
        case 0x66: out += '\f'; break;
        case 0x6E: out += '\n'; break;
        case 0x72: out += '\r'; break;
        case 0x74: out += '\t'; break;
        case 0x75: {
          const hex = t.slice(ctx.pos, ctx.pos + 4);
          if (hex.length !== 4) throw new Error(`payload.parse: short \\u escape at ${ctx.pos}`);
          const code = parseInt(hex, 16);
          if (Number.isNaN(code)) throw new Error(`payload.parse: bad \\u escape at ${ctx.pos}`);
          out += String.fromCharCode(code);
          ctx.pos += 4;
          break;
        }
        default: throw new Error(`payload.parse: bad escape \\${String.fromCharCode(esc)} at ${ctx.pos - 1}`);
      }
      chunkStart = ctx.pos;
      continue;
    }
    ctx.pos++;
  }
  throw new Error(`payload.parse: unterminated string starting at ${chunkStart - 1}`);
}

function parseLiteral(ctx, lit, value) {
  if (ctx.text.slice(ctx.pos, ctx.pos + lit.length) !== lit)
    throw new Error(`payload.parse: expected ${lit} at ${ctx.pos}`);
  ctx.pos += lit.length;
  return value;
}

function parseNumber(ctx) {
  const t = ctx.text;
  const start = ctx.pos;
  if (t.charCodeAt(ctx.pos) === 0x2D) ctx.pos++;
  while (ctx.pos < t.length) {
    const c = t.charCodeAt(ctx.pos);
    if (c >= 0x30 && c <= 0x39) ctx.pos++;
    else break;
  }
  let isFloat = false;
  if (t.charCodeAt(ctx.pos) === 0x2E) {
    isFloat = true;
    ctx.pos++;
    while (ctx.pos < t.length) {
      const c = t.charCodeAt(ctx.pos);
      if (c >= 0x30 && c <= 0x39) ctx.pos++;
      else break;
    }
  }
  const ec = t.charCodeAt(ctx.pos);
  if (ec === 0x65 || ec === 0x45) {
    isFloat = true;
    ctx.pos++;
    const sgn = t.charCodeAt(ctx.pos);
    if (sgn === 0x2B || sgn === 0x2D) ctx.pos++;
    while (ctx.pos < t.length) {
      const c = t.charCodeAt(ctx.pos);
      if (c >= 0x30 && c <= 0x39) ctx.pos++;
      else break;
    }
  }
  const numStr = t.slice(start, ctx.pos);
  const value = +numStr;
  if (Number.isNaN(value)) throw new Error(`payload.parse: bad number "${numStr}" at ${start}`);
  return isFloat ? new Float(value, numStr) : value;
}

// ── Deep clone (Float-aware) ──────────────────────────────────────────────────
//
// structuredClone() can't be used on a parsed payload because it strips class
// identity from Float instances (turns them into plain {value,source} objects),
// which breaks `instanceof Float` in the serializer. This recursive cloner
// preserves Float wrappers.

export function clonePayload(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Float) return new Float(value.value, value.source);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = clonePayload(value[i]);
    return out;
  }
  const out = {};
  for (const k of Object.keys(value)) out[k] = clonePayload(value[k]);
  return out;
}

// ── Serializer ────────────────────────────────────────────────────────────────

export function serializePayload(value) {
  const parts = [];
  emit(value, parts);
  return parts.join('');
}

// C#'s System.Text.Json (and Newtonsoft) emit \uXXXX escapes with UPPERCASE
// hex digits. JS's JSON.stringify uses lowercase. Match C# so unchanged
// strings round-trip byte-identical. Escape set matches Newtonsoft defaults:
// quote, backslash, and control chars 0x00..0x1F. Non-ASCII bytes are
// passed through as-is (UTF-8 in the source text).
function escapeJsonString(s) {
  let out = '"';
  let chunkStart = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let esc = null;
    if      (c === 0x22) esc = '\\"';
    else if (c === 0x5C) esc = '\\\\';
    else if (c === 0x08) esc = '\\b';
    else if (c === 0x09) esc = '\\t';
    else if (c === 0x0A) esc = '\\n';
    else if (c === 0x0C) esc = '\\f';
    else if (c === 0x0D) esc = '\\r';
    else if (c < 0x20)   esc = '\\u' + c.toString(16).toUpperCase().padStart(4, '0');
    if (esc !== null) {
      if (i > chunkStart) out += s.slice(chunkStart, i);
      out += esc;
      chunkStart = i + 1;
    }
  }
  if (chunkStart < s.length) out += s.slice(chunkStart);
  out += '"';
  return out;
}

function emit(value, parts) {
  if (value === null || value === undefined) {
    parts.push('null');
    return;
  }
  if (value instanceof Float) {
    if (value.source !== null) { parts.push(value.source); return; }
    const n = value.value;
    if (Number.isInteger(n) && Number.isFinite(n)) parts.push(`${n}.0`);
    else parts.push(String(n));
    return;
  }
  if (typeof value === 'number') {
    parts.push(String(value));
    return;
  }
  if (typeof value === 'boolean') {
    parts.push(value ? 'true' : 'false');
    return;
  }
  if (typeof value === 'string') {
    parts.push(escapeJsonString(value));
    return;
  }
  if (Array.isArray(value)) {
    parts.push('[');
    for (let i = 0; i < value.length; i++) {
      if (i > 0) parts.push(',');
      emit(value[i], parts);
    }
    parts.push(']');
    return;
  }
  if (typeof value === 'object') {
    parts.push('{');
    let first = true;
    for (const k of Object.keys(value)) {
      if (!first) parts.push(',');
      first = false;
      parts.push(escapeJsonString(k));
      parts.push(':');
      emit(value[k], parts);
    }
    parts.push('}');
    return;
  }
  throw new Error(`payload.serialize: unsupported value type ${typeof value}`);
}
