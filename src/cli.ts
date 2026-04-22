#!/usr/bin/env node
import { readFileSync } from "fs";
import { parseYaml, parseJson } from "./parser.js";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: workflow-validate <file.yaml|file.json>");
  process.exit(1);
}

const filePath = args[0];
let content: string;
try {
  content = readFileSync(filePath, "utf-8");
} catch (e) {
  console.error(`Error reading file: ${filePath}`);
  process.exit(1);
}

const result = filePath.endsWith(".yaml") || filePath.endsWith(".yml")
  ? parseYaml(content)
  : parseJson(content);

if (!result.success || !result.workflow) {
  console.error("Validation failed:");
  for (const err of result.errors) {
    console.error(`  [${err.type.toUpperCase()}] ${err.message}${err.nodeId ? ` (node: ${err.nodeId})` : ""}`);
  }
  process.exit(1);
}

console.log("Validation passed.");
console.log(`Workflow: ${result.workflow.name}`);
console.log(`Nodes: ${result.workflow.nodes.length}`);
