import { describe, it } from "node:test";
import assert from "node:assert";
import { InMemoryRunner, ShellRunner } from "../runners.js";
import type { WorkflowNode } from "../schema.js";
import type { ExecutionContext } from "../types.js";

function makeNode(overrides: Record<string, unknown> = {}): WorkflowNode {
  return {
    id: "test",
    deterministic: true,
    depends_on: [],
    trigger_rule: "all_succeeded",
    max_retries: 0,
    ...overrides,
  } as WorkflowNode;
}

const mockCtx = {
  args: {},
  env: {},
  secrets: [],
  readState: () => undefined,
  log: () => {},
} as ExecutionContext;

describe("InMemoryRunner", () => {
  it("executes registered handler", async () => {
    const runner = new InMemoryRunner();
    runner.register("test", async (_node, _ctx) => ({ success: true, output: "registered" }));

    const result = await runner.execute(makeNode({ id: "test" }), mockCtx);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.output, "registered");
  });

  it("falls through to exec mock", async () => {
    const runner = new InMemoryRunner();
    const result = await runner.execute(makeNode({ id: "other", exec: { command: "echo hi" } }), mockCtx);
    assert.strictEqual(result.success, true);
    assert.ok(String(result.output).includes("mock-exec"));
  });

  it("falls through to invoke_skill mock", async () => {
    const runner = new InMemoryRunner();
    const result = await runner.execute(makeNode({ id: "other", invoke_skill: { name: "my-skill" } }), mockCtx);
    assert.strictEqual(result.success, true);
    assert.ok(String(result.output).includes("mock-skill"));
  });

  it("falls through to gate mock", async () => {
    const runner = new InMemoryRunner();
    const result = await runner.execute(makeNode({ id: "other", gate: { type: "approval", on_timeout: "abort" } }), mockCtx);
    assert.strictEqual(result.success, true);
    assert.ok(String(result.output).includes("mock-gate"));
  });

  it("returns error for unknown node type", async () => {
    const runner = new InMemoryRunner();
    const result = await runner.execute(makeNode({ id: "other" }), mockCtx);
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("No handler"));
  });
});

describe("ShellRunner", () => {
  it("runs a simple exec command", async () => {
    const runner = new ShellRunner();
    const result = await runner.execute(makeNode({ id: "test", exec: { command: "echo hello" } }), mockCtx);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.output, "hello");
  });

  it("reports exec failure", async () => {
    const runner = new ShellRunner();
    const result = await runner.execute(makeNode({ id: "test", exec: { command: "exit 1" } }), mockCtx);
    assert.strictEqual(result.success, false);
    assert.ok(result.error);
  });

  it("rejects invoke_skill", async () => {
    const runner = new ShellRunner();
    const result = await runner.execute(makeNode({ id: "test", invoke_skill: { name: "x" } }), mockCtx);
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("does not support invoke_skill"));
  });

  it("rejects gate", async () => {
    const runner = new ShellRunner();
    const result = await runner.execute(makeNode({ id: "test", gate: { type: "approval", on_timeout: "abort" } }), mockCtx);
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("does not support gate"));
  });
});
