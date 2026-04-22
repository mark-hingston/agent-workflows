import { describe, it } from "node:test";
import assert from "node:assert";
import { WorkflowEngine } from "../engine.js";
import { InMemoryRunner } from "../runners.js";
import type { WorkflowDefinition } from "../schema.js";

function makeBase(overrides: Record<string, unknown> = {}): WorkflowDefinition {
  return {
    name: "test",
    require_deterministic: false,
    on: { invoke: { args: [] } },
    nodes: [],
    ...overrides,
  };
}

describe("WorkflowEngine", () => {
  it("executes a linear workflow end-to-end", async () => {
    const runner = new InMemoryRunner();
    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      nodes: [
        { id: "a", deterministic: true, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo a" }, output: { bind: "a.out" } },
        { id: "b", deterministic: true, depends_on: ["a"], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo b" }, output: { bind: "b.out" } },
      ],
    };

    const result = await engine.execute(workflow, {});
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.executedNodes, ["a", "b"]);
  });

  it("skips a node when when: false and cascades the skip", async () => {
    const runner = new InMemoryRunner();
    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      nodes: [
        { id: "a", deterministic: true, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo a" } },
        { id: "b", deterministic: true, depends_on: ["a"], trigger_rule: "all_succeeded", max_retries: 0, when: "false", exec: { command: "echo b" } },
        { id: "c", deterministic: true, depends_on: ["b"], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo c" } },
      ],
    };

    const result = await engine.execute(workflow, {});
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.executedNodes, ["a"]);
  });

  it("routes on_failure to the designated node", async () => {
    const runner = new InMemoryRunner();
    runner.register("fail", async () => ({ success: false, error: "boom" }));

    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      nodes: [
        { id: "fail", deterministic: false, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "exit 1" }, on_failure: "recover", output: { bind: "fail.out" } },
        { id: "recover", deterministic: true, depends_on: ["fail"], trigger_rule: "always", max_retries: 0, exec: { command: "echo recovered" }, output: { bind: "recover.out" } },
      ],
    };

    const result = await engine.execute(workflow, {});
    assert.strictEqual(result.success, true);
    assert.ok(result.executedNodes.includes("recover"));
  });

  it("fails when on_failure target is missing", async () => {
    const runner = new InMemoryRunner();
    runner.register("fail", async () => ({ success: false, error: "boom" }));

    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      nodes: [
        { id: "fail", deterministic: false, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "exit 1" }, on_failure: "missing" },
      ],
    };

    const result = await engine.execute(workflow, {});
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.failedNode, "fail");
    assert.ok(result.error?.includes("not found"));
  });

  it("times out a long-running node", async () => {
    const runner = new InMemoryRunner();
    runner.register("slow", async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return { success: true, output: "done" };
    });

    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      nodes: [
        { id: "slow", deterministic: false, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, timeout_seconds: 1, exec: { command: "sleep 5" } },
      ],
    };

    const result = await engine.execute(workflow, {});
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.failedNode, "slow");
    assert.ok(result.error?.includes("Timeout") || result.error?.includes("timeout"));
  });

  it("retries on failure then succeeds", async () => {
    const runner = new InMemoryRunner();
    let calls = 0;
    runner.register("flaky", async () => {
      calls++;
      if (calls < 2) return { success: false, error: "retry me" };
      return { success: true, output: "ok" };
    });

    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      nodes: [
        { id: "flaky", deterministic: false, depends_on: [], trigger_rule: "all_succeeded", max_retries: 2, exec: { command: "echo test" }, output: { bind: "flaky.out" } },
      ],
    };

    const result = await engine.execute(workflow, {});
    assert.strictEqual(result.success, true);
    assert.strictEqual(calls, 2);
    assert.ok(result.executedNodes.includes("flaky"));
  });

  it("fails after exhausting retries", async () => {
    const runner = new InMemoryRunner();
    runner.register("always-fail", async () => ({ success: false, error: "nope" }));

    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      nodes: [
        { id: "always-fail", deterministic: false, depends_on: [], trigger_rule: "all_succeeded", max_retries: 1, exec: { command: "echo test" } },
      ],
    };

    const result = await engine.execute(workflow, {});
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.failedNode, "always-fail");
  });

  it("trigger_rule: always runs even when deps fail", async () => {
    const runner = new InMemoryRunner();
    runner.register("fail", async () => ({ success: false, error: "boom" }));
    runner.register("cleanup", async () => ({ success: true, output: "cleaned" }));

    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      nodes: [
        { id: "fail", deterministic: false, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "exit 1" } },
        { id: "cleanup", deterministic: true, depends_on: ["fail"], trigger_rule: "always", max_retries: 0, exec: { command: "echo cleanup" } },
      ],
    };

    const result = await engine.execute(workflow, {});
    assert.ok(result.executedNodes.includes("cleanup"));
  });

  it("trigger_rule: any_completed runs when any dep finishes", async () => {
    const runner = new InMemoryRunner();
    runner.register("a", async () => ({ success: true, output: "a-done" }));
    runner.register("b", async () => ({ success: false, error: "b-fail" }));
    runner.register("notify", async () => ({ success: true, output: "notified" }));

    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      nodes: [
        { id: "a", deterministic: false, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo a" } },
        { id: "b", deterministic: false, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo b" } },
        { id: "notify", deterministic: true, depends_on: ["a", "b"], trigger_rule: "any_completed", max_retries: 0, exec: { command: "echo notify" } },
      ],
    };

    const result = await engine.execute(workflow, {});
    assert.ok(result.executedNodes.includes("a"));
    assert.strictEqual(result.failedNode, "b");
    assert.ok(result.executedNodes.includes("notify"));
  });

  it("trigger_rule: any_completed waits until at least one dep is done", async () => {
    const runner = new InMemoryRunner();
    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      nodes: [
        { id: "a", deterministic: true, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo a" } },
        { id: "b", deterministic: true, depends_on: ["a"], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo b" } },
        { id: "c", deterministic: true, depends_on: ["a", "b"], trigger_rule: "any_completed", max_retries: 0, exec: { command: "echo c" } },
      ],
    };

    const result = await engine.execute(workflow, {});
    assert.strictEqual(result.success, true);
    assert.ok(result.executedNodes.includes("c"));
  });

  it("resolves $node_id.output in when conditions", async () => {
    const runner = new InMemoryRunner();
    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      nodes: [
        { id: "a", deterministic: true, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo a" }, output: { bind: "a.out" } },
        { id: "b", deterministic: true, depends_on: ["a"], trigger_rule: "all_succeeded", max_retries: 0, when: "$a.output", exec: { command: "echo b" } },
      ],
    };

    const result = await engine.execute(workflow, {});
    assert.strictEqual(result.success, true);
    assert.ok(result.executedNodes.includes("b"));
  });

  it("skips downstream when $node_id.output is falsy", async () => {
    const runner = new InMemoryRunner();
    runner.register("a", async () => ({ success: true, output: null }));

    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      nodes: [
        { id: "a", deterministic: false, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo a" } },
        { id: "b", deterministic: true, depends_on: ["a"], trigger_rule: "all_succeeded", max_retries: 0, when: "$a.output", exec: { command: "echo b" } },
      ],
    };

    const result = await engine.execute(workflow, {});
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.executedNodes, ["a"]);
  });

  it("resolves $node_id.output in invoke_skill.with", async () => {
    const runner = new InMemoryRunner();
    let receivedInput: unknown;
    runner.register("consume", async (node, ctx) => {
      receivedInput = ctx.readState("input_from_prev");
      return { success: true, output: "consumed" };
    });
    runner.register("produce", async () => ({ success: true, output: "valuable-data" }));

    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      nodes: [
        { id: "produce", deterministic: false, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo produce" }, output: { bind: "produce.out" } },
        { id: "consume", deterministic: false, depends_on: ["produce"], trigger_rule: "all_succeeded", max_retries: 0, invoke_skill: { name: "process", with: { input_from_prev: "$produce.output" } } },
      ],
    };

    const result = await engine.execute(workflow, {});
    assert.strictEqual(result.success, true);
    assert.strictEqual(receivedInput, "valuable-data");
  });

  it("passes literal values in invoke_skill.with unchanged", async () => {
    const runner = new InMemoryRunner();
    let receivedInput: unknown;
    runner.register("a", async (node, ctx) => {
      receivedInput = ctx.readState("literal");
      return { success: true, output: "done" };
    });

    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      nodes: [
        { id: "a", deterministic: false, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, invoke_skill: { name: "skill", with: { literal: "hello" } } },
      ],
    };

    const result = await engine.execute(workflow, {});
    assert.strictEqual(result.success, true);
    assert.strictEqual(receivedInput, "hello");
  });

  it("throws on unsupported when expression", async () => {
    const runner = new InMemoryRunner();
    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      nodes: [
        { id: "a", deterministic: true, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, when: "some unknown expr", exec: { command: "echo a" } },
      ],
    };

    await assert.rejects(async () => {
      await engine.execute(workflow, {});
    }, /Unsupported expression/);
  });

  it("binds output to state via output.bind", async () => {
    const runner = new InMemoryRunner();
    runner.register("a", async () => ({ success: true, output: "hello" }));

    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      nodes: [
        { id: "a", deterministic: false, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo hello" }, output: { bind: "my_key" } },
      ],
    };

    const result = await engine.execute(workflow, {});
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.finalState["my_key"], "hello");
  });

  it("propagates args into state", async () => {
    const runner = new InMemoryRunner();
    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      nodes: [
        { id: "a", deterministic: true, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo test" } },
      ],
    };

    const result = await engine.execute(workflow, { branch: "main" });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.finalState["branch"], "main");
  });

  it("handles runner throwing an exception", async () => {
    const runner = new InMemoryRunner();
    runner.register("explode", async () => { throw new Error("kaboom"); });

    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      nodes: [
        { id: "explode", deterministic: false, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo test" } },
      ],
    };

    const result = await engine.execute(workflow, {});
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.failedNode, "explode");
    assert.ok(result.error?.includes("kaboom"));
  });

  it("executes independent branches in topological order", async () => {
    const runner = new InMemoryRunner();
    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      nodes: [
        { id: "x", deterministic: true, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo x" } },
        { id: "y", deterministic: true, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo y" } },
        { id: "z", deterministic: true, depends_on: ["x", "y"], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo z" } },
      ],
    };

    const result = await engine.execute(workflow, {});
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.executedNodes, ["x", "y", "z"]);
  });

  it("skips non-deterministic nodes when require_deterministic is true", async () => {
    const runner = new InMemoryRunner();
    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      require_deterministic: true,
      nodes: [
        { id: "a", deterministic: true, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo a" } },
        { id: "b", deterministic: false, depends_on: ["a"], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo b" } },
      ],
    };

    const result = await engine.execute(workflow, {});
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.executedNodes, ["a"]);
    assert.ok(result.skippedNodes.includes("b"));
  });

  it("executes non-deterministic nodes when require_deterministic is false", async () => {
    const runner = new InMemoryRunner();
    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      require_deterministic: false,
      nodes: [
        { id: "a", deterministic: true, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo a" } },
        { id: "b", deterministic: false, depends_on: ["a"], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo b" } },
      ],
    };

    const result = await engine.execute(workflow, {});
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.executedNodes, ["a", "b"]);
  });

  it("executes independent nodes concurrently (with real time overlap)", async () => {
    const runner = new InMemoryRunner();
    const startTimes: Record<string, number> = {};
    const endTimes: Record<string, number> = {};

    runner.register("a", async () => {
      startTimes["a"] = Date.now();
      await new Promise((r) => setTimeout(r, 100));
      endTimes["a"] = Date.now();
      return { success: true, output: "a" };
    });

    runner.register("b", async () => {
      startTimes["b"] = Date.now();
      await new Promise((r) => setTimeout(r, 100));
      endTimes["b"] = Date.now();
      return { success: true, output: "b" };
    });

    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      nodes: [
        { id: "a", deterministic: false, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo a" } },
        { id: "b", deterministic: false, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo b" } },
      ],
    };

    const result = await engine.execute(workflow, {});
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.executedNodes, ["a", "b"]);

    // If they ran truly concurrently, the later of the two start times should be before the earlier of the two end times.
    const latestStart = Math.max(startTimes["a"], startTimes["b"]);
    const earliestEnd = Math.min(endTimes["a"], endTimes["b"]);
    assert.ok(
      latestStart < earliestEnd,
      `Nodes did not overlap: latestStart=${latestStart}, earliestEnd=${earliestEnd}`
    );
  });

  it("evaluates when with && operator", async () => {
    const runner = new InMemoryRunner();
    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      nodes: [
        { id: "a", deterministic: true, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo a" }, output: { bind: "a" } },
        { id: "b", deterministic: true, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo b" }, output: { bind: "b" } },
        { id: "c", deterministic: true, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, when: "$a && $b", exec: { command: "echo c" } },
      ],
    };

    const result = await engine.execute(workflow, { a: true, b: true });
    assert.strictEqual(result.success, true);
    assert.ok(result.executedNodes.includes("c"));
  });

  it("evaluates when with || operator", async () => {
    const runner = new InMemoryRunner();
    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      nodes: [
        { id: "a", deterministic: true, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo a" }, output: { bind: "a" } },
        { id: "b", deterministic: true, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, when: "$a || false", exec: { command: "echo b" } },
      ],
    };

    const result = await engine.execute(workflow, { a: true });
    assert.strictEqual(result.success, true);
    assert.ok(result.executedNodes.includes("b"));
  });

  it("evaluates when with == operator", async () => {
    const runner = new InMemoryRunner();
    runner.register("a", async () => ({ success: true, output: 42 }));

    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      nodes: [
        { id: "a", deterministic: true, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo a" }, output: { bind: "val" } },
        { id: "b", deterministic: true, depends_on: ["a"], trigger_rule: "all_succeeded", max_retries: 0, when: "$val == 42", exec: { command: "echo b" } },
      ],
    };

    const result = await engine.execute(workflow, {});
    assert.strictEqual(result.success, true);
    assert.ok(result.executedNodes.includes("b"));
  });

  it("evaluates when with != operator", async () => {
    const runner = new InMemoryRunner();
    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      nodes: [
        { id: "a", deterministic: true, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo a" }, output: { bind: "val" } },
        { id: "b", deterministic: true, depends_on: ["a"], trigger_rule: "all_succeeded", max_retries: 0, when: "$val != 42", exec: { command: "echo b" } },
      ],
    };

    const result = await engine.execute(workflow, { val: 10 });
    assert.strictEqual(result.success, true);
    assert.ok(result.executedNodes.includes("b"));
  });

  it("evaluates when with > operator", async () => {
    const runner = new InMemoryRunner();
    runner.register("a", async () => ({ success: true, output: 20 }));

    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      nodes: [
        { id: "a", deterministic: true, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo a" }, output: { bind: "val" } },
        { id: "b", deterministic: true, depends_on: ["a"], trigger_rule: "all_succeeded", max_retries: 0, when: "$val > 10", exec: { command: "echo b" } },
      ],
    };

    const result = await engine.execute(workflow, {});
    assert.strictEqual(result.success, true);
    assert.ok(result.executedNodes.includes("b"));
  });

  it("evaluates when with < operator", async () => {
    const runner = new InMemoryRunner();
    runner.register("a", async () => ({ success: true, output: 5 }));

    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      nodes: [
        { id: "a", deterministic: true, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo a" }, output: { bind: "val" } },
        { id: "b", deterministic: true, depends_on: ["a"], trigger_rule: "all_succeeded", max_retries: 0, when: "$val < 10", exec: { command: "echo b" } },
      ],
    };

    const result = await engine.execute(workflow, {});
    assert.strictEqual(result.success, true);
    assert.ok(result.executedNodes.includes("b"));
  });

  it("handles uses node for sub-workflows", async () => {
    const runner = new InMemoryRunner();
    const subWorkflow: WorkflowDefinition = {
      name: "sub",
      require_deterministic: false,
      on: { invoke: { args: [] } },
      nodes: [
        { id: "sub-a", deterministic: true, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo sub-a" }, output: { bind: "sub.out" } },
      ],
    };

    const loader = async (path: string) => {
      if (path === "./sub-workflow.yaml") return subWorkflow;
      throw new Error("Not found");
    };

    const engine = new WorkflowEngine(runner, loader);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      nodes: [
        { id: "call", deterministic: true, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, uses: { workflow: "./sub-workflow.yaml" }, output: { bind: "call.out" } },
      ],
    };

    const result = await engine.execute(workflow, {});
    assert.strictEqual(result.success, true);
    assert.ok(result.executedNodes.includes("call"));
  });

  it("passes env variables to runner context", async () => {
    const runner = new InMemoryRunner();
    let receivedEnv: Record<string, string> = {};
    let receivedSecrets: string[] = [];
    runner.register("a", async (node, ctx) => {
      receivedEnv = ctx.env;
      receivedSecrets = ctx.secrets;
      return { success: true, output: "done" };
    });

    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      env: { variables: [{ name: "GLOBAL_VAR", value: "global", secret: false }], secrets: ["MY_SECRET"] },
      nodes: [
        { id: "a", deterministic: true, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, invoke_skill: { name: "test" } },
      ],
    };

    const result = await engine.execute(workflow, {});
    assert.strictEqual(result.success, true);
    assert.strictEqual(receivedEnv["GLOBAL_VAR"], "global");
    assert.ok(receivedSecrets.includes("MY_SECRET"));
  });

  it("passes node-level env variables", async () => {
    const runner = new InMemoryRunner();
    let receivedEnv: Record<string, string> = {};
    runner.register("a", async (node, ctx) => {
      receivedEnv = ctx.env;
      return { success: true, output: "done" };
    });

    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      nodes: [
        { id: "a", deterministic: true, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, env: [{ name: "NODE_VAR", value: "node-local", secret: false }], invoke_skill: { name: "test" } },
      ],
    };

    const result = await engine.execute(workflow, {});
    assert.strictEqual(result.success, true);
    assert.strictEqual(receivedEnv["NODE_VAR"], "node-local");
  });

  it("handles artifacts from node output", async () => {
    const runner = new InMemoryRunner();
    runner.register("produce", async () => ({
      success: true,
      output: "data",
      artifacts: [{ name: "build", from: "produce", path: "dist/build.js" }],
    }));
    runner.register("consume", async (node, ctx) => {
      const artifact = ctx.readState("produce.artifact.build");
      return { success: true, output: artifact };
    });

    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      nodes: [
        { id: "produce", deterministic: false, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo produce" } },
        { id: "consume", deterministic: true, depends_on: ["produce"], trigger_rule: "all_succeeded", max_retries: 0, invoke_skill: { name: "consume", with: { input: "$produce.artifact.build" } } },
      ],
    };

    const result = await engine.execute(workflow, {});
    assert.strictEqual(result.success, true);
    assert.ok(result.finalState["produce.artifact.build"]);
  });

  it("throws on unsupported expression", async () => {
    const runner = new InMemoryRunner();
    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      nodes: [
        { id: "a", deterministic: true, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, when: "some unknown expr", exec: { command: "echo a" } },
      ],
    };

    await assert.rejects(async () => {
      await engine.execute(workflow, {});
    }, /Unsupported expression/);
  });

  it("on_failure handler runs even with normal trigger_rules present", async () => {
    const runner = new InMemoryRunner();
    runner.register("fail", async () => ({ success: false, error: "boom" }));
    runner.register("recover", async () => ({ success: true, output: "recovered" }));

    const engine = new WorkflowEngine(runner);

    const workflow: WorkflowDefinition = {
      ...makeBase(),
      nodes: [
        { id: "fail", deterministic: false, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "exit 1" }, on_failure: "recover" },
        { id: "recover", deterministic: true, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo recovered" } },
      ],
    };

    const result = await engine.execute(workflow, {});
    assert.strictEqual(result.success, true);
    assert.ok(result.executedNodes.includes("recover"));
    assert.strictEqual(result.finalState["recover.output"], "recovered");
  });
});
