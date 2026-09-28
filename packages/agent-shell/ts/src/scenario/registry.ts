/**
 * 场景包注册表：宿主装配期的单一入口。
 *
 * 产品的 composition root 在启动早期把选中的包 register 进来；宿主各
 * 子系统（ToolRouter / storage / copy-skills / 渲染层槽位）从这里
 * 按槽位读取贡献，而不是各自硬编码 import 场景代码。
 *
 * 注册期即校验（fail loud）：重复 id 在 register 时抛错，而不是等到
 * 运行时才暴露。
 */
import type { ScenarioId, ScenarioPack } from './pack.js';

export class ScenarioRegistry {
  private readonly packs = new Map<ScenarioId, ScenarioPack>();

  register(pack: ScenarioPack): void {
    if (this.packs.has(pack.id)) {
      throw new Error(`[scenario] duplicate pack id: ${pack.id}`);
    }
    this.packs.set(pack.id, pack);
  }

  get(id: ScenarioId): ScenarioPack | undefined {
    return this.packs.get(id);
  }

  has(id: ScenarioId): boolean {
    return this.packs.has(id);
  }

  list(): readonly ScenarioPack[] {
    return [...this.packs.values()];
  }
}

/**
 * 进程级默认注册表。composition root（server/index.ts / 渲染层入口）
 * 在最早阶段填充；各子系统消费同一个实例。
 */
export const scenarioRegistry = new ScenarioRegistry();
