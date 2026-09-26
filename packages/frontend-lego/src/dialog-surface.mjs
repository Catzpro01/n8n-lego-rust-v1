/**
 * Dialogs / overlays pilot (P2-S03 Layer 3, surface `dialogs`).
 *
 * The second strangler slice of P2-S03's Layers 3-5, delivered in the same
 * focused, low-risk shape as the #241/#245/#240 pilots: **one additional
 * low-risk surface, `mode: pilot`, `rollback: pilot-not-primary`, the original
 * editor stays the default path.**
 *
 * WHAT THIS SURFACE IS. A framework-neutral view-model for a modal/overlay -
 * the one place a dialog is *described*, so a later migration can render it
 * without forking a second vocabulary. It is a view-model plus an observation,
 * never a framework component. It declares, requests and renders metadata; it
 * never authorizes and never executes. Confirming, cancelling or submitting a
 * dialog are *declared* interactions - the surface names them, the reference
 * (or a future primary) performs them.
 *
 * WHY it has no backend. The `dialogs` surface is frontend-owned: it carries no
 * backend capability of its own, it renders content whose capability belongs to
 * another surface (the workflow settings, the credential modal, a
 * confirmation). The content is **handed over** (`inputBoundary.source:
 * "hand-over"`), exactly as the other pilots hand over their state. The dialog
 * never fetches, so it holds no private data path and no second source of truth
 * for whatever capability the content came from.
 *
 * THE FOUR REGION STATES, REUSED NOT FORKED. The contract keys its `states` on
 * the closed `REGION_STATES` vocabulary (loading / empty / error / ready), the
 * same vocabulary the parity harness compares against the pinned reference. A
 * closed dialog - one that has no content to show - is `empty` at the region
 * level, not a fifth "closed" state; "preparing" is `loading`, "content shown"
 * is `ready`, "the content failed to render" is `error`.
 *
 * THE KIND DECIDES THE DECLARED ACTIONS. A dialog's `kind` (confirmation /
 * form / notice, a closed set) decides which actions are *declared* for the
 * ready state - confirm/cancel, submit/cancel, or acknowledge. The kind is part
 * of the handed-over payload; the dialog does not interpret or validate the
 * content beyond the closed shape and the bounds.
 *
 * BOUNDED. A dialog title and body are both bounded and both enforced: an
 * over-long title or body is refused, not silently truncated. A dialog with no
 * bound is an unbounded reflow on top of whatever screen it overlays.
 *
 * OPEN / CLOSE IS A REAL MUTATION. Unlike the purely declarative interactions,
 * opening (handing over content) and closing the dialog change what is VISIBLE,
 * and they are the behaviour a test can observe end to end: open, prepare,
 * fail, close. Closing is `empty`, which is how the reference tells a dismissed
 * dialog from one that is showing content.
 */
import {
  REGION_STATES,
  SURFACE_MODES,
  defineSurfaceContract,
  validateSurfaceContract,
} from './surface-contract.mjs';
import { observation } from './parity.mjs';
import { FrontendError, toDisplayModel, normalizeError } from './errors.mjs';
import { buildMessageKey } from './i18n.mjs';

/** Surface identity (must stay in sync with manifest/capabilities.json + surface-migrations.json). */
export const DIALOG_SURFACE_ID = 'ui.primitives.dialogs';
export const DIALOG_SURFACE_VERSION = '1.0.0';
export const DIALOG_CAPABILITY_ID = 'dialogs';

/** Reuse the existing i18n grammar. The `dialogs` slot owns modal titles/confirmations. */
export const DIALOG_MESSAGE_SLOT = 'dialogs';

/** Closed field set of a handed-over dialog payload. Unknown fields are refused. */
export const DIALOG_PAYLOAD_FIELDS = Object.freeze(['title', 'body', 'kind']);

/** Closed set of dialog kinds; the kind decides which actions are declared when ready. */
export const DIALOG_KINDS = Object.freeze(['confirmation', 'form', 'notice']);

