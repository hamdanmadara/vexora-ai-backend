import type { LeadRow } from "@/services/lead/lead.service";
import { greeterAgent } from "@/mastra/agents/greeter.agent";
import { knowledgeAgent } from "@/mastra/agents/knowledge.agent";
import { schedulerAgent } from "@/mastra/agents/scheduler.agent";
import type { Agent } from "@mastra/core/agent";
import { EXPLICIT_CALL_REQUEST_RE, type LeadMeta } from "./lead-meta";
import { isSchedulingMessage } from "./scheduling-intent";

export type RoutedAgentId = "greeter" | "knowledge" | "scheduler";

const AGENTS: Record<RoutedAgentId, Agent> = {
  greeter: greeterAgent,
  knowledge: knowledgeAgent,
  scheduler: schedulerAgent,
};

const GREETER_RE =
  /^(hi|hello|hey|good\s*(morning|afternoon|evening)|howdy|greetings|thanks|thank you|bye|goodbye|see you)\b/i;

export function routeToAgent(
  message: string,
  lead: LeadRow,
  meta: LeadMeta
): { id: RoutedAgentId; agent: Agent } {
  const trimmed = message.trim();

  if (isSchedulingMessage(trimmed, lead, meta)) {
    return { id: "scheduler", agent: AGENTS.scheduler };
  }

  if (EXPLICIT_CALL_REQUEST_RE.test(trimmed)) {
    return { id: "scheduler", agent: AGENTS.scheduler };
  }

  if (GREETER_RE.test(trimmed) && trimmed.split(/\s+/).length <= 6) {
    return { id: "greeter", agent: AGENTS.greeter };
  }

  return { id: "knowledge", agent: AGENTS.knowledge };
}
