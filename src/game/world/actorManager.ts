import { Color, Scene } from 'excalibur'

import { EntityActor } from 'game/actors/entityActor'

import type { EntitySnapshot } from './entityStore'

/**
 * 实体 Actor 管理器：负责把“采样后的实体快照表”落地为 Scene 内的 Actor 增删改。
 *
 * 设计要点：
 * - 以 entityId 为稳定 key（对应服务端 NetworkId）
 * - 快照表里存在 → 确保 Actor 存在并更新位置
 * - 快照表里不存在 → 从 Scene 中移除并释放引用
 */
export class ActorManager {
  /**
   * entityId -> Actor 映射表。
   */
  private readonly actorsById = new Map<number, EntityActor>()

  /**
   * 根据实体快照创建一个渲染 Actor。
   *
   * @param snapshot 实体快照
   * @param localEntityId 本地玩家实体 id（用于高亮显示）
   * @returns 新建的实体 Actor
   */
  private createActor(snapshot: EntitySnapshot, localEntityId: number | undefined) {
    const color = localEntityId === snapshot.id ? Color.Cyan : Color.Orange

    return snapshot.shape === 0
      ? new EntityActor({
          entityId: snapshot.id,
          x: snapshot.x,
          y: snapshot.y,
          color,
          shape: 0,
          radius: snapshot.radius,
        })
      : new EntityActor({
          entityId: snapshot.id,
          x: snapshot.x,
          y: snapshot.y,
          color,
          shape: 1,
          w: snapshot.w,
          h: snapshot.h,
        })
  }

  /**
   * 应用一次快照：创建/更新/删除 Actor。
   *
   * @param scene 目标场景
   * @param snapshots 采样后的实体快照表（key=entityId）
   * @param localEntityId 本地玩家实体 id（用于高亮显示）
   */
  apply(scene: Scene, snapshots: Map<number, EntitySnapshot>, localEntityId: number | undefined) {
    const alive = new Set<number>()

    for (const [id, snapshot] of snapshots) {
      alive.add(id)
      let actor = this.actorsById.get(id)

      if (!actor || !actor.matchesRender(snapshot.shape, snapshot.radius, snapshot.w, snapshot.h)) {
        if (actor) scene.remove(actor)
        actor = this.createActor(snapshot, localEntityId)
        this.actorsById.set(id, actor)
        scene.add(actor)
      }

      actor.pos.x = snapshot.x
      actor.pos.y = snapshot.y
    }

    for (const [id, actor] of this.actorsById) {
      if (alive.has(id)) continue
      scene.remove(actor)
      this.actorsById.delete(id)
    }
  }

  /**
   * 根据 entityId 获取对应的 Actor（用于设置相机跟随等）。
   *
   * @param entityId 实体 id
   */
  getActor(entityId: number) {
    return this.actorsById.get(entityId)
  }

  /**
   * 清空场景中的全部实体 Actor（用于断线/切场景等场景重置）。
   *
   * @param scene 目标场景
   */
  clear(scene: Scene) {
    for (const actor of this.actorsById.values()) scene.remove(actor)
    this.actorsById.clear()
  }
}
