import type { ThemeConfig } from "antd";
import { theme } from "antd";

export const appTheme: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: "#ff3b30",
    colorInfo: "#ff3b30",
    colorBgBase: "#12141a",
    colorBgContainer: "#252833",
    colorBgElevated: "#252833",
    colorBgLayout: "#12141a",
    colorBorder: "transparent",
    colorBorderSecondary: "transparent",
    colorText: "#eceef2",
    colorTextSecondary: "#8b90a0",
    borderRadius: 8,
    fontFamily: '"Segoe UI Variable", "Segoe UI", sans-serif',
    controlHeight: 32,
    boxShadow: "none",
    boxShadowSecondary: "none",
  },
  components: {
    Button: {
      defaultShadow: "none",
      primaryShadow: "none",
      dangerShadow: "none",
      defaultBorderColor: "transparent",
    },
    Input: {
      activeBorderColor: "transparent",
      hoverBorderColor: "transparent",
      activeShadow: "0 0 0 2px rgba(255,59,48,.28)",
    },
    InputNumber: {
      activeBorderColor: "transparent",
      hoverBorderColor: "transparent",
      activeShadow: "0 0 0 2px rgba(255,59,48,.28)",
    },
    Select: {
      activeBorderColor: "transparent",
      hoverBorderColor: "transparent",
    },
    Segmented: {
      itemSelectedBg: "#252833",
      trackBg: "#12141a",
    },
    Slider: {
      trackBg: "#ff3b30",
      railBg: "#252833",
      handleColor: "#eceef2",
    },
    Switch: {
      colorPrimary: "#ff3b30",
    },
    Tabs: {
      inkBarColor: "#ff3b30",
      itemColor: "#8b90a0",
      itemSelectedColor: "#eceef2",
      itemHoverColor: "#eceef2",
      titleFontSize: 13,
    },
  },
};
