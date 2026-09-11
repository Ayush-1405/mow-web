import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Routes, Route, useNavigate } from "react-router-dom";
import { supabase } from "./lib/supabase";
import { t } from "./lib/i18n";
import { requestNotificationPermission, showBrowserNotification, subscribeToPush } from "./lib/pushNotifications";
import Login from "./screens/Login.jsx";
import ChangePassword from "./screens/ChangePassword.jsx";
import TodayTasks from "./screens/TodayTasks.jsx";
import AssignTask from "./screens/AssignTask.jsx";
import Bridges from "./screens/Bridges.jsx";
import Notifications from "./screens/Notifications.jsx";
import UserCreation from "./screens/UserCreation.jsx";
import ManagementDashboard from "./screens/ManagementDashboard.jsx";
import AuditLog from "./screens/AuditLog.jsx";
import AdminDepartments from "./screens/AdminDepartments.jsx";
import DepartmentDashboard from "./screens/DepartmentDashboard.jsx";
import ManagementControlTower from "./screens/ManagementControlTower.jsx";
import Reports from "./screens/Reports.jsx";
import Analytics from "./screens/Analytics.jsx";
import RetailLeads from "./screens/retail/RetailLeads.jsx";
import RetailQuotations from "./screens/retail/RetailQuotations.jsx";
import RetailOrders from "./screens/retail/RetailOrders.jsx";
import RetailDisplay from "./screens/retail/RetailDisplay.jsx";
import RetailStoreOps from "./screens/retail/RetailStoreOps.jsx";
import RetailStock from "./screens/retail/RetailStock.jsx";
import RetailStockTransfer from "./screens/retail/RetailStockTransfer.jsx";
import RetailDelivery from "./screens/retail/RetailDelivery.jsx";
import RetailComplaints from "./screens/retail/RetailComplaints.jsx";
import RetailTargets from "./screens/retail/RetailTargets.jsx";
import RetailPerformance from "./screens/retail/RetailPerformance.jsx";
import InteriorHeadDashboard from "./screens/interior/InteriorHeadDashboard.jsx";
import InteriorAttachments from "./screens/interior/InteriorAttachments.jsx";
import InteriorDesignApproval from "./screens/interior/InteriorDesignApproval.jsx";
import InteriorDesignLock from "./screens/interior/InteriorDesignLock.jsx";
import InteriorSiteExecution from "./screens/interior/InteriorSiteExecution.jsx";
import InteriorDailyUpdates from "./screens/interior/InteriorDailyUpdates.jsx";
import InteriorMaterials from "./screens/interior/InteriorMaterials.jsx";
import InteriorPurchaseBoard from "./screens/interior/InteriorPurchaseBoard.jsx";
import InteriorTasks from "./screens/interior/InteriorTasks.jsx";
import InteriorRequests from "./screens/interior/InteriorRequests.jsx";
import InteriorTimeline from "./screens/interior/InteriorTimeline.jsx";
import InteriorProjectCreate from "./screens/interior/InteriorProjectCreate.jsx";
import InteriorClientComm from "./screens/interior/InteriorClientComm.jsx";
import InteriorPayments from "./screens/interior/InteriorPayments.jsx";
import InteriorCompletion from "./screens/interior/InteriorCompletion.jsx";
import InteriorProjectDetail from "./screens/interior/InteriorProjectDetail.jsx";
import DeptShell from "./components/DeptShell.jsx";
import ProtectedRoute from "./components/ProtectedRoute.jsx";
import InteriorProfileGate from "./components/InteriorProfileGate.jsx";
import { useCurrentUserAccess } from "./lib/access.js";
import { DEPARTMENT_ROUTES, buildOrderedDepartments } from "./lib/departmentConfig.js";

// Nav/screen visibility only — never the real authorization boundary. The
// actual gate for every action is server-side: staff-create-user's own
// role_creation_rules lookup, and RLS/RPC scoping (staff_is_dept_head(),
// staff_dept_in_hod_scope(), etc.) for tasks/Bridge/dashboard data. This set
// exists only to decide which tabs render, keyed strictly off the exact
// role code from user_profiles.roles.code — never off a display label.
// "management" sees every tab via the separate isManagement flag below
// (OR'd in everywhere this set is consulted), so it is deliberately not
// listed here.
const ELEVATED_ROLES = new Set(["dept_head", "accounts_head", "cfo", "sysadmin"]);

