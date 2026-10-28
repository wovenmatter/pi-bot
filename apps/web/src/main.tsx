import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.tsx";
import { applyTheme, storedTheme } from "./theme.ts";
import "./styles.css";

applyTheme(storedTheme());

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
