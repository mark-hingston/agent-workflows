import { z } from "zod";

export const InvokeArgSchema = z.object({
  name: z.string(),
  type: z.enum(["string", "integer", "boolean"]),
  required: z.boolean().default(true),
  default: z.unknown().optional(),
});

export const EnvVarSchema = z.object({
  name: z.string(),
  value: z.string(),
  secret: z.boolean().default(false),
});

export const ArtifactSchema = z.object({
  name: z.string(),
  from: z.string(),
  path: z.string().optional(),
});

export const ExecNodeSchema = z.object({
  command: z.string(),
  env: z.array(EnvVarSchema).optional(),
  secrets: z.array(z.string()).optional(),
});

export const InvokeSkillNodeSchema = z.object({
  name: z.string(),
  with: z.record(z.string()).optional(),
  env: z.array(EnvVarSchema).optional(),
  secrets: z.array(z.string()).optional(),
});

export const GateNodeSchema = z.object({
  type: z.literal("approval"),
  timeout_seconds: z.number().int().optional(),
  on_timeout: z.enum(["abort", "continue"]),
});

export const UsesNodeSchema = z.object({
  workflow: z.string(),
  inputs: z.record(z.string()).optional(),
  secrets: z.array(z.string()).optional(),
});

export const OutputBindingSchema = z.object({
  bind: z.string(),
});

export const NodeSchema = z.object({
  id: z.string(),
  deterministic: z.boolean().default(false),
  depends_on: z.array(z.string()).default([]),
  trigger_rule: z.enum(["all_succeeded", "any_completed", "always"]).default("all_succeeded"),
  when: z.string().optional(),
  on_failure: z.string().optional(),
  max_retries: z.number().int().min(0).max(3).default(0),
  timeout_seconds: z.number().int().optional(),
  output: OutputBindingSchema.optional(),
  artifacts: z.array(ArtifactSchema).optional(),
  env: z.array(EnvVarSchema).optional(),
  secrets: z.array(z.string()).optional(),
  exec: ExecNodeSchema.optional(),
  invoke_skill: InvokeSkillNodeSchema.optional(),
  gate: GateNodeSchema.optional(),
  uses: UsesNodeSchema.optional(),
});

export const WorkflowEnvSchema = z.object({
  variables: z.array(EnvVarSchema).default([]),
  secrets: z.array(z.string()).default([]),
});

export const WorkflowSchema = z.object({
  name: z.string(),
  require_deterministic: z.boolean().default(false),
  on: z.object({
    invoke: z.object({
      args: z.array(InvokeArgSchema),
    }),
  }),
  env: WorkflowEnvSchema.optional(),
  nodes: z.array(NodeSchema),
});

// Use z.output so defaulted fields are required in the resolved type
export type WorkflowDefinition = z.output<typeof WorkflowSchema>;
export type WorkflowNode = z.output<typeof NodeSchema>;
export type InvokeArg = z.infer<typeof InvokeArgSchema>;
export type ExecNode = z.infer<typeof ExecNodeSchema>;
export type InvokeSkillNode = z.infer<typeof InvokeSkillNodeSchema>;
export type GateNode = z.infer<typeof GateNodeSchema>;
export type UsesNode = z.infer<typeof UsesNodeSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type EnvVar = z.infer<typeof EnvVarSchema>;