export default function App() {
  const navigate = useNavigate();
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
      isSuperAdmin: roleCode === "sysadmin",
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
    requestNotificationPermission().then((perm) => {
      if (perm === "granted") subscribeToPush(supabase);
    });
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

  // Department / Management Control Tower access — computed from the SAME
  // profile + lookups.departments already loaded above (no extra network
  // call). See lib/access.js: this only decides what the UI offers: the
  // real boundary is Postgres RLS on staff_tasks/bridges/user_profiles.
  const access = useCurrentUserAccess(profile, lookups?.departments);
  const orderedAccessibleDepartments = useMemo(
    () => buildOrderedDepartments(access.accessibleDepartments),
    [access.accessibleDepartments],
  );
  // "Departments" header button target: the user's own department page if
  // they have one, Management Control Tower for Management, otherwise the
  // first department they're authorized for (if any).
  // Reports / Analytics links — Management-only, computed the same
  // no-extra-network-call, no-flash way as everything else in `access`
  // (see lib/access.js). Rendered by Sidebar right after Management
  // Control Tower on every department page, not just the Tower itself.
  const managementLinks = useMemo(() => {
    if (!access.canAccessManagement()) return [];
    return [
      { route: "/reports", icon: "📄", name_en: t("reportsNav", "en"), name_gu: t("reportsNav", "gu") },
      { route: "/analytics", icon: "📈", name_en: t("analyticsNav", "en"), name_gu: t("analyticsNav", "gu") },
    ];
  }, [access]);
  const myDepartmentRoute = useMemo(() => {
    if (!profile) return null;
    if (profile.isManagement) return DEPARTMENT_ROUTES.CONTROL_TOWER;
    const own = orderedAccessibleDepartments.find((d) => d.id === profile.department_id);
    return own?.route || orderedAccessibleDepartments[0]?.route || null;
  }, [profile, orderedAccessibleDepartments]);

  // Quick Actions on a department dashboard hand off to the existing
  // Today's Tasks / Assign Task / Bridges tabs rather than duplicating that
  // already-working functionality.
  const openLegacyView = useCallback((viewKey) => {
    setView(viewKey);
    navigate("/");
  }, [navigate]);

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
    if (profile.isSuperAdmin) {
      items.push({ key: "admindepartments", icon: "🏛️", label: t("adminDepartmentsTitle", lang) });
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

  // Department dashboard route element: looks up the department row by its
  // stable `code` and gates it with ProtectedRoute using the SAME
  // access.canAccessDepartment() check the sidebar itself was filtered
  // with — a user can never see a link they aren't also allowed to follow
  // directly by URL. profile/lookups are already guaranteed loaded at this
  // point (the two guards above), so there is no loading state to handle.
  function deptPage(code) {
    const dept = lookups.departments.find((d) => d.code === code);
    const allowed = dept ? access.canAccessDepartment(dept) : false;
    return (
      <DeptShell lang={lang} items={orderedAccessibleDepartments} managementLinks={managementLinks} onBackToTasks={() => navigate("/")} onLogout={handleLogout}>
        <ProtectedRoute allowed={allowed} lang={lang}>
          {dept
            ? <DepartmentDashboard lang={lang} profile={profile} department={dept} onOpenLegacy={openLegacyView} />
            : <div className="msg error">Department not configured in the database yet.</div>}
        </ProtectedRoute>
      </DeptShell>
    );
  }

  // Same wrapping as deptPage() (DeptShell + ProtectedRoute, gated on the
  // SAME access.canAccessDepartment() check for that department code) but
  // renders a real module screen instead of the generic DepartmentDashboard
  // — used for every Retail/Interior route the function-card registry
  // (lib/moduleRegistry.js) points at.
  function deptModulePage(code, element) {
    const dept = lookups.departments.find((d) => d.code === code);
    const allowed = dept ? access.canAccessDepartment(dept) : false;
    return (
      <DeptShell lang={lang} items={orderedAccessibleDepartments} managementLinks={managementLinks} onBackToTasks={() => navigate("/")} onLogout={handleLogout}>
        <ProtectedRoute allowed={allowed} lang={lang}>
          {dept ? element : <div className="msg error">Department not configured in the database yet.</div>}
        </ProtectedRoute>
      </DeptShell>
    );
  }

  const controlTowerAllowed = access.canAccessManagement();

  return (
    <Routes>
      <Route path="/management" element={
        <DeptShell lang={lang} items={orderedAccessibleDepartments} managementLinks={managementLinks} onBackToTasks={() => navigate("/")} onLogout={handleLogout}>
          <ProtectedRoute allowed={controlTowerAllowed} lang={lang}>
            <ManagementControlTower lang={lang} lookups={lookups} departments={lookups.departments} />
          </ProtectedRoute>
        </DeptShell>
      } />
      <Route path="/reports" element={
        <DeptShell lang={lang} items={orderedAccessibleDepartments} managementLinks={managementLinks} onBackToTasks={() => navigate("/")} onLogout={handleLogout}>
          <ProtectedRoute allowed={controlTowerAllowed} lang={lang}>
            <Reports lang={lang} lookups={lookups} departments={lookups.departments} />
          </ProtectedRoute>
        </DeptShell>
      } />
      <Route path="/analytics" element={
        <DeptShell lang={lang} items={orderedAccessibleDepartments} managementLinks={managementLinks} onBackToTasks={() => navigate("/")} onLogout={handleLogout}>
          <ProtectedRoute allowed={controlTowerAllowed} lang={lang}>
            <Analytics lang={lang} lookups={lookups} departments={lookups.departments} />
          </ProtectedRoute>
        </DeptShell>
      } />
      {/* Router-addressable versions of the same TodayTasks/Bridges screens
          already reachable from "/" via the legacy view toggle — added so
          the Control Tower KPI tiles and a notification click can link
          straight to a task/bridge instead of only being reachable through
          the bottom-nav. staff_tasks/bridges RLS already scopes what each
          caller sees (Management sees everything, a regular employee sees
          only their own), so this needs no extra allow-check beyond being
          logged in — same as the bottom-nav's own "Today's Tasks"/"Bridge"
          buttons, which are open to every role today. */}
      <Route path="/tasks" element={
        <DeptShell lang={lang} items={orderedAccessibleDepartments} managementLinks={managementLinks} onBackToTasks={() => navigate("/")} onLogout={handleLogout}>
          <TodayTasks lang={lang} profile={profile} lookups={lookups} showToast={showToast} />
        </DeptShell>
      } />
      <Route path="/bridges" element={
        <DeptShell lang={lang} items={orderedAccessibleDepartments} managementLinks={managementLinks} onBackToTasks={() => navigate("/")} onLogout={handleLogout}>
          <Bridges lang={lang} profile={profile} lookups={lookups} showToast={showToast} />
        </DeptShell>
      } />
      <Route path="/users" element={
        <DeptShell lang={lang} items={orderedAccessibleDepartments} managementLinks={managementLinks} onBackToTasks={() => navigate("/")} onLogout={handleLogout}>
          <ProtectedRoute allowed={!!(profile.isDeptHead || profile.isManagement)} lang={lang}>
            <UserCreation lang={lang} profile={profile} lookups={lookups} showToast={showToast} />
          </ProtectedRoute>
        </DeptShell>
      } />
      <Route path="/retail" element={deptPage("RETAIL")} />
      <Route path="/retail/leads" element={deptModulePage("RETAIL", <RetailLeads lang={lang} profile={profile} lookups={lookups} />)} />
      <Route path="/retail/quotations" element={deptModulePage("RETAIL", <RetailQuotations lang={lang} profile={profile} lookups={lookups} />)} />
      <Route path="/retail/orders" element={deptModulePage("RETAIL", <RetailOrders lang={lang} profile={profile} lookups={lookups} />)} />
      <Route path="/retail/display" element={deptModulePage("RETAIL", <RetailDisplay lang={lang} profile={profile} lookups={lookups} />)} />
      <Route path="/retail/store-ops" element={deptModulePage("RETAIL", <RetailStoreOps lang={lang} profile={profile} lookups={lookups} />)} />
      <Route path="/retail/stock" element={deptModulePage("RETAIL", <RetailStock lang={lang} />)} />
      <Route path="/retail/stock-transfer" element={deptModulePage("RETAIL", <RetailStockTransfer lang={lang} profile={profile} lookups={lookups} />)} />
      <Route path="/retail/delivery" element={deptModulePage("RETAIL", <RetailDelivery lang={lang} profile={profile} lookups={lookups} />)} />
      <Route path="/retail/complaints" element={deptModulePage("RETAIL", <RetailComplaints lang={lang} profile={profile} lookups={lookups} />)} />
      <Route path="/retail/targets" element={deptModulePage("RETAIL", <RetailTargets lang={lang} profile={profile} lookups={lookups} />)} />
      <Route path="/retail/performance" element={deptModulePage("RETAIL", <RetailPerformance lang={lang} profile={profile} lookups={lookups} />)} />
      <Route path="/franchise-dealer" element={deptPage("FRANCHISE")} />
      <Route path="/marketing" element={deptPage("MARKETING")} />
      <Route path="/ecommerce" element={deptPage("ECOMMERCE")} />
      <Route path="/interior-projects" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorHeadDashboard lang={lang} staffProfile={profile} /></InteriorProfileGate>)} />
      <Route path="/interior-projects/quotation" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorAttachments lang={lang} stage="Quotation" titleKey="interiorAttachmentsTitle" /></InteriorProfileGate>)} />
      <Route path="/interior-projects/design" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorAttachments lang={lang} stage="Design" titleKey="interiorAttachmentsTitle" /></InteriorProfileGate>)} />
      <Route path="/interior-projects/drawings" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorAttachments lang={lang} stage="Drawings" titleKey="interiorAttachmentsTitle" /></InteriorProfileGate>)} />
      <Route path="/interior-projects/design-approval" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorDesignApproval lang={lang} /></InteriorProfileGate>)} />
      <Route path="/interior-projects/design-lock" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorDesignLock lang={lang} /></InteriorProfileGate>)} />
      <Route path="/interior-projects/site-execution" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorSiteExecution lang={lang} /></InteriorProfileGate>)} />
      <Route path="/interior-projects/daily-updates" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorDailyUpdates lang={lang} /></InteriorProfileGate>)} />
      <Route path="/interior-projects/materials" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorMaterials lang={lang} filterSource={null} /></InteriorProfileGate>)} />
      <Route path="/interior-projects/purchase" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorPurchaseBoard lang={lang} /></InteriorProfileGate>)} />
      <Route path="/interior-projects/tasks" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorTasks lang={lang} /></InteriorProfileGate>)} />
      <Route path="/interior-projects/requests" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorRequests lang={lang} /></InteriorProfileGate>)} />
      <Route path="/interior-projects/timeline" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorTimeline lang={lang} staffProfile={profile} /></InteriorProfileGate>)} />
      <Route path="/interior-projects/new" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorProjectCreate lang={lang} /></InteriorProfileGate>)} />
      <Route path="/interior-projects/communication" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorClientComm lang={lang} /></InteriorProfileGate>)} />
      <Route path="/interior-projects/payments" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorPayments lang={lang} lookups={lookups} /></InteriorProfileGate>)} />
      <Route path="/interior-projects/completion" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorCompletion lang={lang} /></InteriorProfileGate>)} />
      <Route path="/interior-projects/detail/:projectId" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorProjectDetail lang={lang} staffProfile={profile} lookups={lookups} /></InteriorProfileGate>)} />
      <Route path="/b2b-b2g" element={deptPage("B2B_B2G")} />
      <Route path="/procurement" element={deptPage("PROCUREMENT")} />
      <Route path="/inventory" element={deptPage("GODOWN_INV")} />
      <Route path="/dispatch" element={deptPage("DISPATCH")} />
      <Route path="/factory" element={deptPage("FACTORY")} />
      <Route path="/product-rnd" element={deptPage("RND")} />
      <Route path="/hr-admin" element={deptPage("HR_ADMIN")} />
      <Route path="/accounts-finance" element={deptPage("ACCOUNTS")} />
      <Route path="/customer-service" element={deptPage("CUST_SERVICE")} />
      <Route path="*" element={
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>Mood of Wood</h1>
          <div className="sub">{profile.full_name} · {profile.roles?.[lang === "gu" ? "name_gu" : "name_en"] || profile.roleCode}</div>
        </div>
        <div className="header-actions">
          <button className="icon-btn" onClick={() => window.location.reload()} aria-label={t("refresh", lang)} title={t("refresh", lang)}>🔄</button>
          <button className="icon-btn" onClick={() => setLang(lang === "en" ? "gu" : "en")}>{lang === "en" ? "ગુજરાતી" : "EN"}</button>
          {myDepartmentRoute && (
            <button className="icon-btn" onClick={() => navigate(myDepartmentRoute)}>
              🗼 {t("departmentsNav", lang)}
            </button>
          )}
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
        {view === "admindepartments" && profile.isSuperAdmin && (
          <AdminDepartments lang={lang} lookups={lookups} showToast={showToast} onChanged={loadLookups} />
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
      } />
    </Routes>
  );
}
