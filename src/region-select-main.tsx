import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RegionSelectPage } from "@/pages/RegionSelectPage";
import "@/styles.css";

// The window is transparent so the desktop shows through the dimmed still; without
// this the default body background would paint it solid again.
document.documentElement.classList.add("bg-transparent");
document.body.classList.add("bg-transparent", "overflow-hidden");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RegionSelectPage />
  </StrictMode>,
);
