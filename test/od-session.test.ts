import { describe, expect, test } from "bun:test"
import {
  cookieHeader,
  dedupe,
  isOpenDesignDomain,
  mergeSetCookies,
  normaliseCookies,
  sameCookies,
  type StoredCookie,
} from "../src/od-session"

const cookie = (name: string, value: string): StoredCookie => ({ name, value, domain: "open-design.ai" })

describe("normaliseCookies", () => {
  test("reads a raw Cookie header", () => {
    // What DevTools shows for a request to the API: names and values only.
    const cookies = normaliseCookies("better-auth.session_token=abc123; od_device_id=xyz")
    expect(cookies.map((entry) => [entry.name, entry.value])).toEqual([
      ["better-auth.session_token", "abc123"],
      ["od_device_id", "xyz"],
    ])
  })

  test("reads a Playwright storage_state", () => {
    const cookies = normaliseCookies({
      cookies: [
        { name: "session", value: "abc", domain: ".open-design.ai", path: "/" },
        { name: "other", value: "no", domain: ".example.com", path: "/" },
      ],
      origins: [],
    })
    expect(cookies).toEqual([{ name: "session", value: "abc", domain: "open-design.ai" }])
  })

  test("reads JSON text of either shape", () => {
    expect(normaliseCookies('{"name":"a","value":"1"}')).toEqual([cookie("a", "1")])
    expect(normaliseCookies('[{"name":"a","value":"1"}]')).toEqual([cookie("a", "1")])
  })

  test("keeps a cookie for the API host itself", () => {
    const cookies = normaliseCookies([
      { name: "session", value: "abc", domain: "amr-api.open-design.ai" },
    ])
    expect(cookies).toHaveLength(1)
  })

  test("refuses an unrelated domain", () => {
    // A storage_state from a browser holds every site's cookies; replaying a
    // school or bank cookie to OpenDesign would be worse than failing.
    expect(() => normaliseCookies([{ name: "a", value: "1", domain: "example.com" }])).toThrow(
      /no cookies for open-design\.ai/i,
    )
  })

  test("refuses an empty input", () => {
    expect(() => normaliseCookies("   ")).toThrow(/empty/i)
    expect(() => normaliseCookies("not json and no equals")).toThrow(/copy the cookie/i)
    expect(() => normaliseCookies(42)).toThrow(/cookie header/i)
  })

  test("last write wins per name", () => {
    expect(dedupe([cookie("a", "1"), cookie("a", "2")])).toEqual([cookie("a", "2")])
  })

  test("matches a subdomain but not a lookalike", () => {
    expect(isOpenDesignDomain(".open-design.ai")).toBe(true)
    expect(isOpenDesignDomain("amr-api.open-design.ai")).toBe(true)
    expect(isOpenDesignDomain("notopen-design.ai")).toBe(false)
    expect(isOpenDesignDomain("open-design.ai.example.com")).toBe(false)
  })
})

describe("mergeSetCookies", () => {
  const headers = (values: string[]) => {
    const next = new Headers()
    for (const value of values) next.append("set-cookie", value)
    return next
  }

  test("stores a cookie the response sets", () => {
    const merged = mergeSetCookies([cookie("a", "1")], headers(["b=2; Path=/; HttpOnly; Secure"]))
    expect(cookieHeader(merged)).toBe("a=1; b=2")
  })

  test("replaces a rotated value", () => {
    const merged = mergeSetCookies([cookie("session", "old")], headers(["session=new; Path=/"]))
    expect(merged).toEqual([cookie("session", "new")])
  })

  test("removes a cookie cleared with Max-Age=0", () => {
    const merged = mergeSetCookies([cookie("session", "old")], headers(["session=; Max-Age=0; Path=/"]))
    expect(merged).toEqual([])
  })

  test("removes a cookie cleared with a past Expires", () => {
    const merged = mergeSetCookies(
      [cookie("session", "old")],
      headers(["session=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/"]),
    )
    expect(merged).toEqual([])
  })

  test("keeps a cookie whose Expires is in the future", () => {
    const future = new Date(Date.now() + 86_400_000).toUTCString()
    const merged = mergeSetCookies([], headers([`session=live; Expires=${future}; Path=/`]))
    expect(merged).toEqual([cookie("session", "live")])
  })

  test("leaves the input alone when the response sets nothing", () => {
    const before = [cookie("a", "1")]
    expect(mergeSetCookies(before, new Headers())).toEqual(before)
  })
})

describe("sameCookies", () => {
  test("compares by name and value regardless of order", () => {
    expect(sameCookies([cookie("a", "1"), cookie("b", "2")], [cookie("b", "2"), cookie("a", "1")])).toBe(true)
  })

  test("notices a changed value or a different count", () => {
    expect(sameCookies([cookie("a", "1")], [cookie("a", "2")])).toBe(false)
    expect(sameCookies([cookie("a", "1")], [cookie("a", "1"), cookie("b", "2")])).toBe(false)
  })
})

