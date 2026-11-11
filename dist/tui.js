// src/tui.tsx
import { createComponent as _$createComponent } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { Plugin } from "@opencode/plugin/tui";
import { TextAttributes } from "@opentui/core";
import { createSignal } from "solid-js";

// src/constants.ts
var PLUGIN_ID = "jobs.scheduler";
var TUI_ID = "jobs.scheduler.tui";
var COMMAND_STEM = "jobs";
var SUPPORTED_HOST = ">=2.2.3 <2.3.0";
var TESTED_HOSTS = ["2.2.3", "2.2.4", "2.2.5", "2.2.6"];
var errorText = (code, message, nextStep) => `${code}: ${message} Next step: ${nextStep}`;

// src/host-version.ts
var RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;
var parse = (version) => RELEASE.exec(version)?.slice(1).map(Number);
var [LOWEST, ABOVE] = SUPPORTED_HOST.split(" ").map((bound) => parse(bound.replace(/^[<>]=?/, "")));
var compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
function isSupportedHost(version) {
  const parts = parse(version);
  return parts !== void 0 && compare(parts, LOWEST) >= 0 && compare(parts, ABOVE) < 0;
}

// src/host/permissions.ts
var AGENT_BLOCK = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "list", resource: "*", effect: "allow" },
  { action: "jobs_status", resource: "*", effect: "allow" },
  { action: "jobs_list", resource: "*", effect: "allow" },
  { action: "jobs_get", resource: "*", effect: "allow" },
  { action: "jobs_history", resource: "*", effect: "allow" },
  { action: "jobs_pause", resource: "*", effect: "allow" }
];
var READ_AND_PAUSE = [
  { action: "jobs_status", resource: "*", effect: "allow" },
  { action: "jobs_list", resource: "*", effect: "allow" },
  { action: "jobs_get", resource: "*", effect: "allow" },
  { action: "jobs_history", resource: "*", effect: "allow" },
  { action: "jobs_pause", resource: "*", effect: "allow" },
  { action: "jobs_pause_all", resource: "*", effect: "allow" }
];
var READS = READ_AND_PAUSE.slice(0, 4);
function defaultRules(access) {
  const namespace = { action: "jobs_*", resource: "*", effect: access === "all" ? "allow" : access === "ask-changes" ? "ask" : "deny" };
  if (access === "read-only") return [namespace, ...READS];
  return [namespace, ...READ_AND_PAUSE];
}
var DEFAULT_RULES = defaultRules("all");
function agentBlock(agent) {
  return { agents: { [agent]: { permissions: AGENT_BLOCK.map((rule2) => ({ ...rule2 })) } } };
}
var agentBlockJSON = (agent) => JSON.stringify(agentBlock(agent), null, 2);

