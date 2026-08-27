/**
 * Serialize JSON values deterministically.
 *
 * `JSON.stringify` is deliberately not used as the validator here: it silently
 * drops undefined/function/symbol object properties and turns unsupported array
 * values into null. Both behaviours are unsafe for content-addressed evidence.
 */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, new WeakSet<object>(), '$');
}

function canonicalize(value: unknown, ancestors: WeakSet<object>, path: string): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`Unsupported non-finite number at ${path}`);
      }
      return JSON.stringify(value);
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      throw new TypeError(`Unsupported ${typeof value} at ${path}`);
    case "object":
      break;
    default:
      throw new TypeError(`Unsupported value at ${path}`);
  }

  if (ancestors.has(value)) throw new TypeError(`Cyclic value at ${path}`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new TypeError(`Sparse array is unsupported at ${path}[${index}]`);
        }
        items.push(canonicalize(value[index], ancestors, `${path}[${index}]`));
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new TypeError(`Symbol-keyed property is unsupported at ${path}`);
      }
      for (const name of Object.getOwnPropertyNames(value)) {
        if (name === "length") continue;
        const index = Number(name);
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= value.length ||
          String(index) !== name
        ) {
          throw new TypeError(`Non-index array property is unsupported at ${path}.${name}`);
        }
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Non-plain object is unsupported at ${path}`);
    }
    const symbols = Object.getOwnPropertySymbols(value);
    if (symbols.length > 0) {
      throw new TypeError(`Symbol-keyed property is unsupported at ${path}`);
    }

    // Include all own string properties, including non-enumerable ones. This
    // prevents hidden data from being silently omitted from an evidence hash.
    const names = Object.getOwnPropertyNames(value).sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const entries: string[] = [];
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !("value" in descriptor)) {
        throw new TypeError(`Accessor property is unsupported at ${path}.${name}`);
      }
      entries.push(
        `${JSON.stringify(name)}:${canonicalize(descriptor.value, ancestors, `${path}.${name}`)}`,
      );
    }
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
