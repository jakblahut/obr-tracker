import OBR, { Item, Line, Shape, buildLine, buildShape, isLine, isShape } from "@owlbear-rodeo/sdk";
import { barRect, ringBox } from "./geometry";
import { BAR_KEY, CombatData, TokenData, barFill, hpColor, isDead, readCombat, tokenData } from "./shared";

/**
 * Draws static HP bars and the turn ring as real scene items attached to
 * tokens, so every client (including a cast device) sees them without running
 * any code. Only the GM client runs this. Enemy bars get visible=false, which
 * players can't see and the GM sees faded. The animated look is layered on
 * top by local.ts on clients that run the extension.
 */

/** x1/x2 are the two strokes of the X over a dead enemy. */
type Kind = "bg" | "fill" | "temp" | "ring" | "x1" | "x2";

const isCross = (kind: Kind) => kind === "x1" || kind === "x2";

/** Bump when bar geometry or style changes so old items get rebuilt. */
const BAR_VERSION = 7;

interface BarMeta {
  v?: number;
  owner: string;
  kind: Kind;
  /** Token scale when the item was built; rebuilt if the token is resized. */
  scale: string;
  /** Full inner bar: left edge and width, used to size fill and temp. */
  innerX?: number;
  innerWidth?: number;
}

interface Wanted {
  token: Item;
  kind: Kind;
  visible: boolean;
  data: TokenData;
}

/** Keeps rings under bars on the same layer. */
const RING_Z_DROP = 1e12;

export const DEAD_COLOR = "#e5383b";

export const RING_PARTY = "#b46bff";
export const RING_ENEMY = "#ff3b3b";

export function ringColor(data: TokenData) {
  return data.party ? RING_PARTY : RING_ENEMY;
}
export const TEMP_COLOR = "#5bbfff";

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

export function scaleKey(item: Item) {
  return `${item.scale.x.toFixed(3)},${item.scale.y.toFixed(3)}`;
}

function key(owner: string, kind: Kind) {
  return `${owner}:${kind}`;
}

/** Which overlays a token should have right now. Shared with local.ts. */
export function overlaysFor(data: TokenData, tokenId: string, combat: CombatData) {
  const fighting = combat.phase !== "idle" && data.inCombat;
  return {
    bar: data.maxHp > 0 && (fighting || (data.party ? combat.showPartyHp : combat.showEnemyHp)),
    ring: combat.phase === "active" && combat.turnId === tokenId,
  };
}

