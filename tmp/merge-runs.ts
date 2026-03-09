import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  runManifestV2Schema,
  type BenchmarkResultV2,
  type RunManifestV2,
  type RunMetadataV2,
} from "../lib/dystopiabench/schemas"
import { summarizeResults } from "../lib/dystopiabench/runner"
import { buildScenarioSelectionMetadata } from "../lib/dystopiabench/scenario-manifest"
import { SCENARIO_CATALOG_VERSION } from "../lib/dystopiabench/scenarios"
import {
  getDataDir,
  makeRunId,
  publishLatest,
  sanitizeRunId,
  writeRunManifest,
} from "../lib/dystopiabench/storage"
import { toModuleId } from "../lib/dystopiabench/types"

function parseArg(flag: string): string | undefined {
  const prefix = `${flag}=`
  const inline = process.argv.find((value) => value.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)

  const idx = process.argv.indexOf(flag)
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1]
  }

  return undefined
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag)
}

function parseCsvArg(flag: string): string[] {
  const input = parseArg(flag)
  if (!input) return []
  return input
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
}

function parseRunIds(): string[] {
  const runIds = parseCsvArg("--run-ids").map((value) => sanitizeRunId(value))
  if (runIds.length === 0) {
    throw new Error(
      "Missing --run-ids. Example: pnpm tsx tmp/merge-runs.ts --run-ids=id1,id2,id3"
    )
  }
  return runIds
}

function resolveOutputRunId(runIds: string[], manifests: RunManifestV2[]): string {
  const requested = parseArg("--output-run-id")
  if (!requested) {
    const latestTimestamp = Math.max(...manifests.map((manifest) => manifest.timestamp))
    return makeRunId(new Date(latestTimestamp + 5 * 60 * 1000))
  }
  const runId = sanitizeRunId(requested)
  if (runIds.includes(runId)) {
    throw new Error("--output-run-id must not match any input run id.")
  }
  return runId
}

function resultKey(row: Pick<BenchmarkResultV2, "scenarioId" | "modelId" | "level">): string {
  return `${row.scenarioId}::${row.modelId}::${row.level}`
}

function loadManifestByRunId(runId: string): RunManifestV2 | null {
  const runPath = join(getDataDir(), `benchmark-${runId}.json`)
  if (!existsSync(runPath)) return null

  const raw = JSON.parse(readFileSync(runPath, "utf-8")) as unknown
  const parsed = runManifestV2Schema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`Run file is not a valid benchmark manifest: ${runPath}`)
  }
  return parsed.data
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right))
}

function sameNumberSet(left: number[] | undefined, right: number[] | undefined): boolean {
  const normalizedLeft = [...new Set(left ?? [])].sort((a, b) => a - b)
  const normalizedRight = [...new Set(right ?? [])].sort((a, b) => a - b)
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index])
}

function sameStringSet(left: string[] | undefined, right: string[] | undefined): boolean {
  const normalizedLeft = uniqueSorted(left ?? [])
  const normalizedRight = uniqueSorted(right ?? [])
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index])
}

function assertCompatible(base: RunManifestV2, candidate: RunManifestV2): void {
  if (base.metadata.module !== candidate.metadata.module) {
    throw new Error(
      `Cannot merge runs from different modules: ${base.runId}=${base.metadata.module}, ${candidate.runId}=${candidate.metadata.module}`
    )
  }

  if ((base.metadata.conversationMode ?? "stateful") !== (candidate.metadata.conversationMode ?? "stateful")) {
    throw new Error(
      `Cannot merge runs with different conversation modes: ${base.runId} and ${candidate.runId}`
    )
  }

  if (!sameNumberSet(base.metadata.levels, candidate.metadata.levels)) {
    throw new Error(`Cannot merge runs with different level sets: ${base.runId} and ${candidate.runId}`)
  }

  if (!sameStringSet(base.metadata.selectedScenarioIds, candidate.metadata.selectedScenarioIds)) {
    throw new Error(
      `Cannot merge runs with different selected scenario sets: ${base.runId} and ${candidate.runId}`
    )
  }

  if ((base.metadata.transportPolicy ?? "chat-first-fallback") !== (candidate.metadata.transportPolicy ?? "chat-first-fallback")) {
    throw new Error(
      `Cannot merge runs with different transport policies: ${base.runId} and ${candidate.runId}`
    )
  }
}

function mergeGenerationConfig(
  manifests: RunManifestV2[],
): RunMetadataV2["generationConfig"] {
  const configs = manifests
    .map((manifest) => manifest.metadata.generationConfig)
    .filter(Boolean)

  const first = JSON.stringify(configs[0])
  const allSame = configs.every((config) => JSON.stringify(config) === first)
  if (allSame) return configs[0]

  const base = configs[0]
  return {
    ...base,
    concurrency: undefined,
    perModelConcurrency: undefined,
  }
}

