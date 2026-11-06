import type { Plugin } from "@opencode/plugin"
import { Rpc } from "@opencode/plugin/rpc"
import { PLUGIN_ID } from "./constants.js"
import { STATUS_OUTPUT, unavailable, type Status } from "./status.js"

const string = { type: "string" } as const
const closed = <P extends Record<string, object>, R extends readonly (keyof P & string)[]>(properties: P, required: R) =>
  ({ type: "object", properties, required }) as const

/** A failure: the code, the full `CODE: ... Next step: ...` message, and the next step. */
const errors = { unavailable: closed({ nextStep: string }, ["nextStep"]) }
const NO_INPUT = { type: "object" } as const
/** A job and a run, as `list` and `history` summary them. Their fields are the store's, and they grow with it. */
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
      input: { type: "object", properties: { id: string, limit: { type: "integer", minimum: 1, maximum: 50 } } },
      output: listed("runs"),
      errors,
    },
  },
  events: {},
})

export type JobsRpc = typeof Jobs

/** The stubbed reads, until the store lands: there are no jobs and no runs to report. */
const EMPTY = { jobs: [] as unknown[], runs: [] as unknown[] }

export function registerStatusRpc(rpc: Pick<Plugin.Context["rpc"], "register">, read: () => Promise<Status>) {
  const fail = (error: unknown) => {
    const { message, nextStep } = unavailable(error)
    return { message, nextStep }
  }
  const registration = rpc.register(Jobs, {
    status: (_input, { error }) =>
      read().catch((cause: unknown) => {
        const { message, nextStep } = fail(cause)
        return error("unavailable", message, { nextStep })
      }),
    list: async () => ({ jobs: EMPTY.jobs }),
    history: async () => ({ runs: EMPTY.runs }),
  })
  return registration.then((registration) => registration.dispose)
}
