import type { ComponentType } from 'react'
import {
  IconDashboard,
  IconList,
  IconLogs,
  IconPlus,
  IconProjects,
  IconSettings,
  IconSparkle,
  IconWorkspace,
  type IconBaseProps,
} from './icons'

export interface NavItem {
  id: string
  to: string
  labelKey: string
  icon: ComponentType<IconBaseProps>
  end?: boolean
}

export const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', to: '/', labelKey: 'nav.dashboard', icon: IconDashboard, end: true },
  { id: 'projects', to: '/projects', labelKey: 'nav.projects', icon: IconProjects },
  { id: 'new-project', to: '/projects/new', labelKey: 'nav.newProject', icon: IconPlus },
  { id: 'workspace', to: '/workspace', labelKey: 'nav.workspace', icon: IconWorkspace },
  { id: 'knowledge', to: '/knowledge', labelKey: 'nav.knowledge', icon: IconList },
  { id: 'logs', to: '/logs', labelKey: 'nav.logs', icon: IconLogs },
  { id: 'settings', to: '/settings', labelKey: 'nav.settings', icon: IconSettings },
  { id: 'myanmar-test', to: '/dev/myanmar-test', labelKey: 'nav.myanmarTest', icon: IconSparkle },
]

/** Looked up by id so inserting a nav entry never silently shifts the bar. */
const navById = (id: string): NavItem => NAV_ITEMS.find((item) => item.id === id) as NavItem

/** Mobile bottom tab bar keeps the five most-used destinations. */
export const BOTTOM_NAV_ITEMS: NavItem[] = [
  navById('dashboard'),
  navById('projects'),
  navById('new-project'),
  navById('logs'),
  navById('settings'),
]
