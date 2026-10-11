import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from '@/components/layout/AppShell'
import { DashboardPage } from '@/pages/DashboardPage'
import { ProjectsPage } from '@/pages/ProjectsPage'
import { NewProjectPage } from '@/pages/NewProjectPage'
import { WorkspacePage } from '@/pages/WorkspacePage'
import { TranslatePage } from '@/pages/TranslatePage'
import { SettingsPage } from '@/pages/SettingsPage'
import { LogsPage } from '@/pages/LogsPage'
import { KnowledgePage } from '@/pages/KnowledgePage'
import { MyanmarTestPage } from '@/pages/MyanmarTestPage'
import { WelcomePage } from '@/pages/WelcomePage'
import { useUiStore } from '@/stores/uiStore'

/**
 * First-run guard, index route only: before `completeOnboarding()` the
 * dashboard is the welcome/setup screen instead. Deep links (projects,
 * workspace, settings…) are never gated — a shared URL must always open.
 */
function IndexRoute() {
  const onboarded = useUiStore((state) => state.onboarded)
  return onboarded ? <DashboardPage /> : <Navigate to="/welcome" replace />
}

/** Once onboarded the welcome screen sends the user to the dashboard. */
function WelcomeRoute() {
  const onboarded = useUiStore((state) => state.onboarded)
  return onboarded ? <Navigate to="/" replace /> : <WelcomePage />
}

export function App() {
  return (
    <Routes>
      {/* Outside the AppShell: a fresh install has nothing to navigate yet. */}
      <Route path="welcome" element={<WelcomeRoute />} />
      <Route element={<AppShell />}>
        <Route index element={<IndexRoute />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/new" element={<NewProjectPage />} />
        <Route path="workspace" element={<WorkspacePage />} />
        <Route path="workspace/:projectId" element={<WorkspacePage />} />
        <Route path="translate/:projectId" element={<TranslatePage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="knowledge" element={<KnowledgePage />} />
        <Route path="logs" element={<LogsPage />} />
        <Route path="dev/myanmar-test" element={<MyanmarTestPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

export default App
