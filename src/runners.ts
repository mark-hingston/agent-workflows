import type { WorkflowNode } from "./schema.js";
import type { AgentWorkflowRunner, ExecutionContext, NodeResult } from "./types.js";
import { execSync } from "child_process";

export class InMemoryRunner implements AgentWorkflowRunner {
  private handlers = new Map<
    string,
    (node: WorkflowNode, ctx: ExecutionContext) => Promise<NodeResult>
  >();
  private subWorkflowLoader?: (path: string) => Promise<WorkflowNode[]>;

  register(
    nodeId: string,
    handler: (node: WorkflowNode, ctx: ExecutionContext) => Promise<NodeResult>
  ): void {
    this.handlers.set(nodeId, handler);
  }

  setSubWorkflowLoader(loader: (path: string) => Promise<WorkflowNode[]>): void {
    this.subWorkflowLoader = loader;
  }

  async execute(node: WorkflowNode, ctx: ExecutionContext): Promise<NodeResult> {
    const handler = this.handlers.get(node.id);
    if (handler) return handler(node, ctx);

    if (node.exec) {
      return { success: true, output: `mock-exec: ${node.exec.command}`, artifacts: [] };
    }
    if (node.invoke_skill) {
      return { success: true, output: `mock-skill: ${node.invoke_skill.name}`, artifacts: [] };
    }
    if (node.gate) {
      return { success: true, output: "mock-gate: approved", artifacts: [] };
    }
    if (node.uses) {
      if (!this.subWorkflowLoader) {
        return { success: false, error: `Sub-workflow loader not configured for node "${node.id}"` };
      }
      try {
        const subNodes = await this.subWorkflowLoader(node.uses.workflow);
        return {
          success: true,
          output: `mock-uses: ${node.uses.workflow} (${subNodes.length} nodes)`,
          artifacts: [],
        };
      } catch (err) {
        return { success: false, error: `Failed to load sub-workflow: ${err}` };
      }
    }

    return { success: false, error: `No handler registered for node "${node.id}"` };
  }
}

export class ShellRunner implements AgentWorkflowRunner {
  async execute(node: WorkflowNode, ctx: ExecutionContext): Promise<NodeResult> {
    if (node.exec) {
      try {
        const env = { ...process.env, ...ctx.env };
        const stdout = execSync(node.exec.command, { encoding: "utf-8", timeout: 30_000, env });
        return { success: true, output: stdout.trim(), artifacts: [] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: message, artifacts: [] };
      }
    }
    if (node.invoke_skill) {
      return {
        success: false,
        error: `ShellRunner does not support invoke_skill (node "${node.id}")`,
        artifacts: [],
      };
    }
    if (node.gate) {
      return {
        success: false,
        error: `ShellRunner does not support gate (node "${node.id}") — requires interactive harness`,
        artifacts: [],
      };
    }
    if (node.uses) {
      return {
        success: false,
        error: `ShellRunner does not support uses (node "${node.id}") — requires workflow loader`,
        artifacts: [],
      };
    }
    return { success: false, error: `Unsupported node type for "${node.id}"`, artifacts: [] };
  }
}
