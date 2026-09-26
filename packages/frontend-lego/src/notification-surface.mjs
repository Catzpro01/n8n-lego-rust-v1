/**
 * Shared notification surface (Issue #245 §Scope B + C + E).
 *
 * Exactly ONE additional low-risk shared UI surface after the #241 status-region
 * pilot, and the rule that shapes it is the same one #241 set: **the LEGO layer
 * declares, requests and renders metadata; it never authorizes and never becomes
 * the primary UI path.** The original n8n editor stays the default.
 *
 * WHAT THIS SURFACE IS. A framework-neutral notification/status surface: the one
 * place a toast, a banner or an inline notice is *described*, so that a later
 * migration can host all three without forking a second vocabulary. It is a
 * view-model plus an observation, never a framework component.
 *
 * TWO AXES, NOT ONE. Issue #245 asks for five observable states — info, success,
 * warning, error and dismissed — while the surface contract (and the parity
 * harness that compares against the pinned reference) is keyed on the closed
 * `REGION_STATES` vocabulary: loading / empty / error / ready. Those are not the
 * same question and collapsing them loses information:
 *
 *   - **region state** answers *what is the surface doing right now*. This is
 *     what the harness compares, and it is why the contract reuses
 *     `REGION_STATES` verbatim instead of inventing a parallel list.
 *   - **severity** answers *what kind of notice is it*. info / success / warning
 *     / error. A `ready` region can carry any of the three non-error severities
 *     and an `error` region carries the fourth.
 *   - **dismissed** is neither: it is a DISPOSITION. A dismissed notification is
 *     removed from the live region, so the region becomes `empty`.
 *
 * WHY dismissal is a disposition and not a sixth region state: a dismissed notice
 * that still occupied a region state would still be announced. The whole point of
 * dismissal is that the screen reader stops talking about it, and that only works
 * if the region it lived in goes away.
 *
 * NO AMBIENT RENDERING. `renderAvailable: false` is the degradation case from
 * §Scope B. The surface does not throw and does not silently pretend: every
 * transition is still recorded deterministically, so the observable history is
 * the same with and without a renderer, and a consumer can tell the difference by
 * asking rather than by watching for a crash.
 *
 * BOUNDED. The queue has a ceiling. A notification surface with no bound is an
 * unbounded memory leak wearing a UI costume, so the oldest non-error entry is
 * dropped when the bound is exceeded — errors are never silently dropped, because
 * the one notification an operator must not lose is the one saying something
 * broke.
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
export const NOTIFICATION_SURFACE_ID = 'ui.primitives.notification-surface';
export const NOTIFICATION_SURFACE_VERSION = '1.0.0';
export const NOTIFICATION_CAPABILITY_ID = 'notification-surface';

/** Reuse the existing i18n grammar. No second localization model. */
export const NOTIFICATION_MESSAGE_SLOT = 'system-messages';

/** The severity axis. A closed vocabulary: an unknown severity is refused. */
export const NOTIFICATION_SEVERITIES = Object.freeze(['info', 'success', 'warning', 'error']);

/** Severities that may occupy a `ready` region. `error` has its own region state. */
export const NON_ERROR_SEVERITIES = Object.freeze(['info', 'success', 'warning']);

/** The disposition axis. Dismissal removes the notice from the live region. */
export const NOTIFICATION_DISPOSITIONS = Object.freeze(['shown', 'dismissed']);

/** Bounds. The queue is bounded and the message key length is bounded. */
export const NOTIFICATION_LIMITS = Object.freeze({
  maxVisible: 8,
  maxMessageKeyLength: 128,
  maxParams: 16,
});

/**
 * Accessibility intent per severity, derived once so the a11y observable and the
 * contract cannot drift apart.
 *
 * `error` is the only assertive one. Making `warning` assertive too is the common
 * mistake: it turns every caution into an interruption, and a user who is
 * interrupted constantly learns to dismiss the live region without reading it.
 */
export const NOTIFICATION_A11Y = Object.freeze({
  info: Object.freeze({ role: 'status', 'aria-live': 'polite' }),
  success: Object.freeze({ role: 'status', 'aria-live': 'polite' }),
  warning: Object.freeze({ role: 'status', 'aria-live': 'polite' }),
  error: Object.freeze({ role: 'alert', 'aria-live': 'assertive' }),
});

