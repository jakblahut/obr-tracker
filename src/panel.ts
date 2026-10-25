import OBR, { Item } from "@owlbear-rodeo/sdk";
import {
  CombatData,
  SCENE_KEY,
  TOKEN_KEY,
  TokenData,
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

function startCombat() {
  const order = combatOrder(tokens);
  if (!order.length) return;
  setCombat({ active: true, round: 1, turnId: order[0].id });
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

function numberInput(value: number | null, title: string, onCommit: (raw: string) => void) {
  const input = el("input", { value: value === null ? "" : String(value), title });
  const commit = () => onCommit(input.value);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
  });
  input.addEventListener("change", commit);
  return input;
}

function row(token: Item): HTMLElement {
  const data = tokenData(token)!;
  const isTurn = combat.active && combat.turnId === token.id;
  const classes = ["row"];
  if (isTurn) classes.push("turn");
  if (combat.active && !data.inCombat) classes.push("out");

  const name = el("span", { className: "name", title: "Označiť token" }, tokenName(token));
  name.addEventListener("click", () => OBR.player.select([token.id]));

  const side = el(
    "button",
    { className: "icon", title: data.party ? "Partia (klik: nepriateľ)" : "Nepriateľ (klik: partia)" },
    data.party ? "🛡️" : "💀",
  );
  side.addEventListener("click", () => patchToken(token.id, { party: !data.party }));

  const fight = el(
    "button",
    { className: `icon${data.inCombat ? "" : " off"}`, title: data.inCombat ? "V boji" : "Mimo boja" },
    "⚔️",
  );
  fight.addEventListener("click", () => patchToken(token.id, { inCombat: !data.inCombat }));

  const init = numberInput(data.init, "Iniciatíva", (raw) => {
    const n = raw.trim() === "" ? null : Number(raw);
    if (n === null || !Number.isNaN(n)) patchToken(token.id, { init: n });
  });

  const hp = numberInput(data.hp, "HP (napr. 23, -7, +5)", (raw) => {
    const n = parseHp(raw, data.hp);
    if (n === null) return render();
    const clamped = Math.max(0, data.maxHp > 0 ? Math.min(n, data.maxHp) : n);
    patchToken(token.id, { hp: clamped });
  });
  const maxHp = numberInput(data.maxHp, "Max HP", (raw) => {
    const n = Number(raw);
    if (Number.isNaN(n) || n < 0) return render();
    // First time max is set, start at full HP.
    const hpValue = data.maxHp === 0 && data.hp === 0 ? n : Math.min(data.hp, n);
    patchToken(token.id, { maxHp: n, hp: hpValue });
  });

  const remove = el("button", { className: "icon", title: "Odobrať z trackera" }, "✕");
  remove.addEventListener("click", () =>
    OBR.scene.items.updateItems([token.id], (drafts) => {
      for (const d of drafts) delete d.metadata[TOKEN_KEY];
    }),
  );

  const node = el(
    "div",
    { className: classes.join(" ") },
    el("span", { className: "marker" }, isTurn ? "▶" : ""),
    name,
    side,
    fight,
    init,
    el("span", { className: "hp" }, hp, "/", maxHp),
    remove,
  );
  return node;
}

function renderHeader() {
  header.replaceChildren();
  if (combat.active) {
    const back = el("button", { title: "Späť" }, "◀");
    back.addEventListener("click", () => step(-1));
    const next = el("button", { className: "primary" }, "Ďalší ▶");
    next.addEventListener("click", () => step(1));
    const end = el("button", {}, "Ukončiť");
    end.addEventListener("click", () => setCombat({ active: false, round: 0, turnId: null }));
    header.append(el("span", { className: "round" }, `Kolo ${combat.round}`), back, next, end);
  } else {
    const fighters = combatOrder(tokens);
    const start = el(
      "button",
      { className: "primary", disabled: !fighters.length, title: "Najprv označ ⚔️ kto bojuje" },
      "Začať boj",
    );
    start.addEventListener("click", startCombat);
    header.append(el("span", { className: "round" }, "Mimo boja"), start);
  }
  const toggle = el("input", { type: "checkbox", checked: combat.showPartyHp });
  toggle.addEventListener("change", () => setCombat({ showPartyHp: toggle.checked }));
  header.append(el("label", {}, toggle, "Zobraziť HP partie aj mimo boja"));
}

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
    list.append(
      el("div", { className: "empty" }, "Žiadne tokeny. Pravý klik na token → Pridať do partie / Pridať ako nepriateľa."),
    );
    return;
  }

  if (combat.active) {
    const order = combatOrder(tokens);
    const rest = tokens.filter((t) => !order.includes(t));
    list.append(el("h2", {}, "Poradie"), ...order.map(row));
    if (rest.length) list.append(el("h2", {}, "Mimo boja"), ...rest.map(row));
    return;
  }

  const byName = (a: Item, b: Item) => tokenName(a).localeCompare(tokenName(b));
  const party = tokens.filter((t) => tokenData(t)!.party).sort(byName);
  const enemies = tokens.filter((t) => !tokenData(t)!.party).sort(byName);
  if (party.length) list.append(el("h2", {}, "Partia"), ...party.map(row));
  if (enemies.length) list.append(el("h2", {}, "Nepriatelia"), ...enemies.map(row));
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
    list.append(el("div", { className: "empty" }, "Tracker ovláda len GM."));
    return;
  }
  OBR.scene.onReadyChange(watchScene);
  watchScene(await OBR.scene.isReady());
});
