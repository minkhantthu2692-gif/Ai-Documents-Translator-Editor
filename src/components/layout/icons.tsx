import type { ReactNode, SVGProps } from 'react'
import { cn } from '@/lib/cn'

export type IconBaseProps = Omit<SVGProps<SVGSVGElement>, 'children'>

export interface IconProps extends IconBaseProps {
  children: ReactNode
}

/** Base line icon: 24px grid, 1.75 stroke, inherits currentColor. */
export function Icon({ children, className, strokeWidth = 1.75, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={cn('h-4 w-4 shrink-0', className)}
      {...rest}
    >
      {children}
    </svg>
  )
}

export const IconDashboard = (props: IconBaseProps) => (
  <Icon {...props}>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </Icon>
)

export const IconProjects = (props: IconBaseProps) => (
  <Icon {...props}>
    <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2l2 2h7.8A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z" />
  </Icon>
)

export const IconPlus = (props: IconBaseProps) => (
  <Icon {...props}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
)

export const IconWorkspace = (props: IconBaseProps) => (
  <Icon {...props}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
    <path d="M9 13h6M9 17h4" />
  </Icon>
)

export const IconSettings = (props: IconBaseProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 2.5v2.8M12 18.7v2.8M4.6 4.6l2 2M17.4 17.4l2 2M2.5 12h2.8M18.7 12h2.8M4.6 19.4l2-2M17.4 6.6l2-2" />
  </Icon>
)

export const IconLogs = (props: IconBaseProps) => (
  <Icon {...props}>
    <path d="M8.5 6H21M8.5 12H21M8.5 18H21M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
  </Icon>
)

export const IconSun = (props: IconBaseProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2.5 12h2M19.5 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Icon>
)

export const IconMoon = (props: IconBaseProps) => (
  <Icon {...props}>
    <path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8z" />
  </Icon>
)

export const IconSystem = (props: IconBaseProps) => (
  <Icon {...props}>
    <rect x="3" y="4.5" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16.5V20" />
  </Icon>
)

export const IconGlobe = (props: IconBaseProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.6 3.2 2.6 14.8 0 18M12 3c-2.6 3.2-2.6 14.8 0 18" />
  </Icon>
)

export const IconMenu = (props: IconBaseProps) => (
  <Icon {...props}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
)

export const IconChevronLeft = (props: IconBaseProps) => (
  <Icon {...props}>
    <path d="M15 6l-6 6 6 6" />
  </Icon>
)

export const IconChevronRight = (props: IconBaseProps) => (
  <Icon {...props}>
    <path d="M9 6l6 6-6 6" />
  </Icon>
)

export const IconChevronDown = (props: IconBaseProps) => (
  <Icon {...props}>
    <path d="M6 9.5l6 6 6-6" />
  </Icon>
)

export const IconSearch = (props: IconBaseProps) => (
  <Icon {...props}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20.5 20.5L16.6 16.6" />
  </Icon>
)

export const IconTrash = (props: IconBaseProps) => (
  <Icon {...props}>
    <path d="M4 7h16M10 11v6M14 11v6" />
    <path d="M6 7l.9 12.1A2 2 0 0 0 8.9 21h6.2a2 2 0 0 0 2-1.9L18 7" />
    <path d="M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7" />
  </Icon>
)

export const IconDuplicate = (props: IconBaseProps) => (
  <Icon {...props}>
    <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2" />
    <path d="M15.5 8.5v-2A2 2 0 0 0 13.5 4.5h-7A2 2 0 0 0 4.5 6.5v7a2 2 0 0 0 2 2h2" />
  </Icon>
)

export const IconArchive = (props: IconBaseProps) => (
  <Icon {...props}>
    <rect x="3" y="4" width="18" height="4.5" rx="1.2" />
    <path d="M5 8.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5M10 12.5h4" />
  </Icon>
)

export const IconEdit = (props: IconBaseProps) => (
  <Icon {...props}>
    <path d="M4 20h4L18.5 9.5l-4-4L4 16z" />
    <path d="M14.5 5.5l4 4" />
  </Icon>
)

export const IconDownload = (props: IconBaseProps) => (
  <Icon {...props}>
    <path d="M12 4v11M7.5 11L12 15.5 16.5 11M5 20h14" />
  </Icon>
)

export const IconUpload = (props: IconBaseProps) => (
  <Icon {...props}>
    <path d="M12 20V8.5M7.5 13L12 8.5 16.5 13M5 4h14" />
  </Icon>
)

export const IconList = (props: IconBaseProps) => (
  <Icon {...props}>
    <path d="M8.5 6H21M8.5 12H21M8.5 18H21M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
  </Icon>
)

export const IconGrid = (props: IconBaseProps) => (
  <Icon {...props}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
  </Icon>
)

export const IconAlert = (props: IconBaseProps) => (
  <Icon {...props}>
    <path d="M12 4.5L21 20H3z" />
    <path d="M12 10v4.5M12 17.4h.01" />
  </Icon>
)

export const IconCheck = (props: IconBaseProps) => (
  <Icon {...props}>
    <path d="M4.5 12.5l5 5L19.5 7" />
  </Icon>
)

export const IconInfo = (props: IconBaseProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5M12 7.8h.01" />
  </Icon>
)

export const IconClose = (props: IconBaseProps) => (
  <Icon {...props}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
)

export const IconKey = (props: IconBaseProps) => (
  <Icon {...props}>
    <circle cx="8" cy="14.5" r="4" />
    <path d="M11 11.5L20 2.5M17 5.5l2 2M14.5 8l2 2" />
  </Icon>
)

export const IconDatabase = (props: IconBaseProps) => (
  <Icon {...props}>
    <ellipse cx="12" cy="6" rx="8" ry="3" />
    <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
    <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
  </Icon>
)

export const IconRefresh = (props: IconBaseProps) => (
  <Icon {...props}>
    <path d="M20 12a8 8 0 1 1-2.4-5.7" />
    <path d="M20.5 3.5v5h-5" />
  </Icon>
)

export const IconExternal = (props: IconBaseProps) => (
  <Icon {...props}>
    <path d="M14 4h6v6M20 4l-8.5 8.5" />
    <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
  </Icon>
)

export const IconSparkle = (props: IconBaseProps) => (
  <Icon {...props}>
    <path d="M11 3.5l1.7 4.3 4.3 1.7-4.3 1.7L11 15.5 9.3 11.2 5 9.5l4.3-1.7z" />
    <path d="M17.5 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
  </Icon>
)

export const IconMore = (props: IconBaseProps) => (
  <Icon {...props} strokeWidth={2.2}>
    <path d="M6 12h.01M12 12h.01M18 12h.01" />
  </Icon>
)

export const IconFile = (props: IconBaseProps) => (
  <Icon {...props}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </Icon>
)

export const IconLanguage = (props: IconBaseProps) => (
  <Icon {...props}>
    <path d="M3 6h9M7.5 4v2M10 6c0 4-3 7-7 8" />
    <path d="M5 10.5c1.6 2.5 4 4.3 7 5" />
    <path d="M12.5 20.5L17 10.5l4.5 10M14 17.5h6" />
  </Icon>
)
