import { describe, expect, test } from "bun:test"
import { DEFAULT_OPTIONS, parseOptions } from "../../src/options.js"

describe("parseOptions", () => {
  test("defaults to an enabled plugin on a tested host, in the server's time zone", () => {
    expect(parseOptions(undefined)).toEqual(DEFAULT_OPTIONS)
    expect(parseOptions({})).toEqual(DEFAULT_OPTIONS)
    expect(DEFAULT_OPTIONS).toEqual({ enabled: true, allowUntestedHost: false, timezone: null })
  })

  test("accepts every documented value", () => {
    expect(parseOptions({ enabled: false, allowUntestedHost: true })).toEqual({ enabled: false, allowUntestedHost: true, timezone: null })
    expect(parseOptions({ enabled: false, allowUntestedHost: false, timezone: "Europe/London" })).toEqual({ enabled: false, allowUntestedHost: false, timezone: "Europe/London" })
    expect(parseOptions({ timezone: " UTC " }).timezone).toBe("UTC")
  })

  test.each([
    [{ concurrency: 2 }, 'Unknown option "concurrency". Accepted options: "enabled", "allowUntestedHost", "timezone"'],
    [{ enabled: "yes" }, 'The option "enabled" must be true or false (true by default), found "yes"'],
    [{ enabled: null }, 'The option "enabled" must be true or false (true by default), found null'],
    [{ allowUntestedHost: 1 }, 'The option "allowUntestedHost" must be true or false (false by default), found 1'],
    [{ timezone: "" }, 'The option "timezone" must be an IANA time zone name such as "Europe/London" (the server\'s zone by default), found ""'],
    [{ timezone: "Mars/Olympus" }, 'The option "timezone" is not a time zone: "Mars/Olympus". Accepted values are an IANA time zone name such as "Europe/London" (the server\'s zone by default)'],
    ["read", 'The plugin options must be an object, found "read"'],
    [[], "The plugin options must be an object, found an array"],
  ])("rejects %j with the key, the accepted values and an example", (input, problem) => {
    expect(() => parseOptions(input)).toThrow(problem)
    try {
      parseOptions(input)
    } catch (error) {
      const { message, code, nextStep } = error as Error & { code: string; nextStep: string }
      expect(code).toBe("OPTIONS_INVALID")
      expect(message.startsWith("OPTIONS_INVALID: ")).toBe(true)
      expect(nextStep).toContain(`"options": { "enabled": true }`)
      expect(message.endsWith(`. Next step: ${nextStep}`)).toBe(true)
      expect(nextStep.endsWith(".")).toBe(true)
    }
  })
})
