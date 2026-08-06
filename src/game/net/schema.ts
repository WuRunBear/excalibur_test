//
// THIS FILE HAS BEEN GENERATED AUTOMATICALLY
// DO NOT CHANGE IT MANUALLY UNLESS YOU KNOW WHAT YOU'RE DOING
//
// GENERATED USING @colyseus/schema 4.0.25
//

import { Schema, type, MapSchema } from '@colyseus/schema'

export class EntityState extends Schema {
  @type('uint32') public id: number = 0
  @type({ map: 'number' }) public values = new MapSchema<number>()
  @type({ map: 'string' }) public stringValues = new MapSchema<string>()
}

export class PlayerState extends Schema {
  @type('string') public sessionId: string = ''
  @type('uint32') public entityId: number = 0
  @type({ map: EntityState }) public visibleEntities = new MapSchema<EntityState>()
}

export class RoomState extends Schema {
  @type('uint32') public tick: number = 0
  @type('float64') public hour: number = 8
  @type('uint8') public phase: number = 0
  @type('string') public mapId: string = ''
  @type({ map: PlayerState }) public players = new MapSchema<PlayerState>()
  @type({ map: EntityState }) public entities = new MapSchema<EntityState>()
}
