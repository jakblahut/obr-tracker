import OBR, { Effect, Item, Uniform, buildEffect, isEffect } from "@owlbear-rodeo/sdk";
import { barRect, ringBox } from "./geometry";
import { ID, TokenData, barFill, hpColor, readCombat, tokenData } from "./shared";
import { BAR_SKSL, RING_SKSL } from "./shaders";
import { overlaysFor, ringColor, scaleKey } from "./sync";

/**
 * Animated overlays drawn on top of the static scene shapes. Owlbear only
 * allows effects as local items, so every client that runs the extension
 * draws its own. Players skip enemies and hidden tokens.
 */

const LOCAL_KEY = `${ID}/local`;

type Kind = "bar" | "ring";

interface LocalMeta {
  owner: string;
  kind: Kind;
  scale: string;
}

interface Wanted {
  token: Item;
  kind: Kind;
  data: TokenData;
}

// Above the static shapes, which use Date.now() as their z-index.
const Z_ABOVE_SHAPES = 1e15;

let running = false;
let queued = false;

export function requestLocalSync() {
  if (running) {
    queued = true;
    return;
  }
  running = true;
  doSync()
    .catch((e) => console.error("[tracker] local sync failed", e))
    .finally(() => {
      running = false;
      if (queued) {
        queued = false;
        requestLocalSync();
      }
    });
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

function ringUniforms(data: TokenData): Uniform[] {
  return [{ name: "color", value: rgb(ringColor(data)) }];
}

async function doSync() {
  if (!(await OBR.scene.isReady())) return;
  const [items, localItems, sceneMetadata, dpi, role] = await Promise.all([
    OBR.scene.items.getItems(),
    OBR.scene.local.getItems(),
    OBR.scene.getMetadata(),
    OBR.scene.grid.getDpi(),
    OBR.player.getRole(),
  ]);
  const combat = readCombat(sceneMetadata);
  const isGM = role === "GM";

  const wanted = new Map<string, Wanted>();
  const tokensById = new Map<string, Item>();
  for (const token of items) {
    const data = tokenData(token);
    if (!data) continue;
    tokensById.set(token.id, token);
    if (!isGM && !token.visible) continue;
    const show = overlaysFor(data, token.id, combat);
    if (show.bar && (isGM || data.party)) wanted.set(key(token.id, "bar"), { token, kind: "bar", data });
    if (show.ring) wanted.set(key(token.id, "ring"), { token, kind: "ring", data });
  }

  const toDelete: string[] = [];
  const existing = new Map<string, Effect>();
  for (const item of localItems) {
    const meta = item.metadata[LOCAL_KEY] as LocalMeta | undefined;
    if (!meta) continue;
    const k = key(meta.owner, meta.kind);
    const owner = tokensById.get(meta.owner);
    if (!isEffect(item) || !wanted.has(k) || existing.has(k) || !owner || meta.scale !== scaleKey(owner)) {
      toDelete.push(item.id);
      continue;
    }
    existing.set(k, item);
  }

  const toAdd: Item[] = [];
  const toUpdate = new Map<string, Uniform[]>();
  for (const [k, w] of wanted) {
    const item = existing.get(k);
    if (!item) {
      toAdd.push(await build(w, dpi));
    } else {
      const uniforms = w.kind === "bar" ? barUniforms(w.data) : ringUniforms(w.data);
      if (JSON.stringify(item.uniforms) !== JSON.stringify(uniforms)) toUpdate.set(item.id, uniforms);
    }
  }

  if (toAdd.length) await OBR.scene.local.addItems(toAdd);
  if (toUpdate.size) {
    await OBR.scene.local.updateItems<Effect>([...toUpdate.keys()], (drafts) => {
      for (const d of drafts) d.uniforms = toUpdate.get(d.id)!;
    });
  }
  if (toDelete.length) await OBR.scene.local.deleteItems(toDelete);
}

async function build(w: Wanted, dpi: number): Promise<Item> {
  const bounds = await OBR.scene.items.getItemBounds([w.token.id]);
  const meta: LocalMeta = { owner: w.token.id, kind: w.kind, scale: scaleKey(w.token) };
  const effect = buildEffect()
    .effectType("STANDALONE")
    .attachedTo(w.token.id)
    .layer("ATTACHMENT")
    .locked(true)
    .disableHit(true)
    .disableAutoZIndex(true)
    // The animated ring sits under the animated bar.
    .zIndex(w.kind === "ring" ? Z_ABOVE_SHAPES : Z_ABOVE_SHAPES + 1)
    .disableAttachmentBehavior(["ROTATION", "COPY"])
    .metadata({ [LOCAL_KEY]: meta });

  if (w.kind === "ring") {
    const box = ringBox(bounds);
    // Standalone effects are positioned by their top-left corner.
    return effect
      .width(box.size)
      .height(box.size)
      .position({ x: box.x, y: box.y })
      .sksl(RING_SKSL)
      .uniforms(ringUniforms(w.data))
      .build();
  }

  const r = barRect(bounds, dpi);
  return effect
    .width(r.width)
    .height(r.height)
    .position({ x: r.x, y: r.y })
    .sksl(BAR_SKSL)
    .uniforms(barUniforms(w.data))
    .build();
}
