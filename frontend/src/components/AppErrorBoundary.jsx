import React from "react";
import { reportProblem } from "../lib/errorReporter";

// A screen that crashes shows a calm message with Reload instead of a blank page, and the crash is recorded (v3_16).
export default class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error, info) {
    reportProblem("crash", error?.message || String(error), `${error?.stack || ""}\n${info?.componentStack || ""}`);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div style={{ padding: 24, maxWidth: 520, margin: "60px auto", textAlign: "center", fontFamily: "Inter, Arial, sans-serif" }}>
        <h2 style={{ margin: "0 0 8px" }}>Something went wrong on this screen</h2>
        <p style={{ margin: "0 0 4px" }}>It has been reported automatically. Please reload and try again.</p>
        <p style={{ margin: "0 0 16px", color: "#666" }}>આ સ્ક્રીનમાં ભૂલ આવી. તેની જાણ થઈ ગઈ છે — ફરી લોડ કરો.</p>
        <button type="button" className="btn btn-primary" style={{ width: "auto" }} onClick={() => window.location.reload()}>Reload / ફરી લોડ કરો</button>
      </div>
    );
  }
}
