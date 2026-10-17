/** Compare editable fields against the opening draft, including primitive array values. */
export function changedFields<T extends object>(baseline: T, draft: T): Partial<T> {
  const patch: Partial<T> = {};
  for (const key of Object.keys(draft) as (keyof T)[]) {
    const before = baseline[key];
    const after = draft[key];
    const equal = Array.isArray(before) && Array.isArray(after)
      ? before.length === after.length && before.every((value, index) => Object.is(value, after[index]))
      : Object.is(before, after);
    if (!equal) patch[key] = after;
  }
  return patch;
}
