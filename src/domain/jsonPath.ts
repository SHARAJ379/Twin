// A deliberately small JSONPath subset - just enough for scenario `save:`
// expressions ($.id, $.user.email, $.items[0].id). Not a general JSONPath
// implementation; pulling in a dependency for this would be overkill (§7.1).

export class JsonPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonPathError";
  }
}

function tokenize(path: string): string[] {
  const body = path.startsWith("$.") ? path.slice(2) : path.startsWith("$") ? path.slice(1) : path;
  const tokens: string[] = [];
  let current = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === ".") {
      if (current.length > 0) tokens.push(current);
      current = "";
    } else if (ch === "[") {
      if (current.length > 0) tokens.push(current);
      current = "";
      const end = body.indexOf("]", i);
      if (end === -1) throw new JsonPathError(`malformed JSONPath "${path}": unterminated "["`);
      const index = body.slice(i + 1, end);
      // `$.items[]` is a typo, not a selector this subset supports. It used to
      // be read as index 0 - Number("") is 0, and Number.isInteger(0) is true -
      // so the step silently saved the first element and the scenario looked
      // like it worked.
      if (index.trim().length === 0) {
        throw new JsonPathError(`malformed JSONPath "${path}": "[]" needs an index, e.g. "[0]"`);
      }
      tokens.push(index);
      i = end;
    } else {
      current += ch;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

export function extractJsonPath(value: unknown, path: string): unknown {
  const tokens = tokenize(path);
  let current: unknown = value;

  for (const token of tokens) {
    if (current === null || current === undefined) {
      throw new JsonPathError(`JSONPath "${path}" has no value at "${token}"`);
    }
    if (Array.isArray(current)) {
      // Number(" ") and Number("") are both 0, and Number("1.5") is an integer
      // check away from being accepted as an index - so the token has to look
      // like a plain integer before it is treated as one.
      const idx = /^-?\d+$/.test(token) ? Number(token) : Number.NaN;
      current = Number.isInteger(idx) ? current[idx] : undefined;
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[token];
    } else {
      throw new JsonPathError(`JSONPath "${path}" cannot index into a primitive value at "${token}"`);
    }
  }

  if (current === undefined) throw new JsonPathError(`JSONPath "${path}" did not match anything`);
  return current;
}
