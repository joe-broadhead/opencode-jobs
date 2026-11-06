import type { Plugin } from "@opencode/plugin"
import { Rpc } from "@opencode/plugin/rpc"
import { PLUGIN_ID } from "./constants.js"
import type { Report } from "./jobs/report.js"
import { STATUS_OUTPUT, unavailable } from "./status.js"

const string = { type: "string" } as const
const closed = <P extends Record<string, object>, R extends readonly (keyof P & string)[]>(properties: P, required: R) =>
  ({ type: "object", properties, required }) as const

/** A failure: the code, the full `CODE: ... Next step: ...` message, and the next step. */
const errors = { unavailable: closed({ nextStep: string }, ["nextStep"]) }
const NO_INPUT = { type: "object" } as const
/**
 * A job and a run, as `list` and `history` summary them. Their fields are the store's and the status model's, so the
 * schema is open: a field added to either is visible here without a contract change.
 */
const SUMMARY = { type: "object" } as const
const listed = (key: string) => closed({ [key]: { type: "array", items: SUMMARY } }, [key])

/**
 * The read-only status RPC: the dialog and scripts read the same model `/jobs-status` renders. A job's transcript is
 * never here; `history` names what a run did, not what was said in it.
 */
export const Jobs = Rpc.define({
  id: PLUGIN_ID,
  methods: {
    status: { input: NO_INPUT, output: STATUS_OUTPUT, errors },
    list: { input: NO_INPUT, output: listed("jobs"), errors },
    history: {
      input: { type: "object", properties: { id: string, limit: { type: "integer", minimum: 1, maximum: 50 }, since: string } },
      output: listed("runs"),
      errors,
    },
  },
  events: {},
})

export type JobsRpc = typeof Jobs

/** The three reads, each with the status model's own coded error and next step. */
export function registerStatusRpc(rpc: Pick<Plugin.Context["rpc"], "register">, report: Pick<Report, "status" | "list" | "history">) {
  const failure = (error: unknown, respond: (type: "unavailable", message: string, data: { nextStep: string }) => unknown) => {
    const { message, nextStep } = unavailable(error)
    return respond("unavailable", message, { nextStep })
  }
  const registration = rpc.register(Jobs, {
    status: (_input, { error }) => report.status().catch((cause: unknown) => failure(cause, error)),
    list: async (_input, { error }) => report.list().then((jobs) => ({ jobs: [...jobs] }), (cause: unknown) => failure(cause, error)),
    history: async (input: unknown, { error }) => {
      const filter = (typeof input === "object" && input !== null ? input : {}) as { id?: string; limit?: number; since?: string }
      return report
        .history({
          ...(filter.id === undefined ? {} : { id: filter.id }),
          ...(filter.limit === undefined ? {} : { limit: filter.limit }),
          ...(filter.since === undefined ? {} : { since: filter.since }),
        })
        .then((runs) => ({ runs: [...runs] }), (cause: unknown) => failure(cause, error))
    },
  })
  return registration.then((registration) => registration.dispose)
}
