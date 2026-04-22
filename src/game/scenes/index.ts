import { main } from "./main";

export const sceneList = {
    main: main
}

export type sceneName = keyof typeof sceneList