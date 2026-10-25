import OBR, { Effect, Item, Uniform, buildEffect, isEffect } from "@owlbear-rodeo/sdk";
import { BAR_KEY, CombatData, TokenData, barFill, hpColor, readCombat, tokenData } from "./shared";
import { BAR_SKSL, RING_SKSL } from "./shaders";

/**
 * Draws HP bars and the turn ring as real scene items attached to tokens, so
 * every client (including a cast device) sees them without running any code.
 * Only the GM client runs this. Enemy bars get visible=false, which players
 * can't see and the GM sees faded.
 */

type Kind = "bar" | "ring";

/** Bump when bar geometry or style changes so old items get rebuilt. */
const BAR_VERSION = 3;

interface BarMeta {
  v?: number;
  owner: string;
  kind: Kind;
  /** Token scale when the item was built; rebuilt if the token is resized. */
  scale: string;
}

interface Wanted {
  token: Item;
  kind: Kind;
  visible: boolean;
  data: TokenData;
}

const RING_COLOR = "#ffd23f";

let running = false;
let queued = false;

export function requestSync() {
  if (running) {
    queued = true;
    return;
  }
  running = true;
  doSync()
    .catch((e) => console.error("[tracker] sync failed", e))
    .finally(() => {
      running = false;
      if (queued) {
        queued = false;
        requestSync();
      }
    });
}

function scaleKey(item: Item) {
  return `${item.scale.x.toFixed(3)},${item.scale.y.toFixed(3)}`;
}

function key(owner: string, kind: Kind) {
  return `${owner}:${kind}`;
}

function rgb(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return { x: ((n >> 16) & 255) / 255, y: ((n >> 8) & 255) / 255, z: (n & 255) / 255 };
}

function barUniforms(data: TokenData): Uniform[] {
  const fill = barFill(data);
  return [
    { name: "hp", value: fill.hp },
    { name: "temp", value: fill.temp },
    { name: "color", value: rgb(hpColor(fill.ratio)) },
  ];
}

function sameUniforms(a: Uniform[], b: Uniform[]) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function wantedItems(tokens: Item[], combat: CombatData): Map<string, Wanted> {
  const wanted = new Map<string, Wanted>();
  for (const token of tokens) {
    const data = tokenData(token)!;
    const fighting = combat.phase !== "idle" && data.inCombat;
    const showBar = data.maxHp > 0 && (fighting || (combat.showPartyHp && data.party));
    if (showBar) {
      wanted.set(key(token.id, "bar"), { token, kind: "bar", visible: data.party, data });
    }
    if (combat.phase === "active" && combat.turnId === token.id) {
      wanted.set(key(token.id, "ring"), { token, kind: "ring", visible: true, data });
    }
  }
  return wanted;
}

async function doSync() {
  if (!(await OBR.scene.isReady())) return;
  const [items, sceneMetadata, dpi] = await Promise.all([
    OBR.scene.items.getItems(),
    OBR.scene.getMetadata(),
    OBR.scene.grid.getDpi(),
  ]);
  const combat = readCombat(sceneMetadata);
  const tokens = items.filter((i) => tokenData(i));
  const tokensById = new Map(tokens.map((t) => [t.id, t]));
  const wanted = wantedItems(tokens, combat);

  const toDelete: string[] = [];
  const existing = new Map<string, Effect>();
  for (const item of items) {
    const meta = item.metadata[BAR_KEY] as BarMeta | undefined;
    if (!meta) continue;
    const k = key(meta.owner, meta.kind);
    const owner = tokensById.get(meta.owner);
    const stale = !owner || meta.scale !== scaleKey(owner) || meta.v !== BAR_VERSION;
    if (!isEffect(item) || !wanted.has(k) || existing.has(k) || stale) {
      toDelete.push(item.id);
      continue;
    }
    existing.set(k, item);
  }

  const toUpdate = new Map<string, (e: Effect) => void>();
  const toAdd: Item[] = [];
  for (const [k, w] of wanted) {
    const item = existing.get(k);
    if (item) {
      const change = diff(item, w);
      if (change) toUpdate.set(item.id, change);
    } else {
      toAdd.push(await build(w, dpi));
    }
  }

  if (toDelete.length) await OBR.scene.items.deleteItems(toDelete);
  if (toAdd.length) await OBR.scene.items.addItems(toAdd);
  if (toUpdate.size) {
    await OBR.scene.items.updateItems<Effect>([...toUpdate.keys()], (drafts) => {
      for (const d of drafts) toUpdate.get(d.id)?.(d as Effect);
    });
  }
}

function diff(item: Effect, w: Wanted): ((e: Effect) => void) | null {
  const changes: ((e: Effect) => void)[] = [];
  if (item.visible !== w.visible) changes.push((e) => (e.visible = w.visible));
  if (w.kind === "bar") {
    const uniforms = barUniforms(w.data);
    if (!sameUniforms(item.uniforms, uniforms)) changes.push((e) => (e.uniforms = uniforms));
  }
  if (!changes.length) return null;
  return (e) => changes.forEach((c) => c(e));
}

function base(w: Wanted, meta: BarMeta) {
  return buildEffect()
    .effectType("STANDALONE")
    .attachedTo(w.token.id)
    .layer("ATTACHMENT")
    .locked(true)
    .disableHit(true)
    .disableAttachmentBehavior(["ROTATION", "COPY"])
    .visible(w.visible)
    .metadata({ [BAR_KEY]: { ...meta, v: BAR_VERSION } });
}

async function build(w: Wanted, dpi: number): Promise<Item> {
  const bounds = await OBR.scene.items.getItemBounds([w.token.id]);
  const meta: BarMeta = { owner: w.token.id, kind: w.kind, scale: scaleKey(w.token) };

  if (w.kind === "ring") {
    const size = bounds.width * 1.25;
    return base(w, meta)
      .width(size)
      .height(size)
      // Standalone effects are positioned by their top-left corner.
      .position({ x: bounds.center.x - size / 2, y: bounds.center.y - size / 2 })
      .sksl(RING_SKSL)
      .uniforms([{ name: "color", value: rgb(RING_COLOR) }])
      .build();
  }

  const width = bounds.width * 0.8;
  const height = Math.max(dpi * 0.12, 6);
  return base(w, meta)
    .width(width)
    .height(height)
    .position({ x: bounds.center.x - width / 2, y: bounds.max.y - height - dpi * 0.05 })
    .sksl(BAR_SKSL)
    .uniforms(barUniforms(w.data))
    .build();
}
