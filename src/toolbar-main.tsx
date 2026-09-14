import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConfigProvider } from "antd";
import { ToolbarPage } from "@/pages/ToolbarPage";
import { appTheme } from "@/theme";
import "@/styles.css";

document.documentElement.classList.add("bg-transparent");
document.body.classList.add("bg-transparent", "overflow-hidden");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConfigProvider theme={appTheme}>
      <ToolbarPage />
    </ConfigProvider>
  </StrictMode>,
);
