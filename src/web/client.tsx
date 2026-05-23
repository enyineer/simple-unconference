import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { HashRouter } from "./HashRouter";

const root = document.getElementById("root");
if (!root) throw new Error("#root element not found");
createRoot(root).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);
