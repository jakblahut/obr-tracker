import OBR, { Item, Shape, buildShape, isShape } from "@owlbear-rodeo/sdk";
import { BAR_KEY, CombatData, TokenData, hpColor, hpRatio, readCombat, tokenData } from "./shared";

/**
 * Draws HP bars and the turn ring as real scene items attached to tokens, so
 * every client (including a cast device) sees them without running any code.
 * Only the GM client runs this. Enemy bars get visible=false, which players
 * can't see and the GM sees faded.
 */

type Kind = "bg" | "fill" | "ring";

/** Bump when bar geometry or style changes so old items get rebuilt. */
const BAR_VERSION = 2;

interface BarMeta {
  v?: number;
  owner: string;
  kind: Kind;
  /** Token scale when the item was built; rebuilt if the token is resized. */
  scale: string;
  /** Full inner width of the bar, used to size the fill. */
  fullWidth?: number;
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

function wantedItems(tokens: Item[], combat: CombatData): Map<string, Wanted> {
  const wanted = new Map<string, Wanted>();
  for (const token of tokens) {
    const data = tokenData(token)!;
    const fighting = combat.phase !== "idle" && data.inCombat;
    const showBar = data.maxHp > 0 && (fighting || (combat.showPartyHp && data.party));
    if (showBar) {
      wanted.set(key(token.id, "bg"), { token, kind: "bg", visible: data.party, data });
      wanted.set(key(token.id, "fill"), { token, kind: "fill", visible: data.party, data });
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
  const existing = new Map<string, Shape>();
  for (const item of items) {
    const meta = item.metadata[BAR_KEY] as BarMeta | undefined;
    if (!meta) continue;
    const k = key(meta.owner, meta.kind);
    const owner = tokensById.get(meta.owner);
    if (!isShape(item) || !wanted.has(k) || existing.has(k) || !owner || meta.scale !== scaleKey(owner) || meta.v !== BAR_VERSION) {
      toDelete.push(item.id);
      continue;
    }
    existing.set(k, item);
  }

  // Bring existing items up to date, building the missing ones.
  const toUpdate = new Map<string, (s: Shape) => void>();
  const toAdd: Item[] = [];
  for (const [k, w] of wanted) {
    const item = existing.get(k);
    if (item) {
      const change = diff(item, w);
      if (change) toUpdate.set(item.id, change);
    } else {
      toAdd.push(...(await build(w, dpi)));
    }
  }
  // build() creates bg+fill together; skip halves that exist or were built twice.
  const seen = new Set(existing.keys());
  const filteredAdd = toAdd.filter((i) => {
    const meta = i.metadata[BAR_KEY] as BarMeta;
    const k = key(meta.owner, meta.kind);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (toDelete.length) await OBR.scene.items.deleteItems(toDelete);
  if (filteredAdd.length) await OBR.scene.items.addItems(filteredAdd);
  if (toUpdate.size) {
    await OBR.scene.items.updateItems<Shape>([...toUpdate.keys()], (drafts) => {
      for (const d of drafts) toUpdate.get(d.id)?.(d as Shape);
    });
  }
}

function diff(item: Shape, w: Wanted): ((s: Shape) => void) | null {
  const changes: ((s: Shape) => void)[] = [];
  if (item.visible !== w.visible) changes.push((s) => (s.visible = w.visible));
  const ratio = hpRatio(w.data);
  const color = hpColor(ratio);
  if (w.kind === "fill") {
    const meta = item.metadata[BAR_KEY] as BarMeta;
    const width = fillWidth(meta.fullWidth ?? item.width, ratio);
    if (Math.abs(item.width - width) > 0.01) changes.push((s) => (s.width = width));
    if (item.style.fillColor !== color) changes.push((s) => (s.style.fillColor = color));
  }
  if (w.kind === "bg" && item.style.strokeColor !== color) {
    changes.push((s) => (s.style.strokeColor = color));
  }
  if (!changes.length) return null;
  return (s) => changes.forEach((c) => c(s));
}

function fillWidth(full: number, ratio: number) {
  // Keep a sliver rather than a zero-width shape.
  return Math.max(full * ratio, 0.01);
}

function base(w: Wanted, meta: BarMeta) {
  return buildShape()
    .attachedTo(w.token.id)
    .layer("ATTACHMENT")
    .locked(true)
    .disableHit(true)
    .disableAutoZIndex(true)
    .disableAttachmentBehavior(["ROTATION", "COPY"])
    .visible(w.visible)
    .metadata({ [BAR_KEY]: { ...meta, v: BAR_VERSION } });
}

async function build(w: Wanted, dpi: number): Promise<Item[]> {
  const bounds = await OBR.scene.items.getItemBounds([w.token.id]);
  const scale = scaleKey(w.token);
  const owner = w.token.id;

  if (w.kind === "ring") {
    const size = bounds.width * 1.12;
    return [
      base(w, { owner, kind: "ring", scale })
        .shapeType("CIRCLE")
        .width(size)
        .height(size)
        .position(bounds.center)
        .fillOpacity(0)
        .strokeColor(RING_COLOR)
        .strokeOpacity(1)
        .strokeWidth(dpi * 0.07)
        .build(),
    ];
  }

  const width = bounds.width * 0.8;
  const height = Math.max(dpi * 0.12, 6);
  const stroke = dpi * 0.015;
  const x = bounds.center.x - width / 2;
  const y = bounds.max.y - height - dpi * 0.05;
  const innerWidth = width - stroke;
  const ratio = hpRatio(w.data);
  const z = Date.now();

  const bg = base(w, { owner, kind: "bg", scale })
    .shapeType("RECTANGLE")
    .width(width)
    .height(height)
    .position({ x, y })
    .fillColor("#151515")
    .fillOpacity(0.85)
    .strokeColor(hpColor(ratio))
    .strokeOpacity(1)
    .strokeWidth(stroke)
    .zIndex(z)
    .build();
  const fill = base(w, { owner, kind: "fill", scale, fullWidth: innerWidth })
    .shapeType("RECTANGLE")
    .width(fillWidth(innerWidth, ratio))
    .height(height - stroke)
    .position({ x: x + stroke / 2, y: y + stroke / 2 })
    .fillColor(hpColor(ratio))
    .fillOpacity(1)
    .strokeWidth(0)
    .strokeOpacity(0)
    .zIndex(z + 1)
    .build();
  return [bg, fill];
}
