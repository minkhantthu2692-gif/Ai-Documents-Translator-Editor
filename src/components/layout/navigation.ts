import type { ComponentType } from 'react'
import {
  IconDashboard,
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
  { id: 'logs', to: '/logs', labelKey: 'nav.logs', icon: IconLogs },
  { id: 'settings', to: '/settings', labelKey: 'nav.settings', icon: IconSettings },
  { id: 'myanmar-test', to: '/dev/myanmar-test', labelKey: 'nav.myanmarTest', icon: IconSparkle },
]

/** Mobile bottom tab bar keeps the five most-used destinations. */
export const BOTTOM_NAV_ITEMS: NavItem[] = [
  NAV_ITEMS[0],
  NAV_ITEMS[1],
  NAV_ITEMS[2],
  NAV_ITEMS[4],
  NAV_ITEMS[5],
]
