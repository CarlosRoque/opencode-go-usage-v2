import { Plugin } from "@opencode/plugin/tui"
import { Database } from "bun:sqlite"
import { createSignal, onCleanup } from "solid-js"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// OpenCode Go usage widget (CLI plugin for OpenCode v2)
//
// Shows the OpenCode Go / Go Plus plan usage (rolling 5h / weekly / monthly)
// in the sidebar, fetched from the official read-only endpoint:
//   https://opencode.ai/zen/go/v1/usage
//
// Credential resolution order:
//   1. OPENCODE_API_KEY environment variable
//   2. OpenCode Console credential in opencode.db (OAuth access token or API key)
//   3. auth.json (legacy keys)
//
// The credential is re-read on every refresh so OAuth token rotation is
// handled automatically.
//
// Local visual rework (based on upstream v0.1.1, commit fab6083):
//   - status dot in the header shows the tightest window at a glance
//   - per-row color escalates green -> yellow -> red as the window fills
//   - right-aligned percent, smoother 12-char bars, compact countdowns
//   - a window at its limit shows MAX in the error color
//
// IMPORTANT (Solid): every value derived from reactive state is computed
// INSIDE the JSX expressions. Component bodies run only once, so hoisting
// these into locals freezes them at the pre-data render.

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage"

type UsageWindow = { status?: string; percent?: number; resetsAt?: string }
type Usage = { rolling?: UsageWindow; weekly?: UsageWindow; monthly?: UsageWindow }
type CliOptions = { refreshInterval?: number }

let refreshFn: (() => Promise<void>) | undefined

function dataDirCandidates(): string[] {
  const out: string[] = []
  if (process.env.OPENCODE_DATA_DIR) out.push(process.env.OPENCODE_DATA_DIR)
  if (process.env.XDG_DATA_HOME) out.push(join(process.env.XDG_DATA_HOME, "opencode"))
  if (process.env.LOCALAPPDATA) out.push(join(process.env.LOCALAPPDATA, "opencode"))
  out.push(join(homedir(), ".local", "share", "opencode"))
  return out
}

function stateDirCandidates(): string[] {
  const out: string[] = []
  if (process.env.XDG_STATE_HOME) out.push(join(process.env.XDG_STATE_HOME, "opencode"))
  if (process.env.LOCALAPPDATA) out.push(join(process.env.LOCALAPPDATA, "opencode", "state"))
  out.push(join(homedir(), ".local", "state", "opencode"))
  return out
}

function readKeyFromDb(): string | undefined {
  for (const dir of dataDirCandidates()) {
    const dbPath = join(dir, "opencode.db")
    try {
      if (!existsSync(dbPath)) continue
      const db = new Database(dbPath, { readonly: true })
      try {
        const rows = db
          .prepare("SELECT value FROM credential WHERE integration_id = 'opencode' AND active = 1")
          .all() as Array<{ value: string }>
        for (const row of rows) {
          try {
            const v = JSON.parse(row.value) as { type?: string; access?: string; key?: string }
            if (v?.type === "oauth" && typeof v.access === "string" && v.access.length > 0) return v.access
            if (v?.type === "key" && typeof v.key === "string" && v.key.length > 0) return v.key
          } catch {
            // skip malformed row
          }
        }
      } finally {
        db.close()
      }
    } catch {
      // try next candidate
    }
  }
  return undefined
}

function readKeyFromAuthJson(): string | undefined {
  for (const dir of [...dataDirCandidates(), ...stateDirCandidates()]) {
    const file = join(dir, "auth.json")
    try {
      if (!existsSync(file)) continue
      const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, { key?: string }>
      const key = data?.["opencode-go"]?.key ?? data?.["opencode"]?.key
      if (typeof key === "string" && key.length > 0) return key
    } catch {
      // try next candidate
    }
  }
  return undefined
}

function readKey(): string | undefined {
  if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY
  return readKeyFromDb() ?? readKeyFromAuthJson()
}

async function fetchUsage(key: string): Promise<Usage> {
  const res = await fetch(USAGE_URL, { headers: { Authorization: `Bearer ${key}` } })
  if (!res.ok) throw new Error(`usage API HTTP ${res.status}`)
  const body = (await res.json()) as { usage?: Usage }
  return body.usage ?? {}
}

// ---- formatting helpers (pure functions of their arguments) --------------

const BAR_WIDTH = 12
const LABEL_WIDTH = 3
const PCT_WIDTH = 4

type Theme = {
  text?: {
    base?: string
    muted?: string
    feedback?: {
      success?: { base?: string }
      warning?: { base?: string }
      error?: { base?: string }
    }
  }
}

function levelFor(win: UsageWindow | undefined): 0 | 1 | 2 | 3 {
  if (!win || typeof win.percent !== "number") return 0
  if (win.status === "limited" || win.percent >= 80) return 3
  if (win.percent >= 50) return 2
  return 1
}

