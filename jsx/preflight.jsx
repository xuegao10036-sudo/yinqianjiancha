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
// v10.60(审查 2.2/2.4/2.6): 颜色收集深度上限 20->64 与主扫描统一; pfThCopy 补 htCap;
//   __pfUsedCache 两处失效点(进 pfClearUnusedSwatches 即清 + pfClearUnusedGradPattern 读完即清)
// v11.0: 版本号跃升至 11.0(从 10.60 起进入 11.x 线; 代码内容与 v10.60 一致, 仅版本标识变更)
// v11.2: 全站胶囊按钮统一 40px 高(纯面板 CSS 改动, ExtendScript 逻辑零变化), 仅同步版本号
var PF_BUILD = "11.33";

// v10.46(审查 P2-1): 颜色收集的**轮内**复用缓存。
//   onClearSwatches 用 execActionMulti 串联 pfClearUnusedSwatches + pfClearUnusedGradPattern,
//   两个函数原先各自 pfUsedColorKeys(doc) 全文档遍历一遍(textFrames + 所有图层 items,
//   大文档各要数秒) ⇒ 用户点一次按钮付两遍。
//   现在第一个动作通过安全闸后把结果存这里, 第二个动作直接复用。
//   v10.60(审查 2.6): 补两处失效点, 把"跨轮串味"堵死 ——
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
  reso: 300,     // 图片有效分辨率低于此值(ppi)判偏低    <- 原 RESO_MIN
  cap: 5,        // 油墨/描边采样条数上限(按不同值计)    <- 原 SAMPLE_CAP
  scan: 3000,    // 每类对象最多扫描数量(防大卡死)       <- 原 MAX_SCAN
  // v10.39(审查 B6): 隐藏文字统计的帧数上限提成真源 —— 前端那句"仅统计前 N 个"改读
  //   hiddenText.cap(本值), 不再两侧各写一个 500。
  htCap: 500     // 隐藏文字统计帧数上限(诊断性质, 大文档不再往下数, 挂 truncated)
};

var PT2MM = 0.3527777778;     // 1 pt = 0.3528 mm
// 工作副本 —— 每次 runPreflight 开头由 pfThApply 按传入值覆盖, 判定一律读这几个
var MAX_SCAN = PF_TH_DEF.scan;
var BLEED_MIN_MM = PF_TH_DEF.bleed;
var TINY_PT = PF_TH_DEF.tiny;
var THIN_STROKE_MM = PF_TH_DEF.thin;
var LIGHT_CH = PF_TH_DEF.light;
var SAMPLE_CAP = PF_TH_DEF.cap;
var INK_OK = PF_TH_DEF.inkOk;
var INK_WARN = PF_TH_DEF.inkWarn;
var RESO_MIN = PF_TH_DEF.reso;

