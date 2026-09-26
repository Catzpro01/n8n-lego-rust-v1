/**
 * `@lego/frontend` — Frontend LEGO public surface (P2.5).
 *
 * Framework-neutral contract layer between the n8n editor UI and the
 * compatibility/API boundary. Consumed by:
 *
 *   apps/n8n-lego/src/frontend.mjs   the runtime (boot payload + registry)
 *   packages/frontend-lego/test/**   the contract/architecture tests
 *   future frontend feature LEGOs    through the declared extension points
 *
 * The normative document is `contracts/frontend.contract.md`; the architecture and
 * the migration notes for future frontend features are in
 * `docs/n8n-lego/FRONTEND_LEGO.md`.
 */
export {
  BOOT_PAYLOAD_KEYS,
  CAPABILITY_DISCOVERY,
  CONTRACT_ID,
  CONTRACT_VERSION,
  EMPTY_BODY_ENDPOINTS,
  ENVELOPES,
  ENVELOPE_KEYS,
  EVENTS,
  LIST_ENDPOINTS,
  LIST_SHAPES,
  ROUTE_CONVENTIONS,
  SESSION,
  STATUS_SEMANTICS,
  VERSIONING,
  answersEmptyBody,
  describeContract,
  resolveListShape,
} from './src/contract.mjs';

export {
  ERROR_CODES,
  ERROR_KINDS,
  FrontendError,
  assertErrorKeysUseDeclaredSlots,
  errorMessageKeys,
  isFrontendError,
  kindForStatus,
  normalizeError,
  toDisplayModel,
} from './src/errors.mjs';

export {
  FALLBACK_LOCALE,
  MESSAGE_KEY_GRAMMAR,
  MESSAGE_SLOTS,
  PLURAL_CATEGORIES,
  SUPPORTED_LOCALES,
  createPluralSelector,
  pluralKey,
  translationCoverage,
  buildMessageKey,
  createMessageCatalog,
  createTranslator,
  describeLocalizationContract,
  describeLocales,
  describeMessageSlots,
  directionOf,
  isMessageSlot,
  isSupportedLocale,
  isValidMessageKey,
  localeMetadata,
  messageSlot,
  parseMessageKey,
  resolveLocale,
  substitute,
  unmappedMessageSlots,
} from './src/i18n.mjs';

export {
  ACTIVATION_MODES,
  CAPABILITY_SCHEMA,
  CAPABILITY_STATUSES,
  RegistryError,
  createFrontendRegistry,
  validateCapability,
} from './src/registry.mjs';

export {
  CAPABILITY_STATES,
  CRITICALITY,
  LifecycleError,
  RUNNABLE_STATES,
  STATE_TRANSITIONS,
  TRUST_LEVELS,
  TRUST_RULES,
  canTransition,
  createLifecycle,
  degradationFor,
  describeLifecycle,
  describeTrust,
  isRunnable,
  mayPerform,
  trustInherited,
  trustRank,
} from './src/lifecycle.mjs';

export {
  ENVELOPE_FIELDS,
  EnvelopeError,
  TRANSPORTS,
  createOperationContext,
  describeEnvelope,
  nextCorrelationId,
  observationRecord,
} from './src/envelope.mjs';

export {
  DEVICE_PROFILES,
  ProfileError,
  REQUIREMENT_FIELDS,
  SUPPORT_STATES,
  describeProfiles,
  getProfile,
  resolveSupport,
  supportMatrix,
} from './src/profiles.mjs';

export {
  ImpactError,
  OWN_CONTRACTS,
  SELECTIVE_CAVEAT,
  TEST_TIERS,
  TIER_SUITES,
  commandFor,
  createImpactGraph,
  describeTestMap,
  requiresInstance,
} from './src/impact.mjs';

export {
  DEFAULT_INTERACTION,
  INTERACTION_CLASSES,
  INTERACTIONS,
  INTERACTION_TRANSPORTS,
  InteractionError,
  canCarry as canCarryInteraction,
  defineInteraction,
  describeInteractions,
  interactionOf,
  isInteractionClass,
  normaliseInteraction,
  resolveInteraction,
  transportsFor,
} from './src/interactions.mjs';

