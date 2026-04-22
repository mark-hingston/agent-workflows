import type { WorkflowNode, Artifact, EnvVar } from "./schema.js";

export interface NodeResult {
  success: boolean;
  output?: unknown;
  artifacts?: Artifact[];
  error?: string;
}

export interface EngineEvent {
  type: "node_start" | "node_end" | "node_skip" | "node_retry" | "node_failure" | "workflow_complete" | "workflow_failure" | "deterministic_skipped";
  nodeId: string;
  timestamp: string;
  payload?: unknown;
}

export interface ExecutionContext {
  readonly args: Record<string, unknown>;
  readonly env: Record<string, string>;
  readonly secrets: string[];
  readState(key: string): unknown;
  log(event: EngineEvent): void;
}

export interface AgentWorkflowRunner {
  execute(node: WorkflowNode, context: ExecutionContext): Promise<NodeResult>;
}

export interface WorkflowOutcome {
  success: boolean;
  finalState: Record<string, unknown>;
  executedNodes: string[];
  skippedNodes: string[];
  failedNode?: string;
  error?: string;
}
