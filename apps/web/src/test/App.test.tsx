import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import { App } from "../App";

beforeEach(() => {
  window.localStorage.clear();
});

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

  it("renders import, batch statistics, task actions, and keyword editing", async () => {
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
      screen.getByRole("button", { name: "保存口令并重渲尾页" }),
    ).toBeVisible();
  });

  it("shows the derived tail note preview for the keyword", async () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    const keywordInput = await screen.findByRole("textbox", {
      name: "文章口令",
    });
    expect(keywordInput).toHaveValue("AI 产品好用");
    expect(
      screen.getByText("来知乎搜索🔍AI 产品好用可以看到全文", {
        selector: ".tail-note-preview",
      }),
    ).toBeVisible();
  });
});

describe("sidebar", () => {
  it("collapses and expands the navigation, persisting the choice", () => {
    const { container } = render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    const shell = container.querySelector(".app-shell");
    expect(shell).not.toHaveClass("sidebar-collapsed");

    fireEvent.click(screen.getByRole("button", { name: "折叠导航栏" }));
    expect(shell).toHaveClass("sidebar-collapsed");
    expect(window.localStorage.getItem("sidebar-collapsed")).toBe("true");
    // Labels are hidden while icons keep their accessible names.
    expect(screen.getByRole("link", { name: "工作台" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开导航栏" }));
    expect(shell).not.toHaveClass("sidebar-collapsed");
    expect(window.localStorage.getItem("sidebar-collapsed")).toBe("false");
  });
});
