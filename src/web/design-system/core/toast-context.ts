// Internal context module for the toast system. Kept in its own file so:
//   - `toast.tsx` exports only the ToastProvider component (no warnings
//     from react-refresh/only-export-components for mixing component +
//     non-component exports);
//   - `use-toast.ts` exports only the hook (same reason);
//   - both share the exact same React context instance via this module.
//
// Public API is `ToastProvider` (from toast.tsx) and `useToast` (from
// use-toast.ts). Don't import from this file directly outside the toast
// implementation.

import { createContext } from "react";

export type ToastKind = "error" | "success" | "info" | "warning";

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
}

export interface ToastApi {
  error: (message: string) => void;
  success: (message: string) => void;
  info: (message: string) => void;
  warning: (message: string) => void;
  dismiss: (id: string) => void;
}

export const ToastCtx = createContext<ToastApi | null>(null);
