/**
 * M11-01 app shell: 侧栏(220-260px 冻结带,固定 240px)四入口(新任务/
 * 项目/历史/设置)+ 主区(最大阅读宽 ~900px)。/app 为新 UI 根(basename
 * 由 main.tsx 的 BrowserRouter 提供);旧页 / 与其全部行为本批不动。
 */
import type { ReactNode } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { Folder, History, Settings, SquarePen } from "lucide-react";

const NAV_ITEMS: readonly { readonly to: string; readonly label: string; readonly end: boolean }[] = [
  { to: "/", label: "新任务", end: true },
  { to: "/projects", label: "项目", end: false },
  { to: "/history", label: "历史", end: false },
  { to: "/settings", label: "设置", end: false }
];

function navIcon(label: string): ReactNode {
  switch (label) {
    case "新任务":
      return <SquarePen size={18} />;
    case "项目":
      return <Folder size={18} />;
    case "历史":
      return <History size={18} />;
    default:
      return <Settings size={18} />;
  }
}

export function App(): ReactNode {
  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="app-sidebar-brand">role-orchestrator</div>
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => (isActive ? "sidebar-link active" : "sidebar-link")}
          >
            {navIcon(item.label)}
            {item.label}
          </NavLink>
        ))}
      </aside>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
