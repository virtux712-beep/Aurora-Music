/**
 * A minimal ID3v2.3 writer.
 *
 * Aurora does not pull in a tagging library: the download manager needs exactly one operation —
 * "put this title/artist/album/cover at the front of an MP3" — and doing it here keeps the tag
 * format, the size arithmetic and the failure modes visible instead of hidden behind an API.
 *
 * Scope is deliberately small and honest:
 *  - ID3v2.3 with UTF-16 text frames (v2.3 has no UTF-8 encoding, and non-ASCII titles are normal);
 *  - the four frames a music library actually reads: `TIT2`, `TPE1`, `TALB`, `APIC`;
 *  - an existing ID3v2 tag at the front is replaced, never duplicated;
 *  - anything that is not an MP3 is left untouched by the caller, because prepending an ID3 header
 *    to a FLAC or an MP4 would corrupt it.
 */

const HEADER_SIZE = 10
const FRAME_HEADER_SIZE = 10

export interface CoverArt {
  /** e.g. `image/jpeg`. */
  mime: string
  data: Buffer
}

export interface AudioTags {
  title?: string
  artist?: string
  album?: string
  cover?: CoverArt
}

/** ID3 sizes are 28-bit "sync-safe" integers (7 bits per byte). */
function syncSafe(size: number): Buffer {
  return Buffer.from([
    (size >>> 21) & 0x7f,
    (size >>> 14) & 0x7f,
    (size >>> 7) & 0x7f,
    size & 0x7f,
  ])
}

function frame(id: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(FRAME_HEADER_SIZE)
  header.write(id, 0, 'ascii')
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}

/** Text frames: encoding byte + BOM + UTF-16LE body + terminator. */
function textFrame(id: string, value: string): Buffer {
  const text = Buffer.from(value, 'utf16le')
  return frame(id, Buffer.concat([Buffer.from([0x01, 0xff, 0xfe]), text, Buffer.from([0x00, 0x00])]))
}

function pictureFrame(cover: CoverArt): Buffer {
  return frame(
    'APIC',
    Buffer.concat([
      Buffer.from([0x00]), // ISO-8859-1 description encoding
      Buffer.from(cover.mime || 'image/jpeg', 'ascii'),
      Buffer.from([0x00]), // MIME terminator
      Buffer.from([0x03]), // picture type 3 = front cover
      Buffer.from([0x00]), // empty description
      cover.data,
    ]),
  )
}

/** Drops a leading ID3v2 tag (header, body and optional footer). */
export function stripId3v2(buffer: Buffer): Buffer {
  if (buffer.length < HEADER_SIZE) return buffer
  if (buffer.toString('latin1', 0, 3) !== 'ID3') return buffer
  const size =
    ((buffer[6] ?? 0) & 0x7f) * 0x200000 +
    ((buffer[7] ?? 0) & 0x7f) * 0x4000 +
    ((buffer[8] ?? 0) & 0x7f) * 0x80 +
    ((buffer[9] ?? 0) & 0x7f)
  const footerSize = ((buffer[5] ?? 0) & 0x10) !== 0 ? HEADER_SIZE : 0
  const end = HEADER_SIZE + size + footerSize
  return end <= buffer.length ? buffer.subarray(end) : buffer
}

/**
 * Returns the MP3 with the given tags written at the front. A tag-only buffer is returned unchanged
 * when there is nothing to write, so callers can apply this unconditionally.
 */
export function writeId3v23(buffer: Buffer, tags: AudioTags): Buffer {
  const frames: Buffer[] = []
  if (tags.title?.trim()) frames.push(textFrame('TIT2', tags.title.trim()))
  if (tags.artist?.trim()) frames.push(textFrame('TPE1', tags.artist.trim()))
  if (tags.album?.trim()) frames.push(textFrame('TALB', tags.album.trim()))
  if (tags.cover && tags.cover.data.length > 0) frames.push(pictureFrame(tags.cover))
  if (frames.length === 0) return buffer

  const body = Buffer.concat(frames)
  const header = Buffer.alloc(HEADER_SIZE)
  header.write('ID3', 0, 'ascii')
  header[3] = 3 // version 2.3
  header[4] = 0 // revision
  header[5] = 0 // no flags
  syncSafe(body.length).copy(header, 6)

  return Buffer.concat([header, body, stripId3v2(buffer)])
}

/** Reads one text frame back out (used by the tag writer's own verification). */
export function readTextFrame(buffer: Buffer, id: string): string | null {
  if (buffer.length < HEADER_SIZE || buffer.toString('latin1', 0, 3) !== 'ID3') return null
  const size =
    ((buffer[6] ?? 0) & 0x7f) * 0x200000 +
    ((buffer[7] ?? 0) & 0x7f) * 0x4000 +
    ((buffer[8] ?? 0) & 0x7f) * 0x80 +
    ((buffer[9] ?? 0) & 0x7f)
  let cursor = HEADER_SIZE
  const end = Math.min(HEADER_SIZE + size, buffer.length)
  while (cursor + FRAME_HEADER_SIZE <= end) {
    const frameId = buffer.toString('latin1', cursor, cursor + 4)
    const frameSize = buffer.readUInt32BE(cursor + 4)
    if (!/^[A-Z0-9]{4}$/.test(frameId) || frameSize <= 0) break
    const start = cursor + FRAME_HEADER_SIZE
    if (frameId === id) {
      const payload = buffer.subarray(start, start + frameSize)
      if (payload[0] === 0x01) return payload.subarray(3, payload.length).toString('utf16le').replace(/\u0000+$/, '')
      return payload.subarray(1, payload.length).toString('latin1').replace(/\u0000+$/, '')
    }
    cursor = start + frameSize
  }
  return null
}
