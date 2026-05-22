// Hook accessor for the toast API. Lives in its own file so the
// react-refresh/only-export-components rule doesn't flag toast.tsx
// (which exports the ToastProvider component) for mixing a component
// export with a non-component hook export.

import { useContext } from "react";
import { ToastCtx, type ToastApi } from "./toast-context";

export function useToast(): ToastApi {
  const api = useContext(ToastCtx);
  if (!api) {
    throw new Error("useToast() must be used inside <ToastProvider>");
  }
  return api;
}
