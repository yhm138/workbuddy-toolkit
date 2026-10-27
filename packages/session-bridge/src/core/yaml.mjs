/**
 * A deliberately small YAML subset parser.
 *
 * DSH profile files (cordis.yml / cordis.patch.yml) use only a narrow slice of
 * YAML: nested mappings, sequences, inline sequences, quoted scalars and the
 * `!!js` tag. Pulling a full YAML dependency into a migration tool that people
 * are expected to run offline is not worth it, so we parse exactly that slice.
 *
 * Supported:
 *   - block mappings / sequences by indentation
 *   - sequences of mappings (`- id: x` followed by sibling keys)
 *   - inline sequences `[a, b]` and inline maps `{a: 1}`
 *   - single/double quoted scalars, numbers, booleans, null
 *   - block scalars (`|`, `>`) and `!!js` values (kept as raw source text)
 *   - comments and blank lines
 *
 * Not supported (and not needed here): anchors/aliases, multi-document streams,
 * complex keys, tags other than `!!js`.
 */

const TRUE_VALUES = new Set(['true', 'True', 'TRUE', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', 'False', 'FALSE', 'no', 'off']);
const NULL_VALUES = new Set(['null', 'Null', 'NULL', '~', '']);

export function parseYaml(text) {
  const source = stripBom(text).split(/\r?\n/);
  const lines = [];
  for (let i = 0; i < source.length; i += 1) {
    const raw = source[i];
    const withoutComment = stripComment(raw);
    if (!withoutComment.trim()) continue;
    const indent = countIndent(withoutComment);
    lines.push({
      indent,
      // keep the raw text for values that must survive verbatim (block scalars)
      text: withoutComment.slice(indent).replace(/\s+$/, ''),
      line: i + 1,
      index: i,
    });
  }

  let cursor = 0;

  const peek = () => lines[cursor];
  const nextIndent = () => (cursor < lines.length ? lines[cursor].indent : -1);

  function parseNode(indent) {
    const line = peek();
    if (!line || line.indent !== indent) return null;
    if (isSequenceLine(line.text)) return parseSequence(indent);
    // A document that is a single scalar or inline collection (`[]`, `{a: 1}`,
    // `hello`) has no `key:` separator; without this it would be mistaken for a
    // mapping with a synthetic key.
    if (findKeySeparator(line.text) < 0) {
      cursor += 1;
      return parseScalar(line.text);
    }
    return parseMapping(indent);
  }

  function parseSequence(indent) {
    const out = [];
    while (cursor < lines.length && lines[cursor].indent === indent && isSequenceLine(lines[cursor].text)) {
      const item = lines[cursor];
      const rest = item.text.replace(/^-\s?/, '');
      cursor += 1;

      if (!rest) {
        // `-` alone: value is the nested block (or null when the block ends)
        if (nextIndent() > indent) {
          out.push(parseNode(nextIndent()));
        } else {
          out.push(null);
        }
        continue;
      }

      if (findKeySeparator(rest) >= 0) {
        const obj = {};
        const keyIndent = indent + 2;
        readEntryInto(obj, rest, keyIndent, item);
        // sibling keys of the same sequence item
        while (cursor < lines.length && lines[cursor].indent > indent) {
          const childIndent = nextIndent();
          const child = parseMapping(childIndent);
          if (child && typeof child === 'object') Object.assign(obj, child);
          else break;
        }
        out.push(obj);
        continue;
      }

      out.push(parseScalar(rest));
    }
    return out;
  }

  function parseMapping(indent) {
    const out = {};
    while (cursor < lines.length && lines[cursor].indent === indent && !isSequenceLine(lines[cursor].text)) {
      const item = lines[cursor];
      const separator = findKeySeparator(item.text);
      if (separator < 0) {
        // A bare scalar where a mapping was expected: keep it as a value list.
        cursor += 1;
        out[`_${cursor}`] = parseScalar(item.text);
        continue;
      }
      cursor += 1;
      readEntryInto(out, item.text, indent, item);
    }
    return out;
  }

  /**
   * Reads `key: value` (and any nested block / block scalar that belongs to the
   * value) into `target`. `cursor` is already positioned after the key line.
   */
  function readEntryInto(target, text, indent, owner) {
    const separator = findKeySeparator(text);
    const key = unquote(text.slice(0, separator).trim());
    const rawValue = text.slice(separator + 1).trim();

    if (rawValue === '') {
      target[key] = nextIndent() > indent ? parseNode(nextIndent()) : null;
      return;
    }

    if (/^!!js\b/.test(rawValue)) {
      target[key] = readTaggedScalar(rawValue, indent, owner);
      return;
    }

    if (rawValue === '|' || rawValue === '>' || rawValue === '|-' || rawValue === '>-') {
      target[key] = readBlockScalar(rawValue, indent);
      return;
    }

    target[key] = parseScalar(rawValue);
  }

  function readTaggedScalar(firstLine, indent, owner) {
    const parts = [firstLine.replace(/^!!js\s*/, '')];
    while (cursor < lines.length && lines[cursor].indent > indent) {
      parts.push(lines[cursor].text);
      cursor += 1;
    }
    // Preserve the original folded continuations: join with a space, then drop
    // the YAML backslash line-continuations if the author used them.
    const joined = parts.join(' ').replace(/\\\s+/g, '');
    return { __tag: 'js', source: joined, line: owner.line };
  }

  function readBlockScalar(marker, indent) {
    const block = [];
    while (cursor < lines.length && lines[cursor].indent > indent) {
      block.push(lines[cursor].text);
      cursor += 1;
    }
    return marker.startsWith('|') ? block.join('\n') : block.join(' ');
  }

  if (lines.length === 0) return null;
  return parseNode(lines[0].indent);
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function countIndent(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i += 1;
  return i;
}

function isSequenceLine(text) {
  return text === '-' || text.startsWith('- ');
}

/** Removes a trailing `# comment`, but only outside of quotes. */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\' && quote === '"') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Returns the index of the `key:` separator, or -1 when the line is not a key. */
function findKeySeparator(text) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth += 1;
    if (ch === ']' || ch === '}') depth -= 1;
    if (ch === ':' && depth === 0) {
      const next = text[i + 1];
      if (next === undefined || next === ' ' || next === '\t') return i;
    }
  }
  return -1;
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return parseQuoted(value);
  }
  return value;
}