function countdown(iso?: string): string {
  if (!iso) return ""
  const diff = new Date(iso).getTime() - Date.now()
  if (!Number.isFinite(diff)) return ""
  if (diff <= 0) return "now"
  const mins = Math.floor(diff / 60000)
  const days = Math.floor(mins / 1440)
  const hours = Math.floor((mins % 1440) / 60)
  if (days >= 10) return `${days}d`
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins % 60}m`
  return `${mins}m`
}

// ---- component ----------------------------------------------------------

function GoUsage(props: { intervalSeconds: number; theme?: Theme }) {
  const [usage, setUsage] = createSignal<Usage | undefined>()
  const [error, setError] = createSignal<string | undefined>()

  const refresh = async () => {
    let key: string | undefined
    try {
      key = readKey()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return
    }
    if (!key) {
      setError("no credential")
      return
    }
    try {
      const next = await fetchUsage(key)
      setUsage(next)
      setError(undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  refreshFn = refresh
  void refresh()
  const timer = setInterval(() => void refresh(), Math.max(15, props.intervalSeconds) * 1000)
  onCleanup(() => {
    clearInterval(timer)
    if (refreshFn === refresh) refreshFn = undefined
  })

  const t = props.theme?.text

  // every helper is invoked inside JSX braces so it re-runs when `usage`
  // or `error` change (Solid: bodies run once, JSX expressions are reactive)
  const c = () => ({
    base: t?.base,
    muted: t?.muted,
    success: t?.feedback?.success?.base ?? t?.base,
    warning: t?.feedback?.warning?.base ?? t?.muted,
    error: t?.feedback?.error?.base ?? t?.muted,
  })

  const color = (win: UsageWindow | undefined) => {
    const cc = c()
    const level = levelFor(win)
    if (level === 3) return cc.error
    if (level === 2) return cc.warning
    if (level === 1) return cc.success
    return cc.muted
  }

  const dotColor = () => {
    const cc = c()
    if (error()) return cc.warning
    const worst = Math.max(levelFor(usage()?.rolling), levelFor(usage()?.weekly), levelFor(usage()?.monthly))
    if (worst === 3) return cc.error
    if (worst === 2) return cc.warning
    if (worst === 1) return cc.success
    return cc.muted
  }

  const pct = (win: UsageWindow | undefined) => {
    if (!win || typeof win.percent !== "number") return "…"
    if (win.status === "limited") return "MAX"
    return `${Math.round(win.percent)}%`
  }

  const fill = (win: UsageWindow | undefined) => {
    const p = win && typeof win.percent === "number" ? Math.max(0, Math.min(100, win.percent)) : 0
    // any nonzero percent always shows at least one filled block, so the
    // fill never silently disappears on a short bar
    const filled = p > 0 ? Math.max(1, Math.round((p / 100) * BAR_WIDTH)) : 0
    return "█".repeat(filled)
  }

  const track = (win: UsageWindow | undefined) => {
    const p = win && typeof win.percent === "number" ? Math.max(0, Math.min(100, win.percent)) : 0
    const filled = p > 0 ? Math.max(1, Math.round((p / 100) * BAR_WIDTH)) : 0
    return "░".repeat(BAR_WIDTH - filled)
  }

  const cd = (win: UsageWindow | undefined) => {
    const text = countdown(win?.resetsAt)
    return text ? ` ${text}` : ""
  }

  const Row = (p: { label: string; win: UsageWindow | undefined }) => (
    <box flexDirection="row">
      <text flexShrink={0} fg={c().muted}>{p.label.padEnd(LABEL_WIDTH)} </text>
      <text flexShrink={0} fg={color(p.win)}>{pct(p.win).padStart(PCT_WIDTH)} </text>
      <text flexShrink={0} fg={color(p.win)}>{fill(p.win)}</text>
      <text flexShrink={0} fg={c().muted}>{track(p.win)}</text>
      <text flexShrink={0} fg={c().muted}>{cd(p.win)}</text>
    </box>
  )

  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text flexShrink={0} fg={dotColor()}>● </text>
        <text flexShrink={0} fg={c().base}>{error() ? `Go Usage · ${error()}` : "Go Usage"}</text>
      </box>
      <Row label="5h" win={usage()?.rolling} />
      <Row label="1w" win={usage()?.weekly} />
      <Row label="1mo" win={usage()?.monthly} />
    </box>
  )
}

export default Plugin.define({
  id: "go-usage.cli",
  setup(context) {
    const options = (context as unknown as { options?: CliOptions }).options ?? {}
    const parsed = Number(options.refreshInterval)
    const intervalSeconds = Number.isFinite(parsed) && parsed >= 15 ? parsed : 120

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "go-usage.refresh",
          title: "Refresh Go usage",
          group: "Go Usage",
          palette: true,
          slash: { name: "gousage" },
          run: async () => {
            await refreshFn?.()
            context.ui.toast.show({ message: "Go usage refreshed", variant: "success" })
          },
        },
      ],
    }))

    const theme = (context as unknown as { theme?: Theme }).theme

    return context.ui.slot({
      append: "sidebar.content",
      render: () => <GoUsage intervalSeconds={intervalSeconds} theme={theme} />,
    })
  },
})