describe("pasting from a browser", () => {
  // Every one of these is something a person actually copies out of DevTools.
  const EXPECTED = [
    ["better-auth.session_token", "abc.def"],
    ["od_device_id", "xyz"],
  ]

  test("a bare Cookie header", () => {
    expect(pairs(normaliseCookies("better-auth.session_token=abc.def; od_device_id=xyz"))).toEqual(EXPECTED)
  })

  test("a header with its label in front", () => {
    expect(pairs(normaliseCookies("cookie: better-auth.session_token=abc.def; od_device_id=xyz"))).toEqual(EXPECTED)
  })

  test("a whole Copy as cURL command", () => {
    const pasted = `curl 'https://amr-api.open-design.ai/api/v1/workspaces/current' \\
  -H 'accept: application/json' \\
  -H 'cookie: better-auth.session_token=abc.def; od_device_id=xyz' \\
  --compressed`
    expect(pairs(normaliseCookies(pasted))).toEqual(EXPECTED)
  })

  test("a cURL command using -b instead of a header", () => {
    const pasted = `curl 'https://amr-api.open-design.ai/api/v1/workspaces/current' -b 'better-auth.session_token=abc.def; od_device_id=xyz'`
    expect(pairs(normaliseCookies(pasted))).toEqual(EXPECTED)
  })

  test("a whole Copy as fetch snippet", () => {
    const pasted = `fetch("https://amr-api.open-design.ai/api/v1/workspaces/current", {
  "headers": {
    "accept": "application/json",
    "cookie": "better-auth.session_token=abc.def; od_device_id=xyz"
  },
  "method": "GET"
});`
    expect(pairs(normaliseCookies(pasted))).toEqual(EXPECTED)
  })

  test("a hand-written headers object", () => {
    expect(pairs(normaliseCookies("{ headers: { cookie: 'better-auth.session_token=abc.def' } }"))).toEqual([
      ["better-auth.session_token", "abc.def"],
    ])
  })

  test("says what to copy when nothing parses", () => {
    expect(() => normaliseCookies("https://open-design.ai/cloud")).toThrow(/amr-api\.open-design\.ai/i)
  })
})

function pairs(cookies: readonly StoredCookie[]) {
  return cookies.map((cookie) => [cookie.name, cookie.value])
}

describe("a Windows cmd cURL export", () => {
  // Firefox/Chrome on Windows escape every metacharacter with `^`, so the pasted
  // text is `curl --url ^"https://…^" -b ^"a=^%^2Fb^"`. Reading that literally
  // finds no cookie at all, which is what made this worth handling.
  const pasted = String.raw`curl --url ^"https://amr-api.open-design.ai/api/v1/workspaces/current^" ^
  -H ^"accept: application/json^" ^
  -b ^"od_attr=^%^7B^%^22s^%^22^%^7D; __Secure-better-auth.session_token=AAA.BBB^%^2FCCC^%^3D; other=x^" ^`

  test("finds the cookie", () => {
    const cookies = normaliseCookies(pasted)
    expect(pairs(cookies)).toEqual([
      ["od_attr", '%7B%22s%22%7D'],
      ["__Secure-better-auth.session_token", "AAA.BBB%2FCCC%3D"],
      ["other", "x"],
    ])
  })

  test("leaves the session token exactly as the browser sent it", () => {
    // The token's value must not be percent-decoded: the server accepts either,
    // but a rewrite here would be an unforced change to a credential.
    const cookies = normaliseCookies(pasted)
    expect(cookieHeader(cookies)).toContain("__Secure-better-auth.session_token=AAA.BBB%2FCCC%3D")
  })

  test("a plain header containing a caret is untouched", () => {
    expect(pairs(normaliseCookies("a=1^2; b=3"))).toEqual([
      ["a", "1^2"],
      ["b", "3"],
    ])
  })
})

describe("a Copy all as cURL export", () => {
  // DevTools "Copy all as cURL" is a list of every request, and the session
  // cookie appears only on the API ones. Picking the first header would replay
  // analytics cookies and none of the session.
  const pasted = String.raw`curl --url ^"https://open-design.ai/cloud/dashboard^" ^
  -b ^"od_attr=^%^7B^%^7D; _ga=GA1.1.923733920.1793240938^" &
curl --url ^"https://amr-api.open-design.ai/api/auth/get-session^" ^
  -b ^"od_attr=^%^7B^%^7D; __Secure-better-auth.session_token=AAA.BBB; other=x^" &`

  test("picks the request that carries the session", () => {
    expect(pairs(normaliseCookies(pasted))).toEqual([
      ["od_attr", "%7B%7D"],
      ["__Secure-better-auth.session_token", "AAA.BBB"],
      ["other", "x"],
    ])
  })

  test("falls back to the first header when none is a session", () => {
    expect(pairs(normaliseCookies(`curl --url "https://x" -b "a=1; b=2"`))).toEqual([
      ["a", "1"],
      ["b", "2"],
    ])
  })
})
