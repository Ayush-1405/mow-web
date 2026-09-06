// Mood of Wood — MVP Pilot — staff-first-login-ui (TEMPORARY)
//
// Public GET endpoint. Serves a minimal, self-contained bilingual (EN/GU)
// first-login web page: Employee Code + Current Password -> staff-login,
// and (only if must_change_password is true) New Password + Confirm ->
// staff-password-change, using the access token returned by staff-login
// as the Bearer token for that second call.
//
// This function does NOT use the service-role key, does NOT touch any
// database table, and does NOT import any of the _shared/*.ts helpers used
// by the other four staff-* functions — it only serves one static HTML
// document. It calls the two existing endpoints via relative, same-origin
// fetch() from the BROWSER, not from this server-side code, so no CORS
// configuration is involved: a same-origin browser fetch is never subject
// to CORS in the first place.
//
// Security posture:
//   - The access token lives ONLY in a JS closure variable in the served
//     page (in-memory) — never written to localStorage, sessionStorage,
//     a cookie, the URL, any DOM attribute/text, or any console.* call.
//   - Cache-Control: no-store on every response from this function.
//   - A restrictive, per-request-nonce Content-Security-Policy:
//     default-src 'none'; script-src/style-src limited to 'self' plus this
//     response's one-time nonce; connect-src 'self' only; object-src/
//     base-uri/frame-ancestors all locked down. No third-party origin is
//     reachable from this page at all.
//   - No external scripts, fonts, or stylesheets — everything is inlined
//     in this one file, nothing is fetched from a CDN.
//   - All credential fields and the in-memory token are cleared after
//     every terminal outcome: a successful password change, a successful
//     login that did NOT require a password change, or any error.
//
// Deploy with verify_jwt = false — this page itself must be reachable by
// an employee who is not yet authenticated (that is the entire point of a
// first-login screen). It carries no privileged logic of its own: every
// privileged check (rate limiting, credential verification, RLS, audit)
// still happens inside staff-login and staff-password-change exactly as
// before and exactly as already reviewed/deployed. This function is a
// static front door to those two endpoints, nothing more.
//
// TEMPORARY: intended for pilot bring-up only (until a real first-party
// client exists, or once every pilot employee has completed their forced
// password change). Safe to delete on its own — it owns no state, no
// database object, and no other function depends on it.

