import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { registerSW } from "virtual:pwa-register";
import App from "./App.jsx";
import InstallPrompt from "./components/InstallPrompt.jsx";
import AppErrorBoundary from "./components/AppErrorBoundary.jsx";
import { installGlobalReporters } from "./lib/errorReporter";
import "./styles.css";
import "./factory.css";
import "./chat.css";

// Manual registration (injectRegister: null in vite.config.js) so a new
// deployed version never force-reloads mid-session -- onNeedReload only
// dispatches an event; App.jsx's UpdateBanner is what actually offers the
// user an "Update App" action. Nothing here reloads the page by itself.
const updateSW = registerSW({
  onNeedReload() { window.dispatchEvent(new Event("mow-sw-update")); },
  onOfflineReady() {},
});
window.__mowApplyUpdate = () => updateSW(true);
installGlobalReporters();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {/* Route changes run as a React transition: the current screen stays up until the next screen's chunk is ready, instead of flashing a skeleton */}
    <BrowserRouter future={{ v7_startTransition: true }}>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
      <InstallPrompt />
    </BrowserRouter>
  </React.StrictMode>,
);
