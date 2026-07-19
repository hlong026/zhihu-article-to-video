import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// vitest runs with globals disabled, so RTL's auto-cleanup never registers;
// unmount rendered trees explicitly between tests.
afterEach(() => {
  cleanup();
});
