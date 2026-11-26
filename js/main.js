/* 印前检查-雪糕 面板前端逻辑 (CEP) */
(function () {
  "use strict";

  var JS_BUILD = "20261126-2";
  // 必须与 jsx/preflight.jsx 里的 PF_BUILD 保持一致。
  // JSX 每次返回都会带上它的构建号,前端据此判断 ExtendScript 引擎里
  // 加载的是不是当前版本 —— 不一致就强制 $.evalFile 重载(见 execJsx)。
  var JSX_BUILD = "12.17";
  // v10.2 收尾: 「耗时较长」提示阈值 —— 原先 20000 在 run() 与 execAction() 各写一遍,
  //   连提示语里的「20 秒」也是手写 ⇒ 改口径要动 3 处、漏一处就文案与行为不一致。收成一处。
  var BUSY_TIMEOUT_MS = 20000;
  // v11.75(雪糕选 A): 卡片展开态存档键。按卡名记(不用序号) —— 卡片顺序可拖动排序,
  //   序号会漂; 卡名在八卡里唯一且不受排序影响。
  var PF_EXPAND_KEY = "pf_expandCards";

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
    // v11.39: 桥调用兜底 —— 宿主未就绪 / 引擎崩溃时原实现直接抛, 没人接
    //   ⇒ 回调永不触发 ⇒ scanBusy / actionBusy 永久为真, 面板只能重开。
    //   现在统一转成回调: 把 parseResult 认识的失败串交回去, 调用方已有的
    //   "没数据就 showError" 分支会自然接住。
    try { window.__adobe_cep__.evalScript(script, cb); }
    catch (e) { try { cb("EvalScript error."); } catch (e2) {} }
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
  //   getSystemPath + decodeURI + replace; 快路径(jsxReady)上算完即丢。
  //   (原注: 面板获得焦点的 pfDocKey 探针会反复付这笔开销 —— v11.33 起自动扫描已移除,
  //    但热路径仍然只有那一次替换, 缓存照样留着。)
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
  // v10.36(审查 v10.35 #5): execJsx 的"重发"分流 —— 只读函数可安全重发, 写动作不可。
  //   原实现在 jsxReady 为真但返回值 build 不符时, 一律用 withLoad **重发同一条 call**。
  //   对只读探针(runPreflight)无副作用; 但对写动作(pfOutlineAll/pfEmbedAll/pfClearOverprint/
  //   pfDeleteHidden/pfClear*Swatches/…) —— 首次 call 可能**已在宿主执行成功、只是返回值解析
  //   失败**(超时截断/跨桥异常), 重发即**二次执行破坏性动作**(重复转曲/重复删除)。
  //   分流后: 只读照旧重发; 写动作不重发, 置 jsxReady=false(下次调用会带 evalFile 重新加载),
  //   本次结果仍交回调 ⇒ 调用方按失败处理, 用户再点一次即可。
  //   ⚠ 宁可让用户多试点一次, 也不能让宿主重复执行不可逆动作。
  //   注: 正常使用几乎遇不到 —— 只读探针(runPreflight / pfDocKey)走的是重发分支, 会把
  //   jsxReady 刷成新版; 只有"面板开着时热替换 jsx 且用户直接点写动作"才会走这条路径。
  //   (v11.33 起面板打开不再自动 run(), 首次刷 jsxReady 要等用户按「开始检查」。)
  var READONLY_FNS = ["runPreflight", "pfDocKey", "pfLinkScope", "pfThDefaults"];
  function execJsx(call, cb, isReadOnly) {
    if (isReadOnly === undefined) {
      isReadOnly = false;
      // v10.39: 判定前先去掉前导空白 —— 原实现要求恰好以 `fn(` 开头, 一旦有人写成
      //   ' ' + call 或换行拼接就会被判成写动作(只读探针少了 evalFile 重载的机会; 更该防的
      //   是反方向)。纯防御: 现有调用无一违反, 行为对当前代码完全等价。
      var callTrim = String(call).replace(/^\s+/, "");
      for (var ri = 0; ri < READONLY_FNS.length; ri++) {
        if (callTrim.indexOf(READONLY_FNS[ri] + "(") === 0) { isReadOnly = true; break; }
      }
    }
    var withLoad = '$.evalFile("' + jsxFilePath() + '"); ' + call;
    var first = jsxReady ? call : withLoad;
    evalScript(first, function (result) {
      var data = parseResult(result);
      if (data && data.build === JSX_BUILD) { jsxReady = true; cb(data, result); return; }
      if (first === withLoad) { jsxReady = false; cb(data, result); return; } // 已重载仍异常
      // 走到这里 = 没带 evalFile 却拿到不符的 build ⇒ 引擎里的是旧版 jsx
      if (!isReadOnly) {
        jsxReady = false;   // 写动作不重发(上面那次可能已执行); 下次调用重新加载
        cb(data, result);
        return;
      }
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

  // ② (v11.82 已删) truncName —— 按字符数硬截断的旧实现。
  //   三个调用点(字体名 34 / 链接图文件名 40 / 低清图名 34)全部改由 CSS `.trunc`
  //   按**像素宽**省略: 面板可以拉得很宽, 那时字符数上限就成了"明明放得下也不给看"。
  //   ⚠ 别再把它加回来 —— 一条 `grep truncName js/main.js` 应当只命中这几行注释。

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
    // v11.62(雪糕): 标题尾冒号去掉 —— "缺失字体 2 个:" -> "缺失字体 2 个"。
    //   口径: 卡片正文里所有"标签/小节/计数行"一律不带尾冒号, 列表靠缩进与圆点分隔。
    //   提示条(.error/.notice)与确认弹窗里的冒号**不动** —— 那是句子的中文标点,
    //   不是"标签分隔符", 去掉会读成病句。
    // v11.82: 标题行必须带 .pf-exp-head（= flex），否则展开箭头的 margin-left:auto 失效,
    //   列表超过 cap 行时箭头会紧贴在「个」字后面而不是靠右。
    //   ⚠ 整句包一层 <span>: .pf-exp-head 带 gap:8px, 裸文本会被 flex 拆成匿名 flex item,
    //     "缺失字体" / 数字 / "个" 之间各插 8px 间隙, 字句被拉开。包成**一个** item 就没事。
    return '<div class="pf-exp-head"><span>缺失字体 <b class="bad-t">' + arr.length + "</b> 个</span></div>" +
      '<ul class="list">' + items + "</ul>";
  }

  // v5.16: 字体诊断行(fontDiagText)随根因确诊移除

  // chipLevel: 徽标自身的配色级别(可省略,默认沿用卡片级别)
  // v4.3: 卡 1 的"CMYK/RGB"徽标配色必须只跟色彩模式状态走,不能继承卡片级别
  //       ——否则出血不足(黄)会把 CMYK 徽标染黄,看起来像"色彩模式有问题"
  // v5.0: 新增 extraChip(可选)— 卡片右上角可并列第二个徽标(如卡1出血不足)
  // v10.39: 删掉第 7 参 headExtra —— 自 v10.29 叠印卡页签摘除后已**无任何调用点**传值,
  //   `(headExtra || '')` 恒为空串(逐字节等价)。历史上是 v10.14 给叠印卡 seg 用的。
  function card(title, level, chipText, bodyHtml, chipLevel, extraChip, loc, tip) {
    // v11.42: 定位按钮从徽标**右侧**挪到**左侧**（雪糕要求）。放在 chip 之前即可 ——
    //   .chips 是 inline-flex + gap:6px，顺序决定左右，几何仍受 21×21 约束、卡头恒 37px。
    // v12.8: 第 8 参 tip —— 整卡悬停提示。只给"空态一句话"的卡用（卡⑨ 无专色时），
    //   把原先挤在正文里的适用范围挪到悬停，空态才能和其余七卡一样只占一行。
    //   ⚠ 挂在**外层 .card** 而不是 .card-head: 卡头标题 span 的形态被测试逐字钉住，
    //     且空态卡片很矮，悬停整张卡才符合直觉。内层元素自带 title 时浏览器优先用它。
    return '<div class="card"' + (tip ? ' title="' + esc(tip) + '"' : "") +
      '><div class="card-head"><span>' + esc(title) + '</span>' +
      "<span class='chips'>" +
      (loc ? locateBtn(loc) : "") +
      chip(chipLevel || level, chipText) + (extraChip ? extraChip : "") +
      '</span>' +
      '</div><div class="card-body">' + bodyHtml + "</div></div>";
  }

  // v11.41: 卡头定位按钮 —— 选中该卡的全部问题对象。
  //   ⚠ 第 7 参 loc 只在"该卡确实有命中"时由调用方传, 正常态不传:
  //     一个点下去什么都选不中的按钮, 比没有按钮更糟。
  //   ⚠ 图标用手绘 SVG 而不是字符: 准星类的符号在部分系统字体里缺失, 会变成豆腐块。
  //   ⚠ main.js 正文禁全角括号 —— title 文案里的括注也用半角。
  //   v11.42: 图标从**描边准星**换成**面形准星**（Material gps_fixed 原 path），
  //     与设置齿轮同一套视觉语言（24×24 viewBox + fill="currentColor"）。
  //     尺寸 11 -> 12: 面形在 11px 下四个刻度的缝隙会糊成一团。
  //   v11.44: 依雪糕要求换成实心指向箭头（他给的 path）。
  //     ⚠ viewBox 从 0 0 1024 1024 裁到 190 58 644 907 —— 原 path 只占画布中间
  //       x 195~829 / y 63~960 这一条竖带, 直接按 1024 渲染的话 12px 里图形只有
  //       7.4×10.5 且整体偏左。裁到边界后是 8.5×12, 形状本身一个点没动。
  //     ⚠ 颜色仍走 currentColor（#9c9c9c / hover #ffffff），与之前一致。
  //   v11.55: 雪糕 "选择的箭头和鼠标放上去的底部圆形不是左右居中的"。
  //     根因: 裁到**包围盒**只保证几何居中, 不保证**视觉**居中 —— 这个箭头是
  //       "左边一条竖边 + 右上一个尖"的多边形, 墨迹重心天然偏左。
  //       实测(命中采样 0.5px 网格): 包围盒居中时墨迹形心 dx = -13.48%。
  //     改法: viewBox 按**墨迹形心** (388.2, 530.1) 对称取 —— 宽 881.4 使
  //       x 从 -52.5 到 828.9(中心 388.2), 高 932.6 使 y 从 63.8 到 996.4(中心 530.1)。
  //       实测 dx = -0.12%。图形左边界仍是 195.1, 一个点没动, 只是横向留白重分配。
  //     ⚠ 宽高比不等(0.945): 正方形 15×15 里 preserveAspectRatio 取 xMidYMid meet,
  //       按高缩放后横向居中, 不额外偏移。
  //   v11.65(雪糕): "选择的那个箭头图标大点吧" —— 12 -> 15。盒子仍 21×21(卡头 37px
  //     零位移: 卡头高由徽标 21 决定, svg 只在盒内居中), 15 < 21 不会顶出按钮。
  function locateBtn(n) {
    return '<button class="card-locate" data-locate="' + n + '"' +
      ' title="选中该卡的全部问题对象 (锁定/隐藏的只提示位置，不改状态)">' +
      '<svg viewBox="-52.5 63.8 881.4 932.6" width="15" height="15" aria-hidden="true">' +
      '<path fill="currentColor" d="M828.9 697.6L643.3 512 195.1 63.8v896.4l262.5-262.6z"/>' +
      '</svg></button>';
  }

  // v7.0: 标题行 + 右侧样本截断提示(与标题同一行、右对齐、不带括号)
  // 不带"共 N"是因为总数已经在标题的计数里,避免同一行重复报数
  function rowHead(leftHtml, hintText) {
    return '<div class="row-head"><span class="row-t">' + leftHtml + "</span>" +
      (hintText ? '<span class="row-h">' + esc(hintText) + "</span>" : "") + "</div>";
  }

  // ---------- v10.0: 卡片开关(设置弹层) ----------
  // 卡片顺序与 jsx 的 CK 一一对应: ①ab画板出血 ②hd隐藏 ③ft字体 ④im嵌入 ⑤rs分辨率 ⑥ik油墨描边 ⑦ov叠印 ⑧sw色板 ⑨tx空文本
  // v10.13: 新增第⑧卡「色板」(zhiban v0.7.8 移植)。⚠ 传给 jsx 时 c1..c7 仍是前七张卡,
  //   色板是第 **9** 个位置参数(第 8 位已被阈值串占用, 见 swArg)。泛化出 CARD_N, 别再散落硬编码 7。
  //   ⚠ 色板卡**默认不勾**(雪糕点名) —— 老用户 7 位存档不匹配正则 ⇒ 保持默认,
  //     恰好 = 前七张开 + 色板关, 无需迁移。
  // v11.15: 新增第⑨卡「空文本」(雪糕: 套用 AI 自带的 对象-路径-清理-空文本路径)。
  //   ⚠ 显示位置排在叠印之后、色板之前 —— 由 CARD_ORDER 决定; v11.63 合并后它的卡号从 8 变 7。
  //   开关走第 **10** 个位置参数(见 txArg), 绝不并进 c8 阈值串。
  // v11.63(雪糕选 C): 「图片嵌入」+「图片分辨率」合并成一张「图片」卡 ⇒ 九卡变八卡。
  //   ⚠ 合并**只发生在渲染层**: jsx 仍然分别回 d.images / d.resolution 两份数据,
  //     而 ckArgs() 把 c4(im) 与 c5(rs) 传成同一个开关 —— 所以 preflight.jsx 一行都不用改,
  //     CK.im / CK.rs 内部各自的门控全部原样保留(只是同开同关)。
  //   ⚠ 卡号变了 ⇒ 两处 localStorage 存档都要迁移, 且**换新的键名**(pf_cards2 / pf_order2):
  //     新旧格式都是 8 位, 同键无法区分, 直接读会被旧档按错位解释。
  //   卡名同时统一成"只写管什么、不写做什么"(雪糕 2026-10-29):
  //     画板 · 出血 · 色彩 → 画板; 隐藏图层 · 对象 → 隐藏; 字体 · 转曲 → 字体;
  //     油墨 · 描边粗细 → 油墨。顺带解决卡③ 标题被三颗徽标挤成省略号的问题(需 71px 只给 46px)。
  //   v11.64(雪糕): 「油墨」改回带后缀 —— 「油墨 · 描边」。理由: 这张卡同时管
  //     油墨总量(>300 / 220~300)、色版<5%、描边<0.1mm 三类, 光写"油墨"看不出还管描边。
  //     后缀只留"描边"二字(不是原来的"描边粗细"), 长度 6 字 ≈ 84px, 卡头放得下。
  // v11.87: 新增第⑨卡「专色描边」(手工陷印, zhiban v0.9.2 移植) ⇒ 八卡变九卡。
  //   ⚠ 它的扫描开关走 runPreflight 第 **11** 个位置参数(c11, 见 stArg) —— 前七位是
  //     c1..c7、第 8 位是阈值串、第 9/10 位已被色板/清理占用。新卡一律往后排。
  var CARD_N = 10;
  var CK_NAMES = ["画板", "隐藏", "字体", "图片", "油墨 · 描边", "叠印", "色板", "清理", "专色描边", "对照"];
  // v10.1: 卡片显示顺序(位置 -> 卡号)。拖动只改显示; 传给 jsx 的开关仍按固定卡序(ckArgs)
  // v11.63: 清理(7)在色板(6)之前 —— 沿用 v11.15 起的排法(清理紧跟叠印/油墨之后)。
  // v11.87: 专色描边(8)排在叠印(5)之后、清理(7)之前 —— 它也是"改文档"的动作卡, 与叠印同族。
  // v12.1(雪糕): 默认顺序改成**按卡号 ①~⑩ 顺序排**, 与 README 的编号列一一对应。
  //   ⚠ 注意 CK_NAMES 里 index 6 = 色板、index 7 = 清理(两张卡的编号与数组下标相反),
  //     而 README / 面板语义上 ⑦ 是清理、⑧ 是色板 ⇒ 这里必须写成 7 在 6 之前,
  //     面板上看到的才是 ①②③④⑤⑥⑦清理⑧色板⑨专色⑩对照。
  //   ⚠ 只是"新装 / 重置默认"的值; 老用户已存的 pf_order2 不重排(规矩: 排好的顺序一位不动)。
  var CARD_ORDER_DEF = [0, 1, 2, 3, 4, 5, 7, 6, 8, 9];
  var CARD_ORDER = CARD_ORDER_DEF.slice();
  // v12.1(雪糕): 默认关闭的是 ⑧色板 / ⑨专色描边 / ⑩对照 三张 —— 其余七张默认开。
  //   色板: v10.13 起就默认关(要登记全文档颜色引用, 最贵);
  //   专色描边 / 对照: v11.87 / v11.90 曾默认开, 本轮按雪糕要求改为关。
  //   ⚠ 下标: 6 = 色板(⑧) / 8 = 专色描边(⑨) / 9 = 对照(⑩)。
  var CARD_CK = [true, true, true, true, true, true, false, true, false, false];
  // v11.94(审查): 叠印卡的卡号 —— 设置弹层里「叠印版本」滑块要挂在**这张卡那一行**的末尾。
  //   ⚠ 别再写裸数字: v11.63 把图片两卡合并后卡号整体前移(叠印 6 -> 5), drawRows 里那句
  //     `i === 6` 漏改 ⇒ 滑块从 v11.63 起一直挂在「色板」行上、真正的「叠印」行反而没有,
  //     用户找不到切换入口(2026-11-19 全量核查时发现)。抽成常量后只有这一处需要跟着卡号走。
  var CARD_OVP = 5;
  // v11.16: 卡⑨「清理」卡内的三个勾选项(游离点 / 未上色对象 / 空文本路径)。
  //   与卡片开关是两回事: 卡片开关决定"扫不扫这张卡", 这三个决定"一键清理时清哪几类"。
  //   ⚠ 常量提到这里(v10.33 第 11 条同款理由): 若留在 onCleanup 上方, IIFE 早期(赋值前)
  //     就有调用方读它 —— 那时读到的是 undefined。
  var CLEAN_CK = { stray: true, unpainted: true, text: true };
  try {
    var ckClean = localStorage.getItem("pf_clean");
    if (ckClean !== null && /^[01]{3}$/.test(ckClean)) {
      CLEAN_CK.stray = ckClean.charAt(0) === "1";
      CLEAN_CK.unpainted = ckClean.charAt(1) === "1";
      CLEAN_CK.text = ckClean.charAt(2) === "1";
    }
  } catch (eCL) {}
  function cleanSave() {
    try {
      localStorage.setItem("pf_clean",
        (CLEAN_CK.stray ? "1" : "0") + (CLEAN_CK.unpainted ? "1" : "0") + (CLEAN_CK.text ? "1" : "0"));
    } catch (eCS) {}
  }
  // v10.33: 叠印版本存档键名上提到常量区 —— 原先声明在 readOvpMode 上方
  //   (IIFE 中部), 赋值在**执行到那一行时**才完成; 若将来有人在 IIFE 早期(赋值前)调
  //   readOvpMode(), 会读到 undefined。函数声明虽被 hoisting, 但常量不会 —— 挪到这里与 CARD_N 并列。
  var PF_OVP_MODE_KEY = "pf_ovpMode";
  // SCAN_CK = 本轮扫描实际用的开关快照 —— 渲染占位卡按它判,
  //   避免"扫描后又改勾选"拿旧数据/空数据当新结果显示。
  var SCAN_CK = null;
  try {
    // v11.63: 键名换成 pf_cards2 —— 卡片从 9 张合并成 8 张, 新旧存档**都是 8 位**,
    //   同一个键无法区分"合并后的 8 位"和"v10.13 时代的 8 位", 直接读会把位置错开。
    //   现在是: 先读新键; 读不到再把旧键按位次迁移一次(并写回新键), 之后再也不碰旧键。
    var ckSaved = localStorage.getItem("pf_cards2");
    if (ckSaved === null) {
      var ckOld = localStorage.getItem("pf_cards");
      if (ckOld !== null && /^[01]{9}$/.test(ckOld)) {
        // v11.15~v11.62: [画板 隐藏 字体 嵌入 分辨率 油墨 叠印 色板 清理]
        //   ⇒ 嵌入与分辨率**任一开着**合并卡就开着(关掉一张不等于两张都不想看)
        ckSaved = ckOld.charAt(0) + ckOld.charAt(1) + ckOld.charAt(2) +
          ((ckOld.charAt(3) === "1" || ckOld.charAt(4) === "1") ? "1" : "0") +
          ckOld.charAt(5) + ckOld.charAt(6) + ckOld.charAt(7) + ckOld.charAt(8);
      } else if (ckOld !== null && /^[01]{8}$/.test(ckOld)) {
        // v10.13~v11.14: [... 嵌入 分辨率 油墨 叠印 色板], 无清理 ⇒ 清理补默认开
        ckSaved = ckOld.charAt(0) + ckOld.charAt(1) + ckOld.charAt(2) +
          ((ckOld.charAt(3) === "1" || ckOld.charAt(4) === "1") ? "1" : "0") +
          ckOld.charAt(5) + ckOld.charAt(6) + ckOld.charAt(7) + "1";
      } else if (ckOld !== null && /^[01]{7}$/.test(ckOld)) {
        // v10.0~v10.12: [... 嵌入 分辨率 油墨 叠印], 无色板/清理 ⇒ 色板关(默认)、清理开
        ckSaved = ckOld.charAt(0) + ckOld.charAt(1) + ckOld.charAt(2) +
          ((ckOld.charAt(3) === "1" || ckOld.charAt(4) === "1") ? "1" : "0") +
          ckOld.charAt(5) + ckOld.charAt(6) + "0" + "1";
      }
      if (ckSaved !== null) { try { localStorage.setItem("pf_cards2", ckSaved); } catch (eCKw) {} }
    }
    if (ckSaved !== null && /^[01]*$/.test(ckSaved) && ckSaved.length > 0 && ckSaved.length < CARD_N) {
      // v11.87: 八卡时代的存档(8 位) → 九卡。新卡「专色描边」按**出厂默认(开)**补位,
      //   老用户的既有勾选一位不动。补完写回, 之后就是正常 9 位。
      // v11.90: 同一段通用逻辑继续用在 九卡(9 位) → 十卡, 补的是「对照」(默认开)。
      //   ⚠ 这里必须继续"末位补一位"而不重排: 老存档的位次=卡号, 一重排全部错位。
      // v11.94(审查): 原来是 `length === CARD_N - 1` 的**单步**补位 —— 一次只补一位。
      //   于是"v11.86(8 位) 直接升到 v11.90+(10 位)"这种跨版本跳跃会两位都补不上,
      //   整条存档被静默丢弃 ⇒ 卡片开关全部回到出厂值, 用户只会觉得"我勾的怎么没了"。
      //   改成 while 逐位补齐: 补到第几位就用 CARD_CK 在该位的出厂默认值,
      //   位次语义与单步版完全一致(补出来的位置天然是"新增卡在末位")。
      while (ckSaved.length < CARD_N) {
        ckSaved += (CARD_CK[ckSaved.length] ? "1" : "0");
      }
      try { localStorage.setItem("pf_cards2", ckSaved); } catch (eCKu) {}
    }
    if (ckSaved !== null && ckSaved.length === CARD_N && /^[01]*$/.test(ckSaved)) {
      for (var ckI = 0; ckI < CARD_N; ckI++) CARD_CK[ckI] = ckSaved.charAt(ckI) === "1";
    }
  } catch (eCK) {}

  // ---------- v10.1: 阈值(唯一真源在 jsx 的 PF_TH_DEF) ----------
  //   前端**不保存任何阈值默认值**: 默认由 jsx 的 pfThDefaults() 下发;
  //   用户改动只存"改动项"于 localStorage["pf_th"](竖线分隔, 与 jsx pfThApply 的 keys 同序),
  //   扫描时作为 runPreflight 的第 8 参传回 jsx; 生效值再由 res.th 回传供渲染显示。
  //   ⇒ 以后调阈值只改 jsx 一处(PF_TH_DEF), 面板判定与文案自动跟随。
  // v10.2: 去掉「其中重度」(tinyBad) —— 字号只留一条判定(<tiny 直接标红)。
  // v11.5: 线序末尾追加 "light"(色版极浅阈值) —— 原先它只在 jsx 的 PF_TH_DEF 里、不可调。
  //   追加在**末位**是老数据的兼容前提: 旧 pf_th(6 项) 前六位含义不变, 第 7 位缺项 ⇒ 回落默认。
  // v12.14: 末尾追加 "rbSum"(四色黑判断线) —— 与 jsx 的 PF_TH_KEYS 同序, 线序前缀升 "v3"。
  var TH_KEYS = ["bleed", "reso", "thin", "tiny", "inkOk", "inkWarn", "light", "rbSum"];
  var TH_KEYS_V2 = ["bleed", "reso", "thin", "tiny", "inkOk", "inkWarn", "light"];
  // ⚠ 老用户 localStorage 里的 pf_th 是 v10.1 的 7 项格式(含 tinyBad)。
  //   线序靠"字段数"区分: 7 项按旧线序读、6 项按新线序读 —— 否则会把 inkOk 当 tinyBad 用,
  //   判定拿错数字而且毫无提示(油墨阈值变成 5/220 ⇒ 满屏标红)。
  var TH_KEYS_V101 = ["bleed", "reso", "thin", "tiny", "tinyBad", "inkOk", "inkWarn"];
  var TH_DEF = null;    // jsx 下发的默认值(含 cap/scan/light 等非用户项)
  var TH_PREF = null;   // 用户改过的项(只存改动)
  var PF_TH = null;     // 显示用生效值 = 默认 ⊕ 改动; 扫描后由 res.th 校准

  // 设置弹层里的阈值输入(顺序即界面顺序; step 只影响上下箭头粒度)
  // v11.5(雪糕): 顺序改成**与卡片/块的出现顺序一致**, 并补上原先缺的「色版低于」——
  //   卡①出血 → 卡③极小字号 → 卡⑤分辨率 → 卡⑥油墨(总量偏重/超标 → 色版 → 描边)。
  //   ⚠ 这里只管**界面顺序**; 传给 jsx 的线序另由 TH_KEYS 决定(light 必须留在末位), 两者不必同序。
  // v11.22: 每项自带 min —— 原先输入框写死 min="1"(v10.46 从 0 改上来),
  //   但 thin(描边细于)默认 0.1、step 0.05, 值落在 min 下面 ⇒ 输入框处于 invalid 状态,
  //   用 ↑↓ / 滚轮调值时会被浏览器**钳到 1**, 永远调不到 0.1~1 这一段(恰恰是印前最常用的区间)。
  //   手输 0.1 仍能被 thParse 接受, 所以平时不易察觉, 一旦用滚轮就卡住。
  //   ⇒ 按字段给下限: 毫米/百分比类放到 0.1 与 0.01, 计数/ppi/油墨类保持 1。
  //   ⚠ 填 0 仍会被 jsx 的 pfThApply 视为"回落默认"(填 0 = 静默用默认值), 想回默认请清空。
  var TH_FIELDS = [
    { k: "bleed",   label: "出血不足",       unit: "mm",  step: "0.5",  min: "0.1"  },
    { k: "tiny",    label: "极小字号低于",   unit: "pt",  step: "0.5",  min: "0.5"  },
    { k: "reso",    label: "图片分辨率低于", unit: "ppi", step: "1",    min: "1"    },
    { k: "inkOk",   label: "油墨总量偏重",   unit: "",    step: "5",    min: "1"    },
    // v11.114(雪糕选 A): inkWarn 加 hint —— 只挂到行 label 的 title 上, **不占行高**。
    //   设置面板窄的时候多一行小字会把 7 行撑高, 所以宁可用悬停。
    //   要讲清的事: 这一项只管「报不报」, 四色黑转单黑另有一套固定口径, 不跟着这一项走。
    //   雪糕原话: "现在外面是检测油墨大于 300, 转单黑是 320。怎么优化合适?" → 选 A:
    //   **不改阈值**(300 是检测线、320 是能否安全一键转单黑的判断线, 两者职责不同),
    //   只把区别写在文案里。
    //   v12.12: 四色黑的判定简化为"C+M+Y+K 之和 >=N" —— 原来的"每通道 >=80%"已取消。
    //   v12.14(雪糕选 C): N 提成可调项(下面那一行 rbSum), 默认由 320 抬到 330 ——
    //     320 那一档恰好是 C100/M100/Y100/K20 这类三色富黑, 转单黑后由深灰黑变纯黑。
    //   v12.15(雪糕): 行名改成与按钮**完全同名**「四色黑转单黑」—— 原来的「四色黑合计达」
    //     只说清了判定口径, 看不出它就是那颗按钮的开关。设置行与按钮同名最省解释。
    { k: "inkWarn", label: "油墨总量超标",   unit: "",    step: "5",    min: "1",
      hint: "这一项只管「要不要报出来」——改它只影响卡⑥ 的「油墨总量>N」那一块。四色黑那条在下面单独一行，两条线各管各的、互不影响。" },
    { k: "rbSum",   label: "四色黑转单黑",   unit: "%",   step: "5",    min: "1",
      hint: "判四色黑的门槛，也是「四色黑转单黑」那颗按钮的开关：C+M+Y+K 之和达到这个值就会被转成 C0 M0 Y0 K100。默认 330 —— 刚好把 C100/M100/Y100/K20(=320) 这类三色富黑挡在门外，不让它变成纯黑。调到 300 会把纯 CMY 三色黑也转掉，视觉变化更明显。" },
    { k: "light",   label: "色版低于",       unit: "%",   step: "1",    min: "0.1"  },
    { k: "thin",    label: "描边细于",       unit: "mm",  step: "0.05", min: "0.01" }
  ];

  function thParse(s) {   // "v2|3|300|..." -> {bleed:3, reso:300, ...}; 非数字/<=0 的项忽略
    if (!s) return null;
    var p = String(s).split("|"), o = {}, i, v, any = false, off = 0, ks;
    // v11.5: 线序第一次**加字段**(light) ⇒ 字段数已无法区分格式(新 7 项 / v10.1 旧 7 项撞车),
    //   故新格式带**非数字**前缀 "v2"(不能是 "2" —— 出血阈值可能正好是 2)。
    //   无前缀的旧数据照旧: 7 项 = v10.1(含 tinyBad, 该项在下面被跳过), 其余按现行线序。
    if (p[0] === "v3") { off = 1; ks = TH_KEYS; }
    else if (p[0] === "v2") { off = 1; ks = TH_KEYS_V2; }
    else if (p.length === TH_KEYS_V101.length) { ks = TH_KEYS_V101; }
    else { ks = TH_KEYS_V2; }   // v12.14: 无前缀的 6 项老数据按 v2 线序读(末位 rbSum 缺项)
    for (i = 0; i < ks.length; i++) {
      if (TH_KEYS.indexOf(ks[i]) < 0) continue;
      v = parseFloat(p[i + off]);
      if (!isNaN(v) && isFinite(v) && v > 0) { o[ks[i]] = v; any = true; }
    }
    return any ? o : null;
  }
  function thWire(o) {   // {..} -> "v3|3|300|..."; 缺项留空(jsx 侧回落默认)
    if (!o) return "";
    // v12.14: 前缀 v2 -> v3(线序加了第 8 项 rbSum)。与 thParse / jsx pfThApply 同一口径;
    //   三处必须一起改, 否则面板发 v3 而 jsx 只认 v2 ⇒ 用户设置整列静默失效。
    var a = ["v3"], i, v;
    for (i = 0; i < TH_KEYS.length; i++) {
      v = o[TH_KEYS[i]];
      a.push(v === undefined || v === null ? "" : v);
    }
    return a.join("|");
  }
  // jsx 第 8 参(字符串字面量)。空串 ⇒ jsx 的 pfThApply 逐项回落 PF_TH_DEF
  function thArg() { return '"' + thWire(TH_PREF) + '"'; }
  // v10.13: 色板卡开关(c9)。⚠ 不能并进 ckArgs —— c8 是阈值串, 并进去会两头一起坏(见 zhiban v10.16 教训)
  function swArg() { return CARD_CK[6] ? "1" : "0"; }   // v11.63: 色板随卡号前移 7 -> 6
  // v11.15: 空文本卡开关(c10)。同样**不**并进 ckArgs —— 前七位之间的位序一个都不能动。
  function txArg() { return CARD_CK[7] ? "1" : "0"; }   // v11.63: 清理随卡号前移 8 -> 7
  // v11.87: 专色描边卡开关(c11)。同样**不**并进 ckArgs —— 它是第 11 个位置参数,
  //   前七位 + 阈值串(c8) + 色板(c9) + 清理(c10) 的位序一个都不能动。
  function stArg() { return CARD_CK[8] ? "1" : "0"; }
  // v11.87: 卡⑨ 的描边宽(mm) —— 面板直接填描边宽, 没有隐含的 2 倍换算
  //   (zhiban v0.8.1 就是按这个口径改的: "填 0.2 就是 0.2")。
  //   外扩量 = 描边宽 / 2(描边居中), 这句话只出现在卡片提示里, 不参与计算。
  //   ⚠ 上限 10mm 与 jsx 的 pfSpotTrap 内部钳位一致, 两处都是保护, 不互相依赖。
  var TRAP_W = 0.2;
  try {
    var twSaved = parseFloat(localStorage.getItem("pf_trapW"));
    if (!isNaN(twSaved) && twSaved > 0 && twSaved <= 10) TRAP_W = twSaved;
  } catch (eTW) {}

  // v11.90: 卡⑩「对照」的透明度(%) —— **只在建立/重建时生效**(雪糕 2026-11-19 选 B)。
  //   改数字本身不动文档: 它既不重扫、也不发 jsx, 只落 localStorage; 下次点「重建」才写进去。
  //   范围 5~95 与 jsx 的 PF_SNAP_OP_MIN/MAX 一致 —— 0 等于隐形但仍在文档里, 100 会把稿子盖死。
  var SNAP_OP = 50;
  try {
    var soSaved = parseInt(localStorage.getItem("pf_snapOp"), 10);
    if (!isNaN(soSaved) && soSaved >= 5 && soSaved <= 95) SNAP_OP = soSaved;
  } catch (eSO) {}
  function snapOp() { return SNAP_OP; }
  function trapWidth() { return TRAP_W; }
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
  // v11.79(雪糕): 标题行右侧「仅列出前 5 个」这类样本上限提示整体停用 ——
  //   展开箭头上线后名单能全部展开, 这行提示纯属重复。
  //   ⚠ 保留函数与 8 个调用点的形态(恒返回空串), 不动 rowHead / inkBlock 的渲染结构:
  //     那些结构仍被 ink-align / sample-caps 的几何断言钉着, 改结构的收益不抵风险。
  //   ⚠ 带括号的独立灰字行 (仅列出前 3000 个) 是扫描配额警告, 数据根本没生成、
  //     展开也补不出来; 删掉会把不完整结果伪装成完整结果, 必须保留。
  //   (v11.39 原实现会渲染「仅列出前 ? 处」, 那是 thv("cap") 拿不到默认值时的问题,
  //    现在整句不再输出, 该问题自然消失。)
  function capHint(unit) {
    return "";
  }

  // 取"当前生效阈值": 已有默认值则直接算; 否则问 jsx 要一次默认值(只回默认, 不扫描文档)
  // v11.6: force —— 强制重取一次默认值(即便 TH_DEF 已有值)。
  //   由来: v11.5 及以前 TH_DEF 可能被"生效值"污染过, 而它只会写一次; 每次打开设置弹层
  //   重取一遍 pfThDefaults(纯内存拷贝, 不扫文档、不重新解析脚本) 是最便宜的自愈路径。
  var thBusy = false, thQ = [], thTimer = null;
  function thEnsure(cb, force) {
    if (TH_DEF && !force) { thRefresh(); cb(); return; }
    thQ.push(cb);
    if (thBusy) return;
    thBusy = true;
    function fin() {
      // v11.39: 撤兜底计时器 —— 正常回来时不必让它再开一枪
      if (thTimer) { clearTimeout(thTimer); thTimer = null; }
      thBusy = false;
      var q = thQ; thQ = [];
      for (var i = 0; i < q.length; i++) { try { q[i](); } catch (eQ) {} }
    }
    if (!inCEP()) { thRefresh(); fin(); return; }
    // v11.39: 兜底超时 —— 桥不回(文档已关 / 引擎挂掉 / evalScript 静默失败)时
    //   thBusy 永久为真, 之后每次 thEnsure 都只进队列不发出请求 ⇒ 设置弹层再也拿不到默认值。
    //   与 run() 的 graceTimer 同一套路: 到期强行解锁并清队列; 真回调迟到时仍会覆盖 TH_DEF。
    thTimer = setTimeout(function () { thTimer = null; fin(); }, BUSY_TIMEOUT_MS);
    execJsx("pfThDefaults();", function (data) {
      // v11.6: 覆盖写 —— 默认值只有 jsx 说得准, 拿到就顶掉旧的(不再 if 拦截)
      if (data && data.th) TH_DEF = data.th;
      thRefresh();
      fin();
    });
  }

  // ---------- v10.1: 阈值草稿 —— 输入框先写草稿, 按「确认」才落盘(pf_th) ----------
  //   为什么要草稿: 边打边存的话, 输入 300 的过程(3 → 30 → 300)会存三次; 而且"打开看看、
  //   没想改"也会留下痕迹。草稿制: 「确认」= 落盘并关闭; 「关闭」= 放弃本次编辑。
  var TH_DRAFT = null;   // null = 弹层没开; {..} = 正在编辑的那一份
  var TH_DIRTY = false;  // v11.6: 草稿是否被用户动过 —— 异步回来的默认值不许盖掉手输的值
  function thDraftV(k) {   // 草稿值优先, 其次用户已存改动, 再次默认
    if (TH_DRAFT && TH_DRAFT[k] !== undefined) {
      // v11.39: null 是"用户清空了这一项"的哨兵 —— 语义 = 回出厂默认。
      //   原实现用 delete 抹掉键, 于是回落到 thEffV ⇒ TH_PREF(上次保存的值),
      //   表现为「清空后旧值复活」: 之前存过 5, 清空确认后仍是 5, 而不是默认的 3。
      if (TH_DRAFT[k] === null) {
        return (TH_DEF && TH_DEF[k] !== undefined) ? TH_DEF[k] : undefined;
      }
      return TH_DRAFT[k];
    }
    return thEffV(k);
  }
  // v10.37: useDef —— 「重置默认」用它起稿(取 TH_DEF 而非生效值), 使阈值预览回到出厂默认;
  //   弹层常规打开时不传(用生效值)。起稿: 全量 TH_KEYS.length 项。
  //   v11.21 更正: 原注释写"6 项", 实际 v11.5 起 TH_KEYS 是 **7 项**(末位是 light);
  //   代码本身一直按 TH_KEYS.length 循环, 只有注释过期。
  function thDraftInit(useDef) {
    TH_DRAFT = {};
    TH_DIRTY = false;   // v11.6: 重新起稿 = 干净状态
    for (var i = 0; i < TH_KEYS.length; i++) {
      var k = TH_KEYS[i];
      var v = useDef ? (TH_DEF && TH_DEF[k] !== undefined ? TH_DEF[k] : undefined) : thEffV(k);
      // v11.6: 这里的 PF_TH 兜底只在 TH_DEF 没到位时生效(pfThDefaults 还没回 / jsx 调用失败),
      //   那种情况下「重置」等于没重置 —— 调用方(重置按钮)会另给一句提示, 不假装成功。
      if (v === undefined && PF_TH && PF_TH[k] !== undefined) v = PF_TH[k];
      if (v !== undefined) TH_DRAFT[k] = v;
    }
  }
  function thDraftDiscard() { TH_DRAFT = null; }
  // v11.39: 阈值框是否正在被编辑 —— 用来判断"能不能重绘 DOM"。
  //   起因: thEnsure 的默认值是**异步**回来的, 回调里 drawTh() 会重建 innerHTML;
  //   而 TH_DIRTY 只在 onThChange(change 事件, 需失焦或回车)时置位 ⇒ 用户正在打字
  //   的那一刻它仍是 false ⇒ 手输的值被整个抹掉、光标也没了。
  function thFocusedKey() {
    var ae = document.activeElement;
    if (!ae || !ae.id || ae.id.indexOf("th_") !== 0) return null;
    return ae.id.substring(3);
  }
  // 只补空缺项, 不动 DOM —— 有人在打字时的安全替代方案(用户已填的键一概不碰)
  function thDraftFillGaps() {
    if (!TH_DRAFT) TH_DRAFT = {};
    for (var i = 0; i < TH_KEYS.length; i++) {
      var k = TH_KEYS[i];
      if (TH_DRAFT[k] !== undefined) continue;   // null 哨兵也算"用户已定"
      if (TH_DEF && TH_DEF[k] !== undefined) TH_DRAFT[k] = TH_DEF[k];
    }
  }
  function thDraftCommit() {   // 「确认」: 草稿 -> TH_PREF -> localStorage["pf_th"]
    var i, k, v, o = null;
    for (i = 0; i < TH_KEYS.length; i++) {
      k = TH_KEYS[i];
      v = (TH_DRAFT && TH_DRAFT[k] !== undefined) ? TH_DRAFT[k] : thEffV(k);
      // v11.39: null 哨兵 = 回出厂默认; 默认值也拿不到就当"没有偏好"跳过
      if (v === null) v = (TH_DEF && TH_DEF[k] !== undefined) ? TH_DEF[k] : undefined;
      if (v === undefined) continue;
      // 与默认值相同就不存 —— 让 pf_th 里只留真正改过的项
      //   (清空后落到的正是默认值 ⇒ 该键从 TH_PREF 消失 ⇒ 存盘也跟着清掉)
      if (TH_DEF && TH_DEF[k] !== undefined && String(TH_DEF[k]) === String(v)) continue;
      if (!o) o = {};
      o[k] = v;
    }
    TH_PREF = o;
    thSave();
    thRefresh();
  }
  // 「重置默认」: 卡片开关全开 + 顺序复原 + 阈值清空(三项一起, 与按钮文案一致)
  // v10.37: 改为**草稿式** —— 原实现点下即落盘(ckSave/orderSave/thSave), 与"关闭=取消"冲突。
  //   现只改内存 + 用默认值起阈值草稿; 由「确认」统一落盘, 「关闭」整体回滚。
  function thResetAll() {
    var i;
    // v11.15: 不能再用"CARD_N-1 = 色板"的写法 —— 加卡后最后一位不是色板了。
    //   v11.63: 图片两卡合并后卡序整体前移, 色板从 index 7 变 index 6 —— 这里必须跟着改,
    //   否则「恢复默认」会把清理关掉、把色板打开, 与 CARD_CK 初始值逐位不一致。
    for (i = 0; i < CARD_N; i++) CARD_CK[i] = true;
    // v12.1(雪糕): 默认关的三张 —— ⑧色板(index 6) / ⑨专色描边(index 8) / ⑩对照(index 9)。
    //   ⚠ 必须与上面 CARD_CK 的初始值**逐位一致**, 否则「恢复默认」和"新装"结果不同。
    CARD_CK[6] = false;          // ⑧ 色板(v10.13 起关)
    CARD_CK[8] = false;          // ⑨ 专色描边(v12.1 起关)
    CARD_CK[9] = false;          // ⑩ 对照(v12.1 起关)
    // v11.15: 顺序回默认表(空文本插在叠印之后) —— 原先 [0..CARD_N-1] 会把它排到最末。
    CARD_ORDER = CARD_ORDER_DEF.slice();
    thDraftInit(true);   // 阈值起稿用默认值(不再动 TH_PREF / thSave)
  }
  function fillDraftInputs() {   // 输入框一律显示草稿值
    for (var i = 0; i < TH_FIELDS.length; i++) {
      var k = TH_FIELDS[i].k;
      var el = $("th_" + k);
      // v10.46: **跳过当前聚焦的输入框** —— onThChange 每次 change 都会
      //   全量重填, 对被聚焦框重赋值会把光标推到末尾( editing 中间位置时被打断),
      //   inkWarn 联动纠正甚至会把用户刚填的值顶掉(见 onThChange 注释)。
      //   聚焦框的值由用户自己掌控, 失焦/下次进场时自然对齐草稿。
      if (el && el !== document.activeElement) {
        var v = thDraftV(k);
        el.value = (v === undefined) ? "" : v;
      }
    }
  }
  // 输入的联动纠正 —— 与 jsx pfThApply 的两条不变量同口径(只动草稿, 不落盘)
  function onThChange(k, inp) {
    var v = parseFloat(inp.value);
    if (!TH_DRAFT) TH_DRAFT = {};
    TH_DIRTY = true;   // v11.6: 用户动过草稿 —— 之后异步回来的默认值不再重绘草稿
    // v11.39: 非法/清空写 **null 哨兵**, 不再 delete。
    //   delete 会让 thDraftV 回落到 thEffV ⇒ TH_PREF(上次保存的值), 表现为"清空后旧值复活"。
    //   null 的语义明确: 这一项没值了 ⇒ 回出厂默认(见 thDraftV / thDraftCommit)。
    if (!isNaN(v) && isFinite(v) && v > 0) TH_DRAFT[k] = v; else TH_DRAFT[k] = null;
    // v10.46: inkWarn 的纠正**不再写回用户正在编辑的那一项**。
    //   旧实现纠正后无条件 fillDraftInputs() 全量重填: 用户在 inkWarn 框输入 3 想输
    //   300, 第一次 change(按 Tab/回车确认值时)就被顶成 inkOk+1(默认 221), 且聚焦框
    //   value 被重赋值、光标跳尾 —— "想改的数字根本填不进去"。
    //   现在: 纠正照做(不变量不破), 但正在聚焦的框不重写(fillDraftInputs 已跳过),
    //   用户继续把 300 输完; 若最终值仍 <= inkOk, 「确认」时 thDraftCommit 之前的
    //   这一层会在 blur 后重填时体现(那时已不再是聚焦框)。
    var ov = thDraftV("inkOk"), wv = thDraftV("inkWarn");
    // v10.60: 纠正下限与 jsx pfThApply 完全对齐 —— 下限取**默认 inkWarn**
    //   (TH_DEF.inkWarn, 其唯一真源就是 jsx 的 PF_TH_DEF.inkWarn), 而不是只取 ov+1。
    //   旧实现两侧不同源: 输入 100|220 前端纠成 221、jsx 却纠成 300 ⇒ 确认后数字再跳一次
    //   (面板显示与判定不同源)。TH_DEF 尚未就绪(pfThDefaults 还没回)时退回 ov+1,
    //   至少不破"inkWarn > inkOk"这条不变量。
    if (ov !== undefined && wv !== undefined && wv <= ov) {
      var dfltW = (TH_DEF && TH_DEF.inkWarn !== undefined) ? TH_DEF.inkWarn : (ov + 1);
      TH_DRAFT.inkWarn = Math.max(ov + 1, dfltW);
    }
    fillDraftInputs();
  }

  // ---------- v10.1: 卡片显示顺序(pf_order, 8 位数字 = 位置 -> 卡号; v10.19 起含色板) ----------
  function orderSave() {
    // v11.63: 写新键(见下方迁移说明); 旧键 pf_order 从此只读不写。
    try { localStorage.setItem("pf_order2", CARD_ORDER.join("")); } catch (eO) {}
  }
  // 拖动排序用到的两个纯逻辑 + 两个拖拽期变量
  function orderMove(o, from, to) {   // 把 from 位置那张卡挪到 to 位置; 越界/原地返回副本
    var a = o.slice(0);
    if (from < 0 || from > CARD_N - 1 || to < 0 || to > CARD_N - 1 || from === to) return a;
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
  // ⚠ v10.33: v10.32 曾在此加 dragTarget/dragDir 想做"插入位指示线", 但那是**死代码** ——
  //   dragMove 里 dragTarget 与 dragPos 被同时写成 to, 于是 drawRows 的
  //   `pos !== dragPos` 恒为 false, 指示线永不显示(外部审查 v10.32 第 1 条实锤)。
  //   已整体删除(变量 / drawRows 分支 / CSS 两条 .drop-above/.drop-below)。
  //   当前是「实时换位」交互: 被拖的那一行自己跟着光标走 + .dragging 高亮, 足够表意;
  //   插入位指示线是「松手才落位」模式才需要的, 这里本就不该有。
  try {
    // v11.63: 键名换 pf_order2(理由同 pf_cards2 —— 新旧都是 8 位, 同键无法区分)。
    //   迁移规则: 旧序列里把卡号 4(分辨率)整条**摘掉**, 大于 4 的卡号统一 -1。
    //     9 位(0~8) → 摘 4 后剩 8 个, 得到新卡号 0~7;
    //     8 位(0~7, v10.19~v11.14) → 摘 4 后剩 7 个(0,1,2,3,5,6,7 → 0,1,2,3,4,5,6), 末尾补清理(7);
    //     7 位(0~6, v10.1~v10.18) → 摘 4 后剩 6 个(0,1,2,3,5,6 → 0..5), 末尾补色板(6)、清理(7)。
    var oSaved = localStorage.getItem("pf_order2");
    if (oSaved === null) {
      var oOld = localStorage.getItem("pf_order"), oLen = 0, oArr0 = [], oI0, oV0, oMap0 = [];
      if (oOld && /^[0-8]{9}$/.test(oOld)) oLen = 9;
      else if (oOld && /^[0-7]{8}$/.test(oOld)) oLen = 8;
      else if (oOld && /^[0-6]{7}$/.test(oOld)) oLen = 7;
      if (oLen) {
        for (oI0 = 0; oI0 < oLen; oI0++) oArr0.push(parseInt(oOld.charAt(oI0), 10));
        for (oI0 = 0; oI0 < oLen; oI0++) {
          oV0 = oArr0[oI0];
          if (oV0 === 4) continue;                       // 分辨率那张卡没了, 从顺序里摘掉
          oMap0.push(oV0 > 4 ? oV0 - 1 : oV0);
        }
        // 补齐末位: 旧档里没有的卡(清理/色板)一律追加到最后
        for (oI0 = 0; oMap0.length < CARD_N; oI0++) {
          if (oMap0.indexOf(oI0) < 0) oMap0.push(oI0);
        }
        if (oMap0.length === CARD_N) {
          oSaved = oMap0.join("");
          try { localStorage.setItem("pf_order2", oSaved); } catch (eOw) {}
        }
      }
    }
    if (oSaved && /^[0-9]+$/.test(oSaved) && oSaved.length > 0 && oSaved.length < CARD_N) {
      // v11.87: 八卡时代(8 个卡号) → 九卡。新卡号 = CARD_N-1, **追加到末位**
      //   —— 不插到中间: 老用户排好的顺序一位不动, 新卡出现在最下面最不突兀
      //   (想挪位置就去设置里拖)。
      // v11.94(审查): 与 pf_cards2 同一个毛病 —— 原来只补一位, 跨版本跳跃(8 位 → 10 位)
      //   补不满 ⇒ 整条顺序存档被丢弃, 用户拖过的卡序回到出厂值。
      //   改成逐位补齐: 旧序列必然是 0..len-1 的排列, 缺的第 k 位就该补卡号 k。
      while (oSaved.length < CARD_N) oSaved += String(oSaved.length);
      try { localStorage.setItem("pf_order2", oSaved); } catch (eOwu) {}
    }
    if (oSaved && oSaved.length === CARD_N && /^[0-9]+$/.test(oSaved)) {
      var oArr = [], oOk = true, oK, oV;
      for (oK = 0; oK < CARD_N; oK++) {
        oV = parseInt(oSaved.charAt(oK), 10);
        if (oArr.indexOf(oV) >= 0) { oOk = false; break; }   // 必须是不重复的 0~N-1 全排列
        oArr.push(oV);
      }
      // 双保险: 全部字符都在 0~N-1 且无重复 ⇒ 必然是全排列; 再加 isNaN 校验防未来改动。
      if (oOk && oArr.length === CARD_N && !isNaN(oArr[oArr.length - 1])) CARD_ORDER = oArr;
    }
  } catch (eO2) {}

  function ckArgs() {
    // ⚠ v10.33: jsx 的 c1..c7 是**固定位置**参数(ab/hd/ft/im/rs/ik/ov), 与 CARD_N 无关 ——
    //   色板走 c9(swArg)、清理走 c10(txArg), **不要改成 CARD_N-1**: 一旦有位空出来,
    //   阈值串(c8)就会被顶到 c7 上, 全卡判定按错位线序读参数(zhiban v10.16 同因)。
    // v11.63: 图片两张卡合并后只剩一个开关 ⇒ c4(im) 与 c5(rs) 传**同一个值**,
    //   这样 preflight.jsx 一行都不用改, CK.im / CK.rs 各自的内部门控照旧。
    var a = [CARD_CK[0], CARD_CK[1], CARD_CK[2], CARD_CK[3], CARD_CK[3], CARD_CK[4], CARD_CK[5]], i;
    for (i = 0; i < a.length; i++) a[i] = a[i] ? 1 : 0;
    return a.join(",");
  }
  function ckSave() {
    try {
      var t = "", i;
      for (i = 0; i < CARD_N; i++) t += CARD_CK[i] ? "1" : "0";
      localStorage.setItem("pf_cards2", t);   // v11.63: 新键, 旧 pf_cards 只读不写
    } catch (eP) {}
  }
  // 已关闭的卡: 不再渲染(v10.51 雪糕定)。
  //   原先返回一张灰化占位卡(.card-off / .chip.off): 卡头挂「已关闭」徽标, 卡体写
  //   "本轮未检查。在「设置」里勾选后点「开始检查」。"。雪糕要求"关掉的直接删掉, 不用再显示已关闭"。
  // v11.39: 上一版把它降级成 `return "";` 的空函数保留调用形态, 但这层间接已经
  //   没有任何意义(既不能恢复占位态、也没参数被消费) —— 按雪糕要求整体删除, 9 处调用点
  //   直接写 `: "";`。配套删除: 回归用例里钉"函数存在"与调用点计数的那几条断言。
  //   ⚠ .card.card-off 与 .chip.off 两条 CSS 仍旧保留(纯样式, 无引用也无害)。
  //   ⚠ 副作用不变: 若九张卡全关, #results 会是空的(雪糕 2026-10-22 明确不加空态引导)。

  // 设置弹层: 勾选行按真实卡序生成(卡片名只在 CK_NAMES 维护一份, 与 es 侧同序)
  function initSettings() {
    var list = $("setList"), mask = $("setMask");
    if (!list || !mask) return;
    // v10.1: 关闭 = 放弃未确认的草稿
    // v10.37: 改为**整体**回滚/落盘 —— 原先只有阈值走草稿(开关与顺序即时落盘), 导致雪糕点
    //   「关闭」时上面的改动照样生效、"关闭"和"确认"看着一样。现在四项(卡片开关 / 顺序 /
    //   叠印版本 / 阈值)统一: commit=true 全部落盘, commit=false 全部回滚到进场快照。
    function closeSet(commit) {
      if (commit) {
        ckSave();                                   // 卡片开关 → pf_cards
        orderSave();                                // 卡片顺序 → pf_order
        // v10.43(P1-b): 落盘取草稿 SET_OVP(没改过则用进场快照), 快照本身永不被写
        if (SET_SNAP) writeOvpMode(SET_OVP !== null ? SET_OVP : SET_SNAP.ovp);   // 叠印版本 → pf_ovpMode
        thDraftCommit();                            // 阈值 → pf_th
      } else {
        // 回滚: 开关 / 顺序 复位; 叠印 UI 复位(localStorage 本就未动); 阈值草稿丢弃
        if (SET_SNAP) {
          CARD_CK = SET_SNAP.ck.slice();
          CARD_ORDER = SET_SNAP.order.slice();
          applyOvpModeUI(SET_SNAP.ovp);
        }
        thDraftDiscard();
      }
      // v10.43(P1-b): 撤草稿同撤快照; 回滚用的 SET_SNAP.ovp 现在是干净的进场原值
      SET_SNAP = null;
      SET_OVP = null;
      mask.classList.add("hidden");
    }

    // v10.1: 勾选行按 CARD_ORDER 渲染(卡号 i 仍对应 jsx 的 c1..c7)。
    //   「①②③」序号已去掉; 顺序由右侧抓手**拖动**调整(初版的 ↑↓ 已按雪糕要求撤掉)。
    function drawRows() {
      var h = "", pos, i;
      // v10.19: 7 → CARD_N。v10.13 加色板卡时这里漏改, 设置弹层永远只显示前七张卡,
      //   色板开关不出现在列表里 ⇒ 默认关且无法打开(雪糕截图定位)。
      for (pos = 0; pos < CARD_N; pos++) {
        i = CARD_ORDER[pos];
        h += '<div class="set-row' + (pos === dragPos ? " dragging" : "") + '">' +
          '<label class="set-ck"><input type="checkbox" id="ck' + (i + 1) + '">' +
          "<span>" + esc(CK_NAMES[i]) + "</span>" +
          // v10.31: 叠印滑块挂在卡名 span **之后**、label 之内(雪糕点名: 放到"叠印"文案后面)。
          //   独立节点不受卡名省略号影响 —— 长卡名让位省略, 滑块始终可见。
          // v11.94(审查): 4 -> CARD_OVP。原先是裸数字 6, v11.63 卡号前移后没跟着改,
          //   滑块整整错挂在「色板」行上两轮版本(见 CARD_OVP 那处注释)。
          (i === CARD_OVP ? ovpSeg() : "") + "</label>" +
          '<span class="grip" data-grip="' + pos + '" title="按住拖动，调整卡片上下顺序"></span></div>';
      }
      list.innerHTML = h;
      for (pos = 0; pos < CARD_N; pos++) {
        (function (idx) {
          var box = $("ck" + (idx + 1));
          if (!box) return;
          box.checked = CARD_CK[idx];
          // v10.37: 只改内存(不 ckSave) —— 落盘统一由「确认」做, 「关闭」回滚
          box.onchange = function () { CARD_CK[idx] = box.checked; };
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
      // v10.37: 不 orderSave —— 顺序落盘统一由「确认」做
      drawRows();
    }
    // v11.39: 拖拽收尾兜底。
    //   CEP 面板是**独立窗口**: 光标拖出面板边界再松手时, 面板的 document 收不到 mouseup
    //   ⇒ endDrag 永不执行 ⇒ mousemove 监听常驻。之后用户以为早松手了, 在设置列表里
    //   随便挪一下鼠标卡片顺序就跟着跳, 直到下一次点击才停。
    //   两条兜底: ① 窗口失焦(切到 AI 画布/别的面板)立即收尾; ② mousemove 里发现
    //   按键已经全抬起(buttons===0)也收尾 —— 兜住"没收到 up 事件"的所有情形。
    try { window.addEventListener("blur", function () { endDrag(); }); } catch (eBl) {}
    list.addEventListener("mousedown", function (e) {
      var t = e.target;
      if (!t || !t.getAttribute || t.getAttribute("data-grip") === null) return;
      var p = parseInt(t.getAttribute("data-grip"), 10);
      if (isNaN(p) || p < 0 || p > CARD_N - 1) return;
      dragPos = p;
      drawRows();          // 让被拖的那行带上 .dragging
      e.preventDefault();  // 别顺手选中文字
      dragMove = function (ev) {
        // v11.39: 按键已全部抬起却还在收 mousemove ⇒ 那次 mouseup 丢了, 就地收尾
        if (ev && typeof ev.buttons === "number" && ev.buttons === 0) { endDrag(); return; }
        if (dragPos < 0) return;
        var to = posFromY(list, ev.clientY);
        if (to < 0 || to > CARD_N - 1) return;
        // v11.21(外审 #1): 位置**没变就不重建** —— 原先 drawRows() 在 if 外面, 每次
        //   mousemove(哪怕只移了 1px)都要重建整个列表 innerHTML + 重绑 9 个 onchange,
        //   拖动时肉眼可见发涩。只有跨过一行边界才需要重建。
        if (to !== dragPos) {
          CARD_ORDER = orderMove(CARD_ORDER, dragPos, to);
          dragPos = to;
          drawRows();
        }
      };
      dragUp = function () { endDrag(); };
      document.addEventListener("mousemove", dragMove);
      document.addEventListener("mouseup", dragUp);
    });

    // v10.1: 阈值输入 —— 数值来自 jsx 下发的默认值/上次生效值
    // v11.7(雪糕): 数字**居左**; 结构从 label 换成 div + label[for](label 内不放控件那条铁律)。
    // v11.9(雪糕): "去掉 ▲▼ 这个吧，感觉没啥用" —— 自绘箭头整套撤掉, 只剩纯输入框。
    //   原生 spinner 仍然 `-webkit-appearance: none` 藏着(见 style.css), 但 type=number 保留:
    //   ↑↓ 键、滚轮缩放、min/step 校验都还在, 只是不画那两个按钮。
    function drawTh() {
      var el = $("setTh");
      if (!el) return;
      var h = "", i, j, f;
      for (i = 0; i < TH_FIELDS.length; i++) {
        f = TH_FIELDS[i];
        h += '<div class="th-row">' +
          // v11.114: label 上的 title 来自 TH_FIELDS 的 hint(目前只有 inkWarn 有)。
          //   ⚠ 前半段 '<label class="th-name" for="th_' 必须保持原样 —— bt68 拿它做形态断言。
          '<label class="th-name" for="th_' + f.k + '"' +
          (f.hint ? ' title="' + esc(f.hint) + '"' : "") + ">" + esc(f.label) + "</label>" +
          '<input type="number" class="th-in" id="th_' + f.k + '"' +
          // v10.46(审查 P1-2 次要问题): min 0 -> 1 —— jsx 的 pfThApply 对 <=0 的值
          // 逐项回落默认(填 0 = 静默用默认值, 无任何提示); 想回默认直接清空
          // (缺项留空 = 回落默认, 语义一致且可见)。
          // v11.22: 由写死 1 改为**按字段**取 f.min —— 见 TH_FIELDS 上方的说明。
          ' step="' + f.step + '" min="' + f.min + '">' +
          // v10.1: 单位列**无条件**生成(空就空着) —— 否则没单位的两行少一个节点,
          //   在 flex space-between 下输入框会被推到更靠右, 7 行左边界就不齐了。
          '<span class="th-unit">' + (f.unit || "") + "</span>" +
          "</div>";
      }
      el.innerHTML = h;
      for (j = 0; j < TH_FIELDS.length; j++) {
        (function (k) {
          var inp = $("th_" + k);
          if (!inp) return;
          inp.onchange = function () { onThChange(k, inp); };
          // v11.39: 失焦补一次重填 —— onThChange 里的 fillDraftInputs 会跳过
          //   当前聚焦的输入框(v10.46 P1-2, 为了不打断输入), 但 v10.46 的注释假设的
          //   "失焦时会重填"这条路径**根本不存在**(没人监听 blur) ⇒ 焦点框的值永远不刷新,
          //   联动纠正的结果看不清; 清空后也不会显示回落到的默认值。这里把这条路补上。
          inp.onblur = function () { onThChange(k, inp); fillDraftInputs(); };
        })(TH_FIELDS[j].k);
      }
    }

    drawRows();
    drawTh();
    fillDraftInputs();

    var gear = $("btnSet");
    if (gear) gear.addEventListener("click", function () {
      // v10.37: 进场快照 —— 三项即时项的"当时值", 供「关闭」整体回滚
      // v10.43(P1-b): 每次进场先把叠印草稿清空(上一次弹层可能改过没确认)
      SET_OVP = null;
      SET_SNAP = { ck: CARD_CK.slice(), order: CARD_ORDER.slice(), ovp: readOvpMode() };
      mask.classList.remove("hidden");
      thDraftInit();                    // 以"当前生效值"起稿
      drawRows(); drawTh(); fillDraftInputs();
      applyOvpModeUI(SET_SNAP.ovp);     // v10.37: 确保卡体显隐 / seg 选中态与快照一致
      // v10.1: 默认值要到 jsx 才拿得全, 改成**第一次打开弹层**才问 ——
      //   面板一打开就自动扫描, 那次 res.th 已经把阈值带回来了, 所以正常路径下这里同步返回,
      //   不再多跑一次 jsx 解析(初版放在启动时, 会和自动扫描各 evalFile 一遍)。
      // v11.6: 改成 **force 每次重取** —— pfThDefaults 只是把常量表拷一份回传(不碰文档、
      //   不 evalFile), 代价可以忽略; 换来的是"TH_DEF 一旦被污染(旧版 v11.5 及以前的写法)
      //   打开一次设置就自愈", 不必让用户重启面板。
      thEnsure(function () {
        if (!TH_DEF) return;
        // v11.6: 回调是异步的 —— 用户若已开始输入, 别把他的手输值盖回默认
        if (TH_DIRTY) return;
        // v11.39: 正在打字(change 还没触发 ⇒ TH_DIRTY 仍是 false)时不能重绘,
        //   否则 drawTh() 重建 innerHTML 会把手输值连同光标一起抹掉。改为只补空缺项。
        if (thFocusedKey()) { thDraftFillGaps(); return; }
        thDraftInit(); drawTh(); fillDraftInputs();
      }, true);
    });
    // v10.1: 「确认」= 草稿落盘并关闭(阈值不会边打边存)
    var okSet = $("setOk");
    if (okSet) okSet.addEventListener("click", function () {
      closeSet(true);   // v10.37: 落盘(卡片开关 / 顺序 / 叠印版本 / 阈值)
      showNotice("设置已保存，点「开始检查」查看新结果。");
    });
    // v10.2: 「重置默认」点下**直接重置**(雪糕要求去掉确认弹窗) ——
    //   重置后仍停在设置弹层里, 开关/顺序/阈值一眼看得见全回到默认, 所以不需要再问一句。
    var rstSet = $("setReset");
    if (rstSet) rstSet.addEventListener("click", function () {
      thResetAll();
      drawRows(); drawTh(); fillDraftInputs();
      // v10.37: 重置只改草稿 ⇒ 提示改为"尚未保存"
      // v11.6: 默认值没拿到时 thDraftInit 会回落当前生效值(等于没重置) —— 明说, 不假装成功
      showNotice(TH_DEF ? "已恢复默认(尚未保存)，点「确认」保存。"
                      : "未能读取默认阈值，请重新打开面板后再试一次。");
    });
    // v10.37: 关闭 / 点遮罩 / Esc 一律**回滚**(closeSet(false)) —— 与「确认」明确区分
    var clo = $("setClose");
    if (clo) clo.addEventListener("click", function () { closeSet(false); });
    mask.addEventListener("click", function (e) { if (e.target === mask) closeSet(false); });
    // v10.2: 重置不再弹确认框 ⇒ 去掉原先"ESC 先让位给确认框"那层判断(设置弹层里不会再压别的弹层)
    document.addEventListener("keydown", function (e) {
      if (e.keyCode === 27 && !mask.classList.contains("hidden")) closeSet(false);
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
  // v11.39: 扫描轮次号 —— 跨轮次竞态的唯一判据。
  //   现象: 连点两次「开始检查」, 或第一次超时(scanBusy 已被 graceTimer 强解锁)后
  //   第二次已开跑, 而**第一轮**的 evalScript 回调这时才到 —— 它会无条件执行
  //   scanBusy=false / 恢复按钮 / 用旧 payload 覆盖界面, 把第二轮的状态与结果打乱,
  //   还会在第二轮仍在跑时把按钮放开(用户能再点出第三轮)。
  //   修法: 每次 run() 领一个号, 回调首句比对, 不是最新一轮就直接丢掉。
  //   (与 v11.6 给设置弹层加的 TH_DIRTY 是同一类问题, 那次只护了草稿。)
  var scanSeq = 0;

  // v10.42: 高度占位 —— 防"点完按钮页面跳回最上面"(雪糕反馈)。
  //   根因: run() 一进来就把 #results / #foot 清空, 文档高度瞬间塌到只剩顶栏,
  //     浏览器随即把 scrollTop 夹回 0(滚动位置就此丢失); 几十~几百毫秒后结果回填、
  //     高度恢复, 但位置已经回不去了 ⇒ 表现为"点一下按钮, 页面跳回顶部"。
  //   修法: 清空前把两者当前高度锁成 min-height 占位, 渲染完成后再撤掉 ——
  //     全程高度不塌 ⇒ 滚动位置天然保持。
  //   ⚠ 不用"记忆 scrollTop 再 scrollTo 回填": 那样在清空→回填之间会出现
  //     "先跳到顶、再跳回来"的可见闪动(扫描耗时越长越明显), 比现在更糟。
  function holdHeight(el) {
    if (!el) return;
    try { el.style.minHeight = el.offsetHeight + "px"; } catch (eH) {}
  }
  function releaseHeight(el) {
    if (!el) return;
    try { el.style.minHeight = ""; } catch (eR) {}
  }
  // v8.8: 加 keepError —— 一键操作失败时 execAction 先 showError 再刷新结果，
  //   而 run() 一进来就把 #error 加 hidden ⇒ 失败原因瞬间被抹掉、用户只看到新一轮结果。
  function run(keepNotice, keepError) {
    if (!inCEP()) {
      showError("未检测到 CEP 环境。此页面需在 Illustrator 的扩展面板中运行。");
      return;
    }
    if (scanBusy) { showNotice("正在检查中，请稍候再试。"); return; }
    scanBusy = true;
    var mySeq = ++scanSeq;   // v11.39: 本轮号 —— 两枚计时器与回调都要据此判归属
    $("btnRun").disabled = true;
    $("loading").classList.remove("hidden");
    // v10.35: 删掉此处的**无条件**隐藏 —— 它把下方 `if (!keepError)` 直接废掉,
    //   v8.8 加 keepError 时漏删这一行 ⇒ 一键操作失败(转曲/嵌入/清叠印)时 execAction 刚
    //   showError 的红条, 被随后的 run(true,true) 一进来就抹掉, 用户看不到失败原因、重复操作。
    //   现在只有 keepError 为假才隐藏(手动点"开始检查"时仍清残留)。
    // v5.2: 顺带清掉残留的旧成功提示,避免绿条挂在新一轮结果上
    // v8.0: 操作后刷新时保留(keepNotice=true)
    if (!keepNotice) $("notice").classList.add("hidden");
    if (!keepError) $("error").classList.add("hidden");
    // v10.42: 清空前先占住高度, 否则页面塌高 ⇒ 滚动位置被夹回顶部(见 holdHeight 注释)
    holdHeight($("results"));
    holdHeight($("foot"));
    $("results").innerHTML = "";
    $("foot").innerHTML = "";

    var timedOut = false;
    var graceTimer = null;
    var timer = setTimeout(function () {
      if (mySeq !== scanSeq) return;   // v11.39: 已经不是本轮了 —— 别去动新一轮的按钮/提示
      timedOut = true;
      $("loading").classList.add("hidden");
      // v5.2 修复: 超时后必须恢复按钮,否则"开始检查"永久禁用,只能重开面板
      $("btnRun").disabled = false;
      // v8.1: 措辞改为"仍在继续" —— ExtendScript 无多线程,JSX 一旦开跑就停不下来;
      //   旧版在此宣告超时、回调又 `if (timedOut) return` 把已算完的结果丢掉 ⇒ 白转一场。
      showError("检查时间较长(超过 " + (BUSY_TIMEOUT_MS / 1000) + " 秒)。文档对象可能较多，后台仍在继续，完成后会自动显示结果。");
      // v10.60: 兜底解锁 —— 这里**不立即** scanBusy=false: 那是 v8.6 的"防双扫"
      //   口径(jsx 停不下来, 期间放行会让两次扫描各自渲染一遍)。但若 jsx 真挂死
      //   (回调永不返回), scanBusy 会永久为真 ⇒ 按钮虽已恢复、点下去只弹"正在检查中",
      //   面板等于锁死。故再挂一枚宽限计时器: 宽限期内回调到达即被 clearTimeout(见回调开头);
      //   仍未回 ⇒ 强解锁, 面板恢复可用(代价是极端情况可能多渲染一次, 可接受)。
      // v11.39: 兜底解锁也判轮次 —— 否则上一轮的宽限计时器会在新一轮跑到一半时
      //   把 scanBusy 放掉(紧接着就可能被第三次点击插队)。
      graceTimer = setTimeout(function () { if (mySeq === scanSeq) scanBusy = false; }, BUSY_TIMEOUT_MS);
    }, BUSY_TIMEOUT_MS);

    SCAN_CK = CARD_CK.slice(0); // v10.0: 记录本轮扫描用的开关快照(渲染占位卡按它判)
    // v10.1: 第 8 参 = 阈值串(空串则由 jsx 用 PF_TH_DEF 默认值)
    execJsx("runPreflight(" + ckArgs() + "," + thArg() + "," + swArg() + "," + txArg() + "," + stArg() + ");", function (data, raw) {
      // v11.39: 过期轮次的迟到回调 —— 只收掉自己那两枚计时器, 其余一概不碰。
      //   碰了就会把新一轮的 scanBusy / 按钮 / loading / 结果打乱(见 scanSeq 处的说明)。
      if (mySeq !== scanSeq) {
        clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
        return;
      }
      // v8.1: 不再因超时丢弃迟到的结果 —— 照常渲染,并补一条"耗时较长"提示
      scanBusy = false;   // v8.6: 必须先解锁再分支 —— 下面有提前 return,漏了就锁死面板
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);   // v10.60: 撤掉超时兜底计时器
      $("btnRun").disabled = false;
      $("loading").classList.add("hidden");
      // v10.43: 成败两条路都要撤占位 —— 包一层 try/finally。
      //   失败分支的 return 原先直接跳过释放, #results 会留着上一轮高度的
      //   min-height, 下轮清空后成为"空高块", 又把滚动位置钉在错误的位置。
      try {
        if (!data || !data.ok) {
          showError((data && data.error) ? data.error
          : ("脚本执行失败。请确认扩展目录中的 jsx/preflight.jsx 存在。返回: " +
               String(raw).substring(0, 120)));
          return;
        }
        try {
          render(data);
          if (timedOut) showNotice("检查耗时较长，结果已更新。");
        } catch (renderErr) {
          showError("渲染出错 [" + JS_BUILD + "]: " + renderErr.message);
        }
      } finally {
        releaseHeight($("results"));
        releaseHeight($("foot"));
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

  // ---------- 油墨样本行渲染(⑫ 拆分后两张卡共用) ----------
  // v11.1(审查 ⑫): 这 4 个工具原本嵌在第 6 张卡(油墨)里, 但第 7 张卡(叠印)也要用
  //   inkRows —— 拆 render 时立刻报 "inkRows is not defined"。它们是纯函数(只吃样本 + 阈值),
  //   提到闭包级后两张卡共用一份, 顺带让"列对齐 / 合并计数 / 截断提示"只有一处实现。

  // v11.39: 删掉 NBSP / padInkDesc / markLightChannels 三个函数。
  //   它们是 v6.3「四色分量用 U+00A0 补齐到 4 字符」和 v7.6「过浅分量标白」的**旧实现**,
  //   服务的是 ul.list 的等宽文本行。v11.24 油墨卡改成 ul.ink-tbl 表格后, 定宽对齐改由
  //   CSS 逐列<i>负责(inkSegs / inkCvCell), 标白也搬到了 inkSegs —— 这条文本分支
  //   从此不可达(inkRows 的三个调用点全部传 tbl 真值), 三件套成了纯死代码。
  //   ⚠ 功能没有丢: 标白仍在 inkSegs(第 2 参 markLight)、列对齐仍在 .ik-cv > i。
  //   ⚠ 配套删掉了 ink-align.js 里对这三个函数的抽取式断言(那套前提已不存在)。
  // v11.24: 油墨卡色块 —— CMYK 描述转屏幕近似色(减色模型)。
  //   ⚠ 只用于"看个深浅"，不做颜色管理；纯黑 K100 在深底上看不见，故另给浅一档边框。
  function inkCssColor(desc) {
    var g = function (k) {
      var mm = new RegExp(k + "(\\d+(?:\\.\\d+)?)").exec(desc || "");
      return mm ? parseFloat(mm[1]) / 100 : 0;
    };
    var C = g("C"), M = g("M"), Y = g("Y"), K = g("K");
    var f = function (v) { return Math.round(255 * (1 - v) * (1 - K)); };
    return "rgb(" + f(C) + "," + f(M) + "," + f(Y) + ")";
  }
  function inkBorderOf(desc) {
    var mm = /rgb\((\d+),(\d+),(\d+)\)/.exec(inkCssColor(desc));
    if (!mm) return "#4a4a4a";
    var lum = 0.299 * (+mm[1]) + 0.587 * (+mm[2]) + 0.114 * (+mm[3]);
    return lum < 70 ? "#8a8a8a" : "#4a4a4a";   // 近黑的色块用浅一点的边框, 否则在 #1b1b1b 上看不见
  }
  // v11.27: 色值单元格 —— 有 CMYK 就拆 4 列定宽, 否则(线宽)整串一格
  function inkCvCell(desc, hasC, markLight) {
    var segs = hasC ? inkSegs(desc, markLight) : null;
    if (!segs) return '<span class="ik-cv ik-cv1">' + esc(desc) + "</span>";
    var out = '<span class="ik-cv">', i;
    for (i = 0; i < segs.length; i++) out += "<i>" + segs[i] + "</i>";
    return out + "</span>";
  }

  // v11.27: 把 "C40 M30 Y30 K100" 拆成 4 段，供表格**逐列定宽**对齐。
  //   旧表格版直接输出整串 ⇒ 因为不是等宽字体, "C0" 和 "C100" 后面的 M 起始位置对不齐。
  //   现在每个分量一个 <i>, CSS 给固定宽度, 四列严格对齐。(markLight 的标白仍然保留)
  function inkSegs(desc, markLight) {
    var mm = /^C(\d+) M(\d+) Y(\d+) K(\d+)$/.exec(String(desc == null ? "" : desc));
    if (!mm) return null;
    var lim = thv("light");
    var ok = (typeof lim === "number" && isFinite(lim) && lim > 0);
    var out = [], i, f, v;
    for (i = 1; i <= 4; i++) {
      f = "CMYK".charAt(i - 1) + mm[i];
      v = parseInt(mm[i], 10);
      out.push((markLight && ok && v > 0 && v < lim) ? '<b class="ink-w">' + f + "</b>" : esc(f));
    }
    return out;
  }

  // v11.24(B2): 一行 = [色块/线] 位置 色值 数值 ×数量。
  //   ① 填充画**实心圆点**、描边画**圆头短线** —— 形状即语义，不用再读"填充/描边"这四个字。
  //   ② 线宽块(desc 是 "0.06mm" 这种) 没有色值，线高按粗细取 1px / 2px。
  //   ③ 来源 [文字]/[图形] 与对象名移到 title：360 宽下塞不下，且这两项对判断影响小。
  function inkLi(srcLabel, s, markLight, n) {
    if (typeof s === "string") s = { name: "", where: "", desc: s };
    var d = String(s.desc === undefined ? "" : s.desc);
    var hasC = /^C/i.test(d);
    var mk;
    if (hasC) {
      var col = inkCssColor(d);
      // v11.40: 描边色短线补上与圆点同款的 1px 边框 —— v11.24 只给圆点做了"近黑换浅边"
      //   (见 978 行注释), 短线漏了 ⇒ K100 这类近黑描边在 #1b1b1b 卡底上直接融进去,
      //   只能靠后面的 CMYK 数字猜。边色仍走 inkBorderOf(), 与圆点同一套判断。
      //   ⚠ 高度 2 -> 4 配 border-box: 内容仍是 2px 本色(粗细不变), 上下各 1px 让给边框;
      //     行盒是 18px(.ink-tbl li 的 line-height), 4px 撑不起来 ⇒ 零位移。
      //   ⚠ 写内联不新开类: ink-align.js 有 indexOf('class="ik-line"') 精确断言和
      //     /ik-dot|ik-line/g 计数断言, 加类名会让两条误报。
      //   ⚠ 内联顺序 background 在前: bt85 靠"内联以 height 起头"这个特征认出线宽块,
      //     彩色描边若也以 height 起头, 那条断言会认错对象。
      mk = (s.where === "\u63cf\u8fb9")
        ? '<i class="ik-line" style="background:' + col + ';height:4px;box-sizing:border-box;border:1px solid ' + inkBorderOf(d) + '"></i>'
      : '<i class="ik-dot" style="background:' + col + ';border-color:' + inkBorderOf(d) + '"></i>';
    } else {
      var mmp = parseFloat(d);
      if (isNaN(mmp)) mmp = 0;
      mk = '<i class="ik-line" style="height:' + (mmp >= 0.08 ? 2 : 1) + 'px;background:#b6b6b6"></i>';
    }
    // v8.0: jsx 的分档改用 CMYK 原值求和(带小数),这里显示时统一四舍五入回整数
    var tail = s.total !== undefined ? "= " + Math.round(s.total) : "";
    var cnt = (n && n > 1) ? "\u00d7" + n : "";
    var src = "[" + srcLabel + "] ";
    var nm = s.name ? s.name + " " : "";
    // v11.25: 文字用的是"字色", 不能显示成"填充" —— 只有图形才分填充/描边
    var whTxt = (srcLabel === "文字") ? (s.where === "描边" ? "描边" : "文字") : (s.where || "");
    var wh = whTxt ? whTxt + " " : "";
    var title = src + nm + wh + d + (tail ? " " + tail : "") + (cnt ? " " + cnt : "");
    return '<li title="' + esc(title) + '">' + mk +
      '<span class="ik-wh">' + esc(whTxt || "\u2014") + "</span>" +
      inkCvCell(d, hasC, markLight) +
      '<span class="ik-vl">' + esc(tail) + "</span>" +
      '<b class="ik-n">' + esc(cnt) + "</b></li>";
  }
  // 问题块标题: 名称 N 处
  // v6.4: 改"数字染色"——标题文字取常规色,只有计数 N 上黄/红(与全站规则一致)
  // v7.0: 第 4 参 hint 为样本截断提示,渲染在标题同一行最右(不带括号)
  // v11.53: 第 5 参 sub = 该块的定位子类型(over/heavy/light/thin, 见 inkLocBtn)。
  //   按钮紧跟在"N 处"后面(雪糕框的位置), 不是最右侧 —— 最右侧留给截断提示。
  // v11.54: 按钮从 .row-t **里面**挪到外面, 成为 .ink-block 的兄弟节点。
  //   原因: 窄面板(≤280px)下 22px 的按钮会把「油墨总量220~300」挤成两行(实测 40px);
  //   而要让标题"省略号降级"就必须给 .row-t 加 overflow:hidden —— 按钮在它内部
  //   会被一起裁掉。挪出来之后: .row-t 可缩可省略, 按钮恒 16px 不被裁,
  //   .row-h 仍靠 margin-left:auto 贴右。间距由 .ink-block 的 gap:8px 提供。
  // v11.61(雪糕选 B): 量词 处 -> 个。这几块数的是**图形/对象**, 中文里"个"才对;
  //   "处"留给"位置数"(叠印、字号线这类按落点数的地方)。
  //   所以下面四处的 capHint 也一并 处 -> 个, 否则标题说"3 个"、右边提示却说"仅列出前 20 处"。
  function inkBlock(name, n, lvl, hint, sub) {
    return '<div class="ink-block"><span class="row-t">' + esc(name) + ' <b class="' +
      (lvl === "bad" ? "bad-t" : "warn-t") + '">' + n + "</b> 个</span>" +
      (sub ? inkLocBtn(sub) : "") +
      (hint ? '<span class="row-h">' + esc(hint) + "</span>" : "") + "</div>";
  }
  // v11.53: 卡⑥ 每块自己的定位按钮 —— 只选中**这一块**的问题对象。
  //   雪糕: "油墨那块的选择不要放在徽标左侧，放到我框起来的地方，每个选择是选当前的内容，
  //          例如描边的只选描边的"。
  //   卡⑥ 原来只有卡头一颗按钮、选的是四块的并集；块内各一颗之后,
  //   "描边<0.1mm" 那颗只选描边过细的图形、"色版<5%" 那颗只选色版极浅的,
  //   不会再一锅端。
  //   ⚠ sub 走 data-sub 传回 onLocate —— 白名单校验在 onLocate 里, 这里只管发。
  //   ⚠ 图标与卡头那颗同一 path/同一 viewBox, 只是显示 12×12(16px 盒)。
  //   ⚠ v11.55 同上: viewBox 按**墨迹形心**对称, 不是按包围盒 —— 详见 locateBtn 注释。
  // v11.63: 把卡⑥ 的块内定位按钮抽成通用版 —— 合并后的「图片」卡要在两段各放一颗
  //   (4 = 未嵌入的链接图, 5 = 分辨率偏低的图)。svg 与几何必须与卡⑥ 完全一致。
  //   v11.65(雪糕): 9 -> 12(与卡头那颗同比例放大)。盒子仍是 16×16、vertical-align 仍 0
  //     ⇒ 行盒仍 20px, 卡⑥ 四块与图片卡两段的行高一个像素都不动。
  function locBtnAt(n, sub, tip) {
    return '<button class="ink-loc" data-locate="' + n + '"' +
      (sub ? ' data-sub="' + sub + '"' : "") +
      ' title="' + esc(tip || "只选中这一块的问题对象 (锁定/隐藏的只提示位置，不改状态)") + '">' +
      '<svg viewBox="-52.5 63.8 881.4 932.6" width="12" height="12" aria-hidden="true">' +
      '<path fill="currentColor" d="M828.9 697.6L643.3 512 195.1 63.8v896.4l262.5-262.6z"/>' +
      '</svg></button>';
  }
  function inkLocBtn(sub) {
    return locBtnAt(6, sub, "");
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
  function inkRows(rows, cap, tbl) {
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
    // v11.75(雪糕选 A): 输出全部组, 第 cap+1 组起由 pfExpandHtml 加 hidden 折叠;
    //   shown 仍只累计默认可见的前 cap 组 —— 截断提示的判断口径不能跟着变。
    var use = order;
    var out = '<ul class="' + (tbl ? "ink-tbl" : "list") + '">', shown = 0;   // v11.24: 油墨卡用表格, 叠印卡保持 list
    for (i = 0; i < use.length; i++) {
      g = map[use[i]];
      if (!cap || i < cap) shown += g.n;
      out += inkLi(g.l, g.s, g.ml, g.n);   // v11.39: 第 5 参 tbl 已删(那一支不可达)
    }
    out += "</ul>";
    return { html: out, shown: shown };
  }

  // ---------- 渲染 ----------
  // ---------- v11.75(雪糕选 A): 样本名单「默认 5 条 + 卡内展开全部」 ----------
  // v11.76(雪糕选 B): 展开控件从「独占一行的文字按钮」改成标题行折角箭头, 零新增行高。
  // v11.77(雪糕改选 C): 箭头从标题行最左挪到最右(与卡内定位三角错开)。
  //   仍用 B 的「标题行注入 SVG」, 不退回方案页 C 的负外边距 + 伪元素硬提回上一行:
  //   ⚠ 不能靠 .row-t 撑开: .ink-block .row-t 是 flex:0 1 auto, 不吃剩余宽度;
  //     也不能靠 float: flex item 上 float 被忽略, 普通 div 里 float 箭头还会掉出行盒。
  //   ⇒ 标题行统一 flex, 箭头 margin-left:auto 吃剩余宽度; 已有 .row-h(截断提示,
  //     自带 margin-left:auto)的行改挂 pf-exp-after-h, 免得两个 auto 平分空间。
  //   整行标题就是控件, 零新增行高。字体卡的「未转曲文本框 N 个」本来就是标题行,
  //   不许再补「样本名单」之类的占位行。
  // jsx 侧名单采集上限已提到 PF_SAMPLE_MAX(软封顶), 这里**只管显示**:
  //   · 每个 ul.list / ul.ink-tbl 的第 cap+1 条起加 hidden + data-pf-x, 默认折叠;
  //   · 有折叠行的名单, 把箭头注入它**紧邻的标题行 div** 内部末尾(</div> 之前);
  //   · 展开用 JS 直接移除 hidden 属性, 不切 class、不重绘、不重发跨桥。
  // ⚠ 这是**字符串级**后处理: 预览沙箱没有真 DOM, 但它也要拿到增强后的 HTML。
  //   两步走: ① 先折叠所有 ul(不管有没有标题行, 名单都能收); ② 再给有折叠行的
  //   名单配对标题行并注入箭头。标题行限定为不含嵌套 div 的最内层行, 免得从
  //   .card 开头一路吞到名单。
  // ⚠ v11.79: capHint 已停用、row-h 不再渲染; inkRows 的截断计数口径仍一个字不改。
  var PF_EXPAND_ARROW =
    '<button type="button" class="pf-exp-arrow" data-pf-expand="1" ' +
    'title="展开全部" aria-label="展开全部">' +
    '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<polyline points="3,1 7,5 3,9"/></svg></button>';
  function pfDefaultShow() {
    var c = thv("cap");
    return (typeof c === "number" && isFinite(c) && c > 0) ? c : 5;
  }
  function pfExpandHtml(html) {
    var cap = pfDefaultShow();
    var src = String(html).replace(/<ul class="(?:list|ink-tbl)"[^>]*>[\s\S]*?<\/ul>/g, function (block) {
      var n = 0;
      var out = block.replace(/<li\b/g, function (tag) {
        n++;
        return n > cap ? '<li hidden data-pf-x' : tag;
      });
      if (n <= cap) return out;
      return out.replace(/^<ul class="([^"]*)"/, '<ul class="$1 pf-has-more"');
    });
    return src.replace(
      /(<div(?:\s[^>]*)?>(?:(?!<\/?div)[\s\S])*?<\/div>)\s*(<ul class="[^"]*pf-has-more[^"]*"[^>]*>)/g,
      function (m, head, ulOpen) {
        var out = head.replace(/<\/div>$/, PF_EXPAND_ARROW + "</div>") + ulOpen;
        // 有截断提示时 .row-h 自己带 margin-left:auto, 箭头不能再抢 auto(会平分空间
        //   把提示挤到行中间); 改成只跟 6px, 让「提示 + 箭头」一起被推到右侧。
        return /class="row-h"/.test(head)
          ? out.replace('class="pf-exp-arrow"', 'class="pf-exp-arrow pf-exp-after-h"')
        : out;
      });
  }
  function pfCardKey(card) {
    var h = card.querySelector ? card.querySelector(".card-head > span:first-child") : null;
    return h ? String(h.textContent || "") : "";
  }
  function pfSetCardOpen(card, open) {
    var rows = card.querySelectorAll ? card.querySelectorAll("[data-pf-x]") : [];
    var i;
    for (i = 0; i < rows.length; i++) {
      if (open) rows[i].removeAttribute("hidden"); else rows[i].setAttribute("hidden", "");
    }
    if (card.classList) {
      if (open) card.classList.add("pf-expanded"); else card.classList.remove("pf-expanded");
    }
    // v11.75: 一张卡可能有多段名单(如图片卡的链接图 / 低清图), 每段前各有一枚按钮,
    //   必须整卡一起改文案, 否则只有第一枚变「收起」, 其余仍写「展开全部」会误导。
    // v11.76(B): 控件里是 SVG, 写 textContent 会把图标冲掉 —— 只换悬停/无障碍文案。
    var btns = card.querySelectorAll ? card.querySelectorAll("[data-pf-expand]") : [], b;
    for (b = 0; b < btns.length; b++) {
      btns[b].setAttribute("title", open ? "收起" : "展开全部");
      btns[b].setAttribute("aria-label", open ? "收起" : "展开全部");
    }
    // v11.79: 样本上限提示整体停用 ⇒ 不再有 .row-h, 展开态也不再改「已显示全部」。
  }
  function pfSaveExpanded() {
    try {
      var cards = document.querySelectorAll ? document.querySelectorAll(".card.pf-expanded") : [], keys = [], i;
      for (i = 0; i < cards.length; i++) {
        var k = pfCardKey(cards[i]);
        if (k) keys.push(k);
      }
      localStorage.setItem(PF_EXPAND_KEY, keys.join("\u0001"));
    } catch (e) {}
  }
  function pfRestoreExpanded() {
    try {
      var saved = String(localStorage.getItem(PF_EXPAND_KEY) || "");
      if (!saved) return;
      var set = {}, parts = saved.split("\u0001"), i;
      for (i = 0; i < parts.length; i++) set[parts[i]] = 1;
      var cards = document.querySelectorAll ? document.querySelectorAll(".card") : [], j2;
      for (j2 = 0; j2 < cards.length; j2++) {
        if (set[pfCardKey(cards[j2])]) pfSetCardOpen(cards[j2], true);
      }
    } catch (e) {}   // 预览沙箱没有 querySelectorAll 时静默跳过, 不能让它带崩整次 render
  }
  function onExpandToggle(btn) {
    var card = btn.parentNode;
    while (card && !(card.classList && card.classList.contains("card"))) card = card.parentNode;
    if (!card) return;
    pfSetCardOpen(card, !card.classList.contains("pf-expanded"));
    pfSaveExpanded();
  }

  function render(d) {
    lastDocKey = docKey(d); // v5.6: 记录文档指纹,供焦点切换比对
    LAST_SCAN = d;          // v11.104: 供各确认框报数量
    // v10.1: 阈值随结果一起回传(jsx 的 PF_TH_DEF 是唯一真源) —— 面板只显示, 不保存默认值。
    //   d.th 缺失(极旧的 jsx 缓存)时沿用上次生效值; 都没有则显示 "?" 而不是猜一个数字。
    // v11.6: ⚠ 只更新生效值, **不再**顺手写 TH_DEF。d.th 是"生效值"(用户改动已叠加在上),
    //   不是出厂默认 —— 原 `if (!TH_DEF) TH_DEF = d.th` 把它当默认值, 且 `!TH_DEF` 保证
    //   只写一次、永不更正 ⇒ 用户改过的阈值就此变成"默认值", 「重置默认」重置到自己的值。
    //   (雪糕 2026-10-20 真机: 油墨超标 301 / 色版 20 / 描边 1 三项点重置纹丝不动。)
    //   TH_DEF 的唯一来源 = jsx 的 pfThDefaults(), 见 thEnsure()。
    if (d && d.th) { PF_TH = d.th; }
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
          (d.symbols.truncated ? "(仅列出前 " + thv("scan") + " 个)"
          : (d.symbols.scanned ? "(已检查内部内容)" : "(内部不可访问)")) + "</span>" : "") +
      // v11.100: 分段耗时 —— 只在总数上露一个数。
      //   雪糕反馈"有时候打开文件跑脚本会卡好几分钟", 光看总数分不清是遍历卡、读图卡还是
      //   字体卡; 有了这行就能一眼定位, 也方便把明细发回来。
      //   d.ms 是 [[段名, 累计毫秒], ...], 两两相减得各段。
      // v12.4(雪糕): 明细从**原生 title 悬停**改成**点击展开的常驻行**。
      //   起因: 他要截图发人, 但一按 Alt(截图/取色)tooltip 就消失 —— 而且原生 tooltip 由
      //   系统绘制, 多数截图工具根本抓不到。换成页面内节点后能随便截, 还能选中复制。
      //   ⚠ 展开状态**不记忆**(雪糕选"不记住"): 每次 render 都从收起开始。
      //     故这里不能读任何 localStorage, 也不用给 .foot-ms-x 加持久化。
      //   ⚠ 段数会有 7~8 段(遍历/画板/色板/清理/专色/对照/后处理), 全铺开会折 3~4 行,
      //     所以默认收起是必须的, 不能图省事一直显示。
      (function () {
        if (!d.ms || !d.ms.length) return "";
        var arr = d.ms, i, prev = 0, parts = [], total = 0, seg;
        for (i = 0; i < arr.length; i++) {
          seg = arr[i][1] - prev;
          // 0.0s 的段也留着 —— "这段几乎不花时间"本身是有用信息(排除法用得上)
          parts.push('<span class="fms-seg">' + esc(arr[i][0]) + " " + (seg / 1000).toFixed(1) + "s</span>");
          prev = arr[i][1];
          total = arr[i][1];
        }
        // 明细默认 hidden; 靠 .foot-ms.open 加类展开(见下方 document 级事件委托)
        //   tabindex+role: 键盘也能 Tab 到、回车展开(与鼠标同一条 data-pf-ms 通路)。
        //   ⚠ 明细**不用 querySelector 去取** —— 老测试(bt136)的假 DOM 节点只实现了
        //     getAttribute/setAttribute, 没有 querySelector。用最近兄弟 + 属性判状态即可,
        //     真浏览器与假节点两条路都通, 也不用给测试补方法。
        return '<span class="fbuild foot-ms" data-pf-ms="1" tabindex="0" role="button" ' +
          'data-pf-open="0" title="点击展开各段耗时">耗时 ' +
          (total / 1000).toFixed(1) + 's<svg class="fms-arw" viewBox="0 0 10 6" aria-hidden="true">' +
          '<polyline points="1,1 5,5 9,1" fill="none" stroke="currentColor" ' +
          'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          "</span>" +
          // ⚠ 明细必须是外层 span 的**下一个兄弟** —— toggleMsDetail 用 nextElementSibling 取。
          //   放进 span 里面会取到 null(假 DOM 无 querySelector)。
          '<span class="fms-detail" hidden>' + parts.join("") + "</span>";
      })();

    var cards = [];   // v10.1: 每卡先各存一格(v10.13 起八张), 最后按 CARD_ORDER 拼接(见函数末尾)
    // v10.0: 按"本轮扫描用的开关快照"判定占位卡(扫描后又改勾选不会拿旧数据当新结果显示)
    var scanCk = SCAN_CK || CARD_CK;

    // v11.1(审查 ⑫): 八张卡各归一个函数 —— 原 690 行的 render 现在只剩 取数 / 顺序拼接 / 状态回填;
    //   每个 renderCardXxx 只吃 (d, scanCk) 两个参数, 与拆分前完全等价(输出逐字节不变)。

    // v11.39: 逐卡兜底 —— 原实现九张卡裸调用, 任一抛异常就整块 render 中断
    //   ⇒ 九张卡一起空白, 用户只看到"面板没反应"。而 jsx 少回一个字段(旧版缓存 /
    //   前置段扫描失败)就会命中: renderCardArtboard 直接读 d.artboards.length,
    //   卡④读 d.images.linked, 卡⑨读 d.black.xxx —— 其余卡都有 `|| []` 兜底, 这几处没有。
    //   现在单卡失败只废掉那一张, 并在卡内说明原因, 其余八张照常显示。
    function safeCard(fn, name) {
      try { return fn(d, scanCk); } catch (e) {
        var why = (e && e.message) ? e.message : String(e);
        return card(name, "bad", "渲染异常",
          '<div class="dim">这一卡的数据不完整，渲染时出错 —— ' + esc(why) +
          "。其余卡片不受影响，可先看其它卡。</div>");
      }
    }
    cards[0] = safeCard(renderCardArtboard, CK_NAMES[0]);
    cards[1] = safeCard(renderCardHidden, CK_NAMES[1]);
    cards[2] = safeCard(renderCardFont, CK_NAMES[2]);
    // v11.63: 图片嵌入 + 图片分辨率 合并成一张「图片」卡
    cards[3] = safeCard(renderCardImages, CK_NAMES[3]);
    cards[4] = safeCard(renderCardInkStroke, CK_NAMES[4]);
    cards[5] = safeCard(renderCardOverprint, CK_NAMES[5]);
    cards[6] = safeCard(renderCardSwatch, CK_NAMES[6]);
    cards[7] = safeCard(renderCardCleanup, CK_NAMES[7]);   // v11.16: 卡⑨「清理」；v11.63 起为第 8 张
    cards[8] = safeCard(renderCardSpotTrap, CK_NAMES[8]);  // v11.87: 卡⑨「专色描边」
    cards[9] = safeCard(renderCardSnapshot, CK_NAMES[9]);  // v11.90: 卡⑩「对照」

    // v10.1: 按 CARD_ORDER 拼接 —— 卡片上下顺序可在「设置」里拖动调整。
    //   ⚠ 只影响渲染顺序; 传给 jsx 的卡开关仍按固定卡序(ckArgs()+swArg()), 否则 c1..c9 会错位。
    var html = "", _oi;
    for (_oi = 0; _oi < CARD_ORDER.length; _oi++) html += (cards[CARD_ORDER[_oi]] || "");
    $("results").innerHTML = pfExpandHtml(html);
    pfRestoreExpanded();   // v11.75: 重绘后按存档恢复各卡展开态
    // v10.42: 新内容已就位 ⇒ 撤掉占位高度(此后高度由真实内容决定; 滚动位置全程未被夹动)
    releaseHeight($("results"));
    releaseHeight($("foot"));

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
    // v11.16: 卡⑨「清理」三个勾选项回填 + 持久化(与上面几个复选框同一套写法)
    var clS = $("clStray"), clU = $("clUnpaint"), clT = $("clText");
    if (clS) {
      clS.checked = CLEAN_CK.stray;
      clS.onchange = function () { CLEAN_CK.stray = clS.checked; cleanSave(); };
    }
    if (clU) {
      clU.checked = CLEAN_CK.unpainted;
      clU.onchange = function () { CLEAN_CK.unpainted = clU.checked; cleanSave(); };
    }
    if (clT) {
      clT.checked = CLEAN_CK.text;
      clT.onchange = function () { CLEAN_CK.text = clT.checked; cleanSave(); };
    }
    // v9.5: 叠印卡「解锁全部」回填 + 持久化(与转曲卡两个复选框同一套写法)
    var co = $("chkOvpUnlock");
    if (co) {
      co.checked = CHK_OVP_UNLOCK;
      co.onchange = function () {
        syncOvpUnlock(co.checked);
      };
    }
    // v11.91: 卡⑥ 四色黑块的「解锁全部」—— 同一套写法, 独立存档键
    var rbU = $("chkRbUnlock");
    if (rbU) {
      rbU.checked = CHK_RB_UNLOCK;
      rbU.onchange = function () {
        CHK_RB_UNLOCK = rbU.checked;
        try { localStorage.setItem("pf_chkRbUnlock", rbU.checked ? "1" : "0"); } catch (e) {}
      };
    }
    // v10.14: 分级版规则勾选回填 + 持久化(与 chkOvpUnlock 同一套写法; id 加 t 前缀防两版冲突)
    var tcw = $("tChkClearWhite"), tak = $("tChkAddK100"), tou = $("tChkOvpUnlock");
    if (tcw) {
      tcw.checked = CHK_CLEAR_WHITE;
      tcw.onchange = function () {
        CHK_CLEAR_WHITE = tcw.checked;
        try { localStorage.setItem("pf_chkClearWhite", tcw.checked ? "1" : "0"); } catch (e) {}
      };
    }
    if (tak) {
      tak.checked = CHK_ADD_K100;
      tak.onchange = function () {
        CHK_ADD_K100 = tak.checked;
        try { localStorage.setItem("pf_chkAddK100", tak.checked ? "1" : "0"); } catch (e) {}
      };
    }
    if (tou) {
      tou.checked = CHK_OVP_UNLOCK;
      tou.onchange = function () {
        syncOvpUnlock(tou.checked);
      };
    }
    // v11.87: 卡⑨ 描边宽输入 —— 改完立即落盘(只写 localStorage, 不重扫、不重绘:
    //   一重扫整页刷新, 输入框会失焦, 边改边看数字的用户体验直接崩)。
    //   非法值(空 / 0 / 负数 / 超上限)不落盘, 但也不回填 —— 让用户自己改完。
    var twIn = $("inpTrapW");
    if (twIn) {
      twIn.onchange = function () {
        var v = parseFloat(twIn.value);
        if (isNaN(v) || v <= 0) return;
        if (v > 10) { v = 10; twIn.value = "10"; }   // 与 jsx 侧钳位一致, 顺手纠正显示
        TRAP_W = v;
        try { localStorage.setItem("pf_trapW", String(v)); } catch (eTWw) {}
      };
    }
    // v11.90: 卡⑩ 对照透明度 —— 与上一段同一套: 只落盘, 不发 jsx、不重扫。
    //   雪糕 2026-11-19 选的是「改动只在下次重建时生效」⇒ 这里绝不能顺手去改层里的 opacity,
    //   否则就变成"即时生效"了。5~95 夹紧, 与 jsx 的 PF_SNAP_OP_MIN/MAX 对齐。
    var opIn = $("inpTrapOp");
    if (opIn) {
      opIn.onchange = function () {
        var v = parseInt(opIn.value, 10);
        if (isNaN(v)) return;
        if (v < 5) { v = 5; opIn.value = "5"; }
        if (v > 95) { v = 95; opIn.value = "95"; }
        SNAP_OP = v;
        try { localStorage.setItem("pf_snapOp", String(v)); } catch (eSow) {}
      };
    }
  }

  function renderCardArtboard(d, scanCk) {
    // ===== 1. 画板 · 出血 · 色彩(v4.0: 色彩模式并入,原第2项移除) =====
    var cmOk = d.colorMode === "CMYK";
    var abRows = "";
    for (var i = 0; i < d.artboards.length; i++) {
      var a = d.artboards[i];
      abRows += "<tr><td>" + esc(a.name) + (i + 1 === d.activeArtboard ? ' <span class="dim">(当前)</span>' : "") +
        '</td><td class="mono">' + bnum(a.w) + " × " + bnum(a.h) + "mm</td></tr>";
    }
    var bleedLevel = "ok";
    function bnum(v) { return (typeof v === "number" && isFinite(v)) ? v : 0; }
    // 出血不足 3mm 的画板名单(v3.4: 多画板文档逐板实测,只列有问题的)
    var bleedHtml = "";
    var bl = (d.bleed && d.bleed.artboards) ? d.bleed : null;
    var badAbs = [];   // v10.28
    if (bl && bl.supported) {
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
        bleedHtml = '<div class="pf-exp-head"><span>出血不足 ' + thv("bleed") + 'mm 的画板 <b class="warn-t">' + badAbs.length + "</b> 个</span></div>" +
          '<ul class="list">' + badAbs.join("") + "</ul>";
      } else {
        bleedHtml = '出血全部 ≥ ' + thv("bleed") + 'mm，达标。';
      }
    } else {
      bleedHtml = '<span class="dim">无法测量</span>';
    }
    // 合并级别: RGB(坏)优先于出血(黄) — bad > warn > ok
    var c1Level = cmOk ? bleedLevel : "bad";
    // v4.0 形态A: 色彩模式永远平铺一行
    // v11.62(雪糕): "色彩模式: CMYK" -> "色彩模式 CMYK" —— 冒号统一去掉(见 renderMissingFonts 注释)
    var cmHtml = cmOk
      ? '<div>色彩模式 <b class="good">CMYK</b></div>'
    : '<div>色彩模式 <b class="bad-t">RGB</b> · 请转 CMYK (文件 → 文档颜色模式)。</div>';
    // v4.3: 徽标配色由色彩模式自身决定(CMYK=绿 / RGB=红),
    // 左边条颜色才代表整卡状态(出血不足=黄 / RGB=红),两者解耦
    // v5.0: 出血不足时右上角追加"出血不足"徽标(黄底),与色彩徽标并列
    var bleedChip = (bleedLevel === "warn" && badAbs.length > 0)
      ? chip("warn", "出血不足") : "";
    return scanCk[0]
      ? card("画板", c1Level, cmOk ? "CMYK" : "RGB",
          '<table class="kv">' + abRows + "</table>" + bleedHtml + cmHtml,
          cmOk ? "ok" : "bad", bleedChip)
    : "";
  }

  function renderCardHidden(d, scanCk) {
    // ===== 2. 隐藏对象 =====
    var hd = d.hidden || { layerCount: 0, itemCount: 0, layerNames: [], truncated: false };
    var hdTotal = (hd.layerCount || 0) + (hd.itemCount || 0);
    // v11.66(雪糕选 B / P5): 卡片级与徽标级对齐 —— 原先是"卡黄条 + 红徽标", 看着像
    //   "卡片没那么严重、徽标却很严重"。隐藏对象确实要处理 ⇒ 统一升到 bad。
    var hdLevel = hdTotal > 0 ? "bad" : "ok";
    var hdHtml = "";
    if (hdTotal === 0) {
      // v7.1: 去掉冗余的"未发现"——卡片标题已表明检查项,正文直说状态
      hdHtml = '无隐藏图层、隐藏对象。';
    } else {
      var hdHint = (hd.layerNames && hd.layerCount > hd.layerNames.length) ? capHint("个") : "";
      // v7.1: 去掉冗余的"发现"
      hdHtml = rowHead('隐藏图层 <b class="warn-t">' + (hd.layerCount || 0) + "</b> 个 · 隐藏对象 <b class='warn-t'>" +
        (hd.itemCount || 0) + "</b> 个。", hdHint);
      if (hd.layerNames && hd.layerNames.length) {
        hdHtml += '<ul class="list">' + hd.layerNames.map(function (n) { return "<li>图层 " + esc(n) + "</li>"; }).join("") + "</ul>";
      }
      // v5.18: "隐藏内容不会出现在导出结果中…"提示灰字按用户要求移除
      // v7.1: 配额提示去掉"对象过多,"前缀(与"仅列出前 N"语义重复)
      if (hd.truncated) hdHtml += '<div class="dim">(仅列出前 ' + thv("scan") + ' 个)</div>';
      // v10.15: 「删除全部隐藏对象」按钮(zhiban 同源移植) —— 只删对象, 隐藏图层本身保留。
      //   仅在**可见图层内确有隐藏对象**(itemCount>0)时显示 —— 隐藏图层的对象不在删除范围,
      //   若隐藏内容全来自隐藏图层, 按钮点了也无目标 ⇒ 不显示, 避免误导。
      var hdDeletable = (hd.itemCount || 0) > 0;
      if (hdDeletable) {
        hdHtml += '<div class="action-row"><button class="btn-action" id="btnDelHidden">删除全部隐藏对象</button></div>';
      } else if ((hd.hiddenLayerItems || 0) > 0) {
        hdHtml += '<div class="dim">隐藏内容均位于隐藏图层内，不在删除范围</div>';
      }
    }
    // v5.20: 有隐藏内容时徽标转红(左边条维持黄色,仅徽标级别改 bad)
    // v11.66(P1/P2): "12 个" -> "隐藏 12 个"(原写法数字打头、没名词); ok 态 "无" -> "无隐藏"。
    return scanCk[1] ? card("隐藏", hdLevel,
      hdTotal > 0 ? "隐藏 " + hdTotal + " 个" : "无隐藏",
      hdHtml, hdTotal > 0 ? "bad" : "ok")
    : "";
  }

  function renderCardFont(d, scanCk) {
    // ===== 3. 字体转曲 =====
    // v5.14: 转曲状态与缺失字体是两个独立状态,徽标并列显示(修 bug: 原三目
    // 二选一,"未转曲 8 个"与"缺字体 1"只能显示一个);同卡 1 的双徽标形态
    var fHtml = "", fLevel, fChip, fChipLevel;
    var missingFonts = (d.fonts && d.fonts.missingFonts) ? d.fonts.missingFonts : [];
    var hasMissing = missingFonts.length > 0;
    // v11.66(P1): 补量词 —— "缺字体 2" -> "缺字体 2 个"
    var missChip = hasMissing ? chip("bad", "缺字体 " + missingFonts.length + " 个") : "";
    var tinyChip = "";
    // v5.24: htx 提前计算——全转曲文案与徽标合并计数都要用
    var htx = (d.hiddenText && d.hiddenText.count > 0) ? d.hiddenText : null;
    if (d.fonts.outlined) {
      fLevel = hasMissing ? "bad" : "ok";
      fChip = "已转曲";
      fChipLevel = "ok"; // 转曲状态本身是好的,徽标不跟随卡片红色;缺失风险由并列徽标承担
      // v5.24: 文案改单句"可见文字 已全部转曲，另有 N 个隐藏文字未转曲"
      // v11.67(雪糕选 C): ok 态统一成「无 X。」句式 —— 与卡②/④/⑥/⑦ 同形。
      //   ⚠ 有隐藏文字时不能笼统说"无未转曲文字"(隐藏的也是文字) ⇒ 限定成"可见未转曲文字",
      //     后半句照旧报隐藏处数, 语义不矛盾。
      fHtml = htx
        ? '无可见未转曲文字，另有 <b class="warn-t">' + htx.count + '</b> 个隐藏文字未转曲。'
      : '无未转曲文字。';
      // v5.18: "隐藏图层/对象中的文字未计入…"提示灰字按用户要求移除
      if (hasMissing) fHtml += renderMissingFonts(missingFonts);
    } else {
      fLevel = "bad";
      fChip = "未转曲 " + d.fonts.totalText + " 个";
      fChipLevel = "bad";
      // v7.1: 去掉冗余的"发现"与"涉及"
      // v11.61(雪糕选 B「名词打头」): "26 个未转曲文本框" -> "未转曲文本框 26 个"。
      //   全站口径: 行标题/徽标一律 **名词在前、数字在后**, 与"缺失字体 2 个""隐藏图层 3 个"
      //   同一形态; 叙述句(如"另有 3 个隐藏文字未转曲")不动 —— 那是中文自然语序, 硬倒装反而不通。
      // v11.76(B): 包成一行 div, 让 pfExpandHtml 能把箭头注入这一行。
      // v11.77(C): 箭头改落这一行最右侧, 文字仍在最左, 不补占位行。
      //   pf-exp-head 让这行变 flex(其它标题行本来就是 flex), 箭头才能 margin-left:auto 贴右。
      //   原来它是 card-body 里的裸文本(承载不了按钮); 包 div 后仍独占一行, 视觉零变化。
      // v11.82: 整句再包一层 <span> —— .pf-exp-head 带 gap:8px, 裸文本会被拆成
      //   匿名 flex item, "未转曲文本框"/数字/"个" 之间各多 8px 间隙。
      //   包成单个 item 后 gap 只剩"文字块 ↔ 箭头"一处, 而箭头靠 margin-left:auto 贴右, 不受影响。
      var parts = '<div class="pf-exp-head"><span>未转曲文本框 <b class="warn-t">' + d.fonts.totalText + "</b> 个</span></div>";
      if (d.fonts.names.length) {
        // v5.0: 字体名可能超长(罕见),同样单行截断+title 悬停看全名
        // v11.75(雪糕选 A): 原 v5.19 的 8 条硬截断是「前端第二道截断」——
        //   jsx 侧名单已多收, 到这里又被砍回去 ⇒ 卡内「展开全部」永远展不满。
        //   现在全量交给 pfExpandHtml 折叠(默认 5 行), 不再另设上限 / 不再有"等 N 种"。
        // v11.62(雪糕): 去掉 "，字体:" 这个子标签 —— "未转曲文本框 26 个，字体:" -> 直接跟名单。
        //   卡名「字体 · 转曲」已经交代了这份名单是什么, 多一个"字体:"只是把一句标题切成两截。
        parts += '<ul class="list">' + d.fonts.names.map(function (n) {
          var full = decodeImgName(n);
          // v11.82(雪糕): 去掉 JS 侧硬截断 —— 原来 truncName(full, 34) 先把名字砍到 34 字,
          //   面板拉宽(无 max-width, 可以很宽)时明明放得下也只显示 34 字。
          //   单行省略已由 CSS `.trunc` 按**像素宽**做(text-overflow:ellipsis), 交给它才对。
          return '<li class="trunc" title="' + esc(full) + '">' + esc(full) + "</li>";
        }).join("") + "</ul>";
      }
      if (hasMissing) parts += renderMissingFonts(missingFonts);
      fHtml = parts;
      if (d.fonts.truncated) fHtml += '<div class="dim">(仅列出前 ' + thv("scan") + ' 个)</div>';
    }
    // v8.8: 混合字体帧提示 —— 这类帧(一帧里多种字体、或字体名读不出)整帧无法判缺，
    //   旧实现一声不响。这是漏报面最大的一类，至少让用户知道有多少帧没被检查。
    var mixF = (d.fonts && d.fonts.mixedFonts) ? d.fonts.mixedFonts : 0;
    if (mixF > 0) fHtml += '<div class="dim">另有 <b class="warn-t">' + mixF +
      '</b> 个文本框含多种字体(或字体名读不出)，未参与缺失字体检测。</div>';

    // v11.73(雪糕): 文本溢出块已整体删除 —— "还是不行，检测不出来，彻底删掉这个功能吧"。
    //   卡③ 从此不再有这一块, 也不再读 d.overset。理由与善后见 preflight.jsx 顶部说明。
    //   ⚠ 别再在卡头补"溢出"徽标: 卡③ 三颗徽标 + 定位按钮实测已占 253.9px(可用宽 300px)。

    // v5.15: 极小字号,并入字体卡底部
    // v10.2: 合并为一档 —— 只有"小于阈值"这一条判定, 且直接标红(原先 <6 黄 / <5 红两级)。
    //   ⇒ 掉 badCount 与"其中 N 处小于 5pt"那一行; 徽标也从"有 <5pt 才红"变成一律红。
    var tiny = (d.tiny && d.tiny.count > 0) ? d.tiny : null;
    if (tiny) {
      // v5.17: 去掉小标题与建议灰字,只留计数与样本
      // v7.0: 截断提示回到标题行右侧(同一行、右对齐、不带括号)
      var tinyHint = (tiny.count > tiny.samples.length) ? capHint("处") : "";
      // v7.1: 去掉冗余的"发现"与"的文字"
      // v11.57(雪糕): 数值列改成**两列**(名字 + 值)。起因: "这里都没有对齐" ——
      //   旧版是 名字 + " — " + 值 同一文本流, 值的 x 坐标完全由名字宽度决定,
      //   实测同一列表里 "编号"/"版权说明" 的值左缘差 22px; 名字超长时省略号
      //   还会把值一起吃掉。
      //   ⚠ .trunc 不再挂在 li 上(它是 white-space:nowrap + overflow:hidden,
      //     和 flex 布局打架), 省略号交给 .nm 自己降级; li 换 class="kv2"。
      //   ⚠ 单位前统一加空格("4.2 pt"), 与分辨率行的 "170.8 ppi" 同一写法。
      // v11.61(雪糕选 B): "3 处字号小于 6pt:" -> "小于 6pt 的文本 3 处:"
      //   ⚠ 阈值 thv("tiny") 必须夹在名词里、计数用 处 —— 改文案别把阈值挪到数字旁边,
      //     否则会读成"3 处 6pt"(像是在说字号恰好 6pt)。
      //   ⚠ 长度是实测定过的: 260px 面板下这一行的 .row-t 预算只有 124px(右侧还挂着
      //     截断提示)。"字号小于 6pt 的文本 3 处:" 实测 140px ⇒ 折成两行(40px 高);
      //     "小于 6pt 的文本 3 处:" 116px ⇒ 单行。别再往前加"字号"二字。
      fHtml += rowHead('小于 ' + thv("tiny") + 'pt 的文本 <b class="bad-t">' + tiny.count + "</b> 处", tinyHint) +
        '<ul class="list">' + tiny.samples.map(function (s) {
          return '<li class="kv2" title="' + esc(s.t) + "  " + s.pt + ' pt">' +
            '<span class="nm">' + esc(s.t) + '</span>' +
            '<span class="vl">' + s.pt + " pt</span></li>";
        }).join("") + "</ul>";
      // v11.66(P1): 补量词 —— "小字号 3" -> "小字号 3 处"(与"叠印 2 处"同词)
      tinyChip = chip("bad", "小字号 " + tiny.count + " 处");
      fLevel = "bad";
    }
    // v5.21: 隐藏文字统计(树遍历只扫可见,隐藏的单独列出;字体名已并入缺失检测)
    // v5.22: 文案理顺——隐藏文字必然未转曲(转曲了就不是文本框),直接说明
    // v5.24: 不再单列"隐文 N"徽标(并入下方合并计数);未转曲分支保留"勾选显示全部"引导
    if (htx && !d.fonts.outlined) {
      fHtml += '另有 <b class="warn-t">' + htx.count + "</b> 个隐藏文字未转曲" +
        (htx.missingCount > 0 ? "(缺字体 <b class='bad-t'>" + htx.missingCount + "</b> 个)" : "") +
        '，勾选「显示全部」可一并转曲。';
      // v10.39: 500 不再写死 —— 改读 jsx 下发的 htx.cap(唯一真源 = PF_TH_DEF.htCap)
      if (htx.truncated) fHtml += '<div class="dim">(仅列出前 ' + htx.cap + " 个)</div>";
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
    // v11.41: 有未转曲文字或缺字体 → 卡头给定位按钮 (pfLocate(3) 选中全部 TextFrame)
    var fLoc = (totalOutline > 0 || hasMissing) ? 3 : 0;
    return scanCk[2] ? card("字体", fLevel, fChip, fHtml, fChipLevel, missChip + tinyChip, fLoc)
    : "";
  }

  // v11.63(雪糕选 C): 「图片嵌入」+「图片分辨率」合并成一张「图片」卡(九卡 → 八卡)。
  //   合并只发生在渲染层 —— jsx 仍分别回 d.images / d.resolution, ckArgs 把 c4/c5 传同一个开关。
  //   合并后必须处理掉四处矛盾(都只有合并才会冒出来):
  //     ① 卡头原来有两颗定位箭头(4 = 未嵌入的链接图 / 5 = 低清图), 形状一样、没有文字,
  //        用户分不清谁管谁 ⇒ 改成两段各一颗块内按钮(沿用卡⑥ 的 .ink-loc + data-locate),
  //        卡头不再挂定位按钮, 顺带把宽度还给标题。
  //     ② 总数说了两遍 —— "嵌入 11 张 + 链接 6 张" 与 "共 17 张图片"
  //        ⇒ 分辨率行不再报总数, 只报两档: "≥300ppi 15 张 · <300ppi 2 张"。
  //     ③ 分项里"图片"重复三次 ⇒ 精简成 "嵌入 11 张 · 链接 6 张 · 缺失 1 张"。
  //     ④ 两个红色挤在一行 ⇒ 链接降为黄(有链接图是常态, 只是提醒), 只有"缺失"保持红。
  //   ⚠ 卡级判定随之分开(合并前"有链接图"就直接判 bad, 与"文件真的丢了"同级):
  //        缺失链接 → bad; 仅有链接 / 分辨率偏低 / 结果不完整 → warn; 否则 ok。
  function renderCardImages(d, scanCk) {
    // ===== 4. 图片(嵌入 + 分辨率) =====
    var im = d.images || {};
    var missN = im.missingCount || 0;
    var linkedN = im.linkedCount || 0;
    var embN = im.embeddedCount || 0;
    var rs = d.resolution || { total: 0, lowCount: 0, okCount: 0, unknownCount: 0, samples: [], truncated: false };
    // v11.56: "无法测量"或"扫描截断"都算检查不完整 —— 徽标必须先报未完成,
    //   不能再落进绿色"全部达标"。旧 jsx 没有 unknownCount, 回落 0。
    var rsUnknown = rs.unknownCount || 0;
    var rsIncomplete = (rs.truncated === true) || rsUnknown > 0;
    var lowN = rs.lowCount || 0;
    // v11.61(雪糕选 B): 名词打头、数字后置; v11.62: 标签尾无冒号; v11.63: 去掉重复的"图片"二字
    var srcRow = "嵌入 <b>" + embN + "</b> 张 · 链接 <b class='" +
      (linkedN ? "warn-t" : "good") + "'>" + linkedN + "</b> 张" +
      (missN ? " · 缺失 <b class='bad-t'>" + missN + "</b> 张" : "");
    var iHtml = "";
    // 卡级判定: 缺失(源文件真的丢了) > 偏低 > 结果不完整 > 仅有链接(常态, 只提醒) > 全部嵌入
    var iLevel = "ok", iChip = "全部嵌入";
    if (embN === 0 && linkedN === 0 && rs.total === 0) {
      iChip = "无图片";
    } else if (missN > 0) {
      iLevel = "bad"; iChip = "缺失 " + missN + " 张";
    } else if (lowN > 0) {
      // v11.64: "有 2 张偏低" -> "偏低 2 张" —— 与"缺失 1 张"同形, 也符合 v11.61 定的
      //   "名词打头 + 数字 + 量词"口径(旧写法是数字打头)。
      iLevel = "warn"; iChip = "偏低 " + lowN + " 张";
    } else if (rsIncomplete) {
      iLevel = "warn"; iChip = "未完成";
    } else if (linkedN > 0) {
      iLevel = "warn"; iChip = "有链接图";
    }
    // v11.64(雪糕选 B): 卡头补一颗**次徽标** —— 主徽标仍只报"最严重一档", 但叠加时
    //   (比如既有缺失又有低清)光一颗看不出还有别的活儿要干。
    //   口径: 次徽标报"能下手处理"的那两类(偏低 / 结果不完整), **不报"有链接图"**
    //     —— 有链接是常态, 段 1 的计数行已经用黄字标了, 挂到卡头是噪音。
    //   取法: 按与主徽标同源的优先级排成 iCand, 只有"主徽标正好等于候选第一位"时才挂
    //     第二位; 这样"全部嵌入 / 无图片 / 有链接图"三种 ok~轻状态永远不会多出一颗。
    // v11.69(雪糕): "如果图片全部嵌入应该显示全部嵌入这种的文案, 现在只会显示偏低 3 张"。
    //   根因是 v11.63 合并两卡把「嵌入状态」与「分辨率状态」压进了同一条优先级链 ——
    //   "全部嵌入"只是 iChip 的初值, 前面任何一档成立它就永远不出现。于是
    //   「3 张全嵌入 + 3 张都低清」卡头只剩「偏低 3 张」, 而"图都在文件里"这个安全信号消失。
    //   ⇒ 维度补位: 嵌入维度已干净(无缺失、无链接、有嵌入)时, 追加一颗**绿**徽标
    //     「全部嵌入」作为末位候选。它排在"未完成"之后 —— 过程状态(检查没跑完)比已完成
    //     状态更该被看到, 所以只有"偏低 + 未完成 + 全嵌入"三态叠加时它才让位(罕见, 接受)。
    //   ⚠ 候选从字符串改成 {t,lv} 对象: 次徽标不再是清一色 warn, "全部嵌入"必须是绿。
    // v11.70(雪糕): "全部嵌入、全部达标 这个状态改成 2 个徽标吧" ——
    //   既然"另一个维度已干净"可以占次位, 分辨率维度的干净状态也该有个名字。
    //   `全部达标` = 分辨率维度全清(有图、无低清、无读不出、未截断), 与 `全部嵌入` 对等。
    //   ⚠ 条件里要带 missN === 0: 缺了源文件的那张根本量不出 ppi, 这时说"全部达标"
    //     与同屏的「缺失 N 张」自相矛盾。带上它之后, 有缺失时这颗绿徽标永不出现。
    var iCand = [];
    if (missN > 0) iCand.push({ t: "缺失 " + missN + " 张", lv: "bad" });
    if (lowN > 0) iCand.push({ t: "偏低 " + lowN + " 张", lv: "warn" });
    if (rsIncomplete) iCand.push({ t: "未完成", lv: "warn" });
    // v12.10(雪糕选 B): 「有链接图」不在 iCand 里(它是常态, 挂卡头是噪音) ⇒ 下面的
    //   "首位相等才挂次位"对它永远不成立。后果: 有链接图且分辨率全清时, 主徽标是黄的
    //   「有链接图」、iCand[0] 却是「全部达标」⇒ 两者不等 ⇒ 绿徽标被吞掉,
    //   "虽然是链接图但分辨率都够"这个正面信号用户看不到。
    //   ⇒ 只在"有链接 + 分辨率全清"这一种状态下把「有链接图」补成第 0 位,
    //     次徽标便自然挂出绿色的「全部达标」。
    //   ⚠ 不可无条件 push —— 那样"有链接 + 有低清"会多挂一颗黄「有链接图」,
    //     正是上面"不报有链接图"那条注释要避免的噪音(bt130 的 #有链接不补 守着)。
    if (missN === 0 && linkedN > 0 && lowN === 0 && !rsIncomplete && rs.total > 0) {
      iCand.push({ t: "有链接图", lv: "warn" });
    }
    if (missN === 0 && linkedN === 0 && embN > 0) iCand.push({ t: "全部嵌入", lv: "ok" });
    if (missN === 0 && rs.total > 0 && lowN === 0 && !rsIncomplete) iCand.push({ t: "全部达标", lv: "ok" });
    // ⚠ 比较点必须写 .t —— 候选改成对象之后, 写 iCand[0] === iChip 恒为假, 次徽标会整片消失。
    var iChip2 = (iCand.length > 1 && iCand[0].t === iChip) ? chip(iCand[1].lv, iCand[1].t) : "";
    // 一张图都没有: 与卡②「无隐藏图层、隐藏对象。」同一形态, 不摆空行 (v11.67 ok 态统一)
    if (embN === 0 && linkedN === 0 && rs.total === 0 && !rsIncomplete) {
      iHtml = '无图片。';
    } else {
      // 段 1 的标题行用 .ink-block（不是 .row-head）—— 两个理由:
      //   ① 它是卡体首元素, CSS 的 `.card-body > :first-child{margin-top:0}` 会吃掉
      //      .ink-block 的 8px 上边距, 卡头间距与其它卡一致, 不会白多 8px;
      //   ② 段 2 的标题行也是 .ink-block, 它前面是 <ul>, 于是自动拿到 8px 上边距,
      //      两段之间不需要新加 CSS 就能分开(用 .row-head 的话这里只剩 1px)。
      iHtml = '<div class="ink-block"><span class="row-t">' + srcRow + "</span>" +
        (linkedN > 0 ? locBtnAt(4, "", "只选中未嵌入的链接图片 (锁定/隐藏的只提示位置，不改状态)") : "") +
        "</div>";
    }
    if (im.linked && im.linked.length) {
      // v11.63: 小标题行「未嵌入」整行删掉 —— 上方块标题已经写着"链接 6 张",
      //   紧接着的清单只可能是这 6 个文件, 再挂一个小标题就是同一件事说两遍。
      //   (v7.1 当时只删了括注, v11.62 去掉了它的尾冒号, 这一轮连标签一起去。)
      // v5.0: 链接文件名(name/file 路径)可能超长或 URL 编码,解码+单行截断
      // v5.19: 两行并一行——只显示文件名,完整路径移到悬停 title,清单高度减半
      iHtml += '<ul class="list">' + im.linked.map(function (it) {
        var fn = decodeImgName(it.name);
        var ff = decodeImgName(it.file);
        return '<li class="trunc" title="' + esc(ff) + '">' + (it.missing ? '<span class="warn-tri">⚠</span> ' : "") +
          // v11.82: 同字体名单 —— 不再 JS 硬截断(原 truncName(fn, 40)), 交给 CSS `.trunc`。
          esc(fn) + (it.missing ? ' <span class="bad-t">源文件不存在</span>' : "") + "</li>";
      }).join("") + "</ul>";
      // v6.9: 样本截断提示按用户要求删除(truncated 仍代表扫描配额上限,提示保留)
      if (im.truncated) iHtml += '<div class="dim">(仅列出前 ' + thv("scan") + ' 张)</div>';
    }
    // ---------- 段 2: 分辨率(v11.63 由独立卡并入) ----------
    //   ⚠ 只在真有位图或结果不完整时出现 —— 没有位图时"嵌入 N 张"已经说明完了,
    //     再补一句"文档无位图"是第三种重复。
    if (rs.total > 0 || rsIncomplete) {
      var rsHint = (lowN > rs.samples.length) ? capHint("张") : "";
      // 阈值用 &lt; 而不是裸 "<": 裸尖括号靠浏览器的容错解析成文本, 一致性差。
      iHtml += '<div class="ink-block"><span class="row-t">分辨率 &lt;' + thv("reso") + "ppi <b class='" +
        (lowN ? "warn-t" : "good") + "'>" + lowN + "</b> 张 · 达标 <b class='good'>" + (rs.okCount || 0) + "</b> 张" +
        (rsUnknown > 0 ? " · 无法判定 <b class='warn-t'>" + rsUnknown + "</b> 张" : "") +
        "</span>" +
        (lowN > 0 ? locBtnAt(5, "", "只选中分辨率偏低的图片 (锁定/隐藏的只提示位置，不改状态)") : "") +
        (rsHint ? '<span class="row-h">' + esc(rsHint) + "</span>" : "") + "</div>";
      if (rs.samples.length) {
        // v5.0: 文件名先 URL 解码再截断显示;完整名放 title(悬停可查)
        iHtml += '<ul class="list">' + rs.samples.map(function (s) {
          var full = decodeImgName(s.name);
          // v11.82: 不再 JS 硬截断(原 truncName(full, 34)), 交给 CSS `.trunc` 按像素宽省略。
          // v8.2: jsx 的 ppiOf 返回**原值**(带小数,为的是卡 300 阈值时不误判),显示时不输出长小数
          //   —— 与油墨 total 同一口径(jsx 传原值 / 前端格式化)。
          //   旧版(≤v8.1)这里直接输出 s.ppi ⇒ 面板上出现 "170.776863599299 ppi" 这种长小数。
          // v11.46(雪糕): 取整改成**保留 1 位小数**。起因: "300ppi 的也选择中了" ——
          //   实测 299.6 的图被 Math.round 显示成 "300 ppi", 面板上就变成"写着 300 却
          //   被判偏低", 看着像判定错了。留 1 位小数后 299.6 就是 299.6, 一眼能对上;
          //   整数仍显示整数(300 而不是 300.0), 不引入视觉噪音。
          var ppiShow = (typeof s.ppi === "number" && isFinite(s.ppi)) ? (Math.round(s.ppi * 10) / 10) : s.ppi;
          // v11.57(雪糕): 两列 + 单位前留空格, 与字号块同一套(详见上方字号那条)。
          return '<li class="kv2" title="' + esc(full) + "  " + ppiShow + ' ppi">' +
            '<span class="nm">' + esc(full) + '</span>' +
            '<span class="vl">' + ppiShow + " ppi</span></li>";
        }).join("") + "</ul>";
      }
      // v6.9: 样本截断提示按用户要求删除
      // v11.56: 措辞统一回 "(仅列出前 N 张)" 形态 —— 与卡②③④⑤ 的配额灰字行一致,
      //   但必须补一句"结果不完整": 截断意味着没扫完, 不能让人读成"扫过的都达标"。
      if (rs.truncated) iHtml += '<div class="dim">(仅列出前 ' + thv("scan") + " 张，结果不完整)</div>";
      // v11.56: 无法判定的图片必须显式说明, 不能让人把"欠缺数据"读成"全部通过"。
      if (rsUnknown > 0) {
        iHtml += '<div class="dim">有 <b class="warn-t">' + rsUnknown +
          "</b> 张图片无法读取分辨率(文件缺失、格式异常或缩放矩阵不可用)，这一节结果不完整。</div>";
      }
      // v5.18: "低于 300ppi…建议更换高清图源"提示灰字按用户要求移除
    }
    // 一键嵌入按钮固定在**卡末** —— 合并前它在卡④ 尾部, 直接拼在分辨率段后面会夹在正文中间。
    if (linkedN > 0) {
      iHtml += '<div class="action-row"><button class="btn-action" id="btnEmbed">一键嵌入</button></div>';
    }
    // v11.63: 卡头不再挂定位按钮 —— 两段各有一颗块内按钮(4 = 链接图 / 5 = 低清图),
    //   卡头再挂一颗只会让人分不清它选的是哪一边。
    return scanCk[3] ? card("图片", iLevel, iChip, iHtml, null, iChip2, 0) : "";
  }

  function renderCardInkStroke(d, scanCk) {
    // ===== 6. 油墨 · 描边粗细 (v6.2: 方案 B —— 按"问题类型"分块,标题统一) =====
    var bt = d.black.text, bp = d.black.path;
    var bHtml = "";
    var bLevel = "ok";
    // v11.66(P2): 初值同无异常分支 —— "通过" 这个说法只在这张卡出现过, 与「无叠印/无未使用」不搭
    var bChip = "无异常";
    var totalBad = bt.bad + bp.bad;
    var totalWarn = bt.warn + bp.warn;
    var light = d.black.light || { count: 0, samples: [] };
    var lightN = light.count || 0;
    var thinN = bp.thin || 0;
    // v11.91: 四色黑(v12.14 起只看四通道之和 >= 设置里的 rbSum, 默认 330)
    //   —— 本卡唯一带红色动作按钮的块。
    //   ⚠ 旧 jsx(缓存里没有 richBlack 键)一律兜成 0 —— 否则 rb.count 读 undefined 会让
    //     "四色黑 0 个"的块凭空出现(undefined > 0 恒假, 但 rbN 传给 inkBlock 会显示 undefined)。
    //   v11.92: 只读 count —— 块里不再列样本(见下方说明), jsx 那边也跟着只留计数。
    var rb = d.black.richBlack || { count: 0 };
    var rbN = rb.count || 0;

    // v6.7: 合并"文字样本 + 图形样本"为一张表(文字在前),分组合并与截断统一交给 inkRows。
    //   此前两类样本各自拼接、最多 10 行,但截断提示只写了"前 5",与实际不符;现按用户口径真截到前 5 组。
    function inkMerge(a, b, cap, tbl) {
      var rows = [], i;
      for (i = 0; i < (a || []).length; i++) rows.push({ l: "文字", s: a[i] });
      for (i = 0; i < (b || []).length; i++) rows.push({ l: "图形", s: b[i] });
      return inkRows(rows, cap, tbl);
    }

    var blocks = "";
    // 块 1: 油墨总量>300(红) —— 文字 + 图形样本合并成一张表,按来源标 [文字]/[图形]
    if (totalBad > 0) {
      var badRows = inkMerge(bt.badSamples, bp.badSamples, thv("cap"), 1); // v6.7/v10.1: 合并后统一截到前 cap 条
      blocks += inkBlock("油墨总量>" + thv("inkWarn"), totalBad, "bad", totalBad > badRows.shown ? capHint("个") : "", "over");
      blocks += badRows.html;
    }
    // 块 2: 油墨总量 220~300(黄)
    if (totalWarn > 0) {
      var warnRows = inkMerge(bt.warnSamples, bp.warnSamples, thv("cap"), 1); // v6.7/v10.1: 合并后统一截到前 cap 条
      blocks += inkBlock("油墨总量" + thv("inkOk") + "~" + thv("inkWarn"), totalWarn, "warn", totalWarn > warnRows.shown ? capHint("个") : "", "heavy");
      blocks += warnRows.html;
    }
    // 块 3: 色版<5%(黄,CMYK 某分量) —— 用户指定排在描边块之前
    //   v11.4: 文案由区间式改为 "<阈值%" 式: ① 不再做"阈值减 1"的减法
    //     (阈值取不到时它正是问号的来源); ② 与同卡其余三块口径统一 ——
    //     "油墨总量>300" / "描边<0.1mm" / "<300ppi" 都用 <> 号; ③ 语义不变:
    //     0 表示该色版不用(不算太浅), 判定只收 1 ~ (阈值-1)。
    if (lightN > 0) {
      var lightRows = (light.samples || []).map(function (s) {
        return { l: s.src === "text" ? "文字" : "图形", s: s, markLight: true };  // v7.6: 过浅分量标白
      });
      var lightOut = inkRows(lightRows, thv("cap"), 1);   // v7.7/v10.1: 相同色值合并为 " ×n"
      blocks += inkBlock("色版<" + thv("light") + "%", lightN, "warn", lightN > lightOut.shown ? capHint("个") : "", "light");
      blocks += lightOut.html;
    }
    // v9.4: 原"块 4 叠印"已拆成独立卡片(见下方"7. 叠印"), 卡片顺序保持"油墨 -> 叠印"。
    // 块 4: 描边<0.1mm(黄,仅图形) —— 相同宽度合并为 "描边 0.09mm ×3"
    // v7.8: jsx 已按 mm 去重并带 n(全量次数);这里仍按 mm 分组(旧 jsx 兜底),计数优先取 s.n
    if (thinN > 0) {
      // v11.39: thinSamples 一处判空一处不判 —— 截断提示那行直接读 .length
      //   (jsx 少回这个字段就抛, 整张油墨卡变红), 下面的遍历却写了 `|| []`。统一到一处。
      var thinArr = bp.thinSamples || [];
      blocks += inkBlock("描边<" + thv("thin") + "mm", thinN, "warn", thinN > thinArr.length ? capHint("个") : "", "thin");
      var tOrder = [], tMap = {};
      thinArr.forEach(function (s) {
        var k = String(s.mm);
        if (!tMap[k]) { tMap[k] = { mm: s.mm, n: 0, names: [] }; tOrder.push(k); }
        tMap[k].n += (s.n > 0 ? s.n : 1);   // 有 n 用 n(全量真值);无 n(旧 jsx)按 1 条累计
        if (s.name) tMap[k].names.push(s.name);
      });
      // v11.24(B2): 与上面三块统一成表格 —— 线高按 mm 取 1/2px，粗细一眼可比
      blocks += '<ul class="ink-tbl">' + tOrder.map(function (k) {
        var g = tMap[k];
        var hpx = (g.mm >= 0.08) ? 2 : 1;
        var cnt = (g.n > 1) ? "\u00d7" + g.n : "";
        var txt = "[图形] " + (g.names.length ? g.names.join(" ") + " " : "") +
                  "描边 " + g.mm + "mm" + (cnt ? " " + cnt : "");
        return '<li title="' + esc(txt) + '">' +
          '<i class="ik-line" style="height:' + hpx + 'px;background:#b6b6b6"></i>' +
          '<span class="ik-wh">\u63cf\u8fb9</span>' +
          '<span class="ik-cv">' + esc(g.mm + "mm") + "</span>" +
          '<span class="ik-vl"></span>' +
          '<b class="ik-n">' + esc(cnt) + "</b></li>";
      }).join("") + "</ul>";
    }

    // ===== v11.91: 四色黑 → 单黑 =====
    //   位置: 四个"只报告"的块之后、灰色汇总行之前 —— 这是本卡唯一带红色动作按钮的块,
    //   放最后才不会被夹在一堆名单中间误点。
    //   口径(v12.14): 四通道之和 >= 设置里的「四色黑合计达」(默认 330, jsx 的 PF_RB_SUM);
    //   文字填充与描边都算、图形填充/描边都算 —— 与上面两个油墨总量块同源。
    // v11.92(雪糕): **不列样本清单** —— 与上面「油墨总量>300」那张表是同一批对象
    //   (累计 >= rbSum 必然 > inkWarn 的默认值, 一屏里同一个东西列两遍)。
    // v11.93(雪糕): 标题行「四色黑 N 个」和那行灰字说明**也去掉** —— 卡头徽标已经写着
    //   「四色黑 N 个」, 块里再报一遍是第二次重复。块内只剩 勾选 + 按钮;
    //   数量与判定口径挂到按钮的 title 上(悬停可见), 不为它单独占行。
    // v11.94(审查): 量词「个」改「处」—— rbN 是 jsx 侧按**填充/描边各一次**累加的
    //   (jsx 的 black.richBlack.count 在两个写入点各 ++), 一个对象填充与描边都是四色黑
    //   会算 2。按 v11.61 定的口径「个 = 对象 / 处 = 落点」, 这里必须是「处」,
    //   否则卡头写「四色黑 2 个」而文档里其实只有 1 个对象。按钮 title 同步。
    if (rbN > 0) {
      blocks += '<div class="action-row">' +
        '<div class="chk-row">' +
        '<label class="chk" title="转换前先解锁图层、对象级锁定(Ctrl+2)与锁定组；隐藏对象一律不碰"><input type="checkbox" id="chkRbUnlock"> 解锁全部</label>' +
        '</div>' +
        // v11.114(雪糕选 A): title 里点明「四色黑」与上面「油墨总量>300」是**两条线** ——
        //   雪糕问过"为什么外面检测 >300、转单黑却按 >320"。答案是这两个数管的不是一件事:
        //   300 是「要不要报给你看」的检测线, 另一个是「能不能安全地一键转单黑」的判断线。
        // v12.14: 判断线提成可调项(rbSum, 默认 330) ⇒ 文案改成读 thv("rbSum")。
        //   ⚠ **不要再硬编码这个数**: 前端现在有它的镜像(TH_KEYS 末位), 写死必然与设置又走散。
        '<button class="btn-action" id="btnRbK100" title="与上面的「油墨总量>' + thv("inkWarn") +
        '」是两条线：四色黑只看 C+M+Y+K 之和是否 >=' + thv("rbSum") +
        '%，不看单个通道的深浅（这个数在设置里可改）。本按钮处理 ' + rbN +
        ' 处填充/描边 (含文字描边)，转为 C0 M0 Y0 K100；只改颜色，不改叠印">四色黑转单黑</button>' +
        '</div>';
    }

    // 汇总行(灰):正常计数 + RGB/专色/混合色
    // v8.8: 一律 ||0 —— 旧 jsx 缓存里 black.path 没有 mixed 键，直接相加得 NaN，
    //   而 if(NaN) 恒假 ⇒ 「混合色」这段从上线起就没显示过。other = 渐变/图案。
    var rgbN = (bt.rgb || 0) + (bp.rgb || 0), spotN = (bt.spot || 0) + (bp.spot || 0),
        mixedN = (bt.mixed || 0) + (bp.mixed || 0), otherN = (bt.other || 0) + (bp.other || 0);
    // v11.62(雪糕): "正常: 文字 N · 图形 N" -> "正常 文字 N · 图形 N"(卡片正文去冒号)
    var rest = "正常 文字 <b class='ink-n'>" + bt.ok + "</b> · 图形 <b class='ink-n'>" + bp.ok + "</b>";
    if (rgbN) rest += " · RGB <b class='warn-t'>" + rgbN + "</b>";
    if (spotN) rest += " · 专色 <b>" + spotN + "</b>";
    if (mixedN) rest += " · 混合色 <b>" + mixedN + "</b>";
    if (otherN) rest += " · 渐变/图案 <b>" + otherN + "</b>";
    if (bp.truncated) rest += " · 仅列出前 " + thv("scan") + " 个";
    blocks += '<div class="ink-rest">' + rest + "</div>";
    bHtml = blocks;

    // 徽标: v11.66(雪糕选 B / P4) 换成"主 + 次"两段式, 与图片卡同一口径。
    //   旧口径是一条互斥链: 有超标就只报"超标 N 处", 否则把 偏重/描边细/色版浅 三类
    //   **加成一个数**报"注意 N 处" —— 既看不出是哪一类, 超标时偏重也会被整段盖掉。
    //   新口径: 按 超标 > 偏重 > 描边细 > 色版浅 排成候选, 主徽标取第一位(最严重),
    //   次徽标取第二位(下一个能下手处理的), 每颗都带自己的类别名。
    //   ⚠ 候选只 push 上面四种; RGB/专色/混合色 仍只出现在灰色汇总行 —— 它们不属于
    //     "油墨总量/描边/色版" 这三类可下手的问题(要不要计入得单独拍板)。
    var bCand = [];
    if (totalBad > 0) bCand.push(["bad", "超标 " + totalBad + " 处"]);
    // v11.91: 四色黑排在超标之后、偏重之前 —— 它和超标常是同一批对象(总墨量 >= rbSum),
    //   但"可以直接点一下修掉"比"偏重"更该被看见。两者都命中时徽标读作
    //   "超标 N 处 · 四色黑 M 处", 正好是"超标里有 M 处是四色黑"。
    // v11.94(审查): 单位由「个」改「处」—— 见上方四色黑块的注释(填充/描边各计一次)。
    if (rbN > 0) bCand.push(["bad", "四色黑 " + rbN + " 处"]);
    if (totalWarn > 0) bCand.push(["warn", "偏重 " + totalWarn + " 处"]);
    if (thinN > 0) bCand.push(["warn", "描边细 " + thinN + " 处"]);
    if (lightN > 0) bCand.push(["warn", "色版浅 " + lightN + " 处"]);
    if (bCand.length === 0) {
      // v11.66(P2): "通过" 太笼统, 与「无叠印 / 无未使用」这一族不搭 ⇒ 改「无异常」
      bChip = "无异常";
      // v11.67(雪糕选 C): 干净时补一句 ok 结论, 与其余五张卡同形「无 X。」。
      //   ⚠ 只加这一句, 不动下面的灰色汇总行(.ink-rest) —— 那行在**有问题时也在**
      //     (内容是"正常 N · RGB N · 专色 N"), 调亮它会在有问题的卡里跟真结论抢注意力。
      bHtml = '无异常。' + bHtml;
    } else {
      bLevel = bCand[0][0];
      bChip = bCand[0][1];
    }
    var bChip2 = bCand.length > 1 ? chip(bCand[1][0], bCand[1][1]) : "";
    // v9.4: 叠印已独立成卡(下一张),这里不再挂 extraChip,标题也去掉"叠印"二字
    // v11.53: 卡头按钮撤掉 —— 雪糕要的是"每块各一颗"(见 inkBlock 的第 5 参),
    //   卡头这颗选的是四块并集, 与块内按钮语义重复且更容易"一锅端"。
    //   ⇒ 第 7 参一律传 0(bt114 守住移除, 别又加回来)。
    // v11.64(雪糕): 卡名带后缀 —— 这张卡管三类事(油墨总量/色版/描边), 光写"油墨"看不出描边。
    // v11.66: 第 6 参由空串改为 bChip2(次徽标)。
    return scanCk[4] ? card("油墨 · 描边", bLevel, bChip, bHtml, null, bChip2, 0) : "";
  }

  function renderCardOverprint(d, scanCk) {
    // ===== 7. 叠印 (v9.4: 依雪糕要求从油墨卡拆出, 独立成卡) =====
    // v8.3: 叠印(文字+图形共一池)—— 计数只走"分块 + extraChip",**不并入主徽标计数**
    //   v11.1(审查 ⑫): 这两行原在油墨卡块里, 但 v9.4 把叠印拆成独立卡后它们只被本卡使用
    //     ⇒ 随本卡一起搬到此处(拆分 render 时才暴露出来: ovp is not defined)。
    var ovp = d.black.overprint || { count: 0, samples: [] };
    var ovpN = ovp.count || 0;
    //   ⚠ 旧 jsx(缓存里没有 white/text/path 键)一律 ||0 —— 让 undefined 参与算术会得 NaN、
    //     而 if(NaN) 恒假 ⇒ 整段静默不显示(v8.8 的 black.path.mixed 就是这么栽的)。
    var ovpW = ovp.white || 0, ovpTx = ovp.text || 0, ovpPth = ovp.path || 0;
    // v11.56: 分级版"需处理"必须用 whiteClass(<1 的近白/纯白), 不能用精确 ==0 的 white。
    //   旧 jsx 没这个字段时回落 ovpW, 保持兼容。
    var ovpWCls = (typeof ovp.whiteClass === "number") ? ovp.whiteClass : ovpW;
    // v9.6: 其中落在锁定对象/图层/锁定组里的处数(旧 jsx 无此键 ⇒ ||0, 否则 if(undefined>0) 恒假、静默不显示)
    var ovpLocked = ovp.locked || 0;
    // v10.14: 四分类计数(旧 jsx 无 k100/spot/color 键 ⇒ ||0, 否则 NaN 恒假导致静默不显示)
    var ovpK100 = ovp.k100 || 0, ovpSpot = ovp.spot || 0, ovpColor = ovp.color || 0;
    // v12.17(雪糕): 还没加叠印的单黑(K100) —— 与「单黑叠印」(已经加了)是两回事。
    //   旧 jsx 没有这个字段 ⇒ 兜成 0, 面板行为与之前完全一致(不会凭空冒出按钮)。
    var ovpK100Todo = ovp.k100Todo || 0;
    // v10.35: 叠印扫描是否被配额截断 —— 截断且 count=0 时**不能**说"无叠印"
    //   (漏检报通过是印刷上最危险的假阳性)。旧 jsx 无此键 ⇒ undefined, 走 !=== true 判否。
    // v10.36(审查 v10.35): 截断且 count>0 的两分支也要处理 —— v10.35 只补了 count=0 分支,
    //   漏了"前 N 个已命中若干处、后面的没扫完" ⇒ 用户看到"叠印 8 处"就以为只有 8 处
    //   (漏检报部分, 比"报无"轻但同样是失真)。徽标加 "+" 表示"至少 N", 并补一行灰字说明。
    var ovpTrunc = (ovp.truncated === true);
    var oHtml = "", oLevel = "ok", oChip = "无叠印";
    if (ovpN > 0) {
      oLevel = "bad";
      // v10.22: 徽标并单枚(雪糕点名, 参考分级版"需处理 N · 正常 N"形态) ——
      //   "叠印 N 处" + 副徽标"白叠印 N 处" 两枚太长 ⇒ "叠印 N · 白 N" 一枚。
      //   危害说明不丢: 卡内汇总行"白色 N"仍带 title 悬停提示。
      // v10.36: 截断时数字加 "+" —— "叠印 8+" 一眼看出"不止这些"。
      // v12.9: 主数补量词「处」—— 卡体写的是"共 N 处叠印", 徽标却写"叠印 N",
      //   同一件事两种说法。副数保持「白叠印 N」不动: 那两个字是 v11.66 特意补的
      //   (光写"白"看不出是白底叠印), 且再加一个"处"会让这枚徽标在 300px 下变挤。
      oChip = "叠印 " + ovpN + (ovpTrunc ? "+" : "") + " 处" +
        (ovpW > 0 ? " · 白叠印 " + ovpW : "");
      var oRows = (ovp.samples || []).map(function (s) {
        return { l: s.src === "text" ? "文字" : "图形", s: s };
      });
      var oOut = inkRows(oRows, thv("cap"), 1);   // v11.26: 叠印卡也改表格(B 方案, 不分组)
      // v9.7: 叠印汇总 —— 锁定 / 白色一并进标题行(原先各占一行: 一行灰字 + 一行正文),
      //   两段解释改挂 title 悬停提示 ⇒ 卡片净省 2 行, 且数字集中在一处更好对账。
      oHtml += rowHead("共 <b class='bad-t'>" + ovpN + "</b> 处叠印" +
        ((ovpTx || ovpPth) ? " · 文字 <b>" + ovpTx + "</b> · 图形 <b>" + ovpPth + "</b>" : "") +
        (ovpLocked > 0 ? ' · <span title="清除叠印时锁定对象默认跳过；勾选「解锁全部」可一并清除">锁定 <b class="warn-t">' + ovpLocked + "</b></span>" : "") +
        (ovpW > 0 ? ' · <span title="白色叠印后不再遮挡下层，印出来会花">白色 <b class="bad-t">' + ovpW + "</b></span>" : ""),
        ovpN > oOut.shown ? capHint("处") : "", "over");
      oHtml += oOut.html;
      // v10.36: 截断说明 —— 放在样本之后、动作区之前(先让用户看清已找到的, 再提示还有没扫完的)
      if (ovpTrunc) {
        oHtml += '<div class="dim">已达检查上限，叠印数可能不止 <b class="warn-t">' + ovpN +
          "</b> 处，未扫完的部分需人工复核。</div>";
      }
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
    } else if (ovpTrunc) {
      // v10.35: 扫描达配额上限且未命中叠印 —— 不能说"无", 只能报"未完成"(灰徽标)。
      oLevel = "warn"; oChip = "未完成";
      oHtml = '已检查范围内<b class="warn-t">无叠印</b>，但已达检查上限，结果不完整。' +
        '<br><span class="dim">文档对象数超过本次检查配额，可能有叠印未被检查到。</span>';
    } else {
      oHtml = '无叠印。';
    }
    // v11.101(雪糕): 原先这里有一行「隐藏对象与图层不参与叠印检查。」挂在按钮下面 ——
    //   **整行删掉**。点按钮弹的确认框里本来就写着同一句("隐藏对象与图层不参与叠印检查,
    //   本操作也不会改动它们"), 卡片上再留一遍属于重复, 还白占一行高度。
    //   ⚠ 口径本身没变, 仍写在确认框 + README「卡 ⑦ 叠印」里。分级版那侧同步删了。
    // v10.22: 副徽标(第 6 参)废弃 —— 白色计数已并入主徽标("叠印 N · 白 N"), 危害说明留在汇总行 title。
    var oExtra = "";

    // ---------- v10.14: 分级版卡体(四分类 + 规则动作; zhiban v0.7.x 同款, 全角已转半角) ----------
    //   口径: 单黑(k100)/专色(spot)=正常; 纯白(white)/彩色(color)=需处理。
    //   需处理 >0 才显示勾选区与按钮; 徽标「需处理 N · 正常 N」(zhiban v0.7.4 雪糕选定形态)。
    var tClsRow = function (n, label, tip, cls) {
      var c = n > 0 ? cls : "dim";
      return '<div' + (tip ? ' title="' + tip + '"' : "") + '><b class="' + c + '">' + n + '</b> 个' + label + "</div>";
    };
    var tHtml = "", tLevel = "ok", tChip = "无叠印";
    // v12.17(雪糕): 「还没加叠印的单黑」也算要处理 —— 否则文档里一处叠印都没有时, 分级版
    //   连「单黑加叠印」这个勾选项都不出现, 这条规则等于无处下手。
    var tHasClear = (ovpWCls > 0 || ovpColor > 0);
    var tHasAddK100 = (ovpK100Todo > 0);
    if (ovpN > 0) {
      var tNeedN = ovpWCls + ovpColor, tNormN = ovpK100 + ovpSpot;
      tLevel = tHasClear ? "bad" : (tHasAddK100 ? "warn" : "ok");
      // v10.36: 截断时两个计数都只是下限 ⇒ 各加 "+"(与简洁版同口径)
      tChip = "需处理 " + tNeedN + (ovpTrunc ? "+" : "") + " · 正常 " + tNormN + (ovpTrunc ? "+" : "");
      tHtml += '<div class="ovp-cls">' +
        tClsRow(ovpK100, "单黑叠印", "C0 M0 Y0 K100: 压印后不再镂空，避免套印露白(正常)", "good") +
        tClsRow(ovpSpot, "专色叠印", "专色、渐变、图案上的叠印(正常)", "good") +
        tClsRow(tNeedN, "需处理叠印",
          "近白/纯白叠印 " + ovpWCls + " 个(白色叠印后不再遮挡下层，印出来会花)；" +
          "彩色叠印 " + ovpColor + " 个(其余 CMYK / RGB 叠印)", "bad-t") +
        "</div>";
      if (ovpLocked > 0) {
        tHtml += '<div class="dim">其中 <b class="warn-t">' + ovpLocked +
          '</b> 处位于锁定对象/图层，勾选「解锁全部」可一并处理。</div>';
      }
      tHtml += oOut.html;   // 样本行与简洁版同源(同一批样本, 不重复扫描)
      // v10.36: 截断说明(与简洁版同口径)
      if (ovpTrunc) {
        tHtml += '<div class="dim">已达检查上限，叠印数可能不止 <b class="warn-t">' + ovpN +
          "</b> 处，未扫完的部分需人工复核。</div>";
      }
      if (ovpWCls > 0 || ovpColor > 0) {
        // v12.17: 动作区已挪到 if/else 之外(见下方 tHasClear/tHasAddK100 那段) ——
        //   因为「只有待加单黑、一处叠印都没有」时也要出按钮, 不能再挂在这个分支里。
      }
    } else if (ovpTrunc) {
      // v10.35: 与简洁版同口径 —— 截断且未命中时不报"无", 报"未完成"
      tLevel = "warn"; tChip = "未完成";
      tHtml = '已检查范围内<b class="warn-t">无叠印</b>，但已达检查上限，结果不完整。' +
        '<br><span class="dim">文档对象数超过本次检查配额，可能有叠印未被检查到。</span>';
    } else {
      tHtml = '无叠印。';
    }
    // v12.17(雪糕): 「待加单黑的账」与动作区统一放在 if/else 之外 ——
    //   只要有得做(该清的叠印 / 该加的单黑)就出按钮, 两样都清零后按钮自动消失。
    if (tHasAddK100) {
      // 一处叠印都没有、只有待加单黑时: 卡头也换成它, 否则"需处理 0 · 正常 0"读不出重点。
      if (ovpN === 0 && !ovpTrunc) { tLevel = "warn"; tChip = "待加单黑 " + ovpK100Todo + " 处"; }
      tHtml += '<div class="dim">未加叠印的单黑 <b class="warn-t">' + ovpK100Todo +
        "</b> 处，勾选「单黑加叠印」可一并加上。</div>";
    }
    if (tHasClear || tHasAddK100) {
      // 动作区 id 加 t 前缀: 与简洁版的 chkOvpUnlock/btnOvpClear 区分(两版同时渲染进 DOM)
      // 没有对应的活就不渲染那一颗勾选 —— 免得摆一个勾了也没用的框。
      tHtml += '<div class="action-row"><div class="chk-row">' +
        (tHasClear
          ? '<label class="chk" title="清除需处理叠印(近白/纯白 + 彩色 CMYK/RGB)对象的填充与描边叠印"><input type="checkbox" id="tChkClearWhite"> 清除需处理叠印</label>'
          : "") +
        (tHasAddK100
          ? '<label class="chk" title="为单黑(C0M0Y0K100)对象的填充与描边新增叠印"><input type="checkbox" id="tChkAddK100"> 单黑加叠印</label>'
          : "") +
        '<label class="chk" title="执行前先解锁全部图层、对象级锁定(Ctrl+2)与锁定组；隐藏对象一律不碰"><input type="checkbox" id="tChkOvpUnlock"> 解锁全部</label>' +
        '</div><button class="btn-action" id="tBtnOvpApply">执行勾选项</button></div>';
    }
    // v11.101: 与简洁版同步 —— 这句「隐藏对象与图层不参与叠印检查。」删掉(确认框里已有)。


    // 两版同时渲染进 #ovpDual, data-m 决定显隐(CSS); 选择记 pf_ovpMode, 默认 legacy(简洁版)
    var ovpMode = readOvpMode();   // v10.32: 统一读取口
    // ⚠ card() 写死 class="card", 两份卡需各自带 ovp-legacy / ovp-tiered 类供 CSS 切显隐;
    //   卡体内部不含该字面量, replace 首个(也唯一)开标签安全。
    // v10.29: 卡头 seg 页签摘除(雪糕点名) —— 版本选择移到设置弹层「叠印」行卡名后;
    //   v10.31: 卡头标题补版本后缀「叠印 · 全清理 / 叠印 · 分级版」(根据当前选择)。
    // v11.41: 有叠印 → 两份卡的卡头都带定位按钮 (pfLocate(7) 选中全部叠印对象)。
    //   截断且 0 命中时 ovpN=0 ⇒ 不给按钮(确实没有可选中的对象)。
    var oLoc = ovpN > 0 ? 7 : 0;
    var legacyCard = card("叠印 · 全清理", oLevel, oChip, oHtml, null, oExtra, oLoc)
      .replace('<div class="card">', '<div class="card ovp-legacy">');
    var tieredCard = card("叠印 · 分级版", tLevel, tChip, tHtml, null, "", oLoc)
      .replace('<div class="card">', '<div class="card ovp-tiered">');
    return scanCk[5]
      ? '<div class="ovp-dual" id="ovpDual" data-m="' + ovpMode + '">' + legacyCard + tieredCard + "</div>"
    : "";
  }

  function renderCardSwatch(d, scanCk) {
    // ===== 8. 色板 (zhiban v10.16/v0.7.8 移植) =====
    //   展示: 色板 / 渐变 / 图案 / 颜色组 的总数 · 在用 · 未使用; 未使用超 0 挂清理按钮。
    //   ⚠ jsx 侧这些字段只在卡⑧开启时才存在 —— 关掉(或旧版 jsx)一律当 null,
    //     不参与任何算术(NaN 会让 if 恒假 ⇒ 静默空白)。
    var sw = d.swatch || null;
    var gd = d.gradient || null;
    var pt = d.pattern || null;
    var sg = d.swatchGroup || null;   // 颜色组(旧版 jsx / 不支持时=null)
    var sHtml = "", sLevel = "ok", sChip = "无未使用";
    var sUnusedSw = 0, sUnusedGd = 0, sUnusedPt = 0, sAnyData = false;
    if (sw) { sAnyData = true; sUnusedSw = sw.unused || 0; }
    if (gd) { sAnyData = true; sUnusedGd = gd.unused || 0; }
    if (pt) { sAnyData = true; sUnusedPt = pt.unused || 0; }
    // v11.39: 颜色采集失败 ⇒ 整卡改"统计失败"态。
    //   原先 jsx 侧采集失败时三个 Scan 各自兜成 {0,0,0}, 卡⑧ 会渲染成"色板 0 / 0 / 0"
    //   加绿标"无未使用" —— 与"文档真的很干净"完全同形, 用户无从分辨。
    //   宁可说不出数, 也不假装 0。(只在失败路径出现, 正常运行看不到)
    if (sw && sw.usedFailed) {
      return scanCk[6]
        ? card("色板", "warn", "统计失败",
            '<span class="dim">颜色采集失败，本轮色板、渐变、图案统计不可信，已整体跳过。' +
            "可先点「开始检查」重试。</span>")
      : "";
    }
    var sUnusedTotal = sUnusedSw + sUnusedGd + sUnusedPt;
    if (sAnyData) {
      if (sUnusedTotal > 0) { sLevel = "bad"; sChip = "未使用 " + sUnusedTotal + " 个"; }
      // v11.27(雪糕选 C): 三行同款句式 -> 一张表。四类对象 × 三列指标, 本来就是表格。
      //   ① 颜色组也进表(它只有总数, 在用/未使用读不到 ⇒ 显示 "—" 并附注)。
      //   ② "在用"**不标绿** —— 一列全是绿反而看不出重点, 只把"未使用 > 0"标红。
      var rows = ['<ul class="sw-tbl">' +
        '<li class="sw-h"><span class="sw-nm"></span><b>总数</b><b>在用</b><b>未使用</b></li>'];
      function rowOf(label, o, noDel) {
        if (!o) return "";
        var t = o.total || 0, un = o.unused || 0;
        var u = (o.used === undefined || o.used === null) ? "—" : String(o.used);
        var x = noDel ? "—" : String(un);
        var xc = (!noDel && un > 0) ? ' class="bad-t"' : "";
        return '<li><span class="sw-nm">' + esc(label) + "</span>" +
          "<b>" + t + "</b><b>" + u + "</b><b" + xc + ">" + x + "</b></li>";
      }
      rows.push(rowOf("色板", sw));
      rows.push(rowOf("渐变", gd));
      rows.push(rowOf("图案", pt));
      // 颜色组: AI 28 读不到成员(v0.7.8), 本版一律不删 ⇒ 后两列给 "—"
      if (sg && sg.supported) {
        rows.push(rowOf("颜色组", { total: sg.total || 0 }, true));
      }
      rows.push("</ul>");
      sHtml = rows.join("");
      if (sUnusedTotal > 0) {
        sHtml += '<div class="action-row">' +
          '<button class="btn-action" id="btnClearSwatches"' +
          ' title="删除未被任何对象引用的色板、渐变、图案(不删除颜色组)">' +
          '删除未使用的色板</button>' +
          '</div>';
      }
      // v11.88(雪糕): 删掉表下那两行"判定口径"说明(统计范围, 以及"颜色组一律不删")。
      //   那两句是**口径备注**, 对"我该点哪个按钮"没有帮助 —— 表里的数字已经说完了,
      //   却固定占掉卡片底部三行高度(300px 宽面板下这段会折成三行)。
      //   ⚠ 口径本身没改, 只是不再印在面板上: 仍写在 README「卡 ⑧ 色板」的判定行里,
      //     以及 pfSwatchScan / pfSwatchUsed / pfClearUnusedSwatchGroups 的注释里。
    } else {
      // v10.46: 无数据态徽标同步改"未检查" —— 旧实现只改 sHtml,
      //   徽标仍是初始值"无未使用"(绿色), 与正文"未检查。"自相矛盾。
      sHtml = '<span class="dim">未检查。</span>';
      sChip = "未检查";
      sLevel = "warn";
    }
    return scanCk[6]
      ? card("色板", sLevel, sChip, sHtml)
    : "";
  }

  // v11.16(雪糕 审查 ⑫ 同款拆分): 从 render 拆出的第 9 张卡 —— 清理。
  //   ===== 9. 清理 =====
  //   对照 Illustrator 自带「对象 > 路径 > 清理」的三个勾选项:
  //   游离点 / 未上色对象 / 空文本路径。计数只报数不给样本(这三类本来就看不见)。
  //   ⚠ jsx 侧 d.cleanup 只在卡⑨开启时才存在 —— 关掉(或旧版 jsx)一律当 null,
  //     不参与任何算术(NaN 会让 if 恒假 ⇒ 静默空白)。
  function renderCardCleanup(d, scanCk) {
    var cl = d.cleanup || null;
    // v11.31(审查 Bug2): 补 cChipLevel —— 原实现第五参恒为 `nAll > 0 ? "bad" : "ok"`,
    //   cl 为 null(卡⑨关闭 / 旧版 jsx 无 cleanup 字段)时 nAll 仍是 0 ⇒ 算出 "ok"
    //   ⇒ **绿色徽标配"未检查"三个字**, 与正文自相矛盾。这正是 v10.46 审查 P2-3 给卡⑧
    //   修过的同一个坑(卡⑧已改为回落 sLevel, 卡⑨ v11.16 才加, 漏跟)。
    //   现在徽标级别独立三态: 未检查黄 / 有命中红 / 正常绿 —— 与卡⑧、卡⑤ 口径一致。
    // v11.66(P1/P2/P5): 三项一起改 ——
    //   ① "3 个" -> "可清理 3 个"(原写法数字打头, 看不出这 3 个是什么);
    //   ② ok 态 "无" -> "无需清理"(与"无叠印/无未使用"同一族);
    //   ③ 卡片级由 warn 升 bad, 与红色徽标对齐(原先黄条配红标)。
    var cHtml = "", cLevel = "ok", cChip = "无需清理", cChipLevel = "ok", nAll = 0;
    if (cl) {
      var nStray = (cl.stray && cl.stray.count) || 0;
      var nUnp = (cl.unpainted && cl.unpainted.count) || 0;
      var nTxt = (cl.emptyText && cl.emptyText.count) || 0;
      nAll = nStray + nUnp + nTxt;
      var cHid = ((cl.stray && cl.stray.hidden) || 0) + ((cl.unpainted && cl.unpainted.hidden) || 0) +
                 ((cl.emptyText && cl.emptyText.hidden) || 0);
      var cLck = ((cl.stray && cl.stray.locked) || 0) + ((cl.unpainted && cl.unpainted.locked) || 0) +
                 ((cl.emptyText && cl.emptyText.locked) || 0);
      if (nAll === 0) {
        cHtml = '无游离点、未上色对象、空文本。';
      } else {
        cLevel = "bad"; cChip = "可清理 " + nAll + " 个"; cChipLevel = "bad";
        cHtml = '<div>游离点 <b class="warn-t">' + nStray + "</b> 个 · 未上色对象 <b class=\"warn-t\">" +
          nUnp + "</b> 个 · 空文本 <b class=\"warn-t\">" + nTxt + "</b> 个。</div>";
        if ((cl.spaceOnly || 0) > 0) {
          cHtml += '<div>空文本中纯空格 <b class="warn-t">' + cl.spaceOnly + "</b> 个。</div>";
        }
        if (cHid + cLck > 0) {
          cHtml += '<div class="dim">其中隐藏 ' + cHid + " 个、锁定 " + cLck + " 个，一并清理</div>";
        }
        cHtml += '<div class="action-row"><div class="chk-row">' +
          '<label class="chk" title="只有一个锚点、没有长度的路径"><input type="checkbox" id="clStray"> 游离点</label>' +
          '<label class="chk" title="既无填充也无描边的路径对象"><input type="checkbox" id="clUnpaint"> 未上色对象</label>' +
          '<label class="chk" title="内容为空或纯空白的文本框(对应 AI 的 对象 > 路径 > 清理 > 空文本路径)"><input type="checkbox" id="clText"> 空文本</label>' +
          '</div><button class="btn-action" id="btnCleanup"' +
          ' title="清理整个文档，含隐藏与锁定的对象">一键清理</button></div>';
      }
    } else {
      cHtml = '<span class="dim">未检查。</span>';
      cChip = "未检查"; cLevel = "warn"; cChipLevel = "warn";
    }
    // v11.41: 有命中 → 卡头定位按钮 (pfLocate(9) 选中游离点/未上色/空文本，口径同 pfJunkEach)
    return scanCk[7]
      ? card("清理", cLevel, cChip, cHtml, cChipLevel, "", nAll > 0 ? 9 : 0)
    : "";
  }

  // ===== 9. 专色描边(手工陷印) =====
  //   v11.87: zhiban v0.9.2 第⑨卡整套移植(规则/口径一字未改), 只把**卡体文案改成表格**
  //   —— 雪糕指定照色板卡那张三列表来, 不再用一长串"某某 个"的行文:
  //       专色      · 需加 4 · 已加 1 · 待加 3
  //       相邻四色  · 需加 2 · 已加 0 · 待加 2
  //   列头用「需加 / 已加 / 待加」而不是「总数 / …」: 专色的总数里含"只贴白/空白"的一批
  //   (按规则不处理), 把它放第一列会让"6 个里已加 1、待加 2"这种账怎么算都不平。
  //   总数改在表下那句灰字里交代(专色共 N 个, 其中 M 个只贴白/空白不处理)。
  //   ⚠ d.spotTrap 只在卡⑨开启时存在 —— 关掉(或旧版 jsx)一律当 null, 不参与任何算术
  //     (NaN 会让 if 恒假 ⇒ 静默空白, 与卡⑧/卡⑨ 同一个坑)。
  function renderCardSpotTrap(d, scanCk) {
    var stp = d.spotTrap || null;
    var tHtml = "", tLevel = "ok", tChip = "无专色", tTip = "";
    if (stp) {
      var tTotal = stp.spotTotal || 0;          // 专色填充图元总数(含只贴白的)
      var tNeed = stp.spot || 0;                // 其中需要加描边的(与四色或另一专色相邻)
      var tNeedDone = stp.spotDone || 0;        // 其中已带同色叠印描边的
      var tAdj = stp.cmykAdj || 0;              // 贴着专色的四色
      var tAdjDone = stp.cmykAdjDone || 0;
      var tWhite = stp.white || 0;              // 白色块(C0M0Y0K0 或 纸色/白色色板): 跳过, 也不当邻居
      var tIdle = stp.spotIdle || 0;            // 只贴白/空白的专色: 按规则不处理
      var tText = stp.textSkipped || 0;
      // v11.96: 两个新桶 —— 卡上必须把它们说出来, 否则"报的数和画面对不上"没法解释
      var tKept = stp.strokeKept || 0;          // 已有**别色**描边: 整条不算需加, 也不动手
      var tLock = stp.spotLocked || 0;          // 锁定/隐藏的专色: 动手时跳过, 所以不算"待加"
      // v11.95(雪糕): 已有**同族**描边的(tNeedDone/tAdjDone)计入「已加」但执行端不改粗细。
      //   「待加」= 需加 - 已加 = 完全没有描边的那批 ⇒ 正好是执行端会动手的集合。
      var tLeft = (tNeed - tNeedDone) + (tAdj - tAdjDone);

      // 表行: 名称 + 需加 / 已加 / 待加; 待加 > 0 标红(与色板卡"未使用 > 0 标红"同一套)
      function tRow(nm, need, done) {
        var left = need - done;
        return '<li><span class="sw-nm">' + esc(nm) + "</span>" +
          "<b>" + need + "</b><b>" + done + "</b>" +
          '<b class="' + (left > 0 ? "bad-t" : "dim") + '">' + left + "</b></li>";
      }
      // 表下那句"账": 把没进"需加"的专色一律点名, 否则第一列的数字对不上"文档里到底几个专色"。
      //   ⚠ 长度必须省着写 —— 240px 内容宽约 20 个汉字/行, 全列出来最多两行还行, 三行就压卡片了。
      var tWhy = [], tSkip = [];
      if (tIdle > 0) tWhy.push(tIdle + " 个只贴白");
      if (tKept > 0) tWhy.push(tKept + " 个已有别色描边");
      if (tLock > 0) tWhy.push(tLock + " 个锁定");
      if (tWhite > 0) tSkip.push("白色块 " + tWhite);
      if (tText > 0) tSkip.push("文字 " + tText + " 处");
      var tWhyStr = tWhy.length ? "，另有 " + tWhy.join("、") + "（不加）" : "";
      var tSkipStr = tSkip.length ? "；" + tSkip.join("、") + "跳过" : "";
      if (tTotal > 0) {
        if (tNeed > 0) {
          tLevel = tLeft > 0 ? "bad" : "ok";
          // v12.9: 补量词 —— 全站徽标口径是「名词 + 数字 + 量词」(隐藏 12 个 / 缺失 1 张 /
          //   未使用 4 个), 只有这里写成"待加 3"。
          tChip = tLeft > 0 ? "待加 " + tLeft + " 个" : "已加完";
          tHtml = '<ul class="sw-tbl">' +
            '<li class="sw-h"><span class="sw-nm"></span><b>需加</b><b>已加</b><b>待加</b></li>' +
            tRow("专色", tNeed, tNeedDone) +
            (tAdj > 0 ? tRow("相邻四色", tAdj, tAdjDone) : "") +
            "</ul>";
          tHtml += '<div class="dim">专色共 ' + tTotal + " 个" + tWhyStr + tSkipStr + "。</div>";
          // v11.103: 回到**一颗**全宽按钮(雪糕: "算了, 这个按钮去掉吧, 只保留一个")。
          //   v11.102 试过并排两颗(选中加描边 / 全部加描边), 用过之后决定不要手动那颗;
          //   手动入口在 jsx(pfSpotTrapSel)与 css(.btn-row)里一并删干净, 不留死代码。
          // ⚠ 换算提示必须**短**: 卡片内容宽只有 ~240px, 一行装得下
          //   「描边宽(48) + 输入(56) + mm(26) + 提示(75) + 三个 8px 间距」= 229。
          //   写成"外扩 = 描边宽 ÷ 2"会到 250px ⇒ 在 300px 面板里折成第二行(截图确认过)。
          tHtml += '<div class="trap-row">' +
            '<label class="trap-lb" for="inpTrapW">描边宽</label>' +
            '<input type="number" id="inpTrapW" class="th-in trap-in" min="0.01" max="10" step="0.05" value="' +
            trapWidth() + '">' +
            '<span class="th-unit">mm</span>' +
            '<span class="trap-eq">外扩 = 宽 ÷ 2</span></div>';
          // 文案: v11.103 起叫「一键加描边叠印」—— 12 字的老名字也放得下, 但既然只剩一颗,
          //   用雪糕自己叫的名字更顺口; title 里保留"自动选中"的完整说明。
          tHtml += '<div class="action-row">' +
            '<button class="btn-action" id="btnSpotTrap"' +
            ' title="自动选中需加描边的专色 + 贴着专色的四色，并给它们加同色描边 + 描边叠印（整圈描边：贴白那侧也会外扩）；本来就有其他颜色描边的对象不动">' +
            '一键加描边叠印</button></div>';
        } else {
          // 有专色, 但没有一个需要处理(只贴白 / 已有别色描边 / 锁定)。
          //   ⚠ 这里**不出表**: 一张 0/0/0 的表只是噪声, 一句话说得更清楚。
          //   v11.96: 不能再一口咬定"全部只与白色块/空白相邻" —— 也可能是"已有其他描边的",
          //     那句话会把责任推给白块, 用户照着去查白块什么也查不到。
          tLevel = "ok";
          tChip = tKept > 0 && tIdle === 0 ? "已有描边" : "无需陷印";
          // ⚠ 这句要短: 240px 内容宽约 20 汉字/行, 三个桶全列出来本来就两行,
          //   再拖一句"按规则无需加描边"就压成三行了(300px 面板实测)。
          tHtml = '<div class="dim">专色共 ' + tTotal + " 个" + tWhyStr +
            (tWhy.length ? "。" : "，全部只与白色块/空白相邻，按规则不加描边。") + "</div>";
        }
      } else {
        // v12.8(雪糕): 空态与其余七卡统一成"一句话" —— 原先这里拖着两行适用范围
        //   （本卡只处理「填充为专色」的图元…），在 300px 面板里独占两行，是整页唯一
        //   一个空态不极简的卡。适用范围不是"每次扫完都要读"的信息 ⇒ 挪到整卡悬停提示。
        //   ⚠ 文案里的括注用半角（main.js 正文禁全角括号, bt v9.9 守着）。
        tHtml = '<span class="dim">没有专色填充对象。</span>';
        tTip = "只处理「填充为专色」的图元，以及贴着专色的四色图元；渐变 / 图案 / 文字不处理。";
      }

      // v11.89(雪糕): 删掉卡片末尾那三行"规则 / 两条 ⚠"脚注。
      //   规则说明不该常驻在卡片上 —— 它是"查手册时看的东西", 不是"每次扫完都要读一遍"的东西;
      //   而它固定占掉四到六行高度, 300px 面板里这张卡本就已经很高了。
      //   ⚠ 规则与两条限制本身一个字都没变, 只是换了存放位置:
      //     规则矩阵 → README「卡 ⑨ 专色描边」的相邻关系表;
      //     整圈描边 / 包围盒近似这两个限制 → README 同节的三条 ⚠ 引用块, 以及按钮 title。
    } else {
      tHtml = '<span class="dim">未检查。</span>';
      tChip = "未检查";
      tLevel = "warn";
    }
    return scanCk[8] ? card("专色描边", tLevel, tChip, tHtml, null, null, null, tTip) : "";
  }

  // ===== v11.90: 卡⑩「对照」=====
  //   雪糕定的流程: 复制当前画板上的可见对象 → 栅格化 300ppi → 新建图层 → 置最顶层
  //   → 透明底 → 位置不变 → 原稿不动 → 透明度可调(默认 50%, **只在下次重建时生效**)。
  //   卡片只做两件事: 报告"在不在 / 层里那张是什么样" + 一颗建立或重建的红按钮。
  //   ⚠ 刻意**不做**显示/隐藏、也不做删除: 显隐在 AI 图层面板里一眼可见一眼可点;
  //     而"删除"多一颗按钮就多一条手滑路径 —— 这一层删掉等于把"处理前"永久丢了。
  //   ⚠ 透明度输入框改动**不重扫、不重绘**(与卡⑨ 描边宽同一套处理): 一重扫整页刷新,
  //     输入框会失焦, 边改边看数字的体验直接崩。
  //
  // 🔴 v11.116: 「差异比对」**正式上线**（雪糕 2026-11-24: "卡⑩「比对变化」上线"）。
  //   v11.113 曾整块下线(当时是"先发别人, 不想让别人看到"), 现在放回来。
  //   开关保留不删 —— 下次要临时藏起来只改这一行, 别去动渲染分支。
  var PF_SHOW_DIFF = true;
  function renderCardSnapshot(d, scanCk) {
    var sn = d.snap || null;
    var sHtml = "", sLevel = "warn", sChip = "未检查";

    // 透明度输入行(两种状态共用)
    function opRow() {
      return '<div class="trap-row">' +
        '<label class="trap-lb" for="inpTrapOp">透明度</label>' +
        '<input type="number" id="inpTrapOp" class="th-in trap-in" min="5" max="95" step="5" value="' + snapOp() + '">' +
        '<span class="th-unit">%</span></div>';
    }

    if (!sn) {
      sHtml = '<span class="dim">未检查。</span>';
    } else if (sn.exists) {
      var sAct = (typeof sn.opacity === "number" && sn.opacity > 0) ? sn.opacity : 0;
      sLevel = "ok";
      sChip = "已建";
      sHtml = '<div class="dim">已建立 · 300ppi · 最顶层 · 锁定 · 不打印' +
        (sn.wmm > 0 ? ' · ' + sn.wmm + '×' + sn.hmm + 'mm' : '') + '</div>';
      if (sn.rasters < 0) {
        // jsx 侧读 pageItems 抛了异常(层被占用/损坏) —— 与"空层"分开报, 别让用户以为图没了。
        sLevel = "warn";
        sChip = "读不到";
        sHtml += '<div class="dim">层在，但读不到里面的内容（可能正被其它程序占用）。点重建可恢复。</div>';
      } else if (!(sn.rasters > 0)) {
        // 层在、但没有栅格图: 用户手动清空过。仍然给"重建", 不然只能自己删层。
        sLevel = "warn";
        sChip = "空层";
        sHtml += '<div class="dim">这一层里没有栅格图（可能被手动删掉了），点重建即可恢复。</div>';
      }
      sHtml += opRow();
      // 只有"输入框的值和层里实际值不一致"才提示 —— 一致时这句话纯属噪声。
      if (sAct > 0 && sAct !== snapOp()) {
        sHtml += '<div class="dim">层内实际 ' + sAct + '% —— 改动点「重建」后生效。</div>';
      }
      sHtml += '<div class="action-row"><button class="btn-action" id="btnSnap" data-old="1">重建处理前对照</button></div>';
      // v11.105: 只有对照图确实在时才给"比对变化" —— 空层比不了。
      //   v11.113: 外层再挂 PF_SHOW_DIFF, 整个差异比对块(灵敏度 + 忽略细边 + 按钮)暂时下线。
      if (PF_SHOW_DIFF && sn.rasters > 0) {
        // v11.108: 灵敏度三档 —— 复用弹层那套 .ovp-seg 胶囊, 与"叠印版本"同一视觉语言。
        //   title 里带上当前档的实际参数, 想深究的人悬停就能看到数字。
        var dp = diffParams();
        sHtml += '<div class="trap-row"><label class="trap-lb">灵敏度</label>' +
          '<span class="ovp-seg" id="diffSeg" title="当前: 阈值 ' + dp.th +
          ' · 块命中 ' + dp.hit + ' · 最小块 ' + dp.minb +
          '（阈值/块命中/最小块越大 = 判定越钝、框越少）">' +
          '<i data-s="0"' + (DIFF_SEN === 0 ? ' class="on"' : '') + '>少圈</i>' +
          '<i data-s="1"' + (DIFF_SEN === 1 ? ' class="on"' : '') + '>标准</i>' +
          '<i data-s="2"' + (DIFF_SEN === 2 ? ' class="on"' : '') + '>多圈</i>' +
          '</span></div>';
        // v11.109: 「忽略细边」—— 勾上后腐蚀跑两遍, 不再圈 0.2mm 那种细描边
        sHtml += '<div class="chk-row"><label class="chk"' +
          ' title="勾上后，宽度 ≤0.2mm 的细边变化（比如本面板刚给专色加的那圈描边）不再圈出来。' +
          '代价：真正的细微改动也可能被一并忽略——要抓小改动就把勾去掉、并切到「多圈」">' +
          '<input type="checkbox" id="chkDiffEdge"' + (DIFF_EDGE ? ' checked' : '') + '>' +
          ' 忽略 0.2mm 以内的细边</label></div>';
        sHtml += '<div class="action-row">' +
          '<button class="btn-action" id="btnDiff"' +
          ' title="把当前版面和对照图逐像素比对，有变化的区域用红框圈在「对照-差异(可删)」图层里；不改动稿子内容，框可整体删掉">' +
          '比对变化</button></div>';
      }
    } else {
      sLevel = "warn";
      sChip = "未建";
      sHtml = '<div class="dim">复制当前画板的可见对象 → 栅格化 300ppi → 放进新图层，置顶透明。原稿不动，位置不变。</div>' +
        opRow() +
        '<div class="action-row"><button class="btn-action" id="btnSnap" data-old="0">建立处理前对照</button></div>';
    }
    return scanCk[9] ? card("对照", sLevel, sChip, sHtml) : "";
  }

  // ---------- 执行 JSX 操作并刷新 ----------
  // v5.6/F7: 执行期间禁用按钮+显示 loading,防连点排队重复执行
  var actionBusy = false;
  // v12.6: 动作轮次号 —— 与 run() 的 scanSeq 同一套路。
  //   为什么需要: actBegin 的 20s 超时会**故意**放开 actionBusy(v10.43, 大 PDF 不干等),
  //   用户接着点第二个动作后, 第一个动作的迟到回调仍会调 actEnd 把第二个的锁清掉,
  //   表现为"第二个动作还没完, 按钮就亮了 / loading 先灭了"。
  //   有了轮次号, 回调先认领"我还是不是当前这一轮", 不是就只收自己的计时器。
  var actionSeq = 0;

  // v11.1(审查 ⑥): 动作执行的三段公共流程提到这里 —— 原先 execAction 与
  //   execActionMulti 各自抄了一遍"上锁 + 禁按钮 + 挂超时兜底"和"解锁 + 复按钮 + 收尾提示",
  //   共约 30 行逐字重复。v10.43 那次就只改了 execAction 的超时分支(审查 P2-a),
  //   execActionMulti 是后来照着补的 —— 两份同构代码就是两只脚踩两条船, 迟早再走散。
  //   现在只有一处可改: actBegin(上锁) / actEnd(解锁) / actFinish(刷新+补放提示)。
  function actBegin() {
    actionBusy = true;
    $("btnRun").disabled = true;
    $("loading").classList.remove("hidden");
    var btns = document.querySelectorAll(".btn-action");
    for (var bi = 0; bi < btns.length; bi++) btns[bi].disabled = true;
    // v8.6: 大 PDF 栅格化等操作可能远超 20 秒,期间 loading 一直转却毫无反馈。
    //   复用 run() 的超时口径: 20 秒补一句"仍在继续";操作本身不中断
    //   (ExtendScript 无多线程,停不下来),回调到达时清掉计时器。
    return setTimeout(function () {
      // v10.43(审查 P2-a): 超时后放开动作锁 + 恢复各卡按钮 —— 大 PDF 操作可能数分钟,
      //   期间 actionBusy 锁死、.btn-action 全禁用, 用户只能干等。放开不等于重发: 已发出的
      //   jsx 照跑, 回调到达时再收尾; 期间新点的动作排进 ExtendScript 队列依次执行。
      //   btnRun 一并恢复(只读动作, 与 v8.6 扫描超时口径一致; 真有扫描在跑时
      //   scanBusy 会挡下重复点击)。loading 不动 —— 操作/扫描谁在跑都该转着。
      actionBusy = false;
      $("btnRun").disabled = false;
      var btns2 = document.querySelectorAll(".btn-action");
      for (var bj = 0; bj < btns2.length; bj++) btns2[bj].disabled = false;
      showNotice("操作耗时较长，后台仍在继续。期间可进行其他操作，完成后会自动刷新结果。");
    }, BUSY_TIMEOUT_MS);
  }

  // 解锁 + 恢复按钮/loading(就地恢复, 不依赖 run() 收尾)
  function actEnd(timer) {
    clearTimeout(timer);
    actionBusy = false;
    // v10.43(审查 P1-a): 按钮/loading 的恢复**不再依赖 run() 收尾** —— run() 开头有
    //   scanBusy / !inCEP 两道提前 return, 一旦被挡(操作回调与手动扫描撞上, 或非 CEP
    //   环境), btnRun 会永久禁用、loading 常驻。就地恢复, 状态自愈。
    $("btnRun").disabled = false;
    if (!scanBusy) $("loading").classList.add("hidden");   // 扫描并发中还转着
  }

  // 刷新检查结果 + 结论补放
  //   v10.43(P1-a): 结论先存变量、不急着显示 —— run() 被 scanBusy 挡下时它开头那句
  //   "正在检查中"会覆盖提示, 操作成败就石沉大海; 挪到 run() 之后按需补放。
  function actFinish(failed, msg) {
    // v8.8: 失败时传 keepError，避免刚弹的红条被本轮 run() 抹掉
    run(true, failed);
    if (scanBusy && msg) {
      if (failed) showError(msg); else showNotice(msg);
    }
  }

  // 失败文案(两个执行器同款)
  function actFailMsg(data, raw) {
    return (data && data.error)
      ? data.error
    : ("操作失败。返回: " + String(raw).substring(0, 120));
  }

  function execAction(jsxFns, successMsg) {
    // v11.39: 静默吞点击 → 给一句提示。按钮虽已被 actBegin 置 disabled, 但
    //   .btn-action 之外还有可点目标(设置齿轮、遮罩里的按钮), 撞上时原实现纯粹无声,
    //   用户只会觉得"点了没反应、面板卡了"。与 run() 的"正在检查中"同一口径。
    if (actionBusy) { showNotice("上一个操作还在执行，请稍候再试。"); return; }
    var mySeq = ++actionSeq;   // v12.6: 本轮号(与 scanSeq 同法)
    var actTimer = actBegin();
    execJsx(jsxFns, function (data, raw) {
      // v12.6: 超时放开锁后用户已点了新动作 ⇒ 本轮作废。只收自己的计时器,
      //   别去动新一轮的 actionBusy / 按钮 / 结果(与 run() 里的 mySeq 同一判法)。
      if (mySeq !== actionSeq) { clearTimeout(actTimer); return; }
      actEnd(actTimer);
      var ok = !!(data && data.ok);
      // v8.8: 失败路径要保留错误提示(见 actFinish)
      var actMsg = ok ? (data.message || successMsg || "操作完成") : actFailMsg(data, raw);
      actFinish(!ok, actMsg);
    });
  }

  // ---------- v10.13: 串行执行多个 JSX 动作(zhiban v10.13 移植) ----------
  //   逐个执行, 任一失败**即停**并报错(fail-fast); 全部完成后统一刷新一次。
  //   ⚠ 与 execAction 共用 actionBusy 锁, 防连点。
  //   ⚠ 对 zhiban 原版的两处修正:
  //     ① 原版失败分支是「先 step() 后 idx=calls.length」—— step 同步执行时会
  //        把下一步也发出去, 与"任一失败即停"的注释矛盾; 先封口再收尾才是真 fail-fast。
  //     v10.41: 原②「随动作一并禁用/恢复顶栏那枚按钮」随「全部清理」按钮一并移除。
  function execActionMulti(calls, successMsg) {
    if (actionBusy) { showNotice("上一个操作还在执行，请稍候再试。"); return; }   // v11.39
    if (!calls || !calls.length) return;
    var mySeq = ++actionSeq;   // v12.6: 整串共用一个轮次号
    var actTimer = actBegin();
    var msgs = [], idx = 0, failed = null, raw0 = "";
    function step() {
      // v12.6: 已被新一轮接管 ⇒ 立刻停(不再发下一个 call, 也不 actEnd)。
      //   已发出的 jsx 照跑完, 但后续步骤不再执行 —— 否则两串操作会交错,
      //   而且旧串的 actEnd 会把新一轮的锁清掉。
      if (mySeq !== actionSeq) { clearTimeout(actTimer); return; }
      if (idx >= calls.length) {
        actEnd(actTimer);
        var multiFailed = !!failed;
        var multiMsg = multiFailed
          ? actFailMsg(failed.data, raw0)
        : (msgs.join(" ") || successMsg || "操作完成");
        actFinish(multiFailed, multiMsg);
        return;
      }
      var call = calls[idx++];
      execJsx(call, function (data, raw) {
        if (data && data.ok) {
          if (data.message) msgs.push(data.message);
          step();
        } else {
          failed = { data: data }; raw0 = raw;
          idx = calls.length;   // v10.13 修正: 先封口再收尾(原版顺序会多跑一步)
          step();
        }
      });
    }
    step();
  }

  // 转曲前的图层处理选项(默认勾选;面板重绘后状态保留)
  // v5.6: 状态持久化到 localStorage,重开面板保持上次选择(读取失败保持默认)
  var CHK_SHOW = true, CHK_UNLOCK = true;
  // v9.5: 叠印卡「解锁全部」—— 默认**不勾**(维持 v9.4 的"不动图层状态"默认), 状态同样持久化
  var CHK_OVP_UNLOCK = false;
  // v11.91: 卡⑥「四色黑转单黑」的解锁前置 —— 与叠印卡同一个默认(不勾)、同一套持久化。
  //   不勾时锁定/隐藏对象跳过并如实回报, 免得"点了没反应"却不解释。
  var CHK_RB_UNLOCK = false;
  // v10.28: 两版「解锁全部」统一写入口 —— 简洁版/分级版任一勾选即同步, 修复两版勾选不同步
  function syncOvpUnlock(v) {
    CHK_OVP_UNLOCK = v;
    try { localStorage.setItem("pf_chkOvpUnlock", v ? "1" : "0"); } catch (e) {}
    // v11.39: 叠印两版(简洁/分级)的 DOM 常驻, 勾选态却各存一份 ——
    //   原实现只写内存+存档, 另一版要等下次 run() 整块重绘才跟上, 期间两版显示相反。
    //   这里直接把两处 DOM 一并同步(值相同 ⇒ 不会再触发 onchange, 无回环)。
    var ids = ["chkOvpUnlock", "tChkOvpUnlock"], i, el;
    for (i = 0; i < ids.length; i++) {
      el = $(ids[i]);
      if (el) el.checked = v;
    }
  }
  // v10.32: 叠印版本(pf_ovpMode)读写统一收口(审查 #12/#13) —— 原散落 5 读 1 写,
  //   键名拼错/口径不一都无从查; 现在全工程只经这两个函数(键名只此一处字面量)。
  // v10.33: PF_OVP_MODE_KEY 已上提到 IIFE 顶部常量区, 此处不再声明。
  function readOvpMode() {
    try { if (localStorage.getItem(PF_OVP_MODE_KEY) === "tiered") return "tiered"; } catch (eRm) {}
    return "legacy";
  }
  function writeOvpMode(m) {
    var mm = (m === "tiered") ? "tiered" : "legacy";
    try { localStorage.setItem(PF_OVP_MODE_KEY, mm); } catch (eWm) {}
    return mm;
  }
  // v10.37: 设置弹层草稿快照 —— 进场时记下开关/顺序/叠印模式的"当时值",
  //   点「关闭」/Esc/点遮罩时整体回滚; 点「确认」才落盘。null = 弹层未打开。
  //   ⚠ 这是"关闭 = 真正取消"的实现基础(雪糕反馈: 原先点关闭, 上面的改动照样生效)。
  var SET_SNAP = null;
  // v10.43(审查 P1-b): 叠印版本的**弹层草稿** —— 原先 setOvpMode 直接覆写 SET_SNAP.ovp,
  //   进场快照被改成"改动后的值", 「关闭」回滚时 applyOvpModeUI(SET_SNAP.ovp) 复位到的
  //   是改动值而非原值 ⇒ 关闭=不关闭。现在快照只读, 切换只写这里; null = 本次未改过。
  var SET_OVP = null;
  // 叠印模式取"当前该显示的值": 弹层开着读草稿, 否则读已存值。
  function ovpModeNow() {
    if (SET_SNAP) return (SET_OVP !== null ? SET_OVP : SET_SNAP.ovp);
    return readOvpMode();
  }
  // v10.14: 分级版规则勾选(清除需处理叠印默认勾 / 单黑加叠印默认不勾 —— zhiban 同款)
  var CHK_CLEAR_WHITE = true, CHK_ADD_K100 = false;
  try {
    if (localStorage.getItem("pf_chkShow") !== null) CHK_SHOW = localStorage.getItem("pf_chkShow") === "1";
    if (localStorage.getItem("pf_chkUnlock") !== null) CHK_UNLOCK = localStorage.getItem("pf_chkUnlock") === "1";
    if (localStorage.getItem("pf_chkOvpUnlock") !== null) CHK_OVP_UNLOCK = localStorage.getItem("pf_chkOvpUnlock") === "1";
    if (localStorage.getItem("pf_chkRbUnlock") !== null) CHK_RB_UNLOCK = localStorage.getItem("pf_chkRbUnlock") === "1";   // v11.91
    if (localStorage.getItem("pf_chkClearWhite") !== null) CHK_CLEAR_WHITE = localStorage.getItem("pf_chkClearWhite") === "1";
    if (localStorage.getItem("pf_chkAddK100") !== null) CHK_ADD_K100 = localStorage.getItem("pf_chkAddK100") === "1";
  } catch (eLS) {}

  // v5.6/体验①: 上次结果的文档指纹; 供动作入口的 docGuard 比对(切换过文档就拦下)
  //   v11.33: 自动重扫已移除, 这个指纹只剩"防误改"这一个用途。
  var lastDocKey = null;
  // v11.104: 最近一轮扫描结果 —— 只给"确认框报数量"用(删隐藏 / 清理 / 删色板 / 加描边)。
  //   这些数字本来就在 res 里, 之前只是没接出来; 用户点不可逆按钮之前最想知道的正是"会有多少"。
  //   ⚠ 只在 render 成功时覆盖, 失败时保留上一轮 —— 与 lastDocKey 同一套生命周期。
  var LAST_SCAN = null;
  function docKey(d) { return d.docName + "|" + d.docPath; }

  // 自定义确认框(替代原生 confirm: 原生无法改配色/按钮文字/字号)
  // 黑色主题 + 中文大按钮; 回车=确定, Esc=取消
  // v9.9: 第三参 title —— 标题按场景给(确认转曲 / 确认嵌入 / 确认清除叠印), 缺省仍为"提示"
  function customConfirm(msg, onOk, title) {
    var mask = $("modalMask"), msgEl = $("modalMsg");
    var titleEl = $("modalTitle");
    var okBtn = $("modalOk"), cancelBtn = $("modalCancel");
    // v10.43(审查 P2-b): 原先 DOM 缺失时 `if (onOk) onOk()` —— 直接执行破坏性操作!
    //   确认框的意义就是"问一句", 问不了时必须**取消**并如实报错, 而不是替用户点确定。
    if (!mask || !msgEl || !okBtn || !cancelBtn) { showError("确认框初始化失败，操作已取消。"); return; }
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

  // v10.35: 动作执行前的文档指纹校验 —— 六个破坏性入口(转曲/嵌入/清叠印/
  //   叠印规则/删隐藏/清未用色板)在确认框**开着**时, 用户完全可能在 Illustrator 里切到
  //   另一份文档(切文档不关面板 DOM)。确认框一旦点"确定", jsx 侧一律改 app.activeDocument
  //   ⇒ 改的是**切过去的那份**, 与用户看着确认框时脑中的文档不是同一份。
  //   包一层 guard: 执行前同步探一次 pfDocKey, 与上次渲染记录的 lastDocKey 不一致就直接
  //   取消并报错。代价 = 每次执行多一次跨桥(几十毫秒, 用户无感)。
  //   ⚠ 首轮尚未渲染(lastDocKey 为 null, 例如面板刚开、还没扫过)时**放行** —— 此时探到的
  //   key 反过来作为基准, 不能因为"没有基准"就把用户的操作挡掉。
  //   ⚠ 误拦场景(v11.33 起**不再存在**): 原先"切到 B 自动重扫 → 又切回 A → 防抖未结束就点
  //   按钮"会探到 A 与 lastDocKey=B 不符而取消。v11.33 移除焦点自动重扫后, lastDocKey 只在
  //   run() 里刷新, 故只有"切了文档又没重新检查就动按钮"这一种情况会被拦 —— 正是要拦的。
  //   方向仍是"宁可误拦, 不可误改"(再点一次即可)。
  function docGuard(runAction) {
    execJsx("pfDocKey();", function (d) {
      if (!d || !d.ok || !d.key) { if (runAction) runAction(); return; }  // 探针失败: 不阻断业务
      if (lastDocKey && d.key !== lastDocKey) {
        showError("检测到文档已切换，为免误改，操作已取消。请重新点按并确认。");
        return;
      }
      if (runAction) runAction();
    });
  }

  function onOutline() {
    var showAll = $("chkShowAll") ? $("chkShowAll").checked : CHK_SHOW;
    var unlockAll = $("chkUnlockAll") ? $("chkUnlockAll").checked : CHK_UNLOCK;
    var action = "";
    if (unlockAll && showAll) action = "将解锁全部图层与锁定对象(Ctrl+2/锁定组)，并显示隐藏图层与隐藏对象(Ctrl+3)，然后转曲文档中全部文字。";
    else if (showAll) action = "将显示全部图层与隐藏对象(不解锁)，然后转曲其中可见且未锁定的文字。";
    else if (unlockAll) action = "将解锁全部图层与锁定对象(Ctrl+2/锁定组)，不改动显示状态，然后转曲其中可见的文字。";
    else action = "将只转曲本就可见且未锁定的文字，不改动图层与对象状态。";
    // v11.104: 补一句"符号定义内的文字也会转曲" —— pfOutlineAll 会下钻符号定义源,
    //   一次转曲影响该符号的所有实例, 与"删隐藏对象"完全同型的坑, 那处 v11.94 已补, 这里补上。
    //   只在文档确实含符号时出现, 免得没符号的稿子多读一行无关信息。
    var symN = 0;
    try { symN = (LAST_SCAN && LAST_SCAN.symbols && LAST_SCAN.symbols.count) || 0; } catch (eSN0) {}
    customConfirm(action +
      (symN > 0 ? "\n符号定义内的文字也会一并转曲，影响该符号的所有实例。" : "") +
      "\n此操作不可撤销，确定继续?", function () {
      // v10.35: 执行前校验文档指纹, 防"确认框开着时切文档 → 改错文档"
      docGuard(function () {
        execAction("pfOutlineAll(" + showAll + ", " + unlockAll + ");", "转曲完成。");
      });
    }, "确认转曲");
  }
  // v8.1: 嵌入范围改为"点嵌入时按需统计" —— 旧版读本轮检查结果里的 linkedAll/linkedHidden,
  //   而那两个数是每轮检查都做一遍的全文档 placedItems 遍历,只为这个确认框服务(用户极少点)。
  //   现改为点按钮时现调 pfLinkScope();取数失败退回泛化文案,绝不阻断嵌入。
  var embedProbing = false; // 防连点:取数期间再点直接忽略
  // v10.28: 取数 10s 超时兜底 —— JSX 若因宿主卡死无回调, embedProbing 永远 true 会让嵌入按钮永久失灵
  var embedProbeTimer = null;
  // v10.39: 探针序号 —— 旧回调可能姗姗来迟, 把**新一轮**的 embedProbing/兜底 timer 清掉。
  //   setTimeout 回调里带的序号与当前 embedSeq 不符即视为过期, 直接丢弃(不碰任何状态)。
  var embedSeq = 0;
  function onEmbed() {
    if (embedProbing) return;
    embedProbing = true;
    var mySeq = ++embedSeq;
    embedProbeTimer = setTimeout(function () {
      embedProbing = false;
      embedProbeTimer = null;
    }, 10000);
    execJsx("pfLinkScope();", function (data) {
      if (mySeq !== embedSeq) return;   // 过期回调: 已被新一轮取代, 丢弃
      embedProbing = false;
      if (embedProbeTimer) { clearTimeout(embedProbeTimer); embedProbeTimer = null; }
      // v10.39: pfLinkScope 在"无文档"时回 ok:false —— 原实现把 ok 归并成 0, 于是弹出
      //   "文档中没有链接图"(与实际状态不符)。先判 ok, 不成立直接如实报错返回, 不弹确认框。
      if (!data || !data.ok) { showError((data && data.error) || "读取链接图信息失败。"); return; }
      var nAll = data.all || 0;
      var nHid = data.hidden || 0;
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
      : "文档中没有链接图，执行不会有任何改动。";
      customConfirm(scope +
        "\nPSD / TIF / PDF / AI 均跟随你在 Illustrator 里上次「嵌入」的导入选项。" +
        "\n此操作不可撤销，确定继续?", function () {
        // v10.35: 同上 —— 嵌入列表是按"点嵌入时的文档"取的, 确认期间切了文档必须拦。
        docGuard(function () {
          execAction("pfEmbedAll();", "嵌入完成。");
        });
      }, "确认嵌入");
    });
  }

  // v9.4: 一键清除叠印 —— 只关叠印属性,不动图层/对象状态;锁定与隐藏的跳过并如实报数。
  // v9.5: 加「解锁全部」复选框 —— 勾选后先解锁再清(锁定对象也能清), 隐藏对象始终不碰。
  //   ⚠ 文案没说"不可撤销": 转曲/嵌入是真的不可逆,而这个只是翻属性,撤销粒度我没验证过,
  //     不写死。要统一成"不可撤销"随时说。
  // v9.9: 文案统一 —— 全角()→ 半角()、"(Ctrl+2 / 锁定组)"→"(Ctrl+2/锁定组)"(与转曲弹窗一致),
  //   并补第三参标题"确认清除叠印"。
  function onOvpClear() {
    var uAll = CHK_OVP_UNLOCK;
    customConfirm("将关闭文档中全部叠印(文字与图形、填充与描边)。" +
      (uAll ? "\n已勾选「解锁全部」: 会先解锁全部图层与锁定对象(Ctrl+2/锁定组)，其叠印一并清除。"
          : "\n未勾选「解锁全部」: 锁定或隐藏的对象会跳过，其状态一律不改动。") +
      "\n隐藏对象与图层不参与叠印检查，本操作也不会改动它们。" +
      "\n此操作会直接修改文档，确定继续?", function () {
      // v10.35: 同上
      docGuard(function () {
        execAction("pfClearOverprint(" + uAll + ");", "清除叠印完成。");
      });
    }, "确认清除叠印");
  }

  // ---------- v10.14: 分级版叠印卡 —— seg 切换 + 规则动作执行 ----------
  // 切换只改 #ovpDual 的 data-m 属性(CSS 控制两版显隐), 选择记 pf_ovpMode, 默认简洁版。
  function setOvpMode(m) {
    // v10.37: 弹层内切换只改草稿 + UI, 不落盘 —— 由「确认」统一写(见 SET_SNAP 注释)。
    // v10.43(P1-b): 草稿写 SET_OVP(不再覆写 SET_SNAP.ovp 快照), 否则「关闭」回滚失效。
    var mm = (m === "tiered") ? "tiered" : "legacy";
    if (SET_SNAP) SET_OVP = mm;
    else writeOvpMode(mm);      // 弹层外的调用(当前无)仍即时落盘
    applyOvpModeUI(mm);         // v10.32: 选中态同步收口
  }
  // v10.32: 把"按模式同步 DOM 选中态"从 setOvpMode 里抽出来 ——
  //   drawRows 重绘 seg 后可复用它, 不必走 setOvpMode(避免重复写 localStorage)。
  //   范围钉死在设置弹层列表内, 不做全文档扫描。
  function applyOvpModeUI(mm) {
    var w = $("ovpDual");
    if (w) w.setAttribute("data-m", mm);
    var list = $("setList");
    var segs = list ? list.querySelectorAll(".ovp-seg i[data-m]") : [];
    for (var si = 0; si < segs.length; si++) {
      if (segs[si].getAttribute("data-m") === mm) segs[si].classList.add("on");
      else segs[si].classList.remove("on");
    }
  }
  // 执行勾选项: zhiban 同款 —— 第二个动作的 lockFirst = doW ? false : unlock(避免连跑两遍全文档解锁)。
  // 走 v10.13 execActionMulti 串行器(任一步失败即停并如实报错)。
  function onOvpApply() {
    var doW = $("tChkClearWhite") ? $("tChkClearWhite").checked : CHK_CLEAR_WHITE;
    var doK = $("tChkAddK100") ? $("tChkAddK100").checked : CHK_ADD_K100;
    var uT = CHK_OVP_UNLOCK;
    var calls = [];
    if (doW) calls.push("pfClearWhiteOverprint(" + uT + ");");
    if (doK) calls.push("pfAddK100Overprint(" + (doW ? false : uT) + ");");
    if (!calls.length) { showNotice("请先勾选要执行的规则(清除需处理叠印、单黑加叠印)。"); return; }
    customConfirm("将按勾选依次执行:\n" +
      (doW ? "· 清除需处理叠印(纯白 + 彩色)\n" : "") +
      (doK ? "· 为单黑(C0M0Y0K100)对象新增叠印\n" : "") +
      (uT ? "· 执行前先解锁全部图层与锁定对象\n" : "") +
      "此操作会直接修改文档，确定继续?", function () {
      // v10.35: 同上
      docGuard(function () {
        execActionMulti(calls, "叠印规则执行完成。");
      });
    }, "确认执行叠印规则");
  }

  // ---------- v11.91: 卡⑥ 四色黑 → 单黑 ----------
  //   与 onOvpApply 同一套: customConfirm 说清范围 → docGuard 防切文档误改 → execAction 执行。
  //   ⚠ 面板侧不做二次判定, 一律由 jsx 的 pfRichBlackToK100() 用同一套口径
  //     (pfRichBlackChk)算"改了 N 处", 避免"报 5 改 3"。
  function onRbToK100() {
    var uT = $("chkRbUnlock") ? $("chkRbUnlock").checked : CHK_RB_UNLOCK;
    customConfirm("将把四色黑(C+M+Y+K 之和 >= " + thv("rbSum") + "%)转为单黑:\n" +
      "· 填充/描边改为 C0 M0 Y0 K100\n" +
      "· 只改颜色，叠印状态不动(要加/清叠印请用上面的叠印卡)\n" +
      "· 文字填充与文字描边都算；专色、RGB、渐变、图案一律不动\n" +
      (uT ? "· 执行前先解锁全部图层与锁定对象\n"
        : "· 隐藏/锁定对象跳过；勾「解锁全部」可一并处理\n") +
      "此操作会直接修改文档，确定继续?", function () {
      docGuard(function () {
        execAction("pfRichBlackToK100(" + (uT ? "true" : "false") + ");", "四色黑转单黑完成。");
      });
    }, "确认转单黑");
  }

  // ---------- v10.15: 一键删除全部隐藏对象(zhiban 同源移植) ----------
  //   只删对象, 隐藏图层(含子图层)本身保留; 范围=可见图层内的隐藏组/Ctrl+3 隐藏对象。
  //   锁定的隐藏对象删不动, jsx 如实报数, 由用户解锁后重试 —— 不擅自改锁定状态。
  function onDelHidden() {
    // v11.94(审查): 补一句符号定义的说明 —— pfDeleteHidden 会下钻**可见符号实例的定义源**
    //   删掉里面的隐藏对象(卡② 的隐藏计数本来就含这部分, 不删就会"报 N 删 M")。
    //   但那个删除是**定义级**的: 一次 remove 影响该符号的所有实例, 用户从对话框里
    //   完全看不出来。jsx 侧 v10.46 的注释一直写着"确认框文案已说明", 实际文案里没有
    //   这句 —— 注释领先于实现。这里补上, 让两处对齐。
    // v11.104: 报数量 —— 不可逆删除, 点之前最该知道"删几个"。数字来自上一轮扫描。
    var nHidDel = 0;
    try { nHidDel = (LAST_SCAN && LAST_SCAN.hidden && LAST_SCAN.hidden.itemCount) || 0; } catch (eHN) {}
    customConfirm("将删除可见图层内的" + (nHidDel > 0 ? nHidDel + " 个" : "") + "隐藏对象(隐藏组、Ctrl+3 隐藏的对象)。\n" +
      "隐藏图层及其中的对象一律保留，不会被删除。\n" +
      "若隐藏对象位于符号定义内，删除会同时影响该符号的所有实例。\n" +
      "此操作不可撤销，确定继续?", function () {
      // v10.35: 同上 —— 删除是最不可逆的一步
      docGuard(function () {
        execAction("pfDeleteHidden();", "删除完成。");
      });
    }, "确认删除隐藏对象");
  }

  // ---------- v11.16: 卡⑨ 一键清理(游离点 / 未上色对象 / 空文本路径) ----------
  //   与 onDelHidden 同一套: 先 customConfirm 说明范围, 再 docGuard 包一层才发写动作。
  //   ⚠ 面板侧**不**做二次判定, 一律由 jsx 的 pfCleanup() 用同一套口径(隐藏/锁定不删)算
  //     —— 避免两侧判定漂移。三个勾选框只决定"清哪几类"。
  function onCleanup() {
    var s1 = CLEAN_CK.stray, s2 = CLEAN_CK.unpainted, s3 = CLEAN_CK.text;
    if (!s1 && !s2 && !s3) { showNotice("没有勾选任何清理项。"); return; }
    // v11.104: 每类带上数量(有就带, 0 就不带数字) —— 三个勾选项与卡片上的计数同源。
    var clS = (LAST_SCAN && LAST_SCAN.cleanup) || null;
    function clN(k) { try { return (clS && clS[k] && clS[k].count) || 0; } catch (eCN) { return 0; } }
    var who = [];
    if (s1) who.push("游离点" + (clN("stray") > 0 ? " " + clN("stray") + " 个" : ""));
    if (s2) who.push("未上色对象" + (clN("unpainted") > 0 ? " " + clN("unpainted") + " 个" : ""));
    if (s3) who.push("空文本" + (clN("emptyText") > 0 ? " " + clN("emptyText") + " 个" : ""));
    customConfirm("将清理: " + who.join("、") + "。\n" +
      "含隐藏与锁定的对象，全部一并清理。\n" +
      "此操作不可撤销，确定继续?", function () {
      docGuard(function () {
        execAction("pfCleanup(" + (s1 ? 1 : 0) + "," + (s2 ? 1 : 0) + "," + (s3 ? 1 : 0) + ");",
          "清理完成。");
      });
    }, "确认清理");
  }

  // ---------- v11.41: 卡头定位 ----------
  //   只改 selection, 不改任何锁定/隐藏状态 —— 所以**不包 docGuard、不进 actionBusy**:
  //   定位是"看"不是"改", 不该在它跑的时候锁住面板其他按钮。
  //   ⚠ 不传 execJsx 的 isReadOnly: 它毕竟改了选中态, 按写动作处理(不自动重发)。
  //   ⚠ 锁定/隐藏对象一律**只回报不处理**(雪糕定的口径) —— 别在这里顺手加解锁。
  var locateBusy = false;
  var locateTimer = null;
  // v11.42: 定位自己的超时 —— 不借 BUSY_TIMEOUT_MS(20 秒)。定位只是改 selection,
  //   正常几十毫秒; 拿 20 秒兜底等于"卡住之后用户点 20 秒都没反应"。
  var LOCATE_TIMEOUT_MS = 5000;
  function onLocate(n, sub) {
    if (!n || locateBusy) return;
    // v11.53: 卡⑥ 子类型(块内按钮) —— 白名单校验, 别的卡不传。
    //   ⚠ 拼进 evalScript 的字符串必须只可能出现这四个值, 不做"透传"。
    sub = (sub && /^(over|heavy|light|thin)$/.test(sub)) ? sub : "";
    locateBusy = true;
    // v11.42: 兜底释放 —— 原来 locateBusy 只有回调里那一句置回; 桥万一不回调
    //   (引擎忙 / 面板切后台被挂起), 它会永久为真 ⇒ 之后每次点定位都静默 return,
    //   表现就是"按下去没反应"。这是 v11.39 审查 #15 的同类问题, 当时只治了阈值队列。
    if (locateTimer) clearTimeout(locateTimer);
    locateTimer = setTimeout(function () { locateBusy = false; locateTimer = null; }, LOCATE_TIMEOUT_MS);
    execJsx("pfLocate(" + n + (sub ? ',"' + sub + '"' : "") + ");", function (data) {
      if (locateTimer) { clearTimeout(locateTimer); locateTimer = null; }
      locateBusy = false;
      if (!data || !data.ok) {
        showNotice((data && data.error) || "定位失败。");
        return;
      }
      var sel = data.sel || 0, lk = data.locked || 0, hd = data.hidden || 0;
      var skip = lk + hd;
      var msg;
      if (sel > 0) {
        msg = "已选中 " + sel + " 个对象";
        if (skip > 0) msg += "，" + lk + " 个锁定 / " + hd + " 个隐藏未选";
      } else if (skip > 0) {
        msg = "全部 " + skip + " 个对象锁定或隐藏，未选中";
      } else {
        // 面板显示有命中、现场却找不到 ⇒ 文档在上次检查后被改过
        msg = "没找到可定位的对象，请重新检查。";
      }
      // 图层名只在"有对象没选上"时才有意义 —— 告诉用户去哪个图层手动找
      var lys = data.layers || [];
      if (skip > 0 && lys.length > 0) {
        msg += " (图层「" + lys.join("」「") + "」)";
      }
      showNotice(msg);
    });
  }

  // ---------- v10.14: 叠印卡 seg 页签(原挂两版卡头; v10.29 起只挂设置弹层「叠印」行尾) ----------
  //   ⚠ seg <i> 不加 id(拖动重绘会重复出现) —— 委托按 data-m + 父类名识别。
  //   v10.29: 不再接收 active 参 —— 选中态直接读 pf_ovpMode(卡头双份时代每版自带 on, 现全局一份)。
  function ovpSeg() {
    // 样式仿参考 chips —— 胶囊容器+选中胶囊块(雪糕定稿 v10.17/v10.23 扁平化)
    var m = ovpModeNow();   // v10.37: 弹层内读草稿(切了没确认也显示草稿选中态), 否则读已存值
    return '<span class="ovp-seg" title="切换叠印卡的展示与操作方式(全清理=只报总数+一键清除; 分级版=四分类+规则动作)">' +
      '<i data-m="legacy"' + (m === "legacy" ? ' class="on"' : '') + '>全清理</i>' +
      '<i data-m="tiered"' + (m === "tiered" ? ' class="on"' : '') + '>分级版</i></span>';
  }

  // ---------- v10.13: 卡⑧ 删除未使用色板(zhiban v0.7.8 原文移植) ----------
  //   范围: 未使用色板 + 未使用渐变 + 未使用图案; **颜色组一律不删**
  //   (AI 28 的 SwatchGroup 读不到成员, 删组会级联删掉组内色板 —— zhiban 两次事故的结论)。
  function onClearSwatches() {
    // v11.104: 三类各带数量 —— 这是不可逆删除, 点之前最该知道删几个; 0 个也照报, 让人心里有数。
    var nSw = 0, nGd = 0, nPt = 0;
    try {
      nSw = (LAST_SCAN && LAST_SCAN.swatch && LAST_SCAN.swatch.unused) || 0;
      nGd = (LAST_SCAN && LAST_SCAN.gradient && LAST_SCAN.gradient.unused) || 0;
      nPt = (LAST_SCAN && LAST_SCAN.pattern && LAST_SCAN.pattern.unused) || 0;
    } catch (eUC) {}
    customConfirm("将删除文档中没有任何对象在使用的资产:\n" +
      "· 色板 " + nSw + " 个: 保留系统四项(无、套版色、黑、白)与所有在用颜色；\n" +
      "· 渐变 " + nGd + " 个: 删除未被任何对象引用的渐变；\n" +
      "· 图案 " + nPt + " 个: 删除未被任何对象引用的图案。\n" +
      "颜色组不会被删除(避免误删组内色板)。\n" +
      "判定范围含隐藏与锁定对象、组与复合路径、文字字符色。\n" +
      "此操作不可撤销，确定继续?", function () {
      // v10.39: 补 docGuard —— 原先漏了这一处(v10.35 #1 的六入口名单没算上它)。
      //   确认框开着时切文档 → 点确定 → pfClearUnusedSwatches() 改的是切过去那份, 与 #1 同类事故。
      docGuard(function () {
        execActionMulti([
          "pfClearUnusedSwatches();",
          "pfClearUnusedGradPattern();"
        ], "清理完成。");
      });
    }, "确认清理未使用资产");
  }

  // ---------- v11.87: 卡⑨ 「选中所有专色并加描边叠印」----------
  //   zhiban v0.8.3 的单按钮口径原样移植: 点一下 = ① pfSpotSelectAll() 全选
  //   (需加描边的专色 + 贴着专色的四色) ② pfSpotTrap(描边宽) 给选中项加同色描边 + 叠印。
  //   ⚠ pfSpotTrap 内部"必须有选中"的闸门**保留** —— 那是安全边界: 全选失败时它明确报错,
  //     而不是静默去改全篇。无选中且文档里没有需陷印的专色 ⇒ ok=true 静默放行,
  //     所以串行器不会因为"无事可做"卡住。
  //   ⚠ 加二次确认: 本面板每个改文档的按钮都先确认(叠印/清理/删隐藏/删色板),
  //     这一颗也不例外 —— 它会一次给几百个图元加描边, 值不得"手滑即执行"。
  //   ⚠ 可反复点: jsx 侧幂等(同色 + 已叠印 + 宽度达标 ⇒ skip), 改了描边宽再点会按新宽度重做。
  function onSpotTrap() {
    var w = trapWidth();
    var half = Math.round(w * 50) / 100;   // 外扩量 = 宽/2, 保留两位(别让 0.30000000000000004 露出来)
    // v11.104: 报数量 + 补上 v11.96 的「已有其他颜色描边的对象不动」。
    //   那条规则之前只写在卡片脚注里, 弹窗没提 —— 用户点完发现某几个没加, 只会以为漏了。
    var leftN = 0;
    try {
      var st0 = LAST_SCAN && LAST_SCAN.spotTrap;
      if (st0) leftN = ((st0.spot || 0) - (st0.spotDone || 0)) +
                        ((st0.cmykAdj || 0) - (st0.cmykAdjDone || 0));
    } catch (eST0) { leftN = 0; }
    customConfirm((leftN > 0
        ? "将在 " + leftN + " 个对象上加同色描边 + 描边叠印:\n"
      : "将自动选中「需加描边的专色 + 贴着专色的四色」，并给它们加同色描边 + 描边叠印:\n") +
      "· 描边宽 " + w + " mm(居中：外扩 " + half + " mm、内缩 " + half + " mm)\n" +
      "· 只贴白/空白的专色、白色块、纯四色、渐变图案、文字一律不动\n" +
      "· 已有其他颜色描边的对象不动\n" +
      "· 锁定 / 隐藏的对象跳过\n" +
      "此操作会直接修改文档，确定继续?", function () {
      // 与其它动作入口同款 —— 确认框开着时切了文档, 确定后不许改到另一份
      docGuard(function () {
        execActionMulti([
          "pfSpotSelectAll();",
          "pfSpotTrap(" + w + ");"
        ], "专色描边完成。");
      });
    }, "确认加描边叠印");
  }

  // ---------- v11.90: 卡⑩ 「建立 / 重建处理前对照」----------
  //   一条链路: 二次确认 → docGuard(确认框开着时切了文档就不许动手) → pfSnapBuild(透明度)。
  //   ⚠ 透明度取的是**输入框落盘的当前值**, 不是"上次建立时用的值" —— 雪糕选的就是
  //     "改了数字, 下次重建才生效", 所以这里必须读 snapOp()。
  //   ⚠ 重建会**先删旧层再建**: 这一步不可逆, 确认框里必须写明白(旧的那张处理前图会没)。
  // ---------- v11.105: 对照差分 ----------
  //   流程: jsx 导出两张 PNG(当前版面 / 对照图) → 面板 canvas 逐像素比 →
  //         把差异矩形交回 jsx 画红框。
  //   为什么像素比对面板侧做: ExtendScript 没有像素 API(RasterItem 读不到像素),
  //   而 PNG 是 zlib 压缩的, 在 ES3 里解压又慢又得手写 inflate。
  //   面板本身就是 Chromium: <img>+<canvas> 原生解码, 逐像素是毫秒级。
  // v11.106: 传 0 ⇒ 由 jsx 自动对齐「对照图的原生 ppi」(300), 不再拍 250%。
  //   250% 那次是 180ppi, 对照图会被下采样一遍, 而当前版面是直接按 180ppi 渲染的
  //   ⇒ 两条采样路径, 边缘天然差一两个像素 ⇒ 满屏假框(雪糕反馈的"没改也圈")。
  var DIFF_SCALE = 0;
  // v11.108: 判定参数改成**三档预设**, 卡片上直接切, 不用改代码。
  //   每一档 = [单通道差值阈值, 4×4 块内至少几个像素变, 连通块至少多少块]
  //     th   ↑ = 更钝(要求差得更多才算变)
  //     hit  ↑ = 更钝(一个块里要更多像素变化才算这个块变了)
  //     minb ↑ = 更钝(更小的碎块直接丢掉)
  //   "少圈"是给"污点多、只想看大改"的稿子用的; "多圈"是给"细微挪动也要抓"的。
  var DIFF_PRESETS = [
    { th: 40, hit: 3, minb: 6 },   // 0 少圈(严格判定)
    { th: 26, hit: 1, minb: 2 },   // 1 标准 ← 出厂默认(v12.5 放宽, 见下)
    { th: 14, hit: 1, minb: 1 }    // 2 多圈(灵敏)
  ];
  var DIFF_ERODE = true;     // 1 像素腐蚀, 抹掉单像素毛刺
  // v11.109: 「忽略细边」—— 腐蚀跑**两遍**。
  //   为什么需要: 本面板自己给专色加的那条 0.2mm 描边, 等于把轮廓往外推 0.1mm。
  //   300ppi 下那是 1.18 像素, 再加上抗锯齿的过渡带, 实际形成 2~4 像素宽的一圈"变化环" ——
  //   环本身很细, 但**沿形状绕一圈**, 连通块特别大, 最小块门槛拦不住, 于是一圈一圈地被框出来。
  //   腐蚀一遍能吃掉 1~2 像素的带, 两遍才能吃掉 3~4 像素 ⇒ 勾上这个开关就不圈描边了。
  //   代价(必须说清): 真正的细微改动(同样 ≤3~4 像素宽)也会被一并忽略。
  var DIFF_EDGE = false;
  try { if (localStorage.getItem("pf_diffEdge") === "1") DIFF_EDGE = true; } catch (eEdge) {}
  // v11.110: 碎框合并距离(mm)。
  //   一个文字块被挪动时, 像素差分只会圈出"旧位置和新位置没重叠的那几条边摆" ——
  //   同一个字上能散出好几个小框。那在工艺上没意义: 用户要的是"这块动过"。
  //   ⇒ 把**同一行/同一列上相邻**、间距小于这个值的框并成一个大框。
  // v12.5(雪糕实测反馈, 改为 0 = 默认不合并):
  //   6mm 在 300ppi 下是 71px, 而合并判据是"纵向重叠 > 较矮那个的一半" ⇒ 同一行文字
  //   **天然全部满足**, 于是一行字被连锁并成一个外接矩形, 把中间没变的部分也框进去。
  //   雪糕的原话: "整个框起来了, 不一样的地方没有框" —— 大框反而把真实位置淹没了。
  //   现在默认 0: 每处差异独立成框, 绝不整块框住。想聚合的人调「少圈」档即可
  //   (那一档 th 40 + hit 3 + minb 6, 本身就会把碎点滤掉一大半)。
  //   ⚠ 别再改回 6: 合并用的是 union box(外接矩形), 天然覆盖中间空白, 与"指出哪儿变了"
  //     这个目的直接冲突。
  var DIFF_MERGE_MM = 0;
  var DIFF_BLOCK = 4;        // 聚合成 4×4 的块
  var DIFF_PAD_PX = 3;       // 红框外扩(像素)
  // 档位落盘(0/1/2) —— 与其它偏好同一套: 本地存档, 重开面板还在
  var DIFF_SEN = 1;
  try {
    var senSaved = localStorage.getItem("pf_diffSen");
    if (senSaved === "0" || senSaved === "1" || senSaved === "2") DIFF_SEN = Number(senSaved);
  } catch (eSen) {}
  function diffParams() { return DIFF_PRESETS[DIFF_SEN] || DIFF_PRESETS[1]; }
  var diffBusy = false;

  function diffReadB64(path) {
    try {
      if (!window.cep || !window.cep.fs) return null;
      var r = window.cep.fs.readFile(path, window.cep.encoding.Base64);
      if (!r || r.err !== 0 || !r.data) return null;
      return r.data;
    } catch (e) { return null; }
  }
  function diffLoadImg(b64, cb) {
    var img = new Image();
    img.onload = function () { cb(img); };
    img.onerror = function () { cb(null); };
    img.src = "data:image/png;base64," + b64;
  }
  function diffRd(v) { return Math.round(v * 100) / 100; }

  // 两张同尺寸图 → 差异矩形列表(文档坐标字符串 "l,t,w,h;...")
  //
  // v11.107: 关键改动 —— 判定从"这一个像素不一样"改成"**邻域里都找不到一样的**"。
  //   为什么: 对照图是 300ppi 位图, 导出的当前版面是按画板(而不是按那张图)对齐像素网格的,
  //   两者的像素相位差一点点(5mm 外扩 = 59.06px, 那个 .06 就够)。于是**每一条高对比度的边**
  //   都会整体错开零点几个像素 —— 腐蚀对付不了(它不是单像素细线, 是整条边偏移),
  //   结果就是黑字压在橙底上, 字里全是小框(雪糕截图那个样子)。
  //   现在: 严格判定为"变了"的像素, 还要确认 **A 的 ±1 邻域在 B 里找不到同色**、
  //   **B 的 ±1 邻域在 A 里也找不到同色**, 才算真变化。亚像素错位被这个容差吃掉,
  //   真正挪动/增删的内容(至少几个像素宽)依然会被抓到。
  //
  //   分带处理(256 行 + 上下各 1 行余量): 邻域要跨行读取, 所以切片比目标带多两行;
  //   峰值内存约 5MB(A4@300ppi), 不分带的话两张整图 ImageData 要 70MB。
  function pxDiff(d, i, e, j, T) {
    return Math.abs(d[i] - e[j]) > T ||
           Math.abs(d[i + 1] - e[j + 1]) > T ||
           Math.abs(d[i + 2] - e[j + 2]) > T;
  }
  // A 在 p 处的颜色, 能否在 B 的 p±1 邻域里找到; 反向亦然
  function nearMatch(dA, dB, w, rh, x, sy, T) {
    var dx, dy, xx, yy, j;
    var i = (sy * w + x) * 4;
    for (dy = -1; dy <= 1; dy++) {
      yy = sy + dy; if (yy < 0 || yy >= rh) continue;
      for (dx = -1; dx <= 1; dx++) {
        xx = x + dx; if (xx < 0 || xx >= w) continue;
        j = (yy * w + xx) * 4;
        if (!pxDiff(dA, i, dB, j, T)) return true;
      }
    }
    var ip = i;
    for (dy = -1; dy <= 1; dy++) {
      yy = sy + dy; if (yy < 0 || yy >= rh) continue;
      for (dx = -1; dx <= 1; dx++) {
        xx = x + dx; if (xx < 0 || xx >= w) continue;
        j = (yy * w + xx) * 4;
        if (!pxDiff(dB, ip, dA, j, T)) return true;
      }
    }
    return false;
  }

  // v11.110: 把"同一行/同一列上挨得近"的矩形并起来, 直到不再变化。
  //   矩形用 [l, t, w, h](AI 坐标, y 向上 ⇒ 下边 = t - h)。
  //   判据(两条满足其一):
  //     · 纵向重叠 > 较矮那个的一半 且 水平间隙 <= gap  ⇒ 同一行相邻
  //     · 横向重叠 > 较窄那个的一半 且 垂直间隙 <= gap  ⇒ 同一列相邻
  //   ⚠ 不做"斜对角也并": 那会把两行之间的零碎一路串成一大片, 反而看不出改了哪儿。
  function diffShouldMerge(a, b, gap) {
    var al = a[0], at = a[1], ar = a[0] + a[2], ab = a[1] - a[3];
    var bl = b[0], bt = b[1], br = b[0] + b[2], bb = b[1] - b[3];
    var vOv = Math.min(at, bt) - Math.max(ab, bb);     // 纵向重叠长度
    var hOv = Math.min(ar, br) - Math.max(al, bl);     // 横向重叠长度
    var dx = Math.max(0, Math.max(al, bl) - Math.min(ar, br));
    var dy = Math.max(0, Math.max(ab, bb) - Math.min(at, bt));
    if (vOv > Math.min(a[3], b[3]) * 0.5 && dx <= gap) return true;
    if (hOv > Math.min(a[2], b[2]) * 0.5 && dy <= gap) return true;
    return false;
  }
  function diffUnionBox(a, b) {
    var l = Math.min(a[0], b[0]);
    var t = Math.max(a[1], b[1]);
    var r = Math.max(a[0] + a[2], b[0] + b[2]);
    var bo = Math.min(a[1] - a[3], b[1] - b[3]);
    return [l, t, r - l, t - bo];
  }
  function diffMergeRects(list, gap) {
    var changed = true, i, j;
    while (changed) {
      changed = false;
      for (i = 0; i < list.length; i++) {
        for (j = i + 1; j < list.length; j++) {
          if (!diffShouldMerge(list[i], list[j], gap)) continue;
          list[i] = diffUnionBox(list[i], list[j]);
          list.splice(j, 1);
          j--;
          changed = true;
        }
      }
    }
    return list;
  }

  function diffBoxes(imgA, imgB, rect, scale) {
    var w = Math.min(imgA.naturalWidth, imgB.naturalWidth);
    var h = Math.min(imgA.naturalHeight, imgB.naturalHeight);
    if (!(w > 0) || !(h > 0)) return null;

    var BAND = 256, HALO = 1, CH = BAND + HALO * 2;
    function mkCv() {
      var c = document.createElement("canvas");
      c.width = w; c.height = CH;
      return c;
    }
    var cvA = mkCv(), cvB = mkCv();
    var ca = cvA.getContext("2d"), cb = cvB.getContext("2d");
    var P = diffParams(), T = P.th;
    var chg = new Uint8Array(w * h), nchg = 0;
    var y0, hh, ry0, ry1, rh, pa, pb, off, ty, sy, x, i, rowS, rowG, y;

    for (y0 = 0; y0 < h; y0 += BAND) {
      hh = Math.min(BAND, h - y0);
      ry0 = Math.max(0, y0 - HALO);
      ry1 = Math.min(h, y0 + hh + HALO);
      rh = ry1 - ry0;
      ca.clearRect(0, 0, w, CH); cb.clearRect(0, 0, w, CH);
      ca.drawImage(imgA, 0, ry0, w, rh, 0, 0, w, rh);
      cb.drawImage(imgB, 0, ry0, w, rh, 0, 0, w, rh);
      pa = ca.getImageData(0, 0, w, rh).data;
      pb = cb.getImageData(0, 0, w, rh).data;
      off = y0 - ry0;                       // 目标带在切片里的起始行
      for (ty = 0; ty < hh; ty++) {
        sy = off + ty;
        rowS = sy * w * 4;
        rowG = (y0 + ty) * w;
        for (x = 0; x < w; x++) {
          i = rowS + x * 4;
          if (!pxDiff(pa, i, pb, i, T)) continue;
          // 有差异 —— 但若邻域里能找到同色, 说明是亚像素错位, 不算变化
          if (nearMatch(pa, pb, w, rh, x, sy, T)) continue;
          chg[rowG + x] = 1; nchg++;
        }
      }
    }
    if (!nchg) return { list: "", n: 0 };

    // 1 像素腐蚀(4 邻域), 可跑多遍: 每跑一遍, 变化区域四边各缩 1 像素。
    //   1 遍 ⇒ 吃掉 1~2 像素宽的带(单像素毛刺、亚像素错位残留);
    //   2 遍 ⇒ 吃掉 3~4 像素宽的带(本面板加的 0.2mm 专色描边就是这一档)。
    if (DIFF_ERODE) {
      var passes = DIFF_EDGE ? 2 : 1, ps;
      for (ps = 0; ps < passes; ps++) {
        var er = new Uint8Array(w * h);
        for (y = 1; y < h - 1; y++) {
          rowS = y * w;
          for (x = 1; x < w - 1; x++) {
            i = rowS + x;
            if (!chg[i]) continue;
            if (chg[i - 1] && chg[i + 1] && chg[i - w] && chg[i + w]) er[i] = 1;
          }
        }
        chg = er;
      }
    }

    // 按 4×4 块聚合
    var B = DIFF_BLOCK;
    var bw = Math.ceil(w / B), bh = Math.ceil(h / B);
    var mask = new Uint8Array(bw * bh);
    var bx, by, cnt, y2, x2;
    for (by = 0; by < bh; by++) {
      for (bx = 0; bx < bw; bx++) {
        cnt = 0;
        y2 = Math.min((by + 1) * B, h); x2 = Math.min((bx + 1) * B, w);
        for (y = by * B; y < y2; y++) {
          rowS = y * w;
          for (x = bx * B; x < x2; x++) {
            if (chg[rowS + x]) cnt++;
          }
        }
        if (cnt >= P.hit) mask[by * bw + bx] = 1;
      }
    }

    // 连通域(BFS, 8 邻域)
    var seen = new Uint8Array(bw * bh);
    var stackX = [], stackY = [], boxes = [];
    for (by = 0; by < bh; by++) {
      for (bx = 0; bx < bw; bx++) {
        var id = by * bw + bx;
        if (!mask[id] || seen[id]) continue;
        var minx = bx, maxx = bx, miny = by, maxy = by, np = 0;
        stackX.length = 0; stackY.length = 0;
        stackX.push(bx); stackY.push(by); seen[id] = 1;
        while (stackX.length) {
          var cxx = stackX.pop(), cyy = stackY.pop();
          np++;
          if (cxx < minx) minx = cxx; if (cxx > maxx) maxx = cxx;
          if (cyy < miny) miny = cyy; if (cyy > maxy) maxy = cyy;
          for (var dy = -1; dy <= 1; dy++) {
            for (var dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              var nx = cxx + dx, ny = cyy + dy;
              if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
              var nid = ny * bw + nx;
              if (!mask[nid] || seen[nid]) continue;
              seen[nid] = 1; stackX.push(nx); stackY.push(ny);
            }
          }
        }
        if (np >= P.minb) boxes.push([minx, miny, maxx, maxy]);
      }
    }
    if (!boxes.length) return { list: "", n: 0 };

    // 像素 → 文档坐标(pt)。rect 是 [l, t, r, b], y 轴向上(t > b)
    var k = (Number(scale) > 0 ? Number(scale) : 100) / 100;
    var L0 = rect[0], T0 = rect[1], rects = [];
    for (var q = 0; q < boxes.length; q++) {
      var b0 = boxes[q];
      var px0 = Math.max(0, b0[0] * B - DIFF_PAD_PX);
      var py0 = Math.max(0, b0[1] * B - DIFF_PAD_PX);
      var px1 = Math.min(w, (b0[2] + 1) * B + DIFF_PAD_PX);
      var py1 = Math.min(h, (b0[3] + 1) * B + DIFF_PAD_PX);
      rects.push([L0 + px0 / k, T0 - py0 / k, (px1 - px0) / k, (py1 - py0) / k]);
    }

    // v11.110: 碎框合并 —— 同一行/同一列上挨得近的并成一个大框
    var nBefore = rects.length;
    // ⚠ MMPT 是 jsx 里的常量, 面板侧没有 —— 这里直接写 1mm = 2.8346456693pt
    if (DIFF_MERGE_MM > 0) rects = diffMergeRects(rects, DIFF_MERGE_MM * 2.8346456693);

    var out = [];
    for (var m = 0; m < rects.length; m++) {
      out.push(diffRd(rects[m][0]) + "," + diffRd(rects[m][1]) + "," +
               diffRd(rects[m][2]) + "," + diffRd(rects[m][3]));
    }
    return { list: out.join(";"), n: out.length, raw: nBefore };
  }

  // v11.109: 勾/取消「忽略细边」—— 只改腐蚀遍数, 不自动重跑
  function onDiffEdge(on) {
    DIFF_EDGE = !!on;
    try { localStorage.setItem("pf_diffEdge", DIFF_EDGE ? "1" : "0"); } catch (eEg) {}
    showNotice(DIFF_EDGE
      ? "已忽略 0.2mm 以内的细边，点「比对变化」看结果。"
    : "已恢复细边检测，点「比对变化」看结果。");
  }

  // v11.108: 切灵敏度档位 —— 只改本地偏好 + 段控件高亮, 不自动重跑
  //   (每次比对要导两张 300ppi 的图, 切一下就跑太吵; 改完自己点「比对变化」)。
  function onDiffSen(el) {
    var sNum = parseInt(el.getAttribute("data-s"), 10);
    if (!(sNum >= 0 && sNum <= 2)) return;
    DIFF_SEN = sNum;
    try { localStorage.setItem("pf_diffSen", String(sNum)); } catch (eS) {}
    var seg = $("diffSeg");
    if (seg) {
      var its = seg.getElementsByTagName("i");
      for (var i = 0; i < its.length; i++) {
        its[i].className = (its[i] === el) ? "on" : "";
      }
      var dp = diffParams();
      seg.title = "当前: 阈值 " + dp.th + " · 块命中 " + dp.hit + " · 最小块 " + dp.minb +
        "（阈值/块命中/最小块越大 = 判定越钝、框越少）";
    }
    showNotice("灵敏度已切到" + (sNum === 0 ? "「少圈」" : sNum === 1 ? "「标准」" : "「多圈」") +
      "，点「比对变化」看新结果。");
  }

  // 主入口: 「比对变化」按钮
  function onDiffCompare() {
    if (diffBusy) { showNotice("正在比对，请稍候。"); return; }
    if (!window.cep || !window.cep.fs) {
      showError("当前环境读不到本地文件(cep.fs 不可用)，无法比对。");
      return;
    }
    diffBusy = true;
    showNotice("正在导出对照图…");
    execJsx("pfDiffExport(" + DIFF_SCALE + ");", function (data) {
      if (!data || !data.ok) {
        diffBusy = false;
        showError((data && data.error) || "导出对照图失败。");
        return;
      }
      var a = diffReadB64(data.a), b = diffReadB64(data.b);
      if (!a || !b) {
        diffBusy = false;
        showError("读取导出的 PNG 失败。路径: " + data.a);
        return;
      }
      diffLoadImg(a, function (ia) {
        if (!ia) { diffBusy = false; showError("第一张图解码失败。"); return; }
        diffLoadImg(b, function (ib) {
          if (!ib) { diffBusy = false; showError("第二张图解码失败。"); return; }
          var out = null;
          try { out = diffBoxes(ia, ib, data.rect, data.scale); }
          catch (e1) { diffBusy = false; showError("比对出错: " + e1.message); return; }
          if (!out) { diffBusy = false; showError("比对结果为空。"); return; }
          // ⚠ 即使一处都没变也要调 pfDiffDraw("") —— 它的职责是"先删旧层再画",
          //   不调的话上一次的红框会留在画布上, 看起来像"这次又变了"。
          execJsx('pfDiffDraw("' + (out.list || "") + '");', function (r2) {
            diffBusy = false;
            if (!r2 || !r2.ok) { showError((r2 && r2.error) || "画红框失败。"); return; }
            showNotice(r2.message || "完成。");
          });
        });
      });
    });
  }

  function onSnapBuild(hasOld) {
    var op = snapOp();
    var msg = (hasOld
      ? "将删除现有的「对照-处理前(请勿编辑)」图层，再按当前画板重新生成：\n"
    : "将在文档里新建「对照-处理前(请勿编辑)」图层：\n") +
      "· 复制当前画板上的可见对象 → 栅格化 300ppi(透明底)\n" +
      "· 图层置最顶层、锁定、不打印；透明度 " + op + "%\n" +
      "· 原稿不动、位置不变；这一层不参与任何检查统计\n" +
      (hasOld ? "⚠ 旧的那张处理前图会被删掉，无法恢复。\n" : "") +
      "确定继续?";
    customConfirm(msg, function () {
      docGuard(function () {
        execAction("pfSnapBuild(" + op + ");", hasOld ? "对照层已重建。" : "对照层已建立。");
      });
    }, hasOld ? "确认重建" : "确认建立");
  }

  // 事件委托: 处理动态生成的按钮
  // v12.4: 耗时行的展开/收起 —— 鼠标点击与键盘回车/空格共用这一段。
  //   ⚠ 状态存 data-pf-open（"0"/"1"），不靠 classList —— 假 DOM 节点未必有 classList。
  //   ⚠ 明细节点用 nextElementSibling 取，不用 querySelector（理由见调用处注释）。
  function toggleMsDetail(box) {
    var open = box.getAttribute("data-pf-open") === "1";
    var det = box.nextElementSibling;
    open = !open;
    box.setAttribute("data-pf-open", open ? "1" : "0");
    box.setAttribute("title", open ? "点击收起" : "点击展开各段耗时");
    if (det && det.getAttribute && det.getAttribute("class")) { /* 真 DOM: 走下一行的样式 */ }
    if (det) {
      if (open) det.removeAttribute("hidden");
      else det.setAttribute("hidden", "hidden");
      // 收起态由 .foot-ms[data-pf-open="1"] .fms-detail 控制显隐, hidden 属性兜底
      if (det.classList && det.classList.toggle) det.classList.toggle("on", open);
    }
  }

  document.addEventListener("keydown", function (e) {
    // v12.4: 耗时行是 role=button, 键盘回车/空格要与点击等价。
    //   ⚠ 这里**不调 e.preventDefault()** —— bt10.34 守着全文件 preventDefault 恰好 2 处。
    if (e.key !== "Enter" && e.key !== " ") return;
    var t = e.target;
    var box = (t && t.closest) ? t.closest("[data-pf-ms]") : null;
    if (box) toggleMsDetail(box);
  });

  document.addEventListener("click", function (e) {
    var t = e.target;
    // v11.78(雪糕真机: "最右边的按钮按下去没反应"): 展开箭头是纯 SVG 按钮,
    //   点中 <svg>/<polyline> 时 e.target 不是 button; 且 data-pf-expand 曾是
    //   **无值属性**, getAttribute 返回 "", 拿它当布尔恒假 ⇒ 从不触发。
    //   ⇒ closest 向上找控件 + 判 !== null, 两条路都不依赖属性有没有值。
    var expBtn = (t && t.closest) ? t.closest("[data-pf-expand]") : null;
    if (!expBtn && t && t.getAttribute && t.getAttribute("data-pf-expand") !== null) expBtn = t;
    // v12.4: 页脚「耗时 → 各段明细」点击展开/收起。
    //   ⚠ 这段注释里**不能写出上方的展开箭头属性名** —— bt136 是按"回调源码里是否含
    //     该属性名"来认那个 click 回调的; 这里多写一次就会让它认成两个回调、跑两遍而误判。
    //     所以判断只用 getAttribute 认自己, 不参与上面的 closest 链。
    //   ⚠ 用 getAttribute 逐层向上找而**不是 closest("[data-pf-ms]")** —— bt136 的假节点
    //     closest() 对任何选择器都返回它自己, 用 closest 会把展开箭头误认成耗时行、提前
    //     return, 导致 onExpandToggle 不再执行。所以这里自己走 parentNode 链。
    var msHit = null, msNode = t;
    for (var msI = 0; msNode && msI < 6; msI++) {   // 6 层足够: 明细段 -> 明细 -> 行 -> 页脚
      if (msNode.getAttribute && msNode.getAttribute("data-pf-ms") !== null) { msHit = msNode; break; }
      msNode = msNode.parentNode;
    }
    if (msHit) { toggleMsDetail(msHit); return; }
    if (t && t.id === "btnOutline") onOutline();
    else if (t && t.id === "btnEmbed") onEmbed();
    else if (t && t.id === "btnOvpClear") onOvpClear();
    else if (t && t.id === "btnClearSwatches") onClearSwatches(); // v10.13: 卡⑧
    else if (t && t.id === "tBtnOvpApply") onOvpApply(); // v10.14: 分级版规则执行
    else if (t && t.id === "btnDelHidden") onDelHidden(); // v10.15: 卡② 删除隐藏对象
    else if (t && t.id === "btnCleanup") onCleanup(); // v11.16: 卡⑨ 一键清理
    else if (t && t.id === "btnSpotTrap") onSpotTrap(); // v11.87: 卡⑨ 专色描边
    else if (t && t.id === "btnRbK100") onRbToK100(); // v11.91: 卡⑥ 四色黑转单黑
    else if (t && t.id === "btnSnap") onSnapBuild(t.getAttribute("data-old") === "1"); // v11.90: 卡⑩ 对照
    else if (t && t.id === "btnDiff") onDiffCompare(); // v11.105: 卡⑩ 比对变化
    else if (t && t.parentNode && t.parentNode.id === "diffSeg") onDiffSen(t); // v11.108: 灵敏度
    else if (t && t.id === "chkDiffEdge") onDiffEdge(t.checked); // v11.109: 忽略细边
    else if (expBtn) onExpandToggle(expBtn); // v11.78: SVG target + 无值属性都能命中
    // v11.41: 卡头定位按钮(五卡: 字体/嵌入/分辨率/叠印/清理) + v11.53 卡⑥ 块内按钮。
    //   ⚠ 按钮内是 <svg>, 点击时 e.target 可能是它或 <path> ——
    //   靠 CSS 的 pointer-events:none 让 target 恒落在 button 上; 这里仍按
    //   data-locate **属性**取卡号, 不依赖 t.id, 少一层脆弱假设。
    //   v11.53: 卡⑥ 的块内按钮额外带 data-sub(该块类型), 无 sub 时按旧口径传空。
    else if (t && t.getAttribute && t.getAttribute("data-locate"))
      onLocate(parseInt(t.getAttribute("data-locate"), 10),
               t.getAttribute("data-sub") || "");
    // v10.14: seg 页签 —— <i data-m> 在 .ovp-seg 里, 按 data-m 切两版显隐
    // v10.33: 父节点判定由 `className === "ovp-seg"` 改为 classList.contains
    //   —— 严格相等一旦给 .ovp-seg 再加一个 class(如 .active)就会当场失效, 静默不响应点击。
    else if (t && t.getAttribute && t.getAttribute("data-m") &&
             t.parentNode && t.parentNode.classList &&
             t.parentNode.classList.contains("ovp-seg")) {
      // v10.34: 叠印滑块在 <label class="set-ck"> 之内(v10.31 雪糕点名"挂到叠印文案后面")。
      //   HTML 规范: 点 label 内**任何**位置都会激活其关联 checkbox ⇒ 点滑块会连带切换
      //   "叠印"行的勾选(雪糕截图)。label 的转发属**默认行为**, preventDefault 即可拦住,
      //   不必把滑块搬出 label(那样要重排 CSS 间距)。
      e.preventDefault();
      setOvpMode(t.getAttribute("data-m"));
    }
  });

  // ---------- 启动 ----------
  // v11.39: 只在 DOMContentLoaded 上挂一次是不够的 —— 若本脚本在 DOM 已就绪
  //   **之后**才注入(CEP 某些版本的热重载、或将来改成 defer/动态加载), DOMContentLoaded
  //   早已派发过, 启动函数永不执行 ⇒ 面板空白、且没有任何报错。补一个 readyState 判断。
  function bootPanel() {
    // v8.0: 必须包一层 —— 若直接把 run 当监听器,浏览器会把 click 事件对象传进第 1 参(keepNotice),
    //       事件对象恒为真 ⇒ 手动点"开始检查"也会保留旧提示(不再是"清残留"语义)
    initSettings(); // v10.0: 设置弹层(卡片开关, v10.13 起八卡)按真实卡序生成
    $("btnRun").addEventListener("click", function () { run(); });
    // v11.33(雪糕): **只有按按钮才扫描**。去掉两处自动扫描:
    //   ① 打开面板时的自动首扫 `if (inCEP()) run();` —— 面板一开就白付一次全量扫描;
    //   ② 获得焦点时的"切了文档就自动重扫"(v5.6 体验①) —— 连同 v10.28 防抖、v11.31 三处
    //      actionBusy 避让一起删掉(那三项的存在意义就是服务于这条自动扫描)。
    //   安全兜底仍在: 动作入口的 docGuard 会比对 currentDoc 与 lastDocKey, 切换过文档就直接
    //   拦下并提示重新检查 —— 不会出现"看着 A 的结果、对 B 执行破坏性动作"。
    //   ⚠ 别再加回来: 几千条路径的稿上一次扫描 500ms+, 什么时候扫由用户按按钮决定。
  }
  var booted = false;
  function bootOnce() {
    if (booted) return;
    booted = true;
    bootPanel();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootOnce);
  } else {
    bootOnce();   // 注入时 DOM 已就绪 —— 直接启动(上面那两行补的就是这种情况)
  }
})();
