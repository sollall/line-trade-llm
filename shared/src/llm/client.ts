import type { LlmDecision, LlmJudgmentResult } from "../types.js";
import { buildJudgmentPrompt, SYSTEM, type JudgmentContext } from "./prompt.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
export const DEFAULT_JUDGE_MODEL = "claude-sonnet-5";

const REPORT_JUDGMENT_TOOL = {
  name: "report_judgment",
  description: "Report the structured classification of this line touch.",
  input_schema: {
    type: "object",
    properties: {
      decision: {
        type: "string",
        enum: ["break_confirmed", "hold_reject", "undetermined"] satisfies LlmDecision[],
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Confidence in the decision, 0.0-1.0",
      },
      reasoning: {
        type: "string",
        description: "Short justification: wick length, body close position, volume, etc.",
      },
    },
    required: ["decision", "confidence", "reasoning"],
  },
} as const;

export interface CallClaudeJudgeParams {
  apiKey: string;
  model?: string;
  context: JudgmentContext;
  /** Injected so this works identically in Workers and Node (backtest). */
  fetchImpl?: typeof fetch;
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  name: string;
  input: unknown;
}

interface AnthropicMessageResponse {
  content: Array<AnthropicToolUseBlock | { type: string }>;
}

function isLlmDecision(value: unknown): value is LlmDecision {
  return value === "break_confirmed" || value === "hold_reject" || value === "undetermined";
}

function parseToolInput(input: unknown): LlmJudgmentResult {
  if (typeof input !== "object" || input === null) {
    throw new Error("LLM tool_use input was not an object");
  }
  const obj = input as Record<string, unknown>;
  if (!isLlmDecision(obj.decision)) {
    throw new Error(`LLM returned an invalid decision: ${String(obj.decision)}`);
  }
  const confidence = typeof obj.confidence === "number" ? obj.confidence : 0;
  const reasoning = typeof obj.reasoning === "string" ? obj.reasoning : "";
  return { decision: obj.decision, confidence, reasoning };
}

/**
 * Calls Claude with the touch context and returns the structured judgment.
 * Throws on network/HTTP/parse failure — callers own the retry policy
 * (see spec section 4.2: retry a couple of times, then let the next Cron
 * tick pick it back up rather than looping here).
 */
export async function callClaudeJudge(params: CallClaudeJudgeParams): Promise<LlmJudgmentResult> {
  const doFetch = params.fetchImpl ?? fetch;
  const response = await doFetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": params.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: params.model ?? DEFAULT_JUDGE_MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      tools: [REPORT_JUDGMENT_TOOL],
      tool_choice: { type: "tool", name: "report_judgment" },
      messages: [
        {
          role: "user",
          content: buildJudgmentPrompt(params.context),
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Claude API error ${response.status}: ${body.slice(0, 500)}`);
  }

  const data = (await response.json()) as AnthropicMessageResponse;
  const toolUse = data.content.find((block): block is AnthropicToolUseBlock => block.type === "tool_use");
  if (!toolUse) {
    throw new Error("Claude response did not include a report_judgment tool_use block");
  }
  return parseToolInput(toolUse.input);
}
