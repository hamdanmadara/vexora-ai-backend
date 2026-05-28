/**
 * Public entry point for the Mastra layer.
 * Components are lazy so the server can boot without all env vars present.
 */
export { getSupervisor } from "./agents/supervisor.agent";
export { getMemory } from "./memory";
export { getVectorStore, ensureKnowledgeIndex } from "./vector";
