import { t } from "./i18n";

export const FILTER_FIELDS = [
  { key: "project", labelKey: "tfProjectField", allKey: "allInteriorProjectsLabel", optionsKey: "projects" },
  { key: "status", labelKey: "tfStatusField", allKey: "allStatusesLabel", optionsKey: "statuses" },
  { key: "priority", labelKey: "tfPriorityField", allKey: "allPrioritiesLabel", optionsKey: "priorities" },
  { key: "department", labelKey: "tfDepartmentField", allKey: "allDepartmentsLabel", optionsKey: "departments" },
  { key: "primary", labelKey: "tfPrimaryField", allKey: "primaryAssigneeFilterLabel", optionsKey: "assignees" },
  { key: "second", labelKey: "tfSecondField", allKey: "secondAssigneeFilterLabel", optionsKey: "assignees" },
];

// Only the filters that are actually set. Values are looked up in `options`
// so the chip shows a name, never an id.
export function activeFilterList(values, options, lang) {
  const list = [];
  FILTER_FIELDS.forEach((f) => {
    const v = values[f.key];
    if (!v) return;
    const opt = options[f.optionsKey].find((o) => o.value === v);
    list.push({ key: f.key, label: t(f.labelKey, lang), value: opt ? opt.label : "…" });
  });
  if (values.filterType && values.filterType !== "due") {
    list.push({ key: "filterType", label: t("tfFilterTypeField", lang), value: t("assignedDateFilterTypeLabel", lang) });
  }
  return list;
}

