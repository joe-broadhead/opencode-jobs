/** The plugin's id: the status RPC's id, the tools RPC's prefix, and the stem of its commands and its tool namespace. */
export const PLUGIN_ID = "jobs.scheduler"
/** The terminal UI part's id. */
export const TUI_ID = "jobs.scheduler.tui"
/** The name `/jobs-status` and the `/jobs` dialog are built from. */
export const COMMAND_STEM = "jobs"
/** The OpenCode versions the plugin starts on. Equals `opencode.host` in package.json. */
export const SUPPORTED_HOST = ">=2.2.3 <2.3.0"
/** The OpenCode releases every check runs on: the one list. Status calls only these "tested". */
export const TESTED_HOSTS: readonly string[] = ["2.2.3", "2.2.4", "2.2.5", "2.2.6"]

/** The one error shape: `CODE: what happened. Next step: What to do.` Both parts are sentences. */
export const errorText = (code: string, message: string, nextStep: string) => `${code}: ${message} Next step: ${nextStep}`

export function jobsError(code: string, message: string, nextStep: string) {
  return Object.assign(new Error(errorText(code, message, nextStep)), { code, nextStep })
}
