import React from "react";
import { VIEWS } from "../../lib/chatFilters";

const fmtDue = (d) => (d ? new Date(d + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : null);

// The task the composer is currently "about". Shown under the project header. Removing it returns the composer to general project talk.
// `info` comes from chat_task_refs, which only returns tasks the caller may see; without it we still show a minimal, clearable reference.
export function TaskRefCard({ taskId, info, onOpenTask, onClear, canClear = true }) {
  if (!taskId) return null;
  return (
    <div className="chat-taskref" role="region" aria-label="Task context">
      <div className="chat-taskref-main">
        <div className="chat-taskref-title">
          <span className="fx-tag gold">Task</span>{" "}
          {info ? <><b>{info.task_number}</b> — {info.title}</> : <b>Task reference</b>}
        </div>
        {info && (
          <div className="chat-taskref-tags">
            <span className="fx-tag">{info.status}</span>
            {info.priority && <span className="fx-tag">{info.priority}</span>}
            {info.due_date && <span className="fx-tag">Due {fmtDue(info.due_date)}</span>}
            {info.is_bridge ? <span className="fx-tag gold">🌉 {info.from_department} → {info.owning_department}</span> : info.owning_department && <span className="fx-tag">{info.owning_department}</span>}
            {info.primary_assignee && <span className="fx-tag">👤 {info.primary_assignee}</span>}
            {info.second_assignee && <span className="fx-tag">👤 {info.second_assignee}</span>}
          </div>
        )}
      </div>
      <div className="chat-taskref-actions">
        <button type="button" className="btn btn-outline" onClick={() => onOpenTask(taskId)}>Open Task</button>
        {canClear && <button type="button" className="btn btn-outline" onClick={onClear} aria-label="Clear task context" title="Clear task context"><span aria-hidden="true">✕</span><span className="lbl">&nbsp;Clear</span></button>}
      </div>
    </div>
  );
}

// Small reference shown on a message that is about a task; clicking it opens that task.
export function TaskChip({ taskId, info, onOpenTask }) {
  return (
    <button type="button" className="chat-taskchip" onClick={() => onOpenTask(taskId)} title={info ? `${info.task_number} — ${info.title}` : "Open task"}>
      <span aria-hidden="true">📌</span> {info ? <><b>{info.task_number}</b> {info.title}</> : "Task"}
    </button>
  );
}

// Views of the SAME conversation (never separate conversations). "Tasks" can be narrowed to one task.
export function ProjectViewBar({ view, onView, taskId, onTask, taskOptions }) {
  return (
    <div className="chat-viewbar">
      <div className="fx-tabs chat-views mobile-tab-list" role="tablist" aria-label="Project chat views">
        {VIEWS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={view === k} className={view === k ? "active" : ""} onClick={() => onView(k)}>{label}</button>
        ))}
      </div>
      {view === "tasks" && !taskId && (
        <select className="chat-taskselect" aria-label="Filter by task" value={taskId || ""} onChange={(e) => onTask(e.target.value || null)}>
          <option value="">All tasks</option>
          {taskOptions.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      )}
    </div>
  );
}