/** Bounds: the title and body lengths are both bounded and both enforced. */
export const DIALOG_LIMITS = Object.freeze({
  maxTitleLength: 120,
  maxBodyLength: 4000,
});

/**
 * Accessibility intent per region state, derived once so the a11y observable
 * and the contract cannot drift apart.
 *
 * `error` is the only assertive state. `loading` is the only busy one. A
 * `ready` dialog is announced politely so a background refresh does not
 * interrupt. A `empty` (closed) dialog is hidden: a dismissed dialog that still
 * occupied a live region would still be announced.
 */
export const DIALOG_A11Y = Object.freeze({
  loading: Object.freeze({ role: 'status', 'aria-live': 'polite', 'aria-busy': true, hidden: false }),
  empty: Object.freeze({ role: 'region', 'aria-live': 'polite', 'aria-busy': false, hidden: true }),
  error: Object.freeze({ role: 'alert', 'aria-live': 'assertive', 'aria-busy': false, hidden: false }),
  ready: Object.freeze({ role: 'dialog', 'aria-live': 'polite', 'aria-busy': false, hidden: false }),
});

/** The closed set of dialog interactions, reported as booleans by observe(). */
export const DIALOG_INTERACTIONS = Object.freeze(['confirm', 'cancel', 'submit', 'acknowledge', 'retry', 'close']);

/** The state message key each region state carries, in the `dialogs` slot. */
const STATE_MESSAGE_NAME = Object.freeze({
  loading: 'preparing',
  empty: 'closed',
  error: 'render-error',
  ready: 'title',
});

function stateMessageKey(state) {
  return buildMessageKey(DIALOG_MESSAGE_SLOT, STATE_MESSAGE_NAME[state]);
}

/** The declared ready-state actions for a dialog kind, a closed mapping. */
const READY_ACTIONS = Object.freeze({
  confirmation: ['confirm', 'cancel'],
  form: ['submit', 'cancel'],
  notice: ['acknowledge'],
});

/* --------------------------------------------------------------- the contract */

/**
 * The migration contract. States reuse `REGION_STATES`; keys live in the
 * existing `dialogs` slot; rollback keeps the reference primary.
 */
export function dialogSurfaceContract() {
  return defineSurfaceContract({
    id: DIALOG_SURFACE_ID,
    version: DIALOG_SURFACE_VERSION,
    title: 'Dialogs / overlays (handed-over content, bounded, declared actions by kind)',
    mode: 'pilot',
    lifecycleState: 'available',
    capabilityRequirements: [
      {
        id: 'reference-ui',
        criticality: 'optional',
        degradation: {
          fallback: 'native-behavior',
          detail: 'without this surface the stock n8n modal/overlay presentation remains the path',
        },
      },
      {
        id: DIALOG_CAPABILITY_ID,
        criticality: 'optional',
        degradation: {
          fallback: 'native-behavior',
          detail: 'if the capability is absent, the reference modal/overlay stays primary',
        },
      },
    ],
    inputBoundary: {
      fields: ['title', 'body', 'kind', 'error', 'renderAvailable'],
      source: 'hand-over',
    },
    outputBoundary: {
      events: ['dialog:rendered', 'dialog:closed'],
      authority: 'declare-request-render',
    },
    interaction: 'event',
    transport: 'local',
    localization: {
      slot: DIALOG_MESSAGE_SLOT,
      fallbackLocale: 'en',
    },
    accessibility: {
      observables: ['role', 'aria-live', 'aria-busy', 'aria-label-key', 'hidden'],
    },
    states: {
      // The content is being prepared. Transient by nature; the only busy region.
      loading: { messageKey: stateMessageKey('loading') },
      // No content to show: the dialog is closed or was dismissed.
      empty: { messageKey: stateMessageKey('empty') },
      // The content failed to render. The only assertive region state.
      error: { messageKey: stateMessageKey('error'), errorKind: 'server' },
      // Content is shown.
      ready: { messageKey: stateMessageKey('ready') },
    },
    observability: {
      events: [
        'dialog.opened',
        'dialog.closed',
        'dialog.degraded',
      ],
    },
    rollback: {
      strategy: 'pilot-not-primary',
      reference: 'n8n-editor-ui@2.9.4',
    },
  });
}

