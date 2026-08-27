import { useEffect, useRef } from 'react'

const EDITABLE_TAG_NAMES = ['INPUT', 'TEXTAREA', 'SELECT']

const isEditableElement = (element) => Boolean(
  element && (element.isContentEditable || EDITABLE_TAG_NAMES.includes(element.tagName))
)

// Screenshots land on the clipboard as a generic "image.png" blob, so those get a
// timestamped name while real copied files keep the one they already have.
const namePastedImageFile = (file, index) => {
  const hasUsefulName = file.name && !/^image\.[a-z0-9]+$/i.test(file.name)
  if (hasUsefulName) return file

  const extension = (file.type.split('/')[1] || 'png').split('+')[0].replace('jpeg', 'jpg')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  const suffix = index > 0 ? `-${index + 1}` : ''

  return new File([file], `pasted-image-${stamp}${suffix}.${extension}`, { type: file.type })
}

const readClipboardImageFiles = (clipboardData) => {
  if (!clipboardData) return []

  const fromFiles = Array.from(clipboardData.files || []).filter(file => file.type.startsWith('image/'))
  const fromItems = Array.from(clipboardData.items || [])
    .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
    .map(item => item.getAsFile())

  return (fromFiles.length > 0 ? fromFiles : fromItems)
    .filter(Boolean)
    .map(namePastedImageFile)
}

// Ctrl-V / Cmd-V import of clipboard images. `onImageFiles` receives the pasted
// image files (already named) and is only called when the clipboard actually
// carries one, so a plain text paste keeps its normal behaviour.
export default function usePasteImageFiles(onImageFiles, { enabled = true } = {}) {
  const handlerRef = useRef(onImageFiles)

  useEffect(() => {
    handlerRef.current = onImageFiles
  }, [onImageFiles])

  useEffect(() => {
    if (!enabled) return undefined

    const handlePaste = (event) => {
      const clipboardData = event.clipboardData
      if (!clipboardData) return

      // A text field pasting text is doing its own job; an image-only paste is
      // still imported even when a field happens to hold the focus.
      const carriesText = Array.from(clipboardData.types || []).some(type => type.startsWith('text/'))
      if (carriesText && (isEditableElement(event.target) || isEditableElement(document.activeElement))) return

      const files = readClipboardImageFiles(clipboardData)
      if (files.length === 0) return

      event.preventDefault()
      handlerRef.current?.(files)
    }

    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [enabled])
}
