import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { IndicatorPage } from "@/pages/IndicatorPage";
import "@/styles.css";

document.documentElement.classList.add("bg-transparent");
document.body.classList.add("bg-transparent", "overflow-hidden");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <IndicatorPage />
  </StrictMode>,
);