/** Validate against the closed vocabularies, exactly like the #241/#245/#240 pilots do. */
export function validateDialogSurfaceContract(contract = dialogSurfaceContract(), catalog = {}) {
  return validateSurfaceContract(contract, catalog);
}

/* ------------------------------------------------------------- the view-model */

function assertPayloadShape(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('a dialog payload must be a plain object');
  }
  const keys = Object.keys(payload);
  for (const key of keys) {
    if (!DIALOG_PAYLOAD_FIELDS.includes(key)) {
      throw new Error(
        `dialog payload has unknown field "${key}" (allowed: ${DIALOG_PAYLOAD_FIELDS.join(', ')})`,
      );
    }
  }
  if (typeof payload.title !== 'string' || payload.title.length === 0) {
    throw new Error('dialog payload.title must be a non-empty string');
  }
  if (payload.body !== undefined && payload.body !== null && typeof payload.body !== 'string') {
    throw new Error('dialog payload.body must be a string or null when present');
  }
  if (payload.kind !== undefined && payload.kind !== null && !DIALOG_KINDS.includes(payload.kind)) {
    throw new Error(`dialog payload.kind must be one of ${DIALOG_KINDS.join(', ')}`);
  }
}

function normalizePayload(payload) {
  assertPayloadShape(payload);
  return Object.freeze({
    title: payload.title,
    body: payload.body ?? '',
    kind: payload.kind ?? 'notice',
  });
}

/**
 * Create a dialogs / overlays view-model.
 *
 * @param {object} [init]
 * @param {boolean} [init.renderAvailable] false = degradation (reference stays primary)
 * @param {string}  [init.locale]
 */
