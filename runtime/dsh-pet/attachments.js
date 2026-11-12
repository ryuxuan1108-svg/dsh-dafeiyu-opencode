import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { imageSize } from 'image-size'

export function createAttachments(root) {
  const directory = join(root, 'attachments')
  const locate = (ref) => /^sha256:[a-f0-9]{64}$/.test(ref?.attachmentId || '')
    ? join(directory, ref.attachmentId.slice(7)) : undefined
  return {
    imageLimits: { maxImageBytes: 650000 },
    async saveImages(inputs) {
      return inputs.map(({ data, mediaType }) => {
        if (data.length > 650000) throw new Error('图片过大，请压缩到 650KB 以内。')
        const info = imageSize(data)
        const expected = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[info.type]
        if (expected !== mediaType || !info.width || !info.height || info.width * info.height > 20000000) {
          throw new Error('图片格式或尺寸不可用。')
        }
        const ref = { attachmentId: `sha256:${createHash('sha256').update(data).digest('hex')}`,
          mediaType, bytes: data.length, width: info.width, height: info.height }
        mkdirSync(directory, { recursive: true })
        const file = locate(ref)
        if (!existsSync(file)) writeFileSync(file, data, { flag: 'wx', mode: 0o600 })
        return ref
      })
    },
    imageHostPath: locate,
    materialize(ref) {
      const file = locate(ref)
      if (!file || !existsSync(file)) throw new Error('对话图片不存在，请重新上传。')
      return { type: 'image', mediaType: ref.mediaType, data: readFileSync(file).toString('base64') }
    },
  }
}
