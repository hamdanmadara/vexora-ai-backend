import { env } from "@/config/env";

/**
 * Shared persona helpers for all agents.
 *
 * The chatbot represents whichever company uploaded the knowledge base — NOT
 * Vexora AI (which is the platform powering the chatbot). Everything the
 * customer-facing agents say must be derived from:
 *   - The configured COMPANY_NAME / COMPANY_DESCRIPTION (optional)
 *   - The retrieved knowledge-base passages
 *
 * Agents must NEVER mention "Vexora", "Mastra", "OpenAI", or any other
 * underlying tech.
 */

export interface CompanyPersona {
  /** Best-effort company name. Empty string when unknown. */
  name: string;
  /** A phrase you can drop into prose, e.g. "for Acme" or "" when unknown. */
  forName: string;
  /** Description of what the company does, when configured. */
  description?: string;
}

export function getCompanyPersona(): CompanyPersona {
  const name = env.COMPANY_NAME ?? "";
  return {
    name,
    forName: name ? ` for ${name}` : "",
    description: env.COMPANY_DESCRIPTION,
  };
}

/**
 * A small block of guidance injected into every agent prompt so they all
 * agree on who they are and never break character.
 */
export function personaBlock(): string {
  const persona = getCompanyPersona();
  const lines: string[] = [
    persona.name
      ? `You represent ${persona.name}. Speak as a member of the ${persona.name} team — use "we", "our team", "our product".`
      : `You represent the company whose knowledge base you have been given. Speak as a member of that team — use "we", "our team", "our product". Learn the company's name from the retrieved documents when needed; otherwise stay generic.`,
  ];
  if (persona.description) {
    lines.push(`About us: ${persona.description}`);
  }
  lines.push(
    "Never mention the underlying platform, the AI provider, or any tooling. Never say you are 'Vexora', 'Mastra', or any product name unless it appears in the uploaded documents."
  );
  return lines.join("\n");
}
