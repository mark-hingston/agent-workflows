# @mhingston5/agent-workflows

A **standalone, repo-agnostic** declarative DAG workflow engine for orchestrating agent skills. Define workflows in YAML or JSON, validate them statically, and execute them deterministically against any harness via a thin runner contract.

> **This is a library, not a skill.** It lives in `node_modules/`, not `.agents/skills/`. Skills are the payload; this is the control plane.

## Why this exists

Agent harnesses often hard-code pipeline topology in imperative code (`if (step1.ok) run(step2)`). This makes them brittle, hard to audit, and impossible to reuse across repos. This library replaces that with a **declarative, deterministic DAG** — similar to GitHub Actions workflows — where nodes are skills, shell commands, gates, or sub-workflows, and edges are explicit `depends_on` + `trigger_rule` declarations.

## Features

| Feature | Description |
|---------|-------------|
| **Parallel execution** | Independent DAG branches run concurrently via a dynamic ready-set scheduler |
| **Deterministic enforcement** | `require_deterministic: true` skips non-deterministic nodes; ensures reproducible workflows |
| **Two-phase validation** | Structural (Zod) + semantic (DAG cycles, missing deps, unresolved output refs) |
| **Rich conditions** | `when` expressions support `&&`, `\|\|`, `==`, `!=`, `>`, `<`, `>=`, `<=` |
| **Failure routing** | Explicit `on_failure` edges, `always` trigger rules, retry with `max_retries` and `timeout_seconds` |
| **Variable resolution** | `$args.FIELD`, `$state.FIELD`, `$node_id.output`, `$node_id.artifact.NAME` |
| **Environment & secrets** | Workflow-level and node-level env vars, secret references |
| **Artifact passing** | Nodes can produce/consume artifacts from upstream nodes |
| **Sub-workflows** | Recursive execution via `uses:` with input binding and state merging |
| **Harness-agnostic** | Implement `AgentWorkflowRunner.execute(node, context)` for any platform |

## Installation

```bash
npm install @mhingston5/agent-workflows
```

## Quick Start

```typescript
import { WorkflowEngine, ShellRunner, parseYaml } from "@mhingston5/agent-workflows";

const yaml = `
name: hello-world
on:
  invoke:
    args:
      - name: name
        type: string
        required: true

nodes:
  - id: greet
    deterministic: true
    exec:
      command: echo "Hello, $name!"
    output:
      bind: greeting
`;

const { workflow, errors } = parseYaml(yaml);
if (!workflow) throw new Error(errors.map((e) => e.message).join("\n"));

const engine = new WorkflowEngine(new ShellRunner());
const result = await engine.execute(workflow, { name: "World" });

console.log(result.finalState["greeting"]); // "Hello, World!"
```

## Integration Guide

To adopt this in an existing harness, you only need to implement one interface:

```typescript
import type { AgentWorkflowRunner, WorkflowNode, ExecutionContext, NodeResult } from "@mhingston5/agent-workflows";

class MyRunner implements AgentWorkflowRunner {
  async execute(node: WorkflowNode, context: ExecutionContext): Promise<NodeResult> {
    if (node.invoke_skill) {
      const skill = loadSkill(node.invoke_skill.name);
      const result = await skill.run({
        args: context.args,
        inputs: node.invoke_skill.with ?? {},
        readState: context.readState,
      });
      return { success: result.ok, output: result.data, error: result.error };
    }

    if (node.exec) {
      const { stdout } = execSync(node.exec.command, { encoding: "utf-8" });
      return { success: true, output: stdout.trim() };
    }

    if (node.gate) {
      const approved = await promptForApproval(node.id);
      return { success: approved, output: approved ? "approved" : "rejected" };
    }

    return { success: false, error: "Unsupported node type" };
  }
}
```

Then load a workflow YAML and delegate to `WorkflowEngine`:

```typescript
const { workflow, errors } = parseYaml(fs.readFileSync("workflow.yaml", "utf-8"));
const engine = new WorkflowEngine(new MyRunner());
const outcome = await engine.execute(workflow, { ticket_key: "PAY-1234" });
```

The harness retains its existing skills, state-file format, and audit tooling. The only change: **pipeline topology is data, not code.**

## Workflow YAML Spec

```yaml
name: test-and-deploy
require_deterministic: false
on:
  invoke:
    args:
      - name: branch
        type: string
        required: true
      - name: skip_tests
        type: boolean
        required: false
        default: false

env:
  variables:
    - name: NODE_ENV
      value: production
  secrets:
    - API_KEY
    - DATABASE_URL

nodes:
  - id: install
    deterministic: true
    exec:
      command: "npm ci"
    output:
      bind: install.done

  - id: lint
    deterministic: true
    depends_on: [install]
    trigger_rule: all_succeeded
    exec:
      command: "npm run lint"

  - id: test
    deterministic: false
    depends_on: [install]
    when: "$args.skip_tests == false"
    exec:
      command: "npm test"
    max_retries: 2
    timeout_seconds: 120
    on_failure: notify-test-failure

  - id: build
    deterministic: true
    depends_on: [lint, test]
    trigger_rule: all_succeeded
    exec:
      command: "npm run build"
    artifacts:
      - name: dist
        from: build
        path: dist/

  - id: deploy
    deterministic: false
    depends_on: [build]
    trigger_rule: all_succeeded
    exec:
      command: "npm run deploy"

  - id: notify-test-failure
    deterministic: true
    trigger_rule: always
    exec:
      command: "echo 'Tests failed'"
```

