import React from "react";
import ReactDOM from "react-dom/client";

function App() {
  return <main>Pi Bot</main>;
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
