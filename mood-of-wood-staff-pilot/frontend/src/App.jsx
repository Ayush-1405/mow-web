import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabase";
import { t } from "./lib/i18n";
import { requestNotificationPermission, showBrowserNotification } from "./lib/pushNotifications";
import Login from "./screens/Login.jsx";
import ChangePassword from "./screens/ChangePassword.jsx";
import TodayTasks from "./screens/TodayTasks.jsx";
import AssignTask from "./screens/AssignTask.jsx";
import Bridges from "./screens/Bridges.jsx";
import Notifications from "./screens/Notifications.jsx";
import UserCreation from "./screens/UserCreation.jsx";
import ManagementDashboard from "./screens/ManagementDashboard.jsx";
import AuditLog from "./screens/AuditLog.jsx";

// Nav/screen visibility only — never the real authorization boundary. The
// actual gate for every action is server-side: staff-create-user's own
// role_creation_rules lookup, and RLS/RPC scoping (staff_is_dept_head(),
// staff_dept_in_hod_scope(), etc.) for tasks/Bridge/dashboard data. This set
// exists only to decide which tabs render, keyed strictly off the exact
// role code from user_profiles.roles.code — never off a display label.
// "management" sees every tab via the separate isManagement flag below
// (OR'd in everywhere this set is consulted), so it is deliberately not
// listed here.
const ELEVATED_ROLES = new Set(["dept_head", "accounts_head", "cfo"]);

