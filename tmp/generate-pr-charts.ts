import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { AVAILABLE_MODELS } from "../lib/dystopiabench/models"
import {
  LEVEL_LABELS,
  MODULE_COLORS,
  getModuleColor,
  scoreColor,
} from "../lib/dystopiabench/chart-config"
import { runManifestV2Schema, type RunManifestV2 } from "../lib/dystopiabench/schemas"

type ParsedArgs = {
  runIds: string[]
  files: string[]
  outDir: string
}

type ModelSummary = {
  modelId: string
  avgDcs: number
  refusalRate: number
  counts: Record<string, number>
}

type ScenarioSummary = {
  scenarioId: string
  title: string
  avgDcs: number
}

type RunSummary = {
  moduleId: string
  moduleLabel: string
  runId: string
  conversationMode: "stateful" | "stateless"
  scenarioCount: number
  modelSummaries: ModelSummary[]
  levelAverages: Array<{ level: number; avgDcs: number }>
  scenarioSummaries: ScenarioSummary[]
}

const SVG_BG = "#0b1020"
const PANEL_BG = "#121a30"
const GRID = "#24304f"
const TEXT = "#e5ecff"
const MUTED = "#94a3b8"

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    runIds: [],
    files: [],
    outDir: "tmp/pr-charts",
  }

  for (const arg of argv) {
    if (arg.startsWith("--run-ids=")) {
      args.runIds = arg
        .slice("--run-ids=".length)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
      continue
    }

    if (arg.startsWith("--files=")) {
      args.files = arg
        .slice("--files=".length)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
      continue
    }

    if (arg.startsWith("--out-dir=")) {
      args.outDir = arg.slice("--out-dir=".length).trim() || args.outDir
    }
  }

  return args
}

function usage(): never {
  throw new Error(
    "Usage: tsx tmp/generate-pr-charts.ts --run-ids=<id> or <id1,id2> [--out-dir=tmp/pr-charts] OR --files=<file> or <file1,file2>"
  )
}

function resolveRunPaths(args: ParsedArgs): string[] {
  if (args.runIds.length > 0 && args.files.length > 0) {
    throw new Error("Use either --run-ids or --files, not both.")
  }

  if (args.runIds.length >= 1 && args.runIds.length <= 2) {
    return args.runIds.map((runId) =>
      resolve(process.cwd(), "public", "data", `benchmark-${runId}.json`)
    )
  }

  if (args.files.length >= 1 && args.files.length <= 2) {
    return args.files.map((file) =>
      isAbsolute(file) ? file : resolve(process.cwd(), file)
    )
  }

  return usage()
}

function loadManifest(filePath: string): RunManifestV2 {
  const raw = JSON.parse(readFileSync(filePath, "utf-8")) as unknown
  const parsed = runManifestV2Schema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`Invalid benchmark manifest: ${filePath}`)
  }
  return parsed.data
}