function parseQuoted(value) {
  const quote = value[0];
  const inner = value.slice(1, -1);
  if (quote === "'") return inner.replace(/''/g, "'");
  return inner.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

export function parseScalar(raw) {
  const value = raw.trim();
  if (value === '') return null;
  if (NULL_VALUES.has(value)) return null;
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) return parseQuoted(value);
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return parseQuoted(value);
  if (value.startsWith('[') && value.endsWith(']')) return parseInlineArray(value);
  if (value.startsWith('{') && value.endsWith('}')) return parseInlineMap(value);
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function splitTopLevel(text, separator) {
  const parts = [];
  let current = '';
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"') {
        current += text[i + 1] ?? '';
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth += 1;
    if (ch === ']' || ch === '}') depth -= 1;
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function parseInlineArray(value) {
  const inner = value.slice(1, -1).trim();
  if (!inner) return [];
  return splitTopLevel(inner, ',').map((part) => parseScalar(part.trim()));
}

function parseInlineMap(value) {
  const inner = value.slice(1, -1).trim();
  if (!inner) return {};
  const out = {};
  for (const part of splitTopLevel(inner, ',')) {
    const separator = findKeySeparator(part);
    if (separator < 0) continue;
    const key = unquote(part.slice(0, separator).trim());
    out[key] = parseScalar(part.slice(separator + 1).trim());
  }
  return out;
}

/** Flattens `{__tag:'js'}` wrappers so callers never need to know about tags. */
export function plainify(node) {
  if (Array.isArray(node)) return node.map(plainify);
  if (node && typeof node === 'object') {
    if (node.__tag === 'js') return node.source;
    const out = {};
    for (const [key, value] of Object.entries(node)) out[key] = plainify(value);
    return out;
  }
  return node;
}