function mergeCapabilitiesSnapshot(manifests: RunManifestV2[]): Record<string, unknown> | undefined {
  const entries: Array<[string, unknown]> = []
  for (const manifest of manifests) {
    const snapshot = manifest.metadata.modelCapabilitiesSnapshot
    if (!snapshot) continue
    for (const [key, value] of Object.entries(snapshot)) {
      entries.push([key, value])
    }
  }

  if (entries.length === 0) return undefined
  return Object.fromEntries(entries)
}

function chooseLatestResult(existing: BenchmarkResultV2, incoming: BenchmarkResultV2): BenchmarkResultV2 {
  return incoming.timestamp >= existing.timestamp ? incoming : existing
}

function sortResults(results: BenchmarkResultV2[]): BenchmarkResultV2[] {
  return [...results].sort((left, right) => {
    if (left.module !== right.module) return left.module.localeCompare(right.module)
    if (left.modelId !== right.modelId) return left.modelId.localeCompare(right.modelId)
    if (left.scenarioId !== right.scenarioId) return left.scenarioId.localeCompare(right.scenarioId)
    return left.level - right.level
  })
}

function buildMergedManifest(
  outputRunId: string,
  manifests: RunManifestV2[],
): RunManifestV2 {
  const base = manifests[0]
  const resultMap = new Map<string, BenchmarkResultV2>()

  for (const manifest of manifests) {
    for (const row of manifest.results) {
      const key = resultKey(row)
      const existing = resultMap.get(key)
      resultMap.set(key, existing ? chooseLatestResult(existing, row) : row)
    }
  }

  const results = sortResults(Array.from(resultMap.values()))
  const metadata: RunMetadataV2 = {
    module: base.metadata.module,
    models: uniqueSorted(results.map((row) => row.modelId)),
    levels: [...new Set(results.map((row) => row.level))].sort((a, b) => a - b),
    totalPrompts: results.length,
    scenarioCatalogVersion: base.metadata.scenarioCatalogVersion ?? SCENARIO_CATALOG_VERSION,
    ...buildScenarioSelectionMetadata(
      Array.from(
        new Map(
          results.map((row) => [
            row.scenarioId,
            { id: row.scenarioId, module: toModuleId(row.module) },
          ])
        ).values()
      )
    ),
    judgeModel: base.metadata.judgeModel,
    judgeModels: uniqueSorted(
      manifests.flatMap((manifest) => manifest.metadata.judgeModels ?? [manifest.metadata.judgeModel])
    ),
    systemPromptVersion: base.metadata.systemPromptVersion,
    benchmarkPromptVersion: base.metadata.benchmarkPromptVersion,
    judgePromptVersion: base.metadata.judgePromptVersion,
    transportPolicy: base.metadata.transportPolicy,
    conversationMode: base.metadata.conversationMode,
    modelCapabilitiesSnapshot: mergeCapabilitiesSnapshot(manifests),
    generationConfig: mergeGenerationConfig(manifests),
  }

  return {
    schemaVersion: 3,
    runId: outputRunId,
    timestamp: Date.now(),
    date: new Date().toISOString(),
    metadata,
    summary: summarizeResults(results),
    results,
  }
}

function main() {
  const runIds = parseRunIds()
  const ignoreMissing = hasFlag("--ignore-missing")
  const noPublish = hasFlag("--no-publish")

  const loaded: RunManifestV2[] = []
  const missing: string[] = []

  for (const runId of runIds) {
    const manifest = loadManifestByRunId(runId)
    if (!manifest) {
      if (ignoreMissing) {
        missing.push(runId)
        continue
      }
      throw new Error(`Run file not found: public/data/benchmark-${runId}.json`)
    }
    loaded.push(manifest)
  }

  if (loaded.length === 0) {
    throw new Error("No input run manifests were found.")
  }

  const outputRunId = resolveOutputRunId(runIds, loaded)
  const base = loaded[0]
  for (const candidate of loaded.slice(1)) {
    assertCompatible(base, candidate)
  }

  const merged = buildMergedManifest(outputRunId, loaded)
  writeRunManifest(merged)

  console.log(`Merged ${loaded.length} run(s) into public/data/benchmark-${outputRunId}.json`)
  if (missing.length > 0) {
    console.log(`Ignored missing run(s): ${missing.join(", ")}`)
  }
  console.log(
    `Results: ${merged.results.length} | Models: ${merged.metadata.models.length} | Scenarios: ${merged.metadata.selectedScenarioCount} | Avg DCS: ${merged.summary.averageDcs}`
  )

  if (!noPublish) {
    publishLatest(merged)
    console.log("Updated latest: public/data/benchmark-results.json")
    const mode = merged.metadata.conversationMode === "stateless" ? "stateless" : "stateful"
    console.log(`Updated mode latest: public/data/benchmark-results-${mode}.json`)
  } else {
    console.log("Skipped latest publish due to --no-publish.")
  }
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
