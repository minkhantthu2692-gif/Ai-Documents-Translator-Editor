/**
 * Inspector column (Phase 4).
 *
 * Keeps its own live query of the project's blocks so the inspector stays in
 * step with the editor even when the two are mounted from different columns
 * of the page layout.
 */

import { useLiveQuery } from 'dexie-react-hooks'
import { loadEditorBlocks } from '@/editor/blocks'
import type { IndexedBlock } from '@/editor/commands'
import { useEditorStore } from '@/editor/store'
import { BlockInspector } from './BlockInspector'

export interface WorkspaceInspectorProps {
  projectId: string
}

export function WorkspaceInspector({ projectId }: WorkspaceInspectorProps) {
  const blocks = useLiveQuery(() => loadEditorBlocks(projectId), [projectId], [] as IndexedBlock[])
  const activeBlockId = useEditorStore((state) => state.activeBlockId)
  const block = blocks.find((entry) => entry.id === activeBlockId) ?? null

  return <BlockInspector projectId={projectId} block={block} blocks={blocks} />
}