export default function App() {
  const [booting, setBooting] = useState(true);
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [lookups, setLookups] = useState(null);
  const [view, setView] = useState("tasks");
  const [lang, setLang] = useState("en");
  const [toast, setToast] = useState(null);
  const [unreadCount, setUnreadCount] = useState(0);
  // Persistent bilingual error state for a failed profile/lookup/bootstrap
  // request. Set only to one of the two fixed messages below — never to a
  // raw Supabase/Postgres error string — so this never leaks backend detail.
  // While set, it takes over rendering (see the bootError branch below)
  // instead of leaving the user on an indefinite spinner.
  const [bootError, setBootError] = useState(null);

  const showToast = useCallback((kind, message) => {
    setToast({ kind, message });
    window.clearTimeout(showToast._t);
    showToast._t = window.setTimeout(() => setToast(null), 4500);
  }, []);

  // Fixed bilingual messages only — never a raw Supabase/Postgres error
  // string — so the boot-error screen can never leak backend detail.
  const BOOT_ERROR_PROFILE = {
    en: "Could not load your profile. Please try again.",
    gu: "તમારી પ્રોફાઇલ લોડ કરી શકાઈ નથી. કૃપા કરીને ફરી પ્રયાસ કરો.",
  };
  const BOOT_ERROR_LOOKUPS = {
    en: "Could not load app data. Please try again.",
    gu: "એપ ડેટા લોડ કરી શકાયો નથી. કૃપા કરીને ફરી પ્રયાસ કરો.",
  };

  const loadLookups = useCallback(async () => {
    const [dep, rol, tt, pr, pt, st] = await Promise.all([
      supabase.from("departments").select("*").eq("is_active", true),
      supabase.from("roles").select("*").eq("is_active", true),
      supabase.from("task_types").select("*").eq("is_active", true),
      supabase.from("priority_master").select("*").eq("is_active", true).order("sort_order"),
      supabase.from("proof_types").select("*").eq("is_active", true),
      supabase.from("status_master").select("*").eq("is_active", true).order("sort_order"),
    ]);
    if (dep.error || rol.error || tt.error || pr.error || pt.error || st.error) {
      setBootError(BOOT_ERROR_LOOKUPS);
      return false;
    }
    const departments = dep.data || [];
    const roles = rol.data || [];
    const taskTypes = tt.data || [];
    const priorities = pr.data || [];
    const proofTypes = pt.data || [];
    const statuses = st.data || [];
    setLookups({
      departments,
      roles,
      taskTypes,
      priorities,
      proofTypes,
      statuses,
      departmentById: Object.fromEntries(departments.map((d) => [d.id, d])),
      roleById: Object.fromEntries(roles.map((r) => [r.id, r])),
      statusById: Object.fromEntries(statuses.map((s) => [s.id, s])),
    });
    return true;
  }, []);

  const loadProfile = useCallback(async (userId) => {
    const { data, error } = await supabase
      .from("user_profiles")
      .select("*, roles(code, name_en, name_gu)")
      .eq("id", userId)
      .maybeSingle();
    if (error || !data) {
      setBootError(BOOT_ERROR_PROFILE);
      return null;
    }
    const roleCode = data.roles?.code || "";
    setLang(data.language_pref === "gu" ? "gu" : "en");
    const p = {
      ...data,
      roleCode,
      isManagement: roleCode === "management",
      isDeptHead: ELEVATED_ROLES.has(roleCode),
    };
    setProfile(p);
    return p;
  }, [showToast]);

  const loadUnread = useCallback(async () => {
    const { count } = await supabase.from("notifications").select("id", { count: "exact", head: true }).eq("is_read", false);
    setUnreadCount(count || 0);
  }, []);

  useEffect(() => {
    let active = true;
    async function bootstrap() {
      const { data } = await supabase.auth.getSession();
      if (!active) return;
      if (data?.session) {
        setSession(data.session);
        const p = await loadProfile(data.session.user.id);
        if (p) {
          setMustChangePassword(!!p.must_change_password);
          const ok = await loadLookups();
          if (ok) await loadUnread();
        }
      }
      setBooting(false);
    }
    bootstrap();
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      if (!newSession) {
        setProfile(null);
        setLookups(null);
      }
    });
    return () => {
      active = false;
      sub?.subscription?.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live unread-count badge + real-time push: notifications_select_own
  // already scopes every row to this signed-in user, so any insert/update
  // reaching this subscriber is necessarily one of theirs. INSERT also
  // triggers a browser-native notification (see lib/pushNotifications) —
  // every open device/tab signed in as this user holds its own independent
  // subscription, so all of them pop it at once. UPDATE (e.g. marking read
  // elsewhere) only refreshes the count, never re-shows a popup.
  useEffect(() => {
    if (!session || !profile) return undefined;
    requestNotificationPermission();
    const channel = supabase
      .channel("app_unread_badge")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications" }, (payload) => {
        loadUnread();
        const row = payload.new;
        if (row) {
          showBrowserNotification({
            id: row.id,
            title: "Mood of Wood",
            body: lang === "gu" ? row.title_gu : row.title_en,
          });
        }
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "notifications" }, () => loadUnread())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [session, profile, loadUnread, lang]);

  async function handleLoggedIn({ mustChangePassword: mcp }) {
    setBootError(null);
    const { data } = await supabase.auth.getSession();
    setSession(data.session);
    const p = await loadProfile(data.session.user.id);
    setMustChangePassword(mcp || !!p?.must_change_password);
    if (p && !(mcp || p.must_change_password)) {
      const ok = await loadLookups();
      if (ok) await loadUnread();
    }
  }

  async function handlePasswordChanged() {
    setMustChangePassword(false);
    const p = await loadProfile(session.user.id);
    if (p) {
      const ok = await loadLookups();
      if (ok) await loadUnread();
    }
  }

  // Retry handler for the persistent boot-error screen below. Re-runs
  // exactly the same profile -> lookups -> unread-count sequence used at
  // startup, for the current session, so a transient failure (e.g. a
  // dropped connection) can be recovered from without forcing a re-login.
  async function retryBoot() {
    if (!session) return;
    setBootError(null);
    const p = await loadProfile(session.user.id);
    if (p) {
      setMustChangePassword(!!p.must_change_password);
      if (!p.must_change_password) {
        const ok = await loadLookups();
        if (ok) await loadUnread();
      }
    }
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    setSession(null);
    setProfile(null);
    setLookups(null);
    setMustChangePassword(false);
    setBootError(null);
    setView("tasks");
  }

  const navItems = useMemo(() => {
    if (!profile) return [];
    const items = [
      { key: "tasks", icon: "📋", label: t("todaysTasks", lang) },
      { key: "assign", icon: "📝", label: t("assignTask", lang) },
      { key: "bridges", icon: "🌉", label: t("bridges", lang) },
      { key: "notifications", icon: "🔔", label: t("notifications", lang) },
    ];
    if (profile.isDeptHead || profile.isManagement) {
      items.push({ key: "users", icon: "👥", label: t("userCreation", lang) });
      items.push({ key: "dashboard", icon: "📊", label: t("dashboard", lang) });
      items.push({ key: "auditlog", icon: "🗂️", label: t("auditLog", lang) });
    }
    return items;
  }, [profile, lang]);

  if (booting) {
    return <div className="center-page"><div className="spinner" style={{ border: "2.5px solid #ebe3d6", borderTopColor: "#7a4a24" }} /></div>;
  }

  if (!session) {
    return <Login lang={lang} onLoggedIn={handleLoggedIn} />;
  }

  // Persistent bilingual error screen. Takes priority over the password
  // screen and the spinner below so a failed profile/lookup/bootstrap
  // request never leaves the user stuck indefinitely. Only ever shows a
  // fixed message (BOOT_ERROR_PROFILE / BOOT_ERROR_LOOKUPS) — never a raw
  // backend error — and offers Retry (re-runs the same load sequence) or
  // Logout (returns to the login screen).
  if (bootError) {
    return (
      <div className="center-page">
        <div className="auth-card">
          <div className="logo-title">
            <h1>Mood of Wood</h1>
          </div>
          <div className="msg error">{bootError.en} / {bootError.gu}</div>
          <div className="btn-row" style={{ marginTop: 12 }}>
            <button className="btn btn-primary" onClick={retryBoot}>
              Retry / ફરી પ્રયાસ કરો
            </button>
            <button className="btn btn-outline" onClick={handleLogout}>
              {t("logout", lang)}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (mustChangePassword) {
    return <ChangePassword lang={lang} onDone={handlePasswordChanged} />;
  }

  if (!profile || !lookups) {
    return <div className="center-page"><div className="spinner" style={{ border: "2.5px solid #ebe3d6", borderTopColor: "#7a4a24" }} /></div>;
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>Mood of Wood</h1>
          <div className="sub">{profile.full_name} · {profile.roles?.[lang === "gu" ? "name_gu" : "name_en"] || profile.roleCode}</div>
        </div>
        <div className="header-actions">
          <button className="icon-btn" onClick={() => setLang(lang === "en" ? "gu" : "en")}>{lang === "en" ? "ગુજરાતી" : "EN"}</button>
          <button
            className="icon-btn bell"
            onClick={() => { setView("notifications"); loadUnread(); }}
            aria-label={t("notifications", lang)}
          >
            🔔{unreadCount > 0 && <span className="dot">{unreadCount > 9 ? "9+" : unreadCount}</span>}
          </button>
          <button className="icon-btn" onClick={handleLogout}>{t("logout", lang)}</button>
        </div>
      </header>

      <main className="main-area">
        {toast && <div className={`msg ${toast.kind}`}>{toast.message}</div>}
        {view === "tasks" && <TodayTasks lang={lang} profile={profile} lookups={lookups} showToast={showToast} />}
        {view === "assign" && <AssignTask lang={lang} profile={profile} lookups={lookups} showToast={showToast} />}
        {view === "bridges" && <Bridges lang={lang} profile={profile} lookups={lookups} showToast={showToast} />}
        {view === "notifications" && <Notifications lang={lang} showToast={showToast} />}
        {view === "users" && (profile.isDeptHead || profile.isManagement) && (
          <UserCreation lang={lang} profile={profile} lookups={lookups} showToast={showToast} />
        )}
        {view === "dashboard" && (profile.isDeptHead || profile.isManagement) && (
          <ManagementDashboard lang={lang} lookups={lookups} showToast={showToast} />
        )}
        {view === "auditlog" && (profile.isDeptHead || profile.isManagement) && (
          <AuditLog lang={lang} lookups={lookups} showToast={showToast} />
        )}
      </main>

      <nav className="bottom-nav">
        {navItems.map((item) => (
          <button
            key={item.key}
            className={view === item.key ? "active" : ""}
            onClick={() => setView(item.key)}
          >
            <span className="nav-icon" aria-hidden="true">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
