import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { registerSW } from "virtual:pwa-register";
import App from "./App.jsx";
import InstallPrompt from "./components/InstallPrompt.jsx";
import "./styles.css";

// Manual registration (injectRegister: null in vite.config.js) so a new
// deployed version never force-reloads mid-session -- onNeedReload only
// dispatches an event; App.jsx's UpdateBanner is what actually offers the
// user an "Update App" action. Nothing here reloads the page by itself.
const updateSW = registerSW({
  onNeedReload() { window.dispatchEvent(new Event("mow-sw-update")); },
  onOfflineReady() {},
});
window.__mowApplyUpdate = () => updateSW(true);

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
      <InstallPrompt />
    </BrowserRouter>
  </React.StrictMode>,
);
