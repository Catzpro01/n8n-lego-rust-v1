/**
 * SETTINGS LEGO — `GET /rest/settings`, the single object the editor reads on
 * boot.
 *
 * Field set mirrors `FrontendSettings` from `@n8n/api-types` (n8n 2.9.4,
 * `packages/@n8n/api-types/src/frontend-settings.ts`). The editor indexes into
 * this object without defensive checks, so every documented field is present —
 * an absent key surfaces as a blank page rather than a network error.
 *
 * Feature flags here must describe this instance truthfully: a flag set just to
 * make a menu appear advertises a capability the backend does not have (the
 * compatibility layer then answers its endpoints with the explicit 501
 * "unsupported" semantics). Community defaults follow upstream
 * (`@n8n/config`): `hideUsagePage` defaults to false, enterprise features off.
 */

const ENDPOINT_FORM = 'form';
const ENDPOINT_FORM_TEST = 'form-test';
const ENDPOINT_FORM_WAITING = 'form-waiting';
const ENDPOINT_MCP = 'mcp';
const ENDPOINT_MCP_TEST = 'mcp-test';
const ENDPOINT_WEBHOOK = 'webhook';
const ENDPOINT_WEBHOOK_TEST = 'webhook-test';
const ENDPOINT_WEBHOOK_WAITING = 'webhook-waiting';
const ENDPOINT_HEALTH = 'healthz';

/**
 * Instance base URL **without** a trailing slash, including the configured base
 * path — mirrors `UrlService.getInstanceBaseUrl()`.
 */
function origin(config, requestOrigin) {
  const raw = (requestOrigin ?? config.publicUrl).replace(/\/+$/, '');
  const path = config.basePath === '/' ? '' : config.basePath.replace(/\/+$/, '');
  return `${raw}${path}`;
}

/** Webhook base URL always ends with a slash — mirrors `getWebhookBaseUrl()`. */
function webhookOrigin(config, requestOrigin) {
  return `${origin(config, requestOrigin)}/`;
}

function url(config, path, requestOrigin) {
  return `${origin(config, requestOrigin)}/${config.restEndpoint}/${path}`;
}

/** Bare endpoint segments, like `endpoints.*` in @n8n/config. */
function segments(config) {
  return {
    form: config.formEndpoint,
    formTest: config.formTestEndpoint,
    formWaiting: config.formWaitingEndpoint,
    webhook: config.webhookEndpoint,
    webhookTest: config.webhookTestEndpoint,
    webhookWaiting: config.webhookWaitingEndpoint,
  };
}

/**
 * @param {object} config
 * @param {{ hasOwner?: boolean, requestOrigin?: string|null, dismissedBanners?: string[] }} [options]
 *   `requestOrigin` wins over the configured public URL so that a reverse proxy
 *   (nginx, Caddy, the Arena preview) produces correct webhook and OAuth
 *   callback URLs without extra configuration.
 */
