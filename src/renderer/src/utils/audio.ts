import type { AudioTrack, PlaybackQuality } from '../../../shared/types'
import { qualityBadge, qualityTier, tierOfFacts, type QualityBadgeView, type QualityTierId } from '../../../shared/quality'

/**
 * Audio-format helpers.
 *
 * Everything here reads fields that were actually measured (a file's own tags, or a platform's per-song
 * quality list) — nothing is inferred from a source's advertised capability. That is the point: a badge must
 * never claim more than the data says.
 *
 * The four tiers themselves live in `shared/quality.ts`, because the *main* process needs the same model to
 * turn a preference into a token it sends to a source. One vocabulary, two consumers.
 */

export function tierOf(track: AudioTrack): QualityTierId | null {
  return qualityBadge(track)?.tier ?? null
}

export function isLossless(track: AudioTrack): boolean {
  const tier = tierOf(track)
  return tier === 'ultra' || tier === 'lossless'
}

export function isHiRes(track: AudioTrack): boolean {
  return tierOfFacts(track) === 'ultra'
}

/** Human description of a local file's technical facts, e.g. `FLAC · 24bit / 96.0kHz`. */
export function describeAudio(track: AudioTrack): string {
  const parts: string[] = [track.format.toUpperCase()]
  const bits = track.bitsPerSample
  const rate = track.sampleRate
  if (bits && rate) parts.push(`${bits}bit / ${(rate / 1000).toFixed(1)}kHz`)
  else if (rate) parts.push(`${(rate / 1000).toFixed(1)}kHz`)
  if (track.bitrate) parts.push(`${Math.round(track.bitrate / 1000)}kbps`)
  return parts.join(' · ')
}

/**
 * One badge per track, from whichever vocabulary the track carries — a source's per-song availability list,
 * or the file's own tags. A track that advertises neither gets `null`: an invented "320K" would be a lie.
 */
export function bestQualityBadge(track: Pick<AudioTrack, 'qualities' | 'format' | 'bitsPerSample' | 'sampleRate' | 'bitrate'>): QualityBadgeView | null {
  return qualityBadge(track)
}

/** The tier a badge belongs to, for anything that needs to compare rather than render. */
export function badgeTier(badge: QualityBadgeView | null): QualityBadgeView['tier'] | null {
  return badge ? qualityTier(badge.tier).id : null
}