function average(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function percent(part: number, total: number): number {
  if (total === 0) return 0
  return (part / total) * 100
}

function titleCase(input: string): string {
  return input.charAt(0).toUpperCase() + input.slice(1)
}

function summarizeRun(manifest: RunManifestV2): RunSummary {
  const moduleId = String(
    manifest.metadata.scenarioModuleIds?.[0] ??
      manifest.metadata.module
  )
  return summarizeModuleRows(manifest, moduleId, manifest.results)
}

function summarizeModuleRows(
  manifest: RunManifestV2,
  moduleId: string,
  rowsForModule: RunManifestV2["results"]
): RunSummary {
  const moduleLabel = `${titleCase(moduleId)} Module`
  const rows = rowsForModule.filter(
    (result) => result.module === moduleId && typeof result.score === "number"
  )

  const modelIds = manifest.metadata.models
  const modelSummaries = modelIds.map((modelId) => {
    const modelRows = rows.filter((row) => row.modelId === modelId)
    const avgDcs = average(modelRows.map((row) => row.score ?? 0))
    const counts = {
      refusal: modelRows.filter((row) => row.compliance === "refusal").length,
      hesitant: modelRows.filter((row) => row.compliance === "hesitant").length,
      compliant: modelRows.filter((row) => row.compliance === "compliant").length,
      proactive: modelRows.filter((row) => row.compliance === "proactive").length,
    }

    return {
      modelId,
      avgDcs: +avgDcs.toFixed(1),
      refusalRate: +percent(counts.refusal, modelRows.length).toFixed(1),
      counts,
    }
  })

  const levelAverages = [1, 2, 3, 4, 5].map((level) => {
    const levelRows = rows.filter((row) => row.level === level)
    return {
      level,
      avgDcs: +average(levelRows.map((row) => row.score ?? 0)).toFixed(1),
    }
  })

  const scenarioTitles = new Map<string, string>()
  for (const row of rows) scenarioTitles.set(row.scenarioId, row.scenarioTitle)
  const scenarioIds = [...new Set(rows.map((row) => row.scenarioId))]
  const scenarioSummaries = scenarioIds.map((scenarioId) => {
    const scenarioRows = rows.filter((row) => row.scenarioId === scenarioId)
    return {
      scenarioId,
      title: scenarioTitles.get(scenarioId) ?? scenarioId,
      avgDcs: +average(scenarioRows.map((row) => row.score ?? 0)).toFixed(1),
    }
  })

  return {
    moduleId,
    moduleLabel,
    runId: manifest.runId,
    conversationMode:
      manifest.metadata.conversationMode === "stateless" ? "stateless" : "stateful",
    scenarioCount:
      manifest.metadata.selectedScenarioCount ??
      manifest.metadata.selectedScenarioIds?.length ??
      scenarioIds.length,
    modelSummaries,
    levelAverages,
    scenarioSummaries,
  }
}

function summarizeManifestByModules(manifest: RunManifestV2): RunSummary[] {
  const moduleIds = [
    ...new Set(
      manifest.results
        .map((result) => String(result.module))
        .filter(Boolean)
    ),
  ]

  return moduleIds.map((moduleId) =>
    summarizeModuleRows(manifest, moduleId, manifest.results)
  )
}

function svgHeader(width: number, height: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none">`
}

function svgText(
  x: number,
  y: number,
  text: string,
  options: { size?: number; weight?: number; fill?: string; anchor?: "start" | "middle" | "end" } = {}
): string {
  const size = options.size ?? 14
  const weight = options.weight ?? 400
  const fill = options.fill ?? TEXT
  const anchor = options.anchor ?? "start"
  return `<text x="${x}" y="${y}" fill="${fill}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${escapeXml(
    text
  )}</text>`
}

function escapeXml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

function renderGroupedBarChart(runs: RunSummary[]): string {
  const width = 1280
  const height = 760
  const margin = { top: 80, right: 40, bottom: 160, left: 80 }
  const chartWidth = width - margin.left - margin.right
  const chartHeight = height - margin.top - margin.bottom
  const models = AVAILABLE_MODELS.map((model) => model.id)
  const groupWidth = chartWidth / models.length
  const innerPad = 16
  const barWidth = (groupWidth - innerPad * 2) / runs.length

  const parts: string[] = [
    svgHeader(width, height),
    `<rect width="${width}" height="${height}" fill="${SVG_BG}" rx="16"/>`,
    svgText(margin.left, 36, "Average DCS by Model and Module", {
      size: 24,
      weight: 700,
    }),
    svgText(margin.left, 58, "Lower is safer. Grouped bars compare module-level averages from the selected run set.", {
      size: 12,
      fill: MUTED,
    }),
  ]

  for (let tick = 0; tick <= 100; tick += 20) {
    const y = margin.top + chartHeight - (tick / 100) * chartHeight
    parts.push(`<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="${GRID}" stroke-width="1"/>`)
    parts.push(svgText(margin.left - 10, y + 4, String(tick), { size: 11, fill: MUTED, anchor: "end" }))
  }

  models.forEach((modelId, index) => {
    const groupX = margin.left + index * groupWidth
    runs.forEach((run, runIndex) => {
      const summary = run.modelSummaries.find((row) => row.modelId === modelId)
      const value = summary?.avgDcs ?? 0
      const barHeight = (value / 100) * chartHeight
      const x = groupX + innerPad + runIndex * barWidth
      const y = margin.top + chartHeight - barHeight
      parts.push(
        `<rect x="${x}" y="${y}" width="${Math.max(barWidth - 6, 8)}" height="${barHeight}" rx="4" fill="${MODULE_COLORS[run.moduleId] ?? getModuleColor(run.moduleId)}"/>`
      )
    })
    parts.push(
      svgText(groupX + groupWidth / 2, height - 88, modelId, {
        size: 11,
        fill: MUTED,
        anchor: "middle",
      })
    )
  })

  runs.forEach((run, index) => {
    const x = margin.left + index * 220
    const y = height - 42
    const color = MODULE_COLORS[run.moduleId] ?? getModuleColor(run.moduleId)
    parts.push(`<rect x="${x}" y="${y - 10}" width="14" height="14" rx="3" fill="${color}"/>`)
    parts.push(svgText(x + 22, y + 1, `${run.moduleLabel} (${run.runId})`, { size: 12, fill: TEXT }))
  })

  parts.push("</svg>")
  return parts.join("\n")
}

function renderEscalationCurves(runs: RunSummary[]): string {
  const width = 1280
  const height = 620
  const panelGap = 32
  const panelWidth = (width - 80 - panelGap * Math.max(runs.length - 1, 0)) / runs.length
  const panelHeight = 460
  const parts: string[] = [
    svgHeader(width, height),
    `<rect width="${width}" height="${height}" fill="${SVG_BG}" rx="16"/>`,
    svgText(40, 36, "Escalation Curves by Module", { size: 24, weight: 700 }),
    svgText(40, 58, "Average DCS across L1-L5 for the two selected runs.", {
      size: 12,
      fill: MUTED,
    }),
  ]

  runs.forEach((run, index) => {
    const panelX = 40 + index * (panelWidth + panelGap)
    const panelY = 90
    parts.push(`<rect x="${panelX}" y="${panelY}" width="${panelWidth}" height="${panelHeight}" rx="12" fill="${PANEL_BG}" stroke="${GRID}" stroke-width="1"/>`)
    parts.push(svgText(panelX + 20, panelY + 28, `${run.moduleLabel}`, { size: 18, weight: 700 }))
    parts.push(svgText(panelX + 20, panelY + 48, `${run.runId} • ${run.conversationMode}`, { size: 11, fill: MUTED }))

    const chartX = panelX + 56
    const chartY = panelY + 70
    const chartW = panelWidth - 88
    const chartH = panelHeight - 120

    for (let tick = 0; tick <= 100; tick += 25) {
      const y = chartY + chartH - (tick / 100) * chartH
      parts.push(`<line x1="${chartX}" y1="${y}" x2="${chartX + chartW}" y2="${y}" stroke="${GRID}" stroke-width="1"/>`)
      parts.push(svgText(chartX - 10, y + 4, String(tick), { size: 10, fill: MUTED, anchor: "end" }))
    }

    run.levelAverages.forEach((point, pointIndex) => {
      const x = chartX + (pointIndex / 4) * chartW
      const y = chartY + chartH - (point.avgDcs / 100) * chartH
      if (pointIndex > 0) {
        const prev = run.levelAverages[pointIndex - 1]
        const prevX = chartX + ((pointIndex - 1) / 4) * chartW
        const prevY = chartY + chartH - (prev.avgDcs / 100) * chartH
        parts.push(`<line x1="${prevX}" y1="${prevY}" x2="${x}" y2="${y}" stroke="${MODULE_COLORS[run.moduleId] ?? getModuleColor(run.moduleId)}" stroke-width="4" stroke-linecap="round"/>`)
      }
      parts.push(`<circle cx="${x}" cy="${y}" r="5" fill="${MODULE_COLORS[run.moduleId] ?? getModuleColor(run.moduleId)}"/>`)
      parts.push(svgText(x, chartY + chartH + 24, LEVEL_LABELS[point.level], { size: 10, fill: MUTED, anchor: "middle" }))
      parts.push(svgText(x, y - 10, String(point.avgDcs), { size: 10, fill: TEXT, anchor: "middle" }))
    })
  })

  parts.push("</svg>")
  return parts.join("\n")
}

function renderScenarioHeatmap(runs: RunSummary[]): string {
  const width = 1280
  const height = 720
  const panelGap = 32
  const panelWidth = (width - 80 - panelGap * Math.max(runs.length - 1, 0)) / runs.length
  const parts: string[] = [
    svgHeader(width, height),
    `<rect width="${width}" height="${height}" fill="${SVG_BG}" rx="16"/>`,
    svgText(40, 36, "Scenario Difficulty Heatmap", { size: 24, weight: 700 }),
    svgText(40, 58, "Average DCS by scenario. Cooler cells are safer; warmer cells indicate more compliance.", {
      size: 12,
      fill: MUTED,
    }),
  ]

  runs.forEach((run, index) => {
    const panelX = 40 + index * (panelWidth + panelGap)
    const panelY = 90
    const rowHeight = 88
    parts.push(`<rect x="${panelX}" y="${panelY}" width="${panelWidth}" height="560" rx="12" fill="${PANEL_BG}" stroke="${GRID}" stroke-width="1"/>`)
    parts.push(svgText(panelX + 20, panelY + 28, `${run.moduleLabel}`, { size: 18, weight: 700 }))
    parts.push(svgText(panelX + 20, panelY + 48, `${run.runId}`, { size: 11, fill: MUTED }))

    run.scenarioSummaries.forEach((scenario, rowIndex) => {
      const y = panelY + 72 + rowIndex * rowHeight
      const color = scoreColor(scenario.avgDcs)
      parts.push(`<rect x="${panelX + 20}" y="${y}" width="${panelWidth - 40}" height="64" rx="8" fill="${color}" fill-opacity="0.2" stroke="${color}" stroke-width="1"/>`)
      parts.push(svgText(panelX + 36, y + 24, scenario.scenarioId, { size: 12, weight: 700 }))
      parts.push(svgText(panelX + 36, y + 44, scenario.title, { size: 11, fill: MUTED }))
      parts.push(svgText(panelX + panelWidth - 32, y + 38, `${scenario.avgDcs}`, {
        size: 20,
        weight: 700,
        anchor: "end",
      }))
    })
  })

  parts.push("</svg>")
  return parts.join("\n")
}

function renderMarkdownSummary(runs: RunSummary[]): string {
  const lines: string[] = [
    "# PR Run Summary",
    "",
    "| Module | Run ID | Mode | Scenarios | Lowest model DCS | Highest model DCS |",
    "|---|---|---|---:|---:|---:|",
  ]

  for (const run of runs) {
    const scores = run.modelSummaries.map((row) => row.avgDcs)
    lines.push(
      `| ${run.moduleId} | ${run.runId} | ${run.conversationMode} | ${run.scenarioCount} | ${Math.min(...scores).toFixed(
        1
      )} | ${Math.max(...scores).toFixed(1)} |`
    )
  }

  lines.push("", "## Model DCS by module", "")

  const header = ["Model", ...runs.map((run) => `${run.moduleId} DCS`), ...runs.map((run) => `${run.moduleId} refusal%`)]
  lines.push(`| ${header.join(" | ")} |`)
  lines.push(`| ${header.map(() => "---").join(" | ")} |`)

  for (const model of AVAILABLE_MODELS) {
    const dcs = runs.map((run) => run.modelSummaries.find((row) => row.modelId === model.id)?.avgDcs ?? 0)
    const refusal = runs.map((run) => run.modelSummaries.find((row) => row.modelId === model.id)?.refusalRate ?? 0)
    lines.push(
      `| ${model.id} | ${dcs.map((value) => value.toFixed(1)).join(" | ")} | ${refusal
        .map((value) => `${value.toFixed(1)}%`)
        .join(" | ")} |`
    )
  }

  lines.push("")
  return lines.join("\n")
}

function writeOutputs(outDir: string, runs: RunSummary[]) {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, "module-model-dcs.svg"), renderGroupedBarChart(runs), "utf-8")
  writeFileSync(join(outDir, "module-escalation-curves.svg"), renderEscalationCurves(runs), "utf-8")
  writeFileSync(join(outDir, "module-scenario-heatmap.svg"), renderScenarioHeatmap(runs), "utf-8")
  writeFileSync(join(outDir, "summary.md"), renderMarkdownSummary(runs), "utf-8")
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const runPaths = resolveRunPaths(args)
  const manifests = runPaths.map(loadManifest)
  const runs =
    manifests.length === 1
      ? summarizeManifestByModules(manifests[0])
      : manifests.map(summarizeRun)

  if (new Set(runs.map((run) => run.moduleId)).size !== runs.length) {
    throw new Error("Expected unique module ids across the selected input manifest(s).")
  }

  writeOutputs(resolve(process.cwd(), args.outDir), runs)

  console.log("Generated PR chart bundle:")
  for (const fileName of [
    "module-model-dcs.svg",
    "module-escalation-curves.svg",
    "module-scenario-heatmap.svg",
    "summary.md",
  ]) {
    console.log(`- ${join(args.outDir, fileName)}`)
  }
}

main()
