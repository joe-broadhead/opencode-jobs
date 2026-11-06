import { Plugin } from "@opencode/plugin/tui"
import { TextAttributes } from "@opentui/core"
import { createSignal } from "solid-js"
import { COMMAND_STEM, PLUGIN_ID, TUI_ID } from "./constants.js"
import type { Status } from "./status.js"
import { formatStatus, unavailable as unavailableError } from "./status.js"
import { Jobs } from "./rpc.js"

const TITLE = "Jobs status"

/** What the dialog shows: reading, the report, or why there is no report. */
export type View =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly status: Status }
  | { readonly state: "unavailable"; readonly message: string; readonly nextStep: string }

/** A failure as the dialog says it: the coded message and its next step, or the generic restart step. */
export function viewOf(error: unknown): View {
  const type = typeof error === "object" && error !== null && "type" in error ? error.type : undefined
  if (type === "unavailable") {
    const { message, data } = error as { message?: unknown; data?: { nextStep?: unknown } }
    if (typeof message === "string" && typeof data?.nextStep === "string") return { state: "unavailable", message, nextStep: data.nextStep }
  }
  const { message, nextStep } = unavailableError(error instanceof Error ? error : new Error(String(error)))
  return { state: "unavailable", message, nextStep }
}

/** The keys the dialog answers, exactly as the standard writes them. The kill switch is a palette command that asks. */
export function keysLine(): string {
  return "r refresh · esc close"
}

/** The dialog's body, without its title: the report's rows, or why there is none. */
export function dialogText(view: View): string {
  if (view.state === "loading") return "Reading the job status…"
  if (view.state === "unavailable") return `${view.message}\n\nNext step: ${view.nextStep}`
  return formatStatus(view.status).split("\n").slice(1).join("\n")
}

/**
 * Pauses every job, or resumes them, by running the same `/jobs-pause` command a person types. The TUI answers one
 * read-only RPC and nothing else, so the change goes through the plugin's own command, in a session created for it and
 * removed at once: the pause state is the plugin's, never a second copy here.
 */
export async function togglePause(client: Plugin.Context["client"], location: Plugin.Context["location"]): Promise<void> {
  const at = location ?? { directory: "" }
  const created = await client.session.create({ location: at, title: TITLE })
  try {
    await client.session.command({ sessionID: created.id, name: `${COMMAND_STEM}-pause`, text: "" })
  } finally {
    await client.session.remove({ sessionID: created.id }).catch(() => undefined)
  }
}

type Theme = Plugin.Context["theme"]

function StatusDialog(props: {
  readonly context: Plugin.Context
  readonly view: View
  readonly refreshing: boolean
  readonly refresh: () => void
}) {
  // Created inside the dialog, so the host removes the layer when the dialog closes. The dialog only reads: the kill
  // switch is the palette command, which asks first.
  props.context.keymap.layer(() => ({
    mode: "modal",
    commands: [
      { id: `${PLUGIN_ID}.status.refresh`, title: "Refresh the job status", group: "Jobs", bind: "r", run: () => props.refresh() },
      { title: "Close the job status", group: "Jobs", bind: "escape", run: () => props.context.ui.dialog.clear() },
    ],
  }))
  const theme = (): Theme => props.context.theme.surface("dialog")
  return (
    <box flexDirection="column" gap={1} paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme().text.base} attributes={TextAttributes.BOLD}>
          {TITLE}
        </text>
        <text fg={theme().text.muted}>{props.refreshing ? "refreshing…" : keysLine()}</text>
      </box>
      <text fg={theme().text.base} wrapMode="word">
        {dialogText(props.view)}
      </text>

    </box>
  )
}

export default Plugin.define({
  id: TUI_ID,
  setup(context) {
    const [view, setView] = createSignal<View>({ state: "loading" })
    const [refreshing, setRefreshing] = createSignal(false)
    let controller: AbortController | undefined
    let disposed = false
    /** The open dialog, so showing another one closes this one. */
    let open: object | undefined
    /** The event listeners of the open dialog. */
    let stops: (() => void)[] = []

    const close = () => {
      controller?.abort()
      for (const stop of stops.splice(0)) stop()
      open = undefined
    }

    const refresh = () => {
      if (disposed) return
      controller?.abort()
      const current = new AbortController()
      controller = current
      setRefreshing(true)
      void context.client
        .rpc(Jobs)
        .status({}, { location: context.location ?? context.data.location.default(), signal: current.signal })
        .then((status): View => ({ state: "ready", status: status as Status }), viewOf)
        .then((next) => {
          if (current.signal.aborted) return
          setView(next)
          setRefreshing(false)
        })
    }

    const paused = () => {
      const current = view()
      return current.state === "ready" && current.status.paused !== undefined
    }

    /** The kill switch, from the palette: it asks first, because it stops every job at once. */
    const toggle = async () => {
      if (disposed) return
      const pausing = !paused()
      const confirmed = await context.ui.dialog.confirm({
        title: "Jobs",
        message: pausing ? "Pause every job? Nothing new starts, and a run in flight is interrupted." : "Resume every job? Their schedules run again.",
        label: { confirm: pausing ? "Pause all" : "Resume all", cancel: "Cancel" },
      }).catch(() => undefined)
      if (confirmed !== true) return
      await togglePause(context.client, context.location).then(
        () => refresh(),
        (error: unknown) => setView(viewOf(error)),
      )
    }

    const show = () => {
      if (disposed) return
      close()
      const token = {}
      context.ui.dialog.show(
        () => <StatusDialog context={context} view={view()} refreshing={refreshing()} refresh={refresh} />,
        () => {
          if (open === token) close()
        },
      )
      context.ui.dialog.set({ size: "large" })
      open = token
      setView({ state: "loading" })
      // Only while the dialog is open: the report changes when the server reconnects, an agent changes, or a job runs.
      stops = [context.data.on("server.connected", () => refresh()), context.data.on("agent.updated", () => refresh()), context.data.on("session.idle", () => refresh())]
      refresh()
    }

    // Registered from setup, outside any root of the plugin's own, so the host's keymap owns it. Global, so the palette
    // lists it from every screen.
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: `${PLUGIN_ID}.status`,
          title: "Jobs: Status",
          description: "The runner, the jobs, the next runs and the next step",
          group: "Jobs",
          palette: true,
          slash: { name: COMMAND_STEM },
          run: show,
        },
        {
          id: `${PLUGIN_ID}.pause`,
          title: "Jobs: Pause or resume every job",
          description: "Pause every job at once, or resume them; it asks first",
          group: "Jobs",
          palette: true,
          run: () => void toggle(),
        },
      ],
    }))

    return () => {
      if (disposed) return
      disposed = true
      if (open) context.ui.dialog.clear()
      close()
    }
  },
})
