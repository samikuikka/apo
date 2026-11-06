/** A caller-defined dimension stamped on a batch at creation
 * (`run_metadata.labels`); `id` is what filters match, `name` is display. */
export type RunLabel = { id: string; name: string };
export type RunLabels = Record<string, RunLabel>;

export type LabelRef = { key: string; id: string };

const LABEL_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** `<key>:<id>`; the id is everything after the first colon. Throws with a
 * usage message on a malformed value. */
export function parseLabelRef(raw: string): LabelRef {
  const fail = (): Error =>
    new Error(
      `--label must be <key>:<id> with a key of letters, digits, '_' or '-' (got '${raw}')`,
    );
  const colon = raw.indexOf(":");
  if (colon < 0) throw fail();
  const key = raw.slice(0, colon);
  const id = raw.slice(colon + 1);
  // Length limits beyond the key pattern are the backend's 422 to enforce.
  if (!LABEL_KEY_RE.test(key) || id.trim() === "") throw fail();
  return { key, id };
}

/** `--label` values for `task run`: one value per key, name defaults to id.
 * Throws when the same key is given twice. */
export function labelsFromFlags(values: string[]): RunLabels {
  const labels: RunLabels = {};
  for (const raw of values) {
    const { key, id } = parseLabelRef(raw);
    if (key in labels) {
      throw new Error(`--label ${key} given more than once; a run carries one value per key`);
    }
    labels[key] = { id, name: id };
  }
  return labels;
}
