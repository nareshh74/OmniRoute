"use strict";
// Fail-open OTel preload for OmniRoute. Any error here must never affect request handling.
(function () {
  try {
    if (process.env.OTEL_SDK_DISABLED === "true") return;
    const { trace, context } = require("@opentelemetry/api");
    const { logs, SeverityNumber } = require("@opentelemetry/api-logs");
    const { resourceFromAttributes } = require("@opentelemetry/resources");
    const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
    const { BatchSpanProcessor } = require("@opentelemetry/sdk-trace-base");
    const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
    const { OTLPLogExporter } = require("@opentelemetry/exporter-logs-otlp-http");
    const { LoggerProvider, BatchLogRecordProcessor } = require("@opentelemetry/sdk-logs");
    const { registerInstrumentations } = require("@opentelemetry/instrumentation");
    const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http");
    const { UndiciInstrumentation } = require("@opentelemetry/instrumentation-undici");

    const base = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://otel-collector:4318").replace(/\/$/, "");
    const TIMEOUT = 2000; // fail-open: exporter gives up fast; bounded queue drops when full
    const CAPTURE = process.env.OMNIROUTE_OTEL_CAPTURE_BODIES === "true"; // opt-in
    const MAX_BODY = 16384;

    const resource = resourceFromAttributes({
      "service.name": process.env.OTEL_SERVICE_NAME || "omniroute",
      "service.namespace": "llm-gateway",
    });
    const batch = { maxQueueSize: 2048, maxExportBatchSize: 256, scheduledDelayMillis: 3000, exportTimeoutMillis: TIMEOUT };
    const tp = new NodeTracerProvider({
      resource,
      spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: base + "/v1/traces", timeoutMillis: TIMEOUT }), batch)],
    });
    tp.register(); // installs W3C traceparent/tracestate propagator + context manager
    const lp = new LoggerProvider({
      resource,
      processors: [new BatchLogRecordProcessor(new OTLPLogExporter({ url: base + "/v1/logs", timeoutMillis: TIMEOUT }), batch)],
    });
    logs.setGlobalLoggerProvider(lp);
    const logger = logs.getLogger("omniroute.llm");

    const stripPath = (u) => (u || "").split("?")[0];
    const isLlm = (p) => /^\/(api\/)?v1\/(chat\/completions|responses|completions|messages|embeddings)/.test(p);
    const OPS = { "chat/completions": "chat", responses: "chat", completions: "text_completion", messages: "chat", embeddings: "embeddings" };
    const SKEY = Symbol("omniroute.otel");
    const hdr = (res, n) => { const v = res.getHeader(n); return v == null ? undefined : String(v); };
    const tryJson = (s) => { try { return JSON.parse(s); } catch (_) { return undefined; } };

    // Pull model/usage from a JSON body or SSE data frames.
    function parseResponse(text) {
      const out = {};
      const pick = (o) => {
        if (!o || typeof o !== "object") return;
        if (o.model) out.model = o.model;
        const u = o.usage || (o.message && o.message.usage) || (o.response && o.response.usage);
        if (u) {
          const i = u.prompt_tokens != null ? u.prompt_tokens : u.input_tokens;
          const c = u.completion_tokens != null ? u.completion_tokens : u.output_tokens;
          if (i != null) out.in = i;
          if (c != null) out.out = c;
        }
        if (o.response) pick(o.response);
        if (o.message) pick(o.message);
      };
      const whole = tryJson(text);
      if (whole) { pick(whole); return out; }
      for (const line of text.split("\n")) {
        if (line.startsWith("data:") && line.length > 6) pick(tryJson(line.slice(5).trim()));
      }
      return out;
    }

    const httpInst = new HttpInstrumentation({
      ignoreIncomingRequestHook: (req) => !isLlm(stripPath(req.url)),
      requestHook(span, info) {
        try {
          const request = info.request;
          if (!request || request.method !== "POST" || typeof request.push !== "function") return;
          if (!isLlm(stripPath(request.url))) return;
          const st = { req: [], reqLen: 0, res: [], resLen: 0 };
          request[SKEY] = st;
          const push = request.push;
          request.push = function (chunk, enc) { // non-consuming tap
            try { if (chunk && st.reqLen < 262144) { st.req.push(Buffer.from(chunk)); st.reqLen += chunk.length; } } catch (_) {}
            return push.call(this, chunk, enc);
          };
        } catch (_) {}
      },
      responseHook(span, res) {
        try {
          if (!res || typeof res.getHeader !== "function") return; // outbound client responses
          const req = res.req;
          const st = req && req[SKEY];
          if (!st) return;
          const path = stripPath(req.url);
          const op = OPS[path.replace(/^\/(api\/)?v1\//, "")] || "chat";
          const w = res.write, e = res.end;
          const tap = (c) => {
            if (c && typeof c !== "function" && st.resLen < 262144) {
              const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
              st.res.push(b); st.resLen += b.length;
            }
          };
          res.write = function (c) { try { tap(c); } catch (_) {} return w.apply(this, arguments); };
          res.end = function (c) { try { tap(c); } catch (_) {} return e.apply(this, arguments); };
          res.once("close", () => {
            try {
              const reqBody = tryJson(Buffer.concat(st.req).toString("utf8")) || {};
              const text = Buffer.concat(st.res).toString("utf8");
              const out = parseResponse(text);
              const A = { "gen_ai.operation.name": op, "gen_ai.system": "omniroute", "omniroute.route": path };
              if (reqBody.model) A["gen_ai.request.model"] = String(reqBody.model);
              if (out.model) A["gen_ai.response.model"] = String(out.model);
              if (out.in != null) A["gen_ai.usage.input_tokens"] = out.in;
              if (out.out != null) A["gen_ai.usage.output_tokens"] = out.out;
              const prov = hdr(res, "x-omniroute-provider");
              if (prov) A["omniroute.provider"] = prov;
              const fb = hdr(res, "x-omniroute-fallback-attempts");
              if (fb != null) { A["omniroute.fallback"] = Number(fb) > 0; A["omniroute.fallback_attempts"] = Number(fb) || 0; }
              const cost = parseFloat(hdr(res, "x-omniroute-response-cost"));
              if (!Number.isNaN(cost)) A["omniroute.cost_usd"] = cost;
              if (res.statusCode >= 400) A["error.type"] = String(res.statusCode);
              span.setAttributes(A);
              if (CAPTURE) {
                logger.emit({
                  severityNumber: SeverityNumber.INFO,
                  body: "llm.exchange",
                  attributes: {
                    "gen_ai.request.model": A["gen_ai.request.model"] || "",
                    "gen_ai.prompt": JSON.stringify(reqBody.messages || reqBody.input || reqBody.prompt || "").slice(0, MAX_BODY),
                    "gen_ai.completion": text.slice(0, MAX_BODY),
                  },
                  context: trace.setSpan(context.active(), span),
                });
              }
            } catch (_) {}
          });
        } catch (_) {}
      },
    });
    registerInstrumentations({ instrumentations: [httpInst, new UndiciInstrumentation()] });
    process.on("SIGTERM", () => { Promise.allSettled([tp.shutdown(), lp.shutdown()]); });
  } catch (err) {
    try { console.warn("[otel-preload] disabled:", err && err.message); } catch (_) {}
  }
})();
