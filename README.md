# @mhingston5/agent-workflows

A **standalone, repo-agnostic** declarative DAG workflow engine for orchestrating agent skills. Define workflows in YAML or JSON, validate them statically, and execute them deterministically against any harness via a thin runner contract.

**This is a library, NOT a skill.** It lives in `node_modules/`, not `.agents/skills/`. Skills are the payload; this is the control plane.

## Features

- **TypeScript-first** — Zod schema with full IDE autocomplete, YAML/JSON as serialization targets
- **Deterministic enforcement** — optional `require_deterministic` flag skips non-deterministic nodes; ensures reproducible workflows
- **Two-phase validation** — structural (Zod) + semantic (DAG cycles, missing deps, output refs)
- **Rich conditions** — `when` supports `&&`, `||`, `==`, `!=`, `>`, `<`, `>=`, `<=`
- **Failure routing** — `on_failure` edges, `always` trigger rules, retry with `max_retries` and `timeout_seconds`
- **Variable resolution** — `$args`, `$state`, `$node_id.output`, `$node_id.artifact.NAME` in conditions and inputs
- **Environment & secrets** — workflow-level and node-level env vars, secret references
- **Artifact passing** — nodes can produce/consume artifacts from other nodes
- **Sub-workflows** — reusable workflow references via `uses:` property
- **Harness-agnostic** — implement `AgentWorkflowRunner.execute(node, context)` for any platform

## Installation

```bash
npm install @mhingston5/agent-workflows
```

## Quick Start

```typescript
import { WorkflowEngine, InMemoryRunner, parseYaml } from "@mhingston5/agent-workflows";

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

const runner = new InMemoryRunner();
const engine = new WorkflowEngine(runner);
const result = await engine.execute(workflow, { name: "World" });
console.log(result.finalState["greeting"]); // mock-exec: echo "Hello, World!"
```

## Integration Guide: Adding to an Existing Harness

The most common question: **How do I drop this into my repo?**

### What it is (and isn't)

- **It is** a TypeScript orchestration library — a replacement for hardcoded pipeline dispatch.
- **It is not** an Oh My Pi skill. It does not live in `.agents/skills/`. It lives in `node_modules/` and is imported by harness code.
- **Skills are payload.** The workflow engine is the control plane that decides which skill to run, when, and with what inputs.

### Three adoption patterns

| Pattern | Effort | What changes |
|---|---|---|
| **A. Validation gate** | 1 hour | Add `workflow-validate` to CI/harness preflight |
| **B. Coexistence** | 1 day | Harness entry points load YAML and delegate to `WorkflowEngine` |
| **C. Full replacement** | 1 week | Every harness node becomes a workflow node; skills are the only dispatch target |

**Pattern B is the sweet spot.** You gain declarative workflows, trigger rules, retries, and failure routing immediately, without deleting any working harness code.

### Pattern B: Coexistence walkthrough

Assume your repo already has skills like `jira-ticket-intake`, `pre-push-validation`, and `ci-monitor`, plus a harness that hardcodes nodes 1–9 in `orchestration-model.mjs`.

#### Step 1: Install

```bash
cd ~/source/payments
npm install @agent-workflows/core
```

#### Step 2: Write a workflow YAML

```yaml
# .agents/workflows/ticket-to-pr.yaml
name: ticket-to-pr
on:
  invoke:
    args:
      - { name: ticket_key, type: string, required: true }
      - { name: track, type: string, required: false, default: standard }

nodes:
  - id: intake
    deterministic: true
    invoke_skill:
      name: jira-ticket-intake
      with:
        ticket_key: "$args.ticket_key"
    output:
      bind: brief

  - id: branch
    deterministic: true
    depends_on: [intake]
    trigger_rule: all_succeeded
    invoke_skill:
      name: using-git-worktrees
      with:
        ticket_key: "$args.ticket_key"

  - id: plan
    deterministic: true
    depends_on: [branch]
    trigger_rule: all_succeeded
    invoke_skill:
      name: writing-plans
      with:
        ticket_key: "$args.ticket_key"

  - id: validate
    deterministic: true
    depends_on: [plan]
    trigger_rule: all_succeeded
    invoke_skill:
      name: pre-push-validation
    max_retries: 1

  - id: push
    deterministic: true
    depends_on: [validate]
    trigger_rule: all_succeeded
    exec:
      command: "git push"

  - id: create_pr
    deterministic: true
    depends_on: [push]
    trigger_rule: all_succeeded
    invoke_skill:
      name: create-pr
      with:
        ticket_key: "$args.ticket_key"

  - id: ci_monitor
    deterministic: true
    depends_on: [create_pr]
    trigger_rule: all_succeeded
    invoke_skill:
      name: ci-monitor
      with:
        ticket_key: "$args.ticket_key"
    on_failure: notify_failure
    timeout_seconds: 5400

  - id: notify_failure
    deterministic: true
    trigger_rule: always
    exec:
      command: "echo 'Pipeline failed — see state file'"
```

#### Step 3: Write a runner adapter

```typescript
// .agents/harness/payments-runner.mjs
import { execSync } from "child_process";
import { loadSkill } from "./skill-loader.mjs"; // your existing skill dispatch
import type { WorkflowNode, ExecutionContext, NodeResult } from "@agent-workflows/core";

export class PaymentsRunner {
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

#### Step 4: Wire the harness entry point

```typescript
// .agents/harness/pipeline.mjs
import fs from "fs";
import yaml from "js-yaml";
import { WorkflowEngine, parseYaml } from "@agent-workflows/core";
import { PaymentsRunner } from "./payments-runner.mjs";

