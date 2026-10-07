/**
 * M11-01 entry: /app 为新 UI 根。BrowserRouter basename="/app" —— 服务端
 * 对 /app 与 /app/* 都回这份单文件 HTML,深链(如 /app/history)刷新安全。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { App } from "./App";
import { NewTaskPage } from "./pages/NewTaskPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { HistoryPage } from "./pages/HistoryPage";
import { SettingsPage } from "./pages/SettingsPage";
import { RunDetailPage } from "./pages/RunDetailPage";
import "./tokens.css";
import "./app.css";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("#root container missing — the served /app HTML does not match this build");
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter basename="/app">
      <Routes>
        <Route element={<App />}>
          <Route index element={<NewTaskPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="history" element={<HistoryPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="runs/:runId" element={<RunDetailPage />} />
          <Route path="*" element={<p className="page-subtitle">页面不存在。</p>} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>
);
