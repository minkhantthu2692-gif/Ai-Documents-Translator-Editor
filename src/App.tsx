import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from '@/components/layout/AppShell'
import { DashboardPage } from '@/pages/DashboardPage'
import { ProjectsPage } from '@/pages/ProjectsPage'
import { NewProjectPage } from '@/pages/NewProjectPage'
import { WorkspacePage } from '@/pages/WorkspacePage'
import { TranslatePage } from '@/pages/TranslatePage'
import { SettingsPage } from '@/pages/SettingsPage'
import { LogsPage } from '@/pages/LogsPage'
import { MyanmarTestPage } from '@/pages/MyanmarTestPage'

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/new" element={<NewProjectPage />} />
        <Route path="workspace" element={<WorkspacePage />} />
        <Route path="workspace/:projectId" element={<WorkspacePage />} />
        <Route path="translate/:projectId" element={<TranslatePage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="logs" element={<LogsPage />} />
        <Route path="dev/myanmar-test" element={<MyanmarTestPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

export default App
