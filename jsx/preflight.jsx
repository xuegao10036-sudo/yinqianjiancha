// ============================================================
// 印前检查宿主脚本
// 运行于 Illustrator ExtendScript 环境,由 CEP 面板调用
// 入口函数: runPreflight()  返回 JSON 字符串
// ------------------------------------------------------------
// 逐版改动见 更新日志.txt; 此处只留**仍影响当前逻辑**的结论:
//   · 扫描结构: "图层→组→对象"一次树遍历 —— 隐藏图层/隐藏组的整棵子树直接跳过,
//     可见性沿树向下传递, 不逐对象沿 parent 链向上爬。每类对象独立扫描配额。
//   · 缺失字体占位条目: AI 会把文档引用的缺失字体也放进 app.textFonts(只有名字可用,
//     family/style 为空), 建表时必须给这类条目打 ph 标记, 否则缺失字体会被"洗白"、
//     不报缺失(v5.13 真机确诊)。判定口径: 不在表里 **或** 仅为占位条目, 都算缺失。
//   · 叠印: 文字**没有** pageItem 级 fillOverprint/strokeOverprint(AI 28.0.0 真机实测),
//     只能读字符级 textRange.characterAttributes.overprintFill / overprintStroke。
//     每次读取都包 try/catch, 读不到/抛异常一律当 false —— 绝不抛、绝不误报。
// ============================================================

// ExtendScript 无原生 JSON,且读取未声明的 JSON 标识符会直接报错,
// 因此使用独立命名的序列化函数,彻底绕开 JSON 标识符
function pfStringify(value) {
  function esc(s) {
    return String(s)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n")
      .replace(/\t/g, "\\t")
      // v8.6: 兜底转义其余 C0 控制字符(0x00~0x1F, 含 \b \f \v)。
      //   只转 \r\n\t 是不够的 —— 文本框 contents 里若混入 \u0008 之类控制字符,
      //   产出的 JSON 就是非法的,前端 JSON.parse 失败 ⇒ parseResult 返回 null
      //   ⇒ 整轮结果作废, 面板只报"脚本执行失败"。放在最后(前三条已把它们转成可见形式)。
      //   ⚠ 必须补足 4 位十六进制: 0x10~0x1F 直接拼 "\u000"+h 会得到 5 位(f), 仍非法。
      .replace(/[\u0000-\u001f]/g, function (c) {
        return "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4);
      });
  }
  function ser(v) {
    if (v === null || v === undefined) return "null";
    var t = typeof v;
    if (t === "number") {
      // NaN / Infinity 不是合法 JSON,转成 null 防止前端解析失败
      if (isNaN(v) || !isFinite(v)) return "null";
      return String(v);
    }
    if (t === "boolean") return String(v);
    if (t === "string") return '"' + esc(v) + '"';
    if (v instanceof Array) {
      var a = [];
      for (var i = 0; i < v.length; i++) a.push(ser(v[i]));
      return "[" + a.join(",") + "]";
    }
    var parts = [];
    for (var k in v) {
      // v8.6: 跳过内部去重键 _k(仅 jsx 侧"同值合并"用, 前端从不读它)。
      //   只跳这一个具名键 —— 别写成 k.charAt(0)==="_", n 是前端在用的计数字段。
      if (k === "_k") continue;
      if (v.hasOwnProperty(k)) parts.push('"' + esc(k) + '":' + ser(v[k]));
    }
    return "{" + parts.join(",") + "}";
  }
  return ser(value);
}

// JSX 构建号: 随每次改动递增,并随每个返回值下发。
// 前端据此判断 ExtendScript 引擎里加载的是否为当前版本:
// 版本一致 → 跳过 $.evalFile 直接调用函数(省掉每次重载 28KB 脚本);
// 不一致/不存在 → 强制重载一次。这样开发期改完 JSX 无需重启 AI。
// v7.2: 仅随版本号递增(本版为面板文案一致化,检测逻辑与返回结构零改动)。
// v10.1: 版本号 —— 面板/宿主同步递增
// v10.46: 全量审查修复(P1-1 符号口径 / P2-1 色板轮内复用 / P2-2 死字段 /
//   P2-4 sawHidden / P2-5 嵌入位图 XMP 锚表)
// v10.60: 颜色收集深度上限 20->64 与主扫描统一; pfThCopy 补 htCap;
//   __pfUsedCache 两处失效点(进 pfClearUnusedSwatches 即清 + pfClearUnusedGradPattern 读完即清)
// v11.2: 全站胶囊按钮统一 40px 高(纯面板 CSS 改动, ExtendScript 逻辑零变化), 仅同步版本号
var PF_BUILD = "12.16";

// v10.46: 颜色收集的**轮内**复用缓存。
//   onClearSwatches 用 execActionMulti 串联 pfClearUnusedSwatches + pfClearUnusedGradPattern,
//   两个函数原先各自 pfUsedColorKeys(doc) 全文档遍历一遍(textFrames + 所有图层 items,
//   大文档各要数秒) ⇒ 用户点一次按钮付两遍。
//   现在第一个动作通过安全闸后把结果存这里, 第二个动作直接复用。
//   v10.60: 补两处失效点, 把"跨轮串味"堵死 ——
//     ① pfClearUnusedSwatches **进函数即清**(它恒是每轮的第一个动作): 万一本轮在安全闸
//        处提前 return(没走到下面的覆写), 缓存就不会停在上一次的值;
//     ② pfClearUnusedGradPattern **读完即清**(一次性消费): 若将来出现单独入口, 也拿不到残值。
var __pfUsedCache = null;

// ============================================================
// v10.1: 阈值唯一真源 —— 全部阈值集中在这张表, 前端不再保存任何阈值数字
//   (面板只显示这里回传的生效值)。设置弹层的改动经 runPreflight 第 8 参传入,
//   由 pfThApply 覆盖下面的工作副本; 未传 / 坏值逐项回落本表。
// ============================================================
var PF_TH_DEF = {
  bleed: 3,      // 实际出血不足此值(mm)判露白风险      <- 原 BLEED_MIN_MM
  tiny: 6,       // 字号低于此值(pt)判极小字号(红)       <- 原 TINY_PT
  // v10.2: 原 tinyBad(其中重度 <5pt)已按雪糕要求去掉 —— 字号只留这一条判定
  thin: 0.1,     // 描边宽低于此值(mm)判过细             <- 原 THIN_STROKE_MM
  light: 5,      // CMYK 某分量 0<值<此值 判色值极浅      <- 原 LIGHT_CH
  inkOk: 220,    // 油墨总量达此值算偏重(黄)             <- 原 INK_OK
  inkWarn: 300,  // 油墨总量超过此值算超标(红)           <- 原 INK_WARN
  // v12.14(雪糕选 C): 四色黑判断线提成可调项, 默认 330(原写死 320)。
  //   320 那条线只管「要不要报出来」, 330 这条管「能不能安全地一键转单黑」, 职责不同。
  //   ⚠ 与 inkOk 绑定一条不变量: rbSum 必须 > inkOk, 否则整张稿子都会被转单黑
  //     (见 pfThApply 末尾的回落)。
  rbSum: 330,    // C+M+Y+K 之和达此值判四色黑(可转单黑)
  reso: 300,     // 图片有效分辨率低于此值(ppi)判偏低    <- 原 RESO_MIN
  cap: 5,        // 面板默认显示的样本条数(名单采集上限见 PF_SAMPLE_MAX)
  scan: 3000,    // 每类对象最多扫描数量(防大卡死)       <- 原 MAX_SCAN
  // v10.39: 隐藏文字统计的帧数上限提成真源 —— 前端那句"仅统计前 N 个"改读
  //   hiddenText.cap(本值), 不再两侧各写一个 500。
  htCap: 500     // 隐藏文字统计帧数上限(诊断性质, 大文档不再往下数, 挂 truncated)
};

var PT2MM = 0.3527777778;     // 1 pt = 0.3528 mm
// v11.87: mm -> pt 的反向换算(卡⑨ 专色描边要把用户填的 mm 换成 strokeWidth 的 pt)。
//   与 PT2MM 互为倒数, 但**不要**写成 1/PT2MM —— 那样算出来是 2.834645669291339,
//   与这里的字面量差 1e-13, 单测里 near() 过得去、真机不会有差别, 但两处常量各写一份
//   迟早会有人把其中一处改掉。直接给字面量, 与 zhiban 移植源(PF_MM2PT)逐字一致。
var MMPT = 2.8346456693;      // 1 mm = 2.8346 pt
// v11.39: 父链 / 树递归的深度上限收成一处。
//   原先三套并存: pfBlockInfo 走 40、走树的 walkLayer/visitItem 允许 64、另有几处 8。
//   后果是**第 41~64 层**的锁定/隐藏被 pfBlockInfo 当成"未阻挡" ⇒ 动作侧会去改用户锁定的
//   对象, 或对隐藏对象做了显形。统一到 64 后, "判定阻挡"与"遍历是否到达"用同一把尺子。
//   ⚠ 别往下调 —— 64 是 v11.33 为深层组刻意放的; 也别往上加, 再深就是损坏文档了。
//   ⚠ 三处 `depth > 8` 不并入: 那是"符号内再套符号"的层级上限, 语义不同, 有意保持小值。
var PF_MAX_DEPTH = 64;

// ============================================================
// v11.90: 第⑩卡「对照」—— 处理前栅格对照层
//   雪糕 2026-11-19 定稿的流程(与自动制版 zhidongzhiban 的 Step0 同源, 但有**三处**参数不同):
//     复制当前画板上的可见对象 → 栅格化 300ppi → 新建图层 → 图层置**最顶层**
//     → **透明底** → 位置不变 → 原稿不动 → 透明度可调(默认 50%, 改动**下次重建**才生效)
//   ⚠ 别照抄自动制版那版, 三处差异是刻意的:
//     ① zOrder: SENDTOBACK -> BRINGTOFRONT —— 雪糕要"能叠在上面直接比";
//     ② transparency: false(白底) -> **true(透明底)** —— 顶层半透明若带白底, 等于给整版
//        先蒙一层 50% 白雾, 纸白与图形全被冲淡, 对照时颜色判断失真;
//     ③ clipBounds: 全内容并集 -> **当前画板**(四周外扩 PF_SNAP_PAD_MM) —— 多画板文档
//        不再把别的画板一起栅进来。
//   ⚠ 图层名与自动制版**同名**: 两个面板因此认得同一层, 不会在同一个文件里各建一张满版栅格。
//     代价: 建成后若再跑自动制版, 它会按自己的口径认定"已有对照层"并拒绝运行(这是安全行为)。
//   ⚠⚠ 这一层必须被**所有**检查与动作排除(pfIsAuxLayer): 它是一张满版栅格 —— 一旦被扫到,
//     卡④ 会多算一张"嵌入位图"、卡① 会读它的边界(空画板凭空有出血)、卡⑥/⑧ 会把它的
//     fillColor 收进"在用色"(未使用色板判定直接错)。
//   ⚠ 刻意不做「删除对照层」按钮: 删一个"请勿编辑"的层在 AI 图层面板里两秒的事, 而面板上
//     多一颗删除键就多一条"手滑点错"的路径。
// ============================================================
var PF_SNAP_NAME = "对照-处理前(请勿编辑)";
// v11.105: 对照差分的红框画在这个图层里 —— 独立一层, 可整体删除/重画, 不碰对照图本身。
//   名字带"(可删)"是给用户看的: 这是标记层, 删了不影响任何东西。
var PF_DIFF_LAYER = "对照-差异(可删)";
// 当前画板四周外扩(mm): 覆盖标签 3mm / 礼盒 5mm 的常规出血 —— 只按画板矩形裁会把出血区
//   一起裁掉, 对照时就看不出血位对不对。取得比常见出血大一档, 宁可多带 2mm 空白。
var PF_SNAP_PAD_MM = 5;
var PF_SNAP_RESO = 300;
// v11.111: 对照图栅格化的**像素上限**。超过就等比降 ppi(见 pfSnapBuild)。
//   1000 万像素 ≈ A4 在 320ppi / 300×500mm 在 220ppi —— 再大就只是白白拖慢。
var PF_SNAP_MAX_PX = 10000000;
var PF_SNAP_OP_DEF = 50;
var PF_SNAP_OP_MIN = 5;      // 0 等于隐形但仍在文档里参与计算, 不给
var PF_SNAP_OP_MAX = 95;     // 100 会把稿子完全盖掉, 对照就失效了
var PF_SNAP_RT_NAME = "处理前栅格对照";
var PF_SNAP_TAG = "prepress:before-raster:v2";   // 与自动制版同 tag, 便于跨面板识别同一层

// 是否为"辅助层"(对照层) —— 全站唯一的判定入口。
//   所有图层级遍历(walkLayer / 收色 / 清理 / 专色 / 解锁 / 删隐藏)都必须先过这一关。
//   读取失败按 false(不是辅助层)处理: 宁可多扫一遍, 也不要因为读不到名字就把用户真实图层
//   跳过 —— 漏扫等于凭空造数据, 比多扫危险得多。
function pfIsAuxLayer(ly) {
  if (!ly) return false;
  try { return ly.name === PF_SNAP_NAME; } catch (e) { return false; }
}

// 工作副本 —— 每次 runPreflight 开头由 pfThApply 按传入值覆盖, 判定一律读这几个
// v11.75(雪糕选 A): 「名单采集上限」与「默认显示条数」拆成两个值。
//   cap(=5) 仍是面板默认显示条数, 由 res.th 下发, 前端 thv("cap") 用它算默认可见行;
//   这里的 200 是扫描时最多保留的不同值 / 条目数(软封顶), 超了才回退到截断提示。
//   ⚠ 别把它并回 cap: capHint 与前端多处截断都读 cap, 一起放大会把卡片撑长。
var PF_SAMPLE_MAX = 200;
var MAX_SCAN = PF_TH_DEF.scan;
var BLEED_MIN_MM = PF_TH_DEF.bleed;
var TINY_PT = PF_TH_DEF.tiny;
var THIN_STROKE_MM = PF_TH_DEF.thin;
var LIGHT_CH = PF_TH_DEF.light;
var SAMPLE_CAP = PF_SAMPLE_MAX;
var INK_OK = PF_TH_DEF.inkOk;
var INK_WARN = PF_TH_DEF.inkWarn;
var RESO_MIN = PF_TH_DEF.reso;
// v11.47: 分辨率判定加 **0.5% 容差**（300 → 298.5 即达标）—— 阈值比较一律走 pfResoLow()。
//   缘起: v11.46 查清"300 也被选中"是显示取整骗人(299.75 被 Math.round 成 300),
//   当时没加容差(v8.1 定过"299.x 必须照实报")。雪糕 2026-10-27 明确拍板:
//   "299.x 也该算达标" ⇒ 加容差, 并同步改 v8.1 / v10.8 两条旧断言。
//   取 0.5%(不是 1%): 刚好覆盖 299.x 这类"AI 缩放百分比取整"造成的零点几误差,
//   297 这种真·低清仍然照报, 不会把 1% 的模糊地带也放过去。
//   ⚠ 比较式只留一份: 检查端(resoCheck)与定位端(卡⑤)都调 pfResoLow() ——
//     v11.44 就是两边各写一遍, 才漂出"卡里达标、定位却选上"。
var RESO_TOL_PCT = 0.005;

// 阈值表浅拷贝(全是数字, 逐个列出而不是 for-in —— 免得把原型链上的东西带出去)
// v10.60: 补齐 htCap —— 原实现漏带该项, 使 pfThDefaults 下发的默认表缺 htCap。
//   当前前端走 htx.cap 取该值(唯一真源), 侥幸未暴露; 但任何读 th.htCap 的调用方都会
//   拿到 undefined ⇒ 补上, 让"浅拷贝 == 全字段"这条语义成立(新加字段不再被漏掉)。
function pfThCopy(t) {
  return { bleed: t.bleed, tiny: t.tiny, thin: t.thin, light: t.light,
           inkOk: t.inkOk, inkWarn: t.inkWarn, rbSum: t.rbSum, reso: t.reso,
           cap: t.cap, scan: t.scan, htCap: t.htCap };
}
// 面板首次打开设置时向 jsx 要默认值 —— 只回默认值, 不碰文档、不扫描
function pfThDefaults() {
  var res = { ok: true, th: pfThCopy(PF_TH_DEF) };
  return pfReturn(res);
}
// v10.2: 面板传 "bleed|reso|thin|tiny|inkOk|inkWarn"(竖线分隔; v10.1 是 7 项、多一个 tinyBad)。
//   不用 JSON —— ExtendScript 没有 JSON 对象, 竖线分隔最省事也没有转义风险。
//   逐项校验: 非数字 / <=0 的项**回落默认值**(不是整串丢弃); 再强制一条不变量(inkOk < inkWarn)。
//   ⚠ **字段数对不上就整串不认**(新旧版本错配 / 面板从没存过设置) —— 宁可"设置没生效",
//     也不要按错位的线序去读: 那会把 inkOk 当 tiny 用, 拿错数字判定而且毫无提示。
//   v10.9: 不认 ≠ 不动 —— 工作副本(BLEED_MIN_MM 等)仍要**无条件回默认**。jsx 上下文常驻,
//     若字段数不符就提前 return, 模块级阈值会留着**上一次扫描**的值 ⇒ 判定用旧阈值、res.th
//     却回默认 ⇒ 显示与判定不同源(雪糕 2026-10-07 真机踩中: 阈值改回默认后报出旧阈值结果)。
// v10.32: 面板只传这 6 项(都是 <name>|<name>|… 的顺序线序),
//   提成模块级常量 —— 原先每轮 check 都在函数内新建一次数组, 属可省的分配。
// v11.5: 末尾追加 "light"(色版极浅阈值) —— 原先它只能在 PF_TH_DEF 里改, 面板设置不到。
//   位置必须与 main.js 的 TH_KEYS 一致(light 在末位), 否则当场错位。
// v12.14: 再追加 "rbSum"(四色黑判断线) —— 同样接在末位, 线序前缀升 "v3"。
//   ⚠ **旧线序必须留着**: CEP 缓存里可能还是上一版 main.js, 它发的是 "v2|…" 七项;
//     若只认 v3, 用户存过的阈值会整列**静默**回落默认。PF_TH_KEYS_V2 就是那份七项线序。
var PF_TH_KEYS = ["bleed", "reso", "thin", "tiny", "inkOk", "inkWarn", "light", "rbSum"];
var PF_TH_KEYS_V2 = ["bleed", "reso", "thin", "tiny", "inkOk", "inkWarn", "light"];

function pfThApply(s) {
  var t = pfThCopy(PF_TH_DEF);
  // v10.33: 去掉 `var keys = PF_TH_KEYS;` 别名 —— 常量不会改, 直接用更直白。
  var parts = String(s === undefined || s === null ? "" : s).split("|");
  var i, v;
  // v11.5: 新线序带 "v2" 前缀(与 main.js thWire 同源) —— 加了字段后字段数不再能区分新旧
  //   (新 7 项 / v10.1 旧 7 项都是 7)。无前缀的旧面板(6 项)按旧口径读不进, 逐项回落默认。
  // v12.14: 三套线序并存 —— v3(8 项) / v2(7 项) / 无前缀(6 或 7 项, 按 v2 读)。
  var off = 0, ks = PF_TH_KEYS_V2, hit = false, n = 0;
  if (parts[0] === "v3") {
    off = 1; ks = PF_TH_KEYS; n = parts.length - off; hit = (n === PF_TH_KEYS.length);
  } else if (parts[0] === "v2") {
    off = 1; ks = PF_TH_KEYS_V2; n = parts.length - off; hit = (n === PF_TH_KEYS_V2.length);
  } else {
    ks = PF_TH_KEYS_V2; n = parts.length;
    hit = (n === PF_TH_KEYS_V2.length || n === PF_TH_KEYS_V2.length - 1);
  }
  // v10.9: 字段校验收进 if —— 工作副本赋值无条件执行, 字段数不符时 t 即全默认。
  // v11.5: 额外放行"无前缀 6 项"(旧面板线序) —— 万一 CEP 缓存里还是旧 main.js,
  //   阈值照旧生效(light 回落默认), 而不是整列静默回默认。多余项读到 undefined ⇒ NaN ⇒ 跳过。
  if (hit) {
    for (i = 0; i < ks.length; i++) {
      v = parseFloat(parts[i + off]);
      if (!isNaN(v) && isFinite(v) && v > 0) t[ks[i]] = v;
    }
    // v10.33: 不变量 inkOk < inkWarn
    if (t.inkWarn <= t.inkOk) t.inkWarn = Math.max(t.inkOk + 1, PF_TH_DEF.inkWarn);
    // v12.14: 四色黑判断线必须高于"偏重线", 否则整张稿子都会被判四色黑、一键转成单黑。
    //   坏值**回落默认**(与其它项"填 0 = 用默认"同一口径), 不静默蹭到 inkOk+1 ——
    //   蹭出来的数字用户没见过, 面板回填时会显得莫名其妙。
    if (!(t.rbSum > t.inkOk)) t.rbSum = PF_TH_DEF.rbSum;
  }
  BLEED_MIN_MM = t.bleed; RESO_MIN = t.reso; THIN_STROKE_MM = t.thin;
  TINY_PT = t.tiny;
  INK_OK = t.inkOk; INK_WARN = t.inkWarn; LIGHT_CH = t.light;
  PF_RB_SUM = t.rbSum;      // v12.14: 判断线随设置走(原先写死 320)
  return t;
}

function pfRound(v) { return Math.round(v * 10) / 10; }

// ---- 计算四色油墨总量 C+M+Y+K; 返回 {total, type, desc} ----
//     total<0 表示非 CMYK 类(无法按四色相加判断)
function pfInkSum(c) {
  if (!c) return null;
  var tn = "";
  try { tn = c.typename; } catch (e) { return null; }

  if (tn === "CMYKColor") {
    var cy = Math.round(c.cyan), mg = Math.round(c.magenta),
        yl = Math.round(c.yellow), bk = Math.round(c.black);
    // v8.0: 分档用**原值**求和 —— 逐分量取整再相加会在 220/300 阈值附近偏 ±2(最多四个 0.5),
    //       把临界对象分错级(如 219.6+0.0+0.0+0.0 取整成 220 被误判"偏重")。
    //       desc 仍用取整后的分量(显示口径不变),前端显示 "= 总量" 时再统一四舍五入。
    var total = c.cyan + c.magenta + c.yellow + c.black;
    return { total: total, type: "cmyk", desc: "C" + cy + " M" + mg + " Y" + yl + " K" + bk };
  }
  if (tn === "GrayColor") {
    var g = Math.round(c.gray);
    return { total: c.gray, type: "cmyk", desc: "K" + g };   // v8.0: 同上,用原值分档
  }
  if (tn === "RGBColor") {
    var r = Math.round(c.red), gg = Math.round(c.green), b = Math.round(c.blue);
    return { total: -1, type: "rgb", desc: "RGB(" + r + "," + gg + "," + b + ")" };
  }
  if (tn === "SpotColor") {
    var sn = "";
    try { sn = c.spot.name; } catch (e2) {}
    return { total: -1, type: "spot", desc: "专色 " + sn };
  }
  // v8.8: 渐变 / 图案没有单一油墨总量可判 ⇒ 归入"未判断"(前端单列)，
  //   旧实现直接 return null 被静默丢弃，汇总行的分类计数与对象总数对不上。
  //   NoColor(无填充 / 无描边)本就不产生油墨，仍返 null 不计数。
  if (tn === "GradientColor") return { total: -1, type: "other", desc: "渐变" };
  if (tn === "PatternColor") return { total: -1, type: "other", desc: "图案" };
  return null;
}

// v8.5: 一次读齐 CMYK 四分量,同时产出"油墨总量"与"极浅通道"判定。
//   旧实现里 pfInkSum 与 pfLightChannel 各自回读四分量(共 8 次跨桥) ⇒ 合并为 4 次。
//   非 CMYK(Gray/RGB/专色/其他)原样交给 pfInkSum,light 恒为 null(与旧口径一致)。
//   返回 { total, type, desc, light }; light = 极浅说明串(str) 或 null。
//   ⚠ 读分量可能抛异常(混合色),由调用方 try/catch 兜住 —— 与 pfInkSum 行为一致。
function pfInkLightBoth(c) {
  if (!c) return null;
  var tn = "";
  try { tn = c.typename; } catch (e) { return null; }
  if (tn !== "CMYKColor") return pfInkSum(c);
  var vc = c.cyan, vm = c.magenta, vy = c.yellow, vk = c.black;   // 各读 1 次
  var cy = Math.round(vc), mg = Math.round(vm), yl = Math.round(vy), bk = Math.round(vk);
  var desc = "C" + cy + " M" + mg + " Y" + yl + " K" + bk;
  // v6.1 口径: 四舍五入后 0<值<5 视为极浅(恰为 0 不算); Gray 不判
  var light = ((cy > 0 && cy < LIGHT_CH) || (mg > 0 && mg < LIGHT_CH) ||
               (yl > 0 && yl < LIGHT_CH) || (bk > 0 && bk < LIGHT_CH)) ? desc : null;
  return { total: vc + vm + vy + vk, type: "cmyk", desc: desc, light: light };  // v8.0: 分档用原值
}

function pfSnippet(tf) {
  try {
    var s = tf.contents;
    s = s.replace(/[\r\n\t]+/g, " ");
    if (s.length > 12) s = s.substring(0, 12) + "...";
    return '"' + s + '"';
  } catch (e) { return "(文本)"; }
}

// v11.73(雪糕): 文本溢出检测已**整体移除** —— "还是不行，检测不出来，彻底删掉这个功能吧"。
//   历程: v11.60 判 `TextFrame.overflows`(AI 没有此属性, 恒 undefined) ⇒ 空转;
//         v11.71 改"Σ行字数 + (段数-1)"; v11.72 改社区通行的"两边去回车对账" —— 三轮都没跑通。
//   结论: Illustrator 的 DOM 不暴露"这一帧溢出了"这个事实, 任何脚本对账都只是近似,
//     真机表现不可控。与其留一个"看起来在查、实际查不出"的假检测, 不如没有。
//   ⇒ 别再把它加回来。要确认字有没有排出来, 在 AI 里选中文本框看溢出标记;
//     而未排出来的字必然同时是"未转曲", 卡③ 的未转曲清单已经覆盖了这批框。
//   一并删掉: 卡③ 溢出块 / `overset` 统计与 `res.overset` 字段 / 预览工具 --ovs /
//     bt121 与 bt132 的正面断言(改成"守住已移除")。
// v6.2: 取对象名(带引号),无 name 返回 "" —— 样本改结构化后由前端拼装展示
function pfObjName(it) {
  try { if (it.name && it.name !== "") return '"' + it.name + '"'; } catch (e) {}
  return "";
}

// v8.5: 原 pfLightChannel(单独跑一遍极浅判定)已并入上面的 pfInkLightBoth,
//   所有调用点统一改为"一次读出 ink+light",不再回读四分量。

// v8.3: 叠印读取——一律包 try/catch,读不到属性 / 属性不存在 / 抛异常 全部当 false。
//   不写成 obj[prop] 泛读是因为 Adobe 宿主对象对中括号取值偶有怪癖,显式写更稳。
//   图形侧(pageItem 级)与文字侧(字符级)各两个,共四个。
function pfOvpFill(obj) {
  try { return (obj.fillOverprint === true); } catch (e) { return false; }
}
function pfOvpStroke(obj) {
  try { return (obj.strokeOverprint === true); } catch (e) { return false; }
}
function pfCharOvpFill(ca) {
  try { return (ca.overprintFill === true); } catch (e) { return false; }
}
function pfCharOvpStroke(ca) {
  try { return (ca.overprintStroke === true); } catch (e) { return false; }
}
// v8.3: 叠印样本的色值说明——复用 pfInkSum 的 desc(CMYK 四色 / K 灰 / RGB / 专色),
//   拿不到就退化成 typename(如 PatternColor),再不行给 "(无)"。
// v9.4: 顺带给出 white —— 白色叠印是最典型的印刷事故(白墨叠印后不再遮挡下层,印出来会花),
//   要在卡片右上角单挂一个"白叠印 N 处"。判定只认**能确证的纸白**:CMYK/Gray 四分量和为 0、
//   或 RGB(255,255,255);专色 / 渐变 / 图案一律不算(与叠印读取同口径:宁可不报,绝不误报)。
function pfOvpInfo(c) {
  var o = null;
  try { o = pfInkSum(c); } catch (e) {}
  var desc = (o && o.desc) ? o.desc : "(无)";
  if (!o) { try { if (c && c.typename) desc = String(c.typename); } catch (e2) {} }
  var white = !!(o && ((o.type === "cmyk" && o.total === 0) ||
                       (o.type === "rgb" && o.desc === "RGB(255,255,255)")));
  // v10.43: 把 pfInkSum 的完整结果挂在 _o 上 —— pfOvpAdd 紧接着算四分类时
  //   可直接复用, 同一颜色不必再跑一遍 pfInkSum。⚠ _o 仅内部传递用: 本函数的消费方
  //   (pfOvpAdd)只取 desc/white 标量, _o 不会随 res 回传前端。
  return { desc: desc, white: white, _o: o };
}
// v10.11: 删除 pfOvpDesc —— "兼容旧调用(只要色值说明)"的一行包装, 全工程零引用
// (pfOvpInfo 统一后旧调用点早已改完), 属遗留死代码; 已 grep 源码+测试确认为 0 引用。

// v10.14: 叠印四分类 —— 单黑 / 纯白 / 彩色 / 专色, 供卡⑦分级版展示与规则动作筛选。
//   · "white"  纯白: CMYK/Gray 四色**原值之和 < 1**(极小非零也按白处理), 或 RGB(255,255,255)
//   · "k100"   单黑: CMYK 且 C/M/Y 原值均 < 1、K 原值 >= 100(Gray K100 亦算)
//   · "spot"   专色: 专色 / 渐变 / 图案等非 CMYK 可判类
//   · "color"  彩色: 其余 CMYK(RGB 归此类)
//   ⚠ 判定顺序: white 优先于 k100 —— K0 的白不可能同时是 K100, 天然互斥, 顺序只为稳妥。
//   ⚠ 全部分类一律**读原值**, 不拿取整后的显示串反推(用 desc 判 K100, K99.6 显示成
//     K100 会误判为单黑, 方向反了)。
// v10.43: 拆出带 info 的变体 —— pfOvpAdd 已为白计数算过 pfOvpInfo(内含
//   一次 pfInkSum), 原 pfOvpClass 又对同一颜色跑一遍 pfInkSum。现在把 info._o 传进来
//   直接复用; 调用方没有 info(如规则动作侧)时传 null, 行为与原版逐字一致。
//   ⚠ white 两口径并存不变: info.white 是 ===0(pfOvpInfo 原口径, 白叠印计数用),
//     pfOvpClass 内的是 <1(四分类口径) —— 复用 pfInkSum 结果不影响任何一侧的判定。
function pfOvpClass(c) { return pfOvpClass2(c, null); }
function pfOvpClass2(c, info) {
  var o = null;
  try { o = (info && info._o) ? info._o : pfInkSum(c); } catch (e) {}
  if (!o) {
    // pfInkSum 返 null: 无填充/描边(NoColor)或读不出 —— 归专色类兜底(不误判为白/黑)
    return { cls: "spot", desc: pfOvpInfoDesc(c), white: false };
  }
  var desc = o.desc;
  if (o.type === "rgb") {
    if (o.desc === "RGB(255,255,255)") return { cls: "white", desc: desc, white: true };
    return { cls: "color", desc: desc, white: false };
  }
  if (o.type === "spot" || o.type === "other") return { cls: "spot", desc: desc, white: false };
  // cmyk(含 Gray 归一: total=K 原值)。四色原值之和 < 1 ⇒ 纯白(极小非零也算白)
  if (o.total < 1) return { cls: "white", desc: desc, white: true };
  // 单黑判定: 读原值 —— C/M/Y 均 < 1 且 K >= 100
  if (pfIsK100Raw(c)) return { cls: "k100", desc: desc, white: false };
  return { cls: "color", desc: desc, white: false };
}
// v10.14: 单黑原值判定 —— 直接读颜色对象原值, 不解析显示串。
//   CMYK: C/M/Y 均 < 1 且 K >= 100; Gray: gray >= 100。
function pfIsK100Raw(c) {
  try {
    var tn = "";
    try { tn = c.typename; } catch (et) { return false; }
    if (tn === "GrayColor") return (c.gray >= 100);
    if (tn !== "CMYKColor") return false;
    var cy = c.cyan, mg = c.magenta, yl = c.yellow, bk = c.black;
    return (cy < 1 && mg < 1 && yl < 1 && bk >= 100);
  } catch (e) { return false; }
}
function pfOvpInfoDesc(c) {
  try { var o = pfInkSum(c); if (o && o.desc) return o.desc; } catch (e) {}
  try { if (c && c.typename) return String(c.typename); } catch (e2) {}
  return "(无)";
}

// ============================================================
// v11.91: 四色黑判定
//   规则来源: 自动制版 CONFIG.richBlackThreshold(甲方 2026-08-21 定"四通道均 >=80%")。
//   现行口径(v12.12, 雪糕 2026-11-25): **只看四通道之和 >= 320**, 逐通道的 80% 下限已取消。
//     "只要四者之和 >=320 就行了" —— C80/M80/Y80/K80(=320) 与 C100/M100/Y100/K20(=320) 同样命中。
//   ⚠ 三处必须与自动制版 Step4 同口径, 否则同一份稿两个面板给出不同结论:
//     ① **全局 Process 色**在 DOM 里是 SpotColor 壳(spot.colorType === ColorModel.PROCESS),
//        要按 tint 折算成实际 CMYK 才能判; 真专色(ColorModel.SPOT)一律不参与
//        —— 绝不把专色当"四色黑"转掉(那是印刷事故, 不是修正)。
//     ② 面板显示 80% 内部可能是 79.9985(浮点尾数) ⇒ 判定前先两位小数四舍五入;
//        而"单黑"判定仍走上面既有的 pfIsK100Raw(C/M/Y<1 且 K>=100), 这里不另立一套。
//     ③ 复合路径 / 裁切路径由调用方逐对象传入, 本函数只管颜色本身。
//   ⇒ 白名单式: 只认 CMYKColor 与 Process 壳, 其余(Gray/RGB/专色/渐变/图案)一律 null。
//   ⚠ 历史: v11.95~v11.116 是严格大于(80/80/80/80 不转); v11.117 改回含等号并加了"每通道"闸;
//     v12.12 把"每通道"整条取消; **v12.14 默认 320 -> 330**(雪糕选 C) —— 320 那一档
//     恰好是 C100/M100/Y100/K20 这类三色富黑, 转成 K100 后由"四色叠深灰黑"变"纯黑"。
//   🔴 本值现在是**可调的**: 真源在 PF_TH_DEF.rbSum, 由 pfThApply 覆盖(设置里那一行
//     「四色黑合计达」)。真正参与判定的始终是这个变量, 不要在多处另写 330。
var PF_RB_SUM = 330;

// 取"实际印刷 CMYK": CMYKColor 原样返回; 全局 Process 色按 底色 × tint 折算; 其余 null
function pfEffCMYK(c) {
  if (!c) return null;
  var tn = "";
  try { tn = c.typename; } catch (e) { return null; }
  if (tn === "CMYKColor") return c;
  if (tn !== "SpotColor") return null;
  try {
    if (!c.spot || c.spot.colorType !== ColorModel.PROCESS) return null;
    var base = c.spot.color;
    if (!base || base.typename !== "CMYKColor") return null;
    var f = (c.tint === undefined ? 100 : c.tint) / 100;
    return { cyan: base.cyan * f, magenta: base.magenta * f, yellow: base.yellow * f, black: base.black * f };
  } catch (e2) { return null; }
}

// 判四色黑: 命中 true, 否则 false。
//   v12.12(雪糕): 收敛成**一道闸** —— 四通道之和 >= 320 即可, 逐通道下限取消。
//   ⚠ 副作用(已知并接受): K 很浅的组合(如 C100/M100/Y100/K20)也会被转成 C0M0Y0K100,
//     视觉上由"四色叠出的深灰黑"变成"纯黑" —— 这正是四色黑转单黑要解决的问题。
//   v11.92(雪糕): 块里不再列样本 ⇒ 不再返回 desc, 只回布尔(与 pfIsK100Raw 同一种返回形态)。
function pfRichBlackChk(c) {
  var cm = pfEffCMYK(c);
  if (!cm) return false;
  var cy, mg, yl, bk;
  try {
    cy = Math.round(cm.cyan * 100) / 100;
    mg = Math.round(cm.magenta * 100) / 100;
    yl = Math.round(cm.yellow * 100) / 100;
    bk = Math.round(cm.black * 100) / 100;
  } catch (e) { return false; }
  return (cy + mg + yl + bk) >= PF_RB_SUM;
}

// v10.32: 采样池内部去重键字段名 —— 提成模块级常量。
//   原先每个写入点都各写一遍 "_k" 字符串字面量(易拼错且 grep 时噪声大);
//   这里只作纯字面量替换, 行为零变化。
var PF_SAMPLE_KEY = "_k";

// v7.8: 采样池——同一个"值"只占 1 条,条数上限 cap;同值再出现时只累加它的 n。
//   为什么:前端拿到 5 条原始样本后会把重复的合并成一行并加 " ×n",
//   若池里 5 条里有重复,合并后就不足 5 行了(雪糕:v7.7 上线后 "只列出了 4 个,我想显示 5 个")。
//   改成"按不同值收"后,5 条 = 5 个不同色值 = 5 行;且 n 是**文档全量真值**,
//   不受采样池大小限制(原来 ×n 只统计池内条数,同色 >5 个就会少报)。
//   key 由调用方给(色值 + 填充/描边 + 名称 + 来源),与前端合并用的分组键保持一一对应。
//   注意: 池满后再出现的**新**值直接丢弃(不显示也不计数)——它由块标题的总数与前端截断提示兜住。
function pfSampleAdd(list, rec, key, cap) {
  for (var i = 0; i < list.length; i++) {
    if (list[i][PF_SAMPLE_KEY] === key) { list[i].n++; return; }
  }
  if (list.length < cap) { rec[PF_SAMPLE_KEY] = key; rec.n = 1; list.push(rec); }
}

// v7.9: 采样池"只留最值前 cap 个"—— dir<0 留最大(油墨总量,从高到低),dir>0 留最小(图片 ppi,从低到高)。
//   与 pfSampleAdd 一样按 key 去重(n 累加全量次数),但池满后比的是 rec[field]:
//   不如池内最差的那条就直接丢弃,更优则挤掉最差的、按序插入。
//   列表**始终保持有序**,所以前端按数组顺序渲染即可,不必再排。
//   为什么要这个: 原来"前 5 条"是"树遍历里最先遇到的 5 个"(= 文档顺序,与严重程度无关);
//   改成 top-K 后,列出的才是真正最严重的 5 个,而且有顺序。
//   ⚠ 每类各自取 top-5(文字/图形是两个独立的 stat),前端会把两者合并后再全局排一次。
function pfSampleAddTop(list, rec, key, cap, field, dir) {
  var i, j;
  for (i = 0; i < list.length; i++) {
    if (list[i][PF_SAMPLE_KEY] === key) { list[i].n++; return; }
  }
  if (list.length >= cap) {
    var last = list[list.length - 1];
    if (dir < 0 ? rec[field] <= last[field] : rec[field] >= last[field]) return;
    list.pop();
  }
  rec[PF_SAMPLE_KEY] = key; rec.n = 1;
  for (j = 0; j < list.length; j++) {
    if (dir < 0 ? rec[field] > list[j][field] : rec[field] < list[j][field]) break;
  }
  list.splice(j, 0, rec);
}

// 统一返回出口: Base64 编码(仅含字母数字 +/ =,任何传输层都无法破坏)
function pfUtf8Bytes(str) {
  var bytes = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) {
      bytes.push(0xC0 | (c >> 6));
      bytes.push(0x80 | (c & 0x3F));
    } else if (c < 0xD800 || c >= 0xE000) {
      bytes.push(0xE0 | (c >> 12));
      bytes.push(0x80 | ((c >> 6) & 0x3F));
      bytes.push(0x80 | (c & 0x3F));
    } else if (c <= 0xDBFF) {
      // v8.8: 高代理 —— 只有紧跟低代理才组成码位。孤立时(含出现在串尾)旧实现会读到
      //   charCodeAt 越界返回的 NaN，编出 F0 80 80 80(超长编码 U+0000) ⇒ 落进 JSON
      //   就是**裸控制字符** ⇒ 前端 JSON.parse 拒收 ⇒ 整轮结果作废。现替换为 U+FFFD。
      var c2 = (i + 1 < str.length) ? str.charCodeAt(i + 1) : -1;
      if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
        i++;
        var cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
        bytes.push(0xF0 | (cp >> 18));
        bytes.push(0x80 | ((cp >> 12) & 0x3F));
        bytes.push(0x80 | ((cp >> 6) & 0x3F));
        bytes.push(0x80 | (cp & 0x3F));
      } else {
        bytes.push(0xEF); bytes.push(0xBF); bytes.push(0xBD);
      }
    } else {
      // v8.8: 孤立低代理(0xDC00~0xDFFF) 同样无法表示，一并替换为 U+FFFD
      bytes.push(0xEF); bytes.push(0xBF); bytes.push(0xBD);
    }
  }
  return bytes;
}

function pfBase64(str) {
  var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var bytes = pfUtf8Bytes(str);
  // v11.1(审查 ⑬): out += ... 改成"按块 push + 末次 join"。
  //   原写法每 3 字节做 4 次字符串拼接, 报告一大(几十 KB)就是几十万次拼接,
  //   ExtendScript 的字符串是不可变的长串, 拼接要反复重新分配 ⇒ 编解码本身成了瓶颈。
  //   现在每 3 字节只拼一个 4 字符块、push 一次, 最后 join 一次。输出逐字节不变。
  var buf = [];
  var i = 0;
  while (i < bytes.length) {
    var b1 = bytes[i++];
    var b2 = (i < bytes.length) ? bytes[i++] : -1;
    var b3 = (i < bytes.length) ? bytes[i++] : -1;
    var has2 = (b2 !== -1), has3 = (b3 !== -1);
    var n = (b1 << 16) | ((has2 ? b2 : 0) << 8) | (has3 ? b3 : 0);
    buf.push(chars.charAt((n >> 18) & 63) + chars.charAt((n >> 12) & 63) +
             (has2 ? chars.charAt((n >> 6) & 63) : "=") +
             (has3 ? chars.charAt(n & 63) : "="));
  }
  return buf.join("");
}

function pfReturn(res) {
  try { res.build = PF_BUILD; } catch (e) {}
  return pfBase64(pfStringify(res));
}

// ============================================================
// 字体可用性探测(全局,跨多次检查复用)
// v8.5 起: 由"全表快照"改为"**按需探测**"为主。
//   背景: app.textFonts 可能上千条,旧实现在重建时逐条读 name+family+style
//   (3×N 次跨桥,真机 N≈1810 ⇒ 可达 1~3 秒);但缺失判定只针对"文档实际出现的
//   字体名"(去重后通常 5~30 个) ⇒ 只需对这 K 个名按需 getByName。
// 三重保险(正确性优先):
//   ① 自检: 用 app.textFonts[0].name(必然存在)试 getByName;
//      命中才启用按需探测,否则自动回退全表快照(= 老行为)。
//   ② 兜底: 某个名"探测查不到"时,先建一次全表快照仲裁,防名字不匹配误报缺失。
//   ③ 失效: app.textFonts.length 变化(装/删字体)时清空探测缓存并重新自检,
//      与 v5.8 "数量变化才重建"的语义一致。
// v5.8 沿革: 旧实现只在脚本加载时建一次表,jsxReady 优化后脚本不再重载 ⇒
//   中途装/激活字体后缓存永不更新、一直误报缺失;故改为每次检查比对 length。
// ============================================================
var __pfSysFonts = {};             // name -> {f,s,ph}: 按需探测命中 / 全表快照 都写这里
var __pfSysFontCount = -1;         // 全表快照对应的 textFonts.length
var __pfSysFontsReady = false;     // 全表快照是否可用(空表会把所有字体误报成缺失)
var __pfFontProbe = {};            // name -> meta(命中) / null(确认查不到)
var __pfFontCount = -1;            // 上次比对时的 textFonts.length(变化 ⇒ 缓存作废)
var __pfProbeOn = false;           // 是否启用按需探测(自检通过才 true)
var __pfProbeChecked = false;      // 自检只做一次(会话内)
var __pfProbeFallbackDone = false; // 全表兜底仲裁只做一次(会话内)

function pfEnsureFontTable() {
  var n = -1;
  try { n = app.textFonts.length; } catch (eFcnt) { return; }
  if (__pfSysFontCount === n) return; // 数量未变,复用缓存
  __pfSysFontCount = n;
  // 读取失败(length 拿不到)时标记不可用: 空表会把所有字体误报成"缺失",
  // 宁可本次跳过缺失字体检测,也不给出错误结论(v3.3)
  __pfSysFontsReady = (n > 0);
  __pfSysFonts = {};
  try {
    for (var fi = 0; fi < n; fi++) {
      try {
        var sfn = app.textFonts[fi].name;
        if (sfn) {
          // v5.12: 同步记录 family/style(重建时才读,均摊成本;缺失字体占位条目
          // 这两项通常为空,是与真实安装字体区分的关键特征)
          var sfMeta = { f: "", s: "", ph: false };
          try { sfMeta.f = String(app.textFonts[fi].family || ""); } catch (ef1) {}
          try { sfMeta.s = String(app.textFonts[fi].style || ""); } catch (ef2) {}
          // v5.13: 占位条目标记——AI 为文档缺失字体临时挂的条目没有 style,
          // 且 family 为空或直接等于字体名;真实安装的字体 style 至少是 Regular
          sfMeta.ph = (sfMeta.s === "" && (sfMeta.f === "" || sfMeta.f === sfn));
          __pfSysFonts[sfn] = sfMeta;
        }
      } catch (efs) {}
    }
  } catch (efc) {
    // v11.21(外审 #14): 中途异常(被这里吞掉)会留下**半张表**, 而上面已经把
    //   __pfSysFontCount 记成 n ⇒ 下次会以为表是完整的、永远不重建, 半表会让
    //   表里没有的字体全被判成缺失。这里把计数置 -1, 下次强制重建。
    __pfSysFontCount = -1;
    __pfSysFonts = {};
    __pfSysFontsReady = false;
  }
  // 构建后校验: 表仍为空(逐条读取全失败/中途异常)则视为不可用,避免半表全量误报(v3.4)
  if (__pfSysFontsReady) {
    __pfSysFontsReady = false;
    for (var fk in __pfSysFonts) { __pfSysFontsReady = true; break; }
  }
}

// v8.5: 自检 —— app.textFonts[0].name 必然存在,试 getByName 能否按 name 命中。
//   命中 ⇒ 按需探测可用;未命中 / 抛异常 / 无该方法 ⇒ 判定不可用,回退全表快照。
function pfProbeSelfCheck() {
  __pfProbeChecked = true;
  __pfProbeOn = false;
  try {
    if (typeof app.textFonts.getByName !== "function") return;
    var n0 = app.textFonts[0].name;
    if (!n0) return;
    __pfProbeOn = (app.textFonts.getByName(n0) != null);
  } catch (eSC) { __pfProbeOn = false; }
}

// v8.5: 按需探测单个字体名。命中 ⇒ 写入 __pfSysFonts 并返回 true;
//   查不到 ⇒ 先做一次全表快照仲裁(兜底,防"名字与 getByName 不匹配"误报缺失),
//   仲裁后仍无该名才返回 false(确属缺失)。
function pfProbeFont(n) {
  if (Object.prototype.hasOwnProperty.call(__pfSysFonts, n)) return true;
  if (!__pfProbeOn) return false;
  if (Object.prototype.hasOwnProperty.call(__pfFontProbe, n)) {
    var hit = __pfFontProbe[n];
    if (hit) { __pfSysFonts[n] = hit; return true; }
  } else {
    var meta = null;
    try {
      var tf = app.textFonts.getByName(n);
      if (tf) {
        var f = "", s = "";
        try { f = String(tf.family || ""); } catch (e1) {}
        try { s = String(tf.style || ""); } catch (e2) {}
        meta = { f: f, s: s, ph: (s === "" && (f === "" || f === n)) };
      }
    } catch (eG) { meta = null; }
    __pfFontProbe[n] = meta;
    if (meta) { __pfSysFonts[n] = meta; return true; }
  }
  // 兜底:探测查不到 ⇒ 建一次全表快照再仲裁(会话内只做一次)
  if (!__pfProbeFallbackDone) {
    __pfProbeFallbackDone = true;
    pfEnsureFontTable();
    if (Object.prototype.hasOwnProperty.call(__pfSysFonts, n)) return true;
  }
  return false;
}

// v8.5: 统一入口 —— textFonts.length 变化时清缓存并重新自检;
//   仅当按需探测不可用时才退回"全表快照"(老行为)。
function pfEnsureFonts() {
  var n = -1;
  try { n = app.textFonts.length; } catch (eC) { return; }
  if (__pfFontCount === n) return;   // 数量未变:缓存仍有效
  __pfFontCount = n;
  // 字体数变了(装/删字体) ⇒ 探测缓存 + 全表快照全部作废,重新自检
  __pfFontProbe = {};
  __pfProbeFallbackDone = false;
  __pfSysFonts = {};
  __pfSysFontCount = -1;
  __pfSysFontsReady = false;
  if (!__pfProbeChecked) pfProbeSelfCheck();
  if (!__pfProbeOn) pfEnsureFontTable();
}

pfEnsureFonts(); // 脚本加载时探测首表

// v5.13/v8.5: 缺失判定统一出口——不在表里/查不到,或表里只有占位条目
// (AI 为文档缺失字体临时挂的假条目,见 ph 标记),都算缺失。
// v8.5: 按需探测模式下先确保该名字已探测(探测内部含"查不到 ⇒ 全表兜底仲裁")。
function pfIsFontMissing(n) {
  if (!n || n === "(混合字体)") return false;
  var meta = __pfSysFonts[n];
  if (__pfProbeOn && !meta) { if (pfProbeFont(n)) meta = __pfSysFonts[n]; }
  if (!meta) return true;
  if (meta.ph) return true;
  // v8.4: 第二判据"切分痕迹"——AI 为文档缺失字体伪造的占位条目,其 family/style 恰好是
  // 字体名在首个连字符处硬切出来的: style=连字符后段, family=前段(连字符→空格)+空格+后段。
  // 旧 ph 判据(style 为空且 family 空/等于名)对"名中带连字符的缺失字体"整类漏报,
  // 而真实安装字体的 family 取自真实 name table(如"阿里妈妈方圆体 VF"),不会命中此式。
  // 真机实测(1810 字体):命中 1、误报 0。
  var i = n.indexOf("-");
  if (i >= 0) {
    var tail = n.substring(i + 1);
    if (meta.s === tail && meta.f === (n.substring(0, i) + " " + tail)) return true;
  }
  return false;
}

// v5.6: 文档指纹(名称+路径),供前端在面板获得焦点时判断用户是否切换了文档,
// 切换则自动重新检查(轻量探测,只读 name/path 两个属性)
function pfDocKey() {
  var res = { ok: false };
  try {
    if (app.documents.length === 0) { res.key = "(无文档)"; res.ok = true; return pfReturn(res); }
    var doc = app.activeDocument;
    var p = "";
    // v8.7: 哨兵必须与 runPreflight 的 res.docPath 逐字一致 —— 前端指纹是 docName|path,
    //   两处哨兵不同(旧: 这里 "(未保存)" vs 那边 "(文档尚未保存)")会让"新建未另存"的文档
    //   在面板每次获得焦点时都误判成"用户切换了文档", 从而全量重扫一遍。
    try { p = doc.path.fsName; } catch (e) { p = "(文档尚未保存)"; }
    res.key = doc.name + "|" + p;
    res.ok = true;
  } catch (err) { res.error = String(err); }
  return pfReturn(res);
}

// ============================================================
// 主检查入口(单遍扫描)
// ============================================================
// v10.0 新增: 七卡开关 —— c1~c7 依次对应 ①画板出血 ②隐藏 ③字体 ④嵌入 ⑤分辨率
//   ⑥油墨描边 ⑦叠印(v9.4 起叠印已从⑥拆出独立成卡)。缺省(undefined)= 开,
//   兼容旧调用 runPreflight(); 0 / false / "0" = 关。
//   关掉的卡在遍历里**完全不读其依赖属性**(不是"读完再丢弃"): 卡①走路 bleedOf 入口,
//   卡⑤走 resoCheck 入口,卡⑥⑦在对象分派分支里门控,卡③④同理。判定阈值/样本口径/卡片文案一律不变。
// v11.87: 卡⑨「专色描边」走第 **11** 参(c11) —— 第 8 位是阈值串(c8), 第 9/10 位已被
//   色板/清理占用。⚠ 新卡一律**往后排**, 绝不插进 c8 之前(否则阈值串被顶位、全卡判定错线)。
function pfCkOn(v) { return !(v === 0 || v === false || v === "0"); }

function runPreflight(c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11) {
  var res = { ok: false };
  // v11.100: 分段计时 —— 只有先量准, 才知道"卡好几分钟"卡在哪一段。
  //   记录的是**从开头起的累计毫秒**, 前端两两相减得到各段耗时(见 main.js 的 render)。
  //   ⚠ 用 new Date().getTime(): 本文件禁 ES5, 不能依赖 Date.now()。
  //   代价: 十来次 new Date(), 可以忽略; 关掉的话把 PF_TIMING 置 false 即可。
  var PF_TIMING = true;
  var __t0 = (new Date()).getTime(), __ms = [];
  function mark(nm) { if (PF_TIMING) __ms.push([nm, (new Date()).getTime() - __t0]); }
  try {
    // v10.0: 各卡门控开关(缺省全开 —— 旧调用点不传参时行为与 v9.9 逐字一致)
    var CK = {
      ab: pfCkOn(c1), hd: pfCkOn(c2), ft: pfCkOn(c3), im: pfCkOn(c4),
      rs: pfCkOn(c5), ik: pfCkOn(c6), ov: pfCkOn(c7),
      // v10.13: 卡⑧色板(第 9 参 —— 第 8 位是阈值串, 见 ckArgs/swArg)。
      //   ⚠ 缺省(旧 7 参/无参调用)按**关**处理 —— 与 zhiban 的缺省开不同: 印前承诺
      //   「旧调用点行为与旧版逐字一致」(v10.0), 缺省开会让老调用多跑一次全文档色板遍历;
      //   面板总是显式传 0/1, 不受影响。
      sw: pfCkOn(c9 === undefined ? 0 : c9),
      // v11.15: 卡⑨「空文本」(第 10 参)。同色板口径 —— 缺省关, 面板显式传 0/1。
      tx: pfCkOn(c10 === undefined ? 0 : c10),
      // v11.87: 卡⑨「专色描边」(第 11 参)。同前两项口径 —— 缺省关。
      //   面板显式传 1 时才会多付一趟全文档 bbox 收集 + 相邻判定。
      st: pfCkOn(c11 === undefined ? 0 : c11)
    };
    // v10.1: 先应用面板传来的阈值, 并立刻回传生效值 —— 前端只显示这个数,
    //   自己不留任何阈值数字。缺省(旧调用点 runPreflight())时 c8 为 undefined,
    //   pfThApply 会逐项回落 PF_TH_DEF ⇒ 与 v10.0 行为逐字一致。
    var TH = pfThApply(c8);
    res.th = TH;
    // v11.100(性能): 只在字体卡开时同步字体表。原先无条件调 —— 字体数变化时它要遍历
    //   app.textFonts 逐条读 name/family/style(常见 1800+ 个字体, 数千次属性读),
    //   而字体卡关着时这些数据一条都用不到。
    if (CK.ft) pfEnsureFonts();
    if (app.documents.length === 0) {
      res.error = "当前没有打开的文档，请先打开一个 AI 文件。";
      return pfReturn(res);
    }
    var doc = app.activeDocument;
    res.ok = true;
    // v11.81: 定位缓存重置 —— 必须在**任何扫描之前**。它同时充当"本轮各卡开关"的快照，
    //   定位端靠这份快照判断"这张卡这轮到底扫没扫过"（没扫过就回落旧路径重算）。
    pfLocCacheReset(doc, CK);
    // v11.82 起本打算"按轮清空"光栅图缓存, 理由是一张链接图可能在外部被换成高清版(路径不变),
    //   不清就会一直读到旧像素 ⇒ 分辨率偏低一直误报。但那个做法把代价压在了每次检查上:
    //   每轮都要把每张链接图**重新 open + 读 4KB**, 图挂网络盘时几十张就能拖出十几秒。
    // v11.100: 改成"路径 + 文件大小 + 修改时间"指纹校验(见 pfPxSize) ——
    //   换过图 ⇒ 指纹变 ⇒ 自动重读(与按轮清空等价); 没换 ⇒ 只做一次 stat, 不 open 不读内容。
    //   ⚠ 所以这里**不再清空** PF_PX_CACHE。
    // v11.81: 当前正在下钻的符号实例（null = 不在符号里）。入缓存时一律落在这个实例上 ——
    //   符号定义源里的对象不在画布上，塞进 selection 是原生层崩溃（见「扫描缓存」一节）。
    var curSym = null;
    // v11.39: 前置段兜底 —— 这三处是全函数唯一没有局部 try 的裸读
    //   (其余每一类扫描都有), 任一抛错就落到末尾的外层 catch ⇒ ok=false ⇒ 前端
    //   九张卡全部空白。损坏/非常规文档、切换文档的瞬时状态下真会遇到。
    //   策略: 单段失败只让"那一段的数据"降级, 其余卡片照常出结果, 并在 error 里留痕。
    try { res.docName = doc.name; } catch (eDN) { res.docName = "(文档名读取失败)"; }
    try { res.docPath = doc.path.fsName; } catch (e0) { res.docPath = "(文档尚未保存)"; }

    // ---------- 1. 画板尺寸 ----------
    var boards = [];
    var abRects = []; // 各画板 rect(v3.4: 供出血逐画板测量)
    var abBleed = []; // 各画板四向最大超出(pt) + 是否有内容
    var activeIdx = 0;
    try { activeIdx = doc.artboards.getActiveArtboardIndex(); } catch (e1) {}
    try {
      for (var i = 0; i < doc.artboards.length; i++) {
        var abObj = doc.artboards[i];
        var r = abObj.artboardRect; // [left, top, right, bottom] pt
        abRects.push(r);
        abBleed.push({ top: 0, bottom: 0, left: 0, right: 0, hasContent: false });
        var wMm = (r[2] - r[0]) * PT2MM;
        var hMm = (r[1] - r[3]) * PT2MM;
        boards.push({ name: abObj.name, w: pfRound(wMm), h: pfRound(hMm) });
      }
    } catch (eAB) {
      // 画板读不到: 保底给一条"(画板读取失败)" —— 别让卡① 显示 0 个画板却不解释
      abRects = []; abBleed = [];
      boards = [{ name: "(画板读取失败)", w: 0, h: 0 }];
    }
    res.artboards = boards;
    res.activeArtboard = activeIdx + 1;

    // ---------- 1b. 实际出血(实测) ----------
    // 注: 文档设置出血(documentBleedOffset)前端已不再展示,且 Adobe 脚本接口
    //     对已打开文档读取不可靠(官方确认的已知限制),v3.5 起不再读取,
    //     统一以"实际出血"(内容超出画板的实测值)为准。旧实现见 v3.3/v3.4 备份。
    var bleed = { supported: false, artboards: [] };

    // (B) 实际出血: 测量内容超出各画板边缘的最大距离(每画板独立,v3.4)
    //     v3.7 起测量在"图层→组→对象"树遍历中进行,不再依赖文档级扁平集合
    function measureItem(gb) {
      if (!gb || gb.length < 4) return;
      for (var bi = 0; bi < abRects.length; bi++) {
        var arB = abRects[bi], stB = abBleed[bi];
        if (gb[2] < arB[0] || gb[0] > arB[2] || gb[1] < arB[3] || gb[3] > arB[1]) continue; // 不重叠
        stB.hasContent = true;
        var oTop    = gb[1] - arB[1];
        var oBottom = arB[3] - gb[3];
        var oLeft   = arB[0] - gb[0];
        var oRight  = gb[2] - arB[2];
        if (oTop > stB.top) stB.top = oTop;
        if (oBottom > stB.bottom) stB.bottom = oBottom;
        if (oLeft > stB.left) stB.left = oLeft;
        if (oRight > stB.right) stB.right = oRight;
      }
    }

    // 出血测量(v3.7): 可见性由树遍历上下文保证——隐藏图层/隐藏组的子树根本
    // 不会到达这里,对象自身 hidden 已在 visitItem 排除,无需再沿 parent 链
    // 向上检查;bounds 先行做重叠预测试(纯算术),任一重叠才读 guides。
    function bleedOf(it, checkGuides) {
      if (!CK.ab) return; // v10.0: 卡①关 ⇒ 整段出血实测跳过(不再逐对象读 geometricBounds)
      var gb = null;
      try { gb = it.geometricBounds; } catch (ebg) { return; }
      if (!gb || gb.length < 4) return;
      var anyOverlap = false;
      for (var bq = 0; bq < abRects.length; bq++) {
        var aq = abRects[bq];
        if (!(gb[2] < aq[0] || gb[0] > aq[2] || gb[1] < aq[3] || gb[3] > aq[1])) { anyOverlap = true; break; }
      }
      if (!anyOverlap) return;
      if (checkGuides) { try { if (it.guides === true) return; } catch (eig) {} }
      measureItem(gb);
    }

    // ---------- 2. 色彩模式 ----------
    // v11.39: 裸读包 try —— 见上面前置段的说明
    try {
      res.colorMode = (doc.documentColorSpace === DocumentColorSpace.CMYK) ? "CMYK" : "RGB";
    } catch (eCS) { res.colorMode = "(未知)"; }

    mark("画板");

    // ---------- 2a. 色板(未使用色板统计) ----------
    // v10.13: 卡⑧「色板」(zhiban v0.7.8 状态移植) —— 统计"文档色板里有哪些没被使用",
    //   供前端显示数量。只在卡⑧开启时跑(关掉则一个色板属性都不读)。
    //   ⚠ 这里只统计**不修改** —— 真正删除走 pfClearUnusedSwatches()(按钮触发)。
    //   口径与删除动作严格一致(共用 pfUsedColorKeys / pfIsSystemSwatch),
    //   避免"说能删 5 个、点下去只删 3 个"这种前后不一致。
    var swatchInfo = null;
    if (CK.sw) {
      // 同卡附带"未使用渐变/未使用图案"统计 —— v10.28: pfUsedColorKeys 只调一次,
      //   结果同时喂给 pfSwatchScan(usedPre)/渐变/图案/颜色组, 消除同轮双调(审计疑似2)。
      var usedOnce = null, usedFailed = false;
      try {
        usedOnce = pfUsedColorKeys(doc);
        if (!usedOnce || usedOnce.incomplete) usedFailed = true;
      } catch (eUO) { usedOnce = null; usedFailed = true; }
      swatchInfo = pfSwatchScan(doc, usedOnce);
      // v11.39: 采集失败要说出来。原来 usedOnce=null 时 pfSwatchScan / 渐变 / 图案
      //   各自**再跑一遍**全文档遍历, 再失败就各自 catch 成 {0,0,0} —— 卡⑧ 显示"0 个色板 /
      //   没有未使用渐变", 和"文档真的很干净"完全同形, 用户无从分辨。挂一个失败位给前端换文案。
      if (usedFailed && swatchInfo) swatchInfo.usedFailed = true;
      res.swatch = swatchInfo;
      // 采集失败时不再跑渐变/图案 —— 它们只会再失败两次、再各自兜成 0, 纯浪费一次全文档遍历
      if (!usedFailed) {
        res.gradient = pfGradientScan(doc, usedOnce);
        res.pattern = pfPatternScan(doc, usedOnce);
        // v11.56: 任一类统计局部失败都让卡⑧进入"统计失败", 不能只报另外两类的绿字。
        if ((res.gradient && res.gradient.usedFailed) ||
            (res.pattern && res.pattern.usedFailed)) {
          swatchInfo.usedFailed = true;
        }
      }
      // 颜色组统计(读不到 swatchGroups 时 supported=false, 前端自动隐藏该行)
      //   v11.1(审查 ⑦): 不再传 usedOnce —— 该入参在函数内从未使用。
      res.swatchGroup = pfSwatchGroupScan(doc);
    }
    mark("色板");

    // ---------- 2a2. 清理(游离点 / 未上色 / 空文本) ----------
    // v11.15: 卡⑨ 起于"删空文本框"; v11.16(雪糕) 扩成一张「清理」卡 ——
    //   对照 Illustrator 自带「对象 > 路径 > 清理」的三个勾选项。
    //   只统计不修改; 真正删除走 pfCleanup(doStray, doUnpaint, doText)(卡片「一键清理」)。
    //   ⚠ 扫描与删除共用 pfJunkEach 同一套判定, 避免"报 N 删 M"。
    if (CK.tx) {
      res.cleanup = pfCleanupScan(doc, PF_LOC_SCAN ? PF_LOC_SCAN.c9 : null);
    }
    mark("清理");

    // ---------- 2a3. 专色描边(手工陷印) ----------
    // v11.87: 卡⑨「专色描边」—— 只统计"谁需要描边、谁已经有了", 供卡片出表。
    //   只读, 不动任何对象; 真正加描边走按钮 → pfSpotSelectAll() + pfSpotTrap(描边宽)。
    //   口径与执行端严格同源(共用 pfTrapCollect / pfNearPeer), 避免"说需加 5 个、
    //   点下去只处理 3 个"。单段兜底: 失败只让这张卡显示"未检查", 其余卡照常。
    if (CK.st) {
      try { res.spotTrap = pfSpotScan(doc); } catch (eST) { res.spotTrap = null; }
    }
    mark("专色");

    // ---------- 2a4. 对照层状态 ----------
    // v11.90: 卡⑩「对照」只需要一句"在不在 + 层里那张是什么样"。
    //   ⚠ 刻意**不**新增第 12 个位置参数: 判定只是"递归找一遍同名图层 + 读一张图元的
    //     opacity", 代价等同于零; 而 c1..c11 的位序是硬约束(阈值串夹在 c8), 能不占位就不占。
    //   ⚠ 它也不参与任何判定, 只是给卡片显示用, 所以不需要随卡片开关门控。
    try { res.snap = pfSnapScan(doc); } catch (eSN) { res.snap = null; }
    mark("对照");

    // ---------- 2b. 隐藏对象检查 ----------
    // v10.15: hiddenLayerItems = 隐藏图层内的对象数(含层内隐藏对象) —— 供前端判断
    //   「删除全部隐藏对象」按钮是否该显示(删除范围只含可见图层内的隐藏对象)。
    var hidden = { layerCount: 0, itemCount: 0, layerNames: [], truncated: false, hiddenLayerItems: 0 };
    // v8.1: 主遍历是否见过"隐藏节点"(隐藏图层/隐藏组/隐藏对象)。
    //   没见过 ⇒ 文档里不可能有隐藏文字 ⇒ 跳过下面那次文档级 textFrames 全量扫描。
    //   ⚠ 只在"确认没有隐藏内容"时为 false;任何读取异常都保守置 true(宁可多扫,不可漏报)。
    var sawHidden = false;

    // v10.32: 原先这里是独立的 checkLayerVisible() 递归(见旧注释), 把 doc.layers 整棵树
    //   又走了一遍 —— 而下面 walkLayer 本来就要走同一棵树。两次遍历读的是同一批
    //   layer.visible / layer.pageItems, 等于把"读图层可见性 + 读图层对象列表"这两笔
    //   跨桥开销**整份付了两遍**(大图层树文件的图层遍历成本直接翻倍)。
    //   现改为把隐藏图层统计**并进 walkLayer 的那一趟**: walkLayer 在判断
    //   `ly.visible === false` 的那个分支里顺手记 layerCount / layerNames / hiddenLayerItems。
    //   ⚠ 口径必须与旧 checkLayerVisible 逐字一致 —— 旧实现在**任意深度**上, 只要某层
    //     visible===false 就计 1 层、并把该层 pageItems.length 加进 hiddenLayerItems, 且
    //     **不管祖先层是否已隐藏**(子层的子层仍会被访问到)。
    //     walkLayer 的隐藏分支是 `return`(整棵子树剪枝) —— 所以合并版必须**在 return 之前**
    //     显式再走一遍"隐藏层下的子层", 否则"隐藏层套隐藏子层"会少计; 这正是旧行为与此前
    //     语义的差别所在, 现按旧口径补回(见 walkLayer 的 hLayer 分支)。
    //   ⚠ CK.hd(卡②关) 时旧实现整段跳过、hidden 全为 0; walkLayer 侧统计也必须同样门控,
    //     否则关卡后 hidden 计数会冒出来(与 v10.0 的"关卡即不统计"口径相悖)。

    // 把"隐藏图层"的账记上(含该层直接对象数)。祖先层已隐藏时子层仍要计入 —— 由
    // walkLayer 的 hLayer 分支负责把这棵子树继续走完(walkLayer 走完不会重复记可见层的对象)。
    function tallyHiddenLayer(ly) {
      hidden.layerCount++;
      try {
        // v10.43: 硬编码 5 → SAMPLE_CAP(与其余样本列表同一真源, v10.39 B6 同款)
        if (hidden.layerNames.length < SAMPLE_CAP) hidden.layerNames.push(ly.name || "(未命名图层)");
      // v10.33: catch 里也要判 < 5 —— 原先无条件 push, 若多个图层的
      //   name 都读抛异常, layerNames 会超过 5 个, 前端渲染出多余行(与其他层的"仅列前 5"不一致)。
      } catch (eHLN) { if (hidden.layerNames.length < SAMPLE_CAP) hidden.layerNames.push("(未命名图层)"); } // v10.43(P3-1): 同走 SAMPLE_CAP
      // v10.15: 统计隐藏图层内的对象数(含层内隐藏对象) —— 删除动作只删可见图层内的
      //   隐藏对象, 隐藏图层内容一律保留; 若可见图层内没有可删目标(itemCount===0),
      //   按钮就不该出现, 此处给出判据。
      try { hidden.hiddenLayerItems += ly.pageItems.length; } catch (ehli) {}
    }

    // 隐藏"对象"统计: v3.7 起随树遍历顺带统计(每类独立配额 underQuota),
    // 不再用文档级扁平集合;隐藏图层/隐藏组的子树整棵跳过,不再逐个读取。
    res.hidden = hidden;

    // ============================================================
    // 3~5. 树遍历引擎(v3.7): 图层→组→对象 一次递归走完
    // 取代旧版 8 个文档级扁平集合分别扫描的模式:
    //   ① 隐藏图层/隐藏组的整棵子树直接跳过,内部对象一个属性都不读
    //     (含大量隐藏图层/备用方案/历史版本的客户文件提速明显);
    //   ② 可见性沿树向下传递,不再逐对象沿 parent 链向上爬;
    //   ③ 每类对象独立扫描配额(underQuota),大文档统计不再偏科。
    // 口径修正(与旧版的差异):
    //   · 隐藏内容不计入油墨/字体/分辨率统计(不输出的内容不参与印刷);
    //   · 复合路径按 1 个对象统计油墨(取首组件色;旧版每个组件各计一次);
    //   · 隐藏图层上的文本框不计入文本总数与缺失字体检测。
    // 注: Layer.pageItems / GroupItem.pageItems 均只含直接子项(不穿透组),
    //     递归进组即可覆盖全部对象,不会重复访问;复合路径按整体处理,
    //     不下钻其组件 pathItems(组件会重复计色)。
    // ============================================================

    // ---------- 字体 + 油墨 数据结构 ----------
    var fonts = { totalText: 0, outlined: false, names: [], truncated: false, missingFonts: [], mixedFonts: 0 };
    // v5.15: 极小字号(<6pt)统计,样本带文字内容
    // v10.2: 只剩一档 —— <TINY_PT 即计入(标红)
    var tiny = { count: 0, samples: [] };
    var seen = {};

    // 油墨总量规则(v10.1, 阈值可调): total < INK_OK 无问题; INK_OK ~ INK_WARN 偏重(黄); > INK_WARN 超标(红)
    //   INK_OK / INK_WARN 已上提到模块级(阈值唯一真源), 由 pfThApply 按面板传入值覆盖
    // v6.2: 样本一律结构化,由前端拼装(便于按"问题类型"分组、加 [文字]/[图形] 标签、合并重复描边)
    //   badSamples/warnSamples: [{name, where, desc, total}]
    //   thinSamples: [{mm, name}]   light.samples: [{src, where, desc, name}]
    var black = {
      // v8.8: 两边的键必须**对称** —— 前端按 bt.mixed + bp.mixed 求和，path 侧少一个键
      //   就会算出 NaN、而 if(NaN) 恒假 ⇒ 卡6「混合色」静默不显示(自上线起从未生效)。
      //   other = 渐变/图案(无法用单一油墨总量描述)，单列以使分类计数与对象总数一致。
      text: { ok: 0, warn: 0, bad: 0, rgb: 0, spot: 0, mixed: 0, other: 0, warnSamples: [], badSamples: [] },
      path: { ok: 0, warn: 0, bad: 0, rgb: 0, spot: 0, mixed: 0, other: 0, warnSamples: [], badSamples: [], truncated: false,
              thin: 0, thinSamples: [] },   // 描边过细(仅图形)
      light: { count: 0, samples: [] },     // 色值极浅(文字+图形)
      // v11.91: 四色黑(每通道 >=80 且 累计 >=320, 见 pfRichBlackChk) —— 可一键转单黑的那批, 只统计数量。
      //   ⚠ 文字侧**只统计填充** —— 与油墨总量文字侧同口径(那边也只读 ca.fillColor),
      //     否则"四色黑 ⊄ 油墨超标", 卡上两个块会互相矛盾。
      //   图形侧填充/描边都算(与油墨总量图形侧同口径)。
      //   v11.92(雪糕): 不再收样本清单 —— 这批对象必然也在「油墨总量>300」那张表里
      //     (累计 >320 必然 >300), 同一个东西列两遍。只留 count。
      richBlack: { count: 0 },
      // v8.3: 叠印——文字(字符级) + 图形(pageItem 级) 共用一个池,count 为全量真值
      // v9.6: locked = 其中落在**锁定**对象/图层/锁定组里的处数(照常计入 count, 只多报一个数,
      //   供卡⑦ 提示"其中锁定 N 处, 勾选「解锁全部」可一并清除")。
      // v10.14: 四分类计数(k100 单黑 / spot 专色 / color 彩色)新增, white 沿用既有字段;
      //   旧前端(不认新键)零影响 —— 多出的键没人读就是了。
      // v10.35: 加 truncated —— 原先 path/compound 超配额只挂 black.path.truncated,
      //   而卡⑦叠印判定读的是 overprint.count。若前 3000 个 path 无叠印、第 3001 个有叠印后被
      //   配额截断 ⇒ count 停在 0、前端显示"无叠印"+绿徽标 —— **漏检却报通过**, 印刷上最危险。
      //   三处 underQuota 失败须同步把本字段置真(见下方 path/compound/text 分支)。
      // v11.56: whiteClass —— 分级版口径的"白"(CMYK 原值和 < 1), 与精确 0 的 white 分开记。
      overprint: { count: 0, white: 0, whiteClass: 0, k100: 0, spot: 0, color: 0, text: 0, path: 0, locked: 0, samples: [], truncated: false }
    };

    // 按阈值归类,并记录样本(v5.6/B2: 文字/路径各自独立)
    // v7.8: 样本改为"按不同色值收"—— 同值只占 1 条、n 累加全量次数(见 pfSampleAdd)
    // v7.9: 改为 top-5 —— 只留**油墨总量最高的 5 条**,并按总量从高到低排好
    // name: 文字片段或对象名(带引号,可为空); where: "填充"/"描边"
    function inkBucket(stat, cls, name, where) {
      if (cls.total >= 0) {
        var rec = { name: name || "", where: where || "填充", desc: cls.desc, total: cls.total };
        var scKey = cls.desc + "|" + rec.where + "|" + rec.name;
        if (cls.total > INK_WARN) {
          stat.bad++;
          pfSampleAddTop(stat.badSamples, rec, scKey, SAMPLE_CAP, "total", -1);
        } else if (cls.total >= INK_OK) {
          stat.warn++;
          pfSampleAddTop(stat.warnSamples, rec, scKey, SAMPLE_CAP, "total", -1);
        } else {
          stat.ok++;
        }
      } else if (cls.type === "rgb") {
        stat.rgb++;
      } else if (cls.type === "spot") {
        stat.spot++;
      } else if (cls.type === "mixed") {
        stat.mixed++;
      } else if (cls.type === "other") {
        stat.other++;   // v8.8: 渐变/图案 —— 不判油墨但也不丢，否则汇总行与对象数对不上
      }
    }

    // v8.3: 叠印采样——文字/图形共用一个池,按"来源+填充/描边+色值+名称"去重(同值 ×n)。
    //   与 light 池同款:count 是文档全量真值,SAMPLE_CAP 只截采样池条数。
    // v9.4: 参数由"已算好的 desc"改为**色对象** —— 一次 pfOvpInfo 同时拿到 desc 与 white,
    //   避免为判白再回读一遍颜色。样本多带一个 white 字段供前端使用(去重键不含它)。
    // v9.5: 第 5 参 item —— 命中时沿 parent 链判是否被**锁定**(Ctrl+2 / 锁定组 / 锁定图层),
    //   计入 locked。⚠只判不跳过: 锁定对象**照常统计**(与"隐藏不参与"的口径不同),
    //   前端据此提示"其中锁定 N 处,勾选解锁全部可一并清除"。
    //   ⚠这一判只在**命中叠印**时才跑(命中本就稀少),一次 parent 链走查对整体扫描无感。
    function pfOvpAdd(src, where, colorObj, name, item) {
      var info = pfOvpInfo(colorObj);
      // v10.14: 四分类(供分级版叠印卡展示与规则动作筛选)。
      //   ⚠ 与 zhiban 逐字同款: white 计数仍走 pfOvpInfo 的原口径(四色原值和===0 才算白),
      //   四分类走 pfOvpClass 的口径(和<1 也算白, 极小非零印出来照样花)——两口径并存,
      //   简洁版「白叠印 N 处」的数字与 v10.13 逐字一致, 零漂移。
      //   pfOvpAdd 只在叠印命中时才跑(本就稀少), 多一次 pfInkSum 读取对扫描无感。
      // v10.43: 改传 pfOvpClass2(colorObj, info) —— 复用 info 里已算过的
      //   pfInkSum 结果, 同一颜色不再读两遍(原 pfOvpClass 内部会再跑一次)。
      var cls = pfOvpClass2(colorObj, info);
      black.overprint.count++;
      if (info.white) black.overprint.white++;
      if (cls.cls === "white") black.overprint.whiteClass++;
      else if (cls.cls === "k100") black.overprint.k100++;
      else if (cls.cls === "spot") black.overprint.spot++;
      else if (cls.cls === "color") black.overprint.color++;
      if (src === "text") black.overprint.text++; else black.overprint.path++;
      if (item) {
        var blkO = null;
        try { blkO = pfBlockInfo(item); } catch (eBlkO) {}
        // v10.35: 改用 locked 布尔 —— 原判 `reason === "locked"` 会漏掉
        //   "同一节点既隐藏又锁定"的对象(那时 reason 报的是 hidden)。
        if (blkO && blkO.locked) black.overprint.locked++;
      }
      // v11.81: 卡⑦ 入缓存。⚠ 必须去重 —— 同一对象的填充与描边会各命中一次，
      //   不去重会让 doc.selection 里出现同一个对象两次（原生层报错）。
      if (PF_LOC_SCAN && item) pfLocPush(PF_LOC_SCAN.c7, curSym || item);
      pfSampleAdd(black.overprint.samples,
        { src: src, where: where, desc: info.desc, name: name, white: info.white, cls: cls.cls },
        src + "|" + where + "|" + info.desc + "|" + name, SAMPLE_CAP);
    }

    // v11.81: 第 2 参 owner = **要入缓存的对象本体**。
    //   复合路径调用点传的是 it.pathItems[0]（只用于判色），入池必须收复合路径本身 ——
    //   与 v11.49/v11.54 那条"判色下钻、收本体"同一个口径，别在缓存这里又破一次。
    function scanPathInk(pi, owner) {
      if (!CK.ik && !CK.ov) return; // v10.0: 卡⑥⑦都关 ⇒ 整个路径油墨扫描跳过(一个属性都不读)
      var bp = black.path;
      var nm = pfObjName(pi);
      // v11.82: 入缓存 / 判锁定的**本体**。复合路径调用点传进来的是 pathItems[0]（只用于判色），
      //   本体必须用它自己 ⇒ 下面 pfOvpAdd 的第 5 参一律传 ownRef，不能传 pi。
      //   ⚠ 不这么改的后果: 卡⑦ 池子里进的是组件, 定位时塞进 doc.selection 会崩(v11.48 同类雷)。
      var ownRef = owner || pi;
      // v11.81: 卡⑥ 四块的命中标记。只做布尔累加，**不额外读任何属性** ——
      //   用的就是下面本来就要算的 rfc / rsc / swMm。
      var lcO = false, lcH = false, lcL = false, lcT = false;
      // v8.5: stroked / fillColor / strokeColor 各读一次后复用 —— 原实现 stroked 读 3 次
      //   (油墨/细描边/极浅各一次)、两个色句柄各读 2 次;同一个色对象一次读出 ink+light。
      var stk = false;
      try { stk = (pi.stroked === true); } catch (e0) {}
      // v10.32: filled 也读一次 —— pfUsedColorKeys(删色板)那边只登记 filled===true 的对象
      //   填充色, 若这边不判 filled 直接读 fillColor, 对"未填充但有残留 fillColor 句柄"的
      //   路径会多记一个油墨对象 ⇒ 两侧口径不一致(雪糕反馈类问题)。
      //   ⚠ 判法必须是**只在明确为 false 时跳过**: `filled` 读不到(抛异常)或为 undefined
      //     (老 mock / 个别对象类型没有该属性)时一律**保守放行**照读 fillColor ——
      //     若反过来用 `=== true` 当门, 会把"没这个属性"的路径全部静默漏掉(实测踩中:
      //     mock 里 PathItem 不设 filled, 油墨计数直接归 0)。
      var fld = true;
      try { fld = (pi.filled !== false); } catch (eFld) { fld = true; }
      // v10.11: fc/sc 按需读取 —— 原先在入口无条件预读, ⑥关⑦开时白读(⑦只在叠印
      //   命中时才需要色值);口径对齐文字侧 v10.0 的"命中才补读"(pfOvpAdd 读不到
      //   会兜成不报, 与原行为一致)。
      var fc = null, sc = null;
      var rfc = null, rsc = null;
      if (CK.ik) { // v10.0: 卡⑥关 ⇒ 不读油墨/极浅
        if (fld) { try { fc = pi.fillColor; } catch (e1) {} }
        try { rfc = pfInkLightBoth(fc); } catch (e3) { rfc = null; }
        try { if (stk) { sc = pi.strokeColor; rsc = pfInkLightBoth(sc); } } catch (e4) { rsc = null; }
        // v11.81: 两个色各判一次卡⑥ 的四块 —— 判据与 inkBucket / pfLocInkAny 同源
        //   （total > INK_WARN 记超标；INK_OK ≤ total ≤ INK_WARN 记偏重；light 非空记极浅）。
        //   一个对象的填充与描边都命中同一块时只记一次 ⇒ 入池时天然不重复。
        if (rfc) {
          inkBucket(bp, rfc, nm, "填充");
          if (rfc.total >= 0) { if (rfc.total > INK_WARN) lcO = true; else if (rfc.total >= INK_OK) lcH = true; }
          if (rfc.light) lcL = true;
        }
        if (rsc) {
          inkBucket(bp, rsc, nm, "描边");
          if (rsc.total >= 0) { if (rsc.total > INK_WARN) lcO = true; else if (rsc.total >= INK_OK) lcH = true; }
          if (rsc.light) lcL = true;
        }
        // v11.91: 四色黑(图形侧填充/描边都算 —— 与上面两个 inkBucket 同口径)。
        //   v11.92: 只计数, 不再收样本(见 black.richBlack 注释)。
        if (rfc && pfRichBlackChk(fc)) black.richBlack.count++;
        if (rsc && pfRichBlackChk(sc)) black.richBlack.count++;
      }
      // v8.3: 叠印检查(图形侧,pageItem 级)——真机 28.0.0 上 PathItem 的这两个属性名尚未验证,
      //   读不到 / 抛异常由 pfOvp* 兜成 false(宁可不报,绝不误报);色值只在命中时才读,摊薄成本。
      // v8.6: 复用上面已读出的 fc / sc, 不再回读 pi.fillColor / pi.strokeColor
      if (CK.ov) { // v10.0: 卡⑦关 ⇒ 不读叠印布尔
        try {
          if (pfOvpFill(pi)) {
            if (!fc) { try { fc = pi.fillColor; } catch (e1b) {} } // v10.11: ⑥关时命中才补读
            pfOvpAdd("path", "填充", fc, nm, ownRef);
          }
        } catch (e8) {}
        try {
          if (pfOvpStroke(pi)) {
            if (!sc) { try { sc = pi.strokeColor; } catch (e2b) {} } // v10.11: 原 scO 补读改为统一兜底
            pfOvpAdd("path", "描边", sc, nm, ownRef);
          }
        } catch (e9) {}
      }
      // v6.2: 描边过细——已描边且实测宽 <0.1mm(0.005mm 容差,防恰好 0.1mm 误报)
      // v7.8: 同一"实测宽(2 位小数)"只占 1 条,n 累加全量次数(前端仍按 mm 合并显示 ×n)
      // v10.8: 收进 CK.ik 门 —— bp.thin 是卡⑥的内容, 原先只靠入口 return 挡住"⑥⑦全关",
      //        关⑥留⑦时仍会走到这里白读一遍 strokeWidth 并累加(只浪费、不误报, 但不该发生)
      if (CK.ik) { try {
        if (stk) {
          var swMm = pi.strokeWidth * PT2MM;
          if (swMm >= 0 && swMm < THIN_STROKE_MM - 0.005) {
            bp.thin++;
            lcT = true;   // v11.81: 同上，只是布尔累加
            var swR = Math.round(swMm * 100) / 100;
            pfSampleAdd(bp.thinSamples, { mm: swR, name: nm }, String(swR), SAMPLE_CAP);
          }
        }
      } catch (e6) {} }
      // v6.2: 色值极浅——填充/描边任一为 CMYK 且某分量四舍五入后 0<值<5
      // v8.5: 复用上面一次读出的 light,不再回读色值
      // v10.11: 收进 CK.ik 门 —— black.light 是卡⑥的内容(文字侧本就在门内);
      //   与 v10.8 的 thin 同款: 此前靠"rfc/rsc=null 隐式兜"不炸, 一旦赋值挪出
      //   CK.ik 门(如给叠印复用)就会变成关⑥还在算卡⑥, 显式门控不留雷。
      if (CK.ik) { try {
        if (rfc && rfc.light) {
          black.light.count++;
          pfSampleAdd(black.light.samples,
            { src: "path", where: "填充", desc: rfc.light, name: nm }, rfc.light + "|填充|" + nm + "|path", SAMPLE_CAP);
        }
        if (rsc && rsc.light) {
          black.light.count++;
          pfSampleAdd(black.light.samples,
            { src: "path", where: "描边", desc: rsc.light, name: nm }, rsc.light + "|描边|" + nm + "|path", SAMPLE_CAP);
        }
      } catch (e7) {} }
      // v11.81: 卡⑥ 入缓存。这里用裸 push 而非 pfLocPush ——
      //   上面把填充/描边两个来源合并进同一组布尔，同一对象在同一个池子里最多进一次。
      //   ⚠ own 必须是**本体**（复合路径不是它的 pathItems[0]），且符号下钻期间换成实例。
      if (PF_LOC_SCAN && CK.ik && (lcO || lcH || lcL || lcT)) {
        var own = curSym || owner || pi;
        if (lcO) PF_LOC_SCAN.c6.over.push(own);
        if (lcH) PF_LOC_SCAN.c6.heavy.push(own);
        if (lcL) PF_LOC_SCAN.c6.light.push(own);
        if (lcT) PF_LOC_SCAN.c6.thin.push(own);
      }
    }

    // ---------- 图片嵌入 + 分辨率 数据结构 ----------
    // v5.7: 计数改为树遍历统计(只含可见图),与下面的清单、分辨率口径一致。
    // 旧版取文档级 pls.length / ris.length(含隐藏图),会出现"链接图片 3 张"
    // 但清单只列 1 张的数字对不上的情况。
    // v5.9: 文档级 placedItems 变量自 v5.7 起已无任何引用(死代码),删除,
    // 省掉每次检查一次跨桥调用;文档级集合只保留 rasterItems,
    // 仅用于 XMP 文件名解析(ris)的必要判断。
    // v11.21(外审 #13): 卡⑤关着时不必读这一笔 —— ris 只服务 XMP 名称解析(已门控 CK.rs)
    // v11.39: 裸读包 try, 失败退成空数组(名称解析会落到顺序兜底), 不牵连整轮扫描
    var ris = [];
    if (CK.rs) { try { ris = doc.rasterItems; } catch (eRI) { ris = []; } }
    // v8.1: linkedAll/linkedHidden 移出本对象 —— 改由 pfLinkScope() 在点"嵌入"时按需统计,
    //   不再每轮检查都扫一遍文档级 placedItems(见文件末尾 pfLinkScope)
    var imgs = { linked: [], linkedCount: 0, embeddedCount: 0, missingCount: 0, truncated: false };

    // v4.8: Symbol 内部扫描统计(符号内可能含未转曲文字/低清图/油墨超标,
    // 旧版直接跳过导致漏检;下钻定义源后其内部对象进入统一树遍历)
    var symbols = { count: 0, scanned: 0, truncated: false };

    // 有效 PPI = 72 / 矩阵基向量模长(与旋转/斜切角度无关)
    // v10.1: RESO_MIN 上提到模块级(阈值唯一真源), 这里不再重复声明
    var reso = { total: 0, lowCount: 0, okCount: 0, unknownCount: 0, samples: [], truncated: false };

    // v11.41: 实现已提到全局 pfPpiOf(定位功能要复用同一份判据, 不能出现两套 ppi 算法)。
    //   这里只留 alias, 调用点(resoCheck / 主扫描)一字未改。
    //   两条历史结论随实现一起搬走, 别丢:
    //     · 模长与旋转/斜切无关(旧实现只看 A/D 分量, 旋转45°会把 212ppi 高估成 ~300 ⇒ 漏检)
    //     · 返回**原值**不取整(提前 Math.round 会让 299.6ppi 被当成 300 判达标)
    // v11.50: 链接图改走 pfPpiReal(读文件像素), 嵌入图仍走 pfPpiOf(矩阵)
    function ppiOf(item) { return pfPpiReal(item); }

    function resoCheck(item, label) {
      if (!CK.rs) return; // v10.0: 卡⑤关 ⇒ 不读图片矩阵、不做 ppi 判定
      var ppi = ppiOf(item);
      // v11.56: 读不到分辨率不再静默丢弃 —— 计入 total/unknownCount, 让面板能报"未完成"。
      //   旧实现直接 return ⇒ 一张都测不出时 total=0, 面板会绿标"无位图/全部达标"。
      reso.total++;
      if (!(ppi >= 0) || !isFinite(ppi)) { reso.unknownCount++; return; }
      // v11.46: 阈值比较统一走 pfResoLow(带容差, 与定位端同一个函数)
      if (pfResoLow(ppi)) {
        reso.lowCount++;
        // v11.81: 卡⑤ 入缓存。判据与定位端同源（都用 pfResoLow，带 1% 容差）。
        if (PF_LOC_SCAN) pfLocPush(PF_LOC_SCAN.c5, curSym || item);
        // v5.19: 15→8; v6.5: →5(列表统一"仅列前 5")
        // v7.9: 只留**分辨率最低的 5 张**,并按 ppi 从低到高排好(原来取的是文档里最先遇到的 5 张)
        //   这里用递增序号做 key ⇒ 不去重(每张图各占一条;同图重复置入也各自可见)
        // v10.39: 硬编码 5 → SAMPLE_CAP(= PF_TH_DEF.cap)。数字本来就相等, 但这里
        //   该跟"唯一真源"走 —— 将来 cap 改了, 分辨率列表不会掉队。
        pfSampleAddTop(reso.samples, { name: label, ppi: ppi }, "r" + reso.total, SAMPLE_CAP, "ppi", 1);
      } else {
        reso.okCount++;
      }
    }

    // 通用: 取图片名称(name → file.name → 兜底)
    function imgName(item, fallback) {
      try { if (item.name && item.name !== "") return item.name; } catch (e) {}
      try { var f = item.file; if (f && f.name && f.name !== "") return f.name; } catch (e) {}
      return fallback;
    }

    // 从 XMP 元数据提取"嵌入"类型图片的文件名(嵌入位图 name/file 属性为空,只能从 XMP 取)
    // XMP manifest 中每个条目有 stMfs:linkForm(EmbedByReference=链接 / EmbedByValue=嵌入) 和 stRef:filePath
    function xmpEmbeddedNames() {
      var names = [];
      try {
        var xs = doc.XMPString;
        if (!xs) return names;
        var forms = [], paths = [], m;
        var reF = /<stMfs:linkForm>([^<]*)<\/stMfs:linkForm>/g;
        var reP = /<stRef:filePath>([^<]*)<\/stRef:filePath>/g;
        while ((m = reF.exec(xs)) !== null) forms.push(m[1]);
        while ((m = reP.exec(xs)) !== null) paths.push(m[1]);
        for (var i = 0; i < forms.length && i < paths.length; i++) {
          if (forms[i] === "EmbedByValue") {
            var p = paths[i];
            var nm = p;
            var ix = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
            if (ix >= 0) nm = p.substring(ix + 1);
            names.push(nm);
          }
        }
      } catch (ex) {}
      return names;
    }

    // 无位图时跳过 XMP 解析(XMP 文本可能很大,解析开销高)
    // v10.43: 再加 CK.rs 门控 —— xmpEmbNames 只服务卡⑤的 resoCheck 标签
    //   (卡⑤关时 resoCheck 首行即 return, embName 的结果被立即丢弃), CK.im 不消费它。
    //   两卡都关时白读一次 doc.XMPString 跨桥, 纯浪费。
    var xmpEmbNames = (CK.rs && ris.length > 0) ? xmpEmbeddedNames() : [];
    var xmpSeq = 0;      // 顺序兜底指针
    var rasterIdx = 0;   // 已处理的嵌入位图计数
    var placedIdx = 0;   // 已处理的链接图计数
    // v10.46: 可见嵌入位图 -> XMP 白名单条目的锚表。
    //   原实现 `xmpEmbNames.length === ris.length` 才按索引精确对应 —— ris 是文档级
    //   **全集**(含隐藏位图), 而调用处传的 rasterIdx 只数**可见**的; 文档含隐藏位图时
    //   该条件恒不成立, 于是全部挤到顺序兜底(xmpSeq 也按可见顺序推进) —— 隐藏位图
    //   在白名单里占着条目却进不了可见序列 ⇒ 可见位图的名字整体前移一位(错配)。
    //   现在按 ris 全集顺序数嵌入位图, 只给**可见**的登记它对应的白名单序号,
    //   隐藏位图占的条目被自然跳过; XMP 解析失败(白名单空)时锚表为空, 退顺序兜底。
    var embAnchor = [];
    if (xmpEmbNames.length > 0) {
      try {
        var embK = 0;
        for (var fi = 0; fi < ris.length; fi++) {
          var fIt = ris[fi], fVis = true;
          // v11.39: 原来用 `!pfBlockInfo(fIt)` 判"可见" —— 但 pfBlockInfo 在
          //   **仅锁定**时也返回非 null, 而主扫描的 visitItem 根本不看 locked ⇒ 锁定的嵌入
          //   位图照常 rasterIdx++, 锚表却不登记 ⇒ 之后所有位图名字统一错一位
          //   (正是 v10.46 P2-5 要修的那种错配; 锁底图是很常见的做法)。
          //   这里只该关心"隐藏": 用 v10.35 新增的聚合位 bi.hidden。
          try { var fBi = pfBlockInfo(fIt); fVis = !(fBi && fBi.hidden); } catch (eFi) { fVis = true; }
          if (fVis) embAnchor.push(embK);
          embK++;
        }
      } catch (eAn) { embAnchor = []; }
    }
    function embName(item, idx, fallback) {
      var n = imgName(item, "");
      if (n !== "") return n;
      if (idx < embAnchor.length && embAnchor[idx] < xmpEmbNames.length) return xmpEmbNames[embAnchor[idx]];
      if (xmpSeq < xmpEmbNames.length) return xmpEmbNames[xmpSeq++];
      return fallback;
    }

    // ---------- 每类对象独立扫描配额(v3.6/v3.7) ----------
    // 防大文件卡死;每类各自最多 MAX_SCAN 个,统计不再因扫描顺序偏科。
    // 注: 超配额由各调用方挂对应类别自己的 truncated(不再统一挂 hidden,
    //      v4.8 修复: 原先任何类超限都会误置 hidden.truncated,导致隐藏对象
    //      卡错误显示"仅扫描前 3000 个")。
    var scanTicks = {};
    function underQuota(cat) {
      var n = scanTicks[cat] || 0;
      if (n >= MAX_SCAN) return false;
      scanTicks[cat] = n + 1;
      return true;
    }

    // ---------- 树遍历 ----------
    // v11.81: 隐藏子树「只收引用」的收集器 —— 见文件末尾「扫描缓存」一节第 ① 条。
    //   检查端对隐藏内容一律跳过（隐藏内容不参与印刷统计，这是 v4.8 以来的口径），
    //   但定位端必须能找到它们，否则"问题对象都在隐藏图层里"时会回报"没找到可定位的对象"，
    //   而那恰恰是用户最需要看到的那句话。⇒ 这里只读 typename + 存引用，**不判任何色值/叠印/分辨率**。
    //   ⚠ 遇到符号实例直接置 hidCut：它自身没有色值/叠印/分辨率属性，必须下钻定义源才判得出，
    //     而定义源对象不能进 selection —— 这条路整个交回旧路径（pfLocGather 会下钻并收实例）。
    function pfLocHidGather(container, depth) {
      if (!PF_LOC_SCAN || depth > PF_MAX_DEPTH) return;
      var kids = null;
      try { kids = container.pageItems; } catch (eHG) { PF_LOC_SCAN.hidCut = true; return; }
      if (!kids) return;
      var lim = 0;
      try { lim = kids.length; } catch (eHL) { PF_LOC_SCAN.hidCut = true; return; }
      for (var i = 0; i < lim; i++) {
        var k = null;
        try { k = kids[i]; } catch (eHK) { continue; }
        if (!k) continue;
        var tn = "";
        try { tn = k.typename; } catch (eHT2) { continue; }
        if (tn === "GroupItem") { pfLocHidGather(k, depth + 1); continue; }
        if (tn === "SymbolItem") { PF_LOC_SCAN.hidCut = true; return; }
        if (tn === "PathItem" || tn === "CompoundPathItem" || tn === "TextFrame" ||
            tn === "RasterItem" || tn === "PlacedItem") {
          if (PF_LOC_HID_N >= PF_LOC_HID_MAX) { PF_LOC_SCAN.hidCut = true; return; }
          PF_LOC_HID_N++;
          PF_LOC_SCAN.hid.push(k);
        }
      }
    }

    // 单个对象: 按 typename 分派(可见性已由 walkLayer 的图层过滤保证,
    // 无需再传 vis 标志 —— v4.8 清理死参数)
    // v10.0: 第三参 skipBleed —— 组级剪枝命中后向整棵子树传递"跳过出血测量"
    //   (只跳出血, 其余检查照常), 缺省 undefined = 不跳过。
    function visitItem(it, depth, skipBleed) {
      if (depth > PF_MAX_DEPTH) return; // 防异常深嵌套导致栈溢出(超过深度放弃下钻)
      var tn = "";
      // v10.46: typename 都读不到时**不敢断言无隐藏** —— 与其余读取失败点
      //   (walkLayer 的 eLv/eLs/eLi、组的 eGk)一并置 sawHidden=true 同口径。
      //   漏置的后果: CK.ft 开时整段隐藏文字补扫被跳过, 而隐藏文字扫描本不依赖树遍历成功。
      try { tn = it.typename; } catch (eT) { sawHidden = true; return; }

      // 组: 隐藏组整棵子树跳过;可见组继续下钻
      if (tn === "GroupItem") {
        var gHidden = false;
        try { gHidden = (it.hidden === true); } catch (eGv) {}
        if (gHidden) {
          sawHidden = true;   // v8.1: 见到隐藏组 ⇒ 内部可能有隐藏文字
          if (CK.hd) {        // v10.0: 卡②关 ⇒ 不计数(但 hidden 判定必须保留, 否则隐藏组会被当可见内容检查)
            if (underQuota("group")) hidden.itemCount++;
            else hidden.truncated = true; // v4.8: 隐藏组超配额只挂 hidden 自己的截断
          }
          // v11.81: 组内对象收进隐藏池（只存引用，判据留给定位端）—— 见「扫描缓存」第 ① 条
          if (PF_LOC_SCAN) pfLocHidGather(it, 0);
          return;
        }
        // v8.6: 组级出血测量改为"只在子项读不出来时兜底" —— 原来无条件先测一次, 而组的
        //   geometricBounds 是纯几何量(**含隐藏子项**): 可见组里若有隐藏子项越界, 组级测量
        //   会把它的超出算进出血(measureItem 每边取 max) ⇒ 可能**漏报出血不足**, 与"隐藏
        //   内容不参与印刷统计"的口径相悖。可见子项本就各自测过(取 max, 天然幂等) ⇒ 正常
        //   路径上组级测量既冗余又有害; 只有读不到子项时它才是唯一测量, 那时才该兜。
        // v10.0(移植自分支 v8.7.2): 出血组级剪枝 —— 组 geometricBounds 是子项 bounds 的
        //   并集(**含隐藏子项**,故恒 ⊇ 任一可见子项)。若组 bounds 完整落在某个画板内、
        //   且与其他画板均不相交, 则每个可见子项也必然完整落在该画板内 ⇒ 四向超出量恒 ≤0、
        //   不会刷新任何极值; 唯一会被写入的状态是该画板的 hasContent —— 这里直接补写,
        //   结果与逐子项测量完全一致。收益: 组内成千上万个路径不再逐个读 geometricBounds
        //   (AI 要逐段算贝塞尔包围盒, 是本面板最大的单项耗时)。
        //   ⚠ 剪枝**只跳出血测量**, 组内字体/油墨/分辨率检查照常下钻。
        var childSkip = (skipBleed === true);
        try {
          var kids = it.pageItems;
          var kLim = kids.length; // v10.0: 长度外提(剪枝条件与循环条件原来各重读一轮)
          if (!childSkip && CK.ab && kLim > 0) {
            try {
              var ggb = it.geometricBounds;
              if (ggb && ggb.length === 4) {
                var inA = -1, canPrune = true;
                for (var gbi = 0; gbi < abRects.length; gbi++) {
                  var gr = abRects[gbi];
                  if (ggb[0] >= gr[0] && ggb[2] <= gr[2] && ggb[1] <= gr[1] && ggb[3] >= gr[3]) {
                    if (inA === -1) inA = gbi; // 完整落入该画板
                  } else if (!(ggb[2] < gr[0] || ggb[0] > gr[2] || ggb[1] < gr[3] || ggb[3] > gr[1])) {
                    canPrune = false; // 与某画板部分相交(可能跨界) ⇒ 子项必须逐个测
                    break;
                  }
                }
                if (canPrune && inA !== -1) {
                  childSkip = true;
                  for (var gh = 0; gh < abRects.length; gh++) {
                    var ghr = abRects[gh];
                    if (ggb[0] >= ghr[0] && ggb[2] <= ghr[2] && ggb[1] <= ghr[1] && ggb[3] >= ghr[3])
                      abBleed[gh].hasContent = true; // 复刻"子项落在画板内"必写的 hasContent
                  }
                }
              }
            } catch (eGg) {}
          }
          for (var k = 0; k < kLim; k++) visitItem(kids[k], depth + 1, childSkip);
        } catch (eGk) {
          sawHidden = true;   // v8.1: 组内读不到 ⇒ 不敢断言"无隐藏"
          if (!childSkip) bleedOf(it, false); // v5.25 兜底;v10.0 已剪枝的组 bounds 必在画板内,无需兜底
        }
        return;
      }

      // 对象自身隐藏(Ctrl+3)
      var selfHidden = false;
      try { selfHidden = (it.hidden === true); } catch (eH) {}

      var cat = "";
      if (tn === "TextFrame") cat = "text";
      else if (tn === "PathItem") cat = "path";
      else if (tn === "CompoundPathItem") cat = "compound";
      else if (tn === "MeshItem") cat = "mesh";
      else if (tn === "SymbolItem") cat = "symbol";
      else if (tn === "RasterItem") cat = "raster";
      else if (tn === "PlacedItem") cat = "placed";
      if (cat === "") return;

      // 隐藏对象统计(每类独立配额);隐藏内容不输出 → 跳过一切印刷相关检查
      if (selfHidden) {
        sawHidden = true;   // v8.1: 见到隐藏对象(可能是隐藏文本框) ⇒ 需保留隐藏文字扫描
        if (CK.hd) {        // v10.0: 卡②关 ⇒ 不计数(hidden 判定保留: 隐藏内容不参与一切印刷检查)
          if (underQuota(cat)) hidden.itemCount++;
          else hidden.truncated = true; // v5.6/B1: 超配额也必须挂截断标记,否则隐藏数被低估且界面无提示
        }
        // v11.81: 收进隐藏池（只存引用，不判色/叠印/分辨率）。符号实例、网格对象都不收 ——
        //   前者要靠下钻定义源才判得出（见 pfLocHidGather 说明），后者与本功能无关。
        if (PF_LOC_SCAN) {
          if (tn === "SymbolItem") PF_LOC_SCAN.hidCut = true;
          else if (tn === "PathItem" || tn === "CompoundPathItem" || tn === "TextFrame" ||
                   tn === "RasterItem" || tn === "PlacedItem") {
            if (PF_LOC_HID_N >= PF_LOC_HID_MAX) PF_LOC_SCAN.hidCut = true;
            else { PF_LOC_HID_N++; PF_LOC_SCAN.hid.push(it); }
          }
        }
        return;
      }

      if (tn === "TextFrame") {
        if (!skipBleed) bleedOf(it, false); // v5.25 出血先于配额;v10.0 剪枝子树跳过出血
        // v4.8: 配额检查前置,totalText 只统计实际扫描数(原在配额前++,超限仍虚增)
        if (!underQuota("text")) { fonts.truncated = true; black.overprint.truncated = true; return; } // v10.35: 叠印同步挂截断; v11.60: 溢出同步
        if (CK.ft) fonts.totalText++; // v10.0: 卡③关 ⇒ 不计文本总数
        // v8.5: characterAttributes 只解析一次 —— 原实现每步都重新解析
        //   textRange.characterAttributes(字体名 / 字号 / 填充色给油墨 / 填充色给极浅 / 叠印 共 5 遍),
        //   同一帧要付 5 次链解析的跨桥成本;现在一次取回 ca 全程复用。
        // v10.0: 卡③(字体) ⑥(油墨) ⑦(叠印) 全关 ⇒ 连 characterAttributes 都不解析
        var ca = null;
        if (CK.ft || CK.ik || CK.ov) {
          try { ca = it.textRange.characterAttributes; } catch (eCa) { ca = null; }
        }
        // v8.6: 片段只取一次 —— pfSnippet 是一次跨桥读(contents)+正则
        // v10.0: 且只在有卡真的要用它时才取(卡③极小字号样本 / ⑥油墨样本 / ⑦叠印样本)
        // v10.32: 再改为**惰性取值** —— 上面那句"卡开着就取"仍会在"极小字号没命中 /
        //   油墨桶不落样本 / 叠印没命中"时白读一次 contents(contents 是跨桥读, 且长文本
        //   帧的字符串传输不便宜)。改成命中才真取: 四处使用点都已在"确实要用"的分支里,
        //   首次调用即取、之后复用, 语义与"取一次"完全等价, 只是不再无条件先付钱。
        var snip = null;
        function getSnip() {
          if (snip === null) snip = pfSnippet(it);
          return snip;
        }
        if (CK.ft) {
          var fn = "";
          try { fn = ca.textFont.name; }
          catch (e3) {
            // v8.8: 混合字体帧(或字体名读不出)无法判缺。旧实现在这里整帧放行、一声不响，
            //   而"一帧里已装字体 + 缺失字体混排"是最常见的真实漏报场景 ⇒ 至少计数上报。
            fn = "(混合字体)";
            fonts.mixedFonts++;
          }
          if (fn && !seen[fn]) { seen[fn] = true; fonts.names.push(fn); }
          // v5.15: 极小字号检测(混合字号帧读 size 会抛异常,跳过不误报)
          try {
            var fsz = ca.size;
            if (typeof fsz === "number" && isFinite(fsz) && fsz > 0 && fsz < TINY_PT) {
              tiny.count++;
              if (tiny.samples.length < SAMPLE_CAP) tiny.samples.push({ t: getSnip(), pt: pfRound(fsz) }); // v10.43(P3-1): 硬编码 5 → SAMPLE_CAP
            }
          } catch (eSz) {}
        }
        var rtx = null, fcTx = null;
        if (CK.ik) {
          // v8.5: 填充色一次读出"油墨总量 + 极浅";ca 解析失败或混合色仍按旧口径记 mixed。
          if (!ca) { rtx = { total: -1, type: "mixed", desc: "混合颜色" }; }
          else {
            try { fcTx = ca.fillColor; } catch (eFc) { fcTx = null; }
            try { rtx = pfInkLightBoth(fcTx); } catch (eTi) { rtx = { total: -1, type: "mixed", desc: "混合颜色" }; }
          }
          if (rtx) inkBucket(black.text, rtx, getSnip(), "填充");
          // v11.91: 四色黑(文字侧填充)
          if (fcTx && pfRichBlackChk(fcTx)) black.richBlack.count++;
          // v12.12(雪糕: "文字描边也判断可以么"): 文字描边同判。
          //   原来只判填充, 但文字一样可以带四色黑描边, 转单黑时那圈描边也该一起转,
          //   否则"报 N 转不到 N"。读法与 fillColor 完全一致(characterAttributes),
          //   混合属性读不到就当没有 —— 宁可不报, 不可误报。
          var scTx = null;
          try { scTx = ca.strokeColor; } catch (eScT) { scTx = null; }
          if (scTx && pfRichBlackChk(scTx)) black.richBlack.count++;
          // v11.81: 卡⑥ 入缓存（文字侧只判填充色 —— 与定位端 match 的文字口径一致，
          //   描边与"描边<0.1mm"块文字永不参与）。阈值同源：total > INK_WARN / ≥ INK_OK。
          if (PF_LOC_SCAN && rtx) {
            var ownT = curSym || it;
            if (rtx.total >= 0) {
              if (rtx.total > INK_WARN) PF_LOC_SCAN.c6.over.push(ownT);
              else if (rtx.total >= INK_OK) PF_LOC_SCAN.c6.heavy.push(ownT);
            }
            if (rtx.light) PF_LOC_SCAN.c6.light.push(ownT);
          }
          // v6.2: 色值极浅(文字填充色);v7.8: 按不同色值收,n 累加全量次数
          if (rtx && rtx.light) {
            black.light.count++;
            var ltfName = getSnip();
            pfSampleAdd(black.light.samples,
              { src: "text", where: "填充", desc: rtx.light, name: ltfName },
              rtx.light + "|填充|" + ltfName + "|text", SAMPLE_CAP);
          }
        }
        if (CK.ov) {
          // v8.3: 叠印检查(文字侧)——**只能走字符级**,真机 28.0.0 上 TextFrame 没有
          //   pageItem 级 fillOverprint/strokeOverprint(探针 v1 实测为"缺失")。
          //   v10.0: 卡⑥关时上面的 fcTx 尚未读出, 这里补读一次(仅叠印命中才用到)。
          if (!CK.ik && ca) { try { fcTx = ca.fillColor; } catch (eFc2) { fcTx = null; } }
          try {
            var ovf = pfCharOvpFill(ca), ovs = pfCharOvpStroke(ca);
            if (ovf || ovs) {
              if (ovf) pfOvpAdd("text", "填充", fcTx, getSnip(), it);
              if (ovs) {
                // v8.6: 描边色只在真的命中叠印描边时才读(多数帧不描边, 这一读可省)
                var scTx = null; try { scTx = ca.strokeColor; } catch (eSc) {}
                pfOvpAdd("text", "描边", scTx, getSnip(), it);
              }
            }
          } catch (eOvp) {}
        }
        return;
      }
      if (tn === "PathItem") {
        if (!skipBleed) bleedOf(it, true);  // v5.25 出血先于配额;v10.0 剪枝子树跳过出血
        if (!underQuota("path")) { black.path.truncated = true; black.overprint.truncated = true; return; } // v10.35: 叠印同步挂截断
        scanPathInk(it);
        return;
      }
      if (tn === "CompoundPathItem") {
        if (!skipBleed) bleedOf(it, true);  // v5.25 出血先于配额;v10.0 剪枝子树跳过出血
        if (!underQuota("compound")) { black.path.truncated = true; black.overprint.truncated = true; return; } // v10.35: 同上
        // ⚠ v11.82: 第 2 参**必须**传它自己 —— 见 scanPathInk 第 2 参说明。
        //   漏传 ⇒ 入池的成了 pathItems[0] 这个组件; 而组件不是可选中对象,
        //   塞进 doc.selection 与 v11.48 同类(原生层崩, try/catch 接不住)。
        try { scanPathInk(it.pathItems[0], it); } catch (eC) {}
        // ⚠ v10.53(审查 A2, **待真机验证再动**): 复合路径的叠印口径目前**三处不一致** ——
        //   ① 这里(检查端)只读 pathItems[0] 这一个组件;
        //   ② 动作侧文档级循环(doc.compoundPathItems)把 CompoundPathItem 自身交给
        //      pfClrPath/pfRulePath —— 若该类型不暴露 fillOverprint/strokeOverprint,
        //      pfOvp* 的 try 兜底会让那一路**静默无效**(不报错, 也不清任何东西);
        //   ③ 符号下钻内(pfClrOvpIn / pfRuleInSym)又逐个组件处理。
        //   谁与 AI 真机的"叠印属性到底挂在复合路径还是各组件上"一致, 只能真机验证后统一;
        //   盲改会把"已清除 N 处"变成新的对不上账(数字与卡⑦ 不一致)。
        return;
      }
      if (tn === "MeshItem") {
        if (!skipBleed) bleedOf(it, false); // v5.25 出血先于配额;v10.0 剪枝子树跳过出血
        // v8.8: 网格对象只测出血、本来就没有自己的统计桶 ⇒ 这里没有可标记的 truncated，
        //   配额只起限速作用(与 SymbolItem 不同，那边是真把数字少算了)。
        underQuota("mesh");
        return;
      }
      if (tn === "SymbolItem") {
        if (!skipBleed) bleedOf(it, false); // v5.25 出血先于配额;v10.0 剪枝子树跳过出血
        // v8.8: 计数移到配额判断**之前** —— 原顺序在超配额后连"符号 N 个"这个数字本身
        //   也停止累加，面板数字被静默少算且无任何提示。配额只该截断"下钻扫描"。
        symbols.count++;
        // v11.39: 符号超配额也要同步挂上 text/path/overprint 的 truncated。
        //   path/compound/text 三处早就加了(v10.35 审查 #4 的结论), 唯独符号这条漏了 ⇒
        //   符号实例 >3000 且叠印只存在于符号定义内时, 卡⑦ 会是 count=0 + 绿标"无叠印"。
        //   而前端 main.js 正是靠 ovp.truncated 才不敢下"无叠印"结论 —— 等于绕过那道保险。
        if (!underQuota("symbol")) { symbols.truncated = true; fonts.truncated = true; black.path.truncated = true; black.overprint.truncated = true; return; }
        // v4.8: 下钻 Symbol 定义源,扫描内部对象(缺失字体/分辨率/油墨等)
        // 多个实例引用同一符号时会重复扫描(与"实际输出内容"口径一致);
        // 定义源不可访问时静默跳过,仅统计数量
        try {
          var symSrc = pfSymSource(it);   // v11.39: 与动作侧共用同一份下钻
          if (symSrc && symSrc.pageItems) {
            var symKids = symSrc.pageItems;
            var skLim = symKids.length; // v10.0: 长度外提
            // v11.81: 下钻期间记住**当前实例** —— 定义源里的对象不在画布上，
            //   入缓存必须换成实例（否则把定义源对象塞进 selection 是原生层崩溃）。
            //   ⚠ 出错也要复原 curSym，否则后续对象会被错记到这个实例上。
            var symPrev = curSym;
            curSym = it;
            try {
              for (var sk = 0; sk < skLim; sk++) visitItem(symKids[sk], depth + 1);
            } catch (eSK) { curSym = symPrev; throw eSK; }
            curSym = symPrev;
            symbols.scanned++;
          }
        } catch (eSym) {}
        return;
      }
      if (tn === "RasterItem") {
        if (!skipBleed) bleedOf(it, false); // v5.25 出血先于配额;v10.0 剪枝子树跳过出血
        if (!underQuota("raster")) { reso.truncated = true; imgs.truncated = true; return; }
        imgs.embeddedCount++; // v5.7: 只统计可见的嵌入位图
        var embLb = embName(it, rasterIdx, "(嵌入位图" + (rasterIdx + 1) + ")");
        resoCheck(it, embLb);
        rasterIdx++;
        return;
      }
      // PlacedItem
      if (!skipBleed) bleedOf(it, false); // v5.25 出血先于配额;v10.0 剪枝子树跳过出血
      if (!underQuota("placed")) { reso.truncated = true; imgs.truncated = true; return; }
      var lkMissing = false;
      var fp = "";
      if (CK.im) { // v10.0: 卡④关 ⇒ 不读 file.exists、不进清单
        imgs.linkedCount++; // v5.7: 只统计可见的链接图(隐藏链接图不参与印刷,不计入)
        // v5.15: 源文件存在性——被移动/改名/未随包拷贝的链接 AI 输出时会用
        // 低清预览替代;仅 file.exists 明确为 false 才计缺失,读不到不算
        try { lkMissing = (it.file.exists === false); } catch (eEx2) {}
        if (lkMissing) imgs.missingCount++;
      }
      // 文件路径只读一次: 前 5 个用于展示(v6.5: 50→5),同时取扩展名判断位图/矢量
      // v10.0: 卡④⑤都关 ⇒ 连路径都不读
      if (CK.im || CK.rs) { try { fp = String(it.file.fsName); } catch (e11) {} }
      if (CK.im && imgs.linked.length < SAMPLE_CAP) { // v10.43(P3-1): 硬编码 5 → SAMPLE_CAP
        // v10.10: it.name 包错 —— 这是全文件最后一处未包 try/catch 的属性读;
        //   单张链接图读名字失败不该拖垮整轮扫描(外层 catch 会把 res.ok 打成 false)。
        var nmB = "";
        try { nmB = String(it.name || ""); } catch (eNm) {}
        imgs.linked.push({ name: nmB || "(链接图)", file: fp || "(无法读取路径)", missing: lkMissing });
      }
      // 矢量链接(PDF/AI/EPS/SVG)没有有效分辨率: identity 矩阵会被算成
      // 72ppi 而误报"低于300ppi", 只跳过已知矢量(v3.6)。
      // v10.8: 位图"白名单"反转为矢量"跳过表" —— 原先名单外的扩展名(如 webp/psb/heic)会被
      //   静默跳过不查, 而扩展名读不到(空串)反而照查, 两边松紧不一致; 反转后除已知矢量外
      //   一律检查(宁多查、不漏查, 与"空串照查"同一方向)。
      var extB = "";
      var dotB = fp.lastIndexOf(".");
      if (dotB >= 0) extB = fp.substring(dotB + 1).toLowerCase();
      var isVec = (extB === "ai" || extB === "ait" || extB === "pdf" || extB === "eps" ||
                   extB === "svg" || extB === "svgz");
      if (CK.rs && !isVec) { // v10.0: 卡⑤关 ⇒ 不去读 item.name/file 拼标签
        resoCheck(it, imgName(it, "(链接图" + (placedIdx + 1) + ")"));
      }
      placedIdx++;
    }

    // 图层: 隐藏图层整层子树跳过(0 次对象读取);可见层先下钻子图层再遍历对象
    // v10.32: **同时承担隐藏图层统计**(合并自原 checkLayerVisible 的第二趟遍历)。
    function walkLayer(ly, depth) {
      if (depth > PF_MAX_DEPTH) return;
      // v11.90: 对照层整支跳过 —— 它是满版 300ppi 栅格, 扫进去会让卡④多一张"嵌入位图"、
      //   卡①读它的边界(空画板凭空有出血)、卡⑥/⑧ 把它的填充色收进"在用色"。
      //   放在**最前面**(连 hidden 分支都不进): 对照层不计入"隐藏图层"统计。
      if (pfIsAuxLayer(ly)) return;
      var hLayer = false;
      try { hLayer = (ly.visible === false); } catch (eLv) { sawHidden = true; return; }
      if (hLayer) {
        sawHidden = true;
        // v10.0: 卡②关 ⇒ 不计 hidden(与旧 checkLayerVisible 的 CK.hd 门控一致)
        if (CK.hd) tallyHiddenLayer(ly);
        // ⚠ 旧 checkLayerVisible 是"逐层独立判" —— 隐藏层**下面**的子层照样会被访问,
        //   若子层也隐藏, 那子层同样各计 1 层。这里必须把这棵子树继续走完(只统计、
        //   不遍历对象), 否则"隐藏层套隐藏子层"会相对旧口径少计 layerCount /
        //   hiddenLayerItems。⚠ 子树里的可见子层**不统计**(它本身不是隐藏层), 但其下
        //   若有隐藏层仍需计入 —— 故一律递归下探, 不做可见性剪枝。
        if (CK.hd) {
          try {
            var hSubs = ly.layers;
            var hLim = hSubs.length; // v10.0: 长度外提
            for (var hi = 0; hi < hLim; hi++) walkLayerHidden(hSubs[hi], depth + 1);
          } catch (eLsH) {}
        }
        return;
      }
      try {
        var subs = ly.layers;
        var sLim = subs.length; // v10.0: 长度外提
        for (var si = 0; si < sLim; si++) walkLayer(subs[si], depth + 1);
      } catch (eLs) { sawHidden = true; }   // v8.1: 子图层读不到 ⇒ 不敢断言"无隐藏"
      try {
        var items = ly.pageItems;
        var iLim = items.length; // v10.0: 长度外提
        for (var ii = 0; ii < iLim; ii++) visitItem(items[ii], 0);
      } catch (eLi) { sawHidden = true; }   // v8.1: 对象列表读不到 ⇒ 同上
    }

    // v10.32: 隐藏层子树专用下探 —— 只统计隐藏层、**不遍历对象、不做任何检查**
    //   (隐藏层内容本就不参与一切印刷检查)。与 walkLayer 的区别仅"不读 pageItems 内容"。
    function walkLayerHidden(ly, depth) {
      if (depth > PF_MAX_DEPTH) return;
      var hh = false;
      try { hh = (ly.visible === false); } catch (eLv2) { return; }
      // v10.33: 补 CK.hd 门控 —— 当前唯一调用点本就在 CK.hd 分支内,
      //   行为不变; 这里加上是防御: 将来若在别处调它统计别的量, 不会绕过"卡②关即不统计"的口径。
      if (hh && CK.hd) tallyHiddenLayer(ly);
      try {
        var hs = ly.layers;
        var hsLim = hs.length; // v10.0: 长度外提
        for (var hsi = 0; hsi < hsLim; hsi++) walkLayerHidden(hs[hsi], depth + 1);
      } catch (eLs2) {}
    }
    try {
      var topLayers = doc.layers;
      var tLim = topLayers.length; // v10.0: 长度外提
      for (var liW = 0; liW < tLim; liW++) walkLayer(topLayers[liW], 0);
    } catch (eW) { sawHidden = true; }      // v8.1: 顶层图层读不到 ⇒ 同上

    mark("遍历");   // 主扫描(字体/油墨/图片/出血都在这一趟里)

    // ---------- v5.21: 隐藏文字统计 ----------
    // 树遍历跳过隐藏子树(提速优化),隐藏文字因此不进 totalText/缺失检测;
    // 这里用 doc.textFrames 文档级全集(含隐藏层/隐藏对象/锁定,符号内文字不在
    // 其中)单独补一遍: 隐藏帧计数,字体名并入涉及字体与缺失检测。
    // 封顶 500 帧(诊断性质,大文档不再往下数,挂 truncated);
    // 可见性判定复用一键转曲的 pfBlockInfo(沿 parent 链找 hidden 节点)。
    var hiddenText = { count: 0, missingCount: 0, truncated: false, cap: PF_TH_DEF.htCap };
    // v8.1: 前置门控 —— 主遍历只要遇到过一个隐藏节点(隐藏图层/隐藏组/隐藏对象),
    //   才可能存在"隐藏文字";一个都没遇到时隐藏文字必然为 0,于是这次"文档级 textFrames
    //   全量扫描(封顶 500 帧,每帧还都要沿 parent 链判可见性)"可以整段跳过。
    //   ⚠ 只要有任何读取异常都置 sawHidden=true,宁可多扫不多漏(见 walkLayer/visitItem)。
    if (sawHidden && CK.ft) { // v10.0: 卡③关 ⇒ 隐藏文字(字体)补扫整段跳过
      try {
        var dtfsAll = doc.textFrames;
        // v10.39: 封顶值改读 PF_TH_DEF.htCap —— 与前端"仅统计前 N 个"同一真源
        var capHT = dtfsAll.length > PF_TH_DEF.htCap ? PF_TH_DEF.htCap : dtfsAll.length;
        for (var ht = 0; ht < capHT; ht++) {
          var tfH = dtfsAll[ht];
          var visH = true;
          try {
            var blkH = pfBlockInfo(tfH);
            // v11.39: 用聚合位 hidden, 不再看 reason。
            //   reason 只是**首个**命中原因: 文字帧自身锁定(Ctrl+2) + 祖先组隐藏时
            //   reason === "locked", visH 仍为 true ⇒ 该帧既不计隐藏文字、字体名也不登记。
            //   v10.35 加 hidden 这个聚合位就是为了这种情况。
            if (blkH && blkH.hidden) visH = false;
          } catch (eBkH) {}
          if (visH) continue;
          hiddenText.count++;
          var fnH = "";
          try { fnH = tfH.textRange.characterAttributes.textFont.name; } catch (eFnH) { fnH = ""; }
          if (fnH && fnH !== "(混合字体)") {
            if (!seen[fnH]) { seen[fnH] = true; fonts.names.push(fnH); }
            // v11.21(外审 #11): 补门控 —— 字体表整体不可用时 pfIsFontMissing 对任何名字
            //   都会 return true(表里没有 ⇒ 判缺失), 隐藏文字这一路原先没门控, 会造成
            //   「缺字体 N 个」但清单空白(主检测那段是门控跳过、不给结论)。现与主检测同口径。
            if ((__pfProbeOn || __pfSysFontsReady) && pfIsFontMissing(fnH)) hiddenText.missingCount++;
          }
        }
        if (dtfsAll.length > capHT) hiddenText.truncated = true;
      } catch (eHT) {}
    }

    // ---------- 扫描后处理: 缺失字体 / 结果挂载 ----------
    // 检测缺失字体: 与系统字体表对比(表已缓存于全局 __pfSysFonts,跨检查复用)
    try {
      var missMap = {};
      // v8.5: 门控改为"探测已启用 或 全表快照可用" —— 按需探测模式不建全表,
      //   旧门控(__pfSysFontsReady)会恒为 false ⇒ 缺失检测会整体失效。
      if (__pfProbeOn || (typeof __pfSysFontsReady !== "undefined" && __pfSysFontsReady)) {
        for (var mfi = 0; mfi < fonts.names.length; mfi++) {
          var n = fonts.names[mfi];
          if (n && n !== "(混合字体)" && pfIsFontMissing(n)) missMap[n] = true;
        }
      }
      for (var mk in missMap) fonts.missingFonts.push(mk);
      fonts.missingFonts.sort(); // v5.6/B4: 固定字母序,同一文档每次检查列表顺序一致
    } catch (eMiss) {}
    // v5.16: v5.10~v5.12 的诊断量(res.fontDiag/文档级扫描/命中明细)已随根因
    // 确诊(占位条目)整体移除,检查耗时回到 v5.9 水平;占位条目过滤(pfIsFontMissing)保留。
    fonts.outlined = (fonts.totalText === 0);
    res.fonts = fonts;
    res.black = black;
    // v8.1: 链接图范围统计已移出主流程 —— 旧版这里每轮都跑一次 pfCountAllLinks(doc)
    //       (全文档 placedItems 遍历 + 逐项沿 parent 链判隐藏),但它只服务"一键嵌入"的
    //       确认框,用户极少点。现改为点"嵌入"时按需调用 pfLinkScope()(见文件末尾)。
    res.images = imgs;
    res.resolution = reso;
    res.symbols = symbols;
    res.tiny = tiny; // v5.15: 极小字号统计
    res.hiddenText = hiddenText; // v5.21: 隐藏文字统计

    // 实际出血汇总: 每个画板独立判定;v4.2 起空画板也判定(按 0 出血计入"不足")
    // v4.5 起四边全判: 每条边的实测出血独立检查,任一边 <3mm 即列入不足清单。
    // 内容未贴到的边出血按 0 计(内容没超出画板边缘就没有出血)——例如画板只有
    // 左上角贴到、右下角留白,右下 0mm 也会报,不再因为"贴到的边达标"而整体放行。
    bleed.supported = true;
    for (var bs = 0; bs < abBleed.length; bs++) {
      var stB = abBleed[bs];
      var shortEdges = [];
      // 收集不足边: 实测出血 < 3mm(含 v4.1 的 0.05mm 容差,防 8.5pt=2.9986mm 误报)
      var pushShort = function (edge, pt) {
        if (pt * PT2MM < BLEED_MIN_MM - 0.05) shortEdges.push({ edge: edge, mm: pfRound(pt * PT2MM) });
      };
      if (stB.hasContent) {
        pushShort("上", stB.top);
        pushShort("下", stB.bottom);
        pushShort("左", stB.left);
        pushShort("右", stB.right);
      } else {
        // v4.2: 空画板四方向出血为 0,全部不足
        shortEdges = [{ edge: "上", mm: 0 }, { edge: "下", mm: 0 }, { edge: "左", mm: 0 }, { edge: "右", mm: 0 }];
      }
      var isInsufficient = shortEdges.length > 0;
      // 最差边(兜底展示用): 不足边中数值最小的一条
      var worstEdge = "";
      var worstMm = Infinity;
      for (var we = 0; we < shortEdges.length; we++) {
        if (shortEdges[we].mm < worstMm) { worstMm = shortEdges[we].mm; worstEdge = shortEdges[we].edge; }
      }
      var minPt = Math.min(stB.top, stB.bottom, stB.left, stB.right); // 四边最小(pt)
      bleed.artboards.push({
        name: boards[bs].name,
        top: pfRound(stB.top * PT2MM), bottom: pfRound(stB.bottom * PT2MM),
        left: pfRound(stB.left * PT2MM), right: pfRound(stB.right * PT2MM),
        minMm: pfRound(minPt * PT2MM),
        hasContent: stB.hasContent,
        worstEdge: worstEdge,
        shortEdges: shortEdges,   // v4.5: 该画板所有 <3mm 的边 [{edge, mm}]
        insufficient: isInsufficient
      });
    }
    res.bleed = bleed;

    // v11.81: 扫描完整走完才给定位缓存盖章。中途抛错落到下面的外层 catch 时,
    //   缓存是半成品(某些卡没扫完) —— 拿它定位会漏对象、回报的数字偏小,
    //   不如让定位端回落旧路径重算一遍。
    if (PF_LOC_SCAN) { try { PF_LOC_SCAN.ready = true; } catch (eLcR) {} }
    mark("后处理");
    if (PF_TIMING) res.ms = __ms;

    return pfReturn(res);
  } catch (err) {
    res.ok = false;
    res.error = "检查过程出错: " + String(err);
    try { res.ms = __ms; } catch (eMS) {}
    return pfReturn(res);
  }
}

// 系统保留色板名(永不删除)
// ⚠ v0.2 修复(真机 bug): 名字随 Illustrator 界面语言变化 —— 中文版返回的是
//   「[无]/[套版色]/[黑色]/[纸色]」, 英文版才是 [None]/[Registration]/[Black]/[White]。
//   v0.1 只认英文名 ⇒ 中文 AI 下系统四项一个都没匹配上, 全被当成"未使用"列进删除清单。
//   现改为**中英双名 + 类型判定**三保险:
//     ① 名字白名单(中英各一套)
//     ② Registration 类型判定(套版色有 !swatchType 或 swatchType === "REGISTRATION")
//     ③ 保留规律: 系统四项目录固定排在最前 4 个(index 0..3), 用下标兜底
//   ⚠ 下标兜底只在前面已按名字/类型判定过、且位置确实落在前 4 时才用 —— 不盲信下标。
var PF_SYS_NAMES = {
  "[None]": 1, "[无]": 1,
  "[Registration]": 1, "[套版色]": 1,
  "[Black]": 1, "[黑色]": 1, "[黑]": 1,
  "[White]": 1, "[纸色]": 1, "[白色]": 1
};

function pfIsSystemSwatch(sw, idx) {
  // ① 名字白名单(中英双名)
  try { if (PF_SYS_NAMES[sw.name]) return true; } catch (e0) {}
  // ② 类型判定: 套版色在所有语言下都是 REGISTRATION
  try {
    var st = sw.swatchType;
    // SwatchType.REGISTRATION == 3 (但不同版本枚举值可能不同, 故同时认字符串)
    if (st !== undefined && st !== null) {
      if (String(st) === "3" || String(st).toUpperCase() === "REGISTRATION") return true;
    }
  } catch (e1) {}
  // ③ 下标兜底: 系统四项恒为前 4 个 —— 名字读失败时仍能保住
  if (idx !== undefined && idx !== null && idx < 4) return true;
  return false;
}

// 颜色 -> 归一化键(色值匹配用; 专色走名字, 单列)
// ⚠ v0.2 修复(真机 bug): 原用 pfRound()(一位小数)**精确相等**做键 ——
//   色板里的 C15 M100 Y90 K10 与对象上的同色, 只要浮点尾数差 0.0001,
//   拼出的键就不同 ⇒ 在用色板被判成"未使用"。
//   ⇒ 不再用字符串键, 改成"分解分量 + 容差比较"(pfColorParts / pfColorSameParts)。
//   v11.73: 已删除失去调用者的 pfColorKey(字符串键) 与 pfColorSame(每次都重新分解两侧),
//     两者都被 pfColorParts / pfColorSameParts 取代, 留着只会让人以为还在用。

// 把颜色拆成可比较的分量对象(供容差匹配用)
//   返回 { t:"cmyk"|"rgb"|"gray", v:[...] } 或 null
function pfColorParts(c) {
  if (!c) return null;
  var t = "";
  try { t = c.typename; } catch (e) { return null; }
  try {
    if (t === "CMYKColor") return { t: "cmyk", v: [c.cyan, c.magenta, c.yellow, c.black] };
    if (t === "RGBColor") return { t: "rgb", v: [c.red, c.green, c.blue] };
    if (t === "GrayColor") return { t: "gray", v: [c.gray] };
  } catch (e2) { return null; }
  return null;
}

// 两个颜色是否"相同"(容差 EPS: 各分量差 <= EPS)
//   v0.2: 真机上色板色与对象色可能有微小浮点差, 精确相等会漏判 ⇒ 改用容差。
var PF_COLOR_EPS = 0.5;   // 分量容差(0~100 制), 0.5 足以吸收浮点噪声又不误判相邻色
// v11.39: 颜色收集上限提到常量 —— 原先判定处写死两次(1831/1836)、
//   两句拒绝删除的文案里又各写死一次(2056/2223), 改一处必漏三处。
//   文案改成拼接本常量, 五处从此同一真源。
var PF_COLOR_CAP = 4000;

// 左侧已分解版的"颜色相同"判定 —— 供 pfSwatchUsed 的 usedColors 循环
//   复用同一份分解结果。色板色是固定的, 不这样做的话 N 次比对就要白解析 N 遍。
//   v11.73: 原 pfColorSame(a, b) 已随调用者一起删除(它每次对两侧现分解, 只剩这里这一种用法)。
function pfColorSameParts(pa, b) {
  if (!pa) return false;
  var pb = pfColorParts(b);
  if (!pb) return false;
  if (pa.t !== pb.t) return false;
  if (pa.v.length !== pb.v.length) return false;
  for (var i = 0; i < pa.v.length; i++) {
    if (Math.abs(pa.v[i] - pb.v[i]) > PF_COLOR_EPS) return false;
  }
  return true;
}

// 色板 -> 判断"是否在用"
//   v0.2 重构: 由"键字符串精确相等"改为 **名字集合 + 颜色容差列表** 双路判定。
//     ① 专色: 色板名 或 spot.name 命中 usedNames 即算在用
//     ② 印刷色(CMYK/RGB/Gray): 与 usedColors 里任一颜色"容差相同"即算在用
//   原因(真机 bug): 原实现的 pfRound 精确键在浮点尾数差异下漏判, 导致在用色板被列进删除清单。
function pfSwatchUsed(sw, usedNames, usedColors) {
  try { if (pfIsSystemSwatch(sw)) return true; } catch (eS) {}
  var nm = "";
  try { nm = sw.name; } catch (e0) { return true; }   // 读不到名字: 保守当在用(不误删)
  var tn = "";
  try { tn = sw.color.typename; } catch (e1) {}
  // ① 专色: 名字匹配
  if (tn === "SpotColor") {
    if (usedNames["SPOTNAME:" + nm]) return true;
    try {
      var sn = sw.color.spot && sw.color.spot.name;
      if (sn && usedNames["SPOTNAME:" + sn]) return true;
    } catch (e2) {}
    return false;
  }
  // 图案色: 按名字(与 pfUsedColorKeys ④ 的登记一致)
  if (tn === "PatternColor") {
    try {
      var pn = sw.color.pattern && sw.color.pattern.name;
      if (pn && usedNames["PATT:" + pn]) return true;
    } catch (e3) {}
    return false;
  }
  // 渐变/其它: 名字兜底(无法安全按色值判)
  if (tn !== "CMYKColor" && tn !== "RGBColor" && tn !== "GrayColor") return true;
  // ② 印刷色: 容差匹配颜色列表
  var sc = null;
  try { sc = sw.color; } catch (e4) { return true; }
  // v10.43: 分解结果外提到循环外 —— sw.color 是固定的, 原实现每次循环
  //   都重新分解一遍, usedColors 有几百个时就白解析几百遍。
  var paSc = null;
  try { paSc = pfColorParts(sc); } catch (e5) { paSc = null; }
  // v11.56: 色值解析失败必须**保守当在用**。旧实现返回 false(未使用), 在损坏文档或
  //   宿主瞬时异常时会把仍在使用的色板直接送进 remove()。
  if (!paSc) return true;
  for (var i = 0; i < usedColors.length; i++) {
    if (pfColorSameParts(paSc, usedColors[i])) return true;
  }
  return false;
}

// 收集整个文档"实际被使用"的东西 —— 含隐藏/锁定(见上方口径说明)
//   返回 { names: {key:1}, colors: [颜色对象...] }
//   v0.2 重构: 颜色改为**列表**而非字符串键 —— 供容差匹配用。
//   v0.2 同时补全遍历盲区(真机 bug): 原实现只走 PathItem 的填充/描边, 漏掉:
//     - CompoundPathItem 自身的填充/描边(原代码下钻 pathItems, 但复合路径的**整体**色在其自身)
//     - GroupItem 的填充(**组可带填色**, 是 AI 里极常见的用法)
//     - RasterItem / PlacedItem(位图对象的填充/描边属性同样存在)
//     - TextFrame 段落级颜色(characterAttributes 之外, 整帧默认色)
//     - 符号实例(路径经 symbol 引用, 其颜色需另行展开)
//   一律 try/catch 包住, 读不到的属性跳过(宁可少收、不可抛错中断整轮扫描)。
//   v0.5 扩展(雪糕需求): 由"只判色板"升级为"颜色 + 渐变 + 图案"三类共用一套收集。
//     新增登记: GRAD:<name>(被对象引用的渐变)、PATT:<name>(被对象引用的图案)。
//     ⚠ 旧 v0.2 把图案"整类按在用放行"是**保守兜底**(当时图案内部色无法可靠遍历);
//       本次改为**精确认定** —— 只有真正被对象引用的图案才算在用, 未被引用者可删。
function pfUsedColorKeys(doc) {
  var names = {};      // 专色名(SPOTNAME:) / 图案引用(PATT:) / 渐变引用(GRAD:)
  var colors = [];     // 印刷色对象列表(容差匹配用)
  var colorSeen = 0;   // 已登记的**不同色值**数(去重后), 防列表爆炸(大文档)
  // v11.1(审查 ④): 颜色去重键表 —— 原来 colorSeen 数的是"对象个数"且不去重:
  //   一张图里 5000 个对象都用同一个 K100, 旧写法会在第 4001 个对象上就把
  //   colorTruncated 置真 ⇒ 色板删除动作整体拒绝执行, 而实际上全文只用到 1 种颜色。
  //   文案写的是"颜色超过 4000 种", 与行为(对象超过 4000 个)不符, 属于误报。
  //   现在按**完全相同的色值**去重(键用原始分量拼, 不做四舍五入):
  //     ⚠ 不能用量化键(Math.round 到整数): 两个色值四舍五入后同键但实际
  //       相差近 1.0, 而判定容差只有 0.5 —— 去重会误删"能匹配上色板"的那一个,
  //       反而制造误删。用原始分量拼键, 只有真·同色才合并, 匹配语义零变化。
  //   顺带收益: colors 从"对象数"降到"不同色数", pfSwatchUsed 的容差循环随之变短
  //   (60 色板 × 4000 条 → 60 色板 × 几十条)。
  var colorKeys = {};
  // v11.56: 采集不完整标记。任一关键颜色读取/遍历失败都置真, 删除动作据此整体拒绝。
  //   旧实现只在整个文档"一个颜色都没收到"时拦, 局部失败仍继续删 ⇒ 可能误删。
  var incomplete = false;
  function markIncomplete() { incomplete = true; }
  // v0.5.2: 成功遍历到的**顶层对象数**(不含子层下钻的重复计数)。
  //   用途: 区分"真·空文档/空画板"(objCount=0) 与"遍历出错"(有对象却一个色都收不到)。
  //   空画板时该值为 0 ⇒ 安全闸放行(本就该删掉所有非系统色板);
  //   有对象却 0 色 ⇒ 判定异常, 拒绝删除(保住原安全闸意图)。
  var objCount = 0;
  // v10.28: 颜色收集触顶标志(4000 上限) —— 触顶时删除动作拒绝执行,
  //   防止"没收集到的颜色对应色板被误判为未使用"而误删(审计疑似4)。
  //   v11.1: 上限的计量单位由"对象数"改为"不同色值数"(见上 colorKeys)。
  var colorTruncated = false;

  // v0.5: 按名字登记一个渐变/图案引用(供"未使用渐变/图案"判定)
  function markGradRef(g) {
    try { if (g && g.name) names["GRAD:" + g.name] = 1; else markIncomplete(); }
    catch (eGR) { markIncomplete(); }
  }
  function markPattRef(p) {
    try { if (p && p.name) names["PATT:" + p.name] = 1; else markIncomplete(); }
    catch (ePR) { markIncomplete(); }
  }

  function mark(c) {
    if (!c) return;
    var t = "";
    try { t = c.typename; } catch (e) { markIncomplete(); return; }
    if (t === "SpotColor") {
      try { if (c.spot && c.spot.name) names["SPOTNAME:" + c.spot.name] = 1; else markIncomplete(); }
      catch (eSP) { markIncomplete(); }
      return;
    }
    if (t === "PatternColor") {
      // v0.5: 图案色被对象引用 ⇒ 该图案在用(记 PATT:name)
      try { markPattRef(c.pattern); } catch (ePT) { markIncomplete(); }
      return;
    }
    if (t === "GradientColor") {
      // v0.5: 渐变被对象引用 ⇒ 该渐变在用(记 GRAD:name)
      try { markGradRef(c.gradient); } catch (eGD0) { markIncomplete(); }
      // 渐变: 展开色标(色标里的专色/印刷色都要保住)
      try {
        var stops = c.gradient.gradientStops;
        for (var s = 0; s < stops.length; s++) { try { mark(stops[s].color); } catch (eGs) { markIncomplete(); } }
      } catch (eG) { markIncomplete(); }
      return;
    }
    if (t === "CMYKColor" || t === "RGBColor" || t === "GrayColor") {
      // v11.1(审查 ④): 先按原始分量拼键去重(键取不到时退回"逐对象登记", 宁多不少)
      var ck = "";
      try {
        if (t === "CMYKColor") ck = "C" + c.cyan + "," + c.magenta + "," + c.yellow + "," + c.black;
        else if (t === "RGBColor") ck = "R" + c.red + "," + c.green + "," + c.blue;
        else ck = "G" + c.gray;
      } catch (eCK) { ck = ""; }
      if (ck !== "") {
        if (colorKeys[ck]) return;                       // 完全同色: 已在列表里, 不重复登记
        if (colorSeen >= PF_COLOR_CAP) { colorTruncated = true; return; }
        colorKeys[ck] = 1;
        colorSeen++;
        colors.push(c);
      } else {
        // v11.56: 分量读不出来时仍登记对象兜底, 同时标记采集不完整(禁止删除)。
        markIncomplete();
        if (colorSeen < PF_COLOR_CAP) { colors.push(c); colorSeen++; } else { colorTruncated = true; }
      }
      return;
    }
    // NoColor / 其它: 不需要登记
  }

  // v11.56: 文字颜色按**字符属性区间**采集, 避免混合文字/局部专色被整帧读取失败吞掉。
  //   读取失败一律 markIncomplete —— 宁可本轮不删色板, 也不能猜"未使用"。
  function collectTextColors(tf) {
    var tr = null;
    try { tr = tf.textRange; } catch (eTr) { markIncomplete(); return; }
    var ranges = null;
    try { ranges = tf.textRanges; } catch (eRanges) { ranges = null; }
    if (ranges && typeof ranges.length === "number" && ranges.length > 0) {
      var got = 0;
      for (var ri = 0; ri < ranges.length; ri++) {
        try {
          var rca = ranges[ri].characterAttributes;
          mark(rca.fillColor); mark(rca.strokeColor);
          got++;
        } catch (eRca) { markIncomplete(); }
      }
      if (got > 0) return;
    }
    // 兼容没有 textRanges 的旧宿主 / 空文本: 退回整帧属性。
    try {
      var ca = tr.characterAttributes;
      mark(ca.fillColor); mark(ca.strokeColor);
    } catch (eCa) { markIncomplete(); }
  }

  // 逐对象收色: 覆盖 PathItem / CompoundPathItem / GroupItem / RasterItem / PlacedItem
  function collectItem(it, depth, countTop) {
    // v10.60: 深度上限 20 -> 64, 与主扫描(visitItem / walkLayer / walkLayerHidden)
    //   同档。旧值 20 会让"第 21 层以上组内的颜色"登记不到 ⇒ 仍在用的色板可能被判
    //   "未使用"而误删(主扫描那边却统计得到 ⇒ 两侧对不上账)。统一 64 后同深同查。
    if (depth > PF_MAX_DEPTH) { markIncomplete(); return; }
    var tn = "";
    try { tn = it.typename; } catch (eT) { markIncomplete(); return; }
    // v11.1: 这些类型理论上都带填充/描边; 只有它们读取失败才算"采集不完整",
    //   避免插件对象等本来就没有颜色属性的类型把删除动作永久锁死。
    var colorCapable = (tn === "PathItem" || tn === "CompoundPathItem" || tn === "GroupItem" ||
                        tn === "RasterItem" || tn === "PlacedItem" || tn === "TextFrame" ||
                        tn === "MeshItem");
    // v0.5.2: 只统计"顶层"对象(画板/图层直接持有的), 子层下钻不重复计数
    if (countTop) objCount++;

    // 填充 / 描边(这些属性对 Path/CompoundPath/Group/Raster/Placed 大多可用)
    // v10.33: filled 口径与 scanPathInk 统一为 `!== false` ——
    //   原先要求 `=== true`, 对 filled 读不到(=undefined)的对象**不登记**其填充色;
    //   而 scanPathInk 那边是"只排除明确 false"⇒ 会统计其油墨。两侧不一致时,
    //   理论上会出现"对象有油墨、但它用的色板被判未使用" ⇒ 色板被误删。
    //   统一成"只排除明确 false"(更保守: 宁可多留色板, 不可误删)。
    // v11.1(审查 ⑧): fillColor / strokeColor 各只读一次。
    //   原来 mark() 与下面的图案兜底**各读一遍**, 同一对象要跨桥取两次属性 ——
    //   在几百上千对象的文档里就是多出整整一倍的颜色属性读取, 而读到的必然是同一份。
    //   现改为先取到局部变量, 两处共用; 读失败时局部为 null ⇒ 两侧都安全跳过。
    var cFill = null, cStrk = null;
    try { cFill = it.fillColor; } catch (eF0) { cFill = null; if (colorCapable) markIncomplete(); }
    try { cStrk = it.strokeColor; } catch (eS0) { cStrk = null; if (colorCapable) markIncomplete(); }
    try { if (it.filled !== false) mark(cFill); } catch (e1) { if (colorCapable) markIncomplete(); }
    try { if (it.stroked === true) mark(cStrk); } catch (e2) { if (colorCapable) markIncomplete(); }
    // v11.56: 符号定义源/组内的文字也要按字符区间采色。
    if (tn === "TextFrame") collectTextColors(it);

    // v0.5: 图案填充的"图案"句柄有时只能从 fillColor.pattern 读 —— 已在 mark() 内处理;
    //   另补一层 .pattern 直读(个别对象 filled 标志不可靠时兜底)
    try { if (cFill && cFill.typename === "PatternColor") markPattRef(cFill.pattern); } catch (eP1) {}
    try { if (cStrk && cStrk.typename === "PatternColor") markPattRef(cStrk.pattern); } catch (eP2) {}

    // 下钻子对象
    try {
      if (tn === "GroupItem") {
        var gi = it.pageItems;
        for (var g = 0; g < gi.length; g++) collectItem(gi[g], depth + 1, false);
      } else if (tn === "CompoundPathItem") {
        var ci = it.pathItems;
        for (var c2 = 0; c2 < ci.length; c2++) collectItem(ci[c2], depth + 1, false);
      } else if (tn === "SymbolItem") {
        // v11.54: **已放置的符号实例**要下钻定义源。
        //   原先没有这个分支 ⇒ 只用在某个符号里的专色/渐变/图案一律不登记 ⇒
        //   被判"未使用", 「清除未使用色板」会真删 ⇒ 符号里的图形当场改色。
        //   ⚠ 与下面 ⑤ 的"忽略符号"不矛盾: 那条忽略的是 **doc.symbols 整个符号库**
        //     (新建文档自带的默认符号, 其 CMYK 默认色会把默认色板全判成"在用")。
        //     这里只下钻**被遍历到的实例** —— 没放在画板上的库符号照旧不看,
        //     旧取舍不变。检查端 visitItem 从 v4.8 起就是这个口径, 两侧终于一致。
        //   ⚠ 同一符号的多个实例会各自下钻一遍: 颜色按色值去重(pfUsedColorKeys 的
        //     colorKeys), 重复登记无副作用; 符号内再套符号由 depth 上限兜住。
        var ssym = null;
        try { ssym = pfSymSource(it); } catch (eS2) { ssym = null; }
        if (ssym && ssym.pageItems) {
          var spi = ssym.pageItems;
          for (var sp = 0; sp < spi.length; sp++) collectItem(spi[sp], depth + 1, false);
        } else {
          markIncomplete();
        }
      }
    } catch (eD) { markIncomplete(); }
  }

  function walkLayers(lyrs, depth) {
    // v10.60: 同 collectItem —— 20 -> 64, 与主扫描统一。
    if (depth > PF_MAX_DEPTH) { markIncomplete(); return; }
    for (var i = 0; i < lyrs.length; i++) {
      var ly = lyrs[i];
      // v11.90: 对照层不收色 —— 否则它那张栅格的 fillColor 会变成"在用色",
      //   未使用色板的判定随之偏移(该删的删不掉)。
      if (pfIsAuxLayer(ly)) continue;
      try {
        var items = ly.pageItems;
        for (var j = 0; j < items.length; j++) collectItem(items[j], 0, true);
      } catch (eL) { markIncomplete(); }
      try { var subs = ly.layers; if (subs && subs.length) walkLayers(subs, depth + 1); }
      catch (eL2) { markIncomplete(); }
    }
  }
  walkLayers(doc.layers, 0);

  // ② 文字: 字符属性区间 + 整帧默认色(含隐藏/锁定 —— 保守不误删)
  //   v0.5.2: 文字帧也算"对象"计入 objCount(空画板若含文本框, 不该被判成"遍历出错")
  try {
    var tfs = doc.textFrames;
    for (var ti = 0; ti < tfs.length; ti++) {
      var tf = tfs[ti];
      objCount++;
      collectTextColors(tf);
      // 帧对象自身的填充/描边(文本框底纹/边框)
      // v10.33: 同 scanPathInk 口径统一为 `!== false`
      try { if (tf.filled !== false) mark(tf.fillColor); } catch (eTf1) { markIncomplete(); }
      try { if (tf.stroked === true) mark(tf.strokeColor); } catch (eTf2) { markIncomplete(); }
    }
  } catch (eTX) { markIncomplete(); }

  // ③ ⚠ v0.5 移除: 原 v0.1 起把"文档里存在的**所有**渐变"整类按在用放行
  //   (遍历 doc.gradients 把每个渐变的色标色都 mark 一遍) —— 这会让"未使用渐变"
  //   永远无法被识别。现改为: 只登记**被对象引用**的渐变(在上方 mark() 里做),
  //   未被任何对象引用的渐变即可被识别为"未使用"。
  //   ⚠ 但有个例外必须保留: 渐变色标里的**专色/印刷色**仍需保留其对应色板 ——
  //   实际已被上方的 mark(GradientColor) 分支覆盖(它展开色标), 故此处无需重复。

  // ④ ⚠ v0.5 移除: 原 v0.2 把 doc.patterns 整类按在用放行(保守兜底)。
  //   现改为: 只登记**被对象引用**的图案(在上方 mark(PatternColor) 里做),
  //   未被任何对象引用的图案即可被识别为"未使用"。

  // ⑤ ⚠ v0.5.1 移除(真机 bug —— 空画板却显示 11 个色板全在用):
  //   原实现无条件遍历 doc.symbols(文档符号库), 把**符号定义内**的路径颜色也登记为"在用"。
  //   但每个新建的 AI 文档都自带符号库(网页图标/箭头等), 这些符号路径用的正是
  //   默认 CMYK 色值(黑/红/黄/绿/蓝…) ⇒ 色板表里同色值的默认色板全部命中,
  //   产生"空画板却 11 个色板全在用"的假象(系统 4 项 + 默认 7 个印刷色)。
  //   连带影响: 符号里的渐变/图案也被登记 ⇒ v0.5 的"未使用渐变/图案"同样删不掉。
  //   ⚠ 取舍(用户选定「忽略符号」): 只统计**画板上的实际对象**, 不再看符号定义。
  //     代价: 若某文档确实只有一个"未放置的符号"引用某专色, 该专色会被判未使用。
  //     但符号未被放置 = 输出里不会出现它 ⇒ 回收其专属颜色是合理的。
  //     且符号库是**文档级默认携带**的, 把它当"在用"几乎必然误判 —— 故必须忽略。

  return { names: names, colors: colors, objCount: objCount,
           colorTruncated: colorTruncated, incomplete: incomplete };
}

// 统计未使用色板(只读, 不修改文档)
//   返回 { total, used, unused }
//   v10.46: 删死字段 —— unusedNames/usedNames/noText/colorCount/nameCount
//     前端卡⑧只读 total/used/unused(五个都没接线); names 收集连带
//     NAME_CAP 逻辑一并简化, truncated 改按"未使用总数 > NAME_CAP"判(等价原语义)。
//   v11.1(审查 ⑦): 再把 truncated 一并删掉 —— main.js 对 swatches/gradients/patterns
//     这三个结果**只读 total/used/unused**(grep 零消费), 那个字段算出来就没人看;
//     连带 NAME_CAP=12 这个魔数在三个扫描里各重复一遍也一起收掉。
function pfSwatchScan(doc, usedPre) {
  var out = { total: 0, used: 0, unused: 0 };
  try {
    // v10.28: 加参 usedPre 复用调用方已收集的 pfUsedColorKeys 结果, 消除同一轮内双调(审计疑似2)
    var used = usedPre || pfUsedColorKeys(doc);
    // v11.56: 局部读取失败时统计不可信, 前端必须显示"统计失败"而不是绿色"无未使用"。
    if (used && used.incomplete) out.usedFailed = true;
    var sws = doc.swatches;
    out.total = sws.length;
    for (var i = 0; i < sws.length; i++) {
      var sw = sws[i], nm = "", isUsed = false;
      try { nm = sw.name; } catch (eN) { continue; }
      // v0.2: 传入 idx —— 系统四项位置兜底(名字读失败时仍能保住)
      try { if (pfIsSystemSwatch(sw, i)) isUsed = true; } catch (eSys) {}
      if (!isUsed) isUsed = pfSwatchUsed(sw, used.names, used.colors);
      if (isUsed) out.used++;
      else out.unused++;
    }
  } catch (e) { out.usedFailed = true; }
  return out;
}

// ============================================================
// v0.5: 未使用渐变 / 未使用图案 — 统计与清除(雪糕需求)
// ------------------------------------------------------------
// 判定: 一个渐变/图案若**没有被任何对象引用**, 即为"未使用"。
//   引用来源(names 里的 GRAD:name / PATT:name)由 pfUsedColorKeys 统一收集:
//     对象填充/描边为 GradientColor ⇒ 记 GRAD
//     对象填充/描边为 PatternColor  ⇒ 记 PATT
//     (含组/复合路径/文字/符号内的对象)
//   ⚠ 与色板不同: 渐变/图案**没有系统保留项**, 不做下标兜底。
//   ⚠ 安全: 与色板同理设"收集闸" —— 若连一个颜色都没收集到(遍历异常),
//     拒绝删除, 防把整库渐变/图案清空。
//   ⚠ 命名: "[无]"等非渐变项不会出现在 doc.gradients 里; 但个别文档存在
//     不可删的内建项, 删除失败一律计入 failed 如实回报, 不静默跳过。
// ============================================================

// 统计未使用渐变(只读)
//   返回 { total, used, unused }  (v10.46 审查 P2-2: 清单字段已删; v11.1 审查 ⑦: truncated 亦删)
function pfGradientScan(doc, used) {
  var out = { total: 0, used: 0, unused: 0 };
  try {
    if (!used) used = pfUsedColorKeys(doc);
    var gs = doc.gradients;
    out.total = gs.length;
    for (var i = 0; i < gs.length; i++) {
      var nm = "", isUsed = false;
      try { nm = gs[i].name; } catch (eN) { continue; }
      try { if (used.names["GRAD:" + nm]) isUsed = true; } catch (eU) {}
      if (isUsed) out.used++;
      else out.unused++;
    }
  } catch (e) { out.usedFailed = true; }
  return out;
}

// 统计未使用图案(只读)
//   返回 { total, used, unused }  (v11.1 审查 ⑦: 同 pfGradientScan 删 truncated)
function pfPatternScan(doc, used) {
  var out = { total: 0, used: 0, unused: 0 };
  try {
    if (!used) used = pfUsedColorKeys(doc);
    var pts = doc.patterns;
    out.total = pts.length;
    for (var i = 0; i < pts.length; i++) {
      var nm = "", isUsed = false;
      try { nm = pts[i].name; } catch (eN) { continue; }
      try { if (used.names["PATT:" + nm]) isUsed = true; } catch (eU) {}
      if (isUsed) out.used++;
      else out.unused++;
    }
  } catch (e) { out.usedFailed = true; }
  return out;
}

// 删除未使用渐变 + 未使用图案(破坏性动作, 按钮触发)
//   返回 { ok, grad:{before,after,removed,removedNames,failed,failedNames},
//          patt:{...}, message }
//   ⚠ 与 pfClearUnusedSwatches 共用 pfUsedColorKeys 判定 —— "扫出几个就删几个"。
function pfClearUnusedGradPattern() {
  var res = { ok: false };
  try {
    if (app.documents.length === 0) { res.error = "当前没有打开的文档，请先打开一个 AI 文件。"; return pfReturn(res); }
    var doc = app.activeDocument;
    // v10.46: 优先复用同轮串联里 pfClearUnusedSwatches 已收集的结果
    //   (两道安全闸在它那边已过; 删色板不改变在用颜色集合 ⇒ 判定等效)。
    //   单独调用(无缓存)时照旧自收集。
    var used = __pfUsedCache || pfUsedColorKeys(doc);
    // v10.60: 一次性消费 —— 读完立即清空, 免得"上一轮的缓存"跨轮串味。
    __pfUsedCache = null;

    // 安全闸(与色板一致): 名字与颜色都空 ⇒ 遍历异常, 拒绝删除
    //   v0.5.2: 用 objCount 区分"真·空文档/空画板"(objCount=0 ⇒ 放行) 与"遍历出错"(有对象却 0 色 ⇒ 拒绝)
    var nameCnt0 = 0;
    for (var nk0 in used.names) { if (used.names.hasOwnProperty(nk0)) nameCnt0++; }
    var objCnt0 = (typeof used.objCount === "number") ? used.objCount : -1;
    if (objCnt0 !== 0 && nameCnt0 === 0 && used.colors.length === 0) {
      res.ok = false;
      res.error = "安全闸触发(保护机制正常拦截)：未能在文档中收集到任何在用颜色(可能是不兼容的文档状态)。为保证安全，本次不执行删除。请把此情况反馈给开发者。";
      return pfReturn(res);
    }

    // v10.28: 颜色收集触顶(4000 上限) ⇒ 未收集到的颜色对应色板可能被误判"未使用", 拒绝删除
    if (used.colorTruncated) {
      res.ok = false;
      res.error = "文档颜色数量超过收集上限(" + PF_COLOR_CAP + ")，为避免误删，本次不执行删除。";
      return pfReturn(res);
    }
    if (used.incomplete) {
      res.ok = false;
      res.error = "颜色采集不完整(部分文字或对象颜色读取失败)，为避免误删，本次不执行删除。请重试或先在 Illustrator 中检查文档状态。";
      return pfReturn(res);
    }

    // ---- 渐变 ----
    var gRes = { before: 0, after: 0, removed: 0, removedNames: [], failed: 0, failedNames: [] };
    try {
      var gs0 = doc.gradients;
      gRes.before = gs0.length;
      var gsArr = [];
      for (var gi = 0; gi < gs0.length; gi++) gsArr.push(gs0[gi]);
      // 倒序删, 避免索引漂移
      for (var gj = gsArr.length - 1; gj >= 0; gj--) {
        var g = gsArr[gj], gnm = "";
        try { gnm = g.name; } catch (eGN) { gRes.failed++; gRes.failedNames.push("(未命名)"); continue; }
        if (used.names["GRAD:" + gnm]) continue;   // 在用, 保留
        try { g.remove(); gRes.removed++; gRes.removedNames.push(gnm); }
        catch (eGR) { gRes.failed++; gRes.failedNames.push(gnm); }
      }
      try { gRes.after = doc.gradients.length; } catch (eGA) {}
    } catch (eGX) { gRes.failed++; gRes.failedNames.push("(渐变读取失败)"); }

    // ---- 图案 ----
    var pRes = { before: 0, after: 0, removed: 0, removedNames: [], failed: 0, failedNames: [] };
    try {
      var pts0 = doc.patterns;
      pRes.before = pts0.length;
      var ptsArr = [];
      for (var pi = 0; pi < pts0.length; pi++) ptsArr.push(pts0[pi]);
      for (var pj = ptsArr.length - 1; pj >= 0; pj--) {
        var p = ptsArr[pj], pnm = "";
        try { pnm = p.name; } catch (ePN) { pRes.failed++; pRes.failedNames.push("(未命名)"); continue; }
        if (used.names["PATT:" + pnm]) continue;   // 在用, 保留
        try { p.remove(); pRes.removed++; pRes.removedNames.push(pnm); }
        catch (ePR) { pRes.failed++; pRes.failedNames.push(pnm); }
      }
      try { pRes.after = doc.patterns.length; } catch (ePA) {}
    } catch (ePX) { pRes.failed++; pRes.failedNames.push("(图案读取失败)"); }

    res.ok = true;
    res.grad = gRes;
    res.patt = pRes;
    var parts = [];
    parts.push("渐变: " + (gRes.removed > 0 ? "删除 " + gRes.removed + " 个（剩余 " + gRes.after + "）" : "无可删除（当前 " + gRes.after + " 个全部在用）")
      + (gRes.failed > 0 ? "，失败 " + gRes.failed + " 个：" + gRes.failedNames.join("、") : ""));
    parts.push("图案: " + (pRes.removed > 0 ? "删除 " + pRes.removed + " 个（剩余 " + pRes.after + "）" : "无可删除（当前 " + pRes.after + " 个全部在用）")
      + (pRes.failed > 0 ? "，失败 " + pRes.failed + " 个：" + pRes.failedNames.join("、") : ""));
    res.message = parts.join("；") + "。";
  } catch (err) {
    res.ok = false;
    res.error = "清除未使用渐变/图案失败: " + String(err);
  }
  return pfReturn(res);
}

// ============================================================
// v0.5.1: 颜色组(swatchGroups)统计与清理(雪糕需求)
// ------------------------------------------------------------
// AI 的"颜色组"= 色板面板里那一排可展开的分组(swatchGroups)。
//   用户选定方案「拆组 + 删空组」:
//     ① 把组内"未使用"的色板**移出该组**(从组里移除, 不删色板对象本身
//        —— 色板对象的死活仍由 pfClearUnusedSwatches 按原逻辑判定, 不重复删)
//     ② 组被移空 ⇒ 删掉这个空组
//   ⚠ AI 的 DOM 对 swatchGroups 支持较浅且版本差异大, 全程 try/catch 包住:
//     - 读不到 doc.swatchGroups ⇒ 该项统计为 0, 不影响其它功能(优雅降级)。
//     - 组的移除 API 在不同版本上名称不一(remove() / swatchGroup.remove()),
//       失败一律计入 failed 如实回报, 不静默吞掉。
// ============================================================

// 读到文档的颜色组数组(读不到返回 null —— 调用方据此优雅降级)
function pfGetSwatchGroups(doc) {
  try {
    var g = doc.swatchGroups;
    if (g === undefined || g === null) return null;
    return g;
  } catch (e) { return null; }
}

// 统计颜色组: { supported, total }
//   supported=false 表示该版本 AI 不支持 swatchGroups(前端隐藏相关 UI)
//   ⚠ v0.7.8: 真机诊断(AI 28.0.0) 证实 SwatchGroup **无法读取成员**(swatches 等全 undefined),
//     故**不再统计"组内未使用色板"**(根本读不到), 只报告颜色组数量。
//   v11.1(审查 ⑦): 删死参 used 与死字段 unknown/groups —— 前端只读 supported/total
//     (main.js 卡⑧ 仅取 sg.supported / sg.total), 那个入参在函数体里一次都没被用过。
function pfSwatchGroupScan(doc) {
  var out = { supported: false, total: 0 };
  var gs = pfGetSwatchGroups(doc);
  if (!gs) return out;   // 不支持 ⇒ 直接返回, 不影响其它统计
  out.supported = true;
  try {
    out.total = gs.length;
  } catch (e) {}
  return out;
}

// 颜色组清理 —— v0.7.8: **不再删除任何颜色组**
//   ⚠ 依据真机诊断(AI 28.0.0): `SwatchGroup` **不暴露任何可读的成员集合属性**
//     (swatches / swatchGroups / groupItems / members / children / … 全为 undefined,
//      可枚举属性只有 name / typename / parent; removeSwatch 亦为 undefined)。
//     也就是说 —— **我们无法得知一个组里到底有没有色板**, 但 `g.remove()` 会
//     **连带删除组内全部色板**(级联删除)。任何"猜"的空组判定都曾造成不可逆损失:
//       ❌ v0.7.5: 读不到成员数 ⇒ 当作 0 ⇒ 判空组 ⇒ 删组 ⇒ 色板全没
//       ❌ v0.7.7: 「试删 + undo」测长度 ⇒ 但 doc.swatches.length 同执行内不刷新 ⇒ 恒判空 ⇒ 色板全没
//   故本函数**改为只读**: 只报告颜色组数量, **绝不调用 remove()**。
//   代价: 真·空组也不会被删除(用户已确认接受 —— 安全优先)。
//   返回 { ok, supported, groupsBefore, removedGroups:0, skipped:true, message }
//   v10.28: 当前前端未接线(预留) —— 面板没有任何按钮调用本函数, 仅保留作后续扩展。
function pfClearUnusedSwatchGroups() {
  var res = { ok: true, supported: false, removedGroups: 0, skipped: true };
  try {
    if (app.documents.length === 0) { res.error = "当前没有打开的文档，请先打开一个 AI 文件。"; res.ok = false; return pfReturn(res); }
    var doc = app.activeDocument;
    var gs = pfGetSwatchGroups(doc);
    if (!gs) {
      res.supported = false;
      res.message = "颜色组：当前 Illustrator 版本不支持读取颜色组，已跳过。";
      return pfReturn(res);
    }
    res.supported = true;
    res.groupsBefore = gs.length;
    try { res.groupsAfter = doc.swatchGroups.length; } catch (eA) { res.groupsAfter = -1; }
    res.message = "颜色组：已跳过（当前 " + res.groupsBefore + " 个组，均保留）。" +
      "为避免误删组内色板，本版不再删除任何颜色组。";
  } catch (err) {
    res.ok = false;
    res.error = "读取颜色组失败: " + String(err);
  }
  return pfReturn(res);
}

// 删除未使用色板(破坏性动作, 由按钮触发)
//   v10.16: 与 pfSwatchScan 共用同一套判定, 保证"扫出几个就删几个"。
//   ⚠ 文档里还有未转曲文字时**仍执行删除** —— 文字颜色已按字符级读到(见口径②),
//     不存在"文字专色收不到"的情况; 若读取失败则计入 failed 并如实回报, 不静默跳过。
function pfClearUnusedSwatches() {
  var res = { ok: false };
  try {
    if (app.documents.length === 0) { res.error = "当前没有打开的文档，请先打开一个 AI 文件。"; return pfReturn(res); }
    var doc = app.activeDocument;
    // v10.60: 进本函数即作废上一轮的轮内缓存 —— 下面若在安全闸处提前 return,
    //   __pfUsedCache 会停在上一次的值; 而执行链的下一棒(pfClearUnusedGradPattern)仍会读它,
    //   拿旧快照删渐变/图案 ⇒ 可能误删。本函数恒是每轮执行的"第一个动作", 在此清空最稳妥。
    __pfUsedCache = null;
    var used = pfUsedColorKeys(doc);

    // v0.2 安全闸(真机 bug 后新增): 若**名字和颜色都一个没收集到**, 说明遍历/读取出了问题
    //   (语言不匹配、属性名变化、权限等), 此时删除会把全部色板误删 ⇒ 直接拒绝执行。
    //   宁可"今天删不了", 也不能"把文档色板清空"。
    //   ⚠ v0.5.2 修复(真机 bug —— 空画板按了不删色板):
    //     原判定把"空画板"(文档里本就没有任何对象 ⇒ 理应收不到任何在用色) 与
    //     "遍历出错"(有对象却读不到色) 混为一谈, 导致空画板时安全闸误触发、拒绝删除。
    //     现引入 objCount(成功遍历到的对象数) 区分:
    //       objCount === 0  ⇒ 真·空文档/空画板, **放行**(本就该删掉所有非系统色板);
    //       objCount  > 0   且 0 色 0 名 ⇒ 判定遍历异常, 拒绝删除(保住原保护意图);
    //       objCount  < 0   ⇒ 旧版数据(未提供该字段), 保守拒绝。
    var nameCnt0 = 0;
    for (var nk0 in used.names) { if (used.names.hasOwnProperty(nk0)) nameCnt0++; }
    var objCnt0 = (typeof used.objCount === "number") ? used.objCount : -1;
    if (objCnt0 !== 0 && nameCnt0 === 0 && used.colors.length === 0) {
      res.ok = false;
      res.error = "安全闸触发(保护机制正常拦截)：未能在文档中收集到任何在用颜色(可能是不兼容的文档状态)。为保证安全，本次不执行删除。请把此情况反馈给开发者。";
      return pfReturn(res);
    }

    // v10.28: 颜色收集触顶(4000 上限) ⇒ 未收集到的颜色对应色板可能被误判"未使用", 拒绝删除
    if (used.colorTruncated) {
      res.ok = false;
      res.error = "文档颜色数量超过收集上限(" + PF_COLOR_CAP + ")，为避免误删，本次不执行删除。";
      return pfReturn(res);
    }

    // v11.56: 局部遍历/文字颜色/色值读取失败 ⇒ 本轮"未使用"结论不可信, 一律不删。
    if (used.incomplete) {
      res.ok = false;
      res.error = "颜色采集不完整(部分文字或对象颜色读取失败)，为避免误删，本次不执行删除。请重试或先在 Illustrator 中检查文档状态。";
      return pfReturn(res);
    }

    // v10.46: 两道闸都过了 ⇒ 本次确实要删, 把收集结果存进轮内缓存,
    //   供同一轮串联的 pfClearUnusedGradPattern 复用(不再二次全文档遍历)
    __pfUsedCache = used;

    var before = 0;
    try { before = doc.swatches.length; } catch (eB) {}

    // 先快照色板引用(倒序删, 避免索引漂移)
    var sws = [];
    try {
      var cur = doc.swatches;
      for (var i = 0; i < cur.length; i++) sws.push(cur[i]);
    } catch (eS) {
      res.error = "读取色板失败: " + String(eS);
      return pfReturn(res);
    }

    var removed = [], failed = [], kept = 0;
    // v0.2: pfClearUnusedSwatches 与 pfSwatchScan 共用同一判定(名字集合 + 颜色容差列表)
    for (var j = sws.length - 1; j >= 0; j--) {
      var sw = sws[j], nm = "";
      try { nm = sw.name; } catch (eN) { failed.push("(未命名)"); continue; }
      // v0.2: idx 传原始下标 —— 系统四项位置兜底
      var isS = false;
      try { isS = pfIsSystemSwatch(sw, j); } catch (eSys) {}
      if (isS || pfSwatchUsed(sw, used.names, used.colors)) { kept++; continue; }
      try { sw.remove(); removed.push(nm); }
      catch (eR) { failed.push(nm); }
    }

    var after = 0;
    try { after = doc.swatches.length; } catch (eA) {}

    res.ok = true;
    res.before = before;
    res.after = after;
    res.removed = removed.length;
    res.removedNames = removed;
    res.failed = failed.length;
    res.failedNames = failed;
    res.kept = kept;
    res.message = (removed.length > 0
      ? "已删除未使用色板 " + removed.length + " 个（剩余 " + after + " 个）"
    : "未发现可删除的未使用色板（当前 " + after + " 个全部在用）") +
      (failed.length > 0 ? "，失败 " + failed.length + " 个：" + failed.join("、") + "。" : "。");
  } catch (err) {
    res.ok = false;
    res.error = "清除未使用色板失败: " + String(err);
  }
  return pfReturn(res);
}

// ============================================================
// 一键操作: 按需解锁/显示图层(含子图层)
// unlockAll=true 时解锁; showAll=true 时显示; 可单独或同时
// ============================================================
function pfUnlockLayer(layer, unlockAll, showAll, depth) {
  // v11.1(审查 ⑭): 补深度上限 64 —— 全站其余六处图层/对象递归(walkLayers / visitItem /
  //   collectItem / collectTop …)都是 64, 只有本函数与 snapHiddenLayers 没有闸。
  //   正常文档图层深度个位数, 64 只为兜住"异常 parent/layers 环"导致的栈溢出。
  if (depth > PF_MAX_DEPTH) return;
  // v11.90: 对照层不参与解锁/显形 —— 它是锁定态的半透明参考图, 一旦被「解锁全部」解开,
  //   之后任何拖动都会把整张对照图带偏, 而用户完全看不出自己动过它。
  if (pfIsAuxLayer(layer)) return;
  // v10.8: 未勾「显示」时, 隐藏图层整棵跳过 —— 隐藏内容不参与检查(卡内已明示),
  //   也不该被「解锁全部」改掉锁定状态(清除叠印/转曲共用本函数);
  //   勾了「显示」则照常(先显示后解锁, 隐藏层一并处理)。读取失败保守放行(维持旧行为)。
  if (!showAll) { try { if (layer.visible === false) return; } catch (eV) {} }
  if (unlockAll) { try { layer.locked = false; } catch (e) {} }
  if (showAll) { try { layer.visible = true; } catch (e) {} }
  try {
    var sub = layer.layers;
    for (var i = 0; i < sub.length; i++) pfUnlockLayer(sub[i], unlockAll, showAll, (depth || 0) + 1);
  } catch (e) {}
}

// 沿 parent 链解除**该对象自身**的锁定阻挡(含 Ctrl+2 与锁定组); 隐藏一律不动。
//   返回解除层数; 循环上限 10 防异常 parent 链死循环。
//   v11.1(审查 ⑤): 提到模块级 —— 原来 pfClearOverprint 的 pfUnlockItem 与
//   pfOverprintRule 的 pfUnlockItem2 是**逐字相同**的两份(只差函数名), 两处各改一次
//   才算改全, v10.43 就有过一次"只改一个、漏掉另一个"的记录。合成一份后只有一处可改。
function pfUnlockItem(item) {
  var n = 0, g = 0, info = null;
  try { info = pfBlockInfo(item); } catch (e0) { return 0; }
  while (info && info.reason === "locked" && g++ < 10) {
    if (!pfClearBlock(info.node, "locked")) break;
    n++;
    try { info = pfBlockInfo(item); } catch (e1) { break; }
  }
  return n;
}

// ============================================================
// 阻挡检测: 沿 parent 链向上(对象 → 组 → 图层 → 父图层)逐级检查
// 修 bug: 旧逻辑只看文字所在图层,漏掉两类真实阻挡——
//   1) 对象自身被 Ctrl+2 锁定(pageItem.locked,与图层锁定无关)
//   2) 文字在被锁定的组(groupItem)里,或对象被 Ctrl+3 隐藏
// 返回 {reason:"hidden"|"locked", node:阻挡节点, reasons:{...}, locked:bool, hidden:bool}
// v10.35: 原实现命中即返回**单一**原因(hidden 判在 locked 之前) —— 同一节点
//   既隐藏又锁定时只报 hidden, 调用方若只认 locked(如叠印的"其中锁定 N 处")就会漏计。
//   现补 reasons/locked/hidden 三个字段**并列上报**, reason/node 保留原语义(首个命中,
//   供 pfClearBlock 精确解除)—— 旧调用点一字不改, 新调用点可用 locked 布尔。
// ⚠ v10.36 复核修正(审查 v10.35 指出): 这是**抽象改善, 不是实锤修复** ——
//   在**主扫描路径**下 hidden 维度不可达: visitItem 的 `if (tn === "GroupItem")` 分支对
//   隐藏组整支 return、`// 对象自身隐藏(Ctrl+3)` 处对自身隐藏对象整支 return、
//   walkLayer 对隐藏图层整支跳过 ⇒ 能走到 pfBlockInfo 的对象必然自身可见 + 祖先可见 +
//   所在图层可见, 故 fHidden 恒假, 新增的 hidden 字段在主路径下**不改变任何结果**。
//   保留它的价值 = 为"将来放宽剪枝(改成不剪枝隐藏组、逐项判 pfBlockInfo)"留好口子;
//   届时这个字段会立刻生效。**但不要因此就去掉上面的剪枝** —— 剪枝是性能根基。
// v11.39: 上面原本写的是"隐藏组 1067 行 / 自身隐藏 1148 行 / walkLayer 1334 行",
//   那三个行号早已漂到别处(改一次代码就失效, 反而误导)。改成按**分支特征**描述, 不再钉行号。
//   补充: 这一点在**动作侧不成立** —— pfCleanup / pfDeleteHidden / 转曲都会对隐藏对象调
//   pfBlockInfo, 那里 hidden 是实打实会用到的(审查 #10 的错配就是踩在这里)。
function pfBlockInfo(item) {
  var p = item, guard = 0;
  var fLocked = false, fHidden = false, firstNode = null, firstReason = null;
  // v11.56: 锁定节点与隐藏节点**分开记**。
  //   node 是"最近的阻挡节点", 它可能只是隐藏节点; 如果更远祖先才锁定, 把 node 当锁节点
  //   交给 pfCleanup 会出现"解了隐藏节点的 locked(本来就没锁) → 删完再把隐藏节点锁上"。
  //   lockedNode / hiddenNode 各自取最近的那一个, 调用方按需使用。
  var lockedNode = null, hiddenNode = null;
  while (p && guard++ < PF_MAX_DEPTH) {
    var tn = "";
    try { tn = p.typename; } catch (et) { break; }
    if (tn === "Document") break;
    var isH = false, isL = false;
    try { isH = (p.visible === false || p.hidden === true); } catch (e) {}
    try { isL = (p.locked === true); } catch (e) {}
    if (isH || isL) {
      if (isH) { fHidden = true; if (!hiddenNode) hiddenNode = p; }
      if (isL) { fLocked = true; if (!lockedNode) lockedNode = p; }
      // 首个命中节点 = 离对象最近的那个, 保留原 reason/node 语义(pfClearBlock 由它解除)
      if (!firstNode) { firstNode = p; firstReason = isH ? "hidden" : "locked"; }
    }
    try { p = p.parent; } catch (ep) { break; }
  }
  if (!firstNode) return null;
  return { reason: firstReason, node: firstNode, lockedNode: lockedNode, hiddenNode: hiddenNode,
           locked: fLocked, hidden: fHidden,
           reasons: { locked: fLocked, hidden: fHidden } };
}

// 解除单个阻挡节点(Layer 用 visible,对象用 hidden);成功返回 true
function pfClearBlock(node, reason) {
  try {
    if (reason === "locked") { node.locked = false; return true; }
    if (reason === "hidden") {
      var tn = "";
      try { tn = node.typename; } catch (et) {}
      if (tn === "Layer") node.visible = true;
      else node.hidden = false;
      return true;
    }
  } catch (e) {}
  return false;
}

// ============================================================
// v11.39: 符号定义源的下钻统一到这一处。
//   原来同一段"symbol → .item → 兜底 symbol 自身"在三份代码里逐字抄了三遍
//   (清叠印 / 分级规则 / 转曲), 加上检查端的第四份, 共四份。策略一改必漏。
//   口径与原来完全一致: 拿不到 .item 就退回符号定义对象本身(pageItems 仍可读)。
//   ⚠ 不要在这里加"缺失符号/不可访问"的判定 —— 各调用方对 null 的处理不同。
function pfSymSource(it) {
  var def = null;
  try { def = it.symbol; } catch (eSS1) {}
  if (!def) return null;
  var src = null;
  try { src = def.item; } catch (eSS2) {}
  if (!src) { try { src = def; } catch (eSS3) {} }
  return src;
}

// ============================================================
// v9.4 一键清除叠印(雪糕点名的新功能): 把文档里**全部**叠印关掉 —— 文字(字符级)
//   与图形(pageItem 级)、填充与描边都算,口径与检查端完全一致。
//   ⚠ 与转曲不同: **默认不解除任何锁定/隐藏** —— 阻挡的对象直接跳过并计数,如实回报。
//     理由: 清叠印是个"顺手清理"的动作,不该顺手改动用户的图层/对象状态。
//   v9.5: 新增 unlockAll 开关(叠印卡「解锁全部」复选框, 默认关) —— 为真时先解锁全部
//     图层(含子图层)与对象级锁定(Ctrl+2)/锁定组, 这些对象的叠印一并清除;
//     隐藏对象**始终不碰**(面板已标注"隐藏对象与图层不参与叠印检查")。
//   ⚠ 真机未验证(见 v9.4 交付说明): 能自证的只有 mock 下的读写与计数。
// ============================================================
function pfClearOverprint(unlockAll) {
  var res = { ok: false };
  try {
    if (app.documents.length === 0) { res.error = "当前没有打开的文档，请先打开一个 AI 文件。"; return pfReturn(res); }
    var doc = app.activeDocument;
    var uAll = (unlockAll === true);
    var cleared = 0, skipped = 0, failed = 0, unlocked = 0;

    // v9.5: 图层级解锁(含子图层);对象级锁定 / 锁定组由下面 pfUnlockItem 逐项解除
    if (uAll) {
      try {
        var lys = doc.layers;
        for (var li = 0; li < lys.length; li++) pfUnlockLayer(lys[li], true, false);
      } catch (eUL) {}
    }
    // v9.5: 沿 parent 链解除该对象的**锁定**阻挡(含 Ctrl+2 与锁定组);隐藏一律不动。
    //   v11.1(审查 ⑤): 函数体已提到模块级 pfUnlockItem(pfOverprintRule 共用同一份)。

    // 1) 文字: 帧级读法(与检查端同一个 characterAttributes,粒度一致)
    //   v10.46: 循环体抽成 pfClrOvpFrame —— 符号定义源内的文字帧复用同一套
    function pfClrOvpFrame(tf) {
      if (uAll) unlocked += pfUnlockItem(tf);
      if (pfBlockInfo(tf)) { skipped++; return; }
      try {
        var ca = tf.textRange.characterAttributes;
        if (pfCharOvpFill(ca) || pfCharOvpStroke(ca)) {
          ca.overprintFill = false;
          ca.overprintStroke = false;
          cleared++;
        }
      } catch (eT) { failed++; }
    }
    var tfs = doc.textFrames;
    for (var i = tfs.length - 1; i >= 0; i--) pfClrOvpFrame(tfs[i]);

    // 2) 图形: PathItem 与 CompoundPathItem 各一遍(两个集合互不重复;
    //    即便某个内层路径被两处扫到,第一次置 false 后第二次已读不到 true ⇒ 不会重复计数)
    function pfClrPath(pi) {
      if (uAll) unlocked += pfUnlockItem(pi);
      if (pfBlockInfo(pi)) { skipped++; return; }
      try {
        if (pfOvpFill(pi) || pfOvpStroke(pi)) {
          pi.fillOverprint = false;
          pi.strokeOverprint = false;
          cleared++;
        }
      } catch (eP) { failed++; }
    }
    try { var ps = doc.pathItems; for (var j = ps.length - 1; j >= 0; j--) pfClrPath(ps[j]); } catch (ePS) {}
    // ⚠ v10.53(审查 A2): 这里喂的是 CompoundPathItem **自身**, 而检查端读的是它的
    //   pathItems[0]、符号下钻内又是逐个组件 —— 口径不同, 待真机验证后统一(见卡⑦ 检查端注释)。
    try { var cps = doc.compoundPathItems; for (var k = cps.length - 1; k >= 0; k--) pfClrPath(cps[k]); } catch (eCPS) {}

    // 3) v10.46: 符号定义源内的对象(文字帧 + 路径)下钻清除。
    //    根因: 检查端 visitItem 的 SymbolItem 分支会下钻符号定义源, 符号内的文字/路径
    //    进入叠印统计; 而本函数原先只走 doc.textFrames / doc.pathItems 等**文档级**扁平
    //    集合(不含符号内) ⇒ "扫出 N 处 / 清完还剩 N 处"(雪糕视角: 点了没反应)。
    //    口径与检查端对齐: 隐藏/锁定的符号**实例**跳过(pfBlockInfo 判定, 隐藏实例
    //    检查端也整收不下钻); 定义源内对象各自的阻挡由 pfClrOvpFrame / pfClrPath
    //    内部的 pfBlockInfo 判定, 不在此重复。
    //    ⚠ 符号实例集合是文档级全集(含组内实例); 定义源不可访问时静默跳过(只统计)。
    function pfClrOvpIn(container, depth) {
      if (depth > 8) return;   // 符号内再套符号的防呆上限(检查端 SymbolItem 分支同款思路)
      var kids = null;
      try { kids = container.pageItems; } catch (eK) { return; }
      for (var ci = 0; ci < kids.length; ci++) {
        var kIt = kids[ci], kTn = "";
        try { kTn = kIt.typename; } catch (eKt) {}
        if (kTn === "GroupItem") { pfClrOvpIn(kIt, depth + 1); continue; }
        if (kTn === "CompoundPathItem") {
          // ⚠ v10.53(审查 A2): 符号下钻内是**逐个组件**处理 —— 与文档级循环的"复合路径
          //   自身"、检查端的 pathItems[0] 三处口径不同, 待真机验证后统一(见卡⑦ 检查端注释)。
          try {
            var kps = kIt.pathItems;
            for (var kp = 0; kp < kps.length; kp++) pfClrPath(kps[kp]);
          } catch (eKc) {}
          continue;
        }
        if (kTn === "TextFrame") { pfClrOvpFrame(kIt); continue; }
        if (kTn === "SymbolItem") {
          if (pfBlockInfo(kIt)) { skipped++; continue; }   // 隐藏/锁定: 跳过
          var kSrc = pfSymSource(kIt);   // v11.39: 三份重复的下钻收成一处
          if (kSrc && kSrc.pageItems) pfClrOvpIn(kSrc, depth + 1);
          continue;
        }
        pfClrPath(kIt);   // PathItem / MeshItem / PlacedItem 等: 属性读写有 try 兜底, 不匹配的类型不动
      }
    }
    try {
      var sis = doc.symbolItems;
      for (var si = 0; si < sis.length; si++) {
        var sIt = sis[si];
        if (uAll) unlocked += pfUnlockItem(sIt);
        if (pfBlockInfo(sIt)) { skipped++; continue; }   // 隐藏/锁定实例: 跳过(与检查端口径一致)
        // v12.7: 顶层实例的下钻同样走 pfSymSource —— v11.39 抽出来时只改了内层 kIt,
        //   这四处顶层循环各留了一份手抄, 等于"抽了一半"。口径与手抄版逐字一致。
        var sSrc = pfSymSource(sIt);
        if (sSrc && sSrc.pageItems) pfClrOvpIn(sSrc, 0);
      }
    } catch (eSym) {}

    res.ok = true;
    res.cleared = cleared; res.skipped = skipped; res.failed = failed;
    res.unlocked = unlocked;
    res.message = (cleared > 0 ? "已清除叠印 " + cleared + " 处" : "未发现可清除的叠印") +
      (unlocked > 0 ? "，解除锁定 " + unlocked + " 处" : "") +
      (skipped > 0 ? "，跳过 " + skipped + " 处(锁定/隐藏，状态未改动)" : "") +
      (failed > 0 ? "，失败 " + failed + " 处" : "") + "。";
  } catch (err) {
    res.ok = false;
    res.error = "清除叠印失败: " + String(err);
  }
  return pfReturn(res);
}

// ============================================================
// 一键转曲: 只转曲"可见且未锁定"的文字
// showAll/unlockAll 控制转曲前是否先解除隐藏/锁定;
// v3.9: "解锁"同时覆盖图层锁定与对象级锁定(Ctrl+2)、锁定组;
//       "显示"同时覆盖图层隐藏与对象级隐藏(Ctrl+3)。
//       未勾选项对应的阻挡状态原样保留,该文字跳过不转。
// ============================================================
function pfOutlineAll(showAll, unlockAll) {
  var res = { ok: false };
  try {
    if (app.documents.length === 0) { res.error = "当前没有打开的文档，请先打开一个 AI 文件。"; return pfReturn(res); }
    var doc = app.activeDocument;
    var sAll = (showAll === true);
    var uAll = (unlockAll === true);

    // v10.40: 「含显示隐藏」改为**临时显形** —— 转曲要处理隐藏文字, 但跑完必须把文档
    //   可见性复原。否则「全部清理」会**永久**显示隐藏图层(其转曲步默认勾了"含显示隐藏",
    //   而 pfUnlockLayer 是全文唯一改图层 visible 的地方), 与卡②「删除隐藏」"隐藏图层
    //   一律保留"的口径打架 —— 用户看到的是"跑完全部清理, 隐藏图层整支冒出来了, 于是
    //   再点删隐藏才删得掉, 单独点删隐藏却删不掉"。
    //   做法: 先记录**原本隐藏的图层**(含子图层, 递归), 跑完 visible=false 逐层还原;
    //   对象级(Ctrl+3)隐藏文字另在下面收集, 同样还原。只还原**可见性**, 不还原锁定
    //   —— 「解锁全部」是显式选择, 保持解锁(pfUnlockLayer 的 locked=false 不回滚)。
    var hiddenLayers = [];
    // v11.1(审查 ⑭): 同 pfUnlockLayer, 补深度上限 64 兜底异常 layers 环
    function snapHiddenLayers(ls, d) {
      if (d > PF_MAX_DEPTH) return;
      for (var sl = 0; sl < ls.length; sl++) {
        var L = ls[sl], visL = true;
        try { visL = (L.visible !== false); } catch (eVL) {}
        if (!visL) hiddenLayers.push(L);
        try { snapHiddenLayers(L.layers, (d || 0) + 1); } catch (eSL) {}
      }
    }
    if (sAll) { try { snapHiddenLayers(doc.layers); } catch (eSHL) {} }

    // 1. 按需解锁/显示全部图层(含子图层)
    if (sAll || uAll) {
      var layers = doc.layers;
      for (var i = 0; i < layers.length; i++) pfUnlockLayer(layers[i], uAll, sAll);
    }

    // 2. 转曲文字(倒序,避免集合变化导致漏转)
    //   v10.46: 循环体抽成 pfOutlineOne —— 符号定义源内的文字帧复用同一套
    //   (阻挡逐层解除 / 临时显形登记 / createOutline 计数)
    var done = 0, skipped = 0, failed = 0, unlocked = 0, unhidden = 0;
    // v10.40: 被**临时显形**的对象/组(非图层) —— 跑完 hidden=true 还原(图层级由
    //   snapHiddenLayers 覆盖, 这里只管对象/组一级)
    var restoreObjs = [];
    function pfOutlineOne(tf) {
      var info = null;
      try { info = pfBlockInfo(tf); } catch (e1) {}
      // 按勾选状态逐层解除阻挡: 对象→组→图层可能叠多层锁定/隐藏,
      // 旧版只解一层,遇到"锁定对象在锁定组内"会漏转(v3.3 修复),改为循环解除
      var guardB = 0;
      while (info && guardB++ < 10) {
        var clearable = (info.reason === "locked" && uAll) || (info.reason === "hidden" && sAll);
        if (!clearable || !pfClearBlock(info.node, info.reason)) break;
        if (info.reason === "locked") unlocked++;
        else {
          unhidden++;
          try { if (info.node && info.node.typename !== "Layer") restoreObjs.push(info.node); } catch (eRO) {}
        }
        try { info = pfBlockInfo(tf); } catch (e2) {}
      }
      if (info) { skipped++; return; }
      try { tf.createOutline(); done++; } catch (e) { failed++; }
    }
    var tfs = doc.textFrames;
    for (var i = tfs.length - 1; i >= 0; i--) pfOutlineOne(tfs[i]);

    // 2b. v10.46: 符号定义源内的文字下钻转曲。
    //   检查端 visitItem 的 SymbolItem 分支把符号内文字计入"未转曲", 而本函数原先
    //   只走 doc.textFrames(文档级, 不含符号内) ⇒ "扫出 N 个 / 转完还剩 N 个"。
    //   口径与检查端对齐: 隐藏/锁定实例按勾选状态逐层解除(与主循环同一套 while),
    //   仍未解除的跳过; 定义源内的文字帧再走 pfOutlineOne(自身阻挡同样按勾选处理)。
    function pfOutlineInSym(container, depth) {
      if (depth > 8) return;   // 符号内再套符号的防呆上限
      var kids = null;
      try { kids = container.pageItems; } catch (eK) { return; }
      for (var ci = 0; ci < kids.length; ci++) {
        var kIt = kids[ci], kTn = "";
        try { kTn = kIt.typename; } catch (eKt) {}
        if (kTn === "TextFrame") { pfOutlineOne(kIt); continue; }
        if (kTn === "GroupItem") { pfOutlineInSym(kIt, depth + 1); continue; }
        if (kTn === "SymbolItem") {
          if (pfBlockInfo(kIt)) { skipped++; continue; }
          var kSrc = pfSymSource(kIt);   // v11.39: 三份重复的下钻收成一处
          if (kSrc && kSrc.pageItems) pfOutlineInSym(kSrc, depth + 1);
          continue;
        }
        // 复合路径/位图等非文字对象: 无文字可转
      }
    }
    try {
      var sisO = doc.symbolItems;
      for (var siO = 0; siO < sisO.length; siO++) {
        var sItO = sisO[siO];
        var infoS = null;
        try { infoS = pfBlockInfo(sItO); } catch (e1s) {}
        var guardS = 0;
        while (infoS && guardS++ < 10) {
          var clearableS = (infoS.reason === "locked" && uAll) || (infoS.reason === "hidden" && sAll);
          if (!clearableS || !pfClearBlock(infoS.node, infoS.reason)) break;
          if (infoS.reason === "locked") unlocked++;
          else {
            unhidden++;
            try { if (infoS.node && infoS.node.typename !== "Layer") restoreObjs.push(infoS.node); } catch (eROs) {}
          }
          try { infoS = pfBlockInfo(sItO); } catch (e2s) {}
        }
        if (infoS) { skipped++; continue; }
        var sSrcO = pfSymSource(sItO);   // v12.7: 同 pfClearOverprint, 统一到 pfSymSource
        if (sSrcO && sSrcO.pageItems) pfOutlineInSym(sSrcO, 0);
      }
    } catch (eSymO) {}

    // v10.40: 复原可见性(临时显形结束) —— 先对象后图层(互不为祖先/后代, 顺序无关)
    // v11.39: 抽成函数, 正常路径与 catch 分支各调一次。
    //   原来这两行只写在函数末尾(try 之内), 中途任何未捕获异常都直接跳 catch ⇒ 复原整段
    //   被跳过 ⇒ 临时显形的隐藏图层/对象**永久显示**。这正是"半改状态"最典型的形状。
    //   ⚠ 本仓库零处使用 finally, 按现有风格(成对调用)实现, 不新引入 finally。
    //   ⚠ 两个数组都是 var 提升的函数级变量, 异常发生在赋值之前也能安全读到 undefined。
    function pfRestoreVis() {
      var arr, i;
      arr = restoreObjs || [];
      for (i = 0; i < arr.length; i++) { try { arr[i].hidden = true; } catch (eRq) {} }
      arr = hiddenLayers || [];
      for (i = 0; i < arr.length; i++) { try { arr[i].visible = false; } catch (eRl) {} }
    }
    pfRestoreVis();

    res.ok = true;
    res.outlined = done;
    res.skipped = skipped;
    res.failed = failed;
    res.unlocked = unlocked;
    res.unhidden = unhidden;
    res.message = "已转曲 " + done + " 个文本框" +
      (unlocked > 0 ? "，解除锁定 " + unlocked + " 处" : "") +
      (unhidden > 0 ? "，临时显示 " + unhidden + " 处(已复原可见性)" : "") +
      (skipped > 0 ? "，跳过 " + skipped + " 个(隐藏/锁定，未勾选对应选项)" : "") +
      (failed > 0 ? "，失败 " + failed + " 个" : "") + "。";
  } catch (err) {
    // v11.39: 异常路径也必须复原可见性 —— 否则用户会遇到"转曲失败了,
    //   但我原本藏起来的图层全冒出来了", 而且没有任何提示。
    try { pfRestoreVis(); } catch (eRV) {}
    res.ok = false;
    res.error = "转曲失败: " + String(err);
  }
  return pfReturn(res);
}

// v8.0: 统计"文档全部链接图 + 其中隐藏的" —— 供确认框如实说明嵌入范围。
//   背景: 检查端是树遍历"只含可见图"(v5.7),而 pfEmbedAll 走 doc.placedItems(**含隐藏**),
//   两处范围不同 ⇒ 卡片上的"链接图片 N 张" != 实际会被嵌入的张数。
//   隐藏判定: 对象自身 hidden,或任一祖先组 hidden,或所属图层 visible === false。
function pfCountAllLinks(doc) {
  var all = 0, hid = 0;
  try {
    var pls = doc.placedItems;
    all = pls.length;
    for (var i = 0; i < pls.length; i++) {
      var it = pls[i], isH = false;
      try { if (it.hidden === true) isH = true; } catch (e1) {}
      if (!isH) {
        var p = null;
        try { p = it.parent; } catch (e2) {}
        var guard = 0;
        while (p && guard++ < 64) {
          var tn = "";
          try { tn = p.typename; } catch (e3) {}
          if (tn === "Layer") {
            try { if (p.visible === false) isH = true; } catch (e4) {}
            break;   // 到图层即止(图层之下不再有祖先)
          }
          try { if (p.hidden === true) isH = true; } catch (e5) {}
          try { p = p.parent; } catch (e6) { break; }
        }
      }
      if (isH) hid++;
    }
  } catch (e0) {}
  return { all: all, hidden: hid };
}

// v8.1: 按需入口 —— 供前端"一键嵌入"确认框取"全部链接图 / 其中隐藏数"。
//   旧版在 runPreflight 末尾**无条件**统计一次(每轮检查都全文档遍历 placedItems),
//   但确认框只有点"嵌入"才看得到 ⇒ 绝大多数检查白跑一次。现改为点嵌入时单独调用。
function pfLinkScope() {
  var res = { ok: false };
  try {
    if (app.documents.length === 0) { res.error = "当前没有打开的文档，请先打开一个 AI 文件。"; return pfReturn(res); }
    var c = pfCountAllLinks(app.activeDocument);
    res.ok = true;
    res.all = c.all;
    res.hidden = c.hidden;
  } catch (e) { res.error = "统计链接图失败: " + String(e); }
  return pfReturn(res);
}

// ============================================================
// 一键嵌入所有链接图片
// v3.6~v9.8: PDF/AI/EPS 曾改为 300dpi 栅格化, "拼合为单张位图"。
// v9.9: **整条栅格化路已删除** —— 矢量链接也走原生 embed()。
//   v9.8 的"先复制副本再栅格化"在部分稿上会同时留下 1 张 300ppi 位图 + 1 个原生嵌入对象,
//   雪糕明确不要那张位图; 且栅格化本身会丢画板外内容(v9.8 修过一次仍属隐患)。
//   现在所有链接(矢量 / 位图)统一 embed(), 结果与在 AI 里手动"嵌入"一致。
// ============================================================
function pfEmbedAll() {
  var res = { ok: false };
  try {
    if (app.documents.length === 0) { res.error = "当前没有打开的文档，请先打开一个 AI 文件。"; return pfReturn(res); }
    var doc = app.activeDocument;

    var pls = doc.placedItems;
    var done = 0, failed = 0;
    var failedNames = []; // v4.6: 失败明细(文件名),便于用户定位问题图
    for (var i = pls.length - 1; i >= 0; i--) {
      var it = pls[i];
      var fp = "";
      try { fp = String(it.file.fsName); } catch (ef) {}
      var name = "";
      try { name = String(it.name); } catch (en2) {}
      if (!name || name === "") name = fp ? fp : "(链接图" + (i + 1) + ")";

      // v9.9: 全部走 AI 原生 embed() —— 矢量链接(PDF/AI/EPS)不再栅格化为 300ppi 位图。
      //   起因: v9.8 的"先复制副本再栅格化"在部分稿上会**同时**留下 1 张 300ppi 位图
      //   和 1 个原生嵌入对象(同一内容两份), 雪糕明确不要那张位图。
      //   删掉栅格化这条后: 嵌入结果与在 AI 里手动"嵌入"完全一致(内容可编辑),
      //   栅格化特有的丢图 / 裁切 / 与位图叠影三类风险一并消失;
      //   嵌入失败则如实计入 failedNames, 不再声称"已拼合为单张位图"。
      try { it.embed(); done++; } catch (e2) { failed++; failedNames.push(name); }
    }
    res.ok = true;
    res.embedded = done;
    res.failedNames = failedNames;
    res.message = "已嵌入 " + done + " 张链接图。" +
      (failed > 0 ? " 失败 " + failed + " 张:" + failedNames.join("、") + "。" : "");
  } catch (err) {
    res.ok = false;
    res.error = "嵌入失败: " + String(err);
  }
  return pfReturn(res);
}

// ============================================================
// v10.14: 叠印规则动作(自 zhiban v10.15~16 同源移植, 供卡⑦分级版「执行勾选项」)。
//   mode: "white"  -> 清除需处理叠印(纯白 + 彩色; 填充+描边、文字+图形)
//         "k100"   -> 为单黑对象新增叠印(填充+描边、文字+图形)
//   lockFirst: true 时先解锁全部图层, 再沿 parent 链解除对象锁定; 隐藏对象一律不碰。
//   返回 {ok, acted, skipped, failed, unlocked, message}。
function pfOverprintRule(mode, lockFirst) {
  var res = { ok: false };
  try {
    if (app.documents.length === 0) { res.error = "当前没有打开的文档，请先打开一个 AI 文件。"; return pfReturn(res); }
    var doc = app.activeDocument;
    var m = (mode === "k100") ? "k100" : "white";
    var lf = (lockFirst === true);
    var acted = 0, skipped = 0, failed = 0, unlocked = 0;

    // 1. 解锁前置(先解锁, 再处理)
    if (lf) {
      try {
        var lys = doc.layers;
        for (var li = 0; li < lys.length; li++) pfUnlockLayer(lys[li], true, false);
      } catch (eUL) {}
    }
    // 沿 parent 链解除该对象的**锁定**阻挡(解锁前置模式下);隐藏一律不动
    //   v11.1(审查 ⑤): 原先这里有第二份逐字相同的实现(pfUnlockItem2), 现共用模块级 pfUnlockItem。

    // 2. 文字(字符级, 与检查端同一粒度)
    //   v10.46: 循环体抽成 pfRuleFrame —— 符号定义源内的文字帧复用同一套
    function pfRuleFrame(tf) {
      if (lf) unlocked += pfUnlockItem(tf);
      if (pfBlockInfo(tf)) { skipped++; return; }   // 锁定/隐藏: 跳过
      try {
        var ca = tf.textRange.characterAttributes;
        var fc = null, sc = null;
        try { fc = ca.fillColor; } catch (eFc) {}
        try { sc = ca.strokeColor; } catch (eSc) {}
        // 填充
        // v10.39: 只在**真的发生改变**时才计入 acted(与 pfClearOverprint 的
        //   `if (pfCharOvpFill(ca) || ...) { ...; cleared++; }` 口径对齐)。原先"命中颜色
        //   就 +1" ⇒ 报出的 N 是命中颜色数, 不是实际关掉/打开的处数(重复执行同一条规则
        //   会再次报出同一个 N)。
        if (fc && pfColorMatchMode(fc, m)) {
          try {
            if (m === "white") { if (pfCharOvpFill(ca)) { ca.overprintFill = false; acted++; } }
            else { if (!pfCharOvpFill(ca)) { ca.overprintFill = true; acted++; } }
          } catch (eW1) { failed++; }
        }
        // 描边(仅当描边生效才处理)
        var strokeOn = false;
        try { strokeOn = (ca.strokeWeight > 0); } catch (eSw) {}
        if (strokeOn && sc && pfColorMatchMode(sc, m)) {
          try {
            if (m === "white") { if (pfCharOvpStroke(ca)) { ca.overprintStroke = false; acted++; } }
            else { if (!pfCharOvpStroke(ca)) { ca.overprintStroke = true; acted++; } }
          } catch (eW2) { failed++; }
        }
      } catch (eT) { failed++; }
    }
    var tfs = doc.textFrames;
    for (var i = tfs.length - 1; i >= 0; i--) pfRuleFrame(tfs[i]);

    // 3. 图形(pageItem 级: PathItem 与 CompoundPathItem 各一遍)
    function pfRulePath(pi) {
      if (lf) unlocked += pfUnlockItem(pi);
      if (pfBlockInfo(pi)) { skipped++; return; }
      var fOn = false, sOn = false;
      try { fOn = (pi.filled === true); } catch (eFo) {}
      try { sOn = (pi.stroked === true); } catch (eSo) {}
      if (fOn) {
        var fc2 = null; try { fc2 = pi.fillColor; } catch (e1) {}
        if (fc2 && pfColorMatchMode(fc2, m)) {
          try {
            // v10.39: 同文字侧 —— 只计真实改变
            if (m === "white") { if (pfOvpFill(pi)) { pi.fillOverprint = false; acted++; } }
            else { if (!pfOvpFill(pi)) { pi.fillOverprint = true; acted++; } }
          } catch (e2) { failed++; }
        }
      }
      if (sOn) {
        var sc2 = null; try { sc2 = pi.strokeColor; } catch (e3) {}
        if (sc2 && pfColorMatchMode(sc2, m)) {
          try {
            if (m === "white") { if (pfOvpStroke(pi)) { pi.strokeOverprint = false; acted++; } }
            else { if (!pfOvpStroke(pi)) { pi.strokeOverprint = true; acted++; } }
          } catch (e4) { failed++; }
        }
      }
    }
    try { var ps = doc.pathItems; for (var j = ps.length - 1; j >= 0; j--) pfRulePath(ps[j]); } catch (ePS) {}
    // ⚠ v10.53(审查 A2): 同 pfClearOverprint —— CompoundPathItem 自身 vs 检查端的
    //   pathItems[0] vs 符号下钻内的逐组件, 三口径不同, 待真机验证后统一。
    try { var cps = doc.compoundPathItems; for (var k = cps.length - 1; k >= 0; k--) pfRulePath(cps[k]); } catch (eCPS) {}

    // 3b. v10.46: 符号定义源内的对象(文字帧 + 路径)下钻执行规则。
    //   与 pfClearOverprint 同根因: 检查端统计含符号内对象, 本函数原先只走文档级
    //   扁平集合 ⇒ 分级版"执行勾选项"对符号内叠印无效, 卡上数字清完不变。
    //   口径同检查端: 隐藏/锁定实例跳过; 定义源内对象各自判定, 不重复计数。
    function pfRuleInSym(container, depth) {
      if (depth > 8) return;   // 符号内再套符号的防呆上限
      var kids = null;
      try { kids = container.pageItems; } catch (eK) { return; }
      for (var ci = 0; ci < kids.length; ci++) {
        var kIt = kids[ci], kTn = "";
        try { kTn = kIt.typename; } catch (eKt) {}
        if (kTn === "GroupItem") { pfRuleInSym(kIt, depth + 1); continue; }
        if (kTn === "CompoundPathItem") {
          // ⚠ v10.53(审查 A2): 同 pfClrOvpIn —— 逐组件处理, 与文档级"复合路径自身"、
          //   检查端 pathItems[0] 口径不同, 待真机验证后统一。
          try {
            var kps = kIt.pathItems;
            for (var kp = 0; kp < kps.length; kp++) pfRulePath(kps[kp]);
          } catch (eKc) {}
          continue;
        }
        if (kTn === "TextFrame") { pfRuleFrame(kIt); continue; }
        if (kTn === "SymbolItem") {
          if (pfBlockInfo(kIt)) { skipped++; continue; }
          var kSrc = pfSymSource(kIt);   // v11.39: 三份重复的下钻收成一处
          if (kSrc && kSrc.pageItems) pfRuleInSym(kSrc, depth + 1);
          continue;
        }
        pfRulePath(kIt);   // PathItem / MeshItem 等: 属性读写有 try 兜底, 不匹配的类型不动
      }
    }
    try {
      var sisR = doc.symbolItems;
      for (var siR = 0; siR < sisR.length; siR++) {
        var sItR = sisR[siR];
        if (lf) unlocked += pfUnlockItem(sItR);
        if (pfBlockInfo(sItR)) { skipped++; continue; }
        var sSrcR = pfSymSource(sItR);   // v12.7: 同 pfClearOverprint, 统一到 pfSymSource
        if (sSrcR && sSrcR.pageItems) pfRuleInSym(sSrcR, 0);
      }
    } catch (eSymR) {}

    res.ok = true;
    res.acted = acted; res.skipped = skipped; res.failed = failed; res.unlocked = unlocked;
    var label = (m === "white") ? "已清除需处理叠印" : "已为单黑对象新增叠印";
    res.message = (acted > 0 ? label + " " + acted + " 处" : (m === "white" ? "未发现需处理的叠印" : "未发现可新增叠印的单黑对象")) +
      (lf && unlocked > 0 ? "，解除锁定 " + unlocked + " 处" : "") +
      (skipped > 0 ? "，跳过 " + skipped + " 处(锁定/隐藏，状态未改动)" : "") +
      (failed > 0 ? "，失败 " + failed + " 处" : "") + "。";
  } catch (err) {
    res.ok = false;
    res.error = "叠印规则处理失败: " + String(err);
  }
  return pfReturn(res);
}
// 颜色是否命中规则: "white" 判**需处理叠印**(纯白 + 彩色); "k100" 判单黑。
//   即: white 模式命中 = 非 k100 且 非 spot(= 纯白 white 或 彩色 color),
//   与界面「需处理叠印」口径一致(否则"勾了清除需处理叠印, 彩色却还在")。
function pfColorMatchMode(c, m) {
  try {
    var cls = pfOvpClass(c).cls;
    if (m === "white") return (cls === "white" || cls === "color");   // 需处理 = 纯白 + 彩色
    if (m === "k100") return cls === "k100";
    return false;
  } catch (e) { return false; }
}
// 前端入口包装(两个独立函数, 便于按钮各自调用)
function pfClearWhiteOverprint(lockFirst) { return pfOverprintRule("white", lockFirst); }
function pfAddK100Overprint(lockFirst) { return pfOverprintRule("k100", lockFirst); }

// ============================================================
// v11.91: 四色黑 → 单黑(C0 M0 Y0 K100)
//   雪糕 2026-11-19: "油墨卡加个按钮吧, 四色黑 → 单黑"。
//
//   v11.93(雪糕): **不再顺手加叠印** —— 只改颜色, 叠印状态原样保留。
//     v11.91/11.92 曾按自动制版 Step4 的做法把填充/描边叠印一并设为 true
//     (理由: 单黑不叠印会露白边), 雪糕明确不要这个副作用 ⇒ 本函数从此**不写**
//     fillOverprint / strokeOverprint / overprintFill / overprintStroke 任何一个。
//     ⚠ 原本就带叠印的对象, 转完仍带叠印(不去动它); 要不要叠印交给叠印卡那张卡管。
//
//   口径(与检查端**逐条同源**, 避免"报 N 处、点下去只改 M 处"):
//     · 文字: 只处理填充(检查端文字侧只读 ca.fillColor) —— 与油墨总量/四色黑统计同口径;
//     · 图形: 填充 + 描边(pathItems 与 compoundPathItems 各一遍);
//     · 符号定义源下钻(与 pfOverprintRule 同一套), 否则符号里的四色黑点了没反应;
//     · 隐藏/锁定对象: 不擅自改, 计入 skipped 如实回报(lockFirst 时才先解锁)。
//
//   ⚠ 与自动制版刻意不同的两处:
//     ① **不做**"裁切路径只处理描边"那条特殊分支 —— 这里按对象本身读写, 不碰 clipping 语义;
//     ② 复合路径按**自身**读写(与 pfOverprintRule 一致), 不逐组件改 —— 同一复合路径的
//        各组件共用一个填充, 逐组件写等于重复写同一笔, 还会让"改了 N 处"虚高。
//
//   写后核验: 每个改过的通道都读回一次, 必须是 pfIsK100Raw(单黑) 才计 acted。
//   Illustrator 对"写入不报错但没接受"的情况是存在的(自动制版 Step4 真机踩过),
//   所以不靠"赋值没抛异常"推定成功。
// ============================================================
function pfRichBlackToK100(lockFirst) {
  var res = { ok: false };
  try {
    if (app.documents.length === 0) { res.error = "当前没有打开的文档，请先打开一个 AI 文件。"; return pfReturn(res); }
    var doc = app.activeDocument;
    var lf = (lockFirst === true);
    var acted = 0, skipped = 0, failed = 0, unlocked = 0;

    function k100() {
      var c = new CMYKColor();
      c.cyan = 0; c.magenta = 0; c.yellow = 0; c.black = 100;
      return c;
    }

    // 1. 解锁前置(与 pfOverprintRule 同款: 只解图层与锁定链, 不动隐藏)
    if (lf) {
      try {
        var lys = doc.layers;
        for (var li = 0; li < lys.length; li++) pfUnlockLayer(lys[li], true, false);
      } catch (eUL) {}
    }

    // 2. 文字(字符级填充)
    function convFrame(tf) {
      if (lf) unlocked += pfUnlockItem(tf);
      if (pfBlockInfo(tf)) { skipped++; return; }
      try {
        var ca = tf.textRange.characterAttributes;
        // v12.12(雪糕: "文字描边也判断可以么"): 填充与描边**各判各改**。
        //   原实现是 `if (!fc || !pfRichBlackChk(fc)) return;` —— 填充不是四色黑就整帧早退,
        //   描边永远没机会被处理, 于是"检查端报了描边、动作端转不到"。
        var fc = null;
        try { fc = ca.fillColor; } catch (eFc) {}
        if (fc && pfRichBlackChk(fc)) {
          try {
            // v11.93: 只写颜色 —— 叠印一个都不碰(见函数头)
            ca.fillColor = k100();
            // 核验: 颜色确为单黑
            var nf = null;
            try { nf = ca.fillColor; } catch (eV1) {}
            if (pfIsK100Raw(nf)) acted++; else failed++;
          } catch (eW) { failed++; }
        }
        var scT = null;
        try { scT = ca.strokeColor; } catch (eScT) {}
        if (scT && pfRichBlackChk(scT)) {
          try {
            ca.strokeColor = k100();
            var nsT = null;
            try { nsT = ca.strokeColor; } catch (eV6) {}
            if (pfIsK100Raw(nsT)) acted++; else failed++;
          } catch (eWs) { failed++; }
        }
      } catch (eT) { failed++; }
    }
    try {
      var tfs = doc.textFrames;
      for (var i = tfs.length - 1; i >= 0; i--) convFrame(tfs[i]);
    } catch (eTF) {}

    // 3. 图形(填充 + 描边)
    function convPath(pi) {
      if (lf) unlocked += pfUnlockItem(pi);
      if (pfBlockInfo(pi)) { skipped++; return; }
      var fOn = false, sOn = false;
      try { fOn = (pi.filled === true); } catch (eFo) {}
      try { sOn = (pi.stroked === true); } catch (eSo) {}
      if (fOn) {
        var fc2 = null; try { fc2 = pi.fillColor; } catch (e1) {}
        if (fc2 && pfRichBlackChk(fc2)) {
          try {
            pi.fillColor = k100();
            var nf2 = null;
            try { nf2 = pi.fillColor; } catch (eV3) {}
            if (pfIsK100Raw(nf2)) acted++; else failed++;
          } catch (e2) { failed++; }
        }
      }
      if (sOn) {
        var sc2 = null; try { sc2 = pi.strokeColor; } catch (e3) {}
        if (sc2 && pfRichBlackChk(sc2)) {
          try {
            pi.strokeColor = k100();
            var ns2 = null;
            try { ns2 = pi.strokeColor; } catch (eV5) {}
            if (pfIsK100Raw(ns2)) acted++; else failed++;
          } catch (e4) { failed++; }
        }
      }
    }
    try { var ps = doc.pathItems; for (var j = ps.length - 1; j >= 0; j--) convPath(ps[j]); } catch (ePS) {}
    try { var cps = doc.compoundPathItems; for (var k = cps.length - 1; k >= 0; k--) convPath(cps[k]); } catch (eCPS) {}

    // 3b. 符号定义源下钻(与 pfOverprintRule 同一套, 否则符号里的四色黑点了没反应)
    function convInSym(container, depth) {
      if (depth > 8) return;
      var kids = null;
      try { kids = container.pageItems; } catch (eK) { return; }
      for (var ci = 0; ci < kids.length; ci++) {
        var kIt = kids[ci], kTn = "";
        try { kTn = kIt.typename; } catch (eKt) {}
        if (kTn === "GroupItem") { convInSym(kIt, depth + 1); continue; }
        if (kTn === "CompoundPathItem") { convPath(kIt); continue; }
        if (kTn === "TextFrame") { convFrame(kIt); continue; }
        if (kTn === "SymbolItem") {
          if (pfBlockInfo(kIt)) { skipped++; continue; }
          var kSrc = pfSymSource(kIt);
          if (kSrc && kSrc.pageItems) convInSym(kSrc, depth + 1);
          continue;
        }
        convPath(kIt);
      }
    }
    try {
      var sis = doc.symbolItems;
      for (var si = 0; si < sis.length; si++) {
        var sIt = sis[si];
        if (lf) unlocked += pfUnlockItem(sIt);
        if (pfBlockInfo(sIt)) { skipped++; continue; }
        var sSrc = pfSymSource(sIt);   // v12.7: 同 pfClearOverprint, 统一到 pfSymSource
        if (sSrc && sSrc.pageItems) convInSym(sSrc, 0);
      }
    } catch (eSym) {}

    res.ok = true;
    res.acted = acted; res.skipped = skipped; res.failed = failed; res.unlocked = unlocked;
    res.message = (acted > 0 ? "四色黑已转单黑 " + acted + " 处（C0 M0 Y0 K100，叠印状态未改动）" : "未发现四色黑（四通道之和 >=" + PF_RB_SUM + "%）") +
      (lf && unlocked > 0 ? "，解除锁定 " + unlocked + " 处" : "") +
      (skipped > 0 ? "，跳过 " + skipped + " 处（锁定/隐藏，状态未改动）" : "") +
      (failed > 0 ? "，失败 " + failed + " 处（写入后核验未通过，请人工检查）" : "") + "。";
  } catch (err) {
    res.ok = false;
    res.error = "四色黑转单黑失败: " + String(err);
  }
  return pfReturn(res);
}


// ============================================================
// v11.87: 卡⑨「专色描边」—— 按颜色关系决定给谁加同色叠印描边(手工陷印)
//   整套由 zhiban v0.9.2(jsx PF_BUILD 0.5.11) 移植; 规则由雪糕定, 2026-10-21 二次确认:
//     专色 ↔ 四色 ................ 两边都加(优先)
//     专色 ↔ 专色 ................ 两边都加(优先)
//     专色 ↔ 白色块(C0M0Y0K0) .... **不加**
//     专色 ↔ 纸白/空白 ........... **不加**
//     四色 ↔ 四色 ................ 不加
//     白色对象 ................... 不加, 也**不作为相邻源**
//     专色压在四色上(重叠) ....... 算相邻 ⇒ 要加
// v11.96(雪糕 2026-11-23): **已经有其他颜色描边的图元一律不动。**
//   描边是原设计的一部分(白边、金边、客户指定描边), 拿陷印描边去覆盖它是改稿不是修稿。
//   ⇒ 只给"没有描边"的图元新建同色描边 + 叠印; 已有同色描边的只补宽度/叠印; 已有别色的跳过。
//   三态判定统一走 pfStrokeState(0 无描边 / 1 同色 / 2 别色), 统计/选中/执行三处同源。
// v11.96 同日: 纸色[Paper] / 白色[White] 在 DOM 里是 SpotColor 壳, 必须按"无墨"归类
//   (见 pfIsNoInkSpot) —— 否则它们既进邻居池又不当遮挡物, "白块隔开两层墨"完全失效。
//   ⇒ **两侧都要过相邻判定**, 侧别不同、邻居口径不同:
//     · 专色 → 与「四色 或 另一个专色」相邻才加(bbox 接触/重叠)
//     · 四色 → 与「专色」相邻才加
//     · 白色 → 跳过, 且不进参照池(否则"专色贴白"会被白拉进来加描边)
//
// 相邻判定 = geometricBounds 矩形间隙近似:
//   横、纵间隙都 <= PF_TRAP_TOL(pt) 即判相邻(重叠时间隙为 0)。
//   ⚠ 误报场景: L 形/斜切/镂空 —— 盒子碰上了但图形没碰 ⇒ 给不挨专色的四色也加了描边,
//     它若压在别的四色上会混色。雪糕已确认接受此近似。
//
// ⚠ 描边只能整圈(无"只画某条边"的脚本接口) ⇒ 需要加的专色, 其贴白那侧也会外扩 W/2。
//   即"专色贴白不加"只能做到"不为白而加", 做不到"加了之后白侧没有描边"。
// ⚠ 叠印 = 两墨叠加 ⇒ 专色压在专色/四色上, 交界出现混色带(工艺代价, 已确认)。
//
// 移植差异(与 zhiban 源文件的三处不同, 均为**等价改写**, 不改变行为):
//   ① mm→pt 用本文件的 MMPT 常量(源文件叫 MM2PT);
//   ② 源文件用 pfColorKey(字符串键)比较描边色与填充色, 本文件 v11.73 已删掉那个函数
//      ⇒ 改用 pfTrapColorSame(): 专色比「色板名 + tint」, 印刷色走既有的
//      pfColorParts / pfColorSameParts 容差比较(与色板卡的判定同源);
//   ③ bbox 归一化在**收集时算一次**并存进 entry(nx0/nx1/ny0/ny1)。源文件每比较一对
//      就重新归一化两侧, 而相邻判定是 O(专色 × 参照池) 的双重循环 —— 大稿上那笔
//      重复计算会白烧几百万次属性读取。判定结果逐字不变。
// ============================================================

// 相邻容差: 0.05mm ≈ 0.14pt。共边图形 bbox 间隙通常是 0(或极小浮点差), 留一点余量。
var PF_TRAP_TOL = 0.2;   // pt

// v11.97: 选全 → 执行 之间的**交接名单**。
//   起因(雪糕 2026-11-23 的稿子): 卡片报"需加 27、已加 17、待加 10", 提示条却说
//   "已选中 28 个对象…已加描边叠印: 专色 1 + 四色 17"。也就是说 **选区里少了 10 个**,
//   它们既没被写、也没落进任何计入的桶 —— 无声消失, 待加永远停在 10。
//   根因: 执行端按 `doc.selection` 反推要处理谁。而 Illustrator 的选区是**有损的**:
//     ① 组内子对象赋值 `doc.selection = [...]` 会**上浮成父组**(隔离模式之外选不中孙子);
//     ② 只要有一个对象不可选, 整批赋值抛异常, 退回逐个 `selected = true` 时**静默失败**;
//     ③ 多图层/锁定态下选区的实际内容与赋进去的数组并不老是等价。
//   ⇒ 执行端不能再"照着选区猜", 必须拿**选全那一刻算出来的同一份名单**。
//   名单只在内存里活一跳: pfSpotSelectAll 写, pfSpotTrap **读完即清**,
//   并比对 doc 引用 —— 换了文档就当没有, 绝不让上一份稿子的对象漏到这一份来。
var PF_TRAP_PENDING = null;
var PF_TRAP_DOC = null;

// v11.96: 「实际无墨」的专色壳 —— 纸色 / 白色 / 0% 网点 / 全局 Process 且底色为 0
//   为什么必须单独认出来(雪糕 2026-11-23 的条码案例):
//     纸色[Paper] 与 白色[White] 在 AI 的 DOM 里都是 **SpotColor 壳**, 只按 typename 分类
//     会把它们当成"专色" ⇒ 既进了陷印邻居池、又**不承担遮挡作用**。而白色在整套规则里
//     有两个职责: ① 自己不加描边; ② 把上下两个墨层隔开(专色压白不陷印)。
//     结果就是: 绿底专色 / 中间白块 / 顶层四色条码, 三者的 bbox 层层叠合 ⇒ 条码被判成
//     "与专色相邻" ⇒ 四色被加了描边。v11.95 的遮挡判定只认 C0M0Y0K0 的 CMYK 白,
//     碰上"用[白色]/[纸色]色板铺的白"就完全失效 —— 这里补上。
//   ⚠ 只认"确实不上墨"的: 名字是白色/纸色, 或 tint 为 0, 或 Process 壳折算后四通道全 0。
//     套版色[Registration]、真正的专色一律不在此列。
var PF_WHITE_SW = /^(?:\[?(?:纸色|白色|White|Paper)\]?)$/i;
function pfIsNoInkSpot(c) {
  try {
    var nm = (c.spot && c.spot.name) ? String(c.spot.name) : "";
    if (PF_WHITE_SW.test(nm)) return true;
    var t = (typeof c.tint === "number") ? c.tint : 100;
    if (t <= 0.01) return true;                    // 0% 网点 = 不上墨
    var m = t / 100;
    if (c.spot && c.spot.colorType === ColorModel.PROCESS) {
      var base = c.spot.color;
      if (base && base.typename === "CMYKColor") {
        return (Math.abs(base.cyan) * m < 0.5 && Math.abs(base.magenta) * m < 0.5 &&
                Math.abs(base.yellow) * m < 0.5 && Math.abs(base.black) * m < 0.5);
      }
    }
  } catch (e) {}
  return false;
}

// 填充色分类: "spot" 专色 / "white" 白色(不上墨) / "cmyk" 四色 / "other" 渐变图案等
//   ⚠ v12.13(雪糕 2026-11-25 "问题11.25.ai" 真机实测): **灰度 0% 与 RGB 纯白也是"白"**。
//     旧实现把 GrayColor / RGBColor 一律归 "other" ⇒ 灰白色块既不进参照池、也**不承担遮挡**
//     ⇒ 压在它上面的四色/专色照样被判成"贴着底下的专色" ⇒ 二维码被白底托着却加了描边。
//     那份稿子里两块白底都是 GrayColor(gray=0)(不是 C0M0Y0K0), 正是踩在这条上。
//     灰 0 与 RGB 255/255/255 在视觉与制版上都等同于纸白, 必须与 C0M0Y0K0 同待遇。
//     ⚠ 只认"真的不上墨"的: 灰 1% 以上、RGB 不到纯白, 仍然归 "other" 不参与(不做过度扩张)。
function pfFillKind(c) {
  if (!c) return "other";
  var t = "";
  try { t = c.typename; } catch (e) { return "other"; }
  if (t === "SpotColor") return pfIsNoInkSpot(c) ? "white" : "spot";   // v11.96: 纸色/白色算白
  if (t === "CMYKColor") {
    try {
      if (Math.abs(c.cyan) < 0.01 && Math.abs(c.magenta) < 0.01 &&
          Math.abs(c.yellow) < 0.01 && Math.abs(c.black) < 0.01) return "white";
    } catch (e2) {}
    return "cmyk";
  }
  if (t === "GrayColor") {                     // v12.13: 灰 0% = 纸白
    try { if (Math.abs(c.gray) < 0.01) return "white"; } catch (e3) {}
    return "other";
  }
  if (t === "RGBColor") {                      // v12.13: RGB 纯白 = 纸白
    try { if (c.red >= 254 && c.green >= 254 && c.blue >= 254) return "white"; } catch (e4) {}
    return "other";
  }
  return "other";   // 渐变 / 图案 / 灰度(非 0) / RGB(非纯白) / 无填充
}

// v12.13(雪糕 2026-11-25 真机实测): **复合路径读不到自身的 filled / fillColor**
//   (AI 28.0.0 上 CompoundPathItem 的 filled / strokeWidth / strokeColor 全读成 undefined)。
//   后果比想象中严重 —— 旧代码在 pfTrapCollect 里 `filled === true` 取假就 return, 于是
//   复合路径**从来没进过参照池**:
//     · 转曲后的文字(那份稿子的「精选大豆油」= 5 个复合路径)一个描边都加不上;
//     · 二维码的定位角标(2 子路径的环)也从来加不上;
//     · 它同样不能当遮挡物 / 邻居(这一条在复合路径上本来是空转, 因为多数复合路径没填色)。
//   修法: 自身读不到就**回退到子路径** —— 复合路径的填色本来就存在 pathItems 上,
//   与手动在 AI 里给复合路径上色是同一条路。只读第一个"有填色"的子路径, 不猜。
//   返回 { on: 是否有填色, c: 填色(读不到为 null) }。
function pfNodeFill(node) {
  if (!node) return { on: false, c: null };
  var on = false, c = null;
  try { if (node.filled === true) on = true; } catch (e0) {}
  try { var x = node.fillColor; if (x) c = x; } catch (e1) {}
  if (on && c) return { on: true, c: c };
  var subs = null;
  try { subs = node.pathItems; } catch (e2) { subs = null; }
  if (!subs) return { on: on, c: c };
  var n = 0; try { n = subs.length; } catch (e3) { n = 0; }
  for (var i = 0; i < n; i++) {
    var sOn = false, sC = null;
    try { if (subs[i].filled === true) sOn = true; } catch (e4) {}
    try { var y = subs[i].fillColor; if (y) sC = y; } catch (e5) {}
    if (sOn && sC) return { on: true, c: sC };
  }
  return { on: on, c: c };
}

// v11.96: 半强度地判"同一个颜色族" —— 只看**色板/四值**, 不要求 tint 完全相等。
//   用途: 区分"这条描边是照我们的口径加的"(同族, 可以对齐 tint) 还是"原设计另画的一条"
//   (别的颜色, 一个像素都不能动)。tint 差异(60% 填充 + 100% 描边)属于前者 —— 那正是
//   v11.73 修过的老 bug(把 tint 100 的描边误判成"已处理"), 不能因为本轮改了跳过规则
//   又把它放回来。
function pfSameFamily(a, b) {
  if (!a || !b) return false;
  var ta = "", tb = "";
  try { ta = a.typename; } catch (e1) { return false; }
  try { tb = b.typename; } catch (e2) { return false; }
  if (ta !== tb) return false;
  if (ta === "SpotColor") {
    try {
      var na = a.spot && a.spot.name, nb = b.spot && b.spot.name;
      return String(na) === String(nb);
    } catch (e3) { return false; }
  }
  try { return pfColorSameParts(pfColorParts(a), b); } catch (e4) {}
  return false;
}

// v11.96: 图元的描边状态 —— 三态, 统计/选中/执行三处**必须同源**(否则又是"说 N 做 M")
//   0 = 没有描边(未描边, 或描边宽 <= 0 —— 宽度 0 的描边视觉上不存在, 按"没有"处理)
//   1 = 有描边且与填充**同族**(同色板/同四值)
//   2 = 有描边但**是别的颜色**(白边、金边、客户指定的描边)
//   ⚠ v11.95(雪糕 2026-11-24): 1 和 2 **行为已经一致 —— 都一动不动**。
//     起因: 手工加的 3mm 同色描边被面板的 0.2mm 覆盖掉了。现在只要"有描边"就只计数、
//     不改宽度/颜色/叠印; 要改请用户自己先清掉描边。
//     三态仍保留, 是因为界面要能分开说"已有描边"与"未描边", 将来也可能分档提示。
//   雪糕 2026-11-23: "如果专色本身有其他颜色的描边，按按钮后不要把描边改成专色描边
//   并叠印，只改没有描边的专色进行描边。"
//   ⚠ 判"同族"而不是"完全相同"见 pfSameFamily 的说明: tint 不同仍是同一条陷印描边。
// v12.13: 只判**一个**目标对象的描边状态(不改任何属性) —— pfStrokeState 的内核。
//   拆出来是因为复合路径要逐个看子路径(见下面 pfStrokeState 的说明)。
function pfStrokeStateOf(t, fc) {
  if (!t) return 0;
  var sOn = false; try { sOn = (t.stroked === true); } catch (e0) { sOn = false; }
  if (!sOn) return 0;
  var w = 0; try { w = t.strokeWidth; } catch (e1) { w = 0; }
  if (!(typeof w === "number" && w > 0)) return 0;
  var sc = null; try { sc = t.strokeColor; } catch (e2) { sc = null; }
  if (!sc) return 0;                     // 描边开着却读不到颜色 ⇒ 当没有处理(保守: 不去动它)
  try { return pfSameFamily(sc, fc) ? 1 : 2; } catch (e3) {}
  return 2;
}
function pfStrokeState(pi, fc) {
  var st = pfStrokeStateOf(pi, fc);
  if (st > 0) return st;
  // v12.13: 复合路径自身读不到 stroked/strokeWidth/strokeColor(AI 28.0.0 实测)
  //   ⇒ 回退到子路径: **任一**子路径有描边就算"有"。
  //   不这么做的话, 转曲文字上原设计画好的描边会被当成"没描边", 再被面板盖一层。
  var subs = null; try { subs = pi.pathItems; } catch (e4) { subs = null; }
  if (!subs) return st;
  var n = 0; try { n = subs.length; } catch (e5) { n = 0; }
  for (var i = 0; i < n; i++) {
    var s2 = pfStrokeStateOf(subs[i], fc);
    if (s2 > 0) return s2;
  }
  return 0;
}

// 递归一个节点: 组往下钻, 文字单独回调(kind="text"), 路径交出去(kind="path")
//   v12.6: 补深度闸 —— 全文件其余递归(主扫描/色板/清理/转曲/叠印)都有 PF_MAX_DEPTH,
//     只有专色这一对没有, 是唯一的缺口。组嵌套异常深或层树损坏时, 这里会栈溢出。
//     缺省(老调用点仍按两参)从 0 起算, 行为不变。
function pfSpotWalk(node, fn, depth) {
  if (depth === undefined) depth = 0;
  if (depth > PF_MAX_DEPTH) return;
  var tn = ""; try { tn = node.typename; } catch (e0) { return; }
  if (tn === "GroupItem") {
    var its = null; try { its = node.pageItems; } catch (e1) { its = null; }
    if (its) { var n = its.length; for (var i = 0; i < n; i++) pfSpotWalk(its[i], fn, depth + 1); }
    return;
  }
  if (tn === "TextFrame") { fn(null, "text"); return; }
  if (tn === "PathItem" || tn === "CompoundPathItem") { fn(node, "path"); return; }
}

// 递归一个图层(含子图层) —— 注意 layer.pageItems **不含**子图层内容, 必须分开递归
//   ⚠ 图层嵌套与对象组嵌套**分开计数**(各 64): 层内对象重新从 0 起算, 与原来一致。
function pfSpotWalkLayer(ly, fn, depth) {
  if (depth === undefined) depth = 0;
  if (depth > PF_MAX_DEPTH) return;
  // v11.90: 对照层不参与专色统计 —— 栅格即使带着专色信息, 也不该被算成"需要陷印的图元"。
  if (pfIsAuxLayer(ly)) return;
  var its = null; try { its = ly.pageItems; } catch (e0) { its = null; }
  if (its) { var n = its.length; for (var i = 0; i < n; i++) pfSpotWalk(its[i], fn, 0); }
  var subs = null; try { subs = ly.layers; } catch (e1) { subs = null; }
  if (subs) { var m = subs.length; for (var j = 0; j < m; j++) pfSpotWalkLayer(subs[j], fn, depth + 1); }
}

// 收集文档里所有"参与陷印"的填充图元(含 bbox) —— 统计与执行共用
//   ⚠ geometricBounds = [left, top, right, bottom]。AI 坐标系 y 轴向上为正,
//     所以 **top 的数值 > bottom**(和网页的 y 向下相反) ⇒ 判定前一律先归一化, 别直接比较。
//   ⚠ 渐变/图案/RGB/灰度/无填充一律不收(规则里没有它们的位置)
function pfTrapCollect(doc) {
  var out = { items: [], textSkipped: 0, capped: false };
  var CAP = 4000;   // 防超大文档卡死
  function onNode(node, kind) {
    if (kind === "text") { out.textSkipped++; return; }
    if (out.items.length >= CAP) { out.capped = true; return; }
    // v12.13: 用 pfNodeFill 而不是直接读 node.filled —— 复合路径的 filled/fillColor
    //   在 AI 28.0.0 上读不到, 直读会把**转曲文字**整体漏掉(见 pfNodeFill 的说明)。
    var fo = pfNodeFill(node);
    if (!fo.on) return;
    var fc = fo.c;
    var k = pfFillKind(fc);
    if (k === "other") return;
    var b = null; try { b = node.geometricBounds; } catch (e3) {}
    if (!b || b.length < 4) return;
    out.items.push({
      it: node, kind: k, l: b[0], t: b[1], r: b[2], b: b[3],
      // v11.99: 存一份填充色 —— 遮挡判定要判断"中间那层是不是同一种墨"(见 pfObstructed)
      fc: fc,
      // 归一化后的大小值(x0<x1 / y0<y1), 相邻判定直接读它 —— 见上方移植差异 ③
      nx0: (b[0] < b[2] ? b[0] : b[2]), nx1: (b[0] < b[2] ? b[2] : b[0]),
      ny0: (b[1] < b[3] ? b[1] : b[3]), ny1: (b[1] < b[3] ? b[3] : b[1]),
      // v11.95: 绘制序号(= 本数组下标)。pfSpotWalkLayer 的遍历顺序就是 AI 的绘制
      //   顺序(图层下→上, 容器内下→上, 子图层整体在父层对象之上), 所以下标越大越靠上。
      //   遮挡判定(pfObstructed)拿它比较谁夹在谁中间 —— 见下方"遮挡"一节。
      z: out.items.length
    });
  }
  try {
    var lys = doc.layers;
    var ln = lys.length;
    for (var i = 0; i < ln; i++) pfSpotWalkLayer(lys[i], onNode);
  } catch (e) {}
  return out;
}

// 取归一化盒(已有 nx0 的直接返回; 手搓的 {l,t,r,b} 现算一份)
//   ⚠ 不假设轴向 —— AI 的 y 轴向上为正, geometricBounds 是 [left, top, right, bottom]
//     且 **top 的数值大于 bottom**。旧的"直接拿 top 当上边、bottom 当下边相减"会把
//     纵向间隙算成两对象跨度之和 ⇒ **纵向相接永远判不出相邻**(zhiban v0.9.1 真机漏判)。
function pfBoxNorm(o) {
  if (o && o.nx0 !== undefined && o.nx1 !== undefined &&
      o.ny0 !== undefined && o.ny1 !== undefined) return o;
  var x1 = o.l, x2 = o.r, y1 = o.t, y2 = o.b;
  return {
    nx0: (x1 < x2 ? x1 : x2), nx1: (x1 < x2 ? x2 : x1),
    ny0: (y1 < y2 ? y1 : y2), ny1: (y1 < y2 ? y2 : y1)
  };
}
// 两个 bbox 是否接触/重叠(横纵间隙都 <= tol)
function pfBBoxNear(a, b, tol) {
  var A = pfBoxNorm(a), B = pfBoxNorm(b);
  var dx = Math.max(0, A.nx0 - B.nx1, B.nx0 - A.nx1);
  var dy = Math.max(0, A.ny0 - B.ny1, B.ny0 - A.ny1);
  return (dx <= tol && dy <= tol);
}

// ============================================================
// v11.95: 相邻判定补上"遮挡"这一维(雪糕 2026-11-23 报的两个 bug)
// ------------------------------------------------------------
// 症状: 底层四色 / 中层白色 / 顶层专色, 三者 bbox 层层叠合 ⇒ 底层四色与顶层专色
//   被判成"相邻" ⇒ ① 四色被误加描边(四色只该与**直接接触**的专色陷印);
//   ② 那个只贴白/被白隔开的专色也被拉进陷印名单。
// 根因: pfBBoxNear 只看矩形是否交叠, 既不认 z 序, 也不认中间夹的东西。白色对象
//   虽然被排除在邻居池外(专色压白不陷印 —— 这条规则本身是对的), 但"排除"被做成了
//   "完全无视", 于是白色既不是相邻源、也**不承担分隔作用**。
// 修法: A 与 B 的 bbox 虽近, 但若二者之间夹着一个不透明填充图元 O, 且 O 盖住了
//   A∩B 的交叠区 ⇒ A、B 实际被隔开 ⇒ 不再判相邻。
// 三条判据(必须全中):
//   ① O 的 z 严格夹在 A、B 之间(AI 里上层才不会遮挡下层, 垫在下面的白不构成分隔);
//   ② O 的 bbox **完全覆盖** A∩B 的交叠区(留 tol 余量);
//   ③ A∩B 必须是**真实二维重叠**(任一轴退化成线就不判 —— 共边对象交接面太小,
//      "有没有被盖住"判断不可靠, 保守起见仍按相邻处理)。
// 保守原则: 宁可漏判(仍加描边), 绝不误杀真正共边的对象。
// ============================================================

// A、B 的真实二维交叠区; 不重叠 / 任一轴退化 ⇒ null(不做遮挡判定)
function pfBoxOverlap(a, b, tol) {
  var A = pfBoxNorm(a), B = pfBoxNorm(b);
  var x0 = Math.max(A.nx0, B.nx0), x1 = Math.min(A.nx1, B.nx1);
  var y0 = Math.max(A.ny0, B.ny0), y1 = Math.min(A.ny1, B.ny1);
  if (x1 - x0 <= tol || y1 - y0 <= tol) return null;
  return { nx0: x0, nx1: x1, ny0: y0, ny1: y1 };
}

// O 的 bbox 是否完全覆盖 ov
function pfBoxCovers(o, ov, tol) {
  var O = pfBoxNorm(o);
  return (O.nx0 <= ov.nx0 + tol && O.nx1 >= ov.nx1 - tol &&
          O.ny0 <= ov.ny0 + tol && O.ny1 >= ov.ny1 - tol);
}

// 遮挡池条数上限 —— 超出就直接不判遮挡(退回旧行为), 防超大文档卡死。
//   occluders 就是 pfTrapCollect 的 items, z 即下标 ⇒ 夹在中间的那段是**连续切片**,
//   只需遍历 items[lo+1 .. hi-1], 不必全池扫。
var PF_OCC_MAX = 4000;        // 池子超过这个数 ⇒ 放弃遮挡判定
// v12.16(雪糕 2026-11-26 的「条码.ai」实测): 400 -> **2000**。
//   症状: 白块托着的黑条码, 3 条里 2 条被加了描边, 剩下 1 条正常; 同一份稿子同一批条码
//     有的加有的不加 —— 这种"部分中招"就是本闸在起作用, 不是颜色判错。
//   实测数据(1805 条图元的真稿, 用 _diag/replay.js 离线重放 pfSpotScan):
//     跨度上限 400  ⇒ 相邻四色 937 条，其中 K100 条码条 **87 条被误判**
//     跨度上限 800+ ⇒ 相邻四色 532 条，K100 条码条 **0 条被误判**（全部由白块隔开）
//   为什么条码必踩: 一根条就是一个图元, 一条码几十上百根, 而跨度 = 这根条与专色底之间
//     **夹了多少个收集到的图元**(不是物理距离) ⇒ 后画的条很容易跨过 400。
//   ⇒ 400 对「几百根条拼成的对象」根本不成立, 放宽到 2000 后该稿所有跨度都落在范围内。
//   ⚠ 代价: 每一对近邻要扫的切片变长。实测 1805 条的稿从 142ms 涨到 181ms(Node),
//     真机 ExtendScript 约慢 5~10 倍但同样是毫秒级到秒级; 若将来遇到超大稿变卡,
//     先降 PF_OCC_MAX(整池上限), 别把这里改回 400 —— 那会让条码类对象重新被误判。
var PF_OCC_SPAN_MAX = 2000;

// A、B 之间是否夹着**另一种墨**把二者隔开
//   a、b、occluders 都必须是 pfTrapCollect 的 entry(带 z / nx0..ny1 / fc)
// v11.99(雪糕 2026-11-23 的稿子实测): 原来只要"中间有东西盖住交叠区"就算隔开,
//   于是**同一块墨压着同一块墨**也被当成分隔 —— 而一个字的笔画本来就是若干同色图元
//   叠出来的。结果: 只有最上面那几块被判成"与底色专色相邻", 其余全被自己的同色覆盖物
//   挡住 ⇒ 面板只处理了 27 个, 另外 29 个一个描边都没加, 用户看到的就是"有的加有的没加"。
//   物理上显而易见的错: 黄色盖着黄色, 这团墨**依然**贴着底下的橙色, 中间那层不构成分隔。
//   ⇒ 遮挡物必须与 A、B **都不是同一种墨**才算数。
//   白块仍然算数(白=不上墨, 与两边都不同色), 所以条码那一单的修法不受影响。
var PF_OCC_SAME_SKIP = true;
// v12.13(雪糕 2026-11-25): **同一种墨的两个图元之间不算"需要陷印的相邻"**。
//   起因: 二维码是一堆同色小色块拼的(那份稿子里 17 个 PathItem + 4 个复合路径, 全是
//   PANTONE 368 C)。每块都"挨着"旁边那块同色块 ⇒ 白底把它们与绿底隔开的修法(见
//   pfObstructed)对它们彼此无效 ⇒ 大白底上那枚专色二维码依然被加了一圈描边。
//   物理上显而易见: 同一条色版上相邻的两块, 中间**不存在套印缝**, 加描边是纯负作用
//   (描边会外扩, 把码点糊在一起)。与 v11.99 "同墨不算分隔" 是同一条道理的两面。
//   ⚠ 只跳"同族"(同色板名 / 同四值, 见 pfSameFamily), 不同专色之间照旧要陷印。
//   box 是手搓的(没有 fc)时无法比较 ⇒ 不跳, 保持旧行为。
var PF_NEAR_SAME_SKIP = true;
function pfSameInkEntry(x, y) {
  if (!x || !y) return false;
  if (!x.fc || !y.fc) return false;
  try { return pfSameFamily(x.fc, y.fc); } catch (e) { return false; }
}
function pfObstructed(a, b, occluders, tol) {
  if (!a || !b || !occluders) return false;
  var za = a.z, zb = b.z;
  if (typeof za !== "number" || typeof zb !== "number") return false;
  var ov = pfBoxOverlap(a, b, tol);
  if (!ov) return false;
  var n = occluders.length;
  if (n > PF_OCC_MAX) return false;
  var lo = (za < zb ? za : zb), hi = (za < zb ? zb : za);
  if (hi - lo < 2) return false;                 // 紧邻两层, 中间没东西可夹
  if (hi - lo > PF_OCC_SPAN_MAX) return false;
  for (var i = lo + 1; i < hi; i++) {
    var o = occluders[i];
    if (!o) continue;
    if (!pfBoxCovers(o, ov, tol)) continue;
    // v11.99: 同墨不算分隔(见上方说明)。判不出颜色时保守地**仍按分隔处理**(宁可漏判)。
    if (PF_OCC_SAME_SKIP && (pfSameInkEntry(o, a) || pfSameInkEntry(o, b))) continue;
    return true;
  }
  return false;
}

// 在 items 里按 pageItem 引用找回 entry(取 z 用)
//   ⚠ pfSpotTrap 的执行端是从 selection 遍历出来的裸 pageItem, 拿不到 z,
//     必须回池里认领同一条 entry; 认不到就返回 null(调用端退回不判遮挡)。
function pfEntryOf(items, it) {
  if (!items || !it) return null;
  var n = items.length;
  for (var i = 0; i < n; i++) if (items[i].it === it) return items[i];
  return null;
}

// 该图元是否与 peers 里**除自己以外**的任一项相邻
//   self : 自己的 pageItem 引用 —— 必须传! peers 池里含自己(专色的邻居包括别的专色),
//          不按引用排除会让每个专色都"与自己相邻" ⇒ 退化成"一律加"。
//          ⚠ 不能靠 item.it === ... 判断: 手搓的 box 没有 .it 属性, 那个比较恒为 false。
//   occ: 遮挡池(pfTrapCollect 的 items), 可省略。v11.95 新增 —— 传了才启用"被夹在
//          中间的白色/其它填充隔开就不算相邻"; 不传 = 旧行为。box 若没有 z(手搓的),
//          遮挡判定自动跳过 ⇒ 向后兼容。
//   ⚠ 注意 peers 池**本身**决定规则(专色看 专色+四色 / 四色只看专色), 遮挡判定只是
//     在"已判相邻"的基础上再做一次否决, 不改变谁能当邻居。
function pfNearPeer(box, peers, tol, self, occ) {
  var n = peers.length;
  for (var i = 0; i < n; i++) {
    if (self && peers[i].it === self) continue;
    if (!pfBBoxNear(box, peers[i], tol)) continue;
    // v12.13: 同一种墨 ⇒ 不算相邻(同色版上没有套印缝, 见 PF_NEAR_SAME_SKIP 的说明)。
    //   手搓 box 没有 fc ⇒ pfSameInkEntry 返回 false ⇒ 保持旧行为。
    if (PF_NEAR_SAME_SKIP && pfSameInkEntry(box, peers[i])) continue;
    if (occ && pfObstructed(box, peers[i], occ, tol)) continue;   // 被隔开 ⇒ 不算相邻
    return true;
  }
  return false;
}

// 只读统计(供卡片显示):
//   spotTotal   专色填充图元总数(含只贴白的)
//   spot        其中**需要陷印**的(与四色或另一个专色相邻)
//   spotDone    需陷印的专色里已带同色叠印描边的
//   cmykAdj     与专色相邻的四色图元数(会加)
//   cmykAdjDone 其中已带同色叠印描边的
//   white       白色对象数(跳过, 也不作为相邻源)
//   spotIdle    只与白/空白相邻、因此不处理的专色数
//   strokeKept  相邻但**自己已经有别的颜色的描边** ⇒ 一律不动(v11.96)
//   spotLocked  相邻但锁定/隐藏的专色 ⇒ 动手时跳过, 所以也不算"待加"
function pfSpotScan(doc) {
  var st = { spotTotal: 0, spot: 0, spotDone: 0, cmykAdj: 0, cmykAdjDone: 0, white: 0,
             textSkipped: 0, spotIdle: 0, strokeKept: 0, spotLocked: 0 };
  var col = pfTrapCollect(doc);
  st.textSkipped = col.textSkipped;
  var spots = [], cmyks = [], i, n = col.items.length, it, fc, ss, sb;
  for (i = 0; i < n; i++) {
    it = col.items[i];
    if (it.kind === "spot") spots.push(it);
    else if (it.kind === "cmyk") cmyks.push(it);
    else if (it.kind === "white") st.white++;
  }
  // 专色的相邻源 = 其它专色 + 四色(白色排除在外 —— 专色压白/贴白不做陷印)
  var peers = [], j;
  for (j = 0; j < spots.length; j++) peers.push(spots[j]);
  for (j = 0; j < cmyks.length; j++) peers.push(cmyks[j]);

  st.spotTotal = spots.length;
  for (i = 0; i < spots.length; i++) {
    if (!pfNearPeer(spots[i], peers, PF_TRAP_TOL, spots[i].it, col.items)) { st.spotIdle++; continue; }
    fc = spots[i].fc;      // v12.13: 用收集时存的那份 —— 复合路径的 it.fillColor 读出来是 null
    // v11.95(雪糕): 已有**同族**描边(比如自己那圈 3mm 专色描边)算「已加」, 但仍留在
    //   「需加」里 —— 表格「需加 / 已加 / 待加」三列才平账。执行端 pfTrapStrokeApply
    //   对这类对象只返回 kept, 一个属性都不改(见那里的说明)。
    //   只有 ss === 2(别的颜色描边)才整条排除出「需加」—— 那不属于陷印描边, 也不动手。
    ss = fc ? pfStrokeState(spots[i].it, fc) : 0;
    if (ss === 2) { st.strokeKept++; continue; }
    // 专色数量少(通常 <50), 逐条查锁定链的代价可以忽略; 四色侧不查(可能成百上千, 会拖慢每次检查)
    sb = null; try { sb = pfBlockInfo(spots[i].it); } catch (e5) { sb = null; }
    if (sb) { st.spotLocked++; continue; }
    st.spot++;
    if (ss === 1) st.spotDone++;   // 已有同族描边 ⇒ 计入「已加」, 但不改粗细
  }
  for (i = 0; i < cmyks.length; i++) {
    if (!pfNearPeer(cmyks[i], spots, PF_TRAP_TOL, cmyks[i].it, col.items)) continue;   // 四色的相邻源只认专色
    fc = cmyks[i].fc;      // v12.13: 同上, 复合路径读不到自身 fillColor
    ss = fc ? pfStrokeState(cmyks[i].it, fc) : 0;
    if (ss === 2) { st.strokeKept++; continue; }     // 同上: 别的颜色的描边不动
    st.cmykAdj++;
    if (ss === 1) st.cmykAdjDone++;
  }
  return st;
}

// 选中所有"需要加描边"的图元 —— 卡⑨按钮的第一步。
//   口径(雪糕 2026-10-21 再确认): 专色**也必须与四色或另一个专色相邻**才选;
//     只贴白/空白/压在白色块上的专色不选(白色不是陷印对象)。
//     白色对象与纯四色同样不选。
//   只改选中状态, 不动任何对象属性。锁定/隐藏跳过(AI 不允许脚本选中被锁定的对象)。
function pfSpotSelectAll() {
  var res = { ok: false };
  try {
    if (app.documents.length === 0) { res.error = "当前没有打开的文档，请先打开一个 AI 文件。"; return pfReturn(res); }
    var doc = app.activeDocument;
    var col = pfTrapCollect(doc);
    var spots = [], cmyks = [], i, n = col.items.length, it;
    for (i = 0; i < n; i++) {
      it = col.items[i];
      if (it.kind === "spot") spots.push(it);
      else if (it.kind === "cmyk") cmyks.push(it);
    }
    // 专色的相邻源 = 其它专色 + 四色(白色排除)
    var peers = [], j;
    for (j = 0; j < spots.length; j++) peers.push(spots[j]);
    for (j = 0; j < cmyks.length; j++) peers.push(cmyks[j]);

    var list = [], skipped = 0, nSpot = 0, nCmyk = 0, nIdle = 0, nKept = 0, fcP, ssP;
    // 返回 true = 真的进了选区 —— 计数只认真正选中的, 锁定的不能算进 "已选中 N 个"
    function pick(entry) {
      var bi = null; try { bi = pfBlockInfo(entry.it); } catch (e) { bi = null; }
      if (bi) { skipped++; return false; }     // 锁定/隐藏的选不上, 计数告知
      list.push(entry.it);
      return true;
    }
    for (i = 0; i < spots.length; i++) {
      if (!pfNearPeer(spots[i], peers, PF_TRAP_TOL, spots[i].it, col.items)) { nIdle++; continue; }   // 只贴白/空白/被隔开
      // v11.96: 已有其他颜色描边的**不选** —— 执行端也不会动它, 选进选区只会让用户
      //   以为"这些也要改", 白担一次心跳。
      try { fcP = spots[i].fc; } catch (eFp) { fcP = null; }   // v12.13: 复合路径要用收集时那份
      ssP = fcP ? pfStrokeState(spots[i].it, fcP) : 0;
      if (ssP === 2) { nKept++; continue; }
      if (pick(spots[i])) nSpot++;
    }
    for (i = 0; i < cmyks.length; i++) {
      if (!pfNearPeer(cmyks[i], spots, PF_TRAP_TOL, cmyks[i].it, col.items)) continue;
      try { fcP = cmyks[i].fc; } catch (eFc2) { fcP = null; }   // v12.13: 同上
      ssP = fcP ? pfStrokeState(cmyks[i].it, fcP) : 0;
      if (ssP === 2) { nKept++; continue; }
      if (pick(cmyks[i])) nCmyk++;
    }

    // v11.97: 名单先交出去, 再谈选区高亮 —— 二者从此解耦。
    //   选区只是"给用户看一眼"的提示, 真正决定处理谁的是这份 list。
    PF_TRAP_PENDING = list.slice(0);
    PF_TRAP_DOC = doc;

    // 先清空再赋值 —— 不清会把上一次的选中累加进来
    var selErr = "";
    try { doc.selection = null; } catch (eN) {}
    if (list.length > 0) {
      try { doc.selection = list; }
      catch (eSel) {
        // v11.97: 不再 return —— 高亮失败不该连累处理(名单已经拿到手了)。
        //   原实现这里直接返回错误, execActionMulti 是 fail-fast ⇒ 第二步(真正加描边)根本不会跑。
        selErr = "（其中部分对象无法高亮，但处理仍按名单执行）";
      }
    }

    res.ok = true;
    res.count = list.length; res.spot = nSpot; res.cmyk = nCmyk;
    res.skipped = skipped; res.spotIdle = nIdle; res.strokeKept = nKept;
    res.pending = list.length;
    res.message = (list.length > 0
      ? "已选中 " + nSpot + " 个专色" + (nCmyk > 0 ? " + " + nCmyk + " 个与专色相邻的四色" : "") +
        "，共 " + list.length + " 个对象" + selErr
    : "未发现需要陷印的专色/相邻四色图元") +
      (nIdle > 0 ? "（另有 " + nIdle + " 个专色只与白色/空白相邻，按规则不处理）" : "") +
      (nKept > 0 ? "（另有 " + nKept + " 个已有其他颜色的描边，不改动）" : "") +
      (skipped > 0 ? "（另有 " + skipped + " 个锁定/隐藏对象未选中，需先解锁）" : "") + "。";
  } catch (err) {
    res.ok = false;
    res.error = "选中失败: " + String(err);
  }
  return pfReturn(res);
}

// v11.102: 「写一条描边」的共用实现 —— 手动按钮与全部按钮**必须同源**,
//   否则又会出现"这颗加了、那颗没加 / 颜色不一样"的老账。
//   入参: pi 图元, wPt 目标描边宽(pt), fc 填充色, k pfFillKind(fc) 的结果。
//   返回: { r: 状态码, k: "spot"|"cmyk"|"" }
//     状态码 —— nofill 无填充 / other 渐变图案RGB灰度 / white 不上墨 /
//               kept 已有**别的颜色**的描边(一个像素都不动) /
//               acted 已写入 / already 本来就是目标状态 / failed 写入失败
function pfTrapSetStrokeColor(pi, fc, k) {
  if (k === "spot") {
    var sc = new SpotColor();
    sc.spot = fc.spot;
    sc.tint = (typeof fc.tint === "number") ? fc.tint : 100;
    pi.strokeColor = sc;
  } else {
    var cc = new CMYKColor();
    cc.cyan = fc.cyan; cc.magenta = fc.magenta; cc.yellow = fc.yellow; cc.black = fc.black;
    pi.strokeColor = cc;
  }
}
// v11.95(雪糕): **只要有描边就一律不动** —— 不看颜色、不看宽度、不看叠印。
//   起因: 用户手工给专色加了 3mm 同色描边、给四色加了 3mm 四色描边, 点「加描边叠印」
//   之后被覆盖成面板里的 0.2mm。面板不该隐式改写别人画好的描边。
//   ⇒ stt >= 1 (同族/异色都算) 直接返回 kept; 只有 stt === 0(本来没描边) 才新建。
//   要改粗细/颜色/叠印, 请用户自己先清掉描边 —— 面板不猜。
function pfTrapStrokeApply(pi, wPt, fc, k) {
  var out = { r: "nofill", k: "" };
  if (!pi || !fc) return out;
  if (k !== "spot" && k !== "cmyk") {
    out.k = "";
    if (k === "white") { out.r = "white"; } else if (k === "other") { out.r = "other"; }
    return out;
  }
  out.k = k;
  var stt = pfStrokeState(pi, fc);
  if (stt >= 1) { out.r = "kept"; return out; }   // 已有描边 ⇒ 原样保留, 一个属性都不碰
  // stt === 0: 本来没有描边 ⇒ 新建同色描边 + 叠印
  //   v12.13: 复合路径(转曲文字/角标环)的 stroked/strokeWidth/strokeColor 在 AI 28.0.0 上
  //     **写不进自身**(属性根本不存在), 必须落到子路径上。原来那版是"没抛异常就当成功",
  //     对复合路径会把一次彻底失败报成 acted。现在改成先定目标、逐个写、逐个核验:
  //     目标 = 自身(可写时) 或 全部子路径(自身不可写时)。
  var tg = [pi];
  var selfOk = false;
  try { selfOk = (typeof pi.stroked !== "undefined"); } catch (e0) { selfOk = false; }
  if (!selfOk) {
    var subs = null; try { subs = pi.pathItems; } catch (e1) { subs = null; }
    var sn = 0; try { sn = subs ? subs.length : 0; } catch (e2) { sn = 0; }
    if (sn > 0) { tg = []; for (var si = 0; si < sn; si++) tg.push(subs[si]); }
  }
  var anyOk = false, bad = 0, ti, tn = tg.length;
  for (ti = 0; ti < tn; ti++) {
    var t = tg[ti], threw = false;
    try {
      t.stroked = true;
      t.strokeWidth = wPt;
      pfTrapSetStrokeColor(t, fc, k);
      t.strokeOverprint = true;
    } catch (e5) { threw = true; }
    if (threw) { bad++; continue; }
    // 核验: 1=写成同族描边 / -1=该类型读不回来(只能信写入) / 其余(0, 2)=没写进去
    var v = -1;
    try { v = pfStrokeStateOf(t, fc); } catch (e6) { v = -1; }
    if (v === 1 || v === -1) anyOk = true; else bad++;
  }
  out.r = (bad === 0 && anyOk) ? "acted" : "failed";
  return out;
}

// 执行: 给专色填充图元加同色描边 + 描边叠印
//   strokeMM: **描边宽度**(mm), 缺省 0.2。面板上填 0.2 就是 0.2, 没有隐含的 2 倍换算。
//   半自动 —— 必须有选中对象才处理(只处理选中项及其组内子项)。
//   按颜色关系分类处理(见上方规则表), 两侧都要过相邻判定:
//     专色 → 与四色或另一个专色相邻才加; 四色 → 与专色相邻才加;
//     白色 → 跳过(也不作相邻源); 渐变/图案 → 跳过。
//     相邻判定用**全文档**图元做参照池(与选中范围无关), 因为邻居可能在选中之外。
function pfSpotTrap(strokeMM) {
  var res = { ok: false };
  try {
    if (app.documents.length === 0) { res.error = "当前没有打开的文档，请先打开一个 AI 文件。"; return pfReturn(res); }
    var doc = app.activeDocument;
    var swMM = parseFloat(strokeMM);
    if (!(swMM > 0)) swMM = 0.2;   // 缺省 0.2mm(≈0.1mm 扩边)
    if (swMM > 10) swMM = 10;      // 上限保护
    var wPt = swMM * MMPT;

    var actedSpot = 0, actedCmyk = 0, already = 0, locked = 0, failed = 0;
    var whiteSkip = 0, otherSkip = 0, cmykFar = 0, textSkipped = 0, spotIdle = 0, strokeKept = 0;

    // 参照池: **全文档**专色 + 四色 —— 判定相邻要看真实邻居, 不能只看选中范围。
    //   白色对象不在池里: 专色压白/贴白按规则不陷印, 白色也不能把邻居"拉进"处理名单。
    var col = pfTrapCollect(doc);
    var spots = [], cmyks = [], ci, cn = col.items.length;
    for (ci = 0; ci < cn; ci++) {
      if (col.items[ci].kind === "spot") spots.push(col.items[ci]);
      else if (col.items[ci].kind === "cmyk") cmyks.push(col.items[ci]);
    }
    var peers = [], cj;
    for (cj = 0; cj < spots.length; cj++) peers.push(spots[cj]);
    for (cj = 0; cj < cmyks.length; cj++) peers.push(cmyks[cj]);
    // 需要陷印的专色(与四色或另一个专色相邻) —— 用来判断"是否真的无事可做"
    var needSpot = 0, ck;
    for (ck = 0; ck < spots.length; ck++) if (pfNearPeer(spots[ck], peers, PF_TRAP_TOL, spots[ck].it, col.items)) needSpot++;

    // 半自动 —— 必须有选中。无选中且文档里有"需陷印的专色" ⇒ 报错而不是改全篇。
    // v11.97: **优先用「选全」那一刻的名单**(见 PF_TRAP_PENDING 的注释)。选区的实际内容
    //   与赋进去的数组不等价(组内上浮 / 整批赋值失败 / 跨层锁定), 拿它当工作清单会**静默丢项**。
    //   没有名单(用户手动选了几个直接调本函数)时才退回选区。
    var roots = [], useSel = false, fromPending = false;
    if (PF_TRAP_PENDING && PF_TRAP_PENDING.length > 0 && PF_TRAP_DOC === doc) {
      roots = PF_TRAP_PENDING; useSel = true; fromPending = true;
    }
    // 一次性: 不管走哪个分支都立刻清掉 —— 绝不让这一份名单漏到下一轮(可能已换文档)
    PF_TRAP_PENDING = null; PF_TRAP_DOC = null;
    if (!fromPending) {
      try {
        if (doc.selection && doc.selection.length > 0) { useSel = true; roots = doc.selection; }
      } catch (eSel) { useSel = false; }
    }
    if (!useSel) {
      if (needSpot === 0) {
        res.ok = true;
        res.acted = 0; res.already = 0; res.locked = 0; res.failed = 0;
        res.width = pfRound(swMM);
        res.message = (spots.length > 0)
          ? "未发现需要陷印的专色（" + spots.length + " 个专色都只与白色/空白相邻）。"
        : "未发现专色填充对象。";
        return pfReturn(res);
      }
      res.error = "请先选中要处理的对象 —— 或直接点「选中所有专色并加描边叠印」按钮(先自动全选专色 + 相邻四色, 再处理)。";
      return pfReturn(res);
    }

    function applyPath(pi) {
      // v12.13: 同 pfTrapCollect —— 复合路径(转曲文字/角标环)要靠 pfNodeFill 才读得出填色
      var fo = pfNodeFill(pi);
      if (!fo.on) return;
      var fc = fo.c;
      var k = pfFillKind(fc);
      if (k === "white") { whiteSkip++; return; }          // C0M0Y0K0: 不加、也不当相邻源
      if (k === "other") { otherSkip++; return; }          // 渐变/图案/RGB/灰度
      // 两侧都要过相邻判定(含被覆盖/重叠的情形 —— bbox 相交 ⇒ 间隙 0 ⇒ 判相邻)
      var b = null; try { b = pi.geometricBounds; } catch (e6) { b = null; }
      if (!b || b.length < 4) { otherSkip++; return; }
      // v11.95: 遮挡判定需要 z 序, 而这里只有裸 pageItem ⇒ 回收集池认领同一条 entry;
      //   认不到就退回手搓 box(没 z, pfObstructed 自动跳过), 保持旧行为不会误伤。
      var box = pfEntryOf(col.items, pi) || { l: b[0], t: b[1], r: b[2], b: b[3] };
      if (k === "spot") {
        // 专色: 与四色或另一个专色相邻才加; 只贴白/空白 ⇒ 跳过
        if (!pfNearPeer(box, peers, PF_TRAP_TOL, pi, col.items)) { spotIdle++; return; }
      } else {
        // 四色: 只认专色做相邻源; 贴四色/白色 ⇒ 跳过
        if (!pfNearPeer(box, spots, PF_TRAP_TOL, pi, col.items)) { cmykFar++; return; }
      }
      // 锁定/隐藏一律不动(需用户先解锁, 与叠印卡同一原则)
      var bi = null; try { bi = pfBlockInfo(pi); } catch (e3) { bi = null; }
      if (bi) { locked++; return; }
      // v11.102: 具体"怎么写这条描边"交给共用实现 —— 与「选中加描边」那颗按钮同一套,
      //   免得两条入口的取色 / 幂等 / 保护规则各写一遍然后走散。
      var rr = pfTrapStrokeApply(pi, wPt, fc, k);
      if (rr.r === "kept") strokeKept++;
      else if (rr.r === "acted") { if (k === "spot") actedSpot++; else actedCmyk++; }
      else if (rr.r === "already") already++;
      else if (rr.r === "failed") failed++;
    }
    function onNode(node, kind) {
      if (kind === "text") { textSkipped++; return; }
      applyPath(node);
    }

    var rn = roots.length;
    for (var s = 0; s < rn; s++) pfSpotWalk(roots[s], onNode);

    res.ok = true;
    res.acted = actedSpot + actedCmyk; res.spot = actedSpot; res.cmyk = actedCmyk;
    res.already = already; res.locked = locked; res.failed = failed;
    res.white = whiteSkip; res.cmykFar = cmykFar; res.other = otherSkip;
    res.spotIdle = spotIdle; res.strokeKept = strokeKept;
    res.textSkipped = textSkipped; res.useSel = useSel; res.width = pfRound(swMM);
    res.pending = roots.length; res.fromPending = fromPending;
    var head = (res.acted > 0)
      ? "已加描边叠印：专色 " + actedSpot + " 个" +
        (actedCmyk > 0 ? "、相邻四色 " + actedCmyk + " 个" : "") +
        "（描边宽 " + pfRound(swMM) + " mm）"
    : "未新增描边";
    res.message = head +
      (already > 0 ? "，已是目标状态 " + already + " 个" : "") +
      (strokeKept > 0 ? "，已有描边 " + strokeKept + " 个（粗细/颜色/叠印一律不改动）" : "") +
      (spotIdle > 0 ? "，只贴白/空白的专色 " + spotIdle + " 个未处理" : "") +
      (whiteSkip > 0 ? "，白色对象 " + whiteSkip + " 个未处理" : "") +
      (cmykFar > 0 ? "，不贴专色的四色 " + cmykFar + " 个未处理" : "") +
      (otherSkip > 0 ? "，渐变/图案/无填充等 " + otherSkip + " 个未处理" : "") +
      (locked > 0 ? "，" + locked + " 个锁定/隐藏未动" : "") +
      (textSkipped > 0 ? "，文字 " + textSkipped + " 处跳过" : "") +
      (failed > 0 ? "，失败 " + failed + " 个" : "") + "。";
  } catch (err) {
    res.ok = false;
    res.error = "专色描边处理失败: " + String(err);
  }
  return pfReturn(res);
}

// ============================================================
// v10.15: 删除全部隐藏对象(zhiban v10.14~15 同源移植) —— 只删对象, 隐藏图层本身保留。
//   范围: **可见图层内**的隐藏组/Ctrl+3 隐藏对象; 隐藏图层(含子图层)整支跳过,
//   层内对象一律不删 —— "删干净"到可见图层为止, 隐藏图层交由人工处理(雪糕要求)。
// 安全: ① 收集与删除分离, 收集到的引用互不为祖先/后代(隐藏组收整组后不再下钻,
//   隐藏图层只收各层顶级对象), 不会删到已失效引用;
//   ② 锁定的隐藏对象 remove() 会抛异常 ⇒ 计入 failed 如实回报, 不擅自改锁定状态
//   (与清叠印"不顺手改用户状态"同一哲学)。
// ============================================================
// v11.16(雪糕): 卡⑨ 由「空文本」扩成「清理」—— 对照 Illustrator 自带
//   「对象 > 路径 > 清理」的三个勾选项: 游离点 / 未上色对象 / 空文本路径。
//   口径(扫描 pfCleanupScan 与删除 pfCleanup 共用同一套 pfJunkEach, 避免"报 N 删 M"):
//     ① 游离点  = 只有一个锚点的 PathItem(pathPoints.length === 1)。guides 一律不算、不碰。
//     ② 未上色  = filled 与 stroked 都为 false 的 PathItem / CompoundPathItem。
//        只认这两类叶子图形 —— 组、图层、文本帧不参与(文本帧归"空文本"那一项)。
//        已判为游离点的不再重复计入未上色。
//     ③ 空文本  = contents 去掉所有空白(空格/不间断空格/全角空格/零宽/制表/换行)后长度 0。
//     ④ 范围 = 全文档树递归(layer.pageItems → 组内下钻), 含组内对象;
//        **不含**符号定义源内的对象 —— 扫描与删除两侧一致, 不会有对不上的账。
//        v11.33: 原为"文档级集合(pathItems / compoundPathItems / textFrames)",
//        真机实测集合按下标取值是线性变慢的(3374 条要 476ms), 换成树递归后 7.9ms。
//     ⑤ 判定照常计入隐藏与锁定对象, 但**隐藏或锁定的一律不删**(不解锁、不改可见性)。
//   已知边界: 复合路径的**子路径**不做游离点判定(只判复合路径整体是否未上色)。
//            v11.33 已量清两者关系: doc.pathItems 含复合路径的组件, 且实测占
//            2819/3374 —— 树递归不进入组件, 与原"逐个读属性后 continue 丢弃"等价。
// ============================================================
function pfIsBlankText(s) {
  if (s === null || s === undefined) return true;
  var t = "";
  try { t = String(s); } catch (e) { return false; }
  return t.replace(/[\s\u00A0\u3000\u200B\uFEFF]/g, "").length === 0;
}

// 遍历三类"可清理对象", 逐个回调 cb(kind, item)
//   kind ∈ "stray" | "unpainted" | "emptyText"
function pfJunkEach(doc, cb) {
  var i, n;
  // ============================================================
  // v11.33(真机实测): 枚举从"文档级集合逐个索引"改成"一次树递归"。
  //   为什么改: doc.pathItems 按下标取值随下标线性变慢 —— 3374 条路径全量索引
  //   要 476ms, 而同一棵树走递归只要 7.9ms, 同机同稿差 47.5 倍。
  //   口径逐条核对过, 三类对象的判定结果与旧实现完全一致:
  //     · 含组内对象; 含隐藏图层 / 隐藏组内对象 —— 本函数**不判** visible/hidden
  //     · **不含**复合路径的组件: 旧实现对每个组件读 3 个属性后 continue 丢弃,
  //       实测这类占 2819/3374, 正是那 476ms 的大头; 现在根本不进去
  //     · **不含**符号定义源内对象 —— 不下钻 SymbolItem, 与旧 doc.pathItems 口径一致
  //   ⚠ 两处深度上限 64 与项目其余递归同款, 防损坏文档无限嵌套。
  //   ⚠ 顺序仍是"路径 → 复合路径 → 文本", 与旧实现一致(pfCleanup 的倒序删除依赖它)。
  // ============================================================
  var paths = [], cps = [], texts = [];
  // v11.39: 含剪切路径子项的组名单 —— 遍历时一次性判定, 供 skipClip 线性查找。
  //   原实现让 skipClip 每判一个对象都沿父链把**每个祖先组的全部子项**重读一遍 clipping,
  //   复杂度 O(未上色对象数 × 组内子项数); 1000 个未上色对象 × 3000 子项的组 ≈ 300 万次
  //   跨桥读取, 和 v11.33 费力消掉的 doc.pathItems[i] 下标开销同一量级(那次 476ms → 7.9ms)。
  //   ⚠ 判定口径完全不变, 只是把"每次都算"换成"一次算好存起来"。
  var clipGroups = [];
  function junkWalkItems(items, depth) {
    if (depth > PF_MAX_DEPTH) return;
    // v11.39: length 外提 —— 与全文 20 余处约定一致(原先每轮跨桥重取一次)
    var lim = 0;
    try { lim = items.length; } catch (eLen) { return; }
    for (var k = 0; k < lim; k++) {
      var it = items[k], tn = "";
      try { tn = it.typename; } catch (eT) { continue; }
      if (tn === "PathItem") paths.push(it);
      else if (tn === "CompoundPathItem") cps.push(it);
      else if (tn === "TextFrame") texts.push(it);
      else if (tn === "GroupItem") {
        // 本组是否含剪切路径子项 —— 只在这里判一次(见 clipGroups 的说明)
        try {
          var gii = it.pageItems, gLim = gii ? gii.length : 0, gk;
          for (gk = 0; gk < gLim; gk++) {
            var gc = false;
            try { gc = (gii[gk].clipping === true); } catch (eGc) { gc = false; }
            if (gc) { clipGroups.push(it); break; }
          }
        } catch (eGi) {}
        try { junkWalkItems(it.pageItems, depth + 1); } catch (eG) {}
      }
    }
  }
  function junkWalkLayers(lyrs, depth) {
    if (depth > PF_MAX_DEPTH) return;
    var limL = 0;
    try { limL = lyrs.length; } catch (eLenL) { return; }
    for (var j = 0; j < limL; j++) {
      var ly = lyrs[j];
      // v11.90: 对照层不参与清理判定 —— 栅格图元本身既不是游离点也不是未上色对象,
      //   但仍然显式跳过: 万一将来判定口径变化(比如把"无填充"扩展到栅格), 这里不会失控。
      if (pfIsAuxLayer(ly)) continue;
      try { junkWalkItems(ly.pageItems, 0); } catch (eL) {}
      try { var subs = ly.layers; if (subs && subs.length) junkWalkLayers(subs, depth + 1); } catch (eS) {}
    }
  }
  try { junkWalkLayers(doc.layers, 0); } catch (eL0) {}

  // v11.17(安全): 路径文字(Type on a Path)的**基底路径**本身就是"无填充 + 无描边"的
  //   PathItem —— 按"未上色"口径会被判成垃圾, 可它一删, 上面的文字当场没。
  //   这里先把它收进 keepPath, 判定时跳过(skipUnpaint)。
  //   ⚠ 两条路一起收, 互为兜底(取不到 textPath 的版本靠 parent 判断):
  //     ① textFrame.textPath(仅 kind === PATHTEXT 有效)
  //     ② 父级是 TextFrame 的 PathItem
  var keepPath = [];
  // v11.19(审查): TextType 是引擎内建枚举, 正常都在; 但这里**不能裸用** ——
  //   一旦它不可用, 整个 pfJunkEach 会抛, 清理整卡直接失败。
  //   取不到时 PT = -1 ⇒ 后面的 `kk !== PT` 恒真 ⇒ 不收 keepPath,
  //   由 skipUnpaint 里"父级是 TextFrame"那条兜底继续保护路径文字基底。
  var PT19 = -1;
  try { PT19 = TextType.PATHTEXT; } catch (ekP) { PT19 = -1; }
  for (i = 0; i < texts.length; i++) {
    var tfK = texts[i], kk = -1;
    try { kk = tfK.kind; } catch (ek2) { kk = -1; }
    if (kk !== PT19) continue;
    var tp = null;
    try { tp = tfK.textPath; } catch (ek3) { tp = null; }
    if (tp) keepPath.push(tp);
  }
  function skipUnpaint(it) {
    var k = 0;
    for (k = 0; k < keepPath.length; k++) { if (keepPath[k] === it) return true; }
    var par = null;
    try { par = it.parent; } catch (ek4) { par = null; }
    var parTn = "";
    try { parTn = par ? par.typename : ""; } catch (ek5) { parTn = ""; }
    return parTn === "TextFrame";
  }
  // v11.20(雪糕真机反馈: "我有些图片是在剪切蒙版里面, 你把我的剪切蒙版也清理了"):
  //   剪切蒙版的**蒙版路径**本身就是一条"无填充 + 无描边"的路径 —— 按未上色口径必删,
  //   一删蒙版就散了, 里面的图整个露出来。这里挡两道, 互为兜底:
  //     ① 对象自己就是剪切路径: pathItem / compoundPathItem 的 clipping === true;
  //     ② 对象在**剪切组**里: 沿 parent 链往上找, 只要某一层组的成员中有 clippping 对象,
  //        整组都算蒙版内容 —— 里面的矢量图形一个都不能动(位图不在 pathItems 里, 本就不参与)。
  //   ⚠ 只影响"清理"这一张卡; 其他卡的统计口径不变(它们只是读, 不删)。
  function skipClip(it) {
    var clip = false;
    try { clip = (it.clipping === true); } catch (eC1) { clip = false; }
    if (clip) return true;
    // v11.39: 只查"预判过的剪切组"名单, 不再逐组扫子项(见 clipGroups 处说明)。
    //   名单通常只有个位数项, 线性查找的代价可忽略; 判定口径与旧实现逐条等价。
    var p = it, guard = 0;
    while (p && guard++ < PF_MAX_DEPTH) {
      var tn = "";
      try { tn = p.typename; } catch (eC2) { break; }
      if (tn === "Document" || tn === "Layer") break;
      if (tn === "GroupItem") {
        for (var k2 = 0; k2 < clipGroups.length; k2++) {
          if (clipGroups[k2] === p) return true;
        }
      }
      try { p = p.parent; } catch (eC5) { break; }
    }
    return false;
  }

  // ---- 路径类: 游离点 + 未上色 ----
  if (paths.length) {
    n = paths.length;
    for (i = 0; i < n; i++) {
      // v12.6: 不再重读 typename —— paths 已由 junkWalkItems 按 tn==="PathItem" 筛好,
      //   这里那次读恒真, 纯粹是每条路径白付一次跨桥属性读(3374 条 = 3374 次)。
      //   下面的 parP 判断**保留**: 它挡的是"将来改回集合枚举"时复合路径组件混进来
      //   (v11.21 外审 #9 的防御), 与本次省掉的那次读不是同一件事。
      var p = paths[i], np = -1, gd = false, fl = true, st = true;
      var parP = null;
      try { parP = p.parent; } catch (eP9) { parP = null; }
      var parPTn = "";
      try { parPTn = parP ? parP.typename : ""; } catch (eP9b) { parPTn = ""; }
      if (parPTn === "CompoundPathItem") continue;
      try { gd = (p.guides === true); } catch (e3) {}
      if (gd) continue;                       // 辅助线: 不算游离点、也不碰
      try { np = p.pathPoints.length; } catch (e4) { np = -1; }
      if (np === 1) {
        if (!skipClip(p)) cb("stray", p);          // v11.20: 剪切组里的单点也不动
        continue;
      }
      try { fl = (p.filled !== false); st = (p.stroked !== false); } catch (e5) {}
      // v11.17: 路径文字基底跳过; v11.20: 剪切蒙版路径 / 蒙版内容跳过
      if (!fl && !st && !skipUnpaint(p) && !skipClip(p)) cb("unpainted", p);
    }
  }
  // ---- 复合路径: 只判"未上色"(整体) ----
  if (cps.length) {
    n = cps.length;
    for (i = 0; i < n; i++) {
      var c2 = cps[i], gd2 = false, fl2 = true, st2 = true;
      try { gd2 = (c2.guides === true); } catch (e8) {}
      if (gd2) continue;
      try { fl2 = (c2.filled !== false); st2 = (c2.stroked !== false); } catch (e9) {}
      // v11.17: 同上; v11.20: 复合路径也可能是剪切路径(或位于剪切组内)
      if (!fl2 && !st2 && !skipUnpaint(c2) && !skipClip(c2)) cb("unpainted", c2);
    }
  }
  // ---- 空文本 ----
  if (texts.length) {
    n = texts.length;
    for (i = 0; i < n; i++) {
      var t = texts[i], blank = false;
      try { blank = pfIsBlankText(t.contents); } catch (eC) { continue; }
      if (blank) cb("emptyText", t);
    }
  }
}

// 只读统计: 三类各多少个(其中隐藏/锁定各几个) + 空文本里"纯空格"的条数
// v11.81: 第 2 参 col = 定位缓存池(可空)。pfJunkEach 的判定**本就含隐藏/锁定对象**
//   (它从不看 visible/hidden), 所以命中对象直接收进 col 就是定位端要的完整集合 ——
//   卡⑨ 不需要像 ⑤⑥⑦ 那样再补一遍隐藏池。同一个对象只会回调一次(三类互斥),
//   故这里裸 push 即可, 不必走 pfLocPush 的引用去重。
function pfCleanupScan(doc, col) {
  var out = {
    stray:     { count: 0, hidden: 0, locked: 0 },
    unpainted: { count: 0, hidden: 0, locked: 0 },
    emptyText: { count: 0, hidden: 0, locked: 0 },
    spaceOnly: 0
  };
  pfJunkEach(doc, function (kind, it) {
    if (col) { try { col.push(it); } catch (eCol) {} }
    var o = out[kind];
    if (!o) return;
    o.count++;
    var bi = null;
    try { bi = pfBlockInfo(it); } catch (e) {}
    if (bi && bi.hidden) o.hidden++;
    else if (bi && bi.locked) o.locked++;
    // "纯空格"单列: 原本有字符但全是空白(对照组: 完全空的点文本长度 0)
    if (kind === "emptyText") {
      var len = 0;
      try { len = String(it.contents || "").length; } catch (e2) {}
      if (len > 0) out.spaceOnly++;
    }
  });
  return out;
}

// 一键清理 —— 按前端三个勾选框传入的开关执行(1/0 或 true/false)
function pfCleanup(doStray, doUnpaint, doText) {
  var res = { ok: false };
  try {
    if (app.documents.length === 0) { res.error = "当前没有打开的文档，请先打开一个 AI 文件。"; return pfReturn(res); }
    var doc = app.activeDocument;
    var want = {};
    if (pfCkOn(doStray)) want.stray = 1;
    if (pfCkOn(doUnpaint)) want.unpainted = 1;
    if (pfCkOn(doText)) want.emptyText = 1;
    if (!want.stray && !want.unpainted && !want.emptyText) {
      res.ok = true; res.deleted = 0; res.failed = 0; res.skipped = 0;
      res.message = "没有勾选任何清理项。";
      return pfReturn(res);
    }
    // v11.18(雪糕): "清理整个文档的…包含隐藏和锁定的也删"。
    //   ⇒ 不再按隐藏/锁定跳过, 全部列入清理名单。
    //   ① 隐藏对象: remove() 本身就能删(隐藏不影响删除), 不需要改可见性。
    //   ② 锁定对象: remove() 会抛 ⇒ 先临时解锁(只解离它最近的那个锁定节点), 删成功就不管,
    //      删失败则**成对复原**锁定状态 —— 遵循"临时改用户状态必须同调用内复原"的铁律,
    //      不允许出现"没删掉还把人家解锁了"的残留副作用。
    var refs = [], locks = [], failed = 0, unlocked = 0;
    pfJunkEach(doc, function (kind, it) {
      if (!want[kind]) return;
      refs.push(it);
      var bi = null;
      try { bi = pfBlockInfo(it); } catch (e) {}
      // v11.56: 必须用 lockedNode, 不能再用混合阻挡节点 node。
      //   node 可能是最近的**隐藏**节点(如隐藏对象位于锁定图层内), 把它当锁节点解锁/回锁
      //   会锁上一个原本未锁的对象或组, 破坏用户状态。
      locks.push((bi && bi.lockedNode) ? bi.lockedNode : null);
    });
    // v11.19(审查 2 处修复):
    //   ① 锁节点 **不是对象本身** 时(= 祖先组/图层被临时解锁), 删成功后也必须把锁还回去。
    //      否则: 删掉了组里一个游离点, 却把用户锁着的整个组解锁了 —— 同样的残留副作用,
    //      只不过方向反过来(旧版只处理"没删成"那一半)。
    //   ② remove() 抛异常不等于失败: 若该对象已被**祖先**连带删除(引用失效, 读 typename 抛错),
    //      它其实已经达成目的 ⇒ 不该计进 failed, 否则回执会吓人地写"N 处删除失败"。
    function relock(node) { try { node.locked = true; } catch (eRL) {} }
    for (var r = refs.length - 1; r >= 0; r--) {
      var it = refs[r], lk = locks[r], didUnlock = false;
      if (lk) {
        try { if (pfClearBlock(lk, "locked")) didUnlock = true; } catch (eU) {}
        if (didUnlock) unlocked++;
      }
      try {
        it.remove();
        if (didUnlock && lk && lk !== it) relock(lk);   // ① 删成功也要把祖先的锁还回去
      } catch (eR) {
        var alive = true;
        try { var _tn19 = it.typename; } catch (eD) { alive = false; }
        if (!alive) {                                   // ② 已被祖先带走: 不算失败
          if (didUnlock && lk && lk !== it) relock(lk);
          continue;
        }
        failed++;
        if (didUnlock && lk) relock(lk);                // 真失败: 同样还原锁定
      }
    }
    res.ok = true;
    res.deleted = refs.length - failed;
    res.failed = failed;
    res.skipped = 0;
    res.unlocked = unlocked;
    res.message = (refs.length > 0 ? "已清理 " + (refs.length - failed) + " 个对象" : "未发现可清理的对象") +
      (unlocked > 0 ? "（其中 " + unlocked + " 个原为锁定，已临时解锁）" : "") +
      (failed > 0 ? "，" + failed + " 处删除失败(已还原其锁定状态)" : "") + "。";
  } catch (err) {
    res.ok = false;
    res.error = "清理失败: " + String(err);
  }
  return pfReturn(res);
}


function pfDeleteHidden() {
  var res = { ok: false };
  try {
    if (app.documents.length === 0) { res.error = "当前没有打开的文档，请先打开一个 AI 文件。"; return pfReturn(res); }
    var doc = app.activeDocument;
    var refs = [];   // 待删除对象引用
    var failed = 0;

    // 收集范围: 只收**可见图层内**的隐藏对象。
    //   隐藏图层(含其子图层)整支跳过 —— 层内的隐藏对象一律不删。
    //   可见性沿树向下传递, 故可见图层里遇到的隐藏组/隐藏对象才是收集目标。
    // ⚠ v10.53(审查 A1): seenSym = 已下钻过的**符号定义源**容器(按对象去重)。
    //   根因: 多个可见实例引用同一符号时 sdH.item 返回同一份定义源 —— 原实现每个实例
    //   各下钻一遍 ⇒ 定义源内的隐藏对象 O 被 refs.push(O) 多次。删除循环里第二次
    //   refs[r].remove() 抛异常 ⇒ failed++ ⇒ 报出"，N 处删除失败(可能被锁定，需先解锁再试)"。
    //   数字恰好还是对的(refs.length - failed 抵消了重复), 但提示会**误导用户去解锁一堆
    //   根本没锁的东西** —— 雪糕可见的误报。去重后每个物理对象在 refs 里只出现一次。
    //   ⚠ 依赖 `===` 对"同一文档内同一符号定义源"的恒等性; 万一某版 AI 上不成立, 行为
    //     退化为去重之前的样子(不会更差) —— 已记入真机待验清单。
    //   ⚠ 副作用(有意为之): 卡②的隐藏计数是**按实例**累加的(检查端 visitItem 对多个实例
    //     重复扫描, 注释写明"与'实际输出内容'口径一致"), 而本动作删的是定义源对象本身 ——
    //     一次 remove 影响该符号的所有实例。故"卡②报 6 / 删完报 2"是两侧口径使然, 非漏删。
    var seenSym = [];
    function collectItems(items, depth) {
      // v10.53(审查 新-1): 补上限, 防异常/损坏文档里的符号自引用无限递归。
      //   ⚠ 取值必须是 64, **不能**照抄符号下钻那三处的 8 —— 本函数的 depth 同时计
      //     **普通组/复合路径的嵌套**, 而卡②的隐藏计数走 visitItem(上限 64, 且每个顶层
      //     对象都从 0 起算, 与这里 collectItems(ly.pageItems, 0) 完全对齐) ⇒ 取 8 会让
      //     "第 9 层组内的隐藏对象"被检查端计入、却收集不到, 反而造出新的对不上账。
      if (depth > PF_MAX_DEPTH) return;
      for (var i = 0; i < items.length; i++) {
        var it = items[i], tn = "";
        try { tn = it.typename; } catch (eT) { continue; }
        var hid = false;
        try { hid = (it.hidden === true); } catch (eH) {}
        if (hid) { refs.push(it); continue; }   // 隐藏组/隐藏对象: 整体收,不下钻
        if (tn === "GroupItem") {
          try { collectItems(it.pageItems, depth + 1); } catch (eG) {}
        } else if (tn === "CompoundPathItem") {
          try { collectItems(it.pathItems, depth + 1); } catch (eC) {}   // 组件路径可能单个被隐藏
        } else if (tn === "SymbolItem") {
          // v10.46: 可见符号实例的定义源下钻 —— 检查端卡②的隐藏计数含
          //   "可见符号实例定义内的隐藏对象"(visitItem SymbolItem 分支), 删隐藏原先
          //   不收 ⇒ "卡②报 N 个 / 删完只报 M 个"且无提示。
          //   ⚠ 删的是**符号定义**内的对象, 影响该符号的所有实例 —— 确认框文案已说明
          //   (main.js onDelHidden); 实例自身隐藏时已在上面整体收掉(删实例不动定义)。
          //   v10.53: 定义源按 seenSym 去重, 同一符号只下钻一次(见上方说明)。
          try {
            var sdH = it.symbol;
            var srcH = null;
            if (sdH) { try { srcH = sdH.item; } catch (eSiH) {} if (!srcH) { try { srcH = sdH; } catch (eSdH2) {} } }
            if (srcH && srcH.pageItems) {
              var sDup = false;
              for (var ds = 0; ds < seenSym.length; ds++) { if (seenSym[ds] === srcH) { sDup = true; break; } }
              if (!sDup) { seenSym.push(srcH); collectItems(srcH.pageItems, depth + 1); }
            }
          } catch (eSymH) {}
        }
      }
    }

    // 隐藏图层一律跳过(不收集任何对象, 也不进其子图层) —— 交由人工处理。
    function walkLayers(lyrs, depth) {
      if (depth > PF_MAX_DEPTH) return;   // v10.39: 与主扫描 walkLayer 同款上限, 防异常层树
      for (var i = 0; i < lyrs.length; i++) {
        var ly = lyrs[i], vis = true;
        try { vis = (ly.visible !== false); } catch (eV) {}
        if (!vis) continue;   // 隐藏图层: 整支跳过(层内对象不删)
        // v11.90: 对照层整支跳过 —— 与主扫描同口径。隐藏态本来就走上面那条 continue,
        //   这里兜的是"可见的对照层"这一支: 栅格图元自身不 hidden, 本来也收不到, 但显式
        //   跳过可以保证将来判定口径变化时不会把对照图当成"隐藏对象"删掉。
        if (pfIsAuxLayer(ly)) continue;
        try { collectItems(ly.pageItems, 0); } catch (eCi) {}
        // v10.39: 原为 walkLayers(subs[j]) —— 传的是**单个 Layer**, 而 Layer.length
        //   是 undefined ⇒ `0 < undefined` 为假 ⇒ 循环体一次都不执行 ⇒ 子图层整支被跳过(笔误)。
        //   对照 pfUsedColorKeys 的同名函数是传 subs 集合。修好前: 子图层内的隐藏对象既不会
        //   被收集也不会被删除, 而卡②的隐藏计数(走 walkLayer, 递归本来正确)**含**子图层
        //   ⇒ 会出现"卡②报 N 个 / 删完只报 M 个"且无任何提示。
        try { var subs = ly.layers; if (subs && subs.length) walkLayers(subs, depth + 1); } catch (eL2) {}
      }
    }
    walkLayers(doc.layers, 0);

    // 删除(倒序;引用互不为祖先/后代,顺序无影响)
    for (var r = refs.length - 1; r >= 0; r--) {
      try { refs[r].remove(); } catch (eR) { failed++; }
    }

    res.ok = true;
    res.deleted = refs.length - failed;
    res.failed = failed;
    res.message = (refs.length > 0 ? "已删除隐藏对象 " + (refs.length - failed) + " 个" : "未发现可删除的隐藏对象") +
      (failed > 0 ? "，" + failed + " 处删除失败(可能被锁定，需先解锁再试)" : "") +
      "。隐藏图层（含层内对象）已保留。";
  } catch (err) {
    res.ok = false;
    res.error = "删除隐藏对象失败: " + String(err);
  }
  return pfReturn(res);
}

// ============================================================
// v11.41: 定位 —— 选中某张卡的全部问题对象
// ------------------------------------------------------------
// 设计约束(改前先读这里):
//   ① **不用 PageItem.editable**: 它是 AI 24.0(CC2020) 才引入的属性, 而 manifest
//      声明的是 ILST [17.0,99.9]。旧版读不到 ⇒ 若拿 `editable !== true` 当门,
//      所有对象都会被判成不可选, 定位永远返回 0 个。这里自己聚合 hidden/locked/父链。
//   ② **不用 uuid / getPageItemFromUuid**(同为 24.0+), 改成点定位时现扫一遍:
//      零版本依赖, 且能选中该卡**全部**问题对象 —— 样本池只留 SAMPLE_CAP 条,
//      uuid 方案只能定位那几条, 卡上写"50 处"时另外 45 处没有入口。
//   ③ **只改 selection, 不碰 locked / hidden / visible**: 锁定与隐藏对象只计数回报。
//      雪糕定的是"只报告不改状态", 别顺手加解锁。
//   ④ 判定**一律复用现有全局函数**(pfPpiOf / pfInkLightBoth / pfOvpFill / pfJunkEach),
//      不在这里另写阈值, 否则会出现"扫出 8 个、定位只找到 7 个"。
// ============================================================

// 图片 ppi —— 原为 runPreflight 内的 ppiOf 局部函数, v11.41 提为全局供定位复用
//   (runPreflight 里保留一个同名 alias, 只有这一份实现)。
//   缩放因子取矩阵基向量模长: x轴->(A,B), y轴->(C,D)。
//   · 模长与旋转/斜切角度无关 —— 旧实现只看 A/D 轴向分量, 旋转45°时真实 212ppi
//     会被高估成约 300ppi 判为达标(漏检), v3.3 改模长。
//   · 返回**原值**不取整 —— 提前 Math.round 会让 299.6ppi 被当成 300 判达标,
//     一律由前端显示时再取整(与油墨总量同一口径)。
//   返回 -1 表示读不到(调用方一律当作"不判")。
function pfPpiOf(item) {
  try {
    var m = item.matrix;
    var sx = Math.sqrt(m.mValueA * m.mValueA + m.mValueB * m.mValueB);
    var sy = Math.sqrt(m.mValueC * m.mValueC + m.mValueD * m.mValueD);
    if (sx < 0.0001 || sy < 0.0001) return -1;
    return Math.min(72 / sx, 72 / sy);
  } catch (e) { return -1; }
}

// 链接图文件的像素宽高 —— 读文件头, 支持 PSD/PSB/PNG/JPEG/TIFF（v11.50）
//   为什么需要: 见 pfPpiReal 里的真机实测说明。PlacedItem 的 matrix 拿不到真实 ppi。
//   返回 null 表示读不到(路径空 / 文件不存在 / 格式不认识), 调用方退回 matrix 算法。
//   ⚠ 只读前 4KB, 不做全文件扫描; 结果按**路径**缓存(同一文件置入多份只读一次)。
var PF_PX_CACHE = [];
function pfU32be(s, i) {
  return s.charCodeAt(i) * 16777216 + s.charCodeAt(i + 1) * 65536 +
         s.charCodeAt(i + 2) * 256 + s.charCodeAt(i + 3);
}
function pfU16be(s, i) { return s.charCodeAt(i) * 256 + s.charCodeAt(i + 1); }
function pfU32le(s, i) {
  return s.charCodeAt(i + 3) * 16777216 + s.charCodeAt(i + 2) * 65536 +
         s.charCodeAt(i + 1) * 256 + s.charCodeAt(i);
}
function pfU16le(s, i) { return s.charCodeAt(i + 1) * 256 + s.charCodeAt(i); }

// v11.100(性能): 缓存改成**跨轮保活 + 文件指纹校验**, 不再每轮清空。
//   原实现每轮 `PF_PX_CACHE = []`(v11.82 为了让"外部换图后重新更新链接"能生效), 代价是
//   每次检查都要把每张链接图**重新打开读 4KB** —— 本地盘还好, 图挂网络盘时一次 open
//   可能要几百毫秒, 几十张图就是十几秒, 这也是"有时候卡好几分钟"的来源之一。
//   现在按 `路径 + 文件大小 + 修改时间` 认文件: 换了图 ⇒ 指纹变 ⇒ 自动重读;
//   没换 ⇒ 只做一次 stat(不 open、不读内容), 比读 4KB 便宜一个量级。
var PF_PX_CACHE_MAX = 800;
function pfPxStat(fp) {
  try {
    var f = new File(fp);
    if (f.exists !== true) return "miss";
    var l = 0, m = 0;
    try { l = f.length || 0; } catch (e1) {}
    try { m = f.modified ? f.modified.getTime() : 0; } catch (e2) {}
    return l + "|" + m;
  } catch (e0) { return ""; }
}
function pfPxSize(path) {
  var fp = "";
  try { fp = String(path); } catch (e0) { return null; }
  if (fp === "") return null;
  var st = pfPxStat(fp), c;
  for (c = 0; c < PF_PX_CACHE.length; c++) {
    if (PF_PX_CACHE[c].p !== fp) continue;
    if (PF_PX_CACHE[c].st === st) return PF_PX_CACHE[c].sz;
    PF_PX_CACHE.splice(c, 1);      // 文件变了 ⇒ 旧值作废, 下面重读
    break;
  }
  var sz = pfPxSizeRaw(fp);
  if (PF_PX_CACHE.length >= PF_PX_CACHE_MAX) PF_PX_CACHE.shift();
  PF_PX_CACHE.push({ p: fp, st: st, sz: sz });
  return sz;
}

// v12.6: JPEG 的 SOF 补读 —— 4KB 内没扫到就按段头跳。
//   只读每段 4 字节的头(FF xx len_hi len_lo), 段体用 seek 跳过:
//   几十 KB 的 ICC/XMP 也只花一次 seek, 不把整个文件读进来。
//   段序: SOI → APPn/COM… → SOF → DHT/DQT… → SOS(压缩数据)。SOF 必在 SOS 之前。
function pfJpegSizeSeek(fp) {
  var f = null;
  try { f = new File(fp); } catch (e0) { return null; }
  try { f.encoding = "BINARY"; } catch (e1) {}
  var opened = false;
  try { opened = f.open("r"); } catch (e2) { opened = false; }
  if (!opened) return null;
  var out = null, pos = 2, guard = 0;
  try {
    while (guard++ < 1024) {          // 段数上限: 防损坏文件里的死循环(JPEG 通常 <100 段)
      try { f.seek(pos, 0); } catch (e3) { out = null; break; }
      var bh = null;
      try { bh = f.read(4); } catch (e4) { bh = null; }
      if (!bh || bh.length < 4) { out = null; break; }
      if (bh.charCodeAt(0) !== 0xFF) { pos++; continue; }   // 填充字节: 逐字节找标记
      var mk = bh.charCodeAt(1);
      if (mk >= 0xC0 && mk <= 0xC3) {                       // SOF0/1/2
        try { f.seek(pos + 5, 0); } catch (e5) { out = null; break; }
        var so = null;
        try { so = f.read(4); } catch (e6) { so = null; }   // 高(2) + 宽(2)
        if (!so || so.length < 4) { out = null; break; }
        out = { w: pfU16be(so, 2), h: pfU16be(so, 0) };
        break;
      }
      // 无长度字段的标记: SOI(D8) / EOI(D9) / RSTn(D0~D7) / TEM(01) —— 只前进 2 字节
      if (mk === 0xD8 || mk === 0xD9 || mk === 0x01 || (mk >= 0xD0 && mk <= 0xD7)) { pos += 2; continue; }
      if (mk === 0xDA) { out = null; break; }               // SOS 之后是压缩数据, SOF 不会再来
      var segLen = pfU16be(bh, 2);
      if (segLen < 2) { out = null; break; }
      pos += 2 + segLen;
    }
  } catch (e7) { out = null; }
  try { f.close(); } catch (e8) {}
  return out;
}

function pfPxSizeRaw(fp) {
  var f = null, head = null;
  try { f = new File(fp); } catch (e1) { return null; }
  var ex = false;
  try { ex = (f.exists === true); } catch (e2) { return null; }
  if (!ex) return null;
  try { f.encoding = "BINARY"; } catch (e3) {}
  var opened = false;
  try { opened = f.open("r"); } catch (e4) { opened = false; }
  if (!opened) return null;
  try { head = f.read(4096); } catch (e5) { head = null; }
  try { f.close(); } catch (e6) {}
  if (!head || head.length < 26) return null;

  // PSD / PSB: "8BPS" —— 高在 offset 14, 宽在 18(各 4 字节大端)
  if (head.substr(0, 4) === "8BPS") {
    return { w: pfU32be(head, 18), h: pfU32be(head, 14) };
  }
  // PNG: 89 50 4E 47 —— 宽 16, 高 20
  if (head.charCodeAt(0) === 0x89 && head.substr(1, 3) === "PNG") {
    return { w: pfU32be(head, 16), h: pfU32be(head, 20) };
  }
  // JPEG: FF D8 开头, 扫 SOF0/1/2 —— SOF 段内: 高@+5, 宽@+7
  if (head.charCodeAt(0) === 0xFF && head.charCodeAt(1) === 0xD8) {
    var ji = 2;
    while (ji + 9 < head.length) {
      if (head.charCodeAt(ji) !== 0xFF) { ji++; continue; }
      var mk = head.charCodeAt(ji + 1);
      if (mk >= 0xC0 && mk <= 0xC3) {
        return { w: pfU16be(head, ji + 7), h: pfU16be(head, ji + 5) };
      }
      // v12.11: 与 pfJpegSizeSeek 的标记处理对齐 —— 下面这几类标记**没有长度字段**:
      //   SOI(D8) / EOI(D9) / TEM(01) / RSTn(D0~D7)。原实现一律按"有长度"跳,
      //   撞上它们会把紧随其后的两个字节当段长 ⇒ 段边界跳错 ⇒ 错过 SOF ⇒ 白付一次 seek。
      //   ⚠ 只补这一条, 不采纳"遇 SOS(DA) 直接 return null": 那会把"因跳错而错过"
      //     误判成"文件里没有 SOF", 退回 matrix ⇒ 300dpi 图报 72ppi(假低清, v12.6 刚修过)。
      //     SOS 之后仍交给 pfJpegSizeSeek 重扫一次, 多一次 I/O 换零误报风险。
      if (mk === 0xD8 || mk === 0xD9 || mk === 0x01 || (mk >= 0xD0 && mk <= 0xD7)) {
        ji += 2; continue;
      }
      var len = pfU16be(head, ji + 2);
      if (len < 2) break;
      ji += 2 + len;
    }
    // v12.6: 4KB 内没找到 SOF ⇒ 按段 seek 补读(见 pfJpegSizeSeek)。
    //   印前 JPEG 常带 APP2(CMYK ICC) / APP13(XMP), 单段几十 KB, SOF0 落在 4KB 之后。
    //   旧实现直接返回 null ⇒ pfPpiReal 退回 matrix ⇒ 300dpi 图报 72ppi ⇒ 假低清误报。
    return pfJpegSizeSeek(fp);
  }
  // TIFF: II*\0(小端) / MM\0*(大端), IFD 里 tag 256=宽, 257=高
  var isII = (head.charCodeAt(0) === 0x49 && head.charCodeAt(1) === 0x49);
  var isMM = (head.charCodeAt(0) === 0x4D && head.charCodeAt(1) === 0x4D);
  if (isII || isMM) {
    var ifd = isII ? pfU32le(head, 4) : pfU32be(head, 4);
    if (ifd <= 0 || ifd + 2 > head.length) return null;
    var n = isII ? pfU16le(head, ifd) : pfU16be(head, ifd);
    if (n > 200) return null;
    var ww = -1, hh = -1;
    for (var ti = 0; ti < n; ti++) {
      var eo = ifd + 2 + ti * 12;
      if (eo + 12 > head.length) break;
      var tag = isII ? pfU16le(head, eo) : pfU16be(head, eo);
      if (tag !== 256 && tag !== 257) continue;
      var typ = isII ? pfU16le(head, eo + 2) : pfU16be(head, eo + 2);
      var val = (typ === 3)
        ? (isII ? pfU16le(head, eo + 8) : pfU16be(head, eo + 8))
      : (isII ? pfU32le(head, eo + 8) : pfU32be(head, eo + 8));
      if (tag === 256) ww = val; else hh = val;
    }
    if (ww > 0 && hh > 0) return { w: ww, h: hh };
    return null;
  }
  return null;
}

// 图片有效 ppi —— 检查端(resoCheck)与定位端(卡⑤)都调这个（v11.50 起）
//   ⚠ 为什么链接图不能只靠 matrix(真机实测 2026-10-28):
//     同一张 3071px 的 PSD 放在 737pt 宽的位置, PlacedItem.matrix 是**单位阵**(1,0,0,-1)
//     ⇒ 72/1 = 72ppi; 而真实值 = 3071 × 72 / 737 = **300.00ppi**。同一张图缩到 379.9pt 时
//     matrix 给 139.67ppi, 真实值 581.97ppi —— 偏差恒定在"原生 dpi / 72"这一档。
//     原因: PlacedItem 的 matrix 表示"相对**原生放置尺寸**的缩放", 链接文件的 dpi 已被
//     AI 吃进原生尺寸里, matrix 里再没有它。
//     而 RasterItem(嵌入) 的 matrix 是 像素→pt, 72/缩放 一直成立(宽/缩放 = 原始像素数,
//     与"像素数÷物理尺寸"数学等价), v3.3 起有效 —— 所以**嵌入图不改**。
//   ⇒ 链接图改走"文件像素 ÷ 画布尺寸"; 读不到文件(缺失/网络盘/不认识格式)退回 matrix 算法。
//   ⚠ 旋转: width/height 是包围盒, 转过角度的对象会让两条边算出的 ppi 明显不一致 ——
//     差值超 15% 就判定"疑似旋转/剪裁"，退回 matrix 算法, 宁可不改也不制造新误报。
function pfPpiReal(item) {
  var tn = "";
  try { tn = item.typename; } catch (e0) { return pfPpiOf(item); }
  if (tn !== "PlacedItem") return pfPpiOf(item);
  var sz = null;
  try { sz = pfPxSize(item.file.fsName); } catch (e1) { sz = null; }
  if (!sz || !(sz.w > 0) || !(sz.h > 0)) return pfPpiOf(item);
  var wp = -1, hp = -1;
  try { wp = item.width; } catch (e2) { wp = -1; }
  try { hp = item.height; } catch (e3) { hp = -1; }
  if (!(wp > 0.0001) || !(hp > 0.0001)) return pfPpiOf(item);
  var pw = sz.w * 72 / wp;
  var ph = sz.h * 72 / hp;
  var mx = (pw > ph) ? pw : ph;
  var mn = (pw > ph) ? ph : pw;
  if (mx > 0 && (mx - mn) / mx > 0.15) return pfPpiOf(item);   // 疑似旋转 / 剪裁
  return mn;
}

// 分辨率是否偏低 —— 检查端(resoCheck)与定位端(卡⑤)共用这一份判据（v11.46 起）
//   ⚠ 别在任一侧再写裸比较: v11.45 之前就是两边各写一份, 一改就不同源。
//   容差见 RESO_TOL_PCT 处说明(0.5%: 阈值 300 时 ≥298.5 算达标)。
//   显示端另做保留 1 位小数(main.js renderCardResolution)。
function pfResoLow(ppi) {
  if (!(ppi >= 0)) return false;              // NaN / -1(矩阵读不到) 一律不算偏低
  return (ppi < RESO_MIN * (1 - RESO_TOL_PCT));
}

// ============================================================
// 定位用「扫描缓存」(v11.81 / 雪糕选 A: 通用缓存)
//   问题: 卡⑤⑥⑦⑨ 的「查找位置」每次都要把整棵树重走一遍 —— ⑥⑦ 走
//     pfLocGather(doc.layers)、⑨ 走 pfJunkEach，两条都是全树递归，
//     3000 对象 × 12~15 次属性读 ⇒ 真机 1~4 秒。
//   做法: **检查轮已经把这批对象逐个判过一遍了**（同一套判据、同一个函数），
//     顺手把命中的对象引用存进下面几个池子；定位时直接取数组，不再重走树。
//     省下的正是"对同一批对象把一模一样的判定再做一次"这份纯重复劳动。
//   ⚠ 三个必须守住的点（改这段前先读完）:
//     ① **隐藏对象检查端不判**（隐藏内容不参与印刷统计）⇒ 缓存里不能只有可见的。
//        否则"问题对象全在隐藏图层里"时定位会回报"没找到可定位的对象" ——
//        而那句话恰恰是用户最需要看到的（他知道该去哪个图层找）。
//        ⇒ visitItem 遇到隐藏组 / 隐藏对象时**只收引用不判据**，放进 hid 池；
//        定位端对这批单独跑一遍判据（隐藏对象本来就少，代价回到旧水平）。
//     ② **符号实例**: 符号定义源里的对象不在画布上，塞进 doc.selection 会崩
//        （v11.48 同类雷）。⇒ 下钻符号期间用 curSym 记住当前实例，
//        一切入池都落在这个实例上；绝不能把定义源对象存进池子。
//     ③ **失效只认「同一文档引用 + 最近一轮扫描跑完」**。用户改稿后再点定位会拿到
//        旧引用 —— pfLocOk 的 try/catch 会让它落进"锁定/隐藏"计数，不崩但数字不准；
//        要准确就重新检查一次（旧版同样是"先检查再定位"的流程）。
//   ⚠ PF_LOC_USE_SCAN_CACHE = false 整条回落旧路径（一行切换，出问题先关它）。
//   ⚠ ③④ **不进缓存**: 它们走 doc.textFrames / doc.placedItems 文档级集合，
//     本来就快（v11.44 实测过），加缓存只会丢掉"隐藏对象"的口径。
// ============================================================
var PF_LOC_USE_SCAN_CACHE = true;
var PF_LOC_SCAN = null;
// 隐藏池配额 —— 超大隐藏子树（整本画册的隐藏备份页）不该把检查拖慢。
//   溢出就置 hidCut ⇒ 该轮定位整体回落旧路径：宁可慢一次，不给错结果。
var PF_LOC_HID_MAX = 2000;
var PF_LOC_HID_N = 0;

function pfLocCacheReset(doc, ck) {
  PF_LOC_SCAN = {
    doc: doc,
    ck: ck,                 // 检查轮各卡开关快照 —— 该卡这轮没扫 ⇒ 定位回落旧路径
    ready: false,           // 扫描完整走完才盖章（中途抛错的是半成品，不能用）
    c5: [], c7: [], c9: [],
    c6: { over: [], heavy: [], light: [], thin: [] },
    hid: [],
    hidCut: false,
    overflow: false        // v11.100: 任一池超上限 ⇒ 本轮定位回落旧路径
  };
  PF_LOC_HID_N = 0;
}

// 按**引用**去重后入池 —— 同一对象重复出现会让 doc.selection 报错（v11.48 同类雷）。
//   末尾快速判覆盖最常见的一种重复：卡⑦ 同一对象的填充、描边先后各命中一次。
// v11.100(性能): 池子加上限 —— 原实现在**每次** push 前线性扫全池,
//   于是在大文档上退化成 O(n²): 一万个命中对象 = 五千万次 `===` 比较, 而每次比较
//   都是一次宿主对象代理调用 ⇒ 这就是"打开文件跑检查卡好几分钟"的头号嫌疑。
//   现在: 池子超过上限就置 overflow, 该轮定位整体回落旧路径(与 hidCut 同一套策略:
//   宁可慢一次, 不给错结果)。上限取 400 —— 正常标签稿命中数远小于它, 溢出只发生在
//   "整本画册几千个对象都超标"这种场合, 那时用户点定位本来就慢, 回落旧路径合理。
var PF_LOC_POOL_MAX = 400;
function pfLocPush(arr, it) {
  if (!arr || !it) return;
  var n = arr.length;
  if (n > 0 && arr[n - 1] === it) return;      // 最常见: 填充、描边连着各命中一次
  if (n >= PF_LOC_POOL_MAX) {
    try { if (PF_LOC_SCAN) PF_LOC_SCAN.overflow = true; } catch (eOvf) {}
    return;
  }
  for (var i = 0; i < n; i++) { if (arr[i] === it) return; }
  arr.push(it);
}

// 父容器(组 / 图层)可选中状态缓存 —— 同一容器下的对象不再逐个重爬父链（v11.47）
//   雪糕: "选中速度还能再快点么？还是没 AI 自带的选择所有文本快"。
//   原来每帧都从自己往上爬: 每层读 3 个属性(locked / hidden / visible) —— 500 个文本帧
//   × 4 层 ≈ 6000 次跨桥, 全花在读同一批组和图层上。
//   现在每个容器只算一次, 结果按**引用**存数组里线性查(容器数量比对象少两个数量级)。
//   ⚠ 必须每轮 pfLocate 开头 `PF_LOC_CACHE.length = 0` —— 否则用户中途解锁/显示后
//     再点定位, 会拿到上一轮的旧结论。
//   ⚠ 深度上限沿用 PF_MAX_DEPTH, 超限按"可选中"处理(与旧实现 break 后 return true 一致)。
var PF_LOC_CACHE = [];
function pfLocParentOk(p, d) {
  var n = PF_LOC_CACHE.length;
  for (var i = 0; i < n; i++) { if (PF_LOC_CACHE[i].p === p) return PF_LOC_CACHE[i].ok; }
  var ok = true;
  if (d > PF_MAX_DEPTH) { PF_LOC_CACHE.push({ p: p, ok: true }); return true; }
  try { if (p.locked === true) ok = false; } catch (e0) {}
  if (ok) { try { if (p.hidden === true) ok = false; } catch (e1) {} }
  if (ok) { try { if (p.visible === false) ok = false; } catch (e2) {} }
  if (ok) {
    var up = null, tn = "";
    try { up = p.parent; } catch (e3) { up = null; }
    if (up) { try { tn = up.typename; } catch (e4) { tn = ""; } }
    if (up && tn !== "Document") ok = pfLocParentOk(up, d + 1);
  }
  PF_LOC_CACHE.push({ p: p, ok: ok });
  return ok;
}

// 可选中判定: 自身 + 整条父链(组 / 图层)都未隐藏、未锁定、图层可见
function pfLocOk(it) {
  try { if (it.hidden === true) return false; } catch (e0) { return false; }
  try { if (it.locked === true) return false; } catch (e1) {}
  var p = null;
  try { p = it.parent; } catch (e2) { return true; }
  if (!p) return true;
  var tn = "";
  try { tn = p.typename; } catch (e3) { tn = ""; }
  if (tn === "Document") return true;
  return pfLocParentOk(p, 1);
}

// 不可选的原因: "隐藏" 或 "锁定"(只用于回报文案)
function pfLocWhy(it) {
  var hd = false;
  try { hd = (it.hidden === true); } catch (e0) {}
  if (!hd) {
    var p = null, d = 0;
    try { p = it.parent; } catch (e1) {}
    while (p && d < PF_MAX_DEPTH) {
      d++;
      var tn = "";
      try { tn = p.typename; } catch (e2) { break; }
      if (tn === "Document") break;
      try { if (p.hidden === true || p.visible === false) { hd = true; break; } } catch (e3) {}
      try { p = p.parent; } catch (e4) { break; }
    }
  }
  return hd ? "隐藏" : "锁定";
}

// 矢量链接(PDF/AI/EPS/SVG)没有有效分辨率 —— 与检查端 isVec 同一份判据（v11.45）
//   为什么必须共用: 检查端在 resoCheck 之前专门跳过这些扩展名, 理由写在那边 ——
//   "identity 矩阵会被算成 72ppi 而误报低于 300ppi"(v3.6 修的 bug)。
//   定位端 v11.44 只判 pfPpiOf < RESO_MIN, 漏了这道跳过 ⇒ 链接的 PDF/EPS 会被
//   当成 72ppi 一起选中, 而卡⑤ 正文里根本没报它。
//   ⚠ 扩展名读不到(空串)时返回 false = 照查, 与检查端"宁多查不漏查"同方向。
function pfLocIsVec(it) {
  var fp = "";
  try { fp = String(it.file.fsName); } catch (e0) { return false; }
  var dot = fp.lastIndexOf(".");
  var ext = (dot >= 0) ? fp.substring(dot + 1).toLowerCase() : "";
  return (ext === "ai" || ext === "ait" || ext === "pdf" || ext === "eps" ||
          ext === "svg" || ext === "svgz");
}

// 从**文档级集合**直接取对象 —— 不遍历整棵树（v11.44）
//   为什么: 卡③④⑤ 各自只要一种类型的对象, 走 pfLocGather 却要把文档里每个对象的
//   typename 读一遍(实测稿 3000+ 路径对象), 跨桥几千次只为挑出几十个。
//   doc.textFrames / placedItems / rasterItems 是文档级 pattern collection,
//   天然含组内对象, 数量小一两个数量级。
//   ⚠ ⑥⑦ 不走这里: 它们要 pathItems(3000+), 集合按下标索引会退化成 O(n²)
//     —— v11.33 实测 476ms vs 树递归 7.9ms。
//   ⚠ out 里按**引用**去重: 卡⑤ 的 rasterItems 与 placedItems 可能命中同一个对象,
//     重复对象塞进 doc.selection 会报错。
function pfLocTake(doc, collName, out, keep) {
  var coll = null;
  try { coll = doc[collName]; } catch (e0) { return; }
  var lim = 0;
  try { lim = coll.length; } catch (e1) { return; }
  for (var i = 0; i < lim; i++) {
    var it = null;
    try { it = coll[i]; } catch (e2) { continue; }
    if (!it) continue;
    if (keep) {
      var ok = false;
      try { ok = keep(it); } catch (e3) { ok = false; }
      if (!ok) continue;
    }
    var dup = false;
    for (var d = 0; d < out.length; d++) { if (out[d] === it) { dup = true; break; } }
    if (!dup) out.push(it);
  }
}

// 对象所在图层名(回报"去哪个图层找"; 拿不到返回空串)
function pfLocLayerName(it) {
  try { return String(it.layer.name || ""); } catch (e0) {}
  try {
    var p = it.parent, d = 0;
    while (p && d < PF_MAX_DEPTH) {
      d++;
      var tn = "";
      try { tn = p.typename; } catch (e1) { break; }
      if (tn === "Layer") { try { return String(p.name || ""); } catch (e2) { return ""; } }
      if (tn === "Document") break;
      try { p = p.parent; } catch (e3) { break; }
    }
  } catch (e4) {}
  return "";
}

// 树递归收集命中 match(it, tn) 的对象 —— 含组内; 不下钻符号定义源
//   (与 pfJunkEach 的口径一致: 符号定义源里的对象不是文档里实际渲染的那一份)
function pfLocGather(items, depth, out, match) {
  if (depth > PF_MAX_DEPTH) return;
  var lim = 0;
  try { lim = items.length; } catch (e0) { return; }
  for (var i = 0; i < lim; i++) {
    var it = items[i], tn = "";
    try { tn = it.typename; } catch (e1) { continue; }
    // v11.90: 对照层整支跳过 —— 必须在 match() **之前**: 否则"选中所选卡的问题对象"会把
    //   这一层本身也塞进 selection(各卡的 match 只认对象类型, 但它拿到的第一个东西就是
    //   Layer 本身); 层里的那张满版栅格更会被当成"低分辨率图片"选中(阈值调到 600 时)。
    if (tn === "Layer" && pfIsAuxLayer(it)) continue;
    try { if (match(it, tn)) out.push(it); } catch (e2) {}
    var kids = null;
    // v11.43: **Layer 分支** —— 这是 v11.41 定位功能"永远没找到对象"的根因。
    //   入口传的是 doc.layers, 集合元素是 Layer; 原来只处理 GroupItem / CompoundPathItem,
    //   Layer 的 kids 恒为 null ⇒ 不递归 ⇒ out 恒空 ⇒ 不管点哪张卡都提示
    //   "没找到可定位的对象，请重新检查。"。
    //   ⚠ 别再改成"入口传 doc.pageItems"来绕过: doc.pageItems 只给顶层项,
    //     组里和复合路径里的照样收不到, 而且拿不到锁定/隐藏图层里的对象(那些也要计数提示)。
    if (tn === "Layer") {
      try { kids = it.pageItems; } catch (eL) { kids = null; }
      // v11.56: 子图层也要递归。旧实现只走 pageItems ⇒ 二级及更深子图层里的问题对象
      //   检查端能报出来, 定位端却一个都收不到(卡⑥⑦"点了没反应")。
      try {
        var subLayers = it.layers;
        if (subLayers && subLayers.length) pfLocGather(subLayers, depth + 1, out, match);
      } catch (eLs) {}
    }
    else if (tn === "GroupItem") { try { kids = it.pageItems; } catch (e3) { kids = null; } }
    // ⚠ v11.54: **不再下钻 CompoundPathItem 的组件**。
    //   原来这里 `kids = it.pathItems` —— 而 match 已经对复合路径本体跑过一遍
    //   (且判色时下钻 pathItems[0]), 于是本体命中后**每个组件**又被当普通 PathItem
    //   判一遍, 组件与 pathItems[0] 同色必然同时命中 ⇒ 一次点选把
    //   "本体 + N 个组件" 全塞进 doc.selection。
    //   后果两条: ① 提示"已选中 N 个"虚高; ② **组件不是可选中对象**, 塞进 selection
    //   与 v11.48 塞隐藏文本帧同类(原生层崩, try/catch 接不住)。
    //   v11.49 的"复合路径判色下钻"已由 match 里的 src = it.pathItems[0] 承担,
    //   不靠递归。⚠ 卡⑦ 的判据同批改成读 pathItems[0](否则这对它就成了漏选)。
    //   (bt115 用**真实** pfLocGather 守住这条; bt110 因把 pfLocGather 桩成平铺循环,
    //    从来没有覆盖到这里。)
    else if (tn === "SymbolItem") {
      // v11.51: **符号下钻定义源** —— 这是"油墨超标报了却选不中"的另一半原因。
      //   检查端 visitItem 的 SymbolItem 分支从 v4.8 起就下钻 `pfSymSource(it).pageItems`
      //   扫描内部对象(含油墨/叠印/缺字体/分辨率), 而定位端完全没有这个分支 ⇒
      //   符号定义源里的问题对象一个都收不到 ⇒ 卡里报了、点定位没反应。
      //   ⚠ 命中后收的是**符号实例(it)**, 不是定义源里的那些对象:
      //     定义源对象不在画布上, 塞进 doc.selection 是原生层不接受的状态
      //     (v11.48 卡③ 崩溃的同一类雷), 用户也看不到它被选中。
      //     选实例 ⇒ 画布上高亮 = 用户知道是哪个符号, 双击进符号编辑再处理。
      //   ⚠ 同一符号的多个实例会各自下钻一遍(检查端也是重复扫描, 口径一致);
      //     符号数量通常很少, 不额外做缓存, 免得引入"改过符号没刷新"的假命中。
      var ss = null;
      try { ss = pfSymSource(it); } catch (eS1) { ss = null; }
      if (ss && ss.pageItems) {
        var tmp = [];
        pfLocGather(ss.pageItems, depth + 1, tmp, match);
        if (tmp.length > 0) out.push(it);
      }
      kids = null;   // 已自行处理, 不再走下面的通用递归
    }
    if (kids) pfLocGather(kids, depth + 1, out, match);
  }
}

// 卡⑥ 定位专用: 该颜色是否属于卡里报告的任何一类油墨问题（v11.52 / v11.53 加 sub）
//   ⚠ 为什么不能只判"超标": 卡⑥ **报了四块** ——
//       ① 油墨总量 >300(红)    ② 油墨总量 220~300 偏重(黄)
//       ③ 色版 <5% 极浅(黄)    ④ 描边 <0.1mm(黄)
//     而定位端原来只覆盖 ① 和 ④ ⇒ 偏重和极浅色版"卡里报了、点定位一个都选不上"，
//     真实症状就是"只能选中描边过细的"（雪糕 2026-10-28 报障）。
//   判据逐条对齐检查端:
//     · ① = `total > INK_WARN`
//     · ② = `INK_OK <= total <= INK_WARN`（检查端 else-if 分支的口径）
//     · ③ = pfInkLightBoth 返回的 light 非空（检查端 black.light 用的就是同一个字段）
//   v11.53: 加第 2 参 sub（over/heavy/light）—— 块内按钮各选各的, 不再四块并集。
//     不传 sub 时退回并集（卡头旧入口 + 老测试），语义与 v11.52 完全一致。
//   ⚠ 阈值一律读全局 INK_OK / INK_WARN（panelf 传入后覆盖），不要再写 220/300 字面量。
function pfLocInkAny(c, sub) {
  if (!c) return false;
  var r = null;
  try { r = pfInkLightBoth(c); } catch (e) { return false; }
  if (!r) return false;
  var t = r.total;
  var lt = (r.light !== null && r.light !== undefined && r.light !== "");
  if (sub === "over") return (t >= 0 && t > INK_WARN);        // 块① 超标
  if (sub === "heavy") return (t >= 0 && t >= INK_OK && t <= INK_WARN);  // 块② 偏重
  if (sub === "light") return lt;                             // 块③ 色版极浅
  if (t >= 0 && t >= INK_OK) return true;                     // 无 sub: 偏重 + 超标
  return lt;                                                  // 无 sub: 色版极浅
}

// 卡⑤⑥⑦ 的命中判据 —— **单一份真源**。
//   回落路径(pfLocGather)与缓存路径(隐藏池补判)共用它: 缓存里那批"检查端判过的"
//   对象直接取用, 但"检查端没判过的隐藏对象"必须在这里按同一套标准补判 ——
//   各抄一份必然走偏(⑥⑦ 的定位判据与检查端不同源, 历史上已经出过三次事故)。
//   返回 null = 该卡不走 match 形式(③④ 走文档级集合, ⑨ 走 pfJunkEach)。
function pfLocMatchFor(n, sub) {
  if (n === 5) {
    // v11.46: 判定走全局 pfResoLow(带 1% 容差) —— 与检查端 resoCheck 同一个函数,
    //   避免"卡里说达标、定位却选上"这种不同源。
    // v11.45: placedItems 侧必须**排除矢量链接** —— 与检查端 resoCheck 前那道
    //   isVec 跳过同源。否则链接的 PDF/EPS 会被当成 72ppi 低清选中,
    //   而卡⑤ 正文里根本没报它(检查端早跳过了)。
    // v11.50: 分辨率取值改 pfPpiReal —— 链接图读文件像素, 不再用 matrix(实测偏差 4.17 倍)
    return function (it, tn) {
      if (tn === "RasterItem") return pfResoLow(pfPpiReal(it));
      if (tn === "PlacedItem") {
        if (pfLocIsVec(it)) return false;
        return pfResoLow(pfPpiReal(it));
      }
      return false;
    };
  }
  if (n === 6) {
    // v11.53: 块内按钮的子类型。"" = 四块并集(卡头旧入口/兼容)。
    var inkSub = sub || "";
    return function (it, tn) {
      if (tn === "TextFrame") {
        // 块④ 描边<0.1mm 检查端**只统计图形** ⇒ 文字侧永不参与该块
        if (inkSub === "thin") return false;
        // 文字侧: 取整帧默认字符属性(与卡⑥正文侧口径一致)
        var ca = null;
        try { ca = it.textRange.characterAttributes; } catch (e) { return false; }
        // v11.45: 只判填充色 —— 检查端文本侧只 inkBucket(ca.fillColor), 从不判
        //   字符描边色的油墨。v11.44 这里把描边色也并进了判定 ⇒ "文字填充正常、
        //   但描边是高油墨"的帧会被选中, 而卡⑥ 正文里没报它(多选)。
        var t1 = null;
        try { t1 = ca.fillColor; } catch (e1) {}
        // v11.52: 改 pfLocInkAny —— 卡⑥ 报的"偏重(220~300)"与"色版<5%"也要能选中
        return pfLocInkAny(t1, inkSub);
      }
      if (tn !== "PathItem" && tn !== "CompoundPathItem") return false;
      // v11.49: 复合路径必须**下钻到第一个组件**再判颜色 —— 与检查端同源。
      //   检查端(v10.53 注释)是先 `scanPathInk(it.pathItems[0])`, 只读第一个组件;
      //   v11.44 起这里却读 CompoundPathItem **自身**的 fillColor/strokeColor。
      //   真机上该类型读自身色拿不到有效值 ⇒ 卡⑥ 报了"油墨超标"、定位却选不中
      //   (转曲后的"回"/"口"字、logo 大多就是复合路径)。
      //   ⚠ 下钻只用于**判定**, out 里收的还是用户要选的那个复合路径对象本身。
      var src = it;
      if (tn === "CompoundPathItem") {
        try { src = it.pathItems[0] || it; } catch (eCP) { src = it; }
      }
      // 描边过细(与主扫描同一条判据: 实测宽 < THIN - 0.005mm)
      var stk = false;
      try { stk = (src.stroked === true); } catch (e3) {}
      // v11.53: 只有"并集"与"块④"才看描边; 块①②③ 是纯油墨判据
      if (inkSub === "" || inkSub === "thin") {
        if (stk) {
          try {
            var mm = src.strokeWidth * PT2MM;
            if (mm >= 0 && mm < THIN_STROKE_MM - 0.005) return true;
          } catch (e4) {}
        }
        if (inkSub === "thin") return false;   // 块④ 只看描边, 不再往下判油墨
      }
      // v11.52: 油墨判定改 pfLocInkAny —— 覆盖卡⑥ 全部四块(超标 / 偏重 / 极浅色版 / 描边细)
      var f1 = null, f2 = null;
      try { if (src.filled !== false) f1 = src.fillColor; } catch (e5) {}
      try { if (stk) f2 = src.strokeColor; } catch (e6) {}
      return pfLocInkAny(f1, inkSub) || pfLocInkAny(f2, inkSub);
    };
  }
  if (n === 7) {
    return function (it, tn) {
      // v11.45: 文字必须走**字符级** —— 真机 AI 28 上 TextFrame 没有对象级
      //   fillOverprint / strokeOverprint(检查端 v8.3 有探针实测记录), pfOvpFill
      //   读不到属性会 try/catch 成 false。v11.44 这里用对象级判 ⇒ 文字叠印
      //   **永远选不上**, 而卡⑦ 正文明明报了 N 处文字叠印(漏选, 方向最危险)。
      if (tn === "TextFrame") {
        var ca = null;
        try { ca = it.textRange.characterAttributes; } catch (e7t) { return false; }
        return pfCharOvpFill(ca) || pfCharOvpStroke(ca);
      }
      if (tn !== "PathItem" && tn !== "CompoundPathItem") return false;
      // v11.54: 复合路径的叠印要读 **pathItems[0]**, 与检查端
      //   `scanPathInk(it.pathItems[0])` 同源(jsx 1338 那段注释记的"三处不一致"
      //   里, 定位端是第四处)。
      //   ⚠ 这条与 pfLocGather 删掉复合路径递归是**成对的**: 删了递归之后,
      //     若这里还读自身(真机该类型不暴露 fillOverprint/strokeOverprint),
      //     复合路径的叠印就彻底选不上了。bt115 守这对改动。
      var src7 = it;
      if (tn === "CompoundPathItem") {
        try { src7 = it.pathItems[0] || it; } catch (e7c) { src7 = it; }
      }
      return pfOvpFill(src7) || pfOvpStroke(src7);
    };
  }
  return null;
}

// v11.81: 从检查轮的扫描缓存取命中对象。
//   返回 true = 已处理完(哪怕结果是空的); 返回 false = 缓存不可用, 调用方回落旧路径。
//   ⚠ 五道闸门缺一不可, 每一道都对应一种"缓存里根本没有这张卡的数据"的现实:
//     ① 总开关关(PF_LOC_USE_SCAN_CACHE)
//     ② 没检查过 / 检查中途抛错(ready)
//     ③ 换了文档(doc 引用不同)
//     ④ 这张卡在检查轮是**关**的 —— 检查端一个属性都没读, 池子是空的。
//        没有这道闸, 用户"在设置里刚开了卡⑥、没重新检查就点定位"会拿到"没找到"，
//        而旧版此时是能找到的 ⇒ 会被当成"定位坏了"。
//     ⑤ 隐藏池溢出或藏了符号实例(hidCut) —— 无法保证完整, 交回旧路径。
function pfLocFromScan(doc, n, sub, out) {
  if (!PF_LOC_USE_SCAN_CACHE) return false;
  var s = PF_LOC_SCAN;
  if (!s || !s.ready) return false;
  try { if (s.doc !== doc) return false; } catch (eD) { return false; }
  var ck = s.ck;
  if (!ck) return false;
  // ③④ 不进缓存(见「扫描缓存」一节末); ⑨ 走 c9
  if (n !== 5 && n !== 6 && n !== 7 && n !== 9) return false;
  if (n === 5 && !ck.rs) return false;
  if (n === 6 && !ck.ik) return false;
  if (n === 7 && !ck.ov) return false;
  if (n === 9 && !ck.tx) return false;
  if (s.hidCut || s.overflow) return false;   // v11.100: 池子溢出 ⇒ 保证不了完整

  if (n === 9) {
    // 卡⑨: pfJunkEach 本就含隐藏/锁定对象 ⇒ c9 已是完整集合, 不必再补隐藏池
    var c9 = s.c9;
    for (var i9 = 0; i9 < c9.length; i9++) out.push(c9[i9]);
    return true;
  }

  if (n === 6) {
    var k = sub || "";
    if (k === "over" || k === "heavy" || k === "light" || k === "thin") {
      var a6 = s.c6[k];
      for (var i6 = 0; i6 < a6.length; i6++) out.push(a6[i6]);
    } else {
      // 并集(卡头旧入口): 四个池跨池去重 —— 同一对象可能既超标又色版极浅
      var keys = ["over", "heavy", "light", "thin"];
      for (var ki = 0; ki < keys.length; ki++) {
        var ak = s.c6[keys[ki]];
        for (var ai = 0; ai < ak.length; ai++) pfLocPush(out, ak[ai]);
      }
    }
  } else {
    var pool = (n === 5) ? s.c5 : s.c7;
    for (var p = 0; p < pool.length; p++) pfLocPush(out, pool[p]);
  }

  // 隐藏池补判 —— 检查端对隐藏内容一个属性都没读, 这批只能在这里按同一套判据过一遍。
  var hid = s.hid;
  if (hid && hid.length) {
    var mat = pfLocMatchFor(n, sub);
    if (!mat) return false;
    for (var h = 0; h < hid.length; h++) {
      var hi = hid[h], htn = "";
      try { htn = hi.typename; } catch (eH) { continue; }
      var okH = false;
      try { okH = mat(hi, htn); } catch (eH2) { okH = false; }
      if (okH) pfLocPush(out, hi);
    }
  }
  return true;
}

// 按卡号收集该卡的问题对象
//   3 字体·转曲   4 图片嵌入   5 图片分辨率
//   6 油墨·描边   7 叠印       9 清理
// v11.53: 第 4 参 sub 只对卡⑥ 有意义(over/heavy/light/thin) —— 块内按钮各选各的。
//   传空 = 卡⑥ 四块并集, 与 v11.52 口径一致。
function pfLocCollect(doc, n, out, sub) {
  // v11.81: 先试检查轮的扫描缓存(见文件末尾「扫描缓存」一节)。命中就到此为止 ——
  //   ⑥⑦⑨ 原本要全树递归 1~4 秒, 现在只是把数组拷出来。
  if (pfLocFromScan(doc, n, sub, out)) return;

  // 卡⑨ 直接复用清理遍历 —— 它已含"剪切组内单点/未上色对象不动"的保护判定
  if (n === 9) {
    pfJunkEach(doc, function (kind, it) { out.push(it); });
    return;
  }
  // v11.44: ③④⑤ 改成"直接取文档级专类集合", 不再遍历整棵树。
  //   雪糕: "现在这个字体转曲这块选择起来会有点慢"。
  //   慢的原因: 卡③ 只要 TextFrame, 却先走 pfLocGather 把文档里**每一个对象**的 typename
  //   读一遍(实测稿子里 3000+ 路径对象), 跨桥读几千次只为挑出几十个文本框。
  //   doc.textFrames / placedItems / rasterItems 是文档级集合, 本身含组内对象;
  //   数量比"全部页面项"小一两个数量级 ⇒ 跨桥次数跟着降下来。
  //   ⚠ ⑥⑦ **保持树递归**: 它们要 pathItems(3000+) + compoundPathItems + textFrames,
  //     三个集合逐个按下标索引反而更慢 —— v11.33 实测集合索引 476ms vs 树递归 7.9ms。
  if (n === 3) {
    // 未转曲的必然还是 TextFrame(转曲后已变 Path/Group)
    pfLocTake(doc, "textFrames", out, null);
    return;
  }
  if (n === 4) {
    // v11.85: 「非 CMYK 位图」段已移除, 卡④ 只剩卡头那枚按钮 —— 选未嵌入的链接图。
    pfLocTake(doc, "placedItems", out, function (it) {
      var em = false;
      try { em = (it.embedded === true); } catch (e4a) { return false; }
      return !em;
    });
    return;
  }
  if (n === 5) {
    // 两个集合并集: rasterItems(位图) 与 placedItems(放置图)。
    //   ⚠ 二者可能命中同一个对象, pfLocTake 内部按引用去重。
    pfLocTake(doc, "rasterItems", out, function (it) {
      return pfResoLow(pfPpiReal(it));
    });
    pfLocTake(doc, "placedItems", out, function (it) {
      if (pfLocIsVec(it)) return false;
      return pfResoLow(pfPpiReal(it));
    });
    return;
  }
  var match = pfLocMatchFor(n, sub);
  if (!match) return;
  pfLocGather(doc.layers, 0, out, match);
}

// 卡③ 极速路径(v11.47) —— **已回退**(v11.48): 真机一点就崩, AI 直接强制关闭。
//   雪糕实测: 字体·转曲卡点"选择所有文本", 面板转一圈后 AI 整个崩掉。
//   原因: 把 textFrames 集合**一次性塞给 selection** 的整批赋值, 把**隐藏/锁定**的
//   文本帧也塞了进去 —— AI 自带菜单"选择所有文本对象"内部会过滤不可选对象, 我们直接塞
//   集合没有这层保护; 这种崩溃发生在原生层, ExtendScript 的 try/catch 接不住,
//   对账 selection.length 也来不及。慢的问题由 PF_LOC_CACHE 父容器缓存继续扛
//   (每帧的父链状态只读一次, 收益主要在组内嵌套多的文档), 不再碰 selection。
// ============================================================

// 定位入口 —— 卡号见 pfLocCollect
//   提示条最多回报几个图层名: 多了会把 notice 撑成两行, 5 个够用户定位到方向。
//   ⚠ 必须是具名常量, 不能写成 length < 5 字面量 —— bt43 的 P3-1 用
//     /length < 5(?![0-9])/ 守"jsx 不再硬编码样本上限 5", 字面量会被它误伤。
var PF_LOC_LAYER_CAP = 5;
// v11.53: 第 2 参 sub = 卡⑥ 块内按钮的类型(over/heavy/light/thin)。
//   白名单在 panel 端 onLocate 已校验一次, 这里再兜一次: 拼进 evalScript 的
//   参数只可能落在这四个值或空串上。
function pfLocSubOk(sub) {
  return (sub === "over" || sub === "heavy" || sub === "light" || sub === "thin") ? sub : "";
}
function pfLocate(n, sub) {
  var res = { ok: false };
  try {
    if (app.documents.length === 0) { res.error = "当前没有打开的文档，请先打开一个 AI 文件。"; return pfReturn(res); }
    var doc = app.activeDocument;
    // v11.47: 每轮先清空父容器缓存(用户可能刚解锁/显示过对象)
    try { PF_LOC_CACHE.length = 0; } catch (eC0) {}
    // ⚠ v11.48: 不要在这里加"整批赋值"快路径 —— v11.47 试过, 真机把隐藏/锁定
    //   文本帧一起塞进 selection, AI 直接崩(见上方回退说明)。
    var hits = [];
    pfLocCollect(doc, n, hits, pfLocSubOk(sub));

    var sel = [], lockN = 0, hidN = 0;
    var layerMap = {}, layerList = [];
    var lim = hits.length;
    for (var i = 0; i < lim; i++) {
      var it = hits[i];
      if (pfLocOk(it)) { sel.push(it); continue; }
      if (pfLocWhy(it) === "隐藏") hidN++; else lockN++;
      var ln = pfLocLayerName(it);
      if (ln !== "" && !layerMap[ln]) {
        layerMap[ln] = 1;
        if (layerList.length < PF_LOC_LAYER_CAP) layerList.push(ln);   // 别撑成两行
      }
    }

    res.total = lim;
    res.sel = sel.length;
    res.locked = lockN;
    res.hidden = hidN;
    res.layers = layerList;

    if (sel.length > 0) {
      try { doc.selection = null; } catch (e1) {}
      try {
        doc.selection = sel;
      } catch (e2) {
        // 整批赋值失败(个别对象仍不可选) ⇒ 退回逐个设置, 只统计真正选上的
        var ok2 = 0;
        for (var k = 0; k < sel.length; k++) {
          try { sel[k].selected = true; ok2++; } catch (e3) {}
        }
        res.sel = ok2;
      }
      // CEP 面板拿到焦点时宿主不一定会重绘选中高亮, 强制刷一次
      try { app.redraw(); } catch (e4) {}
    }
    res.ok = true;
  } catch (err) {
    res.ok = false;
    res.error = "定位失败: " + String(err);
  }
  return pfReturn(res);
}

// ============================================================
// v11.90: 卡⑩「对照」—— 处理前栅格对照层(实现)
//   流程(雪糕 2026-11-19 定): 复制当前画板上的可见对象 → 栅格化 300ppi
//     → 新建图层 → 置最顶层 → 透明底 → 位置不变 → 原稿不动 → 透明度可调。
//   全部函数只被「建立/重建」与「开始检查」两处调用, 不参与其它卡的任何判定。
// ============================================================

// 找对照层 —— 递归(深度 8), 用户手动把它拖进子图层也找得到。
//   只认 name: 图层名是用户在 AI 里肉眼唯一能看到的东西, 也是 zhidongzhiban 的判定口径,
//   两边必须一致, 否则会出现"它建了、我们不认"从而各建一张满版栅格。
// ============================================================
// v11.105: 对照差分 —— 把「当前版面」和「对照层那张图」各导出一份 PNG,
//   像素比对放在**面板侧**(Chromium 的 canvas)做, 不在这里做。
//   为什么不在这里做: ExtendScript 没有像素 API(RasterItem 读不到像素),
//   而 PNG 是 zlib 压缩的, ES3 里解压既慢又得手写 inflate。
//   面板那边 <img> + <canvas> 原生解码, 逐像素比对是毫秒级 —— 分工反而最省事。
//   本函数只负责: 摆好文档状态 → exportFile 两张图 → 原样还原 → 把路径交出去。
// ============================================================
function pfDiffExportOne(doc, path, scalePct) {
  var f = new File(path);
  try { if (f.exists) f.remove(); } catch (e0) {}
  var opt = new ExportOptionsPNG24();
  // v11.106: 抗锯齿必须跟对照图**当初栅格化时**的设置一致。
  //   对照图是 AntiAliasingMethod.ARTOPTIMIZED 出来的(软边), 这里若关掉抗锯齿(硬边),
  //   两条边的灰度过渡完全不同 ⇒ 每一个轮廓都会亮成"变化"。这是"没改也圈"的头号原因。
  opt.antiAliasing = true;
  opt.transparency = false;      // 都压白底 —— 一边透明一边白底会整版"变色"
  opt.artBoardClipping = true;   // 都按画板裁: 取景天然一致, 不依赖内容包围盒
  opt.horizontalScale = scalePct;
  opt.verticalScale = scalePct;
  doc.exportFile(f, ExportType.PNG24, opt);
}

// v11.106: 导出分辨率自动对齐**对照图的原生 ppi**, 不再拍一个 250%。
//   为什么: 对照图是 300ppi 的位图。若按 250%(180ppi) 导出, 它会被**下采样**一次,
//   而当前版面是直接按 180ppi 渲染的 —— 两条采样路径 ⇒ 边缘天然差一两个像素 ⇒ 满屏假框。
//   按 300ppi(416.67%) 导出时, 对照图是 1:1 采样(几乎不重采样), 两边才对得上。
//   代价是图变大(A4 = 2480×3508 ≈ 870 万像素), 所以给一个像素上限, 超了按比例降。
var PF_DIFF_PPI = PF_SNAP_RESO;      // 跟随对照图(300)
// v11.111(性能): 单张像素上限 1200 万 -> 320 万。
//   比对要**导出两张**大图, 而导出的耗时基本跟像素数成正比 —— A4 在 300ppi 是 870 万像素,
//   两张就是两次接近十几兆的渲染+PNG 编码, 用户感觉"点一下等很久"。
//   降到 320 万(A4 ≈ 176ppi, 1mm ≈ 6.9 像素)后:
//     · 导出快约 3 倍;  面板侧逐像素也比原来少算 2/3;
//     · 判定精度仍是 0.15mm 上下 —— 对"字挪了没、删没删"完全够用。
//   ⚠ 想更准可把这里调回去, 代价就是慢。
var PF_DIFF_MAX_PX = 3200000;
function pfDiffAutoScale(ab) {
  var sc = PF_DIFF_PPI / 72 * 100;   // 416.67
  var wpt = ab[2] - ab[0], hpt = ab[1] - ab[3];
  if (!(wpt > 0) || !(hpt > 0)) return sc;
  var px = (wpt * sc / 100) * (hpt * sc / 100);
  if (px > PF_DIFF_MAX_PX) sc = sc * Math.sqrt(PF_DIFF_MAX_PX / px);
  if (sc < 60) sc = 60;
  if (sc > 600) sc = 600;
  return sc;
}

function pfDiffExport(scalePct) {
  var res = { ok: false };
  var doc = null, snapLy = null, ras = null;
  var vis = [], op0 = -1, restored = false;
  // ⚠ 对照层是**锁定**的, 而锁定图层里的对象改任何属性都会抛 —— 包括 opacity。
  //   所以导出前必须临时解锁, 导完(或出错时)把锁定状态一起还原。
  var lock0 = false;

  // 还原文档状态 —— 正常路径与异常路径都调它, 绝不给用户留下一份被改过可见性的稿子
  function restore() {
    if (restored) return;
    restored = true;
    for (var i = 0; i < vis.length; i++) {
      try { vis[i].ly.visible = vis[i].v; } catch (e0) {}
    }
    if (ras && op0 >= 0) { try { ras.opacity = op0; } catch (e1) {} }
    if (snapLy) { try { snapLy.locked = lock0; } catch (e2) {} }
  }

  try {
    if (app.documents.length === 0) { res.error = "当前没有打开的文档，请先打开一个 AI 文件。"; return pfReturn(res); }
    doc = app.activeDocument;
    snapLy = pfSnapFind(doc);
    if (!snapLy) { res.error = "还没有「处理前对照」图层 —— 请先在卡⑩ 点「建立处理前对照」。"; return pfReturn(res); }

    try {
      var its = snapLy.pageItems, n = its.length;
      for (var i = 0; i < n; i++) {
        var it = its[i], tn = "";
        try { tn = it.typename; } catch (e2) {}
        if (tn === "RasterItem") { ras = it; break; }
      }
    } catch (e3) {}
    if (!ras) { res.error = "对照图层里没有栅格图（可能被手动删掉了）—— 请点「重建处理前对照」。"; return pfReturn(res); }

    var abIdx = 0;
    try { abIdx = doc.artboards.getActiveArtboardIndex(); } catch (e4) { abIdx = 0; }
    var ab = null;
    try { ab = doc.artboards[abIdx].artboardRect; } catch (e5) { ab = null; }
    if (!ab || !(ab[2] > ab[0]) || !(ab[1] > ab[3])) { res.error = "当前画板范围异常（宽或高为 0），无法比对。"; return pfReturn(res); }

    // v11.106: 传 0(或非正) ⇒ 自动对齐对照图 ppi; 传正数则按调用方的值(留个手动口子)
    var sc = Number(scalePct);
    if (!(sc > 0)) sc = pfDiffAutoScale(ab);
    if (sc < 60) sc = 60;
    if (sc > 600) sc = 600;

    // 记下所有顶层图层的可见性 + 对照图透明度(默认 50%, 半透明图没法跟实色版面比)
    var lys = doc.layers, ln = lys.length;
    for (var li = 0; li < ln; li++) {
      var ly = lys[li], v = true;
      try { v = (ly.visible !== false); } catch (e6) { v = true; }
      vis.push({ ly: ly, v: v });
    }
    try { lock0 = (snapLy.locked === true); } catch (e7a) { lock0 = false; }
    if (lock0) { try { snapLy.locked = false; } catch (e7b) {} }
    try { op0 = Number(ras.opacity); } catch (e7) { op0 = 100; }
    try { ras.opacity = 100; } catch (e8) {}

    var tmp = Folder.temp;
    var pA = tmp.fsName + "/pf_diff_cur.png";
    var pB = tmp.fsName + "/pf_diff_ref.png";

    // A: 当前版面 —— 藏掉对照层, **还要藏掉上一次画的红框层**。
    //   ⚠ 这个坑很隐蔽: 差异层在上一次是可见的, 只藏对照层的话, A 图里会带着一堆红框、
    //     B 图里没有 ⇒ 每跑一次, 上一次的红框就被当成"变化"再圈一遍, 越滚越多。
    try { snapLy.visible = false; } catch (e9) {}
    try {
      var dly = pfDiffFindLayer(doc);
      if (dly) dly.visible = false;
    } catch (e9b) {}
    pfDiffExportOne(doc, pA, sc);

    // B: 对照图本身 —— 其它顶层图层全藏, 只留对照层
    for (var j = 0; j < vis.length; j++) { try { vis[j].ly.visible = false; } catch (e10) {} }
    try { snapLy.visible = true; } catch (e11) {}
    pfDiffExportOne(doc, pB, sc);

    restore();

    res.ok = true;
    res.a = pA;
    res.b = pB;
    res.rect = ab;          // [l, t, r, b] —— 面板用它把像素坐标换算回文档坐标
    res.scale = sc;
    res.artboard = abIdx + 1;
  } catch (err) {
    restore();
    res.ok = false;
    res.error = "导出对照图失败: " + String(err);
  }
  return pfReturn(res);
}

// 第 2 步: 面板算完差异, 把红框交回来画。
//   listStr 形如 "left,top,width,height;left,top,width,height"(文档坐标 pt)。
//   每次重画都会**先删掉旧的差异层** —— 可反复点, 不留残影。
function pfDiffFindLayer(doc) {
  var lys = null, n = 0;
  try { lys = doc.layers; n = lys.length; } catch (e0) { return null; }
  for (var i = 0; i < n; i++) {
    var nm = "";
    try { nm = lys[i].name; } catch (e1) {}
    if (nm === PF_DIFF_LAYER) return lys[i];
  }
  return null;
}

function pfDiffDraw(listStr) {
  var res = { ok: false, count: 0 };
  try {
    if (app.documents.length === 0) { res.error = "当前没有打开的文档。"; return pfReturn(res); }
    var doc = app.activeDocument;

    var old = pfDiffFindLayer(doc);
    if (old) { try { old.locked = false; } catch (e2) {} try { old.remove(); } catch (e3) {} }

    var parts = String(listStr === undefined || listStr === null ? "" : listStr).split(";");
    var made = 0, ly = null;

    for (var p = 0; p < parts.length; p++) {
      var q = String(parts[p]).split(",");
      if (q.length < 4) continue;
      var L = Number(q[0]), T = Number(q[1]), W = Number(q[2]), H = Number(q[3]);
      if (!(W > 0) || !(H > 0)) continue;
      if (!ly) {
        ly = doc.layers.add();
        ly.name = PF_DIFF_LAYER;
        try { ly.zOrder(ZOrderMethod.BRINGTOFRONT); } catch (e4) {}
      }
      var r = ly.pathItems.rectangle(T, L, W, H);
      r.filled = false;
      r.stroked = true;
      r.strokeWidth = 1.5;
      try {
        var c = new CMYKColor();
        c.cyan = 0; c.magenta = 100; c.yellow = 100; c.black = 0;
        r.strokeColor = c;
      } catch (e5) {}
      made++;
    }
    if (ly) { try { ly.printable = false; } catch (e6) {} }

    res.ok = true;
    res.count = made;
    res.message = made > 0
      ? "已圈出 " + made + " 处变化（图层「" + PF_DIFF_LAYER + "」）。"
    : "没有发现变化。";
  } catch (err) {
    res.ok = false;
    res.error = "画红框失败: " + String(err);
  }
  return pfReturn(res);
}

function pfSnapFind(doc) {
  function find(lyrs, d) {
    if (d > 8) return null;
    var n = 0;
    try { n = lyrs.length; } catch (e0) { return null; }
    for (var i = 0; i < n; i++) {
      var ly = lyrs[i];
      if (pfIsAuxLayer(ly)) return ly;
      var hit = null;
      try { hit = find(ly.layers, d + 1); } catch (e1) { hit = null; }
      if (hit) return hit;
    }
    return null;
  }
  try { return find(doc.layers, 0); } catch (e2) { return null; }
}

// 只读扫描: 卡片据此显示「未建 / 已建 + 透明度 + 尺寸」。
//   刻意只读**第一张**栅格图元的 opacity —— 正常情况下层里就一张; 多于一张说明用户手动
//   动过, 卡片只报第一张的数, 不猜。
function pfSnapScan(doc) {
  var out = { exists: 0, opacity: 0, rasters: 0, wmm: 0, hmm: 0 };
  var ly = pfSnapFind(doc);
  if (!ly) return out;
  out.exists = 1;
  try {
    var its = ly.pageItems, n = its.length;
    for (var i = 0; i < n; i++) {
      var it = its[i], tn = "";
      try { tn = it.typename; } catch (e1) { continue; }
      if (tn !== "RasterItem") continue;
      out.rasters++;
      if (out.rasters === 1) {
        try { out.opacity = Math.round(Number(it.opacity)); } catch (e2) {}
        try {
          var b = it.geometricBounds;
          out.wmm = pfRound((b[2] - b[0]) / MMPT);
          out.hmm = pfRound((b[1] - b[3]) / MMPT);
        } catch (e3) {}
      }
    }
  } catch (e4) { out.rasters = -1; }   // -1 = 层在但读不到内容
  return out;
}

// 可见性: 自身 hidden + 沿 parent 链上每一层 Layer.visible。
//   ⚠ 与主扫描 walkLayer 的口径不同: walkLayer 是"隐藏子树整支剪枝", 这里是"沿链向上判",
//     因为我们是从 doc.pageItems 反查, 没有树可剪。两边结论在正常文档上一致。
function pfSnapVisible(item) {
  var cur = item;
  while (cur && cur.typename !== "Document") {
    try {
      if (cur.typename === "Layer") {
        if (!cur.visible) return false;
      } else if (cur.hidden) {
        return false;
      }
    } catch (e) {}
    cur = cur.parent;
  }
  return true;
}

// 收集当前画板范围内的可见生产对象。
//   · 只收"父级直接是 Layer"的对象 —— 组内子项由所在的组整体复制, 避免重复复制两遍;
//   · 与画板范围不相交的对象整支跳过(只栅格当前画板);
//   · 相交即收(不做裁剪): 骑在画板边上的对象整体进临时源, 栅格化时由 clipBounds 裁,
//     这样出血区的内容照样留在对照图里。
function pfSnapCollect(doc, area) {
  var out = [];
  // v11.111(性能): 集合**只取一次**。
  //   原写法 `doc.pageItems[i]` 在循环体里 —— 每次下标访问都会重新求值一次
  //   `doc.pageItems`(跨桥构造集合), 大文档上就是 O(n²)。这与 v11.33 记的
  //   "doc.pathItems 按下标取值随下标线性变慢(3374 条 476ms)"是同一个坑。
  var all = null, n = 0;
  try { all = doc.pageItems; n = all.length; } catch (e0) { all = null; n = 0; }
  for (var i = 0; i < n; i++) {
    var it = all[i];
    try {
      if (!it.parent || it.parent.typename !== "Layer") continue;
      if (pfIsAuxLayer(it.layer)) continue;        // 对照层自己永不入镜
      if (!pfSnapVisible(it)) continue;
      if (it.typename === "PathItem" && it.guides) continue;
      var b = it.visibleBounds;
      if (!b || b.length < 4) continue;
      if (!isFinite(b[0]) || !isFinite(b[1]) || !isFinite(b[2]) || !isFinite(b[3])) continue;
      // area / b 都是 [left, top, right, bottom], AI 里 top > bottom
      if (b[2] < area[0] || b[0] > area[2]) continue;   // 完全在左 / 右
      if (b[1] < area[3] || b[3] > area[1]) continue;   // 完全在下 / 上
      out.push(it);
    } catch (e1) {}
  }
  return out;
}

// 复制单个对象进临时组 —— 复制前后**成对**恢复对象与其父链图层的锁定状态。
//   AI 里锁定对象/锁定图层上的对象 duplicate() 会抛; 不临时解锁就复制不出完整的一份,
//   而"复制完忘了锁回去"会把用户的生产稿解锁, 属于不可接受的副作用。
function pfSnapDup(item, targetGroup) {
  var itemLocked = false, layerStates = [], cur = null;
  try {
    cur = item.parent;
    while (cur && cur.typename === "Layer") {
      layerStates.push({ ly: cur, locked: cur.locked });
      if (cur.locked) cur.locked = false;
      cur = cur.parent;
    }
    try { itemLocked = item.locked; } catch (eL) { itemLocked = false; }
    if (itemLocked) item.locked = false;
    var dup = item.duplicate(targetGroup, ElementPlacement.PLACEATBEGINNING);
    if (!dup) throw new Error("对象复制失败");
    return dup;
  } finally {
    try { item.locked = itemLocked; } catch (e1) {}
    for (var i = layerStates.length - 1; i >= 0; i--) {
      try { layerStates[i].ly.locked = layerStates[i].locked; } catch (e2) {}
    }
  }
}

// 栅格结果是否仍覆盖画板范围(容差 pt) —— 防"宿主换了坐标基准"却静默产出错位对照。
function pfSnapBoundsMatch(img, area, tol) {
  try {
    var b = img.geometricBounds;
    return Math.abs(b[0] - area[0]) <= tol &&
      Math.abs(b[1] - area[1]) <= tol &&
      Math.abs(b[2] - area[2]) <= tol &&
      Math.abs(b[3] - area[3]) <= tol;
  } catch (e) {
    return false;
  }
}

// 建立/重建对照层。
//   opacityPct: 5~95, 越界夹紧, NaN 回落默认 50。
//   已存在的旧层**先删再建**(重建语义): 旧层若删不掉就直接报错返回, 绝不"建第二张叠上去"。
function pfSnapBuild(opacityPct) {
  var res = { ok: false };
  var doc = null, ly = null, temp = null, originalLayer = null, rebuilt = 0;
  try {
    if (app.documents.length === 0) {
      res.error = "当前没有打开的文档，请先打开一个 AI 文件。";
      return pfReturn(res);
    }
    doc = app.activeDocument;

    // 透明度: 先判 NaN(Number("abc") 是 NaN, 而 NaN 的任何比较都是 false, 夹紧不会生效)
    var op = Number(opacityPct);
    if (isNaN(op)) op = PF_SNAP_OP_DEF;
    if (op < PF_SNAP_OP_MIN) op = PF_SNAP_OP_MIN;
    if (op > PF_SNAP_OP_MAX) op = PF_SNAP_OP_MAX;
    op = Math.round(op);

    // 当前画板 + 四周外扩
    var abIdx = 0;
    try { abIdx = doc.artboards.getActiveArtboardIndex(); } catch (eAB) { abIdx = 0; }
    var ab = doc.artboards[abIdx].artboardRect;   // [l, t, r, b]
    var pad = PF_SNAP_PAD_MM * MMPT;
    var area = [ab[0] - pad, ab[1] + pad, ab[2] + pad, ab[3] - pad];
    if (!(area[2] > area[0]) || !(area[1] > area[3])) {
      throw new Error("当前画板范围异常（宽或高为 0），未建立对照层。");
    }

    var src = pfSnapCollect(doc, area);
    if (src.length === 0) {
      throw new Error("当前画板没有可见内容，未建立对照层。");
    }

    // 旧层: 先删。删不掉就停(见函数头说明)。
    var old = pfSnapFind(doc);
    if (old) {
      try { if (old.locked) old.locked = false; } catch (eOL) {}
      try { old.remove(); rebuilt = 1; } catch (eOR) {
        throw new Error("旧对照层删除失败（可能被其他对象锁定或正在使用），请在图层面板里手动删除后重试。");
      }
    }

    originalLayer = doc.activeLayer;
    ly = doc.layers.add();
    ly.name = PF_SNAP_NAME;
    ly.locked = false;
    ly.visible = true;
    ly.zOrder(ZOrderMethod.BRINGTOFRONT);

    temp = ly.groupItems.add();
    temp.name = "处理前栅格临时源";

    // 从后往前复制并 PLACEATBEGINNING: doc.pageItems 下标小的通常更靠前, 这样复制完
    // 前后关系与画面一致 —— 不改视觉顺序是"原稿不动"的一部分。
    for (var i = src.length - 1; i >= 0; i--) pfSnapDup(src[i], temp);
    if (temp.pageItems.length === 0) {
      throw new Error("对照层临时源复制为空，已停止（原稿未改动）。");
    }

    var opt = new RasterizeOptions();
    // v11.111(性能): 栅格化分辨率加**像素上限**。
    //   300ppi 对 A4(210×297+5mm 外扩)≈ 870 万像素, AI 栅格化要一两秒;
    //   换成大幅面标签(比如 300×500mm)就是 3000 万像素 —— 那一步能拖十几秒甚至更久,
    //   用户感觉就是"点一下等很久"。这里按面积反算, 超过 PF_SNAP_MAX_PX 就等比降 ppi。
    //   ⚠ 对照图的用途是"肉眼套对错位", 200ppi 和 300ppi 在面板上看不出差别;
    //     真正影响判断的是那张图在不在、位置准不准, 不是 ppi 有多高。
    var reso = PF_SNAP_RESO;
    var wptS = area[2] - area[0], hptS = area[1] - area[3];
    if (wptS > 0 && hptS > 0) {
      var pxS = (wptS / 72 * reso) * (hptS / 72 * reso);
      if (pxS > PF_SNAP_MAX_PX) reso = reso * Math.sqrt(PF_SNAP_MAX_PX / pxS);
    }
    opt.resolution = Math.round(reso);
    opt.antiAliasingMethod = AntiAliasingMethod.ARTOPTIMIZED;
    // v11.90(雪糕定 A): 透明底。顶层半透明若用白底, 等于给整版蒙一层 50% 白雾,
    //   纸白与图形一起被冲淡 ⇒ 看到"颜色变浅"分不清是稿子改了还是白雾造成的。
    opt.transparency = true;
    opt.backgroundBlack = false;
    opt.convertSpotColors = false;   // 对照图只用于套对, 不改生产专色定义
    opt.convertTextToOutlines = false;
    opt.includeLayers = true;
    opt.clippingMask = false;
    opt.padding = 0;

    var img = doc.rasterize(temp, area, opt);
    temp = null;   // rasterize 成功后临时源已被消费, 不要再 remove
    if (!img || img.typename !== "RasterItem") {
      throw new Error("Illustrator 栅格化未返回有效 RasterItem。");
    }
    img.move(ly, ElementPlacement.PLACEATEND);
    img.name = PF_SNAP_RT_NAME;
    img.note = PF_SNAP_TAG;
    img.opacity = op;

    // 位置核验: clipBounds 本身就是画板坐标基准, 不该被二次缩放/位移。
    if (!pfSnapBoundsMatch(img, area, 0.5)) {
      throw new Error("栅格结果与当前画板范围不一致，未通过位置核验（原稿未改动）。");
    }

    // 置顶 + 锁定 + 不打印。顺序在最后: 锁定后再 move/add 会抛。
    ly.zOrder(ZOrderMethod.BRINGTOFRONT);
    ly.printable = false;
    ly.locked = true;

    res.ok = true;
    res.opacity = op;
    res.count = src.length;
    res.rebuilt = rebuilt;
    res.wmm = pfRound((area[2] - area[0]) / MMPT);
    res.hmm = pfRound((area[1] - area[3]) / MMPT);
    res.artboard = abIdx + 1;
  } catch (err) {
    // 失败就把半成品清掉 —— 留一层空图层比失败更糟(下次会判"已存在")。
    if (temp) { try { temp.remove(); } catch (e1) {} }
    if (ly) { try { ly.locked = false; ly.remove(); } catch (e2) {} }
    res.ok = false;
    res.error = String(err && err.message ? err.message : err);
  } finally {
    if (doc && originalLayer) {
      try { doc.activeLayer = originalLayer; } catch (e3) {}
    }
  }
  return pfReturn(res);
}
