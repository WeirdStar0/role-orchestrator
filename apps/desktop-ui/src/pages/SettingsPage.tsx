/**
 * M11-01 设置占位:the ask pins this as an honest placeholder — the full
 * settings surface (AI 模型 / Agent 团队 / 高级折叠 / 开发者模式) is
 * M11-05 scope. The transition affordance is a link to the OLD page (/),
 * which keeps carrying the profiles/role-bindings config UI.
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Card } from "../components/ui";

export function SettingsPage(): ReactNode {
  return (
    <div className="app-main-inner">
      <h1 className="page-title">设置</h1>
      <p className="page-subtitle">完整设置界面在 M11-05 到来;当前需要改配置时请用旧工作台。</p>
      <Card>
        <p>
          现在可以配置的内容(AI 模型 profiles、项目角色绑定、会话诊断)都在
          <Link className="inline-link" to="/"> 旧工作台(/)</Link> 的「配置」与「高级」页。
        </p>
        <p className="page-subtitle">
          这里之后会收纳:AI 模型(已检测/已登录/默认模型)、Agent 团队(四角色映射)、
          高级设置(Profile/超时/并发)与开发者工具(Runtime/DAG/事件)。
        </p>
      </Card>
    </div>
  );
}
