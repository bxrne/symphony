import { renderPrompt } from "../workflow/template.js";
import type { Issue } from "../types.js";

export type PromptInputs = {
  template: string;
  issue: Issue;
  attempt: number | null;
  turnNumber: number;
  maxTurns: number;
};

const CONTINUATION_GUIDANCE = [
  "This is a continuation turn on the same thread.",
  "Do not restart the task. Resume from the current workspace and coding-agent thread state.",
  "Check on the issue, pick up the next outstanding item, and keep working toward the handoff criteria.",
].join("\n");

export async function buildTurnPrompt(inputs: PromptInputs): Promise<string> {
  if (inputs.turnNumber <= 1) {
    return await renderPrompt(inputs.template, { issue: inputs.issue, attempt: inputs.attempt });
  }
  const suffix = `\n\n(turn ${inputs.turnNumber} of up to ${inputs.maxTurns})`;
  return `${CONTINUATION_GUIDANCE}${suffix}`;
}
