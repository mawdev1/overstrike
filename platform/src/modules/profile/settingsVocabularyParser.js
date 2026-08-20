/**
 * Settings vocabulary parser.  design/settings-inventory.md is the SOURCE OF TRUTH.
 *
 * http-api.md §11.9 deleted its own settings table because hand-copying it is exactly what
 * produced the drift it documents (`adsSensitivityScale`, FOV narrowed to 70–110, a `voice`
 * channel that does not exist). So nothing here restates the inventory: this module PARSES it
 * and the schema is whatever the document says today.
 *
 * The parse runs at build time (`generateVocabulary.mjs` writes `vocabulary.generated.js`) so
 * the server does not read a markdown file from disk in production, and `profiletest.mjs`
 * re-parses the live document and asserts it still equals the generated artefact. A range
 * edited in the design doc therefore fails the test rather than silently disagreeing with the
 * validator.
 *
 * Unparseable rows THROW. A row we cannot understand is a setting we would otherwise drop from
 * the allowlist, and a silently dropped key is a player preference that stops roaming.
 */

/** Cells arrive as `` `sensitivity` `` or **bold**; the identifier is what we want. */
function cleanCell(s) {
  return s.replace(/`/g, '').replace(/\*\*/g, '').trim();
}

function splitRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  // Leading and trailing pipes produce empty edge cells; drop them, keep interior empties.
  const cells = trimmed.split('|').slice(1, -1).map((c) => c.trim());
  return cells.length ? cells : null;
}

const isSeparatorRow = (cells) => cells.every((c) => /^:?-{2,}:?$/.test(c));

/**
 * Enum member ids are DERIVED from their display labels by a fixed rule (lower camel, non
 * alphanumerics dropped): "Extra large" -> "extraLarge", "North up" -> "northUp". The inventory
 * only fixes IDs for categories and binding actions, so an enum id needs a deterministic
 * derivation rather than a second hand-written table that can drift.
 */
export function enumId(label) {
  const words = label.trim().split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!words.length) throw new Error(`settings-inventory: unusable enum label "${label}"`);
  return words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join('');
}

// The inventory writes ranges with an en dash and a trailing unit, and the step repeats the
// unit ("60–120°, step 1°").
const RANGE_RE = /^(-?\d+(?:\.\d+)?)\s*[–—-]\s*(-?\d+(?:\.\d+)?)\s*(%|x|°|CSS px|px)?\s*,\s*step\s*(\d+(?:\.\d+)?)\s*(?:%|°|x|CSS px|px)?$/;

/** "0.05–10.00, step 0.01" | "0–100%, step 5%" | "Off/On" | "Small/Default/Large/Extra large" */
function parseType(raw, key) {
  const t = cleanCell(raw);

  if (/^Off\/On$/i.test(t)) return { kind: 'boolean' };

  const m = t.match(RANGE_RE);
  if (m) {
    return {
      kind: 'number',
      min: Number(m[1]),
      max: Number(m[2]),
      step: Number(m[4]),
      unit: m[3] ? m[3].replace('CSS px', 'px') : null,
    };
  }

  // Crosshair colour is the one row with no enumerable value set.
  if (/valid custom hex/i.test(t)) return { kind: 'color' };

  if (t.includes('/')) {
    const labels = t.split('/').map((s) => s.trim()).filter(Boolean);
    return { kind: 'enum', values: labels.map(enumId), labels };
  }

  throw new Error(`settings-inventory: cannot parse type "${t}" for key ${key}`);
}

function parseDefault(raw, spec, key) {
  const d = cleanCell(raw);
  if (spec.kind === 'boolean') {
    if (/^off$/i.test(d)) return false;
    if (/^on\b/i.test(d)) return true;
    // "On in development; Off for public default" and "OS preference on first run" are
    // undecided defaults, not values. null means "the client supplies it".
    return null;
  }
  if (spec.kind === 'number') {
    const n = d.match(/(-?\d+(?:\.\d+)?)/);
    return n ? Number(n[1]) : null;
  }
  if (spec.kind === 'color') {
    const hex = d.match(/#[0-9A-Fa-f]{6}/);
    return hex ? hex[0].toUpperCase() : null;
  }
  if (spec.kind === 'enum') {
    const idx = spec.labels.findIndex((l) => l.toLowerCase() === d.toLowerCase());
    return idx >= 0 ? spec.values[idx] : null;   // e.g. "OS preference on first run"
  }
  throw new Error(`settings-inventory: cannot parse default "${d}" for key ${key}`);
}

const SCOPES = new Set(['ROAM', 'DEVICE', 'SESSION', 'PRACTICE']);

/**
 * @param {string} markdown contents of design/settings-inventory.md
 * @returns {{vocabularyVersion:number, categories:string[], scopes:object,
 *            roam:object, keybinds:object}}
 */
export function parseSettingsInventory(markdown) {
  const lines = markdown.split(/\r?\n/);

  const vm = markdown.match(/\*\*Vocabulary version:\*\*\s*`?(\d+)`?/);
  if (!vm) throw new Error('settings-inventory: no vocabulary version declared');

  const categories = [];
  // Prototype-less on purpose. These three are LOOKUP maps against untrusted client keys, and
  // a plain object answers `constructor`, `toString`, `valueOf` and `__proto__` with something
  // truthy that the inventory never declared. A vocabulary that vouches for keys it does not
  // contain is not an allowlist.
  const scopes = Object.create(null);   // every key we saw, with its persistence class
  const roam = Object.create(null);     // ROAM keys only — the RoamingSettingsV1 allowlist
  const keybinds = Object.create(null);

  let i = 0;
  while (i < lines.length) {
    const cells = splitRow(lines[i]);
    if (!cells) { i++; continue; }

    const header = cells.map(cleanCell);
    const rows = [];
    let j = i + 1;
    const next = splitRow(lines[j] || '');
    if (next && isSeparatorRow(next)) {
      j++;
      while (j < lines.length) {
        const r = splitRow(lines[j]);
        if (!r) break;
        rows.push(r);
        j++;
      }
    }
    i = j > i ? j : i + 1;
    if (!rows.length) continue;

    // Category vocabulary.
    if (header[0] === 'Category ID') {
      for (const r of rows) categories.push(cleanCell(r[0]));
      continue;
    }

    // Binding actions. Only the action IDs and the reserved flag are contract; the wire value
    // of a binding is a KeyboardEvent code, which the inventory writes as a human label
    // ("Left Shift"), so the labels are carried as documentation, not as validation input.
    if (header[0] === 'Action ID') {
      for (const r of rows) {
        const id = cleanCell(r[0]);
        const primary = cleanCell(r[2] || '');
        const secondary = cleanCell(r[3] || '');
        keybinds[id] = {
          label: cleanCell(r[1] || ''),
          defaultPrimaryLabel: /^unbound$/i.test(primary)
            ? null
            : primary.replace(/\s*\(reserved\)\s*/i, '').trim(),
          defaultSecondaryLabel:
            !secondary || secondary === '—' || /^unbound$/i.test(secondary) ? null : secondary,
          reserved: /\(reserved\)/i.test(primary),
        };
      }
      continue;
    }

    // Settings rows: any table carrying both a key and a persistence scope.
    const keyIdx = header.indexOf('Key');
    const scopeIdx = header.indexOf('Scope');
    const typeIdx = header.indexOf('Type/range');
    const defIdx = header.indexOf('Default');
    if (keyIdx !== 0 || scopeIdx < 0 || typeIdx < 0 || defIdx < 0) continue;

    for (const r of rows) {
      const key = cleanCell(r[keyIdx]);
      const scope = cleanCell(r[scopeIdx]).toUpperCase();
      if (!key || !SCOPES.has(scope)) {
        throw new Error(`settings-inventory: row "${key}" has unusable scope "${scope}"`);
      }
      if (scopes[key] && scopes[key] !== scope) {
        throw new Error(`settings-inventory: key ${key} declared in two scopes`);
      }
      scopes[key] = scope;
      if (scope !== 'ROAM') continue;
      const spec = parseType(r[typeIdx], key);
      spec.default = parseDefault(r[defIdx], spec, key);
      roam[key] = spec;
    }
  }

  // A settings inventory that parsed to nothing is a parser that broke, not a document that
  // emptied. Fail at generation rather than shipping an allowlist that rejects everything.
  if (!Object.keys(roam).length) throw new Error('settings-inventory: no ROAM keys parsed');
  if (Object.keys(keybinds).length < 20) throw new Error('settings-inventory: binding table not parsed');

  return { vocabularyVersion: Number(vm[1]), categories, scopes, roam, keybinds };
}
