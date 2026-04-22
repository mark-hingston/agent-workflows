import { describe, it } from "node:test";
import assert from "node:assert";
import { parseWorkflow, parseJson, parseYaml } from "../parser.js";
import type { WorkflowDefinition } from "../schema.js";

function makeWorkflow(overrides: any = {}): unknown {
  return {
    name: "test",
    on: { invoke: { args: [] } },
    nodes: [],
    ...overrides,
  };
}

function makeNode(overrides: any = {}): unknown {
  return {
    id: "n1",
    deterministic: true,
    depends_on: [],
    trigger_rule: "all_succeeded",
    max_retries: 0,
    exec: { command: "echo test" },
    ...overrides,
  };
}

describe("parseWorkflow", () => {
  it("accepts a minimal valid workflow", () => {
    const result = parseWorkflow(makeWorkflow());
    assert.strictEqual(result.success, true);
    assert.ok(result.workflow);
    assert.strictEqual(result.errors.length, 0);
  });

  it("accepts a workflow with invoke args", () => {
    const result = parseWorkflow(makeWorkflow({
      on: {
        invoke: {
          args: [
            { name: "branch", type: "string", required: true },
            { name: "skip_tests", type: "boolean", required: false, default: false },
          ],
        },
      },
    }));
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.workflow!.on.invoke.args.length, 2);
  });

  it("accepts a valid DAG", () => {
    const result = parseWorkflow(makeWorkflow({
      nodes: [
        makeNode({ id: "a" }),
        makeNode({ id: "b", depends_on: ["a"] }),
        makeNode({ id: "c", depends_on: ["b"], exec: { command: "echo c" } }),
      ],
    }));
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.workflow!.nodes.length, 3);
  });

  it("rejects missing name field", () => {
    const result = parseWorkflow({ on: { invoke: { args: [] } }, nodes: [] });
    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.message.includes("name")));
  });

  it("rejects missing on field", () => {
    const result = parseWorkflow({ name: "test", nodes: [] });
    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.message.includes("on")));
  });

  it("rejects missing nodes field", () => {
    const result = parseWorkflow({ name: "test", on: { invoke: { args: [] } } });
    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.message.includes("nodes")));
  });

  it("rejects a node without an id", () => {
    const result = parseWorkflow(makeWorkflow({ nodes: [makeNode({ id: undefined })] }));
    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.message.includes("id")));
  });

  it("rejects a cycle in depends_on", () => {
    const result = parseWorkflow(makeWorkflow({
      nodes: [
        makeNode({ id: "a", depends_on: ["c"] }),
        makeNode({ id: "b", depends_on: ["a"] }),
        makeNode({ id: "c", depends_on: ["b"] }),
      ],
    }));
    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.message.includes("Cycle detected")));
  });

  it("rejects unknown dependency", () => {
    const result = parseWorkflow(makeWorkflow({
      nodes: [makeNode({ id: "a", depends_on: ["nonexistent"] })],
    }));
    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.message.includes("depends_on unknown node")));
  });

  it("rejects unknown on_failure target", () => {
    const result = parseWorkflow(makeWorkflow({
      nodes: [makeNode({ on_failure: "nonexistent" })],
    }));
    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.message.includes("on_failure references unknown node")));
  });

  it("rejects a node with no type", () => {
    const result = parseWorkflow(makeWorkflow({
      nodes: [{ id: "a", deterministic: true, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0 }],
    }));
    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.message.includes("exactly one of exec, invoke_skill, gate, or uses")));
  });

  it("rejects a node with multiple types", () => {
    const result = parseWorkflow(makeWorkflow({
      nodes: [makeNode({ exec: { command: "echo" }, invoke_skill: { name: "test" } })],
    }));
    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.message.includes("exactly one of exec, invoke_skill, gate, or uses")));
  });

  it("accepts an invoke_skill node", () => {
    const result = parseWorkflow(makeWorkflow({
      nodes: [{ id: "a", deterministic: true, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, invoke_skill: { name: "test-skill" } }],
    }));
    assert.strictEqual(result.success, true);
  });

  it("rejects invoke_skill.with referencing unknown node output", () => {
    const result = parseWorkflow(makeWorkflow({
      nodes: [
        { id: "a", deterministic: true, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, invoke_skill: { name: "skill", with: { key: "$b.output" } } },
      ],
    }));
    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.message.includes("references unknown node")));
  });

  it("rejects on_failure target not found", () => {
    const result = parseWorkflow(makeWorkflow({
      nodes: [
        { id: "a", deterministic: true, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo" } },
        { id: "b", deterministic: true, depends_on: ["a"], trigger_rule: "all_succeeded", max_retries: 0, exec: { command: "echo" }, on_failure: "unknown" },
      ],
    }));
    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.message.includes("on_failure references unknown")));
  });

  it("accepts a gate node", () => {
    const result = parseWorkflow(makeWorkflow({
      nodes: [{ id: "a", deterministic: true, depends_on: [], trigger_rule: "all_succeeded", max_retries: 0, gate: { type: "approval", on_timeout: "abort" } }],
    }));
    assert.strictEqual(result.success, true);
  });
});

describe("parseJson", () => {
  it("parses valid JSON", () => {
    const result = parseJson(JSON.stringify(makeWorkflow()));
    assert.strictEqual(result.success, true);
  });

  it("rejects invalid JSON", () => {
    const result = parseJson("not json");
    assert.strictEqual(result.success, false);
    assert.ok(result.errors[0].message.includes("Invalid JSON"));
  });

  it("rejects JSON with structural errors", () => {
    const result = parseJson(JSON.stringify({ name: 123, on: { invoke: { args: [] } }, nodes: [] }));
    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.type === "structure"));
  });
});

describe("parseYaml", () => {
  it("parses valid YAML", () => {
    const yaml = `
name: test
on:
  invoke:
    args: []
nodes: []
`;
    const result = parseYaml(yaml);
    assert.strictEqual(result.success, true);
  });

  it("rejects invalid YAML", () => {
    const result = parseYaml("{ bad yaml: ");
    assert.strictEqual(result.success, false);
    assert.ok(result.errors[0].message.includes("Invalid YAML"));
  });

  it("parses the example workflow", () => {
    const result = parseYaml(`
name: test
on:
  invoke:
    args:
      - name: x
        type: string
        required: true
nodes:
  - id: a
    deterministic: true
    exec:
      command: echo a
`);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.workflow!.name, "test");
    assert.strictEqual(result.workflow!.nodes[0].id, "a");
  });
});
