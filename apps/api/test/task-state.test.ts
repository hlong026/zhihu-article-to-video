import { describe, expect, it } from "vitest";

import {
  TaskStateError,
  canTransitionTask,
  getRetryStep,
} from "../src/task-state.js";

describe("task state machine", () => {
  it("allows the normal production pipeline but rejects skipped steps", () => {
    expect(canTransitionTask("pending", "fetching")).toBe(true);
    expect(canTransitionTask("fetching", "summarizing")).toBe(true);
    expect(canTransitionTask("summarizing", "rendering_images")).toBe(true);
    expect(canTransitionTask("rendering_images", "rendering_video")).toBe(true);
    expect(canTransitionTask("rendering_video", "completed")).toBe(true);
    expect(canTransitionTask("pending", "rendering_video")).toBe(false);
  });

  it("retries a failed task from the recorded step", () => {
    expect(
      getRetryStep({ status: "failed", currentStep: "rendering_images" }),
    ).toBe("rendering_images");
    expect(() =>
      getRetryStep({ status: "completed", currentStep: "completed" }),
    ).toThrow(TaskStateError);
  });
});
