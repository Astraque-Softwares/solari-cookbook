import { spawn } from "node:child_process"

function opener(): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return { command: "explorer.exe", args: [] }
  }
  if (process.platform === "darwin") {
    return { command: "open", args: [] }
  }
  return { command: "xdg-open", args: [] }
}

export function openLocalReport(path: string): void {
  const selected = opener()
  const child = spawn(selected.command, [...selected.args, path], {
    detached: true,
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  })
  child.once("error", () => {
    process.stderr.write("Could not open the report automatically; open the generated HTML file directly.\n")
  })
  child.unref()
}
