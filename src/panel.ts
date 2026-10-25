import OBR, { Item } from "@owlbear-rodeo/sdk";
import {
  CombatData,
  SCENE_KEY,
  TOKEN_KEY,
  TokenData,
  applyHpChange,
  clampHp,
  combatOrder,
  readCombat,
  tokenData,
  tokenName,
} from "./shared";

const header = document.getElementById("combat")!;
const list = document.getElementById("list")!;

let tokens: Item[] = [];
let combat: CombatData = readCombat({});
let renderPending = false;

async function patchToken(id: string, patch: Partial<TokenData>) {
  await OBR.scene.items.updateItems([id], (drafts) => {
    for (const d of drafts) {
      d.metadata[TOKEN_KEY] = { ...(d.metadata[TOKEN_KEY] as TokenData), ...patch };
    }
  });
}

async function setCombat(patch: Partial<CombatData>) {
  await OBR.scene.setMetadata({ [SCENE_KEY]: { ...combat, ...patch } });
}

/** "23" sets HP, "-7" / "+5" changes it. */
function parseHp(input: string, current: number): number | null {
  const s = input.replace(/\s/g, "");
  if (!s) return null;
  const n = Number(s);
  if (Number.isNaN(n)) return null;
  return /^[+-]/.test(s) ? current + n : n;
}

function parseOptional(raw: string): number | null | undefined {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isNaN(n) ? undefined : n;
}

function startCombat() {
  const order = combatOrder(tokens);
  if (!order.length) return;
  setCombat({ phase: "active", round: 1, turnId: order[0].id });
}

function step(dir: 1 | -1) {
  const order = combatOrder(tokens);
  if (!order.length) return;
  let idx = order.findIndex((t) => t.id === combat.turnId);
  let round = combat.round;
  if (idx === -1) {
    idx = 0;
  } else {
    idx += dir;
    if (idx >= order.length) {
      idx = 0;
      round += 1;
    } else if (idx < 0) {
      if (round <= 1) return;
      idx = order.length - 1;
      round -= 1;
    }
  }
  setCombat({ turnId: order[idx].id, round });
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function numberInput(value: number | null | undefined, title: string, onCommit: (raw: string) => void) {
  const input = el("input", { value: value == null ? "" : String(value), title, placeholder: title });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
  });
  input.addEventListener("change", () => onCommit(input.value));
  return input;
}

function row(token: Item): HTMLElement {
  const data = tokenData(token)!;
  const showInit = combat.phase !== "idle";
  const isTurn = combat.phase === "active" && combat.turnId === token.id;
  const classes = ["row"];
  if (showInit) classes.push("with-init");
  if (isTurn) classes.push("turn");
  if (combat.phase !== "idle" && !data.inCombat) classes.push("out");

  const name = el("span", { className: "name", title: "Select token" }, tokenName(token));
  name.addEventListener("click", () => OBR.player.select([token.id]));

  const side = el(
    "button",
    { className: "icon", title: data.party ? "Party (click: make enemy)" : "Enemy (click: make party)" },
    data.party ? "🛡️" : "💀",
  );
  side.addEventListener("click", () => patchToken(token.id, { party: !data.party }));

  const fight = el(
    "button",
    { className: `icon${data.inCombat ? "" : " off"}`, title: data.inCombat ? "In combat" : "Not in combat" },
    "⚔️",
  );
  fight.addEventListener("click", () => patchToken(token.id, { inCombat: !data.inCombat }));

  const hp = numberInput(data.hp, "HP", (raw) => {
    const s = raw.replace(/\s/g, "");
    const n = Number(s);
    if (!s || Number.isNaN(n)) return render();
    patchToken(token.id, /^[+-]/.test(s) ? applyHpChange(data, n) : { hp: clampHp(n, data.maxHp) });
  });
  hp.title = "HP (e.g. 23, or -7 / +5; damage uses temp HP first)";
  const temp = numberInput(data.tempHp || null, "Tmp", (raw) => {
    const n = parseHp(raw, data.tempHp ?? 0);
    if (n === null && raw.trim() !== "") return render();
    patchToken(token.id, { tempHp: Math.max(0, n ?? 0) });
  });
  temp.title = "Temp HP";
  temp.classList.add("temp");
  const maxHp = numberInput(data.maxHp, "Max", (raw) => {
    const n = Number(raw);
    if (Number.isNaN(n) || n < 0) return render();
    // First time max is set, start at full HP.
    const hpValue = data.maxHp === 0 && data.hp === 0 ? n : Math.min(data.hp, n);
    patchToken(token.id, { maxHp: n, hp: hpValue });
  });
  const ac = numberInput(data.ac, "AC", (raw) => {
    const n = parseOptional(raw);
    if (n === undefined) return render();
    patchToken(token.id, { ac: n });
  });

  const remove = el("button", { className: "icon", title: "Remove from tracker" }, "✕");
  remove.addEventListener("click", () =>
    OBR.scene.items.updateItems([token.id], (drafts) => {
      for (const d of drafts) delete d.metadata[TOKEN_KEY];
    }),
  );

  const cells: (Node | string)[] = [el("span", { className: "marker" }, isTurn ? "▶" : ""), name, side, fight];
  if (showInit) {
    const init = numberInput(data.init, "Init", (raw) => {
      const n = parseOptional(raw);
      if (n === undefined) return render();
      patchToken(token.id, { init: n });
    });
    init.classList.add("init");
    cells.push(init);
  }
  cells.push(el("span", { className: "hp" }, hp, "/", maxHp), temp, ac, remove);
  return el("div", { className: classes.join(" ") }, ...cells);
}

