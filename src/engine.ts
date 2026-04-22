import type { WorkflowDefinition, WorkflowNode, EnvVar } from "./schema.js";
import type { AgentWorkflowRunner, ExecutionContext, EngineEvent, WorkflowOutcome, NodeResult } from "./types.js";

interface NodeState {
  status: "pending" | "running" | "succeeded" | "failed" | "skipped" | "deterministic_skipped";
  output?: unknown;
  retries: number;
  artifacts?: Map<string, unknown>;
}

export class WorkflowEngine {
  constructor(private runner: AgentWorkflowRunner, private subWorkflowLoader?: (path: string) => Promise<WorkflowDefinition>) {}

  async execute(workflow: WorkflowDefinition, args: Record<string, unknown>): Promise<WorkflowOutcome> {
    const state: Record<string, unknown> = { ...args };
    const nodeStates = new Map<string, NodeState>();
    const executedNodes: string[] = [];
    const skippedNodes: string[] = [];

    for (const node of workflow.nodes) {
      nodeStates.set(node.id, { status: "pending", retries: 0, artifacts: new Map() });
    }

    const order = this.topologicalSort(workflow.nodes);
    const workflowEnv = this.buildWorkflowEnv(workflow);

    const emit = (event: Omit<EngineEvent, "timestamp">) => {
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] ${event.type}: ${event.nodeId}`);
    };

    let failedNodeId: string | undefined;
    let failedError: string | undefined;

    for (const node of order) {
      const ns = nodeStates.get(node.id)!;

      if (ns.status !== "pending") continue;

      const depsSatisfied = this.checkDependencies(node, nodeStates);
      if (!depsSatisfied.ok) {
        ns.status = "skipped";
        skippedNodes.push(node.id);
        emit({ type: "node_skip", nodeId: node.id, payload: { reason: depsSatisfied.reason } });
        continue;
      }

      const whenResult = this.evaluateWhen(node.when, state, nodeStates);
      if (!whenResult) {
        ns.status = "skipped";
        skippedNodes.push(node.id);
        emit({ type: "node_skip", nodeId: node.id, payload: { reason: "when_condition_false" } });
        continue;
      }

      if (workflow.require_deterministic && !node.deterministic) {
        ns.status = "deterministic_skipped";
        skippedNodes.push(node.id);
        emit({ type: "deterministic_skipped", nodeId: node.id, payload: { reason: "require_deterministic is true" } });
        continue;
      }

      const resolvedInputs = this.resolveNodeInputs(node, state, nodeStates);
      const nodeEnv = this.buildNodeEnv(workflowEnv, node);

      const runnerCtx: ExecutionContext = {
        args,
        env: nodeEnv,
        secrets: workflowEnv.secrets,
        readState: (key: string) => resolvedInputs[key] ?? state[key],
        log: (event: EngineEvent) => emit({ ...event, nodeId: event.nodeId || node.id }),
      };

      let result: NodeResult | undefined;
      let finalError: string | undefined;

      const maxRetries = node.max_retries ?? 0;
      const timeoutMs = node.timeout_seconds ? node.timeout_seconds * 1000 : undefined;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        emit({ type: "node_start", nodeId: node.id, payload: { attempt } });
        try {
          result = timeoutMs
            ? await this.runWithTimeout(() => this.runner.execute(node, runnerCtx), timeoutMs)
            : await this.runner.execute(node, runnerCtx);

          if (result.success) {
            ns.status = "succeeded";
            ns.output = result.output;
            state[`${node.id}.output`] = result.output;
            if (node.output?.bind) {
              state[node.output.bind] = result.output;
            }
            if (result.artifacts) {
              for (const artifact of result.artifacts) {
                ns.artifacts?.set(artifact.name, artifact);
                state[`${node.id}.artifact.${artifact.name}`] = artifact;
              }
            }
            executedNodes.push(node.id);
            emit({ type: "node_end", nodeId: node.id, payload: { output: result.output } });
            break;
          } else {
            if (attempt < maxRetries) {
              emit({ type: "node_retry", nodeId: node.id, payload: { attempt, error: result.error } });
            } else {
              finalError = result.error ?? "unknown_error";
              ns.status = "failed";
              emit({ type: "node_failure", nodeId: node.id, payload: { error: finalError } });
            }
          }
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          if (attempt < maxRetries) {
            emit({ type: "node_retry", nodeId: node.id, payload: { attempt, error } });
          } else {
            finalError = error;
            ns.status = "failed";
            emit({ type: "node_failure", nodeId: node.id, payload: { error: finalError } });
          }
        }
      }

      if (ns.status === "failed") {
        if (node.on_failure) {
          const target = workflow.nodes.find((n) => n.id === node.on_failure);
          if (!target) {
            failedNodeId = node.id;
            failedError = `on_failure target "${node.on_failure}" not found`;
          }
        } else {
          failedNodeId = node.id;
          failedError = finalError;
        }
      }
    }

    if (failedNodeId) {
      return {
        success: false,
        finalState: state,
        executedNodes,
        skippedNodes,
        failedNode: failedNodeId,
        error: failedError,
      };
    }

    return {
      success: true,
      finalState: state,
      executedNodes,
      skippedNodes,
    };
  }

  private buildWorkflowEnv(workflow: WorkflowDefinition): { variables: Record<string, string>; secrets: string[] } {
    const variables: Record<string, string> = {};
    const secrets: string[] = [];

    if (workflow.env) {
      for (const v of workflow.env.variables) {
        variables[v.name] = v.value;
      }
      secrets.push(...workflow.env.secrets);
    }

    return { variables, secrets };
  }

  private buildNodeEnv(workflowEnv: { variables: Record<string, string>; secrets: string[] }, node: WorkflowNode): Record<string, string> {
    const env = { ...workflowEnv.variables };

    if (node.env) {
      for (const v of node.env) {
        env[v.name] = v.value;
      }
    }

    return env;
  }

  private topologicalSort(nodes: WorkflowNode[]): WorkflowNode[] {
    const byId = new Map<string, WorkflowNode>(nodes.map((n: WorkflowNode) => [n.id, n]));
    const visited = new Set<string>();
    const temp = new Set<string>();
    const result: WorkflowNode[] = [];

    const visit = (id: string) => {
      if (temp.has(id)) throw new Error(`Cycle detected involving node "${id}"`);
      if (visited.has(id)) return;
      temp.add(id);
      const node = byId.get(id);
      if (!node) throw new Error(`Unknown node "${id}"`);
      for (const dep of node.depends_on) visit(dep);
      temp.delete(id);
      visited.add(id);
      result.push(node);
    };

    for (const node of nodes) visit(node.id);
    return result;
  }

  private checkDependencies(
    node: WorkflowNode,
    states: Map<string, NodeState>
  ): { ok: boolean; reason?: string } {
    if (!node.depends_on.length) return { ok: true };

    switch (node.trigger_rule) {
      case "always":
        return { ok: true };

      case "any_completed": {
        let anyDone = false;
        for (const depId of node.depends_on) {
          const dep = states.get(depId);
          if (!dep) return { ok: false, reason: `unknown_dependency_${depId}` };
          if (dep.status === "succeeded" || dep.status === "failed" || dep.status === "skipped") {
            anyDone = true;
          }
        }
        return anyDone ? { ok: true } : { ok: false, reason: "no_dependencies_completed" };
      }

      case "all_succeeded":
      default: {
        for (const depId of node.depends_on) {
          const dep = states.get(depId);
          if (!dep) return { ok: false, reason: `unknown_dependency_${depId}` };
          if (dep.status === "failed") {
            return { ok: false, reason: `dependency_${depId}_failed` };
          }
          if (dep.status === "skipped") {
            return { ok: false, reason: `dependency_${depId}_skipped` };
          }
          if (dep.status === "deterministic_skipped") {
            return { ok: false, reason: `dependency_${depId}_deterministic_skipped` };
          }
          if (dep.status !== "succeeded") {
            return { ok: false, reason: `dependency_${depId}_not_ready` };
          }
        }
        return { ok: true };
      }
    }
  }

  private evaluateWhen(when: string | undefined, state: Record<string, unknown>, nodeStates: Map<string, NodeState>): boolean {
    if (when === undefined) return true;
    if (when === "true") return true;
    if (when === "false") return false;

    const nodeOutputMatch = when.match(/^\$([a-zA-Z0-9_-]+)\.output$/);
    if (nodeOutputMatch) {
      const val = state[`${nodeOutputMatch[1]}.output`];
      return Boolean(val);
    }

    const match = when.match(/^\$(state|args)\.(.+)$/);
    if (match) {
      const [, scope, key] = match;
      const val = scope === "state" ? state[key] : (state as Record<string, unknown>)[key];
      return Boolean(val);
    }

    const parsed = this.evaluateExpression(when, state);
    return Boolean(parsed);
  }

  private evaluateExpression(expr: string, state: Record<string, unknown>): unknown {
    expr = expr.trim();

    if (expr === "true") return true;
    if (expr === "false") return false;
    if (expr === "null") return null;

    const stateMatch = expr.match(/^\$state\.(.+)$/);
    if (stateMatch) {
      return state[stateMatch[1]];
    }

    const argsMatch = expr.match(/^\$args\.(.+)$/);
    if (argsMatch) {
      return state[argsMatch[1]];
    }

    const nodeOutputMatch = expr.match(/^\$([a-zA-Z0-9_-]+)\.output$/);
    if (nodeOutputMatch) {
      return state[`${nodeOutputMatch[1]}.output`];
    }

    const bareVarMatch = expr.match(/^\$([a-zA-Z_][a-zA-Z0-9_]*)$/);
    if (bareVarMatch) {
      const varName = bareVarMatch[1];
      if (varName in state) {
        return state[varName];
      }
      return state[varName];
    }

    const numMatch = expr.match(/^-?\d+(\.\d+)?$/);
    if (numMatch) return parseFloat(expr);

    const andMatch = expr.match(/^(.+)\s+&&\s+(.+)$/);
    if (andMatch) {
      return Boolean(this.evaluateExpression(andMatch[1], state)) && Boolean(this.evaluateExpression(andMatch[2], state));
    }

    const orMatch = expr.match(/^(.+)\s+\|\|\s+(.+)$/);
    if (orMatch) {
      return Boolean(this.evaluateExpression(orMatch[1], state)) || Boolean(this.evaluateExpression(orMatch[2], state));
    }

    const eqMatch = expr.match(/^(.+)\s+==\s+(.+)$/);
    if (eqMatch) {
      return this.compareValues(this.evaluateExpression(eqMatch[1], state), this.evaluateExpression(eqMatch[2], state));
    }

    const neqMatch = expr.match(/^(.+)\s+!=\s+(.+)$/);
    if (neqMatch) {
      return !this.compareValues(this.evaluateExpression(neqMatch[1], state), this.evaluateExpression(neqMatch[2], state));
    }

    const gtMatch = expr.match(/^(.+)\s+>\s+(.+)$/);
    if (gtMatch) {
      const a = this.evaluateExpression(gtMatch[1], state);
      const b = this.evaluateExpression(gtMatch[2], state);
      return typeof a === "number" && typeof b === "number" ? a > b : String(a) > String(b);
    }

    const gteMatch = expr.match(/^(.+)\s+>=\s+(.+)$/);
    if (gteMatch) {
      const a = this.evaluateExpression(gteMatch[1], state);
      const b = this.evaluateExpression(gteMatch[2], state);
      return typeof a === "number" && typeof b === "number" ? a >= b : String(a) >= String(b);
    }

    const ltMatch = expr.match(/^(.+)\s+<\s+(.+)$/);
    if (ltMatch) {
      const a = this.evaluateExpression(ltMatch[1], state);
      const b = this.evaluateExpression(ltMatch[2], state);
      return typeof a === "number" && typeof b === "number" ? a < b : String(a) < String(b);
    }

    const lteMatch = expr.match(/^(.+)\s+<=\s+(.+)$/);
    if (lteMatch) {
      const a = this.evaluateExpression(lteMatch[1], state);
      const b = this.evaluateExpression(lteMatch[2], state);
      return typeof a === "number" && typeof b === "number" ? a <= b : String(a) <= String(b);
    }

    if (expr.startsWith('"') && expr.endsWith('"')) {
      return expr.slice(1, -1);
    }
    if (expr.startsWith("'") && expr.endsWith("'")) {
      return expr.slice(1, -1);
    }

    try {
      return JSON.parse(expr);
    } catch {
      throw new Error(`Unsupported expression: "${expr}"`);
    }
  }

  private compareValues(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a === "number" && typeof b === "number") return a === b;
    if (typeof a === "string" && typeof b === "string") return a === b;
    if (typeof a === "boolean" && typeof b === "boolean") return a === b;
    return String(a) === String(b);
  }

  private resolveNodeInputs(
    node: WorkflowNode,
    state: Record<string, unknown>,
    nodeStates: Map<string, NodeState>
  ): Record<string, unknown> {
    const inputs: Record<string, unknown> = {};

    if (node.invoke_skill?.with) {
      for (const [key, value] of Object.entries(node.invoke_skill.with)) {
        const resolved = this.resolveValue(value, state, nodeStates);
        inputs[key] = resolved;
      }
    }

    if (node.exec?.command) {
      let command = node.exec.command;
      const matches = command.matchAll(/\$([a-zA-Z0-9_-]+)\.output/g);
      for (const match of matches) {
        const nodeId = match[1];
        const output = state[`${nodeId}.output`];
        command = command.replace(match[0], String(output ?? ""));
      }
      inputs["command"] = command;
    }

    return inputs;
  }

  private resolveValue(value: string, state: Record<string, unknown>, nodeStates: Map<string, NodeState>): unknown {
    const nodeOutputMatch = value.match(/^\$([a-zA-Z0-9_-]+)\.output$/);
    if (nodeOutputMatch) {
      return state[`${nodeOutputMatch[1]}.output`];
    }

    const artifactMatch = value.match(/^\$([a-zA-Z0-9_-]+)\.artifact\.(.+)$/);
    if (artifactMatch) {
      return state[`${artifactMatch[1]}.artifact.${artifactMatch[2]}`];
    }

    const argsMatch = value.match(/^\$args\.(.+)$/);
    if (argsMatch) {
      return state[argsMatch[1]];
    }

    const stateMatch = value.match(/^\$state\.(.+)$/);
    if (stateMatch) {
      return state[stateMatch[1]];
    }

    if (value.startsWith('"') && value.endsWith('"')) {
      return value.slice(1, -1);
    }
    if (value.startsWith("'") && value.endsWith("'")) {
      return value.slice(1, -1);
    }

    if (value === "true") return true;
    if (value === "false") return false;
    if (value === "null") return null;

    const num = parseFloat(value);
    if (!isNaN(num)) return num;

    return value;
  }

  private async runWithTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
      fn()
        .then((val) => {
          clearTimeout(timer);
          resolve(val);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }
}

