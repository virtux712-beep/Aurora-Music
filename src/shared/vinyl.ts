/**
 * What the record in the 拟真唱片 view is pressed from.
 *
 * Kept out of the stores for the same reason `lyricInk` is: it is *data*, and the whitelist that decides
 * whether a stored value may be painted has to be testable without a window. The store publishes the
 * choice as `data-vinyl` on the record; `app.css` owns what each pressing looks like, so the picker and the
 * record cannot drift apart.
 *
 * The three are the three things a record is actually made of, and they are not palette swaps:
 *
 *  - `black`  — the standard pressing. Near-black, silver grooves, a white specular sweep.
 *  - `colour` — the same lacquer with pigment in it. The disc takes the *cover's* colour, so the record
 *               changes with the song; the grooves keep their relief but pick up the tint.
 *  - `clear`  — uncoloured vinyl, which is translucent: the room reads through the disc, the rim carries
 *               most of the light and the grooves are the most visible of the three.
 */
export type VinylMaterial = 'black' | 'colour' | 'clear'

export const VINYL_MATERIALS: VinylMaterial[] = ['black', 'colour', 'clear']

/** One row per material for the picker. The hint is what tells the user what they are choosing. */
export const VINYL_MATERIAL_OPTIONS: { id: VinylMaterial; label: string; hint: string }[] = [
  { id: 'black', label: '黑胶', hint: '标准压制：近黑盘面、银色沟槽' },
  { id: 'colour', label: '彩胶', hint: '盘面随当前封面染色' },
  { id: 'clear', label: '透明胶', hint: '半透明，房间的光透盘而过' },
]

export function isVinylMaterial(value: unknown): value is VinylMaterial {
  return VINYL_MATERIALS.includes(value as VinylMaterial)
}