// src/redact.ts
var SECRETS = [
  [/\b(bearer|basic|token)\s+[\w.~+/=-]{8,}/gi, "$1 [redacted]"],
  [/\b([\w-]*(?:api[_-]?key|access[_-]?key|private[_-]?key|token|secret|password|signature|credential)["']?\s*[:=]\s*)["']?[^\s"'&,;]+["']?/gi, "$1[redacted]"],
  [/\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}/g, "[redacted]"],
  [/\b(?:tvly|sk|pk|rk|ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abposr]|lin_api|lin_oauth)[-_][\w-]{8,}/gi, "[redacted]"],
  [/[\w+=-]{40,}/g, "[redacted]"]
];
var REASON_LIMIT = 160;
var CONTROLS = /[\u0000-\u001f\u007f-\u009f]+/g;
var BIDI = /[‎‏‪-‮⁦-⁩]/g;
var withoutUrlSecrets = (text) => text.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (url) => url.replace(/^(https?:\/\/)[^/?#@]*@/i, "$1").replace(/[?#].*$/s, ""));
var oneLine = (text) => text.replace(BIDI, "").replace(CONTROLS, " ").replace(/\s+/g, " ").trim();
function cut(text, limit) {
  const characters = Array.from(text);
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}\u2026` : text;
}
function shortReason(text) {
  const reason = oneLine(SECRETS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), withoutUrlSecrets(text))).replace(/[.\s]+$/, "");
  if (reason === "") return void 0;
  return cut(reason, REASON_LIMIT);
}

// src/status.ts
var TESTED_TEXT = `${TESTED_HOSTS.slice(0, -1).join(", ")} or ${TESTED_HOSTS.at(-1)}`;
var RESUME = `Run /${COMMAND_STEM}-pause again to resume every job.`;
var iso = (at) => new Date(at).toISOString();
var plural = (count, one) => `${count} ${one}${count === 1 ? "" : "s"}`;
function duration(ms) {
  if (ms < 1e3) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 6e4) return `${Math.round(ms / 1e3)} s`;
  const minutes = Math.floor(ms / 6e4);
  const seconds = Math.round(ms % 6e4 / 1e3);
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}
function jobsText({ total, paused, expiring, invalidFiles }) {
  if (total === 0) return "none yet";
  return `${total} total, ${paused} paused, ${expiring} expiring, ${invalidFiles} invalid files`;
}
function runnerText(status) {
  const { runner, paused } = status;
  const pausedText = paused === void 0 ? "" : `paused since ${iso(paused.at)}; `;
  if (runner === null) return `${pausedText}no leader yet`;
  const lead = `leader in ${runner.location} (pid ${runner.pid}) since ${iso(runner.since)}`;
  return runner.stoppedAt === void 0 ? `${pausedText}${lead}` : `${pausedText}stopped from ${iso(runner.stoppedAt)} to now; ${lead}`;
}
function livenessText({ everyMinutes, lastBeatAt, lastBeatOk }) {
  const every = `keep-alive every ${plural(everyMinutes, "minute")}`;
  if (lastBeatAt === void 0) return `${every}; no beat yet`;
  return `${every}; last beat ${iso(lastBeatAt)} ${lastBeatOk === false ? "failed" : "ok"}`;
}
function nextText(runs) {
  if (runs.length === 0) return "none";
  return runs.map((run) => `${run.name} at ${iso(run.at)}`).join("; ");
}
function runText(run) {
  const parts = [`${run.name} ${run.status}`];
  if (run.durationMs !== void 0) parts.push(duration(run.durationMs));
  if (run.late) parts.push("late");
  if (run.reason !== void 0) parts.push(`skipped: ${run.reason}`);
  if (run.status === "missed" && run.count !== void 0) parts.push(`\xD7${run.count}`);
  return parts.join(" ");
}
function recentText(runs) {
  return runs.length === 0 ? "none" : runs.map(runText).join("; ");
}
function failureText(failures) {
  return failures.length === 0 ? "none" : failures.map((failure) => `${failure.name} \u2014 ${failure.code} (\xD7${failure.count})`).join("; ");
}
function hostText({ host, problems }) {
  const { version, range, tested } = host;
  const outside = version === null || !isSupportedHost(version);
  const notes = [
    ...outside ? [`It is outside the supported range; the plugin runs because allowUntestedHost is true. If a job misbehaves, use OpenCode ${TESTED_TEXT}.`] : [],
    ...problems
  ];
  return `${version ?? "unknown version"} (${tested ? "tested" : "untested"}; supported range ${range})${notes.length ? `. ${notes.join(" ")}` : ""}`;
}
function formatStatus(status) {
  return [
    "Jobs status",
    `- Runner: ${runnerText(status)}`,
    `- Liveness: ${livenessText(status.liveness)}`,
    `- Jobs: ${jobsText(status.jobs)}`,
    `- Next runs: ${nextText(status.nextRuns)}`,
    `- Recent runs: ${recentText(status.recentRuns)}`,
    `- Failures needing attention: ${failureText(status.failures)}`,
    ...agentRows(status),
    ...missingRows(status),
    ...scriptRows(status),
    `- OpenCode: ${hostText(status)}`,
    `- Next step: ${status.nextStep}`
  ].join("\n");
}
function agentRows(status) {
  const { unguardedAgents: agents, permissionsBlock: block } = status;
  if (status.agentsUnknown === true) return ["- Agents without default rules: unknown; the agent list could not be read"];
  const row = `- Agents without default rules: ${agents.length ? agents.join(", ") : "none"}`;
  if (agents.length === 0 || block === void 0) return [row];
  return [row, ...agents.map((agent) => `  Paste this for ${JSON.stringify(agent)} into opencode.json:
${agentBlockJSON(agent)}`)];
}
function missingRows(status) {
  const { missingAgents: agents } = status;
  if (agents.length === 0) return [];
  const names = agents.join(", ");
  return [`- Agents OpenCode no longer lists: ${names} \u2014 jobs that name one do not run, which can happen after a plugin update; run "opencode reload" in a terminal, or restart OpenCode.`];
}
function scriptRows(status) {
  const { scriptJobs: scripts } = status;
  if (scripts === void 0) return [];
  const waiting = scripts.unapproved === 0 ? "none" : `${scripts.names.join(", ")} (approve again with /${COMMAND_STEM}-approve <job>)`;
  const denied = scripts.revoked.length === 0 ? "" : `; a tool is now denied for ${scripts.revoked.join(", ")}`;
  const auto = scripts.automatic === 0 ? "" : ` (${scripts.automatic} automatically)`;
  return [`- Script jobs: ${scripts.approved} approved${auto}, ${scripts.unapproved} needing approval${scripts.unapproved === 0 ? "" : `: ${waiting}`}${denied}`];
}
var strings = { type: "array", items: { type: "string" } };
var rule = {
  type: "object",
  required: ["action", "resource", "effect"],
  properties: { action: { type: "string" }, resource: { type: "string" }, effect: { enum: ["allow", "deny", "ask"] } }
};
var counts = {
  type: "object",
  required: ["total", "paused", "expiring", "invalidFiles"],
  properties: { total: { type: "integer", minimum: 0 }, paused: { type: "integer", minimum: 0 }, expiring: { type: "integer", minimum: 0 }, invalidFiles: { type: "integer", minimum: 0 } }
};
var RUN = {
  type: "object",
  required: ["job", "name", "slot", "status", "late", "attempt"],
  properties: {
    job: { type: "string" },
    name: { type: "string" },
    slot: { type: "string" },
    status: { enum: ["queued", "running", "succeeded", "failed", "timed_out", "interrupted", "skipped", "missed"] },
    outcome: { type: "string" },
    durationMs: { type: "integer", minimum: 0 },
    late: { type: "boolean" },
    reason: { type: "string" },
    attempt: { type: "integer", minimum: 1 },
    count: { type: "integer", minimum: 1 },
    script: { type: "object" },
    sessionID: { type: "string" },
    cost: { type: "number", minimum: 0 },
    error: { type: "string" },
    calls: { type: "array" },
    callCount: { type: "integer", minimum: 0 },
    callsTruncated: { type: "boolean" },
    limits: { type: "object" },
    result: { type: "string" },
    files: { type: "array" }
  }
};
var STATUS_OUTPUT = {
  type: "object",
  required: ["version", "state", "host", "jobs", "runner", "liveness", "nextRuns", "recentRuns", "failures", "unguardedAgents", "missingAgents", "problems", "nextStep"],
  properties: {
    version: { type: "string" },
    state: { enum: ["ready", "disabled"] },
    host: {
      type: "object",
      required: ["version", "range", "tested"],
      properties: { version: { type: ["string", "null"] }, range: { type: "string" }, tested: { type: "boolean" } }
    },
    jobs: counts,
    runner: {
      type: ["object", "null"],
      required: ["location", "pid", "since"],
      properties: { location: { type: "string" }, pid: { type: "integer" }, since: { type: "integer" }, stoppedAt: { type: "integer" } }
    },
    liveness: {
      type: "object",
      required: ["everyMinutes"],
      properties: { everyMinutes: { type: "integer", minimum: 1 }, lastBeatAt: { type: "integer" }, lastBeatOk: { type: "boolean" } }
    },
    paused: {
      type: "object",
      required: ["at"],
      properties: { at: { type: "integer" }, reason: { type: "string" } }
    },
    nextRuns: {
      type: "array",
      items: { type: "object", required: ["id", "name", "at"], properties: { id: { type: "string" }, name: { type: "string" }, at: { type: "integer" } } }
    },
    recentRuns: { type: "array", items: RUN },
    failures: {
      type: "array",
      items: { type: "object", required: ["name", "code", "count"], properties: { name: { type: "string" }, code: { type: "string" }, count: { type: "integer", minimum: 1 } } }
    },
    unguardedAgents: strings,
    missingAgents: strings,
    scriptJobs: {
      type: "object",
      required: ["approved", "unapproved", "names", "revoked", "automatic"],
      properties: { approved: { type: "integer", minimum: 0 }, unapproved: { type: "integer", minimum: 0 }, names: strings, revoked: strings, automatic: { type: "integer", minimum: 0 } }
    },
    agentsUnknown: { type: "boolean" },
    permissionsBlock: { type: "array", items: rule },
    problems: strings,
    nextStep: { type: "string" }
  }
};
function unavailable(error) {
  const reason = shortReason(error instanceof Error ? error.message : String(error));
  const nextStep = `Restart OpenCode, then run /${COMMAND_STEM}-status again.`;
  return { message: errorText("STATUS_UNAVAILABLE", `Could not read the job status${reason ? ` (${reason})` : ""}.`, nextStep), nextStep };
}

// src/rpc.ts
import { Rpc } from "@opencode/plugin/rpc";
var string = { type: "string" };
var closed = (properties, required) => ({ type: "object", properties, required });
var errors = { unavailable: closed({ nextStep: string }, ["nextStep"]) };
var NO_INPUT = { type: "object" };
var SUMMARY = { type: "object" };
var listed = (key) => closed({ [key]: { type: "array", items: SUMMARY } }, [key]);
var Jobs = Rpc.define({
  id: PLUGIN_ID,
  methods: {
    status: { input: NO_INPUT, output: STATUS_OUTPUT, errors },
    list: { input: NO_INPUT, output: listed("jobs"), errors },
    history: {
      input: { type: "object", properties: { id: string, limit: { type: "integer", minimum: 1, maximum: 50 }, since: string } },
      output: listed("runs"),
      errors
    }
  },
  events: {}
});

// src/tui.tsx
var TITLE = "Jobs status";
function viewOf(error) {
  const type = typeof error === "object" && error !== null && "type" in error ? error.type : void 0;
  if (type === "unavailable") {
    const {
      message: message2,
      data
    } = error;
    if (typeof message2 === "string" && typeof data?.nextStep === "string") return {
      state: "unavailable",
      message: message2,
      nextStep: data.nextStep
    };
  }
  const {
    message,
    nextStep
  } = unavailable(error instanceof Error ? error : new Error(String(error)));
  return {
    state: "unavailable",
    message,
    nextStep
  };
}
function keysLine() {
  return "r refresh \xB7 esc close";
}
function dialogText(view) {
  if (view.state === "loading") return "Reading the job status\u2026";
  if (view.state === "unavailable") return `${view.message}

Next step: ${view.nextStep}`;
  return formatStatus(view.status).split("\n").slice(1).join("\n");
}
async function togglePause(client, location) {
  const at = location ?? {
    directory: ""
  };
  const created = await client.session.create({
    location: at,
    title: TITLE
  });
  try {
    await client.session.command({
      sessionID: created.id,
      name: `${COMMAND_STEM}-pause`,
      text: ""
    });
  } finally {
    await client.session.remove({
      sessionID: created.id
    }).catch(() => void 0);
  }
}
function StatusDialog(props) {
  props.context.keymap.layer(() => ({
    mode: "modal",
    commands: [{
      id: `${PLUGIN_ID}.status.refresh`,
      title: "Refresh the job status",
      group: "Jobs",
      bind: "r",
      run: () => props.refresh()
    }, {
      title: "Close the job status",
      group: "Jobs",
      bind: "escape",
      run: () => props.context.ui.dialog.clear()
    }]
  }));
  const theme = () => props.context.theme.surface("dialog");
  return (() => {
    var _el$ = _$createElement("box"), _el$2 = _$createElement("box"), _el$3 = _$createElement("text"), _el$5 = _$createElement("text"), _el$6 = _$createElement("text");
    _$insertNode(_el$, _el$2);
    _$insertNode(_el$, _el$6);
    _$setProp(_el$, "flexDirection", "column");
    _$setProp(_el$, "gap", 1);
    _$setProp(_el$, "paddingLeft", 2);
    _$setProp(_el$, "paddingRight", 2);
    _$setProp(_el$, "paddingBottom", 1);
    _$insertNode(_el$2, _el$3);
    _$insertNode(_el$2, _el$5);
    _$setProp(_el$2, "flexDirection", "row");
    _$setProp(_el$2, "justifyContent", "space-between");
    _$insertNode(_el$3, _$createTextNode(`Jobs status`));
    _$insert(_el$5, (() => {
      var _c$ = _$memo(() => !!props.refreshing);
      return () => _c$() ? "refreshing\u2026" : keysLine();
    })());
    _$setProp(_el$6, "wrapMode", "word");
    _$insert(_el$6, () => dialogText(props.view));
    _$effect((_p$) => {
      var _v$ = theme().text.base, _v$2 = TextAttributes.BOLD, _v$3 = theme().text.muted, _v$4 = theme().text.base;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$3, "fg", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$3, "attributes", _v$2, _p$.t));
      _v$3 !== _p$.a && (_p$.a = _$setProp(_el$5, "fg", _v$3, _p$.a));
      _v$4 !== _p$.o && (_p$.o = _$setProp(_el$6, "fg", _v$4, _p$.o));
      return _p$;
    }, {
      e: void 0,
      t: void 0,
      a: void 0,
      o: void 0
    });
    return _el$;
  })();
}
var tui_default = Plugin.define({
  id: TUI_ID,
  setup(context) {
    const [view, setView] = createSignal({
      state: "loading"
    });
    const [refreshing, setRefreshing] = createSignal(false);
    let controller;
    let disposed = false;
    let open;
    let stops = [];
    const close = () => {
      controller?.abort();
      for (const stop of stops.splice(0)) stop();
      open = void 0;
    };
    const refresh = () => {
      if (disposed) return;
      controller?.abort();
      const current = new AbortController();
      controller = current;
      setRefreshing(true);
      void context.client.rpc(Jobs).status({}, {
        location: context.location ?? context.data.location.default(),
        signal: current.signal
      }).then((status) => ({
        state: "ready",
        status
      }), viewOf).then((next) => {
        if (current.signal.aborted) return;
        setView(next);
        setRefreshing(false);
      });
    };
    const paused = () => {
      const current = view();
      return current.state === "ready" && current.status.paused !== void 0;
    };
    const toggle = async () => {
      if (disposed) return;
      const pausing = !paused();
      const confirmed = await context.ui.dialog.confirm({
        title: "Jobs",
        message: pausing ? "Pause every job? Nothing new starts, and a run in flight is interrupted." : "Resume every job? Their schedules run again.",
        label: {
          confirm: pausing ? "Pause all" : "Resume all",
          cancel: "Cancel"
        }
      }).catch(() => void 0);
      if (confirmed !== true) return;
      await togglePause(context.client, context.location).then(() => refresh(), (error) => setView(viewOf(error)));
    };
    const show = () => {
      if (disposed) return;
      close();
      const token = {};
      context.ui.dialog.show(() => _$createComponent(StatusDialog, {
        context,
        get view() {
          return view();
        },
        get refreshing() {
          return refreshing();
        },
        refresh
      }), () => {
        if (open === token) close();
      });
      context.ui.dialog.set({
        size: "large"
      });
      open = token;
      setView({
        state: "loading"
      });
      stops = [context.data.on("server.connected", () => refresh()), context.data.on("agent.updated", () => refresh()), context.data.on("session.idle", () => refresh())];
      refresh();
    };
    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: `${PLUGIN_ID}.status`,
        title: "Jobs: Status",
        description: "The runner, the jobs, the next runs and the next step",
        group: "Jobs",
        palette: true,
        slash: {
          name: COMMAND_STEM
        },
        run: show
      }, {
        id: `${PLUGIN_ID}.pause`,
        title: "Jobs: Pause or resume every job",
        description: "Pause every job at once, or resume them; it asks first",
        group: "Jobs",
        palette: true,
        run: () => void toggle()
      }]
    }));
    return () => {
      if (disposed) return;
      disposed = true;
      if (open) context.ui.dialog.clear();
      close();
    };
  }
});
export {
  tui_default as default,
  dialogText,
  keysLine,
  togglePause,
  viewOf
};
