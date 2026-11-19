import React from "react";

// The "mood of wood" wordmark as on the company's printed stationery: "mood" over "wood" with a small "of" and ®, and
// "INDIA PRIVATE LIMITED" underneath. Drawn as SVG text in the current colour (red on the Interior form, navy on the
// Retail form), so it stays sharp on any printer and in the PDF. Replace with the official vector file when available.
export default function MowLogo({ className, title = "Mood of Wood India Private Limited" }) {
  return (
    <svg className={className} viewBox="0 0 132 70" role="img" aria-label={title} xmlns="http://www.w3.org/2000/svg">
      <title>{title}</title>
      <g fill="currentColor" fontFamily="Poppins, 'Arial Rounded MT Bold', Arial, sans-serif" fontWeight="800">
        <text x="1" y="27" fontSize="31" letterSpacing="-1.2">mood</text>
        <text x="92" y="11" fontSize="7" fontWeight="600">®</text>
        <text x="95" y="38" fontSize="9.5" fontWeight="700">of</text>
        <text x="1" y="55" fontSize="31" letterSpacing="-1.2">wood</text>
        <rect x="2" y="59.2" width="96" height="0.7" />
        <text x="3" y="66.8" fontSize="6.1" fontWeight="600" letterSpacing="0.55">INDIA PRIVATE LIMITED</text>
      </g>
    </svg>
  );
}
