import assert from "node:assert/strict";
import test from "node:test";

import {
  TOOL_DEFINITION_PROMPT_TOKEN_LIMIT,
  estimateToolDefinitionPromptTokens,
  fitToolNamesWithinDefinitionBudget,
  measureToolDefinitionPromptBytes,
} from "./tool-definition-budget.ts";

const tool = (name, size) => ({
  name,
  description: name,
  parameters: { type: "object", properties: { value: { type: "string", description: "x".repeat(size) } } },
});

test("tool prompt measurement uses the same compact provider payload", () => {
  const definitions = [tool("read", 100), tool("write", 200)];
  const bytes = measureToolDefinitionPromptBytes(definitions);

  assert.ok(bytes > 300);
  assert.ok(estimateToolDefinitionPromptTokens(definitions) > 0);
  assert.equal(TOOL_DEFINITION_PROMPT_TOKEN_LIMIT, 10_000);
});

test("tool selection never crosses the hard 10k serialized prompt limit", () => {
  const definitions = [tool("first", 10_000), tool("second", 10_000), tool("oversized", 32_000)];
  const result = fitToolNamesWithinDefinitionBudget(definitions, ["first", "second", "oversized"]);

  assert.deepEqual(result.toolNames, ["first", "second"]);
  assert.deepEqual(result.droppedToolNames, ["oversized"]);
  assert.ok(result.promptTokens <= TOOL_DEFINITION_PROMPT_TOKEN_LIMIT);
});

test("tool budget selection is stable and ignores duplicate or unknown names", () => {
  const definitions = [tool("read", 50), tool("write", 50)];
  const result = fitToolNamesWithinDefinitionBudget(definitions, ["write", "missing", "write", "read"]);

  assert.deepEqual(result.toolNames, ["write", "read"]);
  assert.deepEqual(result.droppedToolNames, []);
});