export function buildFrontendSettings(config, { hasOwner = false, requestOrigin = null, dismissedBanners = [] } = {}) {
  const userManagementQuota = -1;

  return {
    settingsMode: 'authenticated',
    inE2ETests: false,
    isDocker: false,
    databaseType: 'sqlite',
    endpointForm: segments(config).form,
    endpointFormTest: segments(config).formTest,
    endpointFormWaiting: segments(config).formWaiting,
    endpointMcp: ENDPOINT_MCP,
    endpointMcpTest: ENDPOINT_MCP_TEST,
    endpointWebhook: segments(config).webhook,
    endpointWebhookTest: segments(config).webhookTest,
    endpointWebhookWaiting: segments(config).webhookWaiting,
    endpointHealth: ENDPOINT_HEALTH,

    saveDataErrorExecution: config.saveDataErrorExecution,
    saveDataSuccessExecution: config.saveDataSuccessExecution,
    saveManualExecutions: config.saveManualExecutions,
    saveExecutionProgress: config.saveExecutionProgress,
    executionTimeout: Math.round(config.executionTimeoutMs / 1000),
    maxExecutionTimeout: config.maxExecutionTimeout,
    workflowCallerPolicyDefaultOption: 'workflowsFromSameOwner',

    oauthCallbackUrls: {
      oauth1: url(config, 'oauth1-credential/callback', requestOrigin),
      oauth2: url(config, 'oauth2-credential/callback', requestOrigin),
    },
    timezone: config.timezone,
    // The editor appends the bare endpoint segment to these: the webhook base
    // keeps its trailing slash, the editor base must not have one.
    urlBaseWebhook: webhookOrigin(config, requestOrigin),
    urlBaseEditor: origin(config, requestOrigin),
    versionCli: config.referenceVersion,
    nodeJsVersion: process.versions.node,
    nodeEnv: config.env,
    concurrency: 1,
    authCookie: { secure: config.protocol === 'https' },
    binaryDataMode: 'default',
    releaseChannel: 'stable',

    n8nMetadata: { userId: config.instanceId },
    versionNotifications: {
      enabled: config.versionNotificationsEnabled,
      endpoint: '',
      whatsNewEnabled: false,
      whatsNewEndpoint: '',
      infoUrl: 'https://docs.n8n.io/',
    },
    dynamicBanners: { endpoint: '', enabled: false },
    instanceId: config.instanceId,
    telemetry: { enabled: false },
    posthog: {
      enabled: false,
      apiHost: '',
      apiKey: '',
      autocapture: false,
      disableSessionRecording: true,
      debug: false,
      proxy: '',
    },

    dataTables: { maxSize: 0 },
    personalizationSurveyEnabled: false,
    defaultLocale: config.locale,
    userManagement: {
      quota: userManagementQuota,
      showSetupOnFirstLoad: !hasOwner,
      smtpSetup: false,
      authenticationMethod: 'email',
    },
    sso: {
      saml: { loginLabel: '', loginEnabled: false },
      oidc: { loginEnabled: false, loginUrl: '', callbackUrl: '' },
      ldap: { loginLabel: '', loginEnabled: false },
    },
    publicApi: {
      enabled: true,
      latestVersion: 1,
      path: `${config.basePath}api/v1`,
      // P5-M03 serves /api/v1 but not yet /api/v1/docs; advertising the
      // playground would hand the editor a dead link.
      swaggerUi: { enabled: false },
    },
    workflowTagsDisabled: false,
    logLevel: config.logLevel,
    hiringBannerEnabled: false,
    previewMode: false,
    templates: { enabled: false, host: '' },
    missingPackages: false,
    executionMode: 'regular',
    isMultiMain: false,
    /** n8n lego always speaks the WebSocket protocol the editor expects. */
    pushBackend: 'websocket',
    communityNodesEnabled: config.communityNodesEnabled,
    unverifiedCommunityNodesEnabled: false,
    aiAssistant: { enabled: false, setup: false },
    taskAi: { enabled: false },
    aiBuilder: { enabled: false, setup: false },
    deployment: { type: 'n8n-lego' },
    allowedModules: { builtIn: ['*'], external: [] },
    enterprise: enterpriseSettings(),
    // Upstream default is false (`@n8n/config` N8N_HIDE_USAGE_PAGE): community
    // n8n shows "Usage and plan". It is configurable, never hardcoded.
    hideUsagePage: config.hideUsagePage,
    license: {
      planName: 'n8n lego (community)',
      consumerId: config.instanceId,
      environment: config.env === 'production' ? 'production' : 'development',
    },
    variables: { limit: 0 },
    // P5.6: TOTP MFA is implemented (auth/account-routes.mjs). Enforcement is an
    // enterprise-licensed upstream feature and stays off.
    mfa: { enabled: true, enforced: false },
    folders: { enabled: false },
    banners: { dismissed: dismissedBanners },
    workflowHistory: { pruneTime: -1, licensePruneTime: -1 },
    aiCredits: { enabled: false, credits: 0, setup: false },
    ai: { allowSendingParameterValues: false },
    security: { blockFileAccessToN8nFiles: true },
    easyAIWorkflowOnboarded: true,
    evaluation: { quota: 0 },
    activeModules: [],
    envFeatureFlags: {},
  };
}

/** Community edition: every enterprise capability is off. */
function enterpriseSettings() {
  return {
    sharing: false,
    ldap: false,
    saml: false,
    oidc: false,
    mfaEnforcement: false,
    logStreaming: false,
    advancedExecutionFilters: false,
    variables: false,
    sourceControl: false,
    auditLogs: false,
    externalSecrets: false,
    showNonProdBanner: false,
    debugInEditor: false,
    binaryDataS3: false,
    workerView: false,
    advancedPermissions: false,
    // P5.7: requested key scopes are honoured and attenuated to the role, so
    // the editor shows the scope picker (upstream gates it behind a licence).
    apiKeyScopes: true,
    workflowDiffs: false,
    namedVersions: false,
    provisioning: false,
    projects: { team: { limit: 0 } },
    customRoles: false,
    personalSpacePolicy: false,
  };
}
