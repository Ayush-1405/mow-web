import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

// Overflow ("More") menu for secondary card actions. Disclosure pattern: a button that owns a role="menu" list; closes on outside
// click, Escape and after choosing; arrow keys move between items; every target is >= 44px tall. It only re-arranges existing
// actions -- each item's own handler still enforces exactly the same permission checks as before.
//
// Placement is measured when it opens so it can never run off the screen: it aligns to whichever edge of the button has room
// (right edge first, else left edge), and flips ABOVE the button when there is not enough room below (bottom tab bar included).
const EDGE = 8;
const BOTTOM_BAR = 72;

export default function ActionMenu({ label = "More", items = [] }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState({ h: "right", v: "down" });
  const rootRef = useRef(null);
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const menuId = useId();

  useLayoutEffect(() => {
    if (!open || !menuRef.current || !btnRef.current) return;
    const b = btnRef.current.getBoundingClientRect();
    const w = menuRef.current.offsetWidth;
    const h = menuRef.current.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const horizontal = b.right - w >= EDGE ? "right" : b.left + w <= vw - EDGE ? "left" : "left";
    const vertical = b.bottom + 4 + h > vh - BOTTOM_BAR && b.top - 4 - h >= EDGE ? "up" : "down";
    setPlace((cur) => (cur.h === horizontal && cur.v === vertical ? cur : { h: horizontal, v: vertical }));
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") { setOpen(false); btnRef.current?.focus(); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    rootRef.current?.querySelector('[role="menuitem"]:not([disabled])')?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!items.length) return null;

  function onMenuKey(e) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const els = [...rootRef.current.querySelectorAll('[role="menuitem"]:not([disabled])')];
    const i = els.indexOf(document.activeElement);
    els[(i + (e.key === "ArrowDown" ? 1 : els.length - 1)) % els.length]?.focus();
  }

  return (
    <span className="action-menu" ref={rootRef}>
      <button ref={btnRef} type="button" className="btn btn-outline action-menu-btn" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen((v) => !v)}>
        {label}<span className="action-menu-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div ref={menuRef} id={menuId} role="menu" className={`action-menu-list ${place.h} ${place.v}`} onKeyDown={onMenuKey}>
          {items.map((it) => (
            <button key={it.key} type="button" role="menuitem" className={`action-menu-item${it.danger ? " danger" : ""}`} disabled={it.disabled}
              onClick={() => { setOpen(false); it.onClick?.(); }}>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
