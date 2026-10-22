export const MEDIA_SCHEME = 'aurora-media'

export const AUDIO_EXTENSIONS = ['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.opus'] as const

export const AUDIO_EXTENSION_SET: ReadonlySet<string> = new Set(AUDIO_EXTENSIONS)

export const MAX_IMPORT_FILES = 20000

export const MAX_SCAN_DEPTH = 12
