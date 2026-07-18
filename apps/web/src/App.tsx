import { Clapperboard, Files, LayoutDashboard } from "lucide-react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";

import { TaskHistoryPage } from "./pages/TaskHistoryPage";
import { WorkbenchPage } from "./pages/WorkbenchPage";
import "./styles/app.css";

const navigation = [
  { to: "/workbench", label: "工作台", icon: LayoutDashboard },
  { to: "/history", label: "任务记录", icon: Files },
];

export function App() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Clapperboard size={22} />
          </span>
          <span>知乎文章转视频</span>
        </div>
        <nav aria-label="主导航">
          {navigation.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `nav-link${isActive ? " active" : ""}`
              }
            >
              <Icon size={18} />
              {label}
            </NavLink>
          ))}
        </nav>
        <p className="sidebar-caption">一篇文章，生成一条可审核的图文视频。</p>
      </aside>
      <main className="main-content">
        <Routes>
          <Route path="/workbench" element={<WorkbenchPage />} />
          <Route path="/history" element={<TaskHistoryPage />} />
          <Route path="*" element={<Navigate to="/workbench" replace />} />
        </Routes>
      </main>
    </div>
  );
}
