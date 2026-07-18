import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { App } from "../App";

describe("workbench", () => {
  it("only exposes the workbench and task history navigation", async () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("button", { name: /导入 Excel/ }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "工作台" })).toBeVisible();
    expect(screen.getByRole("link", { name: "任务记录" })).toBeVisible();
    expect(
      screen.queryByText(/用户管理|设置|模板中心|算力/),
    ).not.toBeInTheDocument();
  });

  it("renders import, batch statistics, task actions, and tail note editing", async () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("button", { name: /导入 Excel/ }),
    ).toBeVisible();
    expect(
      screen.getByText("待处理", { selector: ".metric-card span" }),
    ).toBeVisible();
    expect(
      screen.getByText("已生成", { selector: ".metric-card span" }),
    ).toBeVisible();
    expect(
      screen.getByText("需人工确认", { selector: ".metric-card span" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "下载视频" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "保存并重新渲染尾页" }),
    ).toBeVisible();
  });
});
