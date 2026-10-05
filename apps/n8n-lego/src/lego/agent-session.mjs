/** Public ai.agent-session@1.0.0 contract surface. Implementation lives in context-session.mjs. */
import {
  AGENT_SESSION_CONTRACT as implementationContract,
  AGENT_SESSION_CONTRACT_VERSION as implementationVersion,
  AGENT_SESSION_STATES as implementationStates,
  AGENT_SESSION_OPERATIONS as implementationOperations,
  AGENT_SESSION_TRANSITIONS as implementationTransitions,
  ContextSessionError as implementationError,
  createContextSessionManager as implementationCreateManager,
} from './context-session.mjs';

export const AGENT_SESSION_CONTRACT = implementationContract;
export const AGENT_SESSION_CONTRACT_VERSION = implementationVersion;
export const AGENT_SESSION_STATES = implementationStates;
export const AGENT_SESSION_OPERATIONS = implementationOperations;
export const AGENT_SESSION_TRANSITIONS = implementationTransitions;
export const ContextSessionError = implementationError;
export const createContextSessionManager = implementationCreateManager;
