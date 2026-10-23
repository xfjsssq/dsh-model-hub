// dsh-model-hub — 宿主侧插件入口。
//
// 只做三件事：声明依赖、挂 /model-hub/api/* 路由、把停止权交给 cordis 的 effect。
// 客户端 UI 在 ./client.js（由 package.json 的 dsh.client 声明）。

import { setupRoutes } from './lib/host/routes.js'

export const name = 'dsh-model-hub'

// webServer 用于挂路由；llm 提供运行时模型注册表（listConfigurableProviders /
// listModels / resolveModelInfo）。settings 服务通过 ctx.get('settings') 惰性取用，
// 不写进 inject —— 它缺失时目录仍可读，只是不能写。
export const inject = ['webServer', 'llm']

export function apply(ctx, config = {}) {
  if (config && config.enabled === false) return
  ctx.effect(() => setupRoutes(ctx, config || {}), 'dsh-model-hub: /model-hub routes')
}
