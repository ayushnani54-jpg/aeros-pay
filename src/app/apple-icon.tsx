import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#ffffff",
        }}
      >
        <svg width="150" height="150" viewBox="0 0 100 100">
          <path d="M50 16 L16 86" stroke="#0a0a0a" strokeWidth="12" strokeLinecap="round" fill="none" />
          <path d="M50 16 L84 86" stroke="#0a0a0a" strokeWidth="12" strokeLinecap="round" fill="none" />
          <path d="M29 60 L71 60" stroke="#0a0a0a" strokeWidth="12" strokeLinecap="round" fill="none" />
          <path d="M9 65 L91 54" stroke="#ffffff" strokeWidth="5" strokeLinecap="round" fill="none" />
          <path d="M9 79 L91 68" stroke="#ffffff" strokeWidth="5" strokeLinecap="round" fill="none" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
