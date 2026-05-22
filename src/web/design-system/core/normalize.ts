// String normalizers shared by chip/tag input fields. Lives outside
// tag-input.tsx so that file stays a pure component module (Fast Refresh
// only re-runs React components when its modules export components only).

/** Trim whitespace and lowercase. Common for tag-style fields where casing
 *  is incidental ("Workshop" === "workshop"). */
export const lowercaseTrim = (s: string): string => s.trim().toLowerCase();