export {
  COMPATIBILITY,
  RANGE_EXAMPLES as VERSION_RANGE_EXAMPLES,
  VersionError,
  bump,
  compareVersions,
  compatibilityOf,
  describeVersions,
  isRange,
  isVersion,
  majorOf,
  minorOf,
  parseVersion,
  sameMajor,
  satisfiesRange,
} from './src/versions.mjs';

export {
  NO_CAPABILITY,
  backendCapabilitiesOf,
  capabilityOf,
  surfacesOfCapability,
} from './src/surface-capability.mjs';

export {
  CAPABILITY_ORIGINS,
  DEGRADATION_SITUATIONS,
  describeNegotiation,
} from './src/negotiation.mjs';

export {
  AVAILABILITY_STATES,
  CapabilityNotGrantedError,
  NegotiationError,
  createCapabilityNegotiator,
} from './src/negotiation.mjs';

export {
  BACKEND_STATES,
  backendAvailabilityFrom,
  describeBackendView,
} from './src/backend-view.mjs';

export {
  NoTransportError,
  SERIALIZATION,
  TRANSPORT_COSTS,
  TRANSPORT_KINDS,
  TransportError,
  createOperationGateway,
  declaredFutureTransports,
  defineLocalTransport,
  defineTransport,
  describeTransports,
} from './src/transport.mjs';

export {
  EVENT_FIELDS,
  EVENT_NAMES,
  FRONTEND_EVENTS,
  ObservabilityError,
  createBufferSink,
  createObservability,
  describeObservability,
} from './src/observability.mjs';

export {
  ARCHITECTURE_RULES,
  CONFORMANCE_STATES,
  checkConformance,
  describeConformance,
} from './src/conformance.mjs';

export {
  CONTEXT_LEVELS,
  PACK_ROOT,
  REFERENCE_FILES,
  TASK_INDEX,
  contextFor,
  describePack,
  packFiles,
} from './src/knowledge.mjs';

export {
  FRONTEND_BOOT_GLOBAL,
  FRONTEND_BOOT_META_NAME,
  bootMetaTag,
  browserBootstrapSnippet,
  buildBootPayload,
  decodeBootPayload,
  encodeBootPayload,
  extractBootPayload,
  payloadFields,
  validateBootPayload,
} from './src/boot.mjs';

export { createRestClient, createStateStore, STATE_STATUSES } from './src/client.mjs';

export {
  MANIFEST_DIR,
  MANIFEST_FILES,
  PACKAGE_ROOT,
  contextSessionSurface,
  memorySurface,
  workspaceSurface,
  declaredCapabilityIds,
  extensionPointIds,
  loadManifests,
  skillSurface,
  subLegoIds,
  surfaceIds,
} from './src/manifests.mjs';
export {
  MAX_DEPTH,
  RANGE_EXAMPLES,
  SUB_LEGO_SCHEMA,
  SubLegoReplacementError,
  SUB_LEGO_STATUSES,
  SubLegoError,
  SubLegoUpgradeError,
  UPGRADE_POLICIES,
  createSubLegoRegistry,
  depthOf,
  parentIdOf,
  satisfies,
  validateSubLego,
} from './src/sublegos.mjs';

export { ADAPTER, CONVENTIONS, createVueAdapter } from './src/adapters/vue.mjs';
export { ADAPTERS, CURRENT_ADAPTER, CURRENT_ADAPTER_ID, createAdapter } from './src/adapters/index.mjs';

export { createFrontendLego } from './src/lego.mjs';

export {
  AGENT_EVENT_TYPES,
  DELEGATION_FIELDS,
  EVENT_DELIVERY,
  EVENT_GROUPS,
  EVENT_STATUSES,
  SUMMARY_LIMIT,
  TERMINAL_STATUSES,
  TRACE_FIELDS,
  TRACE_LIMIT,
  AgentEventError,
  buildDelegationTree,
  createEventNormalizer,
  createWorkTrace,
  deliveryClassesFor,
  describeAgentEvents,
  isAgentEventType,
  validateTraceEvent,
} from './src/agent-events.mjs';