function wantedItems(tokens: Item[], combat: CombatData): Map<string, Wanted> {
  const wanted = new Map<string, Wanted>();
  for (const token of tokens) {
    const data = tokenData(token)!;
    const show = overlaysFor(data, token.id, combat);
    if (show.bar) {
      for (const kind of ["bg", "fill", "temp"] as const) {
        wanted.set(key(token.id, kind), { token, kind, visible: data.party, data });
      }
    }
    if (show.ring) {
      wanted.set(key(token.id, "ring"), { token, kind: "ring", visible: true, data });
    }
    if (isDead(data)) {
      // Everyone sees that an enemy died, including the cast.
      for (const kind of ["x1", "x2"] as const) {
        wanted.set(key(token.id, kind), { token, kind, visible: true, data });
      }
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
  const existing = new Map<string, Item>();
  for (const item of items) {
    const meta = item.metadata[BAR_KEY] as BarMeta | undefined;
    if (!meta) continue;
    const k = key(meta.owner, meta.kind);
    const owner = tokensById.get(meta.owner);
    const stale = !owner || meta.scale !== scaleKey(owner) || meta.v !== BAR_VERSION;
    const rightType = isCross(meta.kind) ? isLine(item) : isShape(item);
    if (!rightType || !wanted.has(k) || existing.has(k) || stale) {
      toDelete.push(item.id);
      continue;
    }
    existing.set(k, item);
  }

  const toUpdate = new Map<string, (s: Item) => void>();
  const toAdd: Item[] = [];
  const built = new Set<string>();
  for (const [k, w] of wanted) {
    const item = existing.get(k);
    if (item) {
      const change = diff(item, w);
      if (change) toUpdate.set(item.id, change);
    } else if (!built.has(k)) {
      // Bar parts are built together; skip parts that already exist.
      for (const shape of await build(w, dpi)) {
        const meta = shape.metadata[BAR_KEY] as BarMeta;
        const sk = key(meta.owner, meta.kind);
        if (existing.has(sk) || built.has(sk)) continue;
        built.add(sk);
        toAdd.push(shape);
      }
    }
  }

  // Add before deleting so a rejected add never leaves the scene empty.
  if (toAdd.length) await OBR.scene.items.addItems(toAdd);
  if (toUpdate.size) {
    await OBR.scene.items.updateItems([...toUpdate.keys()], (drafts) => {
      for (const d of drafts) toUpdate.get(d.id)?.(d);
    });
  }
  if (toDelete.length) await OBR.scene.items.deleteItems(toDelete);
}

function segment(meta: BarMeta, data: TokenData, kind: "fill" | "temp") {
  const fill = barFill(data);
  const innerX = meta.innerX ?? 0;
  const innerWidth = meta.innerWidth ?? 0;
  const from = kind === "fill" ? 0 : fill.hp;
  const to = kind === "fill" ? fill.hp : fill.temp;
  // Keep a sliver rather than a zero-width shape.
  return { x: innerX + innerWidth * from, width: Math.max(innerWidth * (to - from), 0.01), empty: to - from <= 0 };
}

function diff(item: Item, w: Wanted): ((s: Item) => void) | null {
  const changes: ((s: Item) => void)[] = [];
  if (item.visible !== w.visible) changes.push((s) => (s.visible = w.visible));
  if (isShape(item)) changes.push(...shapeChanges(item, w));
  if (!changes.length) return null;
  return (s) => changes.forEach((c) => c(s));
}

function shapeChanges(item: Shape, w: Wanted): ((s: Item) => void)[] {
  const changes: ((s: Shape) => void)[] = [];
  const color = hpColor(barFill(w.data).ratio);
  if (w.kind === "fill" || w.kind === "temp") {
    const seg = segment(item.metadata[BAR_KEY] as BarMeta, w.data, w.kind);
    const opacity = seg.empty ? 0 : 1;
    if (Math.abs(item.width - seg.width) > 0.01) changes.push((s) => (s.width = seg.width));
    if (Math.abs(item.position.x - seg.x) > 0.01) changes.push((s) => (s.position.x = seg.x));
    if (item.style.fillOpacity !== opacity) changes.push((s) => (s.style.fillOpacity = opacity));
    if (w.kind === "fill" && item.style.fillColor !== color) changes.push((s) => (s.style.fillColor = color));
  }
  if (w.kind === "ring" && item.style.strokeColor !== ringColor(w.data)) {
    changes.push((s) => (s.style.strokeColor = ringColor(w.data)));
  }
  if (w.kind === "bg" && item.style.strokeColor !== color) {
    changes.push((s) => (s.style.strokeColor = color));
  }
  return changes as ((s: Item) => void)[];
}

function base(w: Wanted, meta: BarMeta) {
  return attach(buildShape(), w, meta);
}

function attach<B extends ReturnType<typeof buildShape> | ReturnType<typeof buildLine>>(builder: B, w: Wanted, meta: BarMeta): B {
  return builder
    .attachedTo(w.token.id)
    .layer("ATTACHMENT")
    .locked(true)
    .disableHit(true)
    .disableAutoZIndex(true)
    .disableAttachmentBehavior(["ROTATION", "COPY"])
    .visible(w.visible)
    .metadata({ [BAR_KEY]: { ...meta, v: BAR_VERSION } }) as B;
}

async function build(w: Wanted, dpi: number): Promise<(Shape | Line)[]> {
  const bounds = await OBR.scene.items.getItemBounds([w.token.id]);
  const scale = scaleKey(w.token);
  const owner = w.token.id;
  const z = Date.now();

  if (isCross(w.kind)) {
    // A faint red X across the token, under the HP bar; local.ts animates it.
    const inset = bounds.width * 0.18;
    const { min, max } = bounds;
    const [from, to] =
      w.kind === "x1"
        ? [{ x: min.x + inset, y: min.y + inset }, { x: max.x - inset, y: max.y - inset }]
        : [{ x: max.x - inset, y: min.y + inset }, { x: min.x + inset, y: max.y - inset }];
    return [
      attach(buildLine(), w, { owner, kind: w.kind, scale })
        .startPosition(from)
        .endPosition(to)
        .strokeColor(DEAD_COLOR)
        .strokeOpacity(0.15)
        .strokeWidth(dpi * 0.02)
        .zIndex(z - 1)
        .build(),
    ];
  }

  if (w.kind === "ring") {
    const box = ringBox(bounds);
    return [
      base(w, { owner, kind: "ring", scale })
        .shapeType("CIRCLE")
        .width(box.ringDiameter)
        .height(box.ringDiameter)
        .position(bounds.center)
        .fillOpacity(0)
        .strokeColor(ringColor(w.data))
        // Faint, so the animated comet drawn on top is what you notice.
        .strokeOpacity(0.05)
        .strokeWidth(dpi * 0.025)
        // Below the HP bar shapes.
        .zIndex(z - RING_Z_DROP)
        .build(),
    ];
  }

  const r = barRect(bounds, dpi);
  const innerX = r.x + r.border;
  const innerWidth = r.width - r.border * 2;
  const meta = { owner, scale, innerX, innerWidth };
  const color = hpColor(barFill(w.data).ratio);

  const bg = base(w, { ...meta, kind: "bg" })
    .shapeType("RECTANGLE")
    .width(r.width - r.border)
    .height(r.height - r.border)
    // The stroke is centered on the edge; inset by half so it ends at the bar's edge.
    .position({ x: r.x + r.border / 2, y: r.y + r.border / 2 })
    .fillColor("#121212")
    .fillOpacity(0.8)
    .strokeColor(color)
    .strokeOpacity(1)
    .strokeWidth(r.border)
    .zIndex(z)
    .build();

  const part = (kind: "fill" | "temp", fillColor: string, zOffset: number) => {
    const seg = segment({ ...meta, kind }, w.data, kind);
    return base(w, { ...meta, kind })
      .shapeType("RECTANGLE")
      .width(seg.width)
      .height(r.height - r.border * 2)
      .position({ x: seg.x, y: r.y + r.border })
      .fillColor(fillColor)
      .fillOpacity(seg.empty ? 0 : 1)
      .strokeWidth(0)
      .strokeOpacity(0)
      .zIndex(z + zOffset)
      .build();
  };
  return [bg, part("fill", color, 1), part("temp", TEMP_COLOR, 2)];
}
