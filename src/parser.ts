import { z } from "zod";
import * as yaml from "js-yaml";
import { WorkflowSchema, type WorkflowDefinition } from "./schema.js";

export interface ValidationError {
  type: "structure" | "semantics";
  message: string;
  nodeId?: string;
}

export interface ParseResult {
  success: boolean;
  workflow?: WorkflowDefinition;
  errors: ValidationError[];
}

export function parseWorkflow(workflow: unknown): ParseResult {
  const errors: ValidationError[] = [];

  const structural = WorkflowSchema.safeParse(workflow);
  if (!structural.success) {
    for (const issue of structural.error.issues) {
      errors.push({ type: "structure", message: `${issue.path.join(".")}: ${issue.message}` });
    }
    return { success: false, errors };
  }

  const wf = structural.data;

  const semanticErrors = validateSemantics(wf);
  errors.push(...semanticErrors);

  return {
    success: errors.length === 0,
    workflow: errors.length === 0 ? wf : undefined,
    errors,
  };
}

function validateSemantics(wf: WorkflowDefinition): ValidationError[] {
  const errors: ValidationError[] = [];
  const nodeIds = new Set(wf.nodes.map((n) => n.id));
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));

  const collectRefs = (text: string, pattern: RegExp): string[] => {
    const refs: string[] = [];
    let m;
    while ((m = pattern.exec(text)) !== null) refs.push(m[1]);
    return refs;
  };

  for (const node of wf.nodes) {
    const refs: string[] = [];
    const outputPattern = /\$([a-zA-Z0-9_-]+)\.output/g;
    const artifactPattern = /\$([a-zA-Z0-9_-]+)\.artifact\.[a-zA-Z0-9_-]+/g;

    if (node.when) {
      refs.push(...collectRefs(node.when, outputPattern));
      refs.push(...collectRefs(node.when, artifactPattern));
    }
    if (node.exec?.command) {
      refs.push(...collectRefs(node.exec.command, outputPattern));
      refs.push(...collectRefs(node.exec.command, artifactPattern));
    }
    if (node.invoke_skill?.with) {
      for (const v of Object.values(node.invoke_skill.with)) {
        refs.push(...collectRefs(v, outputPattern));
        refs.push(...collectRefs(v, artifactPattern));
      }
    }

    for (const ref of refs) {
      if (!nodeIds.has(ref)) {
        errors.push({
          type: "semantics",
          message: `Node "${node.id}" references unknown node "${ref}"`,
          nodeId: node.id,
        });
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string, path: string[] = []) => {
    if (visiting.has(id)) {
      const cycleStart = path.indexOf(id);
      const cycle = path.slice(cycleStart).concat(id);
      errors.push({
        type: "semantics",
        message: `Cycle detected: ${cycle.join(" → ")}`,
      });
      return;
    }
    if (visited.has(id)) return;

    if (!nodeIds.has(id)) {
      errors.push({ type: "semantics", message: `Unknown node "${id}"`, nodeId: id });
      return;
    }

    visiting.add(id);
    const node = byId.get(id)!;
    for (const dep of node.depends_on) {
      if (!nodeIds.has(dep)) {
        errors.push({
          type: "semantics",
          message: `Node "${id}" depends_on unknown node "${dep}"`,
          nodeId: id,
        });
      } else {
        visit(dep, [...path, id]);
      }
    }
    visiting.delete(id);
    visited.add(id);
  };

  for (const node of wf.nodes) {
    if (!visited.has(node.id)) {
      visit(node.id);
    }
  }

  for (const node of wf.nodes) {
    if (node.on_failure && !nodeIds.has(node.on_failure)) {
      errors.push({
        type: "semantics",
        message: `Node "${node.id}" on_failure references unknown node "${node.on_failure}"`,
        nodeId: node.id,
      });
    }
  }

  for (const node of wf.nodes) {
    const types = [node.exec, node.invoke_skill, node.gate, node.uses].filter(Boolean).length;
    if (types !== 1) {
      errors.push({
        type: "semantics",
        message: `Node "${node.id}" must specify exactly one of exec, invoke_skill, gate, or uses (found ${types})`,
        nodeId: node.id,
      });
    }
  }

  for (const node of wf.nodes) {
    if (node.artifacts) {
      for (const artifact of node.artifacts) {
        if (!nodeIds.has(artifact.from)) {
          errors.push({
            type: "semantics",
            message: `Node "${node.id}" artifact references unknown node "${artifact.from}"`,
            nodeId: node.id,
          });
        }
      }
    }
  }

  return errors;
}

export function parseJson(json: string): ParseResult {
  try {
    const obj = JSON.parse(json);
    return parseWorkflow(obj);
  } catch (e) {
    return {
      success: false,
      errors: [{ type: "structure", message: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` }],
    };
  }
}

export function parseYaml(yamlText: string): ParseResult {
  try {
    const obj = yaml.load(yamlText);
    return parseWorkflow(obj);
  } catch (e) {
    return {
      success: false,
      errors: [{ type: "structure", message: `Invalid YAML: ${e instanceof Error ? e.message : String(e)}` }],
    };
  }
}