export {
  AI_CAPABILITIES,
  MCP_CONNECTION_STATES,
  MCP_OBJECTS,
  PROVIDER_KINDS,
  RUNTIME_DECLARATION_FIELDS,
  RUNTIME_IDENTITY_FIELDS,
  RUNTIME_KINDS,
  RUNTIME_LOCALITY,
  AgentContractError,
  describeAgents,
  describeInstallation,
  mcpRelationship,
  suitableRuntimes,
  validateProviderDeclaration,
  validateRuntimeDeclaration,
} from './src/agents.mjs';

export {
  CAPABILITY_ID_PATTERN,
  LOCAL_VOCABULARIES,
  PENDING_CONTRACT_ROWS,
  PUBLISHED_CONTRACT_ROWS,
  PENDING_PUBLICATIONS,
  PROMOTED_PUBLICATIONS,
  QUOTED_FROM,
  VOCABULARIES,
  VocabularyError,
  assertTerm,
  compareVocabulary,
  describeVocabulary,
  detectCollisions,
  isDeclaredTerm,
  normaliseCapabilityId,
  pendingPublicationOf,
  promotionOf,
  vocabularyConflicts,
  vocabularyDrift,
  vocabularyOf,
} from './src/vocabulary.mjs';

/**
 * The Skill surface (P2.12): discovery and state presentation over the skill vocabulary the
 * backend declares. A skill is procedural knowledge — it is not a capability, not an agent,
 * and it never implies a permission, a tool or a model. Every word quoted here lives in the
 * vocabulary lock; the surface declares no vocabulary of its own.
 */
export {
  SKILL_AFFORDANCES,
  SKILL_CONTRACT_ID,
  SKILL_DECLARATION_FIELDS,
  SKILL_DECLARATION_SOURCE,
  SKILL_DEGRADATION_STATES,
  SKILL_DISCLOSURE_LEVELS,
  SKILL_FORBIDDEN_FIELDS,
  SKILL_FORBIDDEN_IMPLICATIONS,
  SKILL_IDENTITY_FIELDS,
  SKILL_INSTANCE_FIELDS,
  SKILL_LIFECYCLE,
  SKILL_OPERATIONS,
  SKILL_PERMISSIONS,
  SKILL_QUOTED_VOCABULARIES,
  SKILL_STATUSES,
  SkillDeclarationError,
  createSkillCatalog,
  describeSkills,
  searchSkills,
  skillDetail,
  skillLifecycle,
  skillState,
  skillUnsupported,
  validateSkillDeclaration,
  validateSkillInstance,
} from './src/skills.mjs';

export {
  CHANGE_KINDS,
  VERSION_MOVES,
  classifyChange,
} from './src/versions.mjs';

export {
  CAPABILITY_IDENTITY_FIELDS,
  IDENTITY_PROVENANCE_FIELDS,
  SEAM_FORBIDDEN,
  SEAM_INPUTS,
  SEAM_SOURCES,
  SeamError,
  capabilityIdentity,
  consumeInput,
  describeSeam,
  requireInput,
} from './src/seam.mjs';

/**
 * The Context & Session surface (P2.13): one LEGO, two contracts (`ai.context` = what is loaded
 * now, `ai.agent-session` = bounded state), five concepts that stay distinct, and a publication
 * gap that is rendered instead of hidden. Every word is quoted from the backend declaration; the
 * rollover phase machine and the verification results are ruled but unpublished, so they are
 * reported as pending (`XA-20`) rather than spelled locally. Nothing here fabricates a token
 * count, implies a Memory store, or offers an execution affordance.
 */
