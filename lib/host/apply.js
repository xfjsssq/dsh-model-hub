// dsh-model-hub — 能力写入 + 生效校验。
//
// 这是'看着能改其实没写进去'的唯一防线：写完必须回头用 ctx.llm.resolveModelInfo()
// 读一遍，任何字段对不上就返回 NOT_EFFECTIVE，让客户端回滚。

import { effectiveModel } from './catalog.js'
import { materializeCall } from './selftest.js'
import { CapabilityError, declaredModelRow, normalizeInputModalities, writeModelPatch } from './settings-bridge.js'

export const CAPABILITY_FIELDS = ['contextWindow', 'maxTokens', 'vision', 'inputModalities', 'reasoningEfforts']

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sameArray(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * 逐字段比对期望值与运行时值。
 *
 * inputModalities：严格比对（运行时回读 == 归一化后的请求值）。verifier 已在真宿主确认
 *   profile 的 input 立刻反映到 resolveModelInfo().inputModalities，所以严格比对是安全的。
 *
 * reasoningEfforts：**保守判据**。只要求请求里的非 off 档都出现在运行时的 efforts 里，
 *   另加『profile 声明层确实写入了该字段』。不做集合相等 —— pi-ai 会把未声明的档位也映射进
 *   thinkingLevelMap，精确相等会误报 NOT_EFFECTIVE（那正是必须避免的假失败）。
 *   请求值 null（unset）时，可验证的后置条件就是声明层里该字段消失了。
 *
 * @param declared 写入**之后**从 profile(user 层)读到的模型行；继承层为 undefined
 */
function verifyPatch(patch, effective, declared) {
  const verify = {};
  const read = (field) => (effective === undefined ? undefined : effective[field]);

  if (patch.contextWindow !== undefined) verify.contextWindow = read('contextWindow') === patch.contextWindow;
  if (patch.maxTokens !== undefined) verify.maxTokens = read('maxTokens') === patch.maxTokens;
  // vision 是 inputModalities 的布尔简写：两者同时给时只看 inputModalities，避免双重来源。
  if (patch.vision !== undefined && patch.inputModalities === undefined) verify.vision = read('vision') === patch.vision;

  if (patch.inputModalities !== undefined) {
    verify.inputModalities = sameArray(read('inputModalities'), normalizeInputModalities(patch.inputModalities));
  }

  if (patch.reasoningEfforts !== undefined) {
    const hasDeclared = declared !== undefined && Object.prototype.hasOwnProperty.call(declared, 'reasoningEfforts');
    if (patch.reasoningEfforts === null) {
      verify.reasoningEfforts = declared === undefined ? false : hasDeclared === false;
    } else {
      const efforts = read('efforts');
      const ids = new Set((Array.isArray(efforts) ? efforts : []).map((entry) => entry.id));
      const requested = Object.keys(patch.reasoningEfforts).filter((level) => level !== 'off');
      verify.reasoningEfforts = effective !== undefined && hasDeclared && requested.every((level) => ids.has(level));
    }
  }
  return verify;
}

/**
 * 写入模型能力并确认生效。
 *
 * @param ctx 宿主上下文
 * @param provider 提供商 id
 * @param model 模型 id
 * @param patch {contextWindow?, maxTokens?, vision?} —— 已由 pickPatch 过滤
 * @param options.signal 可选 AbortSignal，只作用于末尾的 prepareCall 证据读取
 * @returns 成功 { ok:true, effective, before, verify, prepared, ... }
 *          失败 { ok:false, code, message, effective?, verify?, prepared?, before? }
 */
export async function applyModelPatch(ctx, provider, model, patch, options) {
  const before = await effectiveModel(ctx, provider, model)
  const beforeValue = before.ok ? before.value : undefined

  let written
  try {
    written = await writeModelPatch(ctx, provider, model, patch)
  } catch (err) {
    if (err instanceof CapabilityError) return { ok: false, code: err.code, message: err.message, before: beforeValue }
    return {
      ok: false,
      code: 'WRITE_FAILED',
      message: err instanceof Error ? err.message : String(err),
      before: beforeValue,
    }
  }

  // 配置写入已完成（settings.mutate 内部 await 了 reconcile），这里读一次运行时结果。
  let after = await effectiveModel(ctx, provider, model)
  // 写入之后的声明层原值：reasoningEfforts 的 unset 只能在这一层验证。
  const declared = declaredModelRow(ctx, provider, model)
  let settledAfterMs = 0;
  let verify = verifyPatch(patch, after.ok ? after.value : undefined, declared)
  const mismatched = () => Object.values(verify).some((flag) => flag === false)
  if (after.ok && mismatched()) {
    // 极少数情况下响应式代次会晚一拍；给它 150ms 再确认一次，仍然不符就如实报失败。
    await sleep(150)
    after = await effectiveModel(ctx, provider, model)
    settledAfterMs = 150
    verify = verifyPatch(patch, after.ok ? after.value : undefined, declared)
  }

  const effective = after.ok ? after.value : undefined

  // 请求级证据：与 /selftest 同一份 prepareCall 物化结果，让客户端一次响应就能显示
  // 『下一次请求真正会用的参数』。
  //
  // 关键：prepareCall 失败**绝不影响**写入结论 —— 判定仍然只看 verify / after。
  // 读不到时 prepared 退化成 { prepareError }，客户端可忽略。
  const materializeOptions = options === undefined ? {} : { signal: options.signal }
  const preparedCall = await materializeCall(ctx, provider, model, materializeOptions)
  const prepared = preparedCall.ok
    ? preparedCall.value
    : { prepareError: { code: preparedCall.code, message: preparedCall.message } }

  const base = {
    ns: written.ns,
    base: written.base,
    layer: written.layer,
    ops: written.ops,
    written: written.written,
    before: beforeValue,
    effective,
    verify,
    settledAfterMs,
    prepared,
    declaredAfter: declared,
  }

  if (!after.ok) {
    return { ok: false, code: 'EFFECTIVE_READ_FAILED', message: after.message, ...base }
  }
  if (mismatched()) {
    const failed = Object.keys(verify).filter((field) => verify[field] === false)
    return {
      ok: false,
      code: 'NOT_EFFECTIVE',
      message: '配置已写入但运行时未生效: ' + failed.join(', '),
      ...base,
      pending: failed,
    }
  }
  return { ok: true, ...base }
}