function renderHeader() {
  header.replaceChildren();
  const fighters = combatOrder(tokens);

  if (combat.phase === "idle") {
    const prepare = el(
      "button",
      { className: "primary", disabled: !fighters.length, title: "Mark combatants with ⚔️ first" },
      "Prepare combat",
    );
    prepare.addEventListener("click", () => setCombat({ phase: "setup", round: 0, turnId: null }));
    header.append(el("span", { className: "round" }, "Out of combat"), prepare);
  } else if (combat.phase === "setup") {
    const missing = fighters.filter((t) => tokenData(t)!.init == null).length;
    const cancel = el("button", {}, "Cancel");
    cancel.addEventListener("click", () => setCombat({ phase: "idle", round: 0, turnId: null }));
    const start = el(
      "button",
      {
        className: "primary",
        disabled: !fighters.length,
        title: missing ? `${missing} without initiative (they go last)` : "",
      },
      "Start combat",
    );
    start.addEventListener("click", startCombat);
    const status = missing ? `Initiative: ${missing} missing` : "Initiative ready";
    header.append(el("span", { className: "round" }, status), cancel, start);
  } else {
    const back = el("button", { title: "Previous turn" }, "◀");
    back.addEventListener("click", () => step(-1));
    const next = el("button", { className: "primary" }, "Next ▶");
    next.addEventListener("click", () => step(1));
    const end = el("button", {}, "End");
    end.addEventListener("click", () => setCombat({ phase: "idle", round: 0, turnId: null }));
    header.append(el("span", { className: "round" }, `Round ${combat.round}`), back, next, end);
  }

  const toggle = el("input", { type: "checkbox", checked: combat.showPartyHp });
  toggle.addEventListener("change", () => setCombat({ showPartyHp: toggle.checked }));
  header.append(el("label", {}, toggle, "Show party HP outside combat"));
}

const byName = (a: Item, b: Item) => tokenName(a).localeCompare(tokenName(b));
const partyFirst = (a: Item, b: Item) =>
  Number(tokenData(b)!.party) - Number(tokenData(a)!.party) || byName(a, b);

function render() {
  // Don't rebuild the list under the user's cursor while they type.
  if (list.contains(document.activeElement) && document.activeElement?.tagName === "INPUT") {
    renderPending = true;
    return;
  }
  renderPending = false;
  renderHeader();
  list.replaceChildren();

  if (!tokens.length) {
    list.append(el("div", { className: "empty" }, "No tokens yet. Right-click a token → Add to party / Add as enemy."));
    return;
  }

  if (combat.phase === "setup") {
    // Stable order while typing initiative; sorting happens on Start.
    const fighters = tokens.filter((t) => tokenData(t)!.inCombat).sort(partyFirst);
    const rest = tokens.filter((t) => !tokenData(t)!.inCombat).sort(partyFirst);
    list.append(el("h2", {}, "Combatants: enter initiative"), ...fighters.map(row));
    if (rest.length) list.append(el("h2", {}, "Not in combat"), ...rest.map(row));
    return;
  }

  if (combat.phase === "active") {
    const order = combatOrder(tokens);
    const rest = tokens.filter((t) => !order.includes(t)).sort(partyFirst);
    list.append(el("h2", {}, "Turn order"), ...order.map(row));
    if (rest.length) list.append(el("h2", {}, "Not in combat"), ...rest.map(row));
    return;
  }

  const party = tokens.filter((t) => tokenData(t)!.party).sort(byName);
  const enemies = tokens.filter((t) => !tokenData(t)!.party).sort(byName);
  if (party.length) list.append(el("h2", {}, "Party"), ...party.map(row));
  if (enemies.length) list.append(el("h2", {}, "Enemies"), ...enemies.map(row));
}

list.addEventListener("focusout", () => {
  // Let the change event commit first.
  setTimeout(() => renderPending && render(), 0);
});

let unsubscribe: (() => void)[] = [];

async function watchScene(ready: boolean) {
  unsubscribe.forEach((u) => u());
  unsubscribe = [];
  if (!ready) {
    tokens = [];
    render();
    return;
  }
  const onItems = (items: Item[]) => {
    tokens = items.filter((i) => tokenData(i));
    render();
  };
  unsubscribe.push(OBR.scene.items.onChange(onItems));
  unsubscribe.push(
    OBR.scene.onMetadataChange((md) => {
      combat = readCombat(md);
      render();
    }),
  );
  combat = readCombat(await OBR.scene.getMetadata());
  onItems(await OBR.scene.items.getItems());
}

OBR.onReady(async () => {
  if ((await OBR.player.getRole()) !== "GM") {
    list.append(el("div", { className: "empty" }, "Only the GM can use the tracker."));
    return;
  }
  OBR.scene.onReadyChange(watchScene);
  watchScene(await OBR.scene.isReady());
});