export {
  CONTEXT_DECLARED_VERSION,
  CONTEXT_DECLARATION_SOURCE,
  CONTEXT_FIELDS,
  CONTEXT_LIFECYCLE,
  CONTEXT_OPERATIONS,
  CONTEXT_PERMISSIONS,
  CONTEXT_SCOPES,
  CONTEXT_SESSION_AFFORDANCES,
  CONTEXT_SESSION_DECISION,
  CONTEXT_SESSION_LEGO_ID,
  CONTEXT_SESSION_QUOTED_VOCABULARIES,
  CONTEXT_CONTRACT_ID,
  CONTEXT_DECLARED_VERBS,
  CONTINUATION_AFFORDANCES,
  continuationAffordances,
  forbiddenReasons,
  CONTINUATION_ENVELOPE_FIELDS,
  CONTINUATION_SECTIONS,
  CONTINUITY_CHECKS,
  CAPABILITY_DECLARATION_SOURCE,
  DISTINCT_CONCEPTS,
  DRIFT_FIELDS,
  FORBIDDEN_FIELDS as CONTEXT_SESSION_FORBIDDEN_FIELDS,
  FORBIDDEN_IMPLICATIONS as CONTEXT_SESSION_FORBIDDEN_IMPLICATIONS,
  FORBIDDEN_KEY_PATTERN,
  LEGO_DECLARATION_SOURCE,
  MEMORY_DECISION,
  PUBLISHED_OPERATION_IDS,
  ROLLOVER_LIFECYCLE_STATES,
  ROLLOVER_PHASES,
  VERIFICATION_RESULTS,
  SESSION_CONTRACT_ID,
  SESSION_DECLARED_VERSION,
  SESSION_DECLARATION_SOURCE,
  SESSION_FIELDS,
  SESSION_OPERATIONS,
  SESSION_PERMISSIONS,
  SESSION_REFERENCES,
  SESSION_STATES,
  SESSION_TERMINAL_STATES,
  TOKEN_DECISION,
  TOKEN_KINDS,
  UNPUBLISHED_CONTEXT_VERBS,
  USAGE_REPORT_STATES,
  ContextSessionError,
  assertDistinctConcepts,
  contextLifecycle,
  contextLifecycleState,
  contextScope,
  contextSessionUnsupported,
  contextUsage,
  continuityVerification,
  createContextSessionView,
  declarationDrift as contextSessionDrift,
  describeContextSession,
  expectedRolloverPhase,
  rehydration,
  scanForbiddenKeys,
  scopeLadder,
  sessionLineage,
  sessionLifecycle,
  sessionState,
  validateContextRecord,
  validateContinuationPackage,
  validateRolloverThreshold,
  validateSessionRecord,
} from './src/context-session.mjs';

/**
 * The Memory surface (P2.14): the quoted record shape of `ai.memory@1.0.0`, the deterministic
 * bounded list, the four list states, the provider-boundary persistence statement, the separation
 * from Context and Session, and the deferred half of the contract named rather than offered. It
 * renders records; it writes, forgets, traverses and ranks nothing.
 */
export {
  // `MEMORY_DECISION` (XA-12) is already exported by the Context & Session surface above — the two
  // surfaces name the same decision, and one name for one decision is the point of the vocabulary
  // lock, so it is deliberately not re-exported here.
  DEFERRED_MEMORY_OPERATIONS,
  FORBIDDEN_MEMORY_FIELDS,
  FORBIDDEN_MEMORY_KEY_PATTERN,
  MEMORY_AFFORDANCES,
  MEMORY_CONTRACT_ID,
  MEMORY_CONTENT_LIMIT_BYTES,
  MEMORY_DECLARED_VERSION,
  MEMORY_DECLARATION_SOURCE,
  MEMORY_ERROR_CODES,
  MEMORY_FIELDS,
  MEMORY_GRAPH_EDGES,
  MEMORY_GRAPH_NODES,
  MEMORY_KINDS,
  MEMORY_LEGO_ID,
  MEMORY_FORBIDDEN_IMPLICATIONS,
  MEMORY_LIFECYCLE,
  MEMORY_LIST_LIMIT,
  MEMORY_LIST_ORDERING,
  MEMORY_LIST_STATES,
  MEMORY_ORIGINS,
  MEMORY_PERSISTENCE_STATES,
  MEMORY_MODELING_DECISION,
  MEMORY_OPERATION_IDS,
  MEMORY_OPERATIONS,
  MEMORY_PERMISSIONS,
  MEMORY_PHASE,
  MEMORY_QUOTED_VOCABULARIES,
  MEMORY_REFERENCE_FIELDS,
  MEMORY_REFERENCE_LIMIT,
  MEMORY_RETENTIONS,
  MEMORY_SCOPES,
  MEMORY_SEPARATION,
  MEMORY_SURFACE_MODULE,
  MEMORY_UNSUPPORTED_ERROR,
  MemoryError,
  assertMemoryIsNotContext,
  createMemoryView,
  describeMemory,
  memoryDrift,
  memoryKind,
  memoryKinds,
  memoryLifecycle,
  memoryLifecycleState,
  memoryList,
  memoryOrigin,
  memoryPersistence,
  memoryPublication,
  memoryRecallResult,
  memoryRetention,
  memoryRetentions,
  memoryScope,
  memoryScopeLadder,
  memoryUnsupported,
  scanForbiddenMemoryKeys,
  validateMemoryRecord,
} from './src/memory.mjs';