export function createDialogSurface(init = {}) {
  const contract = dialogSurfaceContract();
  let renderAvailable = init.renderAvailable !== false;
  const locale = init.locale ?? 'en';

  /** @type {readonly {title:string,body:string,kind:string} | null} */
  let payload = null;
  let region = 'empty';
  let error = null;
  const history = [];
  let degradedEvents = 0;

  function regionState() {
    return region;
  }

  function a11y() {
    const state = regionState();
    const intent = DIALOG_A11Y[state] ?? DIALOG_A11Y.empty;
    return Object.freeze({
      role: intent.role,
      'aria-live': intent['aria-live'],
      'aria-busy': intent['aria-busy'],
      hidden: intent.hidden,
      'aria-label-key': stateMessageKey(state),
    });
  }

  /** The declared actions for the current state and (when ready) the dialog kind. */
  function declaredActions() {
    const state = regionState();
    if (state === 'ready') return READY_ACTIONS[payload?.kind ?? 'notice'];
    if (state === 'loading') return ['close'];
    if (state === 'error') return ['retry', 'close'];
    return [];
  }

  function displayModel() {
    const state = regionState();
    const open = state !== 'empty';
    const errorDisplay = state === 'error' && error
      ? toDisplayModel(
          typeof error.kind === 'string'
            ? new FrontendError({
                kind: error.kind,
                code: error.code ?? null,
                messageKey: error.messageKey ?? undefined,
                message: error.message ?? undefined,
                status: typeof error.status === 'number' ? error.status : undefined,
              })
            : normalizeError(error),
        )
      : null;
    return Object.freeze({
      visible: open,
      open,
      regionState: state,
      loading: state === 'loading',
      empty: state === 'empty',
      error: state === 'error',
      title: payload?.title ?? null,
      body: payload?.body ?? null,
      kind: payload?.kind ?? null,
      messageKey: stateMessageKey(state),
      fallbackText: errorDisplay?.message ?? null,
      // Declared, never executed: the surface names what the user may ask for.
      actions: Object.freeze([...declaredActions()]),
      degraded: !renderAvailable,
    });
  }

  function pushEvent(name) {
    history.push({ event: name, at: history.length });
  }

  return Object.freeze({
    id: DIALOG_SURFACE_ID,
    version: DIALOG_SURFACE_VERSION,
    get mode() {
      return 'pilot';
    },
    contract: Object.freeze(contract),
    get regionState() {
      return regionState();
    },
    get open() {
      return regionState() !== 'empty';
    },
    get renderAvailable() {
      return renderAvailable;
    },
    /** Set rendering availability. Degradation is observable, never silent. */
    setRenderAvailable(next) {
      renderAvailable = next === true;
      if (!renderAvailable) {
        degradedEvents += 1;
        history.push({ event: 'degraded', at: history.length });
      }
      return renderAvailable;
    },
    /**
     * Hand over the content and open the dialog. Replaces the payload and the
     * region becomes `ready`. This is the `hand-over` input: the surface never
     * fetches, so it holds no private path to the content's owning capability.
     */
    openDialog(nextPayload) {
      const normalized = normalizePayload(nextPayload);
      if (normalized.title.length > DIALOG_LIMITS.maxTitleLength) {
        throw new Error(`dialog title exceeds ${DIALOG_LIMITS.maxTitleLength} characters`);
      }
      if (normalized.body.length > DIALOG_LIMITS.maxBodyLength) {
        throw new Error(`dialog body exceeds ${DIALOG_LIMITS.maxBodyLength} characters`);
      }
      payload = normalized;
      error = null;
      region = 'ready';
      pushEvent('opened');
      if (!renderAvailable) degradedEvents += 1;
      return 'ready';
    },
    /** The content failed to render. The only assertive region state. */
    contentFailure(nextError) {
      if (nextError === null || nextError === undefined || typeof nextError !== 'object') {
        throw new Error('contentFailure expects an error object');
      }
      error = nextError;
      region = 'error';
      pushEvent('failed');
      if (!renderAvailable) degradedEvents += 1;
      return 'error';
    },
    /** Back to preparing. The payload is retained but the region is `loading`. */
    setPreparing() {
      region = 'loading';
      pushEvent('preparing');
      return 'loading';
    },
    /**
     * The one dismiss mutation: close the dialog. The region becomes `empty`
     * and the payload is cleared - a dismissed dialog is gone, not a hidden
     * region that would still be announced.
     */
    closeDialog() {
      region = 'empty';
      payload = null;
      error = null;
      pushEvent('closed');
      return 'empty';
    },
    displayModel,
    a11y,
    /** Observable snapshot for the parity harness (candidate side). */
    observe() {
      const state = regionState();
      const model = displayModel();
      const actions = model.actions;
      return observation({
        surfaceId: DIALOG_SURFACE_ID,
        side: 'candidate',
        visible: model.visible,
        regionState: state,
        loading: state === 'loading',
        empty: state === 'empty',
        error: state === 'error' ? { kind: error?.kind ?? 'server' } : null,
        interactions: Object.freeze(
          DIALOG_INTERACTIONS.reduce((acc, name) => {
            acc[name] = actions.includes(name);
            return acc;
          }, {}),
        ),
        // A SNAPSHOT of the current state, not a replay of history: the events
        // describe what is true now, exactly as the #245 snapshot rule requires.
        events: Object.freeze(state === 'ready' ? ['dialog:rendered'] : []),
        accessibility: a11y(),
        localization: Object.freeze({ slot: DIALOG_MESSAGE_SLOT, locale }),
        contract: Object.freeze({ id: DIALOG_SURFACE_ID, version: DIALOG_SURFACE_VERSION }),
      });
    },
    /** Deterministic history, so two runs of the same script agree. */
    get history() {
      return Object.freeze(history.map((item) => Object.freeze({ ...item })));
    },
    get degradedEvents() {
      return degradedEvents;
    },
  });
}

