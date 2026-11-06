import { describe, expect, test } from "bun:test"
import { DEFAULT_OPTIONS, parseOptions } from "../../src/options.js"

describe("parseOptions", () => {
  test("defaults to an enabled plugin on a tested host", () => {
    expect(parseOptions(undefined)).toEqual(DEFAULT_OPTIONS)
    expect(parseOptions({})).toEqual(DEFAULT_OPTIONS)
    expect(DEFAULT_OPTIONS).toEqual({ enabled: true, allowUntestedHost: false })
  })

  test("accepts every documented value", () => {
    expect(parseOptions({ enabled: false, allowUntestedHost: true })).toEqual({ enabled: false, allowUntestedHost: true })
    expect(parseOptions({ enabled: false, allowUntestedHost: false })).toEqual({ enabled: false, allowUntestedHost: false })
  })

  test.each([
    [{ timezone: "Europe/London" }, 'Unknown option "timezone". Accepted options: "enabled", "allowUntestedHost"'],
    [{ enabled: "yes" }, 'The option "enabled" must be true or false (true by default), found "yes"'],
    [{ enabled: null }, 'The option "enabled" must be true or false (true by default), found null'],
    [{ allowUntestedHost: 1 }, 'The option "allowUntestedHost" must be true or false (false by default), found 1'],
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
