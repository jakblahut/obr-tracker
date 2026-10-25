import OBR, { ContextMenuIconFilter } from "@owlbear-rodeo/sdk";
import { ID, TOKEN_KEY, TokenData } from "./shared";
import { requestSync } from "./sync";

const icon = (file: string) => new URL(file, window.location.href).href;

const notInTracker: ContextMenuIconFilter = {
  roles: ["GM"],
  every: [
    { key: "type", value: "IMAGE" },
    { key: ["metadata", TOKEN_KEY], value: undefined },
  ],
};

function addToTracker(party: boolean) {
  return async (context: { items: { id: string }[] }) => {
    const data: TokenData = { party, inCombat: false, hp: 0, maxHp: 0, init: null };
    await OBR.scene.items.updateItems(
      context.items.map((i) => i.id),
      (drafts) => {
        for (const d of drafts) d.metadata[TOKEN_KEY] = { ...data };
      },
    );
    await OBR.action.open();
  };
}

function setupContextMenus() {
  OBR.contextMenu.create({
    id: `${ID}/add-party`,
    icons: [{ icon: icon("add.svg"), label: "Pridať do partie", filter: notInTracker }],
    onClick: addToTracker(true),
  });
  OBR.contextMenu.create({
    id: `${ID}/add-enemy`,
    icons: [{ icon: icon("enemy.svg"), label: "Pridať ako nepriateľa", filter: notInTracker }],
    onClick: addToTracker(false),
  });
  OBR.contextMenu.create({
    id: `${ID}/remove`,
    icons: [
      {
        icon: icon("remove.svg"),
        label: "Odobrať z trackera",
        filter: { roles: ["GM"], every: [{ key: ["metadata", TOKEN_KEY], value: undefined, operator: "!=" }] },
      },
    ],
    onClick: async (context) => {
      await OBR.scene.items.updateItems(
        context.items.map((i) => i.id),
        (drafts) => {
          for (const d of drafts) delete d.metadata[TOKEN_KEY];
        },
      );
    },
  });
}

let unsubscribe: (() => void)[] = [];

function watchScene(ready: boolean) {
  unsubscribe.forEach((u) => u());
  unsubscribe = [];
  if (!ready) return;
  unsubscribe.push(OBR.scene.items.onChange(() => requestSync()));
  unsubscribe.push(OBR.scene.onMetadataChange(() => requestSync()));
  requestSync();
}

OBR.onReady(async () => {
  setupContextMenus();
  // Only the GM draws bars; everyone else (players, the cast) just sees them.
  if ((await OBR.player.getRole()) !== "GM") return;
  OBR.scene.onReadyChange(watchScene);
  watchScene(await OBR.scene.isReady());
});