/* -------------------------------------------------------- the reference model */

/**
 * The reference (pinned n8n editor) observations, as deterministic fixtures. The
 * reference UI is not run here - these are the declared behaviours the candidate
 * is compared against, fixtures precisely so the comparison is reproducible.
 * They mirror `observe()` field for field, which is what makes the parity
 * harness fail-closed: a fixture that drifts from the candidate is a bug.
 */

function referenceInteractions(actions) {
  return Object.freeze(
    DIALOG_INTERACTIONS.reduce((acc, name) => {
      acc[name] = actions.includes(name);
      return acc;
    }, {}),
  );
}

/** The reference dialog while its content is being prepared. The only busy state. */
export function referencePreparingObservation(locale = 'en') {
  return observation({
    surfaceId: DIALOG_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: 'loading',
    loading: true,
    empty: false,
    error: null,
    interactions: referenceInteractions(['close']),
    events: Object.freeze([]),
    accessibility: Object.freeze({
      role: 'status',
      'aria-live': 'polite',
      'aria-busy': true,
      hidden: false,
      'aria-label-key': stateMessageKey('loading'),
    }),
    localization: Object.freeze({ slot: DIALOG_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: DIALOG_SURFACE_ID, version: DIALOG_SURFACE_VERSION }),
  });
}

/** The reference closed dialog: no content to show, hidden. */
export function referenceClosedObservation(locale = 'en') {
  return observation({
    surfaceId: DIALOG_SURFACE_ID,
    side: 'reference',
    visible: false,
    regionState: 'empty',
    loading: false,
    empty: true,
    error: null,
    interactions: referenceInteractions([]),
    events: Object.freeze([]),
    accessibility: Object.freeze({
      role: 'region',
      'aria-live': 'polite',
      'aria-busy': false,
      hidden: true,
      'aria-label-key': stateMessageKey('empty'),
    }),
    localization: Object.freeze({ slot: DIALOG_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: DIALOG_SURFACE_ID, version: DIALOG_SURFACE_VERSION }),
  });
}

/** The reference dialog whose content failed to render. The only assertive state. */
export function referenceErrorObservation({ errorKind = 'server', locale = 'en' } = {}) {
  if (typeof errorKind !== 'string' || errorKind === '') {
    throw new Error('reference errorKind must be a non-empty string when given');
  }
  return observation({
    surfaceId: DIALOG_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: 'error',
    loading: false,
    empty: false,
    error: { kind: errorKind },
    interactions: referenceInteractions(['retry', 'close']),
    events: Object.freeze([]),
    accessibility: Object.freeze({
      role: 'alert',
      'aria-live': 'assertive',
      'aria-busy': false,
      hidden: false,
      'aria-label-key': stateMessageKey('error'),
    }),
    localization: Object.freeze({ slot: DIALOG_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: DIALOG_SURFACE_ID, version: DIALOG_SURFACE_VERSION }),
  });
}

/** The reference shown dialog: content visible, actions declared by kind. */
export function referenceReadyObservation({ kind = 'notice', locale = 'en' } = {}) {
  if (!DIALOG_KINDS.includes(kind)) {
    throw new Error(`reference kind must be one of ${DIALOG_KINDS.join(', ')}`);
  }
  return observation({
    surfaceId: DIALOG_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: 'ready',
    loading: false,
    empty: false,
    error: null,
    interactions: referenceInteractions(READY_ACTIONS[kind]),
    events: Object.freeze(['dialog:rendered']),
    accessibility: Object.freeze({
      role: 'dialog',
      'aria-live': 'polite',
      'aria-busy': false,
      hidden: false,
      'aria-label-key': stateMessageKey('ready'),
    }),
    localization: Object.freeze({ slot: DIALOG_MESSAGE_SLOT, locale }),
    contract: Object.freeze({ id: DIALOG_SURFACE_ID, version: DIALOG_SURFACE_VERSION }),
  });
}

export { REGION_STATES, SURFACE_MODES };
