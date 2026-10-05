import { stepCountIs, ToolLoopAgent } from 'ai';
import { AGENT_NAME, PAY_ETH, type TreasuryChain, WITHDRAW_ETH } from './chain.js';
import { scriptedModel } from './model.js';
import { createTools } from './tools.js';

export interface AgentResult {
  text: string;
  toolResults: { toolName: string; output: unknown }[];
}

/** Runs the treasury agent once. Telemetry must be registered before this module is imported. */
export async function runAgent(chain: TreasuryChain): Promise<AgentResult> {
  const agent = new ToolLoopAgent({
    id: AGENT_NAME,
    telemetry: { functionId: AGENT_NAME },
    model: scriptedModel({ payEth: PAY_ETH, withdrawEth: WITHDRAW_ETH }),
    instructions: 'You manage a small treasury. Use the tools to move funds.',
    tools: createTools(chain),
    stopWhen: stepCountIs(5),
  });
  const result = await agent.generate({
    prompt: `Pay the vendor ${PAY_ETH} ETH, then withdraw ${WITHDRAW_ETH} ETH from the vault.`,
  });
  return {
    text: result.text,
    toolResults: result.steps.flatMap((step) =>
      step.toolResults.map(({ toolName, output }) => ({ toolName, output })),
    ),
  };
}
