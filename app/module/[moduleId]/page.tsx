import { notFound } from "next/navigation"
import { BenchHeader } from "@/components/bench/header"
import { ModuleOverview } from "@/components/bench/module-overview"
import { ALL_MODULES, getModuleById } from "@/lib/dystopiabench/scenarios"

export function generateStaticParams() {
  return ALL_MODULES.map((scenarioModule) => ({
    moduleId: scenarioModule.id,
  }))
}

export default async function ModulePage({
  params,
}: {
  params: Promise<{ moduleId: string }>
}) {
  const { moduleId } = await params
  const scenarioModule = getModuleById(moduleId)

  if (!scenarioModule) {
    notFound()
  }

  return (
    <div className="min-h-screen bg-background">
      <BenchHeader />
      <main className="mx-auto max-w-7xl px-6 py-10">
        <ModuleOverview module={scenarioModule.id} />
      </main>
    </div>
  )
}
