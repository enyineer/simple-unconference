// Shared valibot schemas. Imported by both server (request validation) and
// web (form validation). Keep these the source of truth for "what is a valid
// X" — server enforces, client previews errors before submit.
//
// This file is the public re-export surface — every previously-exported
// name is still importable from `"./schemas"`. The actual definitions live
// in `./schemas/<domain>.ts` for readability.

export * from "./schemas/primitives";
export * from "./schemas/auth";
export * from "./schemas/conferences";
export * from "./schemas/rooms";
export * from "./schemas/submissions";
export * from "./schemas/slots";
export * from "./schemas/experts";
export * from "./schemas/profiles";
export * from "./schemas/chat";
export * from "./schemas/announcements";
export * from "./schemas/takeaways";
export * from "./schemas/utils";
