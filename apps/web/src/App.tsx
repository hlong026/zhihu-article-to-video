import {
  Clapperboard,
  Files,
  LayoutDashboard,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";

import { BatchDetailPage } from "./pages/BatchDetailPage";
import { TaskHistoryPage } from "./pages/TaskHistoryPage";
import { WorkbenchPage } from "./pages/WorkbenchPage";
import "./styles/app.css";

const navigation = [
  { to: "/workbench", label: "工作台", icon: LayoutDashboard },
  { to: "/history", label: "任务记录", icon: Files },
];

const SIDEBAR_COLLAPSED_KEY = "sidebar-collapsed";

function readInitialCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

export function App() {
  const [collapsed, setCollapsed] = useState(readInitialCollapsed);

  function toggleSidebar() {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      } catch {
        // Storage may be unavailable (private mode); the toggle still works.
      }
      return next;
    });
  }

  return (
    <div className={`app-shell${collapsed ? " sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Clapperboard size={22} />
          </span>
          <span className="brand-text">知乎文章转视频</span>
          <button
            type="button"
            className="sidebar-toggle"
            onClick={toggleSidebar}
            aria-label={collapsed ? "展开导航栏" : "折叠导航栏"}
            aria-expanded={!collapsed}
            title={collapsed ? "展开导航栏" : "折叠导航栏"}
          >
            {collapsed ? (
              <PanelLeftOpen size={17} />
            ) : (
              <PanelLeftClose size={17} />
            )}
          </button>
        </div>
        <nav aria-label="主导航">
          {navigation.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              title={label}
              aria-label={label}
              className={({ isActive }) =>
                `nav-link${isActive ? " active" : ""}`
              }
            >
              <Icon size={18} />
              <span className="nav-label">{label}</span>
            </NavLink>
          ))}
        </nav>
        <p className="sidebar-caption">一篇文章，生成一条可审核的图文视频。</p>
      </aside>
      <main className="main-content">
        <Routes>
          <Route path="/workbench" element={<WorkbenchPage />} />
          <Route path="/history" element={<TaskHistoryPage />} />
          <Route path="/history/:batchId" element={<BatchDetailPage />} />
          <Route path="*" element={<Navigate to="/workbench" replace />} />
        </Routes>
      </main>
    </div>
  );
}
