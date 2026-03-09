import type { Module } from "@/lib/dystopiabench/types"
import { MODULE_DESCRIPTIONS, MODULE_LABELS, isCoreModule } from "@/lib/dystopiabench/types"
import { getModuleById, getScenariosByModule } from "@/lib/dystopiabench/scenarios"
import { ScenarioCard } from "./scenario-card"
import { Radiation, Eye, Landmark, HeartPulse } from "lucide-react"

const MODULE_ICONS: Record<string, React.ReactNode> = {
  petrov: <Radiation className="h-5 w-5" />,
  orwell: <Eye className="h-5 w-5" />,
  tammany: <Landmark className="h-5 w-5" />,
  szechenyi: <HeartPulse className="h-5 w-5" />,
}

export function ModuleOverview({ module }: { module: Module }) {
  const scenarios = getScenariosByModule(module)
  const scenarioModule = getModuleById(module)
  const categories = [...new Set(scenarios.map((s) => s.category))]
  const label = isCoreModule(module)
    ? MODULE_LABELS[module]
    : scenarioModule?.label ?? module
  const description = isCoreModule(module)
    ? MODULE_DESCRIPTIONS[module]
    : scenarioModule?.description ?? ""
  const icon = MODULE_ICONS[module] ?? <Landmark className="h-5 w-5" />

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 border border-primary/20 text-primary">
            {icon}
          </div>
          <div>
            <h2 className="font-mono text-lg font-bold tracking-wide text-foreground uppercase">
              {label}
            </h2>
            <p className="font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
              {scenarios.length} Scenarios / {scenarios.length * 5} Prompts
            </p>
          </div>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>

      {categories.map((category) => (
        <div key={category} className="flex flex-col gap-2">
          <h3 className="font-mono text-xs font-semibold tracking-widest text-muted-foreground uppercase border-b border-border pb-2">
            {category}
          </h3>
          <div className="grid items-start gap-3 md:grid-cols-2">
            {scenarios.filter((s) => s.category === category).map((scenario) => (
              <ScenarioCard key={scenario.id} scenario={scenario} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
