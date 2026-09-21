export const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** JSON with sorted keys, so two structurally equal values compare equal whatever their key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => compare(a, b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
