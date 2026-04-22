// src/game/resources.ts
import { ImageSource, Sound } from 'excalibur';
// 加载 Tiled 地图或大型 BGM
import { TiledResource } from '@excaliburjs/plugin-tiled';

// 使用 import 引入，Vite 会返回正确的 URL
import playerPng from 'src/game/assets/sprites/player.png'; 
import hitWav from 'src/game/assets/sfx/hit.wav';

export const Resources = {
    Player: new ImageSource(playerPng),
    HitSound: new Sound(hitWav)
};

export const ExternalResources = {
    Level1Map: new TiledResource('/game/assets/map/level1.json'),
    BGM: new Sound('/game/assets/music/ambient-loop.mp3')
};