// 阈值表浅拷贝(全是数字, 逐个列出而不是 for-in —— 免得把原型链上的东西带出去)
// v10.60(审查 2.4): 补齐 htCap —— 原实现漏带该项, 使 pfThDefaults 下发的默认表缺 htCap。
//   当前前端走 htx.cap 取该值(唯一真源), 侥幸未暴露; 但任何读 th.htCap 的调用方都会
//   拿到 undefined ⇒ 补上, 让"浅拷贝 == 全字段"这条语义成立(新加字段不再被漏掉)。
function pfThCopy(t) {
  return { bleed: t.bleed, tiny: t.tiny, thin: t.thin, light: t.light,
           inkOk: t.inkOk, inkWarn: t.inkWarn, reso: t.reso, cap: t.cap, scan: t.scan,
           htCap: t.htCap };
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
var PF_TH_KEYS = ["bleed", "reso", "thin", "tiny", "inkOk", "inkWarn", "light"];

function pfThApply(s) {
  var t = pfThCopy(PF_TH_DEF);
  // v10.33: 去掉 `var keys = PF_TH_KEYS;` 别名(审查 v10.32 第 10 条) —— 常量不会改, 直接用更直白。
  var parts = String(s === undefined || s === null ? "" : s).split("|");
  var i, v;
  // v11.5: 新线序带 "v2" 前缀(与 main.js thWire 同源) —— 加了字段后字段数不再能区分新旧
  //   (新 7 项 / v10.1 旧 7 项都是 7)。无前缀的旧面板(6 项)按旧口径读不进, 逐项回落默认。
  var off = (parts[0] === "v2") ? 1 : 0;
  var n = parts.length - off;
  // v10.9: 字段校验收进 if —— 工作副本赋值无条件执行, 字段数不符时 t 即全默认。
  // v11.5: 额外放行"无前缀 6 项"(旧面板线序) —— 万一 CEP 缓存里还是旧 main.js,
  //   阈值照旧生效(light 回落默认), 而不是整列静默回默认。多余项读到 undefined ⇒ NaN ⇒ 跳过。
  if (n === PF_TH_KEYS.length || (off === 0 && n === PF_TH_KEYS.length - 1)) {
    for (i = 0; i < PF_TH_KEYS.length; i++) {
      v = parseFloat(parts[i + off]);
      if (!isNaN(v) && isFinite(v) && v > 0) t[PF_TH_KEYS[i]] = v;
    }
    if (t.inkWarn <= t.inkOk) t.inkWarn = Math.max(t.inkOk + 1, PF_TH_DEF.inkWarn);
  }
  BLEED_MIN_MM = t.bleed; RESO_MIN = t.reso; THIN_STROKE_MM = t.thin;
  TINY_PT = t.tiny;
  INK_OK = t.inkOk; INK_WARN = t.inkWarn; LIGHT_CH = t.light;
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
  // v10.43(审查 P3-3): 把 pfInkSum 的完整结果挂在 _o 上 —— pfOvpAdd 紧接着算四分类时
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
// v10.43(审查 P3-3): 拆出带 info 的变体 —— pfOvpAdd 已为白计数算过 pfOvpInfo(内含
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
function pfCkOn(v) { return !(v === 0 || v === false || v === "0"); }

function runPreflight(c1, c2, c3, c4, c5, c6, c7, c8, c9, c10) {
  var res = { ok: false };
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
      tx: pfCkOn(c10 === undefined ? 0 : c10)
    };
    // v10.1: 先应用面板传来的阈值, 并立刻回传生效值 —— 前端只显示这个数,
    //   自己不留任何阈值数字。缺省(旧调用点 runPreflight())时 c8 为 undefined,
    //   pfThApply 会逐项回落 PF_TH_DEF ⇒ 与 v10.0 行为逐字一致。
    var TH = pfThApply(c8);
    res.th = TH;
    pfEnsureFonts(); // v8.5: 每次检查前同步(数量变化才重探/重建),中途激活/安装的字体不再漏识别
    if (app.documents.length === 0) {
      res.error = "当前没有打开的文档，请先打开一个 AI 文件。";
      return pfReturn(res);
    }
    var doc = app.activeDocument;
    res.ok = true;
    res.docName = doc.name;
    try { res.docPath = doc.path.fsName; } catch (e0) { res.docPath = "(文档尚未保存)"; }

    // ---------- 1. 画板尺寸 ----------
    var boards = [];
    var abRects = []; // 各画板 rect(v3.4: 供出血逐画板测量)
    var abBleed = []; // 各画板四向最大超出(pt) + 是否有内容
    var activeIdx = 0;
    try { activeIdx = doc.artboards.getActiveArtboardIndex(); } catch (e1) {}
    for (var i = 0; i < doc.artboards.length; i++) {
      var abObj = doc.artboards[i];
      var r = abObj.artboardRect; // [left, top, right, bottom] pt
      abRects.push(r);
      abBleed.push({ top: 0, bottom: 0, left: 0, right: 0, hasContent: false });
      var wMm = (r[2] - r[0]) * PT2MM;
      var hMm = (r[1] - r[3]) * PT2MM;
      boards.push({ name: abObj.name, w: pfRound(wMm), h: pfRound(hMm) });
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
    res.colorMode = (doc.documentColorSpace === DocumentColorSpace.CMYK) ? "CMYK" : "RGB";

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
      var usedOnce = null;
      try { usedOnce = pfUsedColorKeys(doc); } catch (eUO) { usedOnce = null; }
      swatchInfo = pfSwatchScan(doc, usedOnce);
      res.swatch = swatchInfo;
      res.gradient = pfGradientScan(doc, usedOnce);
      res.pattern = pfPatternScan(doc, usedOnce);
      // 颜色组统计(读不到 swatchGroups 时 supported=false, 前端自动隐藏该行)
      //   v11.1(审查 ⑦): 不再传 usedOnce —— 该入参在函数内从未使用。
      res.swatchGroup = pfSwatchGroupScan(doc);
    }

    // ---------- 2a2. 清理(游离点 / 未上色 / 空文本) ----------
    // v11.15: 卡⑨ 起于"删空文本框"; v11.16(雪糕) 扩成一张「清理」卡 ——
    //   对照 Illustrator 自带「对象 > 路径 > 清理」的三个勾选项。
    //   只统计不修改; 真正删除走 pfCleanup(doStray, doUnpaint, doText)(卡片「一键清理」)。
    //   ⚠ 扫描与删除共用 pfJunkEach 同一套判定, 避免"报 N 删 M"。
    if (CK.tx) {
      res.cleanup = pfCleanupScan(doc);
    }

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
        // v10.43(审查 P3-1): 硬编码 5 → SAMPLE_CAP(与其余样本列表同一真源, v10.39 B6 同款)
        if (hidden.layerNames.length < SAMPLE_CAP) hidden.layerNames.push(ly.name || "(未命名图层)");
      // v10.33: catch 里也要判 < 5(审查 v10.32 第 4 条) —— 原先无条件 push, 若多个图层的
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
      // v8.3: 叠印——文字(字符级) + 图形(pageItem 级) 共用一个池,count 为全量真值
      // v9.6: locked = 其中落在**锁定**对象/图层/锁定组里的处数(照常计入 count, 只多报一个数,
      //   供卡⑦ 提示"其中锁定 N 处, 勾选「解锁全部」可一并清除")。
      // v10.14: 四分类计数(k100 单黑 / spot 专色 / color 彩色)新增, white 沿用既有字段;
      //   旧前端(不认新键)零影响 —— 多出的键没人读就是了。
      // v10.35(审查 #4): 加 truncated —— 原先 path/compound 超配额只挂 black.path.truncated,
      //   而卡⑦叠印判定读的是 overprint.count。若前 3000 个 path 无叠印、第 3001 个有叠印后被
      //   配额截断 ⇒ count 停在 0、前端显示"无叠印"+绿徽标 —— **漏检却报通过**, 印刷上最危险。
      //   三处 underQuota 失败须同步把本字段置真(见下方 path/compound/text 分支)。
      overprint: { count: 0, white: 0, k100: 0, spot: 0, color: 0, text: 0, path: 0, locked: 0, samples: [], truncated: false }
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
      // v10.43(审查 P3-3): 改传 pfOvpClass2(colorObj, info) —— 复用 info 里已算过的
      //   pfInkSum 结果, 同一颜色不再读两遍(原 pfOvpClass 内部会再跑一次)。
      var cls = pfOvpClass2(colorObj, info);
      black.overprint.count++;
      if (info.white) black.overprint.white++;
      if (cls.cls === "k100") black.overprint.k100++;
      else if (cls.cls === "spot") black.overprint.spot++;
      else if (cls.cls === "color") black.overprint.color++;
      if (src === "text") black.overprint.text++; else black.overprint.path++;
      if (item) {
        var blkO = null;
        try { blkO = pfBlockInfo(item); } catch (eBlkO) {}
        // v10.35(审查 #6): 改用 locked 布尔 —— 原判 `reason === "locked"` 会漏掉
        //   "同一节点既隐藏又锁定"的对象(那时 reason 报的是 hidden)。
        if (blkO && blkO.locked) black.overprint.locked++;
      }
      pfSampleAdd(black.overprint.samples,
        { src: src, where: where, desc: info.desc, name: name, white: info.white, cls: cls.cls },
        src + "|" + where + "|" + info.desc + "|" + name, SAMPLE_CAP);
    }

    function scanPathInk(pi) {
      if (!CK.ik && !CK.ov) return; // v10.0: 卡⑥⑦都关 ⇒ 整个路径油墨扫描跳过(一个属性都不读)
      var bp = black.path;
      var nm = pfObjName(pi);
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
        if (rfc) inkBucket(bp, rfc, nm, "填充");
        if (rsc) inkBucket(bp, rsc, nm, "描边");
      }
      // v8.3: 叠印检查(图形侧,pageItem 级)——真机 28.0.0 上 PathItem 的这两个属性名尚未验证,
      //   读不到 / 抛异常由 pfOvp* 兜成 false(宁可不报,绝不误报);色值只在命中时才读,摊薄成本。
      // v8.6: 复用上面已读出的 fc / sc, 不再回读 pi.fillColor / pi.strokeColor
      if (CK.ov) { // v10.0: 卡⑦关 ⇒ 不读叠印布尔
        try {
          if (pfOvpFill(pi)) {
            if (!fc) { try { fc = pi.fillColor; } catch (e1b) {} } // v10.11: ⑥关时命中才补读
            pfOvpAdd("path", "填充", fc, nm, pi);
          }
        } catch (e8) {}
        try {
          if (pfOvpStroke(pi)) {
            if (!sc) { try { sc = pi.strokeColor; } catch (e2b) {} } // v10.11: 原 scO 补读改为统一兜底
            pfOvpAdd("path", "描边", sc, nm, pi);
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
    }

    // ---------- 图片嵌入 + 分辨率 数据结构 ----------
    // v5.7: 计数改为树遍历统计(只含可见图),与下面的清单、分辨率口径一致。
    // 旧版取文档级 pls.length / ris.length(含隐藏图),会出现"链接图片 3 张"
    // 但清单只列 1 张的数字对不上的情况。
    // v5.9: 文档级 placedItems 变量自 v5.7 起已无任何引用(死代码),删除,
    // 省掉每次检查一次跨桥调用;文档级集合只保留 rasterItems,
    // 仅用于 XMP 文件名解析(ris)的必要判断。
    // v11.21(外审 #13): 卡⑤关着时不必读这一笔 —— ris 只服务 XMP 名称解析(已门控 CK.rs)
    var ris = CK.rs ? doc.rasterItems : [];
    // v8.1: linkedAll/linkedHidden 移出本对象 —— 改由 pfLinkScope() 在点"嵌入"时按需统计,
    //   不再每轮检查都扫一遍文档级 placedItems(见文件末尾 pfLinkScope)
    var imgs = { linked: [], linkedCount: 0, embeddedCount: 0, missingCount: 0, truncated: false };

    // v4.8: Symbol 内部扫描统计(符号内可能含未转曲文字/低清图/油墨超标/RGB,
    // 旧版直接跳过导致漏检;下钻定义源后其内部对象进入统一树遍历)
    var symbols = { count: 0, scanned: 0, truncated: false };

    // 有效 PPI = 72 / 矩阵基向量模长(与旋转/斜切角度无关)
    // v10.1: RESO_MIN 上提到模块级(阈值唯一真源), 这里不再重复声明
    var reso = { total: 0, lowCount: 0, okCount: 0, samples: [], truncated: false };

    function ppiOf(item) {
      try {
        var m = item.matrix;
        // 缩放因子取矩阵基向量模长: x轴→(A,B), y轴→(C,D)。
        // 旧实现只看 A/D 轴向分量,旋转45°时真实 212ppi 会被高估成约 300ppi 判为达标(漏检);
        // 模长与旋转/斜切角度无关,任意角度下结果稳定(v3.3 修正)
        var sx = Math.sqrt(m.mValueA * m.mValueA + m.mValueB * m.mValueB);
        var sy = Math.sqrt(m.mValueC * m.mValueC + m.mValueD * m.mValueD);
        if (sx < 0.0001 || sy < 0.0001) return -1;
        // v8.1: 返回**原值**(不再 Math.round)。旧版在这里提前取整,299.6ppi 被当成 300
        //   ⇒ 恰好卡在阈值上时判为"达标"而漏报;改由前端显示时再取整(与油墨总量同一口径)。
        return Math.min(72 / sx, 72 / sy); // 取较小值,保守
      } catch (e) { return -1; }
    }

    function resoCheck(item, label) {
      if (!CK.rs) return; // v10.0: 卡⑤关 ⇒ 不读图片矩阵、不做 ppi 判定
      var ppi = ppiOf(item);
      if (ppi < 0) return;
      reso.total++;
      if (ppi < RESO_MIN) {
        reso.lowCount++;
        // v5.19: 15→8; v6.5: →5(列表统一"仅列前 5")
        // v7.9: 只留**分辨率最低的 5 张**,并按 ppi 从低到高排好(原来取的是文档里最先遇到的 5 张)
        //   这里用递增序号做 key ⇒ 不去重(每张图各占一条;同图重复置入也各自可见)
        // v10.39(审查 B6): 硬编码 5 → SAMPLE_CAP(= PF_TH_DEF.cap)。数字本来就相等, 但这里
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
    // v10.43(审查 P3-4): 再加 CK.rs 门控 —— xmpEmbNames 只服务卡⑤的 resoCheck 标签
    //   (卡⑤关时 resoCheck 首行即 return, embName 的结果被立即丢弃), CK.im 不消费它。
    //   两卡都关时白读一次 doc.XMPString 跨桥, 纯浪费。
    var xmpEmbNames = (CK.rs && ris.length > 0) ? xmpEmbeddedNames() : [];
    var xmpSeq = 0;      // 顺序兜底指针
    var rasterIdx = 0;   // 已处理的嵌入位图计数
    var placedIdx = 0;   // 已处理的链接图计数
    // v10.46(审查 P2-5): 可见嵌入位图 -> XMP 白名单条目的锚表。
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
          try { fVis = !pfBlockInfo(fIt); } catch (eFi) { fVis = true; }
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
    // 单个对象: 按 typename 分派(可见性已由 walkLayer 的图层过滤保证,
    // 无需再传 vis 标志 —— v4.8 清理死参数)
    // v10.0: 第三参 skipBleed —— 组级剪枝命中后向整棵子树传递"跳过出血测量"
    //   (只跳出血, 其余检查照常), 缺省 undefined = 不跳过。
    function visitItem(it, depth, skipBleed) {
      if (depth > 64) return; // 防异常深嵌套导致栈溢出(超过深度放弃下钻)
      var tn = "";
      // v10.46(审查 P2-4): typename 都读不到时**不敢断言无隐藏** —— 与其余读取失败点
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
        return;
      }

      if (tn === "TextFrame") {
        if (!skipBleed) bleedOf(it, false); // v5.25 出血先于配额;v10.0 剪枝子树跳过出血
        // v4.8: 配额检查前置,totalText 只统计实际扫描数(原在配额前++,超限仍虚增)
        if (!underQuota("text")) { fonts.truncated = true; black.overprint.truncated = true; return; } // v10.35: 叠印同步挂截断(审查 #4)
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
        if (!underQuota("path")) { black.path.truncated = true; black.overprint.truncated = true; return; } // v10.35: 叠印同步挂截断(审查 #4)
        scanPathInk(it);
        return;
      }
      if (tn === "CompoundPathItem") {
        if (!skipBleed) bleedOf(it, true);  // v5.25 出血先于配额;v10.0 剪枝子树跳过出血
        if (!underQuota("compound")) { black.path.truncated = true; black.overprint.truncated = true; return; } // v10.35: 同上
        try { scanPathInk(it.pathItems[0]); } catch (eC) {}
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
        if (!underQuota("symbol")) { symbols.truncated = true; return; }
        // v4.8: 下钻 Symbol 定义源,扫描内部对象(缺失字体/分辨率/油墨等)
        // 多个实例引用同一符号时会重复扫描(与"实际输出内容"口径一致);
        // 定义源不可访问时静默跳过,仅统计数量
        try {
          var symDef = null;
          try { symDef = it.symbol; } catch (eSD) {}
          var symSrc = null;
          if (symDef) {
            try { symSrc = symDef.item; } catch (eSI) {}
            if (!symSrc) { try { symSrc = symDef; } catch (eS2) {} }
          }
          if (symSrc && symSrc.pageItems) {
            var symKids = symSrc.pageItems;
            var skLim = symKids.length; // v10.0: 长度外提
            for (var sk = 0; sk < skLim; sk++) visitItem(symKids[sk], depth + 1);
            symbols.scanned++;
          }
        } catch (eSym) {}
        return;
      }
      if (tn === "RasterItem") {
        if (!skipBleed) bleedOf(it, false); // v5.25 出血先于配额;v10.0 剪枝子树跳过出血
        if (!underQuota("raster")) { reso.truncated = true; imgs.truncated = true; return; }
        imgs.embeddedCount++; // v5.7: 只统计可见的嵌入位图
        resoCheck(it, embName(it, rasterIdx, "(嵌入位图" + (rasterIdx + 1) + ")"));
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
      if (depth > 64) return;
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
      if (depth > 64) return;
      var hh = false;
      try { hh = (ly.visible === false); } catch (eLv2) { return; }
      // v10.33: 补 CK.hd 门控(审查 v10.32 第 8 条) —— 当前唯一调用点本就在 CK.hd 分支内,
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
        // v10.39(审查 B6): 封顶值改读 PF_TH_DEF.htCap —— 与前端"仅统计前 N 个"同一真源
        var capHT = dtfsAll.length > PF_TH_DEF.htCap ? PF_TH_DEF.htCap : dtfsAll.length;
        for (var ht = 0; ht < capHT; ht++) {
          var tfH = dtfsAll[ht];
          var visH = true;
          try {
            var blkH = pfBlockInfo(tfH);
            if (blkH && blkH.reason === "hidden") visH = false;
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

    return pfReturn(res);
  } catch (err) {
    res.ok = false;
    res.error = "检查过程出错: " + String(err);
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
//   拼出的键就不同 ⇒ 在用色板被判成"未使用"。改为**统一量化到整数**,
//   且匹配时改用"容差比较"(见 pfColorKeyParts / pfUsedColorMatch),
//   不再依赖字符串相等。
function pfColorKey(c) {
  if (!c) return null;
  var t = "";
  try { t = c.typename; } catch (e) { return null; }
  try {
    if (t === "SpotColor") return "SPOT:" + c.spot.name;
    if (t === "CMYKColor")
      return "CMYK:" + Math.round(c.cyan) + "," + Math.round(c.magenta) + "," + Math.round(c.yellow) + "," + Math.round(c.black);
    if (t === "RGBColor") return "RGB:" + Math.round(c.red) + "," + Math.round(c.green) + "," + Math.round(c.blue);
    if (t === "GrayColor") return "GRAY:" + Math.round(c.gray);
    if (t === "GradientColor") return "GRAD:" + c.gradient.name;
    if (t === "PatternColor") return "PATT:" + c.pattern.name;
    if (t === "NoColor") return null;
  } catch (e2) { return null; }
  return null;
}

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

function pfColorSame(a, b) {
  var pa = pfColorParts(a), pb = pfColorParts(b);
  if (!pa || !pb) return false;
  if (pa.t !== pb.t) return false;
  if (pa.v.length !== pb.v.length) return false;
  for (var i = 0; i < pa.v.length; i++) {
    if (Math.abs(pa.v[i] - pb.v[i]) > PF_COLOR_EPS) return false;
  }
  return true;
}

// v10.43(审查 P3-2): 左侧已分解版的 pfColorSame —— 供 pfSwatchUsed 的 usedColors 循环
//   复用同一份分解结果。原 pfColorSame(a, b) 每次都对两侧现分解, 而色板色是固定的 ⇒
//   N 次比对就白解析 N 遍。原函数保留(其余调用点不变)。
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
  // v10.43(审查 P3-2): 分解结果外提到循环外 —— sw.color 是固定的, 原实现每次循环
  //   都经 pfColorSame 重新分解一遍, usedColors 有几百个时就白解析几百遍。
  var paSc = null;
  try { paSc = pfColorParts(sc); } catch (e5) { paSc = null; }
  if (!paSc) return false;   // 解析不了: 不判在用(与原 pfColorSame 返 false 的口径一致)
  for (var i = 0; i < usedColors.length; i++) {
    if (pfColorSameParts(paSc, usedColors[i])) return true;
  }
  return false;
}

// 收集整个文档"实际被使用"的东西 —— 含隐藏/锁定(见上方口径说明)
//   返回 { names: {key:1}, colors: [颜色对象...] }
//   v0.2 重构: 颜色改为**列表**而非字符串键 —— 供 pfColorSame 做容差匹配。
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
  //     ⚠ 不能用量化键(pfColorKey 的 Math.round): 两个色值四舍五入后同键但实际
  //       相差近 1.0, 而判定容差只有 0.5 —— 去重会误删"能匹配上色板"的那一个,
  //       反而制造误删。用原始分量拼键, 只有真·同色才合并, 匹配语义零变化。
  //   顺带收益: colors 从"对象数"降到"不同色数", pfSwatchUsed 的容差循环随之变短
  //   (60 色板 × 4000 条 → 60 色板 × 几十条)。
  var colorKeys = {};
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
    try { if (g && g.name) names["GRAD:" + g.name] = 1; } catch (eGR) {}
  }
  function markPattRef(p) {
    try { if (p && p.name) names["PATT:" + p.name] = 1; } catch (ePR) {}
  }

  function mark(c) {
    if (!c) return;
    var t = "";
    try { t = c.typename; } catch (e) { return; }
    if (t === "SpotColor") {
      try { if (c.spot && c.spot.name) names["SPOTNAME:" + c.spot.name] = 1; } catch (eSP) {}
      return;
    }
    if (t === "PatternColor") {
      // v0.5: 图案色被对象引用 ⇒ 该图案在用(记 PATT:name)
      try { markPattRef(c.pattern); } catch (ePT) {}
      return;
    }
    if (t === "GradientColor") {
      // v0.5: 渐变被对象引用 ⇒ 该渐变在用(记 GRAD:name)
      try { markGradRef(c.gradient); } catch (eGD0) {}
      // 渐变: 展开色标(色标里的专色/印刷色都要保住)
      try {
        var stops = c.gradient.gradientStops;
        for (var s = 0; s < stops.length; s++) { try { mark(stops[s].color); } catch (eGs) {} }
      } catch (eG) {}
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
        if (colorSeen >= 4000) { colorTruncated = true; return; }
        colorKeys[ck] = 1;
        colorSeen++;
        colors.push(c);
      } else {
        if (colorSeen < 4000) { colors.push(c); colorSeen++; } else { colorTruncated = true; }
      }
      return;
    }
    // NoColor / 其它: 不需要登记
  }

  // 逐对象收色: 覆盖 PathItem / CompoundPathItem / GroupItem / RasterItem / PlacedItem
  function collectItem(it, depth, countTop) {
    // v10.60(审查 2.2): 深度上限 20 -> 64, 与主扫描(visitItem / walkLayer / walkLayerHidden)
    //   同档。旧值 20 会让"第 21 层以上组内的颜色"登记不到 ⇒ 仍在用的色板可能被判
    //   "未使用"而误删(主扫描那边却统计得到 ⇒ 两侧对不上账)。统一 64 后同深同查。
    if (depth > 64) return;
    var tn = "";
    try { tn = it.typename; } catch (eT) { return; }
    // v0.5.2: 只统计"顶层"对象(画板/图层直接持有的), 子层下钻不重复计数
    if (countTop) objCount++;

    // 填充 / 描边(这些属性对 Path/CompoundPath/Group/Raster/Placed 大多可用)
    // v10.33: filled 口径与 scanPathInk 统一为 `!== false`(审查 v10.32 第 3 条) ——
    //   原先要求 `=== true`, 对 filled 读不到(=undefined)的对象**不登记**其填充色;
    //   而 scanPathInk 那边是"只排除明确 false"⇒ 会统计其油墨。两侧不一致时,
    //   理论上会出现"对象有油墨、但它用的色板被判未使用" ⇒ 色板被误删。
    //   统一成"只排除明确 false"(更保守: 宁可多留色板, 不可误删)。
    // v11.1(审查 ⑧): fillColor / strokeColor 各只读一次。
    //   原来 mark() 与下面的图案兜底**各读一遍**, 同一对象要跨桥取两次属性 ——
    //   在几百上千对象的文档里就是多出整整一倍的颜色属性读取, 而读到的必然是同一份。
    //   现改为先取到局部变量, 两处共用; 读失败时局部为 null ⇒ 两侧都安全跳过。
    var cFill = null, cStrk = null;
    try { cFill = it.fillColor; } catch (eF0) { cFill = null; }
    try { cStrk = it.strokeColor; } catch (eS0) { cStrk = null; }
    try { if (it.filled !== false) mark(cFill); } catch (e1) {}
    try { if (it.stroked === true) mark(cStrk); } catch (e2) {}

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
      }
    } catch (eD) {}
  }

  function walkLayers(lyrs, depth) {
    // v10.60(审查 2.2): 同 collectItem —— 20 -> 64, 与主扫描统一。
    if (depth > 64) return;
    for (var i = 0; i < lyrs.length; i++) {
      var ly = lyrs[i];
      try {
        var items = ly.pageItems;
        for (var j = 0; j < items.length; j++) collectItem(items[j], 0, true);
      } catch (eL) {}
      try { var subs = ly.layers; if (subs && subs.length) walkLayers(subs, depth + 1); } catch (eL2) {}
    }
  }
  walkLayers(doc.layers, 0);

  // ② 文字: 字符级 + 整帧默认色(含隐藏/锁定 —— 保守不误删)
  //   v0.5.2: 文字帧也算"对象"计入 objCount(空画板若含文本框, 不该被判成"遍历出错")
  try {
    var tfs = doc.textFrames;
    for (var ti = 0; ti < tfs.length; ti++) {
      var tf = tfs[ti];
      objCount++;
      // 整帧默认字符属性(段落/整帧色常落在这里)
      try {
        var tr = tf.textRange;
        try { var ca = tr.characterAttributes; mark(ca.fillColor); mark(ca.strokeColor); } catch (eCa) {}
      } catch (eTr) {}
      // 帧对象自身的填充/描边(文本框底纹/边框)
      // v10.33: 同 scanPathInk 口径统一为 `!== false`(审查 v10.32 第 3 条)
      try { if (tf.filled !== false) mark(tf.fillColor); } catch (eTf1) {}
      try { if (tf.stroked === true) mark(tf.strokeColor); } catch (eTf2) {}
    }
  } catch (eTX) {}

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

  return { names: names, colors: colors, objCount: objCount, colorTruncated: colorTruncated };
}

// 统计未使用色板(只读, 不修改文档)
//   返回 { total, used, unused }
//   v10.46(审查 P2-2): 删死字段 —— unusedNames/usedNames/noText/colorCount/nameCount
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
  } catch (e) {}
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
  } catch (e) {}
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
  } catch (e) {}
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
    // v10.46(审查 P2-1): 优先复用同轮串联里 pfClearUnusedSwatches 已收集的结果
    //   (两道安全闸在它那边已过; 删色板不改变在用颜色集合 ⇒ 判定等效)。
    //   单独调用(无缓存)时照旧自收集。
    var used = __pfUsedCache || pfUsedColorKeys(doc);
    // v10.60(审查 2.6): 一次性消费 —— 读完立即清空, 免得"上一轮的缓存"跨轮串味。
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
      res.error = "文档颜色数量超过收集上限(4000)，为避免误删，本次不执行删除。";
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
    // v10.60(审查 2.6): 进本函数即作废上一轮的轮内缓存 —— 下面若在安全闸处提前 return,
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
      res.error = "文档颜色数量超过收集上限(4000)，为避免误删，本次不执行删除。";
      return pfReturn(res);
    }

    // v10.46(审查 P2-1): 两道闸都过了 ⇒ 本次确实要删, 把收集结果存进轮内缓存,
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
  if (depth > 64) return;
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
// v10.35(审查 #6): 原实现命中即返回**单一**原因(hidden 判在 locked 之前) —— 同一节点
//   既隐藏又锁定时只报 hidden, 调用方若只认 locked(如叠印的"其中锁定 N 处")就会漏计。
//   现补 reasons/locked/hidden 三个字段**并列上报**, reason/node 保留原语义(首个命中,
//   供 pfClearBlock 精确解除)—— 旧调用点一字不改, 新调用点可用 locked 布尔。
// ⚠ v10.36 复核修正(审查 v10.35 指出): 这是**抽象改善, 不是实锤修复** ——
//   在当前扫描路径下 hidden 维度**不可达**: visitItem 对隐藏组(1067 行)与自身隐藏对象
//   (1148 行)都是**整支 return**, walkLayer 对隐藏图层(1334 行)也整支跳过 ⇒ 能走到
//   pfBlockInfo 调用的对象必然自身可见 + 祖先可见 + 所在图层可见, 故 fHidden 恒假,
//   新增的 hidden 字段在当前路径下**不改变任何结果**(locked 维度原代码已覆盖)。
//   保留它的价值 = 为"将来放宽剪枝(改成不剪枝隐藏组、逐项判 pfBlockInfo)"留好口子;
//   届时这个字段会立刻生效。**但不要因此就去掉上面的剪枝** —— 剪枝是性能根基。
function pfBlockInfo(item) {
  var p = item, guard = 0;
  var fLocked = false, fHidden = false, firstNode = null, firstReason = null;
  while (p && guard++ < 40) {
    var tn = "";
    try { tn = p.typename; } catch (et) { break; }
    if (tn === "Document") break;
    var isH = false, isL = false;
    try { isH = (p.visible === false || p.hidden === true); } catch (e) {}
    try { isL = (p.locked === true); } catch (e) {}
    if (isH || isL) {
      if (isH) fHidden = true;
      if (isL) fLocked = true;
      // 首个命中节点 = 离对象最近的那个, 保留原 reason/node 语义(pfClearBlock 由它解除)
      if (!firstNode) { firstNode = p; firstReason = isH ? "hidden" : "locked"; }
    }
    try { p = p.parent; } catch (ep) { break; }
  }
  if (!firstNode) return null;
  return { reason: firstReason, node: firstNode, locked: fLocked, hidden: fHidden,
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
    //   v10.46(审查 P1-1): 循环体抽成 pfClrOvpFrame —— 符号定义源内的文字帧复用同一套
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

    // 3) v10.46(审查 P1-1): 符号定义源内的对象(文字帧 + 路径)下钻清除。
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
          var kDef = null; try { kDef = kIt.symbol; } catch (eKd) {}
          var kSrc = null;
          if (kDef) { try { kSrc = kDef.item; } catch (eKs) {} if (!kSrc) { try { kSrc = kDef; } catch (eKs2) {} } }
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
        var sDef = null; try { sDef = sIt.symbol; } catch (eSd) {}
        var sSrc = null;
        if (sDef) { try { sSrc = sDef.item; } catch (eSs) {} if (!sSrc) { try { sSrc = sDef; } catch (eSs2) {} } }
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
      if (d > 64) return;
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
    //   v10.46(审查 P1-1): 循环体抽成 pfOutlineOne —— 符号定义源内的文字帧复用同一套
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

    // 2b. v10.46(审查 P1-1): 符号定义源内的文字下钻转曲。
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
          var kDef = null; try { kDef = kIt.symbol; } catch (eKd) {}
          var kSrc = null;
          if (kDef) { try { kSrc = kDef.item; } catch (eKs) {} if (!kSrc) { try { kSrc = kDef; } catch (eKs2) {} } }
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
        var sDefO = null; try { sDefO = sItO.symbol; } catch (eSdO) {}
        var sSrcO = null;
        if (sDefO) { try { sSrcO = sDefO.item; } catch (eSsO) {} if (!sSrcO) { try { sSrcO = sDefO; } catch (eSsO2) {} } }
        if (sSrcO && sSrcO.pageItems) pfOutlineInSym(sSrcO, 0);
      }
    } catch (eSymO) {}

    // v10.40: 复原可见性(临时显形结束) —— 先对象后图层(互不为祖先/后代, 顺序无关)
    for (var ro = 0; ro < restoreObjs.length; ro++) { try { restoreObjs[ro].hidden = true; } catch (eRq) {} }
    for (var rl = 0; rl < hiddenLayers.length; rl++) { try { hiddenLayers[rl].visible = false; } catch (eRl) {} }

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
    //   v10.46(审查 P1-1): 循环体抽成 pfRuleFrame —— 符号定义源内的文字帧复用同一套
    function pfRuleFrame(tf) {
      if (lf) unlocked += pfUnlockItem(tf);
      if (pfBlockInfo(tf)) { skipped++; return; }   // 锁定/隐藏: 跳过
      try {
        var ca = tf.textRange.characterAttributes;
        var fc = null, sc = null;
        try { fc = ca.fillColor; } catch (eFc) {}
        try { sc = ca.strokeColor; } catch (eSc) {}
        // 填充
        // v10.39(审查 B5): 只在**真的发生改变**时才计入 acted(与 pfClearOverprint 的
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
            // v10.39(审查 B5): 同文字侧 —— 只计真实改变
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

    // 3b. v10.46(审查 P1-1): 符号定义源内的对象(文字帧 + 路径)下钻执行规则。
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
          var kDef = null; try { kDef = kIt.symbol; } catch (eKd) {}
          var kSrc = null;
          if (kDef) { try { kSrc = kDef.item; } catch (eKs) {} if (!kSrc) { try { kSrc = kDef; } catch (eKs2) {} } }
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
        var sDefR = null; try { sDefR = sItR.symbol; } catch (eSdR) {}
        var sSrcR = null;
        if (sDefR) { try { sSrcR = sDefR.item; } catch (eSsR) {} if (!sSrcR) { try { sSrcR = sDefR; } catch (eSsR2) {} } }
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
  function junkWalkItems(items, depth) {
    if (depth > 64) return;
    for (var k = 0; k < items.length; k++) {
      var it = items[k], tn = "";
      try { tn = it.typename; } catch (eT) { continue; }
      if (tn === "PathItem") paths.push(it);
      else if (tn === "CompoundPathItem") cps.push(it);
      else if (tn === "TextFrame") texts.push(it);
      else if (tn === "GroupItem") { try { junkWalkItems(it.pageItems, depth + 1); } catch (eG) {} }
    }
  }
  function junkWalkLayers(lyrs, depth) {
    if (depth > 64) return;
    for (var j = 0; j < lyrs.length; j++) {
      var ly = lyrs[j];
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
    var p = it, guard = 0;
    while (p && guard++ < 40) {
      var tn = "";
      try { tn = p.typename; } catch (eC2) { break; }
      if (tn === "Document" || tn === "Layer") break;
      if (tn === "GroupItem") {
        var gis = null;
        try { gis = p.pageItems; } catch (eC3) { gis = null; }
        if (gis) {
          for (var k2 = 0; k2 < gis.length; k2++) {
            var ck = false;
            try { ck = (gis[k2].clipping === true); } catch (eC4) { ck = false; }
            if (ck) return true;
          }
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
      var p = paths[i], tn = "", np = -1, gd = false, fl = true, st = true;
      try { tn = p.typename; } catch (e2) { continue; }
      if (tn !== "PathItem") continue;
      // v11.21(外审 #9): 防御 —— doc.pathItems 若**包含复合路径的组件**, 那些组件的
      //   filled/stroked 可能跟着整体走或为空, 单个删掉会破坏复合路径。组件一律交给
      //   "复合路径整体"那一轮判定(下面第二个循环), 这里直接跳过。
      //   ⚠ 若某版 AI 的 pathItems 本就不含组件, 这条判断永不成立, 无副作用。
      //   v11.33: 枚举已换成树递归(不进入 CompoundPathItem), 组件根本不会出现在 paths
      //   里 ⇒ 本判断恒不成立, 纯属防御, 保留不删(将来若改回集合枚举会立刻再用上)。
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
function pfCleanupScan(doc) {
  var out = {
    stray:     { count: 0, hidden: 0, locked: 0 },
    unpainted: { count: 0, hidden: 0, locked: 0 },
    emptyText: { count: 0, hidden: 0, locked: 0 },
    spaceOnly: 0
  };
  pfJunkEach(doc, function (kind, it) {
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
      locks.push((bi && bi.locked) ? bi.node : null);
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
      if (depth > 64) return;
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
          // v10.46(审查 P1-1): 可见符号实例的定义源下钻 —— 检查端卡②的隐藏计数含
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
      if (depth > 64) return;   // v10.39(审查 B2): 与主扫描 walkLayer 同款上限, 防异常层树
      for (var i = 0; i < lyrs.length; i++) {
        var ly = lyrs[i], vis = true;
        try { vis = (ly.visible !== false); } catch (eV) {}
        if (!vis) continue;   // 隐藏图层: 整支跳过(层内对象不删)
        try { collectItems(ly.pageItems, 0); } catch (eCi) {}
        // v10.39(审查 B2): 原为 walkLayers(subs[j]) —— 传的是**单个 Layer**, 而 Layer.length
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