export async function runPipeline(ticketKey, opts = {}) {
  const src = fs.readFileSync(".agents/workflows/ticket-to-pr.yaml", "utf-8");
  const { workflow, errors } = parseYaml(src);
  if (!workflow) throw new Error(errors.map((e) => e.message).join("\n"));

  const engine = new WorkflowEngine(new PaymentsRunner());
  const outcome = await engine.execute(workflow, { ticket_key: ticketKey, ...opts });

  // Map back to your existing harness state-file format
  writePipelineState(ticketKey, {
    executed_nodes: outcome.executedNodes,
    success: outcome.success,
    failed_node: outcome.failedNode,
    error: outcome.error,
  });

  return outcome;
}
```

That is the entire integration. The harness retains its state-file contract, its skills, and its audit tooling. The only change: **pipeline topology is data, not code.**

## Workflow YAML Spec

```yaml
name: test-and-deploy
require_deterministic: false  # Set true to skip non-deterministic nodes
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

env:  # Workflow-level environment
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
    env:  # Node-level environment
      - name: NPM_CONFIG_LOGLEVEL
        value: verbose
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
    when: "$args.skip_tests == false"  # Rich condition
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
    artifacts:  # Produce artifacts
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
    exec:
      command: "echo 'Tests failed'"
```

### Workflow-Level Properties

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` **required** | Workflow name |
| `require_deterministic` | `boolean` | If true, skip non-deterministic nodes |
| `on.invoke.args` | `InvokeArg[]` | Input arguments |
| `env.variables` | `EnvVar[]` | Workflow-level env vars |
| `env.secrets` | `string[]` | Secret names available to all nodes |

### Node Properties

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` **required** | Unique identifier |
| `deterministic` | `boolean` | Whether this node produces reproducible output |
| `depends_on` | `string[]` | Upstream node IDs |
| `trigger_rule` | `"all_succeeded" \| "any_completed" \| "always"` | When to run; default `all_succeeded` |
| `when` | `string` | Conditional expression with operators |
| `on_failure` | `string` | Node ID to route to on failure |
| `max_retries` | `number` (0-3) | Retry count; default 0 |
| `timeout_seconds` | `number` | Per-node timeout |
| `output.bind` | `string` | State key to write result to |
| `artifacts` | `Artifact[]` | Artifacts produced by this node |
| `env` | `EnvVar[]` | Node-level env vars |
| `secrets` | `string[]` | Node-level secret names |
| `exec.command` | `string` | Shell command to run |
| `invoke_skill.name` | `string` | Skill name to invoke via runner |
| `invoke_skill.with` | `Record<string, string>` | Inputs; supports `$node_id.output`, `$node_id.artifact.NAME` |
| `gate.type` | `"approval"` | Human approval gate |
| `gate.on_timeout` | `"abort" \| "continue"` | Timeout behavior for gates |
| `uses.workflow` | `string` | Path to reusable workflow |
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

### When Conditions (Operators)

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

Implement `AgentWorkflowRunner` to connect the engine to any harness:

```typescript
import { AgentWorkflowRunner, WorkflowNode, ExecutionContext, NodeResult } from "@agent-workflows/core";

class MyRunner implements AgentWorkflowRunner {
  async execute(node: WorkflowNode, context: ExecutionContext): Promise<NodeResult> {
    // context.args — workflow inputs
    // context.env — environment variables (workflow + node level)
    // context.secrets — secret names available
    // context.readState(key) — read-only state access
    // context.log(event) — structured logging

    if (node.exec) {
      // run shell command
      return { success: true, output: "...", artifacts: [] };
    }
    if (node.invoke_skill) {
      // dispatch to agent skill system
      return { success: true, output: "...", artifacts: [] };
    }
    if (node.gate) {
      // await human approval
      return { success: true, output: "approved", artifacts: [] };
    }
    if (node.uses) {
      // load and execute sub-workflow
      return { success: true, output: "...", artifacts: [] };
    }
    return { success: false, error: "Unsupported node type", artifacts: [] };
  }
}
```

### ExecutionContext

```typescript
interface ExecutionContext {
  readonly args: Record<string, unknown>;      // Workflow input arguments
  readonly env: Record<string, string>;        // Environment variables (merged)
  readonly secrets: string[];                  // Available secret names
  readState(key: string): unknown;             // Read from workflow state
  log(event: EngineEvent): void;               // Structured logging
}
```

### NodeResult

```typescript
interface NodeResult {
  success: boolean;
  output?: unknown;                            // Node output
  artifacts?: Artifact[];                      // Produced artifacts
  error?: string;                              // Error message if failed
}
```

### Built-in Runners

| Runner | Description |
|--------|-------------|
| `InMemoryRunner` | Test runner with mock outputs and per-node handler registration |
| `ShellRunner` | Executes `exec.command` via `child_process.execSync` with env |

## CLI Validation

```bash
npx workflow-validate workflow.yaml
```

Validates a workflow file and prints structural/semantic errors with non-zero exit on failure.

## API Reference

### `parseYaml(yaml: string): ParseResult`

Parses and validates a YAML workflow definition.

### `parseJson(json: string): ParseResult`

Parses and validates a JSON workflow definition.

### `parseWorkflow(unknown): ParseResult`

Validates an already-parsed object.

### `WorkflowEngine`

```typescript
constructor(runner: AgentWorkflowRunner)
execute(workflow: WorkflowDefinition, args: Record<string, unknown>): Promise<WorkflowOutcome>
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

### `WorkflowEngine` Constructor

```typescript
constructor(runner: AgentWorkflowRunner, subWorkflowLoader?: (path: string) => Promise<WorkflowDefinition>)
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
   - Exactly-one node type per node (exec/invoke_skill/gate/uses)

## License

MIT
