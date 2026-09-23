import { LINE_STATES, type LineCheckResult, type LineState } from "../types.js";
import { SYSTEM } from "./prompt.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
export const DEFAULT_JUDGE_MODEL = "claude-sonnet-5";

const REPORT_LINE_STATE_TOOL = {
  name: "report_line_state",
  description: "Report the structured classification of where price stands relative to the line.",
  input_schema: {
    type: "object",
    properties: {
      state: {
        type: "string",
        enum: LINE_STATES,
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
    required: ["state", "confidence", "reasoning"],
  },
} as const;

export interface CallClaudeLineCheckParams {
  apiKey: string;
  model?: string;
  /** The user message, built with buildLineCheckPrompt (callers keep it to store alongside the result). */
  prompt: string;
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

function isLineState(value: unknown): value is LineState {
  return LINE_STATES.includes(value as LineState);
}

function parseToolInput(input: unknown): LineCheckResult {
  if (typeof input !== "object" || input === null) {
    throw new Error("LLM tool_use input was not an object");
  }
  const obj = input as Record<string, unknown>;
  if (!isLineState(obj.state)) {
    throw new Error(`LLM returned an invalid state: ${String(obj.state)}`);
  }
  const confidence = typeof obj.confidence === "number" ? obj.confidence : 0;
  const reasoning = typeof obj.reasoning === "string" ? obj.reasoning : "";
  return { state: obj.state, confidence, reasoning };
}

/**
 * Asks Claude for the line's current state and returns the structured answer.
 * Throws on network/HTTP/parse failure — callers own the retry policy
 * (see spec section 4.2: retry a couple of times, then let the next Cron
 * tick pick it back up rather than looping here).
 */
export async function callClaudeLineCheck(params: CallClaudeLineCheckParams): Promise<LineCheckResult> {
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
      tools: [REPORT_LINE_STATE_TOOL],
      tool_choice: { type: "tool", name: "report_line_state" },
      messages: [
        {
          role: "user",
          content: params.prompt,
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
    throw new Error("Claude response did not include a report_line_state tool_use block");
  }
  return parseToolInput(toolUse.input);
}
