import { describe, expect, test } from "bun:test"
import path from "node:path"

const publicDirectory = path.join(import.meta.dir, "..", "web", "public")
const publicFiles = ["index.html", "app.js", "style.css", "summary.js"]

function publicFile(name: string) {
  return Bun.file(path.join(publicDirectory, name)).text()
}

describe("dashboard behind a path prefix", () => {
  test("no public file references an absolute asset or API path", async () => {
    for (const name of publicFiles) {
      const text = await publicFile(name)
      expect(text).not.toMatch(/["'`]\/api\//)
      expect(text).not.toMatch(/(?:href|src)\s*=\s*["']\//)
      expect(text).not.toMatch(/fetch\s*\(\s*["'`]\//)
    }
  })

  test("index.html loads its assets relative to the page", async () => {
    const html = await publicFile("index.html")
    expect(html).toMatch(/href="(?:\.\/)?style\.css"/)
    expect(html).toMatch(/src="(?:\.\/)?app\.js"/)
  })

  test("app.js resolves API URLs against the document base", async () => {
    const app = await publicFile("app.js")
    expect(app).toContain('new URL("./api/", document.baseURI)')
    expect(app).not.toContain("location.origin")
  })
})
