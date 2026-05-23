// Shared validation helpers: a typed error-map shape plus a safeParse wrapper
// that converts valibot issues into a flat path -> message map suitable for
// `c.json(...)` responses on the server and inline-field rendering on the
// client.

import * as v from "valibot";

/**
 * Field-level error map produced by valibot, keyed by dotted path.
 * Server returns this on 400; client renders inline next to inputs.
 */
export interface FieldErrors {
  [path: string]: string;
}

export function toFieldErrors(issues: v.BaseIssue<unknown>[]): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of issues) {
    const path = (issue.path ?? [])
      .map((p) => String((p as { key: PropertyKey }).key))
      .join(".") || "_";
    if (!(path in out)) out[path] = issue.message;
  }
  return out;
}

/**
 * Server-side helper: parse with valibot, returning either { ok: true, data }
 * or { ok: false, errors } in a structured shape suitable for `c.json(...)`.
 */
export function safeParse<TSchema extends v.GenericSchema>(
  schema: TSchema,
  input: unknown,
): { ok: true; data: v.InferOutput<TSchema> }
  | { ok: false; errors: FieldErrors } {
  const result = v.safeParse(schema, input);
  if (result.success) return { ok: true, data: result.output };
  return { ok: false, errors: toFieldErrors(result.issues) };
}
