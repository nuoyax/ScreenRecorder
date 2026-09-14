import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConfigProvider } from "antd";
import { MainPage } from "@/pages/MainPage";
import { appTheme } from "@/theme";
import "@/styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConfigProvider theme={appTheme}>
      <MainPage />
    </ConfigProvider>
  </StrictMode>,
);
