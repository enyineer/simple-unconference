// Tiny form helper around valibot schemas. Drives field-level errors and
// merges server-side errors (returned as `{ error: "validation", fields: ... }`)
// back into the same state.

import { useCallback, useState } from "react";
import * as v from "valibot";
import { toFieldErrors, type FieldErrors } from "../shared/schemas";

export interface FormApi<T> {
  values: T;
  errors: FieldErrors;
  setValue: <K extends keyof T>(key: K, value: T[K]) => void;
  setErrors: (errors: FieldErrors) => void;
  reset: (next?: Partial<T>) => void;
  fieldError: (key: keyof T & string) => string | undefined;
  /** Validate with the schema. Returns parsed output or null (and sets errors). */
  validate: () => unknown | null;
  /** Merge field errors from a server validation response into form state. */
  applyServerErrors: (resp: unknown) => boolean;
}

export function useForm<TSchema extends v.GenericSchema<Record<string, unknown>>>(
  schema: TSchema,
  initial: Partial<v.InferInput<TSchema>>,
): FormApi<v.InferInput<TSchema>> {
  type T = v.InferInput<TSchema>;
  const [values, setValues] = useState<T>(initial as T);
  const [errors, setErrors] = useState<FieldErrors>({});

  const setValue = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!((key as string) in prev)) return prev;
      const next = { ...prev };
      delete next[key as string];
      return next;
    });
  }, []);

  const reset = useCallback((next?: Partial<T>) => {
    setValues({ ...initial, ...(next ?? {}) } as T);
    setErrors({});
  }, [initial]);

  const fieldError = useCallback((key: keyof T & string) => errors[key], [errors]);

  const validate = useCallback(() => {
    const r = v.safeParse(schema, values);
    if (r.success) {
      setErrors({});
      return r.output;
    }
    setErrors(toFieldErrors(r.issues));
    return null;
  }, [schema, values]);

  const applyServerErrors = useCallback((resp: unknown) => {
    if (resp && typeof resp === "object" && "fields" in resp) {
      const f = (resp as { fields?: FieldErrors }).fields;
      if (f && typeof f === "object") {
        setErrors(f);
        return true;
      }
    }
    return false;
  }, []);

  return { values, errors, setValue, setErrors, reset, fieldError, validate, applyServerErrors };
}
