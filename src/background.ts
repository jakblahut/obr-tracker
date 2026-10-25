import OBR, { ContextMenuIconFilter } from "@owlbear-rodeo/sdk";
import { ID, TOKEN_KEY, TokenData } from "./shared";
import { requestLocalSync } from "./local";
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
    const data: TokenData = { party, inCombat: false, hp: 0, maxHp: 0, init: null, ac: null };
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
    icons: [{ icon: icon("add.svg"), label: "Add to party", filter: notInTracker }],
    onClick: addToTracker(true),
  });
  OBR.contextMenu.create({
    id: `${ID}/add-enemy`,
    icons: [{ icon: icon("enemy.svg"), label: "Add as enemy", filter: notInTracker }],
    onClick: addToTracker(false),
  });
  OBR.contextMenu.create({
    id: `${ID}/remove`,
    icons: [
      {
        icon: icon("remove.svg"),
        label: "Remove from tracker",
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

function watchScene(ready: boolean, isGM: boolean) {
  unsubscribe.forEach((u) => u());
  unsubscribe = [];
  if (!ready) return;
  const sync = () => {
    // Only the GM writes the static scene shapes; everyone draws their own animation.
    if (isGM) requestSync();
    requestLocalSync();
  };
  unsubscribe.push(OBR.scene.items.onChange(sync));
  unsubscribe.push(OBR.scene.onMetadataChange(sync));
  sync();
}

OBR.onReady(async () => {
  setupContextMenus();
  const isGM = (await OBR.player.getRole()) === "GM";
  OBR.scene.onReadyChange((ready) => watchScene(ready, isGM));
  watchScene(await OBR.scene.isReady(), isGM);
});
