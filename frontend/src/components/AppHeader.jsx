import React from "react";
import ActionMenu from "./ActionMenu.jsx";

// THE header of the app (main shell and department shell share it). One row, always.
//   * the only element that applies the top safe-area inset (it is the top-most element of both shells)
//   * >= 768px: every action is a labelled button
//   * <  768px: `primary` stays as icon buttons, `secondary` items marked keepOnMobile stay as icon-only buttons, the rest move into a
//     "more" menu -- pure CSS (.hdr-*), no user-agent or JS width checks. Every icon-only control keeps its aria-label + title.
export default function AppHeader({ title = "Mood of Wood", subtitle = null, leading = null, primary = null, secondary = [], moreLabel = "More" }) {
  const overflow = secondary.filter((a) => !a.keepOnMobile);
  return (
    <header className="app-header">
      {leading}
      <div className="app-header-title">
        <h1>{title}</h1>
        {subtitle && <div className="sub">{subtitle}</div>}
      </div>
      <div className="header-actions">
        {primary}
        {secondary.map((a) => (
          <button key={a.key} type="button" className={`icon-btn hdr-btn${a.keepOnMobile ? "" : " hdr-hide-mobile"}`} onClick={a.onClick} aria-label={a.label} title={a.label}>
            {a.icon && <span aria-hidden="true">{a.icon}</span>}
            {!a.iconOnly && <span className="hdr-label">{a.label}</span>}
          </button>
        ))}
        {overflow.length > 0 && (
          <span className="hdr-only-mobile">
            <ActionMenu
              buttonClassName="icon-btn hdr-more" ariaLabel={moreLabel} label="⋯" hideCaret
              items={overflow.map((a) => ({ key: a.key, label: a.icon ? `${a.icon}  ${a.label}` : a.label, onClick: a.onClick }))}
            />
          </span>
        )}
      </div>
    </header>
  );
}
