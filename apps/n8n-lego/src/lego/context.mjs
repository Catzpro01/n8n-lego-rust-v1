/** Public ai.context@1.0.0 contract surface. Implementation lives in context-session.mjs. */
import {
  CONTEXT_CONTRACT as implementationContract,
  CONTEXT_CONTRACT_VERSION as implementationVersion,
  CONTEXT_SCOPES as implementationScopes,
  CONTEXT_OPERATIONS as implementationOperations,
  CONTEXT_MANAGER_STATES as implementationManagerStates,
  CONTINUATION_PACKAGE_VERSION as implementationContinuationVersion,
  CONTINUATION_FIELDS as implementationContinuationFields,
  CONTINUATION_VERIFICATION as implementationContinuationVerification,
  ContextSessionError as implementationError,
  createContextManager as implementationCreateManager,
  createContextSessionManager as implementationCreateSessionManager,
  verifyContinuationPackage as implementationVerifyContinuation,
} from './context-session.mjs';

export const CONTEXT_CONTRACT = implementationContract;
export const CONTEXT_CONTRACT_VERSION = implementationVersion;
export const CONTEXT_SCOPES = implementationScopes;
export const CONTEXT_OPERATIONS = implementationOperations;
export const CONTEXT_MANAGER_STATES = implementationManagerStates;
export const CONTINUATION_PACKAGE_VERSION = implementationContinuationVersion;
export const CONTINUATION_FIELDS = implementationContinuationFields;
export const CONTINUATION_VERIFICATION = implementationContinuationVerification;
export const ContextSessionError = implementationError;
export const createContextManager = implementationCreateManager;
export const createContextSessionManager = implementationCreateSessionManager;
export const verifyContinuationPackage = implementationVerifyContinuation;
