import React, { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { friendlyError } from "./lib/friendlyError";
import { Routes, Route, useNavigate, useParams, Navigate } from "react-router-dom";
import { supabase } from "./lib/supabase";
import { t } from "./lib/i18n";
import { requestNotificationPermission, showBrowserNotification, subscribeToPush } from "./lib/pushNotifications";
import { useForegroundRefresh } from "./lib/useForegroundRefresh";
import ChatNavButton from "./components/ChatNavButton.jsx";
import UpdateBanner from "./components/UpdateBanner.jsx";
import Login from "./screens/Login.jsx";
import ChangePassword from "./screens/ChangePassword.jsx";
import DeptShell from "./components/DeptShell.jsx";
import ProtectedRoute from "./components/ProtectedRoute.jsx";
import InteriorProfileGate from "./components/InteriorProfileGate.jsx";
import { useCurrentUserAccess } from "./lib/access.js";
import { DEPARTMENT_ROUTES, buildOrderedDepartments } from "./lib/departmentConfig.js";

// Route-level code splitting: every screen below used to be a static
// top-of-file import, so the very first page load pulled in Retail,
// Interior (18 modules), Reports/Analytics, User Management, Audit Log —
// every department any session might ever visit — into one JS chunk,
// whether or not that session ever opens them. Only Login/ChangePassword
// stay eager (needed before a session even exists, and small). Each
// lazy() call becomes its own chunk, fetched only the first time its route
// actually renders, then cached by the browser/module registry for the
// rest of the session — including its OTHER usage site, for the handful of
// screens (TodayTasks/AssignTask/Bridges/Notifications/UserCreation) that
// are reachable both from a dedicated route and from the legacy view
// switcher lower in this file.
const TodayTasks = lazy(() => import("./screens/TodayTasks.jsx"));
const AssignTask = lazy(() => import("./screens/AssignTask.jsx"));
// Old Job Order links (?job=ID from notifications, reports, bookmarks) land on
// the one Job Card page; the page itself enforces access through RLS.
function JobOrdersRedirect() {
  const id = new URLSearchParams(window.location.search).get("job");
  return <Navigate to={id ? `/factory-job/${id}` : "/factory/job-cards"} replace />;
}

const Bridges = lazy(() => import("./screens/Bridges.jsx"));
const Notifications = lazy(() => import("./screens/Notifications.jsx"));
const UserCreation = lazy(() => import("./screens/UserCreation.jsx"));
const ManagementDashboard = lazy(() => import("./screens/ManagementDashboard.jsx"));
const AuditLog = lazy(() => import("./screens/AuditLog.jsx"));
const AdminDepartments = lazy(() => import("./screens/AdminDepartments.jsx"));
const DepartmentDashboard = lazy(() => import("./screens/DepartmentDashboard.jsx"));
const ManagementControlTower = lazy(() => import("./screens/ManagementControlTower.jsx"));
const Reports = lazy(() => import("./screens/Reports.jsx"));
const Analytics = lazy(() => import("./screens/Analytics.jsx"));
const RetailLeads = lazy(() => import("./screens/retail/RetailLeads.jsx"));
const RetailQuotations = lazy(() => import("./screens/retail/RetailQuotations.jsx"));
const RetailOrders = lazy(() => import("./screens/retail/RetailOrders.jsx"));
const RetailDisplay = lazy(() => import("./screens/retail/RetailDisplay.jsx"));
const RetailStoreOps = lazy(() => import("./screens/retail/RetailStoreOps.jsx"));
const RetailStock = lazy(() => import("./screens/retail/RetailStock.jsx"));
const RetailStockTransfer = lazy(() => import("./screens/retail/RetailStockTransfer.jsx"));
const RetailDelivery = lazy(() => import("./screens/retail/RetailDelivery.jsx"));
const RetailComplaints = lazy(() => import("./screens/retail/RetailComplaints.jsx"));
const RetailTargets = lazy(() => import("./screens/retail/RetailTargets.jsx"));
const RetailPerformance = lazy(() => import("./screens/retail/RetailPerformance.jsx"));
const InteriorHeadDashboard = lazy(() => import("./screens/interior/InteriorHeadDashboard.jsx"));
const InteriorAttachments = lazy(() => import("./screens/interior/InteriorAttachments.jsx"));
const InteriorSiteExecution = lazy(() => import("./screens/interior/InteriorSiteExecution.jsx"));
const InteriorDailyUpdates = lazy(() => import("./screens/interior/InteriorDailyUpdates.jsx"));
const InteriorMaterials = lazy(() => import("./screens/interior/InteriorMaterials.jsx"));
const InteriorPurchaseManagement = lazy(() => import("./screens/interior/InteriorPurchaseManagement.jsx"));
const FactoryJobOrders = lazy(() => import("./screens/factory/FactoryJobOrders.jsx"));
const AiTaskAssistant = lazy(() => import("./screens/AiTaskAssistant.jsx"));
const FactoryAiIntake = lazy(() => import("./screens/factory/FactoryAiIntake.jsx"));
const FactoryInbox = lazy(() => import("./screens/factory/FactoryInbox.jsx"));
const FactoryJobCardPage = lazy(() => import("./screens/factory/FactoryJobCardPage.jsx"));
const FactoryTasks = lazy(() => import("./screens/factory/FactoryTasks.jsx"));
const ChatPage = lazy(() => import("./screens/chat/ChatPage.jsx"));
const FactoryWorkOverview = lazy(() => import("./screens/factory/FactoryWorkOverview.jsx"));
const FactoryDashboard = lazy(() => import("./screens/factory/FactoryDashboard.jsx"));
const FactoryMasterReport = lazy(() => import("./screens/factory/FactoryMasterReport.jsx"));
const FactoryWipStages = lazy(() => import("./screens/factory/FactoryWipStages.jsx"));
const FactoryInProcessQC = lazy(() => import("./screens/factory/FactoryInProcessQC.jsx"));
const FactoryFinalQC = lazy(() => import("./screens/factory/FactoryFinalQC.jsx"));
const FactoryRework = lazy(() => import("./screens/factory/FactoryRework.jsx"));
const FactoryRejection = lazy(() => import("./screens/factory/FactoryRejection.jsx"));
const FactoryProductionPlanning = lazy(() => import("./screens/factory/FactoryProductionPlanning.jsx"));
const FactoryBom = lazy(() => import("./screens/factory/FactoryBom.jsx"));
const FactoryCuttingLists = lazy(() => import("./screens/factory/FactoryCuttingLists.jsx"));
const FactoryWorkerProductivity = lazy(() => import("./screens/factory/FactoryWorkerProductivity.jsx"));
const FactoryShiftProductivity = lazy(() => import("./screens/factory/FactoryShiftProductivity.jsx"));
const FactoryWastage = lazy(() => import("./screens/factory/FactoryWastage.jsx"));
const FactoryFinishedGoods = lazy(() => import("./screens/factory/FactoryFinishedGoods.jsx"));
const FactoryPacking = lazy(() => import("./screens/factory/FactoryPacking.jsx"));
const FactoryProductTimeTracking = lazy(() => import("./screens/factory/FactoryProductTimeTracking.jsx"));
const FactoryProductCosting = lazy(() => import("./screens/factory/FactoryProductCosting.jsx"));
const FactoryRawMaterialAvailability = lazy(() => import("./screens/factory/FactoryRawMaterialAvailability.jsx"));
const FactoryMaterialIssue = lazy(() => import("./screens/factory/FactoryMaterialIssue.jsx"));
const FactoryMachineTracking = lazy(() => import("./screens/factory/FactoryMachineTracking.jsx"));
const FactoryTransfer = lazy(() => import("./screens/factory/FactoryTransfer.jsx"));
const FactoryDrawings = lazy(() => import("./screens/factory/FactoryDrawings.jsx"));
const FactoryInventoryCosting = lazy(() => import("./screens/factory/FactoryInventoryCosting.jsx"));
const InteriorTasks = lazy(() => import("./screens/interior/InteriorTasks.jsx"));
const InteriorRequests = lazy(() => import("./screens/interior/InteriorRequests.jsx"));
const InteriorTimeline = lazy(() => import("./screens/interior/InteriorTimeline.jsx"));
const InteriorProjectCreate = lazy(() => import("./screens/interior/InteriorProjectCreate.jsx"));
const InteriorClientComm = lazy(() => import("./screens/interior/InteriorClientComm.jsx"));
const InteriorPayments = lazy(() => import("./screens/interior/InteriorPayments.jsx"));
const InteriorCompletion = lazy(() => import("./screens/interior/InteriorCompletion.jsx"));
const InteriorProjectDetail = lazy(() => import("./screens/interior/InteriorProjectDetail.jsx"));
const InteriorMasterReportSelect = lazy(() => import("./screens/interior/InteriorMasterReportSelect.jsx"));
const InteriorMasterReport = lazy(() => import("./screens/interior/InteriorMasterReport.jsx"));
const InteriorWorkingDrawings = lazy(() => import("./screens/interior/InteriorWorkingDrawings.jsx"));
const InteriorDeletedFiles = lazy(() => import("./screens/interior/InteriorDeletedFiles.jsx"));

// Lightweight loading skeleton shown only while a lazy chunk is actually
// in flight (typically well under a second on a normal connection, and
// never shown again for a screen once its chunk has loaded once this
// session) — never a full blank page, never the app's own boot spinner.
function RouteLoadingSkeleton() {
  return (
    <div style={{ padding: 24 }}>
      <div className="skeleton-block" style={{ height: 90, marginBottom: 12 }} />
      <div className="skeleton-block" style={{ height: 160 }} />
    </div>
  );
}

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

// Design / Design Approval / Design Lock / Drawings / Material Selection
// were consolidated into one Working Drawings module — old bookmarked URLs
// must keep working, per the spec's explicit "old URLs must safely
// redirect" requirement, so they're never removed outright, just pointed
// at the new locked route (preserving :projectId when the old URL had one).
function RedirectToWorkingDrawings() {
  const { projectId } = useParams();
  return <Navigate to={projectId ? `/interior-projects/working-drawings/${projectId}` : "/interior-projects/working-drawings"} replace />;
}

// Purchase Coordination + Purchase Board consolidated into Purchase
// Management, whose one canonical route is /interior-projects/purchase —
// same "keep old URLs working" treatment as Working Drawings. Also used to
// retire the short-lived /interior-projects/purchase-management path back
// down to a redirect once the canonical route moved.
function RedirectToPurchaseManagement() {
  const { projectId } = useParams();
  return <Navigate to={projectId ? `/interior-projects/purchase/${projectId}` : "/interior-projects/purchase"} replace />;
}

// Deal Closure + Project Timeline used to be two separate cards/tabs/routes
// that opened the exact same InteriorTimeline screen — consolidated into
// one "Project Timeline & Deal Closure" module at /interior-projects/project-timeline.
// Neither old route ever carried a :projectId segment (InteriorTimeline
// itself has no useParams-based lock, only the lockedProjectId prop used
// from inside Project Detail), so this is a plain unconditional redirect.
function RedirectToProjectTimeline() {
  return <Navigate to="/interior-projects/project-timeline" replace />;
}

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
    setToast({ kind, message: kind === "error" ? friendlyError(message) : message });
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
    // Defensive: this effect re-runs whenever `profile` or `lang` changes
    // (a language toggle, or a role/department change reloading the
    // profile) — if a same-named channel from the previous run hasn't
    // fully detached yet, `.channel(name)` can hand back an already-
    // subscribed instance and the `.on()` calls below throw "cannot add
    // postgres_changes callbacks ... after subscribe()", crashing the
    // whole app shell (confirmed live elsewhere in this app via the
    // shared subscribeTable helper — same root cause, fixed the same way
    // here since this pair predates that helper and calls the client API
    // directly).
    const stale = supabase.getChannels().find((ch) => ch.topic === "realtime:app_unread_badge");
    if (stale) supabase.removeChannel(stale);
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

  // Live permission refresh: if this user's own role/department/active
  // status changes mid-session (e.g. a Super Admin grant, or any future
  // role/department change), reload the profile immediately so
  // isManagement/isSuperAdmin/isDeptHead and the whole access matrix update
  // without a forced logout/login — these flags come from a plain DB read
  // (loadProfile), never from JWT claims, so no fresh token is needed.
  useEffect(() => {
    if (!session?.user?.id) return undefined;
    const staleProfileChannel = supabase.getChannels().find((ch) => ch.topic === "realtime:app_own_profile_changes");
    if (staleProfileChannel) supabase.removeChannel(staleProfileChannel);
    const channel = supabase
      .channel("app_own_profile_changes")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "user_profiles", filter: `id=eq.${session.user.id}` },
        () => loadProfile(session.user.id),
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [session?.user?.id, loadProfile]);

  // Belt-and-suspenders on top of the two realtime channels above: if a
  // websocket was dropped while the tab was backgrounded/offline (phone
  // locked, brief network drop, a role change made while asleep), silently
  // catch up on both the profile and the unread count once the tab/device
  // is usable again -- never a forced logout, never a page reload. One
  // combined callback instead of two separate useForegroundRefresh calls,
  // so there's only ever one extra set of online/focus/visibilitychange
  // listeners for this, not two.
  const refreshOnForeground = useCallback(() => {
    if (session?.user?.id) loadProfile(session.user.id);
    if (session) loadUnread();
  }, [session, loadProfile, loadUnread]);
  useForegroundRefresh(session ? refreshOnForeground : undefined);

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
    if (profile.isDeptHead || profile.isManagement || profile.isSuperAdmin) {
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
    // Factory gets a dedicated, source-department-wise dashboard over real
    // inhouse_production_requests data instead of the generic
    // DepartmentDashboard shell's Department Functions grid — decided here,
    // at the route level, so DepartmentDashboard's own hooks are never
    // conditionally skipped for any department.
    const Body = code === "FACTORY" ? FactoryDashboard : DepartmentDashboard;
    return (
      <DeptShell lang={lang} items={orderedAccessibleDepartments} managementLinks={managementLinks} onBackToTasks={() => navigate("/")} onLogout={handleLogout}>
        <ProtectedRoute allowed={allowed} lang={lang}>
          {dept
            ? <Body lang={lang} profile={profile} lookups={lookups} department={dept} onOpenLegacy={openLegacyView} />
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
    <>
    <UpdateBanner lang={lang} />
    <Suspense fallback={<RouteLoadingSkeleton />}>
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
      <Route path="/ai-tasks" element={
        <DeptShell lang={lang} items={orderedAccessibleDepartments} managementLinks={managementLinks} onBackToTasks={() => navigate("/")} onLogout={handleLogout}>
          <AiTaskAssistant profile={profile} lookups={lookups} />
        </DeptShell>
      } />
      <Route path="/factory-request" element={
        <DeptShell lang={lang} items={orderedAccessibleDepartments} managementLinks={managementLinks} onBackToTasks={() => navigate("/")} onLogout={handleLogout}>
          <FactoryAiIntake lang={lang} profile={profile} lookups={lookups} />
        </DeptShell>
      } />
      <Route path="/factory-inbox" element={<Navigate to="/factory/inbox" replace />} />
      <Route path="/factory-requests" element={
        <DeptShell lang={lang} items={orderedAccessibleDepartments} managementLinks={managementLinks} onBackToTasks={() => navigate("/")} onLogout={handleLogout}>
          <FactoryInbox lang={lang} profile={profile} lookups={lookups} mode="requests" />
        </DeptShell>
      } />
      <Route path="/factory-job/:id" element={
        <DeptShell lang={lang} items={orderedAccessibleDepartments} managementLinks={managementLinks} onBackToTasks={() => navigate("/")} onLogout={handleLogout}>
          <FactoryJobCardPage lang={lang} profile={profile} lookups={lookups} />
        </DeptShell>
      } />
      <Route path="/chat" element={
        <DeptShell lang={lang} items={orderedAccessibleDepartments} managementLinks={managementLinks} onBackToTasks={() => navigate("/")} onLogout={handleLogout}>
          <ChatPage lang={lang} profile={profile} />
        </DeptShell>
      } />
      <Route path="/notifications" element={
        <DeptShell lang={lang} items={orderedAccessibleDepartments} managementLinks={managementLinks} onBackToTasks={() => navigate("/")} onLogout={handleLogout}>
          <Notifications lang={lang} showToast={showToast} />
        </DeptShell>
      } />
      <Route path="/users" element={
        <DeptShell lang={lang} items={orderedAccessibleDepartments} managementLinks={managementLinks} onBackToTasks={() => navigate("/")} onLogout={handleLogout}>
          <ProtectedRoute allowed={!!(profile.isDeptHead || profile.isManagement || profile.isSuperAdmin)} lang={lang}>
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
      <Route path="/interior-projects/design" element={<RedirectToWorkingDrawings />} />
      <Route path="/interior-projects/drawings" element={<RedirectToWorkingDrawings />} />
      <Route path="/interior-projects/design-approval" element={<RedirectToWorkingDrawings />} />
      <Route path="/interior-projects/design-lock" element={<RedirectToWorkingDrawings />} />
      <Route path="/interior-projects/site-execution" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorSiteExecution lang={lang} /></InteriorProfileGate>)} />
      <Route path="/interior-projects/daily-updates" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorDailyUpdates lang={lang} /></InteriorProfileGate>)} />
      <Route path="/interior-projects/materials" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorMaterials lang={lang} filterSource={null} /></InteriorProfileGate>)} />
      <Route path="/interior-projects/purchase" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorPurchaseManagement lang={lang} staffProfile={profile} /></InteriorProfileGate>)} />
      <Route path="/interior-projects/purchase/:projectId" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorPurchaseManagement lang={lang} staffProfile={profile} /></InteriorProfileGate>)} />
      <Route path="/interior-projects/purchase-management" element={<RedirectToPurchaseManagement />} />
      <Route path="/interior-projects/purchase-management/:projectId" element={<RedirectToPurchaseManagement />} />
      <Route path="/interior-projects/tasks" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorTasks lang={lang} /></InteriorProfileGate>)} />
      <Route path="/interior-projects/requests" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorRequests lang={lang} /></InteriorProfileGate>)} />
      <Route path="/interior-projects/project-timeline" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorTimeline lang={lang} staffProfile={profile} /></InteriorProfileGate>)} />
      <Route path="/interior-projects/timeline" element={<RedirectToProjectTimeline />} />
      <Route path="/interior-projects/deal-closure" element={<RedirectToProjectTimeline />} />
      <Route path="/interior-projects/new" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorProjectCreate lang={lang} /></InteriorProfileGate>)} />
      <Route path="/interior-projects/communication" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorClientComm lang={lang} /></InteriorProfileGate>)} />
      <Route path="/interior-projects/payments" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorPayments lang={lang} lookups={lookups} /></InteriorProfileGate>)} />
      <Route path="/interior-projects/completion" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorCompletion lang={lang} /></InteriorProfileGate>)} />
      <Route path="/interior-projects/detail/:projectId" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorProjectDetail lang={lang} staffProfile={profile} lookups={lookups} /></InteriorProfileGate>)} />
      <Route path="/interior-projects/master-report" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorMasterReportSelect lang={lang} /></InteriorProfileGate>)} />
      <Route path="/interior-projects/master-report/:projectId" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorMasterReport lang={lang} staffProfile={profile} /></InteriorProfileGate>)} />
      <Route path="/interior-projects/material-selection" element={<RedirectToWorkingDrawings />} />
      <Route path="/interior-projects/material-selection/:projectId" element={<RedirectToWorkingDrawings />} />
      <Route path="/interior-projects/working-drawings" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorWorkingDrawings lang={lang} staffProfile={profile} /></InteriorProfileGate>)} />
      <Route path="/interior-projects/working-drawings/:projectId" element={deptModulePage("INTERIOR", <InteriorProfileGate lang={lang}><InteriorWorkingDrawings lang={lang} staffProfile={profile} /></InteriorProfileGate>)} />
      <Route path="/interior-projects/deleted-files" element={deptModulePage("INTERIOR",
        <ProtectedRoute allowed={!!(profile.isManagement || profile.isSuperAdmin || profile.isDeptHead)} lang={lang}>
          <InteriorProfileGate lang={lang}><InteriorDeletedFiles lang={lang} staffProfile={profile} /></InteriorProfileGate>
        </ProtectedRoute>
      )} />
      <Route path="/b2b-b2g" element={deptPage("B2B_B2G")} />
      <Route path="/procurement" element={deptPage("PROCUREMENT")} />
      <Route path="/inventory" element={deptPage("GODOWN_INV")} />
      <Route path="/dispatch" element={deptPage("DISPATCH")} />
      <Route path="/factory" element={deptPage("FACTORY")} />
      <Route path="/factory/inbox" element={deptModulePage("FACTORY", <FactoryInbox lang={lang} profile={profile} lookups={lookups} mode="inbox" />)} />
      <Route path="/factory/job-cards" element={deptModulePage("FACTORY", <FactoryInbox lang={lang} profile={profile} lookups={lookups} mode="jobcards" />)} />
      <Route path="/factory/my-tasks" element={<Navigate to="/factory/tasks" replace />} />
      <Route path="/factory/tasks" element={deptModulePage("FACTORY", <FactoryTasks lang={lang} profile={profile} lookups={lookups} />)} />
      <Route path="/factory/overview" element={deptModulePage("FACTORY", <FactoryWorkOverview lang={lang} profile={profile} lookups={lookups} />)} />
      <Route path="/factory/completed" element={deptModulePage("FACTORY", <FactoryInbox lang={lang} profile={profile} lookups={lookups} mode="completed" />)} />
      <Route path="/factory/job-orders" element={<JobOrdersRedirect />} />
      <Route path="/factory/legacy-job-orders" element={deptModulePage("FACTORY", <FactoryJobOrders lang={lang} profile={profile} />)} />
      <Route path="/factory/wip-stages" element={deptModulePage("FACTORY", <FactoryWipStages lang={lang} profile={profile} />)} />
      <Route path="/factory/in-process-qc" element={deptModulePage("FACTORY", <FactoryInProcessQC lang={lang} profile={profile} />)} />
      <Route path="/factory/final-qc" element={deptModulePage("FACTORY", <FactoryFinalQC lang={lang} profile={profile} />)} />
      <Route path="/factory/rework" element={deptModulePage("FACTORY", <FactoryRework lang={lang} profile={profile} />)} />
      <Route path="/factory/rejection" element={deptModulePage("FACTORY", <FactoryRejection lang={lang} profile={profile} />)} />
      <Route path="/factory/production-planning" element={deptModulePage("FACTORY", <FactoryProductionPlanning lang={lang} profile={profile} />)} />
      <Route path="/factory/bom" element={deptModulePage("FACTORY", <FactoryBom lang={lang} profile={profile} />)} />
      <Route path="/factory/cutting-lists" element={deptModulePage("FACTORY", <FactoryCuttingLists lang={lang} profile={profile} />)} />
      <Route path="/factory/worker-productivity" element={deptModulePage("FACTORY", <FactoryWorkerProductivity lang={lang} profile={profile} />)} />
      <Route path="/factory/shift-productivity" element={deptModulePage("FACTORY", <FactoryShiftProductivity lang={lang} profile={profile} />)} />
      <Route path="/factory/wastage" element={deptModulePage("FACTORY", <FactoryWastage lang={lang} profile={profile} />)} />
      <Route path="/factory/finished-goods" element={deptModulePage("FACTORY", <FactoryFinishedGoods lang={lang} profile={profile} />)} />
      <Route path="/factory/packing" element={deptModulePage("FACTORY", <FactoryPacking lang={lang} profile={profile} />)} />
      <Route path="/factory/product-time-tracking" element={deptModulePage("FACTORY", <FactoryProductTimeTracking lang={lang} profile={profile} />)} />
      <Route path="/factory/product-costing" element={deptModulePage("FACTORY", <FactoryProductCosting lang={lang} profile={profile} />)} />
      <Route path="/factory/raw-material-availability" element={deptModulePage("FACTORY", <FactoryRawMaterialAvailability lang={lang} profile={profile} />)} />
      <Route path="/factory/material-issue" element={deptModulePage("FACTORY", <FactoryMaterialIssue lang={lang} profile={profile} />)} />
      <Route path="/factory/machine-tracking" element={deptModulePage("FACTORY", <FactoryMachineTracking lang={lang} profile={profile} />)} />
      <Route path="/factory/transfer" element={deptModulePage("FACTORY", <FactoryTransfer lang={lang} profile={profile} />)} />
      <Route path="/factory/drawings" element={deptModulePage("FACTORY", <FactoryDrawings lang={lang} profile={profile} />)} />
      <Route path="/factory/inventory-costing" element={deptModulePage("FACTORY", <FactoryInventoryCosting lang={lang} profile={profile} />)} />
      <Route path="/factory/master-report" element={deptModulePage("FACTORY", <FactoryMasterReport lang={lang} profile={profile} />)} />
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
          <ChatNavButton />
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
        {view === "users" && (profile.isDeptHead || profile.isManagement || profile.isSuperAdmin) && (
          <UserCreation lang={lang} profile={profile} lookups={lookups} showToast={showToast} />
        )}
        {view === "dashboard" && (profile.isDeptHead || profile.isManagement || profile.isSuperAdmin) && (
          <ManagementDashboard lang={lang} lookups={lookups} showToast={showToast} />
        )}
        {view === "auditlog" && (profile.isDeptHead || profile.isManagement || profile.isSuperAdmin) && (
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
    </Suspense>
    </>
  );
}
