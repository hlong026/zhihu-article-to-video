import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Node 25 内置的实验性 localStorage 在未指定 --localstorage-file 时是个
// 不完整实现（缺少 clear 等方法），会遮蔽 jsdom 提供的版本；检测后换成
// 内存 shim，保证测试里的 localStorage 行为完整。
if (
  typeof window !== "undefined" &&
  typeof window.localStorage?.clear !== "function"
) {
  const store = new Map<string, string>();
  const shim: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(window, "localStorage", {
    value: shim,
    configurable: true,
  });
}

// vitest runs with globals disabled, so RTL's auto-cleanup never registers;
// unmount rendered trees explicitly between tests.
afterEach(() => {
  cleanup();
});
