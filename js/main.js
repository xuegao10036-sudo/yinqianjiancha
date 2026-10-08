/* 印前检查-雪糕 面板前端逻辑 (CEP) */
(function () {
  "use strict";

  var JS_BUILD = "20261008-2";
  // 必须与 jsx/preflight.jsx 里的 PF_BUILD 保持一致。
  // JSX 每次返回都会带上它的构建号,前端据此判断 ExtendScript 引擎里
  // 加载的是不是当前版本 —— 不一致就强制 $.evalFile 重载(见 execJsx)。
  var JSX_BUILD = "10.11";
  // v10.2 收尾: 「耗时较长」提示阈值 —— 原先 20000 在 run() 与 execAction() 各写一遍,
  //   连提示语里的「20 秒」也是手写 ⇒ 改口径要动 3 处、漏一处就文案与行为不一致。收成一处。
  var BUSY_TIMEOUT_MS = 20000;

  // 全局错误捕获: 把任何未捕获异常显示到面板,便于定位"空白"问题
  window.onerror = function (msg, url, line, col) {
    try {
      var el = document.getElementById("error");
      if (el) {
        el.textContent = "JS运行错误: " + msg + " (行 " + line + ")";
        el.classList.remove("hidden");
      }
    } catch (e) {}
    return false;
  };

  function $(id) { return document.getElementById(id); }

  // Base64 解码 + UTF-8 还原
  function b64ToStr(b64) {
    b64 = String(b64).replace(/[^A-Za-z0-9+/=]/g, "");
    var bytes = [];
    // v8.6: 优先用 CEP 宿主(Chromium)原生 atob —— 原逐字符 chars.indexOf 是每字符
    //   O(64) 扫描;atob 由原生实现、快一个量级,还省掉那张 64 字符表。
    //   宿主万一没有 atob 时退回原来的纯 JS 解码(行为一致),不冒"某台机器解不出来"的险。
    var bin = null;
    try { if (typeof atob === "function") bin = atob(b64); } catch (eAtob) { bin = null; }
    if (bin !== null) {
      for (var bi = 0; bi < bin.length; bi++) bytes.push(bin.charCodeAt(bi) & 0xFF);
    } else {
      var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      var buf = 0, bits = 0;
      for (var i = 0; i < b64.length; i++) {
        var c = b64.charAt(i);
        if (c === "=") break;
        var idx = chars.indexOf(c);
        if (idx < 0) continue;
        buf = (buf << 6) | idx;
        bits += 6;
        if (bits >= 8) { bits -= 8; bytes.push((buf >> bits) & 0xFF); }
      }
    }
    var out = "";
    var j = 0;
    while (j < bytes.length) {
      var b = bytes[j++];
      if (b < 0x80) out += String.fromCharCode(b);
      else if (b < 0xE0) out += String.fromCharCode(((b & 0x1F) << 6) | (bytes[j++] & 0x3F));
      else if (b < 0xF0) out += String.fromCharCode(((b & 0x0F) << 12) | ((bytes[j++] & 0x3F) << 6) | (bytes[j++] & 0x3F));
      else {
        var cp = ((b & 0x07) << 18) | ((bytes[j++] & 0x3F) << 12) | ((bytes[j++] & 0x3F) << 6) | (bytes[j++] & 0x3F);
        cp -= 0x10000;
        out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
      }
    }
    return out;
  }

  function inCEP() { return !!window.__adobe_cep__; }

  function evalScript(script, cb) {
    window.__adobe_cep__.evalScript(script, cb);
  }

  // ---------- JSX 调用统一入口 ----------
  // 统一解析返回值: Base64(新) 优先; 兼容 URL 编码与纯 JSON 的旧返回。
  // 解析不出结构化结果时返回 null(不抛异常),由调用方决定如何提示。
  function parseResult(result) {
    try {
      if (!result || result === "undefined" || result === "EvalScript error.") return null;
      if (result.charAt(0) === "%") return JSON.parse(decodeURIComponent(result));
      if (/^[A-Za-z0-9+/=]+$/.test(result) && result.charAt(0) !== "{") return JSON.parse(b64ToStr(result));
      return JSON.parse(result);
    } catch (e) { return null; }
  }

  // v8.7: 结果缓存 —— 扩展路径在会话内不变, 而原实现每次 execJsx 都要白跑一遍
  //   getSystemPath + decodeURI + replace; 快路径(jsxReady)上算完即丢, 每次面板
  //   获得焦点的 pfDocKey 探针也要付这笔开销。
  //   首次读不到(getSystemPath 抛异常 => extPath 为空串)时**不写缓存**, 留给下次重试。
  var jsxPathCache = "";
  function jsxFilePath() {
    if (jsxPathCache) return jsxPathCache;
    var extPath = "";
    try { extPath = decodeURI(window.__adobe_cep__.getSystemPath("extension")); } catch (e) {}
    var p = (extPath + "/jsx/preflight.jsx").replace(/\\/g, "/");
    if (extPath) jsxPathCache = p;
    return p;
  }

  // v3.1: 已确认引擎内 JSX 版本正确时,跳过 $.evalFile 直接调用函数,
  // 省掉每次检查都重新读取并解析 28KB 脚本的开销。
  // 两种情况会自动退回"带重载"的调用: ① AI 重启后引擎被清空
  // ② 部署了新版 jsx(PF_BUILD 变了)—— 所以改完 JSX 仍无需重启 AI。
  var jsxReady = false;
  function execJsx(call, cb) {
    var withLoad = '$.evalFile("' + jsxFilePath() + '"); ' + call;
    var first = jsxReady ? call : withLoad;
    evalScript(first, function (result) {
      var data = parseResult(result);
      if (data && data.build === JSX_BUILD) { jsxReady = true; cb(data, result); return; }
      if (first === withLoad) { jsxReady = false; cb(data, result); return; } // 已重载仍异常
      evalScript(withLoad, function (result2) {
        var data2 = parseResult(result2);
        jsxReady = !!(data2 && data2.build === JSX_BUILD);
        cb(data2, result2);
      });
    });
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // v5.0: 文件名显示处理
  // ① URL 编码还原: AI 的 item.name 可能是 %E5%B0%81... 编码形态,
  //    先尝试 decodeURIComponent 还原成中文;名字里恰好含非法 % 时保持原样
  function decodeImgName(s) {
    s = String(s || "");
    if (s.indexOf("%") < 0) return s;
    try {
      var d = decodeURIComponent(s);
      // 还原结果不应再含 %xx(防止二次编码/误解码)
      return (d.indexOf("%") < 0) ? d : s;
    } catch (e) { return s; }
  }

  // ② 单行截断: 超过 maxLen 个字符截断加 …(完整名由调用方放 title)
  function truncName(s, maxLen) {
    s = String(s || "");
    maxLen = maxLen || 30;
    if (s.length <= maxLen) return s;
    return s.substring(0, maxLen) + "…";
  }

  // ---------- 状态徽标 ----------
  function chip(level, text) {
    var map = { ok: "通过", warn: "注意", bad: "风险" }; // v5.7: 移除从未使用的 info 级别
    return '<span class="chip ' + level + '">' + esc(text || map[level]) + "</span>";
  }

  // 缺失字体列表(带橙色三角感叹号)
  function renderMissingFonts(arr) {
    var items = arr.map(function (n) {
      // v9.0: 清单每行都是缺失项, 行首 ⚠ 属冗余, 按雪糕要求去掉(卡④ 缺失链接那处保留)
      return "<li>" + esc(n) + "</li>";
    }).join("");
    // v5.17: 按用户要求去掉括号说明与"检测方式"灰字,只留名单
    return '<div>缺失字体 <b class="bad-t">' + arr.length + "</b> 个:</div>" +
      '<ul class="list">' + items + "</ul>";
  }

  // v5.16: 字体诊断行(fontDiagText)随根因确诊移除

  // chipLevel: 徽标自身的配色级别(可省略,默认沿用卡片级别)
  // v4.3: 卡 1 的"CMYK/RGB"徽标配色必须只跟色彩模式状态走,不能继承卡片级别
  //       ——否则出血不足(黄)会把 CMYK 徽标染黄,看起来像"色彩模式有问题"
  // v5.0: 新增 extraChip(可选)— 卡片右上角可并列第二个徽标(如卡1出血不足)
  function card(title, level, chipText, bodyHtml, chipLevel, extraChip) {
    return '<div class="card"><div class="card-head"><span>' + esc(title) + "</span><span class='chips'>" +
      chip(chipLevel || level, chipText) + (extraChip ? extraChip : "") + '</span></div><div class="card-body">' + bodyHtml + "</div></div>";
  }

  // v7.0: 标题行 + 右侧样本截断提示(与标题同一行、右对齐、不带括号)
  // 不带"共 N"是因为总数已经在标题的计数里,避免同一行重复报数
  function rowHead(leftHtml, hintText) {
    return '<div class="row-head"><span class="row-t">' + leftHtml + "</span>" +
      (hintText ? '<span class="row-h">' + esc(hintText) + "</span>" : "") + "</div>";
  }

  // ---------- v10.0: 七卡开关(设置弹层) ----------
  // 卡片顺序与 jsx 的 CK 一一对应: ①ab画板出血 ②hd隐藏 ③ft字体 ④im嵌入 ⑤rs分辨率 ⑥ik油墨描边 ⑦ov叠印
  var CK_NAMES = ["画板 · 出血 · 色彩", "隐藏图层 · 对象", "字体 · 转曲", "图片嵌入", "图片分辨率", "油墨 · 描边粗细", "叠印"];
  // v10.1: 卡片显示顺序(位置 -> 卡号)。拖动只改显示; 传给 jsx 的开关仍按固定卡序(ckArgs)
  var CARD_ORDER = [0, 1, 2, 3, 4, 5, 6];
  var CARD_CK = [true, true, true, true, true, true, true];
  // SCAN_CK = 本轮扫描实际用的开关快照 —— 渲染占位卡按它判,
  //   避免"扫描后又改勾选"拿旧数据/空数据当新结果显示。
  var SCAN_CK = null;
  try {
    var ckSaved = localStorage.getItem("pf_cards");
    if (ckSaved !== null && /^[01]{7}$/.test(ckSaved)) {
      for (var ckI = 0; ckI < 7; ckI++) CARD_CK[ckI] = ckSaved.charAt(ckI) === "1";
    }
  } catch (eCK) {}

  // ---------- v10.1: 阈值(唯一真源在 jsx 的 PF_TH_DEF) ----------
  //   前端**不保存任何阈值默认值**: 默认由 jsx 的 pfThDefaults() 下发;
  //   用户改动只存"改动项"于 localStorage["pf_th"](竖线分隔, 与 jsx pfThApply 的 keys 同序),
  //   扫描时作为 runPreflight 的第 8 参传回 jsx; 生效值再由 res.th 回传供渲染显示。
  //   ⇒ 以后调阈值只改 jsx 一处(PF_TH_DEF), 面板判定与文案自动跟随。
  // v10.2: 去掉「其中重度」(tinyBad) —— 字号只留一条判定(<tiny 直接标红)。
  var TH_KEYS = ["bleed", "reso", "thin", "tiny", "inkOk", "inkWarn"];
  // ⚠ 老用户 localStorage 里的 pf_th 是 v10.1 的 7 项格式(含 tinyBad)。
  //   线序靠"字段数"区分: 7 项按旧线序读、6 项按新线序读 —— 否则会把 inkOk 当 tinyBad 用,
  //   判定拿错数字而且毫无提示(油墨阈值变成 5/220 ⇒ 满屏标红)。
  var TH_KEYS_V101 = ["bleed", "reso", "thin", "tiny", "tinyBad", "inkOk", "inkWarn"];
  var TH_DEF = null;    // jsx 下发的默认值(含 cap/scan/light 等非用户项)
  var TH_PREF = null;   // 用户改过的项(只存改动)
  var PF_TH = null;     // 显示用生效值 = 默认 ⊕ 改动; 扫描后由 res.th 校准

  // 设置弹层里的阈值输入(顺序即界面顺序; step 只影响上下箭头粒度)
  // v10.2: 顺序按"默认卡片顺序"排(雪糕点名: 第一个是出血不足) ——
  //   出血(卡①) → 极小字号(卡③) → 分辨率(卡⑤) → 描边 / 油墨(卡⑥)。
  //   ⚠ 这里只管**界面顺序**; 传给 jsx 的线序另由 TH_KEYS 决定, 两者不必同序。
  var TH_FIELDS = [
    { k: "bleed",   label: "出血不足",       unit: "mm",  step: "0.5" },
    { k: "tiny",    label: "极小字号低于",   unit: "pt",  step: "0.5" },
    { k: "reso",    label: "图片分辨率低于", unit: "ppi", step: "1" },
    { k: "thin",    label: "描边细于",       unit: "mm",  step: "0.05" },
    { k: "inkOk",   label: "油墨总量偏重",   unit: "",    step: "5" },
    { k: "inkWarn", label: "油墨总量超标",   unit: "",    step: "5" }
  ];

  function thParse(s) {   // "3|300|..." -> {bleed:3, reso:300, ...}; 非数字/<=0 的项忽略
    if (!s) return null;
    var p = String(s).split("|"), o = {}, i, v, any = false;
    // v10.2: 7 项 = v10.1 旧格式，按旧线序读；只留当前键，旧格式里的 tinyBad 自然被丢弃
    var ks = (p.length === TH_KEYS_V101.length) ? TH_KEYS_V101 : TH_KEYS;
    for (i = 0; i < ks.length; i++) {
      if (TH_KEYS.indexOf(ks[i]) < 0) continue;
      v = parseFloat(p[i]);
      if (!isNaN(v) && isFinite(v) && v > 0) { o[ks[i]] = v; any = true; }
    }
    return any ? o : null;
  }
  function thWire(o) {   // {..} -> "3|300|..."; 缺项留空(jsx 侧回落默认)
    if (!o) return "";
    var a = [], i, v;
    for (i = 0; i < TH_KEYS.length; i++) {
      v = o[TH_KEYS[i]];
      a.push(v === undefined || v === null ? "" : v);
    }
    return a.join("|");
  }
  // jsx 第 8 参(字符串字面量)。空串 ⇒ jsx 的 pfThApply 逐项回落 PF_TH_DEF
  function thArg() { return '"' + thWire(TH_PREF) + '"'; }
  function thSave() {
    try {
      var w = thWire(TH_PREF);
      if (w) localStorage.setItem("pf_th", w); else localStorage.removeItem("pf_th");
    } catch (eT) {}
  }
  try { TH_PREF = thParse(localStorage.getItem("pf_th")); } catch (eT0) {}

  function thEffV(k) {   // 某项的当前打算值(改动优先, 否则默认)
    if (TH_PREF && TH_PREF[k] !== undefined) return TH_PREF[k];
    if (TH_DEF && TH_DEF[k] !== undefined) return TH_DEF[k];
    return undefined;
  }
  function thRefresh() {  // 重算显示用生效值
    PF_TH = {};
    for (var i = 0; i < TH_KEYS.length; i++) {
      var v = thEffV(TH_KEYS[i]);
      if (v !== undefined) PF_TH[TH_KEYS[i]] = v;
    }
  }
  // 渲染取阈值: 优先本次回传的生效值, 其次上次值; 都没有给 "?"(宁可见问号也不猜数字)
  // v10.11: thRefresh 只回填 6 个可编辑键 —— 若在首次扫描前重建过 PF_TH,
  //   light/cap/scan 三项会落空, thv 回退 TH_DEF 兜底(正常路径 render 开头
  //   就会用 res.th 九键整体覆盖, 此兜底只影响扫描前的边缘路径)。
  function thv(k) {
    if (PF_TH && PF_TH[k] !== undefined && PF_TH[k] !== null) return PF_TH[k];
    if (TH_DEF && TH_DEF[k] !== undefined && TH_DEF[k] !== null) return TH_DEF[k];
    return "?";
  }

  // 取"当前生效阈值": 已有默认值则直接算; 否则问 jsx 要一次默认值(只回默认, 不扫描文档)
  var thBusy = false, thQ = [];
  function thEnsure(cb) {
    if (TH_DEF) { thRefresh(); cb(); return; }
    thQ.push(cb);
    if (thBusy) return;
    thBusy = true;
    function fin() {
      thBusy = false;
      var q = thQ; thQ = [];
      for (var i = 0; i < q.length; i++) { try { q[i](); } catch (eQ) {} }
    }
    if (!inCEP()) { thRefresh(); fin(); return; }
    execJsx("pfThDefaults();", function (data) {
      if (data && data.th) TH_DEF = data.th;
      thRefresh();
      fin();
    });
  }

  // ---------- v10.1: 阈值草稿 —— 输入框先写草稿, 按「确认」才落盘(pf_th) ----------
  //   为什么要草稿: 边打边存的话, 输入 300 的过程(3 → 30 → 300)会存三次; 而且"打开看看、
  //   没想改"也会留下痕迹。草稿制: 「确认」= 落盘并关闭; 「关闭」= 放弃本次编辑。
  var TH_DRAFT = null;   // null = 弹层没开; {..} = 正在编辑的那一份
  function thDraftV(k) {   // 草稿值优先, 其次用户已存改动, 再次默认
    if (TH_DRAFT && TH_DRAFT[k] !== undefined) return TH_DRAFT[k];
    return thEffV(k);
  }
  function thDraftInit() {   // 起稿: 全量 7 项(拿不到默认值时退回上次生效值)
    TH_DRAFT = {};
    for (var i = 0; i < TH_KEYS.length; i++) {
      var k = TH_KEYS[i];
      var v = thEffV(k);
      if (v === undefined && PF_TH && PF_TH[k] !== undefined) v = PF_TH[k];
      if (v !== undefined) TH_DRAFT[k] = v;
    }
  }
  function thDraftDiscard() { TH_DRAFT = null; }
  function thDraftCommit() {   // 「确认」: 草稿 -> TH_PREF -> localStorage["pf_th"]
    var i, k, v, o = null;
    for (i = 0; i < TH_KEYS.length; i++) {
      k = TH_KEYS[i];
      v = (TH_DRAFT && TH_DRAFT[k] !== undefined) ? TH_DRAFT[k] : thEffV(k);
      if (v === undefined) continue;
      // 与默认值相同就不存 —— 让 pf_th 里只留真正改过的项
      if (TH_DEF && TH_DEF[k] !== undefined && String(TH_DEF[k]) === String(v)) continue;
      if (!o) o = {};
      o[k] = v;
    }
    TH_PREF = o;
    thSave();
    thRefresh();
  }
  // 「重置默认」: 卡片开关全开 + 顺序复原 + 阈值清空(三项一起, 与按钮文案一致)
  function thResetAll() {
    var i;
    for (i = 0; i < 7; i++) CARD_CK[i] = true;
    ckSave();
    CARD_ORDER = [0, 1, 2, 3, 4, 5, 6];
    orderSave();
    TH_PREF = null;
    thSave();
    thRefresh();
    thDraftInit();
  }
  function fillDraftInputs() {   // 输入框一律显示草稿值
    for (var i = 0; i < TH_FIELDS.length; i++) {
      var k = TH_FIELDS[i].k;
      var el = $("th_" + k);
      if (el) {
        var v = thDraftV(k);
        el.value = (v === undefined) ? "" : v;
      }
    }
  }
  // 输入的联动纠正 —— 与 jsx pfThApply 的两条不变量同口径(只动草稿, 不落盘)
  function onThChange(k, inp) {
    var v = parseFloat(inp.value);
    if (!TH_DRAFT) TH_DRAFT = {};
    if (!isNaN(v) && isFinite(v) && v > 0) TH_DRAFT[k] = v; else delete TH_DRAFT[k];
    var ov = thDraftV("inkOk"), wv = thDraftV("inkWarn");
    if (ov !== undefined && wv !== undefined && wv <= ov) TH_DRAFT.inkWarn = ov + 1;
    fillDraftInputs();
  }

  // ---------- v10.1: 卡片显示顺序(pf_order, 7 位数字 = 位置 -> 卡号) ----------
  function orderSave() {
    try { localStorage.setItem("pf_order", CARD_ORDER.join("")); } catch (eO) {}
  }
  // 拖动排序用到的两个纯逻辑 + 两个拖拽期变量
  function orderMove(o, from, to) {   // 把 from 位置那张卡挪到 to 位置; 越界/原地返回副本
    var a = o.slice(0);
    if (from < 0 || from > 6 || to < 0 || to > 6 || from === to) return a;
    var v = a.splice(from, 1)[0];
    a.splice(to, 0, v);
    return a;
  }
  function posFromY(list, y) {   // 光标 y 落在第几个"插入位"(按各行中线判)
    var rs = list && list.children, n = rs ? rs.length : 0, i, r;
    if (!n || !rs[0] || typeof rs[0].getBoundingClientRect !== "function") return -1;
    for (i = 0; i < n; i++) {
      r = rs[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) return i;
    }
    return n - 1;
  }
  var dragPos = -1, dragMove = null, dragUp = null;
  try {
    var oSaved = localStorage.getItem("pf_order");
    if (oSaved && /^[0-6]{7}$/.test(oSaved)) {
      var oArr = [], oOk = true, oK, oV;
      for (oK = 0; oK < 7; oK++) {
        oV = parseInt(oSaved.charAt(oK), 10);
        if (oArr.indexOf(oV) >= 0) { oOk = false; break; }   // 必须是不重复的 0~6 全排列
        oArr.push(oV);
      }
      if (oOk && oArr.length === 7) CARD_ORDER = oArr;
    }
  } catch (eO2) {}

  function ckArgs() {
    var a = [], i;
    for (i = 0; i < 7; i++) a.push(CARD_CK[i] ? 1 : 0);
    return a.join(",");
  }
  function ckSave() {
    try {
      var t = "", i;
      for (i = 0; i < 7; i++) t += CARD_CK[i] ? "1" : "0";
      localStorage.setItem("pf_cards", t);
    } catch (eP) {}
  }
  // 已关闭的卡: 灰化占位(样式 .card-off / .chip.off), 不渲染任何数据
  function offCard(title) {
    return '<div class="card card-off"><div class="card-head"><span>' + esc(title) +
      '</span><span class="chips"><span class="chip off">已关闭</span></span></div>' +
      '<div class="card-body"><span class="dim">本轮未检查。在「设置」里勾选后点「开始检查」。</span></div></div>';
  }

  // 设置弹层: 勾选行按真实卡序生成(卡片名只在 CK_NAMES 维护一份, 与 es 侧同序)
  function initSettings() {
    var list = $("setList"), mask = $("setMask");
    if (!list || !mask) return;
    // v10.1: 关闭 = 放弃未确认的阈值草稿(开关与顺序是即时的, 不受影响)
    function closeSet() { thDraftDiscard(); mask.classList.add("hidden"); }

    // v10.1: 勾选行按 CARD_ORDER 渲染(卡号 i 仍对应 jsx 的 c1..c7)。
    //   「①②③」序号已去掉; 顺序由右侧抓手**拖动**调整(初版的 ↑↓ 已按雪糕要求撤掉)。
    function drawRows() {
      var h = "", pos, i;
      for (pos = 0; pos < 7; pos++) {
        i = CARD_ORDER[pos];
        h += '<div class="set-row' + (pos === dragPos ? " dragging" : "") + '">' +
          '<label class="set-ck"><input type="checkbox" id="ck' + (i + 1) + '">' +
          "<span>" + esc(CK_NAMES[i]) + "</span></label>" +
          '<span class="grip" data-grip="' + pos + '" title="按住拖动，调整卡片上下顺序"></span></div>';
      }
      list.innerHTML = h;
      for (pos = 0; pos < 7; pos++) {
        (function (idx) {
          var box = $("ck" + (idx + 1));
          if (!box) return;
          box.checked = CARD_CK[idx];
          box.onchange = function () { CARD_CK[idx] = box.checked; ckSave(); };
        })(CARD_ORDER[pos]);
      }
    }
    // v10.1: 拖动排序 —— 抓手按下 → 光标移动时实时换位 → 松手落盘(pf_order)。
    //   ⚠ 不用 HTML5 的 draggable: CEP 里拖影会残留在面板上; 自己接线还能给插入位实时反馈,
    //     而且 orderMove/posFromY 是纯逻辑, 可以脱离浏览器直接测。
    function endDrag() {
      if (dragPos < 0) return;
      dragPos = -1;
      if (dragMove) { document.removeEventListener("mousemove", dragMove); dragMove = null; }
      if (dragUp) { document.removeEventListener("mouseup", dragUp); dragUp = null; }
      orderSave();
      drawRows();
    }
    list.addEventListener("mousedown", function (e) {
      var t = e.target;
      if (!t || !t.getAttribute || t.getAttribute("data-grip") === null) return;
      var p = parseInt(t.getAttribute("data-grip"), 10);
      if (isNaN(p) || p < 0 || p > 6) return;
      dragPos = p;
      drawRows();          // 让被拖的那行带上 .dragging
      e.preventDefault();  // 别顺手选中文字
      dragMove = function (ev) {
        if (dragPos < 0) return;
        var to = posFromY(list, ev.clientY);
        if (to < 0 || to === dragPos) return;
        CARD_ORDER = orderMove(CARD_ORDER, dragPos, to);
        dragPos = to;
        drawRows();
      };
      dragUp = function () { endDrag(); };
      document.addEventListener("mousemove", dragMove);
      document.addEventListener("mouseup", dragUp);
    });

    // v10.1: 阈值输入 —— 数值来自 jsx 下发的默认值/上次生效值
    function drawTh() {
      var el = $("setTh");
      if (!el) return;
      var h = "", i, j;
      for (i = 0; i < TH_FIELDS.length; i++) {
        h += '<label class="th-row"><span class="th-name">' + esc(TH_FIELDS[i].label) + "</span>" +
          '<input type="number" class="th-in" id="th_' + TH_FIELDS[i].k + '"' +
          ' step="' + TH_FIELDS[i].step + '" min="0">' +
          // v10.1: 单位列**无条件**生成(空就空着) —— 否则没单位的两行少一个节点,
          //   在 flex space-between 下输入框会被推到更靠右, 7 行左边界就不齐了。
          '<span class="th-unit">' + (TH_FIELDS[i].unit || "") + "</span>" +
          "</label>";
      }
      el.innerHTML = h;
      for (j = 0; j < TH_FIELDS.length; j++) {
        (function (k) {
          var inp = $("th_" + k);
          if (!inp) return;
          inp.onchange = function () { onThChange(k, inp); };
        })(TH_FIELDS[j].k);
      }
    }

    drawRows();
    drawTh();
    fillDraftInputs();

    var gear = $("btnSet");
    if (gear) gear.addEventListener("click", function () {
      mask.classList.remove("hidden");
      thDraftInit();                    // 以"当前生效值"起稿
      drawRows(); drawTh(); fillDraftInputs();
      // v10.1: 默认值要到 jsx 才拿得全, 改成**第一次打开弹层**才问 ——
      //   面板一打开就自动扫描, 那次 res.th 已经把阈值带回来了, 所以正常路径下这里同步返回,
      //   不再多跑一次 jsx 解析(初版放在启动时, 会和自动扫描各 evalFile 一遍)。
      thEnsure(function () {
        if (!TH_DEF) return;
        thDraftInit(); drawTh(); fillDraftInputs();
      });
    });
    // v10.1: 「确认」= 草稿落盘并关闭(阈值不会边打边存)
    var okSet = $("setOk");
    if (okSet) okSet.addEventListener("click", function () {
      thDraftCommit();
      closeSet();
      showNotice("设置已保存，点「开始检查」生效。");
    });
    // v10.2: 「重置默认」点下**直接重置**(雪糕要求去掉确认弹窗) ——
    //   重置后仍停在设置弹层里, 开关/顺序/阈值一眼看得见全回到默认, 所以不需要再问一句。
    var rstSet = $("setReset");
    if (rstSet) rstSet.addEventListener("click", function () {
      thResetAll();
      drawRows(); drawTh(); fillDraftInputs();
      showNotice("已恢复默认设置，点「开始检查」生效。");
    });
    var clo = $("setClose");
    if (clo) clo.addEventListener("click", closeSet);
    mask.addEventListener("click", function (e) { if (e.target === mask) closeSet(); });
    // v10.2: 重置不再弹确认框 ⇒ 去掉原先"ESC 先让位给确认框"那层判断(设置弹层里不会再压别的弹层)
    document.addEventListener("keydown", function (e) {
      if (e.keyCode === 27 && !mask.classList.contains("hidden")) closeSet();
    });
  }

  // ---------- 主流程 ----------
  // v8.0: keepNotice —— 操作后(转曲/嵌入)触发的刷新必须**保留**本次成功提示。
  //   旧版 showNotice() 之后立刻 run(),而 run() 第一件事就是清 #notice ⇒ 操作反馈一闪即没。
  //   手动点"开始检查"时不传(照旧清掉残留旧提示);提示本身仍由 showNotice 的 5 秒计时器收尾。
  // v8.6: 重入锁 —— 超时只是"前端不再等",ExtendScript 里的扫描仍在跑(单线程,停不下来)。
  //   旧版超时后按钮立即恢复可点,再点会把 runPreflight() 排队再跑一遍(总耗时翻倍、
  //   两次结果先后覆盖渲染)。scanBusy 期间忽略点击,并给一句提示,免得"点了没反应"。
  var scanBusy = false;
  // v8.8: 加 keepError —— 一键操作失败时 execAction 先 showError 再刷新结果，
  //   而 run() 一进来就把 #error 加 hidden ⇒ 失败原因瞬间被抹掉、用户只看到新一轮结果。
  function run(keepNotice, keepError) {
    if (!inCEP()) {
      showError("未检测到 CEP 环境。此页面需在 Illustrator 的扩展面板中运行。");
      return;
    }
    if (scanBusy) { showNotice("正在检查中，请稍候再试。"); return; }
    scanBusy = true;
    $("btnRun").disabled = true;
    $("loading").classList.remove("hidden");
    $("error").classList.add("hidden");
    // v5.2: 顺带清掉残留的旧成功提示,避免绿条挂在新一轮结果上
    // v8.0: 操作后刷新时保留(keepNotice=true)
    if (!keepNotice) $("notice").classList.add("hidden");
    if (!keepError) $("error").classList.add("hidden");
    $("results").innerHTML = "";
    $("foot").innerHTML = "";

    var timedOut = false;
    var timer = setTimeout(function () {
      timedOut = true;
      $("loading").classList.add("hidden");
      // v5.2 修复: 超时后必须恢复按钮,否则"开始检查"永久禁用,只能重开面板
      $("btnRun").disabled = false;
      // v8.1: 措辞改为"仍在继续" —— ExtendScript 无多线程,JSX 一旦开跑就停不下来;
      //   旧版在此宣告超时、回调又 `if (timedOut) return` 把已算完的结果丢掉 ⇒ 白转一场。
      showError("扫描时间较长(超过 " + (BUSY_TIMEOUT_MS / 1000) + " 秒)。文档对象可能较多，后台仍在继续，完成后会自动显示结果。");
    }, BUSY_TIMEOUT_MS);

    SCAN_CK = CARD_CK.slice(0); // v10.0: 记录本轮扫描用的开关快照(渲染占位卡按它判)
    // v10.1: 第 8 参 = 阈值串(空串则由 jsx 用 PF_TH_DEF 默认值)
    execJsx("runPreflight(" + ckArgs() + "," + thArg() + ");", function (data, raw) {
      // v8.1: 不再因超时丢弃迟到的结果 —— 照常渲染,并补一条"耗时较长"提示
      scanBusy = false;   // v8.6: 必须先解锁再分支 —— 下面有提前 return,漏了就锁死面板
      clearTimeout(timer);
      $("btnRun").disabled = false;
      $("loading").classList.add("hidden");
      if (!data || !data.ok) {
        showError((data && data.error) ? data.error
          : ("脚本执行失败。请确认扩展目录中的 jsx/preflight.jsx 存在。返回: " +
             String(raw).substring(0, 120)));
        return;
      }
      try {
        render(data);
        if (timedOut) showNotice("扫描耗时较长，结果已更新。");
      } catch (renderErr) {
        showError("渲染出错 [" + JS_BUILD + "]: " + renderErr.message);
      }
    });
  }

  // v5.2: 报错时顺带隐藏成功提示,避免红绿两个提示框同屏
  function showError(msg) {
    var el = $("error");
    el.textContent = msg;
    el.classList.remove("hidden");
    $("notice").classList.add("hidden");
  }

  // 成功提示(绿色,5 秒后自动消失)
  // v5.2 修复: 计时器存变量,新提示先清掉旧的 —— 否则连续操作时
  // 第一条的计时器会把第二条刚显示的提示提前隐藏
  var noticeTimer = null;
  function showNotice(msg) {
    var el = $("notice");
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("hidden");
    $("error").classList.add("hidden");
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(function () { el.classList.add("hidden"); }, 5000);
  }

  // ---------- 渲染 ----------
  function render(d) {
    lastDocKey = docKey(d); // v5.6: 记录文档指纹,供焦点切换比对
    // v10.1: 阈值随结果一起回传(jsx 的 PF_TH_DEF 是唯一真源) —— 面板只显示, 不保存默认值。
    //   d.th 缺失(极旧的 jsx 缓存)时沿用上次生效值; 都没有则显示 "?" 而不是猜一个数字。
    if (d && d.th) { PF_TH = d.th; if (!TH_DEF) TH_DEF = d.th; }
    // v3.9: 文件名/路径/构建号统一放底部 footer(原顶部信息条已移除)
    var foot = $("foot");
    // v7.2: 去掉常显的"JS构建 <戳>"——平时只是调试信息(版本号顶栏 <span class="ver"> 已可见;
    //       出错时 showError 仍会带上构建号)。footer 只留文件名/路径/符号提示。
    foot.innerHTML =
      '<span class="fname">' + esc(d.docName) + "</span>" +
      (d.docPath ? '<span class="fpath">' + esc(d.docPath) + "</span>" : "") +
      // v4.8: 符号内部扫描提示(仅当文档含符号时)
      (d.symbols && d.symbols.count > 0
        ? '<span class="fbuild">符号 ' + d.symbols.count + " 个" +
          (d.symbols.truncated ? "(仅扫描前 " + thv("scan") + " 个)"
            : (d.symbols.scanned ? "(已扫描内部内容)" : "(内部不可访问)")) + "</span>" : "");

    var cards = [];   // v10.1: 七张卡先各存一格, 最后按 CARD_ORDER 拼接(见函数末尾)
    // v10.0: 按"本轮扫描用的开关快照"判定占位卡(扫描后又改勾选不会拿旧数据当新结果显示)
    var scanCk = SCAN_CK || CARD_CK;

    // ===== 1. 画板 · 出血 · 色彩(v4.0: 色彩模式并入,原第2项移除) =====
    var cmOk = d.colorMode === "CMYK";
    var abRows = "";
    for (var i = 0; i < d.artboards.length; i++) {
      var a = d.artboards[i];
      abRows += "<tr><td>" + esc(a.name) + (i + 1 === d.activeArtboard ? ' <span class="dim">(当前)</span>' : "") +
        '</td><td class="mono">' + bnum(a.w) + " × " + bnum(a.h) + " mm</td></tr>";
    }
    var bleedLevel = "ok";
    function bnum(v) { return (typeof v === "number" && isFinite(v)) ? v : 0; }
    // 出血不足 3mm 的画板名单(v3.4: 多画板文档逐板实测,只列有问题的)
    var bleedHtml = "";
    var bl = (d.bleed && d.bleed.artboards) ? d.bleed : null;
    if (bl && bl.supported) {
      var badAbs = [];
      for (var bi = 0; bi < bl.artboards.length; bi++) {
        var ba = bl.artboards[bi];
        if (ba.insufficient) {
          // v4.5: 列出该画板所有 <3mm 的边(如"上 0mm、下 0mm、右 2.9mm")
          var es = "";
          if (ba.shortEdges && ba.shortEdges.length) {
            es = ba.shortEdges.map(function (e) {
              return e.edge + " " + bnum(e.mm) + "mm";
            }).join("、");
          } else {
            es = (ba.worstEdge ? ba.worstEdge + " " : "最小边 ") + bnum(ba.minMm) + "mm";
          }
          badAbs.push("<li>" + esc(ba.name) + " <span class='dim'>(" + es + ")</span></li>");
        }
      }
      if (badAbs.length) {
        bleedLevel = "warn";
        bleedHtml = '<div>出血不足 ' + thv("bleed") + 'mm 的画板 <b class="warn-t">' + badAbs.length + "</b> 个:</div>" +
          '<ul class="list">' + badAbs.join("") + "</ul>";
      } else {
        bleedHtml = '出血全部 ≥ ' + thv("bleed") + 'mm，<b class="good">达标</b>。';
      }
    } else {
      bleedHtml = '<span class="dim">无法测量</span>';
    }
    // 合并级别: RGB(坏)优先于出血(黄) — bad > warn > ok
    var c1Level = cmOk ? bleedLevel : "bad";
    // v4.0 形态A: 色彩模式永远平铺一行
    var cmHtml = cmOk
      ? '<div>色彩模式: <b class="white">CMYK</b></div>'
      : '<div>色彩模式: <b class="bad-t">RGB</b> · 请转 CMYK (文件 → 文档颜色模式)。</div>';
    // v4.3: 徽标配色由色彩模式自身决定(CMYK=绿 / RGB=红),
    // 左边条颜色才代表整卡状态(出血不足=黄 / RGB=红),两者解耦
    // v5.0: 出血不足时右上角追加"出血不足"徽标(黄底),与色彩徽标并列
    var bleedChip = (bleedLevel === "warn" && badAbs.length > 0)
      ? chip("warn", "出血不足") : "";
    cards[0] = scanCk[0]
      ? card("画板 · 出血 · 色彩", c1Level, cmOk ? "CMYK" : "RGB",
          '<table class="kv">' + abRows + "</table>" + bleedHtml + cmHtml,
          cmOk ? "ok" : "bad", bleedChip)
      : offCard("画板 · 出血 · 色彩");

    // ===== 2. 隐藏对象 =====
    var hd = d.hidden || { layerCount: 0, itemCount: 0, layerNames: [], truncated: false };
    var hdTotal = (hd.layerCount || 0) + (hd.itemCount || 0);
    var hdLevel = hdTotal > 0 ? "warn" : "ok";
    var hdHtml = "";
    if (hdTotal === 0) {
      // v7.1: 去掉冗余的"未发现"——卡片标题已表明检查项,正文直说状态
      hdHtml = '无 <b class="white">隐藏图层 / 隐藏对象</b>。';
    } else {
      var hdHint = (hd.layerNames && hd.layerCount > hd.layerNames.length) ? "仅列出前 " + thv("cap") + " 个" : "";
      // v7.1: 去掉冗余的"发现"
      hdHtml = rowHead('隐藏图层 <b class="warn-t">' + (hd.layerCount || 0) + "</b> 个 · 隐藏对象 <b class='warn-t'>" +
        (hd.itemCount || 0) + "</b> 个。", hdHint);
      if (hd.layerNames && hd.layerNames.length) {
        hdHtml += '<ul class="list">' + hd.layerNames.map(function (n) { return "<li>图层 " + esc(n) + "</li>"; }).join("") + "</ul>";
      }
      // v5.18: "隐藏内容不会出现在导出结果中…"提示灰字按用户要求移除
      // v7.1: 配额提示去掉"对象过多,"前缀(与"仅扫描前 N"语义重复)
      if (hd.truncated) hdHtml += '<div class="dim">(仅扫描前 ' + thv("scan") + ' 个)</div>';
    }
    // v5.20: 有隐藏内容时徽标转红(左边条维持黄色,仅徽标级别改 bad)
    cards[1] = scanCk[1] ? card("隐藏图层 · 对象", hdLevel, hdTotal > 0 ? hdTotal + " 个" : "无", hdHtml, hdTotal > 0 ? "bad" : "ok")
      : offCard("隐藏图层 · 对象");

    // ===== 3. 字体转曲 =====
    // v5.14: 转曲状态与缺失字体是两个独立状态,徽标并列显示(修 bug: 原三目
    // 二选一,"未转曲 8 个"与"缺字体 1"只能显示一个);同卡 1 的双徽标形态
    var fHtml = "", fLevel, fChip, fChipLevel;
    var missingFonts = (d.fonts && d.fonts.missingFonts) ? d.fonts.missingFonts : [];
    var hasMissing = missingFonts.length > 0;
    var missChip = hasMissing ? chip("bad", "缺字体 " + missingFonts.length) : "";
    var tinyChip = "";
    // v5.24: htx 提前计算——全转曲文案与徽标合并计数都要用
    var htx = (d.hiddenText && d.hiddenText.count > 0) ? d.hiddenText : null;
    if (d.fonts.outlined) {
      fLevel = hasMissing ? "bad" : "ok";
      fChip = "已转曲";
      fChipLevel = "ok"; // 转曲状态本身是好的,徽标不跟随卡片红色;缺失风险由并列徽标承担
      // v5.24: 文案改单句"可见文字 已全部转曲，另有 N 个隐藏文字未转曲"
      fHtml = '可见文字 <b class="good">已全部转曲</b>';
      fHtml += htx ? '，另有 <b class="warn-t">' + htx.count + '</b> 个隐藏文字未转曲。' : '。';
      // v5.18: "隐藏图层/对象中的文字未计入…"提示灰字按用户要求移除
      if (hasMissing) fHtml += renderMissingFonts(missingFonts);
    } else {
      fLevel = "bad";
      fChip = "未转曲 " + d.fonts.totalText + " 个";
      fChipLevel = "bad";
      // v7.1: 去掉冗余的"发现"与"涉及"
      var parts = '<b class="warn-t">' + d.fonts.totalText + "</b> 个未转曲文本框";
      if (d.fonts.names.length) {
        // v5.0: 字体名可能超长(罕见),同样单行截断+title 悬停看全名
        // v5.6/F4: 字体种类封顶,超出折叠为"等 N 种"(多字体文档不再拉长卡片)
        // v5.19: 封顶 15→8
        var shown = d.fonts.names.slice(0, 8);
        var extra = d.fonts.names.length - shown.length;
        parts += '，字体:<ul class="list">' + shown.map(function (n) {
          var full = decodeImgName(n);
          return '<li class="trunc" title="' + esc(full) + '">' + esc(truncName(full, 34)) + "</li>";
        }).join("") + (extra > 0 ? '<li class="dim">…等 ' + extra + " 种</li>" : "") + "</ul>";
      }
      if (hasMissing) parts += renderMissingFonts(missingFonts);
      fHtml = parts;
      if (d.fonts.truncated) fHtml += '<div class="dim">(仅扫描前 ' + thv("scan") + ' 个)</div>';
    }
    // v8.8: 混合字体帧提示 —— 这类帧(一帧里多种字体、或字体名读不出)整帧无法判缺，
    //   旧实现一声不响。这是漏报面最大的一类，至少让用户知道有多少帧没被检查。
    var mixF = (d.fonts && d.fonts.mixedFonts) ? d.fonts.mixedFonts : 0;
    if (mixF > 0) fHtml += '<div class="dim">另有 <b class="warn-t">' + mixF +
      '</b> 个文本框含多种字体(或字体名读不出)，未参与缺失字体检测。</div>';

    // v5.15: 极小字号,并入字体卡底部
    // v10.2: 合并为一档 —— 只有"小于阈值"这一条判定, 且直接标红(原先 <6 黄 / <5 红两级)。
    //   ⇒ 掉 badCount 与"其中 N 处小于 5pt"那一行; 徽标也从"有 <5pt 才红"变成一律红。
    var tiny = (d.tiny && d.tiny.count > 0) ? d.tiny : null;
    if (tiny) {
      // v5.17: 去掉小标题与建议灰字,只留计数与样本
      // v7.0: 截断提示回到标题行右侧(同一行、右对齐、不带括号)
      var tinyHint = (tiny.count > tiny.samples.length) ? "仅列出前 " + thv("cap") + " 处" : "";
      // v7.1: 去掉冗余的"发现"与"的文字"
      fHtml += rowHead('<b class="bad-t">' + tiny.count + "</b> 处字号小于 " + thv("tiny") + "pt:", tinyHint) +
        '<ul class="list">' + tiny.samples.map(function (s) {
          return '<li class="trunc" title="' + esc(s.t) + '">' + esc(s.t) + " — " + s.pt + "pt</li>";
        }).join("") + "</ul>";
      tinyChip = chip("bad", "小字号 " + tiny.count);
      fLevel = "bad";
    }
    // v5.21: 隐藏文字统计(树遍历只扫可见,隐藏的单独列出;字体名已并入缺失检测)
    // v5.22: 文案理顺——隐藏文字必然未转曲(转曲了就不是文本框),直接说明
    // v5.24: 不再单列"隐文 N"徽标(并入下方合并计数);未转曲分支保留"勾选显示全部"引导
    if (htx && !d.fonts.outlined) {
      fHtml += '另有 <b class="warn-t">' + htx.count + "</b> 个隐藏文字未转曲" +
        (htx.missingCount > 0 ? "(缺字体 <b class='bad-t'>" + htx.missingCount + "</b> 个)" : "") +
        '，勾选"显示全部"可一并转曲。';
      if (htx.truncated) fHtml += '<div class="dim">(仅统计前 500 个)</div>';
    }
    // v5.24: 徽标合并计数——可见未转曲 + 隐藏文字合并为一个"未转曲 N 个"
    var totalOutline = d.fonts.totalText + (htx ? htx.count : 0);
    if (totalOutline > 0) {
      fChip = "未转曲 " + totalOutline + " 个";
      fChipLevel = "bad";
      fLevel = "bad";
    }
    // 一键转曲区(有未转曲文本框时显示)
    // 默认勾选"显示""解锁",此时转曲前会先解除隐藏/锁定(含图层与对象);
    // 取消某一项则保持该类状态不变,对应文字跳过不转
    // v5.22: 可见文字全转曲但存在隐藏文字时,按钮照常显示(否则提示勾选转曲却没有按钮)
    if (d.fonts.totalText > 0 || htx) {
      fHtml += '<div class="action-row">' +
        '<div class="chk-row">' +
        '<label class="chk" title="显示隐藏图层，并取消对象级隐藏(Ctrl+3)"><input type="checkbox" id="chkShowAll"> 显示全部</label>' +
        '<label class="chk" title="解锁图层，并解除对象级锁定(Ctrl+2)与锁定组"><input type="checkbox" id="chkUnlockAll"> 解锁全部</label>' +
        '</div>' +
        '<button class="btn-action" id="btnOutline">一键转曲</button>' +
        '</div>';
    }
    cards[2] = scanCk[2] ? card("字体 · 转曲", fLevel, fChip, fHtml, fChipLevel, missChip + tinyChip)
      : offCard("字体 · 转曲");

    // ===== 4. 图片嵌入 =====
    // v5.15: 缺失链接——源文件不存在的链接图计数、清单标红、徽标转"缺失 N 张"
    var missN = d.images.missingCount || 0;
    var iLevel = d.images.linkedCount > 0 ? "bad" : "ok";
    var iHtml = "嵌入图片: <b>" + d.images.embeddedCount + "</b> 张 · 链接图片: <b class='" +
      (d.images.linkedCount ? "bad-t" : "good") + "'>" + d.images.linkedCount + "</b> 张" +
      (missN ? " · 缺失链接: <b class='bad-t'>" + missN + "</b> 张" : "");
    if (d.images.linked.length) {
      // v7.0: 截断提示与小标题同一行、右对齐
      var iHint = (d.images.linkedCount > d.images.linked.length) ? "仅列出前 " + thv("cap") + " 张" : "";
      // v7.1: 小标题去掉与"链接图片"重复的括注(上方汇总行已有"链接图片: N 张")
      iHtml += rowHead('<span class="section-sub">未嵌入:</span>', iHint);
      // v5.0: 链接文件名(name/file 路径)可能超长或 URL 编码,解码+单行截断
      // v5.19: 两行并一行——只显示文件名,完整路径移到悬停 title,清单高度减半
      iHtml += '<ul class="list">' + d.images.linked.map(function (it) {
        var fn = decodeImgName(it.name);
        var ff = decodeImgName(it.file);
        return '<li class="trunc" title="' + esc(ff) + '">' + (it.missing ? '<span class="warn-tri">⚠</span> ' : "") +
          esc(truncName(fn, 40)) + (it.missing ? ' <span class="bad-t">源文件不存在</span>' : "") + "</li>";
      }).join("") + "</ul>";
      // v6.9: 样本截断提示按用户要求删除(truncated 仍代表扫描配额上限,提示保留)
      if (d.images.truncated) iHtml += '<div class="dim">(仅扫描前 ' + thv("scan") + ' 张)</div>';
    }
    // 一键嵌入按钮
    if (d.images.linkedCount > 0) {
      iHtml += '<div class="action-row"><button class="btn-action" id="btnEmbed">一键嵌入</button></div>';
    }
    cards[3] = scanCk[3] ? card("图片嵌入", iLevel, missN > 0 ? ("缺失 " + missN + " 张") : (d.images.linkedCount > 0 ? "有链接图" : "全部嵌入"), iHtml)
      : offCard("图片嵌入");

    // ===== 5. 图片分辨率 =====
    var rs = d.resolution || { total: 0, lowCount: 0, okCount: 0, samples: [], truncated: false };
    var rsLevel = rs.lowCount > 0 ? "warn" : "ok";
    var rsHtml = "";
    if (rs.total === 0) {
      rsHtml = '文档<span class="dim">无位图</span>。';
    } else {
      // v7.0: 截断提示与汇总行同一行、右对齐
      var rsHint = (rs.lowCount > rs.samples.length) ? "仅列出前 " + thv("cap") + " 张" : "";
      rsHtml = rowHead("共 <b>" + rs.total + "</b> 张图片 · 达标 <b class='good'>" + rs.okCount + "</b> 张 · <" + thv("reso") + "ppi <b class='" +
        (rs.lowCount ? "warn-t" : "") + "'>" + rs.lowCount + "</b> 张", rsHint);
      if (rs.samples.length) {
        // v5.0: 文件名先 URL 解码再截断显示;完整名放 title(悬停可查)
        rsHtml += '<ul class="list">' + rs.samples.map(function (s) {
          var full = decodeImgName(s.name);
          var shown = truncName(full, 34);
          // v8.2: jsx 的 ppiOf 返回**原值**(带小数,为的是卡 300 阈值时不误判),显示时统一取整
          //   —— 与油墨 total 同一口径(jsx 传原值 / 前端 Math.round)。
          //   旧版(≤v8.1)这里直接输出 s.ppi ⇒ 面板上出现 "170.776863599299 ppi" 这种长小数。
          var ppiShow = (typeof s.ppi === "number" && isFinite(s.ppi)) ? Math.round(s.ppi) : s.ppi;
          return '<li class="trunc" title="' + esc(full) + '">' + esc(shown) + " — " + ppiShow + " ppi</li>";
        }).join("") + "</ul>";
      }
      // v6.9: 样本截断提示按用户要求删除
      if (rs.truncated) rsHtml += '<div class="dim">(仅扫描前 ' + thv("scan") + ' 张)</div>';
      // v5.18: "低于 300ppi…建议更换高清图源"提示灰字按用户要求移除
    }
    cards[4] = scanCk[4] ? card("图片分辨率", rsLevel, rs.lowCount > 0 ? "有 " + rs.lowCount + " 张偏低" : "全部达标", rsHtml)
      : offCard("图片分辨率");

    // ===== 6. 油墨 · 描边粗细 (v6.2: 方案 B —— 按"问题类型"分块,标题统一) =====
    var bt = d.black.text, bp = d.black.path;
    var bHtml = "";
    var bLevel = "ok";
    var bChip = "通过";
    var totalBad = bt.bad + bp.bad;
    var totalWarn = bt.warn + bp.warn;
    var light = d.black.light || { count: 0, samples: [] };
    var lightN = light.count || 0;
    var thinN = bp.thin || 0;
    // v8.3: 叠印(文字+图形共一池)—— 计数只走"分块 + extraChip",**不并入主徽标计数**
    var ovp = d.black.overprint || { count: 0, samples: [] };
    var ovpN = ovp.count || 0;

    // v6.3: CMYK 四色分量左对齐——C/M/Y/K 各列补齐到 4 字符(最多 3 位数),
    //   填充用不换行空格 U+00A0(HTML 会把连续普通空格折叠成一个,补不齐)
    var NBSP = "\u00A0";
    var LIGHT_CH = thv("light");   // v10.1: 与 jsx PF_TH_DEF.light 同口径(前端不再写死该阈值)
    function padInkDesc(desc) {
      var m = /^C(\d+) M(\d+) Y(\d+) K(\d+)$/.exec(String(desc == null ? "" : desc));
      if (!m) return desc;   // 非标准四色(Gray 的 "K50" / RGB / 专色)原样不动
      var out = [];
      for (var i = 1; i <= 4; i++) {
        var f = "CMYK".charAt(i - 1) + m[i];
        while (f.length < 4) f += NBSP;
        out.push(f);
      }
      return out.join(" ");
    }
    // v7.6: 把四色串里"值在 1~4"的分量单独包一层 <b class="ink-w">,面板用白色显示
    //   —— 直接指出是哪一个色版太浅(如 C0 M0 Y0 K2 只有 K2 是白的;
    //      C50 M50 Y2 K100 里只有 Y2 是白的)。
    //   与 padInkDesc 同一套正则、同一套定宽补齐 ⇒ 分量字符宽度不变,行内 "=" 列对齐不受影响。
    //   0(该色版不用) 与 ≥5(正常) 保持常规灰;非标准色(Gray/RGB/专色)原样转义。
    function markLightChannels(desc) {
      var m = /^C(\d+) M(\d+) Y(\d+) K(\d+)$/.exec(String(desc == null ? "" : desc));
      if (!m) return esc(desc);
      var out = [];
      for (var i = 1; i <= 4; i++) {
        var f = "CMYK".charAt(i - 1) + m[i];
        var pad = "";
        while ((f + pad).length < 4) pad += NBSP;
        var v = parseInt(m[i], 10);
        out.push((v > 0 && v < LIGHT_CH) ? '<b class="ink-w">' + f + "</b>" + pad : f + pad);
      }
      return out.join(" ");
    }
    // 样本行: [来源] 名称 填充/描边 内容 [= 总量] [×n]
    // v6.2: jsx 已把样本结构化;这里保留字符串兜底(防旧 jsx 缓存)
    // v7.6: 第 3 参 markLight=true 时走 markLightChannels(把过浅分量标白),目前仅"色版1~4%"块开启。
    // v7.7: 第 4 参 n>1 时行尾追加 " ×n"(同源同色合并计数,与描边块 "0.09mm ×3" 同款)。
    function inkLi(srcLabel, s, markLight, n) {
      if (typeof s === "string") s = { name: "", where: "", desc: s };
      var head = "[" + srcLabel + "] " + (s.name ? s.name + " " : "") +
                 (s.where ? s.where + " " : "");
      var padded = padInkDesc(s.desc);
      // v8.0: jsx 的分档改用 CMYK 原值求和(带小数),这里显示时统一四舍五入回整数,
      //       ⇒ 面板上仍是 "= 308" 这种整数,与 desc 里的分量口径一致
      var tail = s.total !== undefined ? " = " + Math.round(s.total) : "";
      var cnt = (n && n > 1) ? " ×" + n : "";
      return '<li class="trunc" title="' + esc(head + padded + tail + cnt) + '">' +
             esc(head) + (markLight ? markLightChannels(s.desc) : esc(padded)) + esc(tail) + esc(cnt) + "</li>";
    }
    // 问题块标题: 名称 N 处
    // v6.4: 改"数字染色"——标题文字取常规色,只有计数 N 上黄/红(与全站规则一致)
    // v7.0: 第 4 参 hint 为样本截断提示,渲染在标题同一行最右(不带括号)
    function inkBlock(name, n, lvl, hint) {
      return '<div class="ink-block"><span class="row-t">' + esc(name) + ' <b class="' +
        (lvl === "bad" ? "bad-t" : "warn-t") + '">' + n + "</b> 处</span>" +
        (hint ? '<span class="row-h">' + esc(hint) + "</span>" : "") + "</div>";
    }
    // v7.7: 相同样本合并成一行(行尾 " ×n"),再截到前 cap 组。
    // v7.8: jsx 已改成"按不同值收"并在样本上带 n(= 文档全量出现次数)。因此:
    //   ① 入池样本天然互不相同 ⇒ 分组基本是 1 条 1 组,cap 不再吃掉不同的色值(能填满 5 行);
    //   ② 计数**优先取 s.n**(全量真值,不受采样池限制);旧 jsx 缓存里没有 n 时才按 1 条累计。
    // v7.9: 有 total 的块(油墨总量两块)先按 total 从高到低全局排序再截断 → 面板上数字单调递减。
    //   rows: [{l:"文字"|"图形", s:样本, markLight:bool}]
    //   分组键 = 来源标签 + 名称 + 填充/描边 + 色值 + 总量 —— 只有"完全一样"才合并;
    //   不跨 [文字]/[图形] 合并,也不因名称不同而强行并成一条。
    //   返回 {html, shown}: shown = 屏幕上实际体现了多少"原始样本条数"(供截断提示判断);
    //   合并后 5 行可涵盖 >5 条原始样本,故提示条件须与 shown 比,不能与"行数"比。
    function inkRows(rows, cap) {
      var order = [], map = {}, i, r, s, key, g;
      for (i = 0; i < rows.length; i++) {
        r = rows[i]; s = r.s;
        key = r.l + "\u0001" + (s.name || "") + "\u0001" + (s.where || "") +
              "\u0001" + s.desc + "\u0001" + (s.total === undefined ? "" : s.total);
        if (!map[key]) { map[key] = { l: r.l, s: s, ml: !!r.markLight, n: 0 }; order.push(key); }
        map[key].n += (s.n > 0 ? s.n : 1);   // 有 n 用 n(全量真值);无 n(旧 jsx)按 1 条累计
      }
      // v7.9: 油墨总量块按"从高到低"展示。jsx 里 文字/图形 是两个独立的池(各自 top-5),
      //   拼起来跨来源就不单调了 —— 这里合并后再全局排一次,保证数字真正递减;
      //   色版1~4% 块的样本没有 total,比较值为 -Infinity ⇒ 稳定排序保持原顺序,不受影响。
      order.sort(function (a, b) {
        var ta = map[a].s.total, tb = map[b].s.total;
        if (ta === undefined) ta = -Infinity;
        if (tb === undefined) tb = -Infinity;
        // v8.7: 两侧都无 total 时会算出 -Infinity - (-Infinity) = NaN, 而比较器返回 NaN
        //   属规范未定义行为(当前只是 V8 恰好把它当作 0 才保住稳定序) —— 显式返回 0。
        if (ta === tb) return 0;
        return tb - ta;
      });
      var use = (cap && order.length > cap) ? order.slice(0, cap) : order;
      var out = '<ul class="list">', shown = 0;
      for (i = 0; i < use.length; i++) {
        g = map[use[i]];
        shown += g.n;
        out += inkLi(g.l, g.s, g.ml, g.n);
      }
      out += "</ul>";
      return { html: out, shown: shown };
    }
    // v6.7: 合并"文字样本 + 图形样本"为一张表(文字在前),分组合并与截断统一交给 inkRows。
    //   此前两类样本各自拼接、最多 10 行,但截断提示只写了"前 5",与实际不符;现按用户口径真截到前 5 组。
    function inkMerge(a, b, cap) {
      var rows = [], i;
      for (i = 0; i < (a || []).length; i++) rows.push({ l: "文字", s: a[i] });
      for (i = 0; i < (b || []).length; i++) rows.push({ l: "图形", s: b[i] });
      return inkRows(rows, cap);
    }

    var blocks = "";
    // 块 1: 油墨总量>300(红) —— 文字 + 图形样本合并成一张表,按来源标 [文字]/[图形]
    if (totalBad > 0) {
      var badRows = inkMerge(bt.badSamples, bp.badSamples, thv("cap")); // v6.7/v10.1: 合并后统一截到前 cap 条
      blocks += inkBlock("油墨总量>" + thv("inkWarn"), totalBad, "bad", totalBad > badRows.shown ? "仅列出前 " + thv("cap") + " 处" : "");
      blocks += badRows.html;
    }
    // 块 2: 油墨总量 220~300(黄)
    if (totalWarn > 0) {
      var warnRows = inkMerge(bt.warnSamples, bp.warnSamples, thv("cap")); // v6.7/v10.1: 合并后统一截到前 cap 条
      blocks += inkBlock("油墨总量" + thv("inkOk") + "~" + thv("inkWarn"), totalWarn, "warn", totalWarn > warnRows.shown ? "仅列出前 " + thv("cap") + " 处" : "");
      blocks += warnRows.html;
    }
    // 块 3: 色版 1~4%(黄,CMYK 某分量) —— 用户指定排在描边块之前
    if (lightN > 0) {
      var lightRows = (light.samples || []).map(function (s) {
        return { l: s.src === "text" ? "文字" : "图形", s: s, markLight: true };  // v7.6: 过浅分量标白
      });
      var lightOut = inkRows(lightRows, thv("cap"));   // v7.7/v10.1: 相同色值合并为 " ×n"
      blocks += inkBlock("色版1~" + (isFinite(LIGHT_CH) ? LIGHT_CH - 1 : "?") + "%", lightN, "warn", lightN > lightOut.shown ? "仅列出前 " + thv("cap") + " 处" : "");
      blocks += lightOut.html;
    }
    // v9.4: 原"块 4 叠印"已拆成独立卡片(见下方"7. 叠印"), 卡片顺序保持"油墨 -> 叠印"。
    // 块 4: 描边<0.1mm(黄,仅图形) —— 相同宽度合并为 "描边 0.09mm ×3"
    // v7.8: jsx 已按 mm 去重并带 n(全量次数);这里仍按 mm 分组(旧 jsx 兜底),计数优先取 s.n
    if (thinN > 0) {
      blocks += inkBlock("描边<" + thv("thin") + "mm", thinN, "warn", thinN > bp.thinSamples.length ? "仅列出前 " + thv("cap") + " 处" : "");
      var tOrder = [], tMap = {};
      (bp.thinSamples || []).forEach(function (s) {
        var k = String(s.mm);
        if (!tMap[k]) { tMap[k] = { mm: s.mm, n: 0, names: [] }; tOrder.push(k); }
        tMap[k].n += (s.n > 0 ? s.n : 1);   // 有 n 用 n(全量真值);无 n(旧 jsx)按 1 条累计
        if (s.name) tMap[k].names.push(s.name);
      });
      blocks += '<ul class="list">' + tOrder.map(function (k) {
        var g = tMap[k];
        var txt = "[图形] " + (g.names.length ? g.names.join(" ") + " " : "") +
                  "描边 " + g.mm + "mm" + (g.n > 1 ? " ×" + g.n : "");
        return '<li class="trunc" title="' + esc(txt) + '">' + esc(txt) + "</li>";
      }).join("") + "</ul>";
    }

    // 汇总行(灰):正常计数 + RGB/专色/混合色
    // v8.8: 一律 ||0 —— 旧 jsx 缓存里 black.path 没有 mixed 键，直接相加得 NaN，
    //   而 if(NaN) 恒假 ⇒ 「混合色」这段从上线起就没显示过。other = 渐变/图案。
    var rgbN = (bt.rgb || 0) + (bp.rgb || 0), spotN = (bt.spot || 0) + (bp.spot || 0),
        mixedN = (bt.mixed || 0) + (bp.mixed || 0), otherN = (bt.other || 0) + (bp.other || 0);
    var rest = "正常:文字 <b class='ink-n'>" + bt.ok + "</b> · 图形 <b class='ink-n'>" + bp.ok + "</b>";
    if (rgbN) rest += " · RGB <b class='warn-t'>" + rgbN + "</b>";
    if (spotN) rest += " · 专色 <b>" + spotN + "</b>";
    if (mixedN) rest += " · 混合色 <b>" + mixedN + "</b>";
    if (otherN) rest += " · 渐变/图案 <b>" + otherN + "</b>";
    if (bp.truncated) rest += " · 仅扫描前 " + thv("scan") + " 个";
    blocks += '<div class="ink-rest">' + rest + "</div>";
    bHtml = blocks;

    // 徽标: 主徽标只管"油墨总量 + 描边<0.1mm + 色版1~4%"(描边/色版并入"注意 N 处"黄标)
    var totalWarnAll = totalWarn + thinN + lightN;
    if (totalBad > 0) { bLevel = "bad"; bChip = "超标 " + totalBad + " 处"; }
    else if (totalWarnAll > 0) { bLevel = "warn"; bChip = "注意 " + totalWarnAll + " 处"; }
    // v9.4: 叠印已独立成卡(下一张),这里不再挂 extraChip,标题也去掉"叠印"二字
    cards[5] = scanCk[5] ? card("油墨 · 描边粗细", bLevel, bChip, bHtml) : offCard("油墨 · 描边粗细");

    // ===== 7. 叠印 (v9.4: 依雪糕要求从油墨卡拆出, 独立成卡) =====
    //   ⚠ 旧 jsx(缓存里没有 white/text/path 键)一律 ||0 —— 让 undefined 参与算术会得 NaN、
    //     而 if(NaN) 恒假 ⇒ 整段静默不显示(v8.8 的 black.path.mixed 就是这么栽的)。
    var ovpW = ovp.white || 0, ovpTx = ovp.text || 0, ovpPth = ovp.path || 0;
    // v9.6: 其中落在锁定对象/图层/锁定组里的处数(旧 jsx 无此键 ⇒ ||0, 否则 if(undefined>0) 恒假、静默不显示)
    var ovpLocked = ovp.locked || 0;
    var oHtml = "", oLevel = "ok", oChip = "无叠印";
    if (ovpN > 0) {
      oLevel = "bad";
      oChip = "叠印 " + ovpN + " 处";
      var oRows = (ovp.samples || []).map(function (s) {
        return { l: s.src === "text" ? "文字" : "图形", s: s };
      });
      var oOut = inkRows(oRows, thv("cap"));
      // v9.7: 叠印汇总 —— 锁定 / 白色一并进标题行(原先各占一行: 一行灰字 + 一行正文),
      //   两段解释改挂 title 悬停提示 ⇒ 卡片净省 2 行, 且数字集中在一处更好对账。
      oHtml += rowHead("共 <b class='bad-t'>" + ovpN + "</b> 处叠印" +
        ((ovpTx || ovpPth) ? " · 文字 <b>" + ovpTx + "</b> · 图形 <b>" + ovpPth + "</b>" : "") +
        (ovpLocked > 0 ? ' · <span title="清除叠印时锁定对象默认跳过；勾选「解锁全部」可一并清除">锁定 <b class="warn-t">' + ovpLocked + "</b></span>" : "") +
        (ovpW > 0 ? ' · <span title="白色叠印后不再遮挡下层，印出来会花">白色 <b class="bad-t">' + ovpW + "</b></span>" : ""),
        ovpN > oOut.shown ? "仅列出前 " + thv("cap") + " 处" : "");
      oHtml += oOut.html;
      // v9.7: 「其中白色叠印 N 处(…印出来会花)。」整行删除 —— 白色已并入上方标题行,
      //   危害说明移入该段的 title, 不再占用卡片高度。
      // v9.4: 有叠印才给按钮(无叠印时按一下纯属多余)
      // v9.5: 按钮前加「解锁全部」复选框(默认不勾) —— 勾选后清除前先解锁, 锁定对象的
      //   叠印一并清除; 隐藏对象始终跳过。它只服务这个按钮, 故与按钮同生共死。
      oHtml += '<div class="action-row">' +
        '<div class="chk-row">' +
        '<label class="chk" title="清除前先解锁图层、对象级锁定(Ctrl+2)与锁定组；隐藏对象一律不碰"><input type="checkbox" id="chkOvpUnlock"> 解锁全部</label>' +
        '</div>' +
        '<button class="btn-action" id="btnOvpClear">一键清除叠印</button>' +
        '</div>';
    } else {
      oHtml = '文档<b class="good">无叠印</b>。';
    }
    // v9.5: 如实标注检查范围 —— 隐藏对象 / 图层不进叠印统计(读它们得先显示, 而检查是只读的)
    // v9.7: 删掉独立的「其中锁定对象 N 处…」灰字行 —— 锁定处数已并入上方标题行,
    //   "勾选「解锁全部」可一并清除"移作该段的 title 悬停提示(卡片省一行)。
    oHtml += '<div class="dim">隐藏对象与图层不参与叠印检查。</div>';
    // 副徽标(第 6 参): 只有真出现白色叠印才挂,文案带数量便于一眼定量
    //   v9.7: 原先那行「其中白色叠印 N 处(…印出来会花)」已删除, 危害说明改挂 title
    cards[6] = scanCk[6]
      ? card("叠印", oLevel, oChip, oHtml, null,
          ovpW > 0 ? '<span class="chip bad" title="白色叠印后不再遮挡下层，印出来会花">白叠印 ' + ovpW + " 处</span>" : "")
      : offCard("叠印");

    // v10.1: 按 CARD_ORDER 拼接 —— 卡片上下顺序可在「设置」里拖动调整。
    //   ⚠ 只影响渲染顺序; 传给 jsx 的七卡开关仍按固定卡序(ckArgs()), 否则 c1..c7 会错位。
    var html = "", _oi;
    for (_oi = 0; _oi < CARD_ORDER.length; _oi++) html += (cards[CARD_ORDER[_oi]] || "");
    $("results").innerHTML = html;

    // 复选框状态回填 + 变更保存(面板重绘后保持用户选择)
    // v5.6: 变更同步写入 localStorage,跨面板重开也保持
    var cs = $("chkShowAll"), cu = $("chkUnlockAll");
    if (cs) {
      cs.checked = CHK_SHOW;
      cs.onchange = function () {
        CHK_SHOW = cs.checked;
        try { localStorage.setItem("pf_chkShow", cs.checked ? "1" : "0"); } catch (e) {}
      };
    }
    if (cu) {
      cu.checked = CHK_UNLOCK;
      cu.onchange = function () {
        CHK_UNLOCK = cu.checked;
        try { localStorage.setItem("pf_chkUnlock", cu.checked ? "1" : "0"); } catch (e) {}
      };
    }
    // v9.5: 叠印卡「解锁全部」回填 + 持久化(与转曲卡两个复选框同一套写法)
    var co = $("chkOvpUnlock");
    if (co) {
      co.checked = CHK_OVP_UNLOCK;
      co.onchange = function () {
        CHK_OVP_UNLOCK = co.checked;
        try { localStorage.setItem("pf_chkOvpUnlock", co.checked ? "1" : "0"); } catch (e) {}
      };
    }
  }

  // ---------- 执行 JSX 操作并刷新 ----------
  // v5.6/F7: 执行期间禁用按钮+显示 loading,防连点排队重复执行
  var actionBusy = false;
  function execAction(jsxFns, successMsg) {
    if (actionBusy) return;
    actionBusy = true;
    $("btnRun").disabled = true;
    $("loading").classList.remove("hidden");
    var btns = document.querySelectorAll(".btn-action");
    for (var bi = 0; bi < btns.length; bi++) btns[bi].disabled = true;
    // v8.6: 大 PDF 栅格化等操作可能远超 20 秒,期间 loading 一直转却毫无反馈。
    //   复用 run() 的超时口径: 20 秒补一句"仍在继续";操作本身不中断
    //   (ExtendScript 无多线程,停不下来),回调到达时清掉计时器。
    var actTimer = setTimeout(function () {
      showNotice("操作耗时较长，后台仍在继续，完成后会自动刷新结果。");
    }, BUSY_TIMEOUT_MS);
    execJsx(jsxFns, function (data, raw) {
      clearTimeout(actTimer);
      actionBusy = false;
      var actFailed = !(data && data.ok);   // v8.8: 失败路径要保留错误提示(见下方 run 调用)
      if (!actFailed) {
        // v7.1: 不再"成功词 + 详情"两句并排(原为"转曲完成。 已转曲 5 个文本框。")——
        // 有 jsx 详情就只用详情,没有才退回成功词
        showNotice(data.message || successMsg || "操作完成");
      } else {
        showError((data && data.error) ? data.error
          : ("操作失败。返回: " + String(raw).substring(0, 120)));
      }
      run(true, actFailed); // v8.8: 失败时传 keepError，避免刚弹的红条被本轮 run() 抹掉；v8.0: 刷新检查结果(保留本次操作的成功提示;内部会恢复按钮、隐藏 loading)
    });
  }

  // 转曲前的图层处理选项(默认勾选;面板重绘后状态保留)
  // v5.6: 状态持久化到 localStorage,重开面板保持上次选择(读取失败保持默认)
  var CHK_SHOW = true, CHK_UNLOCK = true;
  // v9.5: 叠印卡「解锁全部」—— 默认**不勾**(维持 v9.4 的"不动图层状态"默认), 状态同样持久化
  var CHK_OVP_UNLOCK = false;
  try {
    if (localStorage.getItem("pf_chkShow") !== null) CHK_SHOW = localStorage.getItem("pf_chkShow") === "1";
    if (localStorage.getItem("pf_chkUnlock") !== null) CHK_UNLOCK = localStorage.getItem("pf_chkUnlock") === "1";
    if (localStorage.getItem("pf_chkOvpUnlock") !== null) CHK_OVP_UNLOCK = localStorage.getItem("pf_chkOvpUnlock") === "1";
  } catch (eLS) {}

  // v5.6/体验①: 上次结果的文档指纹;面板获得焦点时比对,切换了文档就自动重扫
  var lastDocKey = null;
  function docKey(d) { return d.docName + "|" + d.docPath; }
  // v8.1: 原 lastData(保存最近检查结果供确认框读 linkedAll/linkedHidden)已移除 ——
  //   嵌入范围改为点"嵌入"时调 pfLinkScope() 现取(见 onEmbed),不再依赖上次检查结果。

  // 自定义确认框(替代原生 confirm: 原生无法改配色/按钮文字/字号)
  // 黑色主题 + 中文大按钮; 回车=确定, Esc=取消
  // v9.9: 第三参 title —— 标题按场景给(确认转曲 / 确认嵌入 / 确认清除叠印), 缺省仍为"提示"
  function customConfirm(msg, onOk, title) {
    var mask = $("modalMask"), msgEl = $("modalMsg");
    var titleEl = $("modalTitle");
    var okBtn = $("modalOk"), cancelBtn = $("modalCancel");
    if (!mask || !msgEl || !okBtn || !cancelBtn) { if (onOk) onOk(); return; }
    if (titleEl) titleEl.textContent = title || "提示";
    msgEl.textContent = msg;
    mask.classList.remove("hidden");
    function done(ok) {
      mask.classList.add("hidden");
      okBtn.onclick = null; cancelBtn.onclick = null;
      document.removeEventListener("keydown", onKey, true);
      if (ok && onOk) onOk();
    }
    function onKey(e) {
      if (e.key === "Enter") done(true);
      else if (e.key === "Escape") done(false);
    }
    okBtn.onclick = function () { done(true); };
    cancelBtn.onclick = function () { done(false); };
    document.addEventListener("keydown", onKey, true);
  }

  function onOutline() {
    var showAll = $("chkShowAll") ? $("chkShowAll").checked : CHK_SHOW;
    var unlockAll = $("chkUnlockAll") ? $("chkUnlockAll").checked : CHK_UNLOCK;
    var action = "";
    if (unlockAll && showAll) action = "将解锁全部图层与锁定对象(Ctrl+2/锁定组)，并显示隐藏图层与隐藏对象(Ctrl+3)，然后转曲文档中全部文字。";
    else if (showAll) action = "将显示全部图层与隐藏对象(不解锁)，然后转曲其中可见且未锁定的文字。";
    else if (unlockAll) action = "将解锁全部图层与锁定对象(Ctrl+2/锁定组)，不改动显示状态，然后转曲其中可见的文字。";
    else action = "将只转曲本就可见且未锁定的文字，不改动图层与对象状态。";
    customConfirm(action + "\n此操作不可撤销，确定继续?", function () {
      execAction("pfOutlineAll(" + showAll + ", " + unlockAll + ");", "转曲完成。");
    }, "确认转曲");
  }
  // v8.1: 嵌入范围改为"点嵌入时按需统计" —— 旧版读本轮检查结果里的 linkedAll/linkedHidden,
  //   而那两个数是每轮检查都做一遍的全文档 placedItems 遍历,只为这个确认框服务(用户极少点)。
  //   现改为点按钮时现调 pfLinkScope();取数失败退回泛化文案,绝不阻断嵌入。
  var embedProbing = false; // 防连点:取数期间再点直接忽略
  function onEmbed() {
    if (embedProbing) return;
    embedProbing = true;
    execJsx("pfLinkScope();", function (data) {
      embedProbing = false;
      var nAll = (data && data.ok && data.all) || 0;
      var nHid = (data && data.ok && data.hidden) || 0;
      // v8.0: ① 如实说明范围 —— 嵌入走文档级"全部链接图"(**含隐藏对象**),与检查卡的可见口径不同,
      //          旧文案只说"所有链接图片",用户看到的"链接图片 N 张"与实际嵌入数对不上;
      //       ② v9.9: 矢量链接已不再栅格化(改走原生 embed) ⇒ 旧"会按 300dpi 栅格化为位图"
      //          的预警一并删除。嵌入口径**跟随 Illustrator 上次用的导入选项**(psd/tif 走
      //          photoshopFileOptions, 拼合为单个图像 ⇔ 将图层转换为对象),
      //          所以只说明"跟随上次设置"即可, 不再逐类型承诺可编辑性 / 体积。
      //          ⚠ 这里写 Illustrator 而非"AI": 同一句里 AI 还代表 .ai 格式, 会歧义。
      var scope = nAll > 0
        ? ("将嵌入文档中全部 " + nAll + " 张链接图" +
           (nHid > 0 ? "(其中 " + nHid + " 张为隐藏对象)" : "") + "。")
        : "将嵌入文档中所有链接图。";
      customConfirm(scope +
        "\nPSD / TIF / PDF / AI 均跟随你在 Illustrator 里上次「嵌入」的导入选项。" +
        "\n此操作不可撤销，确定继续?", function () {
        execAction("pfEmbedAll();", "嵌入完成。");
      }, "确认嵌入");
    });
  }

  // v9.4: 一键清除叠印 —— 只关叠印属性,不动图层/对象状态;锁定与隐藏的跳过并如实报数。
  // v9.5: 加「解锁全部」复选框 —— 勾选后先解锁再清(锁定对象也能清), 隐藏对象始终不碰。
  //   ⚠ 文案没说"不可撤销": 转曲/嵌入是真的不可逆,而这个只是翻属性,撤销粒度我没验证过,
  //     不写死。要统一成"不可撤销"随时说。
  // v9.9: 文案统一 —— 全角（）→ 半角()、"(Ctrl+2 / 锁定组)"→"(Ctrl+2/锁定组)"(与转曲弹窗一致),
  //   并补第三参标题"确认清除叠印"。
  function onOvpClear() {
    var uAll = $("chkOvpUnlock") ? $("chkOvpUnlock").checked : CHK_OVP_UNLOCK;
    customConfirm("将关闭文档中全部叠印(文字与图形、填充与描边)。" +
      (uAll ? "\n已勾选「解锁全部」：会先解锁全部图层与锁定对象(Ctrl+2/锁定组)，其叠印一并清除。"
            : "\n未勾选「解锁全部」：锁定或隐藏的对象会跳过，其状态一律不改动。") +
      "\n隐藏对象与图层不参与叠印检查，本操作也不会改动它们。" +
      "\n此操作会直接修改文档，确定继续?", function () {
      execAction("pfClearOverprint(" + uAll + ");", "清除叠印完成。");
    }, "确认清除叠印");
  }

  // 事件委托: 处理动态生成的按钮
  document.addEventListener("click", function (e) {
    var t = e.target;
    if (t && t.id === "btnOutline") onOutline();
    else if (t && t.id === "btnEmbed") onEmbed();
    else if (t && t.id === "btnOvpClear") onOvpClear();
  });

  // ---------- 启动 ----------
  document.addEventListener("DOMContentLoaded", function () {
    // v8.0: 必须包一层 —— 若直接把 run 当监听器,浏览器会把 click 事件对象传进第 1 参(keepNotice),
    //       事件对象恒为真 ⇒ 手动点"开始检查"也会保留旧提示(不再是"清残留"语义)
    initSettings(); // v10.0: 设置弹层(七卡开关)按真实卡序生成
    $("btnRun").addEventListener("click", function () { run(); });
    if (inCEP()) run(); // 打开面板自动检查一次
    // v5.6/体验①: 面板获得焦点时探测当前文档指纹,与上次结果不一致(切换了文档)则自动重扫
    window.addEventListener("focus", function () {
      if (actionBusy || $("btnRun").disabled) return;
      execJsx("pfDocKey();", function (data) {
        if (data && data.ok && data.key && lastDocKey && data.key !== lastDocKey) run();
      });
    });
  });
})();
