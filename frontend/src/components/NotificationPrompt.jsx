import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { enablePushNotifications, getPushStatus, sendTestNotification } from "../lib/pushNotifications";

// Turns notifications on for THIS device (a tap is required -- browsers ignore a permission request made on page load) and, on the
// Notifications screen (`detailed`), shows the device status and a "Send test" button that pushes a real notification through the whole
// pipeline so anyone can verify their phone is set up. The compact banner hides itself once the device is registered.
const TXT = {
  en: {
    default: "Turn on notifications to get chats and task alerts instantly — even when the app is closed.",
    enable: "Turn on notifications",
    later: "Later",
    "granted-unsubscribed": "Notifications are allowed, but this device is not registered yet.",
    register: "Register this device",
    "needs-install": "On iPhone/iPad, tap Share → “Add to Home Screen”, then open Mood of Wood from the Home Screen to turn on notifications.",
    denied: "Notifications are blocked for this app. Allow them in your browser / phone settings to receive alerts.",
    unsupported: "This browser cannot receive background notifications. You will still see alerts while the app is open.",
    granted: "Notifications are ON for this device.",
    test: "Send test notification",
    testSent: "Test sent — it should arrive within a few seconds.",
    testFail: "Could not send the test. Please try again.",
  },
  gu: {
    default: "ચેટ અને કાર્યોની સૂચનાઓ તરત મેળવવા સૂચનાઓ ચાલુ કરો — એપ બંધ હોય ત્યારે પણ.",
    enable: "સૂચનાઓ ચાલુ કરો",
    later: "પછી",
    "granted-unsubscribed": "સૂચનાઓ મંજૂર છે, પરંતુ આ ડિવાઇસ હજી નોંધાયું નથી.",
    register: "આ ડિવાઇસ નોંધો",
    "needs-install": "iPhone/iPad પર Share → “Add to Home Screen” કરો, પછી હોમ સ્ક્રીનમાંથી Mood of Wood ખોલી સૂચનાઓ ચાલુ કરો.",
    denied: "આ એપ માટે સૂચનાઓ બ્લોક છે. સૂચનાઓ મેળવવા બ્રાઉઝર / ફોન સેટિંગ્સમાં મંજૂરી આપો.",
    unsupported: "આ બ્રાઉઝર બેકગ્રાઉન્ડ સૂચનાઓ મેળવી શકતું નથી. એપ ખુલ્લી હોય ત્યારે તમને ચેતવણીઓ મળશે.",
    granted: "આ ડિવાઇસ માટે સૂચનાઓ ચાલુ છે.",
    test: "ટેસ્ટ સૂચના મોકલો",
    testSent: "ટેસ્ટ મોકલાયું — થોડી સેકન્ડમાં આવવું જોઈએ.",
    testFail: "ટેસ્ટ મોકલી શકાયું નથી. ફરી પ્રયાસ કરો.",
  },
};
const SNOOZE_KEY = "mow.notif_prompt_snooze";
const SNOOZE_MS = 24 * 60 * 60 * 1000;

function snoozed() {
  try { return Date.now() < Number(localStorage.getItem(SNOOZE_KEY) || 0); } catch { return false; }
}

export default function NotificationPrompt({ lang = "en", detailed = false }) {
  const tx = TXT[lang === "gu" ? "gu" : "en"];
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const [hidden, setHidden] = useState(snoozed);

  const refresh = useCallback(() => { getPushStatus().then(setStatus); }, []);
  useEffect(() => {
    refresh();
    // the user may change the permission in the browser settings and come back
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, [refresh]);

  if (!status) return null;
  const ok = status === "granted";
  if (!detailed && (ok || hidden || status === "unsupported")) return null;

  async function enable() {
    setBusy(true);
    setNote(null);
    setStatus(await enablePushNotifications(supabase));
    setBusy(false);
  }
  async function test() {
    setBusy(true);
    const { error } = await sendTestNotification(supabase);
    setNote(error ? tx.testFail : tx.testSent);
    setBusy(false);
  }
  function later() {
    try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS)); } catch { /* non-fatal */ }
    setHidden(true);
  }

  const canEnable = status === "default" || status === "granted-unsubscribed";
  return (
    <div className={`notif-prompt${ok ? " ok" : ""}`} role="status">
      <span aria-hidden="true">{ok ? "🔔" : "🔕"}</span>
      <div className="notif-prompt-text">{tx[status]}{note && <div className="sub">{note}</div>}</div>
      <div className="notif-prompt-actions">
        {canEnable && <button type="button" className="btn btn-primary" disabled={busy} onClick={enable}>{status === "default" ? tx.enable : tx.register}</button>}
        {detailed && ok && <button type="button" className="btn btn-outline" disabled={busy} onClick={test}>{tx.test}</button>}
        {!detailed && <button type="button" className="btn btn-outline" onClick={later}>{tx.later}</button>}
      </div>
    </div>
  );
}
