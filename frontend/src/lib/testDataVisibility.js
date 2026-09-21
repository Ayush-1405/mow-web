import { useCallback, useEffect, useState } from "react";

// Shared "Include Test/UAT Data" visibility control for Factory screens.
//
// Every listAllFactory*/listFactoryMaterials/listFactoryMachines/listProjects
// function in interiorApi.js defaults to `includeTestData = false`, which is
// correct for normal end users (they must never see UAT/test records mixed
// into real operational data). But that same default means the seeded
// TEST-BATCH-FACTORY-UAT-2026-001 dataset is invisible to everyone unless
// something explicitly asks for it — this hook is that "something".
//
// Only Management/Super Admin/Factory dept_head can see or use the toggle;
// everyone else always gets includeTestData=false with no UI for it at all.

const STORAGE_KEY = "mow_factory_include_test_data";

export function canToggleTestData(profile) {
  if (!profile) return false;
  const p = profile.permissions;
  return !!p && (p.hasGlobalOversight || p.isDepartmentHead);
}

export function useIncludeTestData(profile) {
  const allowed = canToggleTestData(profile);
  const [includeTestData, setIncludeTestDataState] = useState(() => {
    if (!allowed) return false;
    try {
      return window.localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (!allowed && includeTestData) setIncludeTestDataState(false);
  }, [allowed, includeTestData]);

  const setIncludeTestData = useCallback((value) => {
    setIncludeTestDataState(value);
    try {
      window.localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
    } catch {
      // localStorage unavailable (private mode etc.) — in-memory state still works for this session.
    }
  }, []);

  return { includeTestData: allowed && includeTestData, canToggle: allowed, setIncludeTestData };
}
