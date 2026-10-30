/**
 * `Math.max(...values)` without spreading the array. Spreading overflows the
 * call stack on a large array (`RangeError: Maximum call stack size exceeded`);
 * a reduction keeps the argument count at one and the memory use constant.
 *
 * The reduction keeps the exact semantics of the spread form: `Math.max`
 * propagates `NaN`, and the neutral starting value matches the empty-array
 * result (`-Infinity` for max, `Infinity` for min). Callers still guard the
 * empty case because they return `null` rather than the neutral value.
 */
export function maxValue(values: readonly number[]): number {
  return values.reduce((a, b) => Math.max(a, b), -Infinity);
}

export function minValue(values: readonly number[]): number {
  return values.reduce((a, b) => Math.min(a, b), Infinity);
}
