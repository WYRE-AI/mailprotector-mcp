/**
 * Elicitation helpers for MCP tool handlers — SDK v2 MRTR seam.
 *
 * Under the 2026-07-28 protocol there is no server→client request channel:
 * a handler that needs input RETURNS an `input_required` result (built with
 * the SDK's `inputRequired()` builder). The client fulfils the embedded
 * `elicitation/create` request and retries the ORIGINAL request with
 * `inputResponses`; on 2025-era stateful connections (e.g. stdio) the SDK's
 * default-on legacy shim fulfils the same return server-side. Either way the
 * handler re-executes from the top on retry, so handlers must complete all
 * reads and elicitation BEFORE the single mutating vendor call.
 *
 * NO module-scope server-ref global: in a per-request stateless design that
 * is a cross-request race. The context is threaded explicitly, per request,
 * from the tools/call handler.
 *
 * Fallback posture (per the Mailprotector integration contract): when the
 * caller never declared form-elicitation capability — including the
 * stateless legacy path, where per-request instances see no `initialize` —
 * helpers report `unavailable` and delete confirmations FALL BACK TO
 * PROCEEDING. Elicitation here is purely additive UX: the production
 * non-interactive caller (the WYRE Conduit gateway) enforces destructive-tool
 * access server-side via its own per-tool read/write/admin classification
 * gate, so the confirmation prompt is a second layer for interactive
 * clients, not the only gate.
 */
import { inputRequired, inputResponse } from "@modelcontextprotocol/server";
import type { ClientCapabilities, InputRequiredResult } from "@modelcontextprotocol/server";

/** Per-request elicitation context, threaded in by the tools/call handler. */
export interface ElicitationContext {
  /**
   * The caller's declared capabilities: per-request envelope on 2026-07-28
   * requests, `initialize`-scoped on 2025-era connections, undefined on the
   * stateless legacy path (no elicitation is possible there).
   */
  clientCapabilities?: ClientCapabilities;
  /** MRTR input responses carried by a retried request (untrusted input). */
  inputResponses?: Record<string, unknown>;
}

/** The context used when no elicitation is possible (tests, direct calls). */
export const NO_ELICITATION: ElicitationContext = {};

/** The outcome of one elicitation point — four-way, never `T | null`. */
export type ElicitOutcome<T> =
  /** The user answered — proceed with the value. */
  | { kind: "answer"; value: T }
  /** The user explicitly declined or cancelled. */
  | { kind: "declined" }
  /** Return `result` from the tool handler; the caller retries with the answer. */
  | { kind: "ask"; result: InputRequiredResult }
  /** The caller cannot answer elicitation — use the pre-elicitation fallback. */
  | { kind: "unavailable" };

/**
 * Whether the caller declared form-mode elicitation. A bare
 * `elicitation: {}` declaration counts as form (the pre-mode 2025 meaning),
 * mirroring the SDK's own capability gate.
 */
function supportsFormElicitation(ctx: ElicitationContext): boolean {
  const elicitation = ctx.clientCapabilities?.elicitation;
  if (elicitation === undefined) return false;
  return elicitation.form !== undefined || Object.keys(elicitation).length === 0;
}

/**
 * Shared MRTR seam: read the retried request's response for `key`, or build
 * the `input_required` result asking for it. `read` extracts the typed
 * answer from accepted content; `undefined` reads as a decline (the values
 * arrive from the client and are untrusted).
 */
function elicit<T>(
  ctx: ElicitationContext,
  key: string,
  properties: Record<string, unknown>,
  message: string,
  read: (content: Record<string, unknown>) => T | undefined
): ElicitOutcome<T> {
  const response = inputResponse(ctx.inputResponses, key);
  if (response.kind === "elicit") {
    if (response.action === "accept" && response.content) {
      const value = read(response.content);
      if (value !== undefined) return { kind: "answer", value };
    }
    return { kind: "declined" };
  }
  if (!supportsFormElicitation(ctx)) return { kind: "unavailable" };
  return {
    kind: "ask",
    result: inputRequired({
      inputRequests: {
        [key]: inputRequired.elicit({
          message,
          requestedSchema: {
            type: "object",
            properties,
            required: [key],
          } as Parameters<typeof inputRequired.elicit>[0]["requestedSchema"],
        }),
      },
    }),
  };
}

/**
 * Ask the user to confirm an action (keyed `confirm`). An accepted
 * `confirm: false` reads as an answer of `false`, which — like `declined` —
 * means cancel.
 */
export function elicitConfirmation(
  ctx: ElicitationContext,
  message: string
): ElicitOutcome<boolean> {
  return elicit(
    ctx,
    "confirm",
    {
      confirm: {
        type: "boolean",
        title: "Confirm",
        description: "Confirm this action",
      },
    },
    message,
    (content) => (typeof content.confirm === "boolean" ? content.confirm : undefined)
  );
}

/** What a delete handler should do next. */
export type DeleteGate =
  /** Confirmed (or the caller cannot be prompted) — run the mutation. */
  | { kind: "proceed" }
  /** Return `result`; the caller retries with the user's answer. */
  | { kind: "ask"; result: InputRequiredResult }
  /** The user said no — cancel, in the handler's own words. */
  | { kind: "refused" };

/**
 * The confirmation gate for delete operations. Interactive callers (any
 * client that declared form elicitation) are prompted; declining or
 * answering `confirm: false` cancels the delete. Callers that CANNOT be
 * prompted (`unavailable` — the stateless legacy path, e.g. the WYRE Conduit
 * gateway) fall back to proceeding, per the integration contract: the
 * gateway enforces destructive-tool access with its own server-side gate,
 * and elicitation is purely additive on top of it.
 */
export function confirmDelete(
  ctx: ElicitationContext,
  message: string
): DeleteGate {
  const outcome = elicitConfirmation(ctx, message);
  if (outcome.kind === "ask") return { kind: "ask", result: outcome.result };
  if (outcome.kind === "unavailable") return { kind: "proceed" };
  if (outcome.kind === "declined" || !outcome.value) return { kind: "refused" };
  return { kind: "proceed" };
}