### Workflow-Level Properties

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` **required** | Workflow name |
| `require_deterministic` | `boolean` | If `true`, skip non-deterministic nodes |
| `on.invoke.args` | `InvokeArg[]` | Input arguments for the workflow |
| `env.variables` | `EnvVar[]` | Workflow-level environment variables |
| `env.secrets` | `string[]` | Secret names available to all nodes |

### Node Properties

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` **required** | Unique identifier |
| `deterministic` | `boolean` | Whether this node produces reproducible output |
| `depends_on` | `string[]` | Upstream node IDs |
| `trigger_rule` | `"all_succeeded" \| "any_completed" \| "always"` | When to run; default `all_succeeded` |
| `when` | `string` | Conditional expression |
| `on_failure` | `string` | Node ID to route to on failure |
| `max_retries` | `number` (0–3) | Retry count; default `0` |
| `timeout_seconds` | `number` | Per-node timeout |
| `output.bind` | `string` | State key to write result to |
| `artifacts` | `Artifact[]` | Artifacts produced by this node |
| `env` | `EnvVar[]` | Node-level environment variables |
| `secrets` | `string[]` | Node-level secret names |
| `exec.command` | `string` | Shell command to run |
| `invoke_skill.name` | `string` | Skill name to invoke via runner |
| `invoke_skill.with` | `Record<string, string>` | Inputs; supports `$node_id.output` and `$node_id.artifact.NAME` |
| `gate.type` | `"approval"` | Human approval gate |
| `gate.on_timeout` | `"abort" \| "continue"` | Timeout behavior for gates |
| `uses.workflow` | `string` | Path to reusable sub-workflow |
| `uses.inputs` | `Record<string, string>` | Inputs to sub-workflow |

### Trigger Rules

- **`all_succeeded`** — runs only if all dependencies succeeded (default)
- **`any_completed`** — runs when at least one dependency has finished (succeeded, failed, or skipped)
- **`always`** — runs regardless of dependency status (useful for cleanup)

### Variable Expressions

| Expression | Scope |
|-----------|-------|
| `$args.FIELD` | Workflow input arguments |
| `$state.FIELD` | Mutable workflow state |
| `$node_id.output` | Output of an upstream node |
| `$node_id.artifact.NAME` | Artifact from an upstream node |

### `when` Condition Operators

| Operator | Example | Description |
|----------|---------|-------------|
| `&&` | `$a && $b` | Logical AND |
| `\|\|` | `$a \|\| $b` | Logical OR |
| `==` | `$val == 42` | Equality |
| `!=` | `$val != null` | Inequality |
| `>` | `$count > 0` | Greater than |
| `>=` | `$score >= 100` | Greater or equal |
| `<` | `$age < 18` | Less than |
| `<=` | `$qty <= 10` | Less or equal |

## Runner Contract

```typescript
interface AgentWorkflowRunner {
  execute(node: WorkflowNode, context: ExecutionContext): Promise<NodeResult>;
}

interface ExecutionContext {
  readonly args: Record<string, unknown>;
  readonly env: Record<string, string>;
  readonly secrets: string[];
  readState(key: string): unknown;
  log(event: EngineEvent): void;
}

interface NodeResult {
  success: boolean;
  output?: unknown;
  artifacts?: Artifact[];
  error?: string;
}
```

### Built-in Runners

| Runner | Description |
|--------|-------------|
| `InMemoryRunner` | Test runner with mock outputs and per-node handler registration |
| `ShellRunner` | Executes `exec.command` via `child_process.execSync` with env injection |

## CLI Validation

```bash
npx workflow-validate workflow.yaml
```

Validates a workflow file and prints structural/semantic errors with a non-zero exit on failure.

## API Reference

### `parseYaml(yaml: string): ParseResult`

Parses and validates a YAML workflow definition.

### `parseJson(json: string): ParseResult`

Parses and validates a JSON workflow definition.

### `parseWorkflow(obj: unknown): ParseResult`

Validates an already-parsed object against the schema and semantic rules.

### `WorkflowEngine`

```typescript
constructor(
  runner: AgentWorkflowRunner,
  subWorkflowLoader?: (path: string) => Promise<WorkflowDefinition>
)

execute(
  workflow: WorkflowDefinition,
  args: Record<string, unknown>
): Promise<WorkflowOutcome>
```

### `WorkflowOutcome`

```typescript
interface WorkflowOutcome {
  success: boolean;
  finalState: Record<string, unknown>;
  executedNodes: string[];
  skippedNodes: string[];
  failedNode?: string;
  error?: string;
}
```

## Validation

Two-phase validation runs on every workflow:

1. **Structural** (Zod) — field types, required properties, enum values
2. **Semantic** (DAG) —
   - Cycle detection in `depends_on`
   - Unknown dependency references
   - Unknown `on_failure` targets
   - Unresolved `$node_id.output` references
   - Unresolved `$node_id.artifact.NAME` references
   - Unknown artifact source nodes
   - Exactly-one node type per node (`exec` / `invoke_skill` / `gate` / `uses`)

## Limitations & Roadmap

| Limitation | Status | Notes |
|-----------|--------|-------|
| Persistence / replays | Not started | No built-in checkpointing or resume-from-failure support yet. |

## License

MIT