const PAGE_HTML = (nonce: string) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>Mood of Wood — First Login / પ્રથમ લોગિન</title>
<style nonce="${nonce}">
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #f4f3f0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
    color: #2a2420;
    padding: 24px;
  }
  main {
    width: 100%;
    max-width: 380px;
    background: #ffffff;
    border: 1px solid #e2ddd5;
    border-radius: 10px;
    padding: 28px 24px;
  }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.sub { font-size: 13px; color: #6b6259; margin: 0 0 20px; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 14px 0 4px; }
  label .gu { font-weight: 400; color: #6b6259; }
  input {
    width: 100%;
    padding: 9px 10px;
    border: 1px solid #cfc8bd;
    border-radius: 6px;
    font-size: 14px;
  }
  input:focus { outline: 2px solid #8a6d3b; outline-offset: 1px; }
  button {
    width: 100%;
    margin-top: 18px;
    padding: 10px;
    border: none;
    border-radius: 6px;
    background: #2a2420;
    color: #fff;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }
  button:disabled { opacity: 0.6; cursor: not-allowed; }
  #msg {
    margin-top: 16px;
    font-size: 13px;
    line-height: 1.5;
    padding: 10px 12px;
    border-radius: 6px;
    display: none;
  }
  #msg.error { display: block; background: #fdecec; color: #8a2a20; border: 1px solid #f2c6c0; }
  #msg.success { display: block; background: #eaf6ec; color: #1f5c34; border: 1px solid #c7e8cd; }
  #msg.info { display: block; background: #f0f0ec; color: #4a4640; border: 1px solid #dcd8d0; }
  section[hidden] { display: none; }
</style>
</head>
<body>
<main>
  <h1>Mood of Wood — Staff First Login</h1>
  <p class="sub">પ્રથમ લોગિન / પાસવર્ડ સેટઅપ</p>

  <section id="login-section">
    <form id="login-form" autocomplete="off">
      <label for="employee_code">Employee Code <span class="gu">/ કર્મચારી કોડ</span></label>
      <input id="employee_code" name="employee_code" type="text" autocomplete="off" required maxlength="40">

      <label for="current_password">Current Password <span class="gu">/ હાલનો પાસવર્ડ</span></label>
      <input id="current_password" name="current_password" type="password" autocomplete="off" required maxlength="200">

      <button type="submit" id="login-btn">Login / લોગિન</button>
    </form>
  </section>

  <section id="change-section" hidden>
    <form id="change-form" autocomplete="off">
      <label for="new_password">New Password <span class="gu">/ નવો પાસવર્ડ</span></label>
      <input id="new_password" name="new_password" type="password" autocomplete="new-password" required minlength="8" maxlength="200">

      <label for="confirm_password">Confirm New Password <span class="gu">/ નવો પાસવર્ડ ફરીથી</span></label>
      <input id="confirm_password" name="confirm_password" type="password" autocomplete="new-password" required minlength="8" maxlength="200">

      <button type="submit" id="change-btn">Change Password / પાસવર્ડ બદલો</button>
    </form>
  </section>

  <div id="msg" role="status" aria-live="polite"></div>
</main>

<script nonce="${nonce}">
(function () {
  "use strict";

  // Access token lives ONLY in this closure-scoped variable — never on
  // window, never in any Web Storage API, never in a cookie, never in the
  // URL, never rendered into the DOM, never passed to console.*.
  var accessToken = null;

  var loginSection = document.getElementById("login-section");
  var changeSection = document.getElementById("change-section");
  var loginForm = document.getElementById("login-form");
  var changeForm = document.getElementById("change-form");
  var loginBtn = document.getElementById("login-btn");
  var changeBtn = document.getElementById("change-btn");
  var msg = document.getElementById("msg");

  var employeeCodeInput = document.getElementById("employee_code");
  var currentPasswordInput = document.getElementById("current_password");
  var newPasswordInput = document.getElementById("new_password");
  var confirmPasswordInput = document.getElementById("confirm_password");

  function showMessage(kind, text) {
    msg.className = kind;
    msg.textContent = text;
  }

  function clearMessage() {
    msg.className = "";
    msg.textContent = "";
  }

  // Wipes every credential field currently on the page and drops the
  // in-memory token. Called after any terminal success or any error.
  function clearAllCredentials() {
    accessToken = null;
    currentPasswordInput.value = "";
    newPasswordInput.value = "";
    confirmPasswordInput.value = "";
  }

  function setBusy(button, busy) {
    button.disabled = busy;
  }

  function bilingualFromError(payload, fallbackEn, fallbackGu) {
    if (payload && payload.error && typeof payload.error.en === "string" && typeof payload.error.gu === "string") {
      return payload.error.en + " / " + payload.error.gu;
    }
    return fallbackEn + " / " + fallbackGu;
  }

  loginForm.addEventListener("submit", function (event) {
    event.preventDefault();
    clearMessage();

    var employeeCode = employeeCodeInput.value.trim();
    var currentPassword = currentPasswordInput.value;

    if (!employeeCode || !currentPassword) {
      showMessage("error", "Please fill in both fields. / કૃપા કરીને બંને ફીલ્ડ ભરો.");
      return;
    }

    setBusy(loginBtn, true);

    fetch("/functions/v1/staff-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employee_code: employeeCode, password: currentPassword }),
    })
      .then(function (res) {
        return res.json().then(function (data) {
          return { ok: res.ok, data: data };
        });
      })
      .then(function (result) {
        // This field's job is done the instant the request body above was
        // built; clear it from the DOM immediately regardless of outcome.
        currentPasswordInput.value = "";

        if (!result.ok || !result.data || !result.data.access_token) {
          showMessage("error", bilingualFromError(result.data, "Login failed.", "લોગિન નિષ્ફળ થયું."));
          clearAllCredentials();
          return;
        }

        if (result.data.must_change_password) {
          // Held only in memory, for the one follow-up request below.
          accessToken = result.data.access_token;
          loginSection.hidden = true;
          changeSection.hidden = false;
          showMessage("info", "Please set a new password to continue. / ચાલુ રાખવા માટે કૃપા કરીને નવો પાસવર્ડ સેટ કરો.");
        } else {
          // This page exists only to force a first-login password change;
          // nothing further to do once that isn't required.
          showMessage("success", "Login successful. No password change required. / લોગિન સફળ. પાસવર્ડ બદલવાની જરૂર નથી.");
          clearAllCredentials();
        }
      })
      .catch(function () {
        showMessage("error", "Network error. Please try again. / નેટવર્ક ભૂલ. કૃપા કરીને ફરી પ્રયાસ કરો.");
        clearAllCredentials();
      })
      .finally(function () {
        setBusy(loginBtn, false);
      });
  });

  changeForm.addEventListener("submit", function (event) {
    event.preventDefault();
    clearMessage();

    var newPassword = newPasswordInput.value;
    var confirmPassword = confirmPasswordInput.value;

    if (!accessToken) {
      showMessage("error", "Your session expired. Please login again. / તમારું સત્ર સમાપ્ત થયું. કૃપા કરીને ફરી લોગિન કરો.");
      clearAllCredentials();
      loginSection.hidden = false;
      changeSection.hidden = true;
      return;
    }

    if (newPassword !== confirmPassword) {
      showMessage("error", "New password and confirmation do not match. / નવો પાસવર્ડ અને પુષ્ટિ મેળ ખાતા નથી.");
      return;
    }
    if (newPassword.length < 8) {
      showMessage("error", "Password must be at least 8 characters. / પાસવર્ડ ઓછામાં ઓછો 8 અક્ષરોનો હોવો જોઈએ.");
      return;
    }

    setBusy(changeBtn, true);
    var tokenForThisRequest = accessToken;

    fetch("/functions/v1/staff-password-change", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + tokenForThisRequest,
      },
      body: JSON.stringify({ new_password: newPassword }),
    })
      .then(function (res) {
        return res.json().then(function (data) {
          return { ok: res.ok, data: data };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          showMessage("error", bilingualFromError(result.data, "Password change failed.", "પાસવર્ડ બદલવામાં નિષ્ફળ."));
          clearAllCredentials();
          return;
        }
        // Required exact success text — the only thing shown on success.
        showMessage("success", "Password updated successfully / પાસવર્ડ સફળતાપૂર્વક અપડેટ થયો.");
        changeSection.hidden = true;
        clearAllCredentials();
      })
      .catch(function () {
        showMessage("error", "Network error. Please try again. / નેટવર્ક ભૂલ. કૃપા કરીને ફરી પ્રયાસ કરો.");
        clearAllCredentials();
      })
      .finally(function () {
        setBusy(changeBtn, false);
      });
  });
})();
</script>
</body>
</html>`;

Deno.serve(function (req) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { "Cache-Control": "no-store" },
    });
  }

  // A fresh nonce on every response — never reused, never derived from
  // anything predictable, never logged.
  const nonce = crypto.randomUUID();

  const csp = [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "connect-src 'self'",
    "img-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");

  // v2: built explicitly with the Headers API (rather than a plain object
  // literal) so there is no ambiguity about what ships on the wire. Every
  // header is set individually and Content-Type is set LAST and is never
  // conditional — the browser must always receive exactly
  // `text/html; charset=utf-8`. This is the fix for the bug report ("raw
  // HTML source displayed instead of a rendered page"): a wrong or missing
  // Content-Type is what makes a browser fall back to showing markup as
  // plain text instead of parsing it.
  const headers = new Headers();
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", csp);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  // Deliberately NEVER set: Content-Disposition. Its absence is what keeps
  // the browser treating this as an ordinary inline HTML page rather than
  // a file to download/save.
  headers.set("Content-Type", "text/html; charset=utf-8");

  if (req.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  // v2: encode the body to UTF-8 bytes explicitly with TextEncoder,
  // instead of handing the Response constructor a raw JS string and
  // relying on its implicit string -> body encoding path. This removes
  // any dependency on that implicit path — the exact bytes on the wire are
  // produced here, deterministically, as UTF-8 — which is the fix for the
  // bug report's second symptom (corrupted Gujarati glyphs): a body
  // encoded as anything other than UTF-8 renders Gujarati (a multi-byte
  // script) as mojibake even when the page's own <meta charset="UTF-8">
  // and this Content-Type header both correctly say UTF-8.
  const bodyBytes = new TextEncoder().encode(PAGE_HTML(nonce));

  return new Response(bodyBytes, { status: 200, headers });
});
