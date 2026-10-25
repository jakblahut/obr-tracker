import { Item, Metadata } from "@owlbear-rodeo/sdk";

export const ID = "sk.blahut.tracker";
/** Metadata on a token that is in our tracker. */
export const TOKEN_KEY = `${ID}/token`;
/** Metadata on the bar/ring items we draw. */
export const BAR_KEY = `${ID}/bar`;
/** Combat state stored on the scene. */
export const SCENE_KEY = `${ID}/combat`;

export interface TokenData {
  party: boolean;
  inCombat: boolean;
  hp: number;
  maxHp: number;
  init: number | null;
  ac?: number | null;
  tempHp?: number;
}

/**
 * idle: no combat. setup: combatants chosen, initiative being entered.
 * active: turns are running.
 */
export type Phase = "idle" | "setup" | "active";

export interface CombatData {
  phase: Phase;
  round: number;
  turnId: string | null;
  /** Show party HP bars outside of combat too. */
  showPartyHp: boolean;
  /** Show enemy HP bars outside of combat (only the GM ever sees them). */
  showEnemyHp: boolean;
}

export const DEFAULT_COMBAT: CombatData = {
  phase: "idle",
  round: 0,
  turnId: null,
  showPartyHp: false,
  showEnemyHp: false,
};

export function readCombat(metadata: Metadata): CombatData {
  const stored = metadata[SCENE_KEY] as (Partial<CombatData> & { active?: boolean }) | undefined;
  const combat = { ...DEFAULT_COMBAT, ...stored };
  // v0.1 stored a boolean instead of a phase.
  if (!stored?.phase && stored?.active) combat.phase = "active";
  return combat;
}

export function tokenData(item: Item): TokenData | undefined {
  return item.metadata[TOKEN_KEY] as TokenData | undefined;
}

export function tokenName(item: Item): string {
  const text = (item as { text?: { plainText?: string } }).text?.plainText;
  return text || item.name || "?";
}

/** Tokens taking part in combat, highest initiative first. */
export function combatOrder(items: Item[]): Item[] {
  return items
    .filter((i) => tokenData(i)?.inCombat)
    .sort((a, b) => {
      const ia = tokenData(a)!.init ?? -Infinity;
      const ib = tokenData(b)!.init ?? -Infinity;
      if (ia !== ib) return ib - ia;
      return tokenName(a).localeCompare(tokenName(b));
    });
}

/** Green above half, yellow above a quarter, red below. */
export function hpColor(ratio: number): string {
  if (ratio > 0.5) return "#3ccf4e";
  if (ratio > 0.25) return "#f2c230";
  return "#e5383b";
}

export function hpRatio(data: TokenData): number {
  if (data.maxHp <= 0) return 0;
  return Math.min(1, Math.max(0, data.hp / data.maxHp));
}

/**
 * Where the HP fill and the temp HP segment end on the bar (0..1). Temp HP
 * extends the bar's scale so it stays visible at full HP.
 */
export function barFill(data: TokenData) {
  const temp = Math.max(0, data.tempHp ?? 0);
  const total = Math.max(data.maxHp, data.hp + temp, 1);
  return { hp: data.hp / total, temp: (data.hp + temp) / total, ratio: hpRatio(data) };
}

/** Damage eats temp HP first; healing never touches it. */
export function applyHpChange(data: TokenData, delta: number): Pick<TokenData, "hp" | "tempHp"> {
  let temp = data.tempHp ?? 0;
  let hp = data.hp;
  if (delta < 0) {
    const absorbed = Math.min(temp, -delta);
    temp -= absorbed;
    hp += delta + absorbed;
  } else {
    hp += delta;
  }
  return { hp: clampHp(hp, data.maxHp), tempHp: temp };
}

export function clampHp(hp: number, maxHp: number) {
  return Math.max(0, maxHp > 0 ? Math.min(hp, maxHp) : hp);
}
