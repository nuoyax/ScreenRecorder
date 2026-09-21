import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RegionSelectPage } from "@/pages/RegionSelectPage";
import "@/styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RegionSelectPage />
  </StrictMode>,
);
