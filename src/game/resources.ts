// src/game/resources.ts
import { ImageSource, Loader, Sound } from 'excalibur';
// 加载 Tiled 地图或大型 BGM
import { TiledResource } from '@excaliburjs/plugin-tiled';

// 使用 import 引入，Vite 会返回正确的 URL
import playerPng from 'game/assets/sprites/player.png';
import speakWav from 'game/assets/sfx/speak.mp3';

export const Resources = {
    Player: new ImageSource(playerPng),
    speakSound: new Sound(speakWav),
    Level1Map: new TiledResource('/game/map/level1.json'),
    BGM: new Sound('/game/music/background.mp3')
};

export const loader = new Loader(Object.values(Resources));
