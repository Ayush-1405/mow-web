import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "../styles.css";
import "../factory.css";
import "../chat.css";
import ChatPage from "../screens/chat/ChatPage.jsx";
import ChatNavButton from "../components/ChatNavButton.jsx";
import { activeChannelCount, cfg, db, deliverForeign, stats } from "../lib/supabase.js";

const q = new URLSearchParams(location.search);
const scenario = q.get("scenario") || "idle";
const strict = q.get("strict") !== "0";
cfg.idempotentMarkRead = q.get("server") !== "old";
cfg.replicaFull = q.get("replica") !== "0";

const profile = { id: "u-me", full_name: "Me Tester", roleCode: "employee", isManagement: false, isSuperAdmin: false };

function Harness() {
  return (
    <div>
      <ChatNavButton />
      <ChatPage lang="en" profile={profile} />
    </div>
  );
}

const app = <BrowserRouter><Routes><Route path="*" element={<Harness />} /></Routes></BrowserRouter>;
createRoot(document.getElementById("root")).render(strict ? <React.StrictMode>{app}</React.StrictMode> : app);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (o) => JSON.parse(JSON.stringify(o));
const snap = () => ({ rpc: clone(stats.rpc), query: clone(stats.query), total: stats.total, events: stats.events, channels: activeChannelCount(), created: stats.channelsCreated, removed: stats.channelsRemoved, storage: stats.storage, capped: stats.capped });
function diff(a, b) {
  const d = { total: b.total - a.total, events: b.events - a.events, rpc: {}, query: {}, channelsCreated: b.created - a.created, channelsRemoved: b.removed - a.removed, activeChannels: b.channels };
  ["rpc", "query"].forEach((k) => Object.keys(b[k]).forEach((n) => { const v = b[k][n] - (a[k][n] || 0); if (v) d[k][n] = v; }));
  return d;
}
function setValue(el, v) {
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
const msgEls = () => [...document.querySelectorAll(".chat-msg")];

async function run() {
  const rep = { scenario, strict, server: cfg.idempotentMarkRead ? "idempotent" : "old", replicaFull: cfg.replicaFull };
  try {
    await sleep(3000);
    if (scenario === "idle") {
      const a = snap();
      await sleep(300000);
      const b = snap();
      rep.idleFiveMinutes = diff(a, b);
      rep.startup = a;
    } else if (scenario === "idleopen") {
      const a = snap();
      await sleep(300000);
      const b = snap();
      rep.idleFiveMinutes = diff(a, b);
      rep.startup = a;
      rep.selectedRestored = !!document.querySelector(".chat-topbar b");
      rep.title = document.querySelector(".chat-topbar b")?.textContent;
    } else if (scenario === "full") {
      const rows = () => [...document.querySelectorAll(".chat-row")];
      rep.initialRows = rows().length;
      rep.badgeBefore = document.querySelector(".chat-badge")?.textContent || null;
      // open the conversation that has one unread message
      const before = snap();
      rows()[1].click();
      await sleep(1500);
      rep.openOne = diff(before, snap());
      rep.url1 = location.search;
      rep.badgeAfterOpen = document.querySelector(".chat-badge")?.textContent || null;
      const open = new URLSearchParams(location.search).get("c");
      rep.messagesShown = msgEls().length;
      // type a long unsent message, then another user's message arrives
      const ta = document.getElementById("chat-composer");
      ta.focus();
      setValue(ta, "this is a long unsent draft that must survive incoming messages");
      await sleep(100);
      const b2 = snap();
      const n0 = msgEls().length;
      deliverForeign(open, "hello from the other user");
      await sleep(1500);
      rep.incoming = diff(b2, snap());
      rep.incomingAddedMessages = msgEls().length - n0;
      const ta2 = document.getElementById("chat-composer");
      rep.draftKept = ta2 && ta2.value === "this is a long unsent draft that must survive incoming messages";
      rep.focusKept = document.activeElement === ta2;
      rep.sameTextareaNode = ta === ta2;
      // send it
      const b3 = snap();
      const n1 = msgEls().length;
      document.querySelector(".chat-send").click();
      await sleep(1500);
      rep.send = diff(b3, snap());
      rep.sendAddedMessages = msgEls().length - n1;
      rep.textareaClearedAfterSend = document.getElementById("chat-composer").value === "";
      const ids = msgEls().map((e) => e.dataset.mid).filter(Boolean);
      rep.duplicateMessageIds = ids.length - new Set(ids).size;
      // walk through ten conversations
      const b4 = snap();
      const chans = [];
      for (let i = 0; i < 10; i += 1) {
        rows()[i].click();
        await sleep(700);
        chans.push(activeChannelCount());
      }
      rep.tenConversations = diff(b4, snap());
      rep.activeChannelsPerStep = chans;
      // back to the first conversation
      rows()[1].click();
      await sleep(800);
      const ids2 = msgEls().map((e) => e.dataset.mid).filter(Boolean);
      rep.returnDuplicateIds = ids2.length - new Set(ids2).size;
      rep.returnMessageCount = msgEls().length;
      // unknown / unauthorized ids
      const b5 = snap();
      history.pushState({}, "", "?c=c9999999-0000-4000-8000-000000000999");
      window.dispatchEvent(new PopStateEvent("popstate"));
      await sleep(1500);
      rep.unauthorized = { ...diff(b5, snap()), text: document.querySelector(".chat-conv-pane")?.textContent?.slice(0, 120) };
      const b6 = snap();
      history.pushState({}, "", "?c=not-a-uuid");
      window.dispatchEvent(new PopStateEvent("popstate"));
      await sleep(1500);
      rep.invalidUrlAfter = location.search;
      rep.invalidId = diff(b6, snap());
      // 30s idle after all that
      const b7 = snap();
      await sleep(30000);
      rep.idleAfterActivity30s = diff(b7, snap());
    }
    rep.final = snap();
  } catch (e) {
    rep.error = String(e && e.message);
    rep.final = snap();
  }
  document.getElementById("report").textContent = "REPORT" + JSON.stringify(rep) + "ENDREPORT";
}
run();
window.__db = db;