export {
  WORKSPACE_FRONTEND_FIELDS,
  WORKSPACE_NON_RENDERED,
  WORKSPACE_SURFACE_CONTRACT,
  WORKSPACE_VOCABULARY,
  WorkspaceSurfaceError,
  checkWorkspaceAlignment,
  describeWorkspace,
  validateWorkspaceRecord,
  workspaceCatalogAudit,
  workspacePublication,
} from './src/workspace.mjs';

export {
  MIGRATION_STATUSES,
  MIGRATION_CONTRACT_STATUSES,
  ROLLBACK_STRATEGIES,
  REQUIRED_CATEGORIES,
  ENTRY_FIELDS,
  SurfaceMigrationError,
  validateMigrationEntry,
  validateSurfaceMigrationInventory,
  describeSurfaceMigration,
} from './src/surface-migration.mjs';

export {
  SURFACE_MODES,
  REGION_STATES,
  SURFACE_CONTRACT_FIELDS,
  SurfaceContractError,
  validateSurfaceContract,
  defineSurfaceContract,
  describeSurfaceContract,
  surfaceRunnable,
} from './src/surface-contract.mjs';

export {
  PARITY_STATUSES,
  PARITY_FIELDS,
  ParityError,
  validateObservation,
  compareObservations,
  observation,
  describeParityHarness,
} from './src/parity.mjs';

export {
  PILOT_ID,
  PILOT_VERSION,
  PILOT_CAPABILITY_ID,
  PILOT_MESSAGE_SLOT,
  pilotSurfaceContract,
  validatePilotSurfaceContract,
  createStatusRegion,
  referenceStatusObservation,
  assertValidPilotObservation,
  pilotCapabilityDeclaration,
} from './src/pilot-status-region.mjs';

export {
  NOTIFICATION_A11Y,
  NOTIFICATION_CAPABILITY_ID,
  NOTIFICATION_DISPOSITIONS,
  NOTIFICATION_LIMITS,
  NOTIFICATION_MESSAGE_SLOT,
  NOTIFICATION_SEVERITIES,
  NOTIFICATION_SURFACE_ID,
  NOTIFICATION_SURFACE_VERSION,
  createNotificationSurface,
  notificationSurfaceContract,
  referenceEmptyNotificationObservation,
  referenceNotificationObservation,
  validateNotificationSurfaceContract,
} from './src/notification-surface.mjs';

export {
  WORKFLOW_LIST_A11Y,
  WORKFLOW_LIST_CAPABILITY_ID,
  WORKFLOW_LIST_LIMITS,
  WORKFLOW_LIST_MESSAGE_SLOT,
  WORKFLOW_LIST_ROW_FIELDS,
  WORKFLOW_LIST_SURFACE_ID,
  WORKFLOW_LIST_SURFACE_VERSION,
  createWorkflowListSurface,
  referenceEmptyObservation,
  referenceErrorObservation,
  referenceLoadingObservation,
  referenceReadyObservation,
  validateWorkflowListSurfaceContract,
  workflowListSurfaceContract,
} from './src/workflow-list.mjs';
