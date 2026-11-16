import { useCallback, useRef, useState } from 'react'
import { api, ApiError } from './api'
import type { Attachment } from './types'

export const MAX_ATTACHMENTS = 50
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024

/** A file picked in the composer, before / while it is uploaded. */
export type DraftAttachment = {
  key: string
  name: string
  size: number
  isImage: boolean
  status: 'uploading' | 'ready' | 'error'
  error?: string | null
  /** Local object URL, so images can be previewed before the upload finishes. */
  previewUrl?: string | null
  attachment?: Attachment
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = size
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const text = unit === 0 || value >= 10 ? String(Math.round(value)) : value.toFixed(1)
  return `${text} ${units[unit]}`
}

/** Where the renderer can load an attachment from (null when it is text-only). */
export function attachmentUrl(attachment: Attachment): string | null {
  if (attachment.localFile) return `/api/attachments/${encodeURIComponent(attachment.localFile)}`
  if (attachment.isImage && attachment.remotePath) {
    return `/api/attachments/remote?path=${encodeURIComponent(attachment.remotePath)}`
  }
  return null
}

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`

export function useDraftAttachments(onError: (message: string) => void) {
  const [items, setItems] = useState<DraftAttachment[]>([])
  const itemsRef = useRef<DraftAttachment[]>([])
  const filesRef = useRef(new Map<string, File>())

  const commit = useCallback((next: DraftAttachment[]) => {
    itemsRef.current = next
    setItems(next)
  }, [])

  const patch = useCallback(
    (key: string, changes: Partial<DraftAttachment>) => {
      commit(itemsRef.current.map((item) => (item.key === key ? { ...item, ...changes } : item)))
    },
    [commit],
  )

  const startUpload = useCallback(
    async (key: string, file: File) => {
      try {
        const attachment = await api.uploadAttachment(file)
        patch(key, {
          status: 'ready',
          attachment,
          name: attachment.name || file.name,
          size: attachment.size || file.size,
          isImage: Boolean(attachment.isImage),
          error: null,
        })
      } catch (err) {
        const message =
          err instanceof ApiError ? err.message : '上传失败，请稍后再试。'
        patch(key, { status: 'error', error: message })
        onError(message)
      }
    },
    [onError, patch],
  )

  const addFiles = useCallback(
    (input: FileList | File[] | null) => {
      const files = Array.from(input || [])
      if (!files.length) return

      const current = itemsRef.current
      const room = MAX_ATTACHMENTS - current.length
      if (room <= 0) {
        onError(`一次最多带 ${MAX_ATTACHMENTS} 个文件`)
        return
      }

      const accepted: DraftAttachment[] = []
      for (const file of files.slice(0, room)) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          onError(`${file.name || '这个文件'} 超过 100 MB`)
          continue
        }
        const key = uid()
        const isImage = file.type.startsWith('image/')
        const previewUrl = isImage ? URL.createObjectURL(file) : null
        filesRef.current.set(key, file)
        accepted.push({
          key,
          name: file.name || 'file',
          size: file.size,
          isImage,
          status: 'uploading',
          previewUrl,
        })
      }

      if (!accepted.length) return
      commit([...current, ...accepted])
      for (const draft of accepted) {
        const file = filesRef.current.get(draft.key)
        if (file) void startUpload(draft.key, file)
      }
    },
    [commit, onError, startUpload],
  )

  const remove = useCallback(
    (key: string) => {
      const target = itemsRef.current.find((item) => item.key === key)
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
      filesRef.current.delete(key)
      commit(itemsRef.current.filter((item) => item.key !== key))
    },
    [commit],
  )

  const reset = useCallback(() => {
    for (const item of itemsRef.current) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
    }
    filesRef.current.clear()
    commit([])
  }, [commit])

  const ready = items.filter((item) => item.status === 'ready' && item.attachment)
  const uploading = items.some((item) => item.status === 'uploading')

  return { items, ready, uploading, addFiles, remove, reset }
}
