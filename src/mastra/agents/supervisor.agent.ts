import { Agent } from "@mastra/core/agent";
import { chatModel } from "../model";
import { getMemory } from "../memory";
import { greeterAgent } from "./greeter.agent";
import { knowledgeAgent } from "./knowledge.agent";
import { schedulerAgent } from "./scheduler.agent";
import { personaBlock } from "./persona";

/**
 * Supervisor that routes each customer turn to the right specialist agent.
 * Built lazily so the server can boot before Supabase/OpenAI are wired.
 */
let _supervisor: Agent | null = null;

export function getSupervisor(): Agent {
  if (_supervisor) return _supervisor;

  _supervisor = new Agent({
    id: "supervisor",
    name: "Sales Supervisor",
    description:
      "Routes each customer message to the right specialist (greeter, knowledge, scheduler).",
    instructions: `
${personaBlock()}

You are the supervisor of a sales chatbot for the company described above.

You have three specialist agents available. Pick exactly one per turn:

1. greeter
   For: greetings ("hi", "hello"), thanks, goodbyes, identity questions
   ("are you a bot?"), tiny one-word openers, pure pleasantries.

2. knowledge
   For: anything substantive about the company, its product, pricing,
   features, integrations, comparisons, deployment, policies, FAQs, or
   any factual question. Also use this when the customer hasn't asked
   anything yet but you need to explain what we do.

3. scheduler
   For: booking, scheduling, "set up a call", "demo please", "yes, I'd like
   to talk", asking for available times, providing email after a meeting was
   proposed, confirming a slot. Once the lead's stored status is
   "meeting_proposed", KEEP routing here until status becomes "meeting_booked"
   or the customer cancels.

Routing tips:
- Prefer specialist > generic. If unsure between greeter and knowledge, pick
  knowledge.
- Always honor an explicit handoff signal from a specialist (e.g. knowledge
  saying "let me hand you to the scheduler").
- You will be told the current lead status in the runtime context — use it.

Output:
Just delegate. Do NOT add a wrapper message of your own. The specialist's
reply is what the customer sees.
`.trim(),
    model: chatModel(),
    agents: {
      greeterAgent,
      knowledgeAgent,
      schedulerAgent,
    },
    memory: getMemory(),
  });

  return _supervisor;
}
