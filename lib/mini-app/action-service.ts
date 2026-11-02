import { createAnswerActionService } from "../intelligent-ui/action-service";
import { MiniAppActionHost, miniAppActionData } from "./action-host";

export const { readUiActions, startUiAction, controlUiAction } = createAnswerActionService({
  kind: "mini-app", tool: "piora_render_mini_app", data: miniAppActionData,
  host: (manager, root) => new MiniAppActionHost({ manager, root }),
});
