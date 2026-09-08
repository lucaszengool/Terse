/**
 * three-stub.mjs — 一个够用的 'three' 替身,只为让模块 import 得进来。
 *
 * wallpaper-project.js 里真正用到 THREE 的只有 ProjectLayer 那个类,而这个 app
 * 值得测的是它上面那一排 sample*() —— 纯函数,进去是数据出来是坐标。可
 * `import * as THREE from 'three'` 在模块顶上,不解析就一行都跑不了,而 three 有
 * 四分之三兆,为了几个纯函数把它装进 node_modules 不合算。
 *
 * 所以给一个 Proxy:要什么给什么,都是空构造函数。没有 WebGL,也不需要 —— 这些
 * 函数一个 GL 调用都不发。
 */
const cls = () => new Proxy(function () {}, {
  construct: () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : undefined), set: () => true }),
  get: (t, k) => (k === 'prototype' ? t.prototype : cls()),
});
export default new Proxy({}, { get: () => cls() });