/** The message key each severity defaults to, in the existing slot. */
const SEVERITY_MESSAGE_NAME = Object.freeze({
  info: 'notification-info',
  success: 'notification-success',
  warning: 'notification-warning',
  error: 'notification-error',
});

function severityMessageKey(severity) {
  return buildMessageKey(NOTIFICATION_MESSAGE_SLOT, SEVERITY_MESSAGE_NAME[severity]);
}

/* --------------------------------------------------------------- the contract */

/**
 * The migration contract. States reuse `REGION_STATES`; keys live in the existing
 * `system-messages` slot; rollback keeps the reference primary.
 */
export function notificationSurfaceContract() {
  return defineSurfaceContract({
    id: NOTIFICATION_SURFACE_ID,
    version: NOTIFICATION_SURFACE_VERSION,
    title: 'Notification surface (info / success / warning / error / dismissed)',
    mode: 'pilot',
    lifecycleState: 'available',
    capabilityRequirements: [
      {
        id: 'reference-ui',
        criticality: 'optional',
        degradation: {
          fallback: 'native-behavior',
          detail: 'without this surface the stock n8n toast/banner presentation remains the path',
        },
      },
      {
        id: NOTIFICATION_CAPABILITY_ID,
        criticality: 'optional',
        degradation: {
          fallback: 'native-behavior',
          detail: 'if the capability is absent, surfaces keep the reference notification presentation',
        },
      },
    ],
    inputBoundary: {
      fields: ['severity', 'messageKey', 'params', 'error', 'renderAvailable'],
      source: 'hand-over',
    },
    outputBoundary: {
      events: ['notification:shown', 'notification:dismissed', 'notification:dropped'],
      authority: 'declare-request-render',
    },
    interaction: 'event',
    transport: 'local',
    localization: {
      slot: NOTIFICATION_MESSAGE_SLOT,
      fallbackLocale: 'en',
    },
    accessibility: {
      observables: ['role', 'aria-live', 'aria-label-key', 'hidden'],
    },
    states: {
      // A notice whose severity is still being resolved. Transient by nature.
      loading: { messageKey: severityMessageKey('info') },
      // Nothing to announce: the queue is empty, or everything was dismissed.
      empty: { messageKey: buildMessageKey(NOTIFICATION_MESSAGE_SLOT, 'notification-empty') },
      // An error notice. The only assertive region state.
      error: { messageKey: severityMessageKey('error'), errorKind: 'network' },
      // A non-error notice is showing.
      ready: { messageKey: severityMessageKey('info') },
    },
    observability: {
      events: [
        'notification.shown',
        'notification.dismissed',
        'notification.dropped',
        'notification.degraded',
      ],
    },
    rollback: {
      strategy: 'pilot-not-primary',
      reference: 'n8n-editor-ui@2.9.4',
    },
  });
}

/** Validate against the closed vocabularies, exactly like the #241 pilot does. */
export function validateNotificationSurfaceContract(contract = notificationSurfaceContract(), catalog = {}) {
  return validateSurfaceContract(contract, catalog);
}

/* ------------------------------------------------------------- the view-model */

function assertSeverity(severity) {
  if (!NOTIFICATION_SEVERITIES.includes(severity)) {
    throw new Error(
      `notification severity "${severity}" must be one of ${NOTIFICATION_SEVERITIES.join(', ')}`,
    );
  }
}

/**
 * Create a notification surface view-model.
 *
 * @param {object} [init]
 * @param {number} [init.maxVisible]   queue bound
 * @param {boolean} [init.renderAvailable]  false = degradation (§Scope B)
 * @param {string} [init.locale]
 */
