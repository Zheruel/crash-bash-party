/** Public metadata types (no game data). */

export interface LevelInfo {
  id: number;
  name: string;
  familyCode: number;
  family: string;
  arenaVariant: number;
  altVariant: number;
  /** CRASHBSH.DAT file index of the objective text, or null */
  textFile: number | null;
  /** t10/t14 music bank file index */
  musicFile: number | null;
  /** t0c sfx bank file indices */
  sfxFiles: number[];
  /** character animation table file index */
  animTableFile: number | null;
  /** candidate file groups holding the arena's t08/t29 pairs (see FILE_GROUPS) */
  modelTextureGroups: number[];
  modelTextureConfidence: string;
}

export interface FileGroup {
  group: number;
  firstFile: number;
  count: number;
  types: Record<string, number>;
}

export type AssetKind = 'textures' | 'model' | 'sound';

export interface DecodeStats {
  textures: number;
  models: number;
  soundBanks: number;
  /** files that are not decodable assets (text tables, code, TGA, animation tables) */
  skipped: number;
  /** items served from the cache instead of decoded */
  cached: number;
  ms: number;
}
