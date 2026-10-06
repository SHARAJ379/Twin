import { randomUUID } from "node:crypto";

import { evaluateExpectation } from "../../domain/expectation.js";
import { redactBody, redactHeaders } from "../../domain/redaction.js";
import { evaluateSaveExpression } from "../../domain/saveExpression.js";
import type { RequestStep, RestartStep, Scenario, Step, WaitStep } from "../../domain/scenario.js";
import type { RedactedRequest, RedactedResponse, StepResult } from "../../domain/stepResult.js";
import { renderTemplateDeep, type TemplateHelpers } from "../../domain/template.js";
import { PIN_HEADER } from "../proxy/httpProxy.js";
import { CookieJar } from "./cookieJar.js";
import type { RunContext, ScenarioClient } from "../../ports/scenarioClient.js";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function makeTemplateHelpers(): TemplateHelpers {
  let counter = 0;
  return {
    unique: () => `u${Date.now().toString(36)}${(counter++).toString(36)}`,
    uuid: () => randomUUID(),
    now: () => new Date().toISOString()
  };
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function buildBody(rendered: RequestStep["request"]): { body: string | FormData | undefined; contentType?: string } {
  if (rendered.json !== undefined) {
    return { body: JSON.stringify(rendered.json), contentType: "application/json" };
  }
  if (rendered.form !== undefined) {
    return { body: new URLSearchParams(rendered.form).toString(), contentType: "application/x-www-form-urlencoded" };
  }
  if (rendered.multipart !== undefined) {
    const form = new FormData();
    form.append("file", new Blob([rendered.multipart.generate.content]), rendered.multipart.generate.name);
    return { body: form };
  }
  if (rendered.body !== undefined) {
    return { body: rendered.body };
  }
  return { body: undefined };
}

/**
 * The only InstanceDriver-aware part of running a scenario: executes steps
 * strictly in order through the proxy (no step concurrency - keeps the core
 * deterministic, per TWIN_ARCHITECTURE.md §0.3).
 */
export class HttpScenarioClient implements ScenarioClient {
  async run(scenario: Scenario, ctx: RunContext): Promise<StepResult[]> {
    const results: StepResult[] = [];
    const variables: Record<string, string> = {};
    const cookieJar = new CookieJar();
    const helpers = makeTemplateHelpers();

    for (const step of scenario.steps) {
      const result = await this.executeStep(step, ctx, variables, cookieJar, helpers);
      if (result.saved !== undefined) Object.assign(variables, result.saved);
      results.push(result);
    }

    return results;
  }

  private async executeStep(
    step: Step,
    ctx: RunContext,
    variables: Record<string, string>,
    cookieJar: CookieJar,
    helpers: TemplateHelpers
  ): Promise<StepResult> {
    if (step.kind === "wait") return this.executeWaitStep(step);
    if (step.kind === "restart") return this.executeRestartStep(step, ctx);
    return this.executeRequestStepWithRetries(step, ctx, variables, cookieJar, helpers);
  }

  private async executeWaitStep(step: WaitStep): Promise<StepResult> {
    const startedAt = Date.now();
    await sleep(step.ms);
    return {
      stepId: step.id,
      startedAt,
      durationMs: Date.now() - startedAt,
      expectationsPassed: true,
      failedExpectations: []
    };
  }

  private async executeRestartStep(step: RestartStep, ctx: RunContext): Promise<StepResult> {
    const startedAt = Date.now();
    const index = ctx.instances.findIndex((i) => i.id === step.instance);
    if (index === -1) {
      return {
        stepId: step.id,
        startedAt,
        durationMs: Date.now() - startedAt,
        expectationsPassed: false,
        failedExpectations: [`restart: no running instance "${step.instance}"`],
        error: { message: `no running instance "${step.instance}"` }
      };
    }

    try {
      const current = ctx.instances[index]!;
      const restarted = await ctx.instanceDriver.restart(current, {
        mode: step.mode ?? "graceful",
        disk: step.disk ?? "fresh"
      });
      ctx.instances[index] = restarted; // mutate in place: the Proxy reads this same array
      return {
        stepId: step.id,
        instanceServed: step.instance,
        startedAt,
        durationMs: Date.now() - startedAt,
        expectationsPassed: true,
        failedExpectations: []
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        stepId: step.id,
        startedAt,
        durationMs: Date.now() - startedAt,
        expectationsPassed: false,
        failedExpectations: [`restart failed: ${message}`],
        error: { message }
      };
    }
  }

  private async executeRequestStepWithRetries(
    step: RequestStep,
    ctx: RunContext,
    variables: Record<string, string>,
    cookieJar: CookieJar,
    helpers: TemplateHelpers
  ): Promise<StepResult> {
    const maxAttempts = (step.retries ?? 0) + 1;
    let last: StepResult | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      last = await this.executeRequestStep(step, ctx, variables, cookieJar, helpers);
      if (last.expectationsPassed || attempt === maxAttempts) break;
      if (step.settleMs !== undefined && step.settleMs > 0) await sleep(step.settleMs);
    }

    return last!;
  }

  private async executeRequestStep(
    step: RequestStep,
    ctx: RunContext,
    variables: Readonly<Record<string, string>>,
    cookieJar: CookieJar,
    helpers: TemplateHelpers
  ): Promise<StepResult> {
    const startedAt = Date.now();
    const clientName = step.as ?? "default";

    // Everything from templating through the fetch call itself can throw
    // (an undefined {{var}} from a scenario typo, a malformed URL, a
    // network error) - all of it must become a StepResult.error, never an
    // exception that crashes the whole run (§7.1: "undefined variable ...
    // at the step, with the variable name in the message").
    let redactedRequest: RedactedRequest | undefined;
    let response: Response;
    try {
      const rendered = renderTemplateDeep(step.request, variables, helpers) as RequestStep["request"];
      const url = new URL(rendered.path, ctx.proxyUrl);

      const headers: Record<string, string> = { ...rendered.headers };
      const cookieHeader = cookieJar.headerFor(clientName, rendered.path);
      if (cookieHeader !== undefined) headers["cookie"] = cookieHeader;
      if (step.via !== undefined && step.via !== "any") headers[PIN_HEADER] = step.via;

      const { body, contentType } = buildBody(rendered);
      if (contentType !== undefined) headers["content-type"] ??= contentType;

      redactedRequest = {
        method: rendered.method,
        path: rendered.path,
        headers: redactHeaders(headers, ctx.redactExtraHeaders),
        bodyPreview: redactBody(typeof body === "string" ? body : undefined, ctx.redactExtraHeaders)
      };

      response = await fetch(url, { method: rendered.method, headers, redirect: "manual", ...(body !== undefined ? { body } : {}) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        stepId: step.id,
        startedAt,
        durationMs: Date.now() - startedAt,
        ...(redactedRequest !== undefined ? { request: redactedRequest } : {}),
        error: { message },
        expectationsPassed: false,
        failedExpectations: [message]
      };
    }

    const responseText = await response.text();
    const responseHeaders = headersToRecord(response.headers);
    const setCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    cookieJar.ingest(clientName, setCookies);

    let parsedBody: unknown;
    try {
      parsedBody = responseText.length > 0 ? JSON.parse(responseText) : undefined;
    } catch {
      parsedBody = undefined;
    }

    const expectationResult = evaluateExpectation(step.expect, { status: response.status, bodyText: responseText, body: parsedBody });

    const saved: Record<string, string> = {};
    if (step.save !== undefined) {
      for (const [varName, spec] of Object.entries(step.save)) {
        try {
          saved[varName] = evaluateSaveExpression(spec, parsedBody, responseHeaders);
        } catch (err) {
          expectationResult.failures.push(err instanceof Error ? err.message : String(err));
        }
      }
    }

    const redactedResponse: RedactedResponse = {
      status: response.status,
      headers: redactHeaders(responseHeaders, ctx.redactExtraHeaders),
      bodyPreview: redactBody(responseText, ctx.redactExtraHeaders)
    };

    return {
      stepId: step.id,
      instanceServed: responseHeaders["x-twin-instance"],
      startedAt,
      durationMs: Date.now() - startedAt,
      request: redactedRequest,
      response: redactedResponse,
      expectationsPassed: expectationResult.failures.length === 0,
      failedExpectations: expectationResult.failures,
      ...(Object.keys(saved).length > 0 ? { saved } : {})
    };
  }
}