export function createNotificationSurface(init = {}) {
  const contract = notificationSurfaceContract();
  const maxVisible = Number.isInteger(init.maxVisible) && init.maxVisible > 0
    ? Math.min(init.maxVisible, NOTIFICATION_LIMITS.maxVisible)
    : NOTIFICATION_LIMITS.maxVisible;
  let renderAvailable = init.renderAvailable !== false;
  const locale = init.locale ?? 'en';

  /** @type {Array<{id:string, severity:string, messageKey:string, params:object, error:object|null, disposition:string}>} */
  const entries = [];
  const history = [];
  let nextId = 1;
  let degradedEvents = 0;

  function regionState() {
    // ONE rule, derived from the ONE leading-notice accessor. The region is empty
    // when nothing is VISIBLE — not when the array is empty: entries are marked
    // dismissed and kept for the history, so counting the array would report a
    // `ready` region for a surface the user has dismissed everything from, and a
    // live region that keeps announcing after the user cleared it is the bug this
    // whole disposition axis exists to prevent.
    //
    // This used to test `entries.some(severity === 'error')`, which scans DISMISSED
    // entries too. Dismissing an error while a success toast stayed visible
    // therefore reported an `error` region whose leading notice was the toast, so
    // the region said error while severity, displayModel and a11y all said
    // success — and observe() emitted `regionState: 'error'` with a fabricated
    // `error.kind: 'network'` that no error ever supplied. Exactly the drift this
    // accessor exists to prevent, reintroduced one line below the comment
    // explaining why it must not happen.
    const leading = leadingEntry();
    if (!leading) return 'empty';
    // The most severe visible notice decides the region: an error must never be
    // masked by a success toast sitting in front of it.
    return leading.severity === 'error' ? 'error' : 'ready';
  }

  function visibleEntries() {
    return entries.filter((entry) => entry.disposition === 'shown');
  }

  /**
   * The notice the surface is actually presenting: the most severe VISIBLE one.
   *
   * One rule, one place. An earlier draft derived the leading notice three times —
   * for the region state, for the severity getter and for the display model — and
   * they disagreed: the region could be `error` while the severity getter reported
   * the `success` toast that happened to arrive last. An operator reading
   * "severity: success" on an error region is being told the wrong thing.
   */
  function leadingEntry() {
    const shown = visibleEntries();
    if (shown.length === 0) return null;
    return shown.find((entry) => entry.severity === 'error') ?? shown.at(-1);
  }

  function a11y() {
    const state = regionState();
    if (state === 'empty') {
      // An empty region is not announced at all: there is nothing to say, and a
      // live region that fires on "nothing changed" trains users to ignore it.
      return Object.freeze({ role: 'presentation', 'aria-live': 'off', hidden: true, 'aria-label-key': null });
    }
    // No `?? entries.at(-1)` fallback: a non-empty region always has a visible
    // leading notice, and reaching for a dismissed one is the bug above.
    const leading = leadingEntry();
    const intent = NOTIFICATION_A11Y[leading.severity] ?? NOTIFICATION_A11Y.info;
    return Object.freeze({
      role: intent.role,
      'aria-live': intent['aria-live'],
      hidden: false,
      'aria-label-key': leading.messageKey,
    });
  }

  function displayModel() {
    const state = regionState();
    if (state === 'empty') {
      return Object.freeze({
        visible: false,
        severity: null,
        messageKey: contract.states.empty.messageKey,
        params: Object.freeze({}),
        fallbackText: null,
        actions: Object.freeze([]),
        degraded: !renderAvailable,
      });
    }
    const leading = leadingEntry();
    const errorDisplay = leading.severity === 'error' && leading.error
      ? toDisplayModel(
          typeof leading.error.kind === 'string'
            ? new FrontendError({
                kind: leading.error.kind,
                code: leading.error.code ?? null,
                messageKey: leading.error.messageKey ?? undefined,
                message: leading.error.message ?? undefined,
                status: typeof leading.error.status === 'number' ? leading.error.status : undefined,
              })
            : normalizeError(leading.error),
        )
      : null;
    return Object.freeze({
      visible: true,
      severity: leading.severity,
      messageKey: leading.messageKey,
      params: Object.freeze({ ...leading.params }),
      fallbackText: errorDisplay?.message ?? null,
      actions: Object.freeze(['dismiss']),
      degraded: !renderAvailable,
    });
  }

  function push(severity, options = {}) {
    assertSeverity(severity);
    if (typeof options.messageKey === 'string' && options.messageKey.length > NOTIFICATION_LIMITS.maxMessageKeyLength) {
      throw new Error(
        `notification messageKey exceeds ${NOTIFICATION_LIMITS.maxMessageKeyLength} characters`,
      );
    }
    // `maxParams` was declared in NOTIFICATION_LIMITS but never enforced anywhere,
    // so a consumer reading the declared bound and trusting it could hand the
    // surface ten thousand interpolation parameters and have every one accepted. A
    // bound that is published but not checked is worse than no bound: it moves the
    // failure to whoever believed it.
    if (options.params !== undefined && options.params !== null) {
      if (typeof options.params !== 'object' || Array.isArray(options.params)) {
        throw new Error('notification params must be a plain object');
      }
      const count = Object.keys(options.params).length;
      if (count > NOTIFICATION_LIMITS.maxParams) {
        throw new Error(
          `notification params exceed ${NOTIFICATION_LIMITS.maxParams} entries (got ${count})`,
        );
      }
    }
    // Deliberately NOT frozen: `disposition` is mutated by dismiss and by the
    // bounded-drop rule, and freezing it here would make the surface throw on its
    // own first dismissal. Only what leaves the surface is frozen.
    const entry = {
      id: `n${nextId++}`,
      severity,
      messageKey: options.messageKey ?? severityMessageKey(severity),
      params: Object.freeze({ ...(options.params ?? {}) }),
      error: options.error ?? null,
      disposition: 'shown',
    };
    entries.push(entry);
    history.push({ event: 'shown', id: entry.id, severity, at: history.length });

    // Bounded: drop the oldest SHOWN non-error entry. Errors are never dropped
    // silently — the one notice an operator must not lose is the one saying
    // something broke.
    const shown = visibleEntries();
    if (shown.length > maxVisible) {
      const droppable = shown.find((item) => item.severity !== 'error');
      if (droppable) {
        droppable.disposition = 'dismissed';
        history.push({ event: 'dropped', id: droppable.id, severity: droppable.severity, at: history.length });
      }
    }
    if (!renderAvailable) degradedEvents += 1;
    return entry.id;
  }

  return Object.freeze({
    id: NOTIFICATION_SURFACE_ID,
    version: NOTIFICATION_SURFACE_VERSION,
    get mode() {
      return 'pilot';
    },
    contract: Object.freeze(contract),
    get severity() {
      const leading = leadingEntry();
      return leading ? leading.severity : null;
    },
    get regionState() {
      return regionState();
    },
    get renderAvailable() {
      return renderAvailable;
    },
    get queueLength() {
      return entries.length;
    },
    get visibleCount() {
      return visibleEntries().length;
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
    /** Show a notice. Returns its id. */
    show(severity, options = {}) {
      return push(severity, options);
    },
    info: (options) => push('info', options),
    success: (options) => push('success', options),
    warning: (options) => push('warning', options),
    error: (options) => push('error', options),
    /**
     * Dismiss a notice. The disposition changes and the region it occupied goes
     * away, so a screen reader stops announcing it. Dismissing an unknown id is a
     * no-op that is still recorded, never a throw: a stale dismiss must not take
     * the surface down.
     */
    dismiss(id) {
      const entry = entries.find((item) => item.id === id) ?? null;
      if (!entry) {
        history.push({ event: 'dismissed', id: String(id), unknown: true, at: history.length });
        return false;
      }
      if (entry.disposition === 'dismissed') return false;
      entry.disposition = 'dismissed';
      history.push({ event: 'dismissed', id: entry.id, severity: entry.severity, at: history.length });
      return true;
    },
    /** Dismiss everything. */
    dismissAll() {
      let dismissed = 0;
      for (const entry of visibleEntries()) {
        entry.disposition = 'dismissed';
        history.push({ event: 'dismissed', id: entry.id, severity: entry.severity, at: history.length });
        dismissed += 1;
      }
      return dismissed;
    },
    displayModel,
    a11y,
    /** Observable snapshot for the parity harness (candidate side). */
    observe() {
      const state = regionState();
      const model = displayModel();
      return observation({
        surfaceId: NOTIFICATION_SURFACE_ID,
        side: 'candidate',
        visible: model.visible,
        regionState: state,
        loading: false,
        empty: state === 'empty',
        error: state === 'error'
          ? { kind: leadingEntry()?.error?.kind ?? 'network' }
          : null,
        interactions: Object.freeze({ dismiss: model.actions.includes('dismiss') }),
        // A SNAPSHOT, not a replay. This used to map every 'shown' entry in the
        // cumulative history to a 'notification:shown' event, so a surface the user had
        // dismissed everything from still reported a shown event — and because the
        // harness compares events as a set, that single stale entry made an otherwise
        // perfect empty surface classify as `migration-required` against the empty
        // reference. Every other field was equal; only the event stream disagreed.
        //
        // The disposition axis had already removed the dismissed notice from the
        // region state, the a11y attributes and the display model, but not from here —
        // which is the same bug wearing a different hat: a dismissed notice that is
        // still being reported. The cumulative log is what `history` is for; an
        // observation that replays it is not a snapshot, and it also grew without
        // bound, allocating one string per notice ever shown on every observe() call.
        events: Object.freeze(visibleEntries().length > 0 ? ['notification:shown'] : []),
        accessibility: a11y(),
        localization: Object.freeze({ slot: NOTIFICATION_MESSAGE_SLOT, locale }),
        contract: Object.freeze({ id: NOTIFICATION_SURFACE_ID, version: NOTIFICATION_SURFACE_VERSION }),
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
 * The reference (pinned n8n editor) observation for a severity, as a deterministic
 * fixture. The reference UI is not run here — this is the declared behavior the
 * candidate is compared against, and it is a fixture precisely so the comparison
 * is reproducible rather than dependent on a browser.
 */
export function referenceNotificationObservation(severity, { errorKind = 'network' } = {}) {
  assertSeverity(severity);
  if (typeof errorKind !== 'string' || errorKind === '') {
    throw new Error('reference errorKind must be a non-empty string when given');
  }
  const intent = NOTIFICATION_A11Y[severity];
  const isError = severity === 'error';
  // The modelled error kind is EXPLICIT and overridable rather than hardcoded. It
  // defaults to the contract's declared `errorKind: 'network'`, so existing callers are
  // unchanged — but the parity suite only ever pushed errors with no payload, which
  // meant `observe()`'s fallback happened to match and a real consumer-supplied kind
  // (`timeout`, `auth`) was never compared against anything. The harness only compares
  // a kind when BOTH sides declare one, so with no way to model a different reference
  // kind the only way to make a timeout error classify was to change the consumer's
  // error or to change this fixture. Now a declared reference kind can be pinned.
  return observation({
    surfaceId: NOTIFICATION_SURFACE_ID,
    side: 'reference',
    visible: true,
    regionState: isError ? 'error' : 'ready',
    loading: false,
    empty: false,
    error: isError ? { kind: errorKind } : null,
    interactions: Object.freeze({ dismiss: true }),
    events: Object.freeze(['notification:shown']),
    accessibility: Object.freeze({
      role: intent.role,
      'aria-live': intent['aria-live'],
      hidden: false,
      'aria-label-key': severityMessageKey(severity),
    }),
    localization: Object.freeze({ slot: NOTIFICATION_MESSAGE_SLOT, locale: 'en' }),
    contract: Object.freeze({ id: NOTIFICATION_SURFACE_ID, version: NOTIFICATION_SURFACE_VERSION }),
  });
}

/** The reference observation for an empty surface: nothing to announce. */
export function referenceEmptyNotificationObservation() {
  return observation({
    surfaceId: NOTIFICATION_SURFACE_ID,
    side: 'reference',
    visible: false,
    regionState: 'empty',
    loading: false,
    empty: true,
    error: null,
    interactions: Object.freeze({ dismiss: false }),
    events: Object.freeze([]),
    accessibility: Object.freeze({ role: 'presentation', 'aria-live': 'off', hidden: true, 'aria-label-key': null }),
    localization: Object.freeze({ slot: NOTIFICATION_MESSAGE_SLOT, locale: 'en' }),
    contract: Object.freeze({ id: NOTIFICATION_SURFACE_ID, version: NOTIFICATION_SURFACE_VERSION }),
  });
}

export { REGION_STATES, SURFACE_MODES };
