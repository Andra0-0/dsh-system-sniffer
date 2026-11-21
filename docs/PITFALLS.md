# 踩坑与注意事项

> 只记**实测过、会再踩**的东西。每条：现象 → 原因 → 做法 → 依据。
> 设计取舍看 `DESIGN.md`，面板行为看 `DETAIL.md`。
>
> 这份文档写于私人开发期：文中提到的 `probe-*.mjs` / `test-*.mjs` 探针脚本与 `.data/...`
> 路径都在作者本地工作区，**没有随仓库发布**。结论本身不依赖这些文件——它们是当时的取证
> 记录，仓库里能跑的等价覆盖是 `test/` 下的 7 个文件。

## 1. PDH 的 `\Process(*)` 实例表是冻结的

- **现象**：进程页的列表是 Host 启动那一刻的名单；新开的程序永远不出现，关掉的进程留成零值行。不是"值不更新"，值每 2 s 在更新。
- **原因**：`\Process(*)` 是通配实例，PDH 在 `PdhAddCounter` 时枚举一次实例表，之后只给这批实例填新值；`typeperf` 没有重新枚举的选项。
- **做法**：进程名单不能用 PDH；改用 `NtQuerySystemInformation(SystemProcessInformation)`（每次调用重新枚举）。`core` / `gpu` 的实例集本来就固定（处理器、网卡、GPU 引擎），不受影响。
- **依据**：`probe-pdh-freeze-long.ps1` —— 开查询时 36 个实例，4 s 后启动 `ping.exe`，80 秒 41 行采样里它一次没出现，表头 1 次、列宽恒 35；面板侧 `proc` 组 37 分钟 `headers=1`、列宽 756 不变。

## 2. `typeperf` 的表头时间不能只看一次

- **现象**：同一组计数器，表头到达时间 0.46 s 和 2.34 s 都测到过。
- **原因**：输出是文件重定向还是管道、PowerShell 是流式还是一次性收集，都会改变缓冲行为；`-sc N` 时最后一行还常在退出时才吐出来。
- **做法**：量首帧只能流式读（`ForEach-Object` / 逐行读文件），并且至少跑三次取区间；不要用"命令跑完后的总耗时"当作到达时间。
- **依据**：`probe-typeperf-timeline.mjs` 与三轮 pwsh 复测。

## 3. koffi：`_Inout_ Struct *` 传对象是按值的

- **现象**：`GetDIBits(hdc, hbm, 0, 0, null, header, 0)` 返回 0，`header.biWidth` 一直是调用前设的值（koffi 把结构体复制进去，不写回）。
- **原因**：koffi 对"结构体参数"默认按值传递；`_Inout_` 并不改变这一点。
- **做法**：所有需要回写的结构体用 `koffi.alloc(Type, 1)` + `koffi.encode(ptr, Type, obj)`，参数声明成 `void *`，返回值用 `koffi.decode(ptr, Type)` 读。
- **依据**：`native/icon.cjs` 的 `makeBitmapInfo`；改之前 `GetDIBits` 恒 0，改之后返回 32 行。

## 4. `GetDIBits` 会写 `bmiColors`，40 字节的 `BITMAPINFOHEADER` 会越界

- **现象**：取图标本身正常，进程**退出时**报 `0xC0000374`（STATUS_HEAP_CORRUPTION），退出码 `-1073740940`。
- **原因**：`GetDIBits` 的目标位深小于 24 位时会往 `BITMAPINFO.bmiColors` 写调色板，而只分配了 40 字节的头，越界 8 字节。
- **做法**：给 `BITMAPINFO` 固定多留 1 KB 调色板空间（`koffi.alloc('uint8', sizeof(BITMAPINFOHEADER) + 1024)`）。
- **依据**：`native/icon.cjs` 注释；分步探针里只有"取 1bpp 掩码"那一步会触发。

## 5. 图标透明度的两种来源

- **现象**：部分老图标整张 alpha 全 0，PNG 出来是"全透明"。
- **原因**：32bpp 图标带 alpha 通道；老图标只有 1bpp AND 掩码（bit=1 表示透明），alpha 通道全 0。
- **做法**：先读 32bpp 颜色位图；若 alpha 全 0，改用掩码逐像素补 alpha（1 → 0，0 → 255）。
- **依据**：`native/icon.cjs` 的 `compose()`。

## 6. `SHGetFileInfo` 只给 32×32

- **现象/限制**：`SHGFI_LARGEICON` 是 32×32，`SHGFI_SMALLICON` 是 16×16；想要 48/256 得走 `SHGetImageList`（`IImageList`，COM）。
- **做法**：列表行 16–20 px 用 32×32 足够，浏览器缩；真要高清图标再上 COM。
- **依据**：`native/icon.cjs` 注释与实测（notepad 32×32、2.6 KB PNG）。

## 7. koffi 的原生模块解析路径

- **现象**：只复制 `node_modules/koffi` 不复制平台包时，报 `Cannot find the native Koffi module; did you bundle it correctly?`。
- **原因**：`koffi/src/koffi/index.cjs` 从 `../@koromix/koffi-<platform>-<arch>` 找 `.node`，平台包是 optionalDependency。
- **做法**：`node_modules/koffi` 与 `node_modules/@koromix/koffi-win32-x64` 必须同时存在（本机是直接从 `.data/tasks/.../probe-koffi` 的 pnpm 目录复制过来的）。
- **依据**：插件目录里 `node_modules` 的布局与 `require('koffi')` 实测。

## 8. 工具沙箱会虚拟化进程表、并禁命名管道

- **现象**：`Get-Process`/PDH 只看到 29–33 个进程（Host 里有 252 个）；`Node` 用默认 `stdio: 'pipe'` spawn 直接 `EPERM`；`fork` 的 IPC 也起不来。窗口枚举却能看到真实桌面的窗口。
- **原因**：DSH 的工具调用跑在受限命名空间里；进程枚举被过滤，命名管道被禁。
- **做法**：测试不要依赖 `spawn`/IPC —— 采集逻辑写成可 `require` 的纯模块（进程内直接调），管理器用假子进程测状态机；真机验 `fork` 只能在 Host 里做。进程数、窗口归属这类"绝对数字"在沙箱里没有代表性。**要真跑 `typeperf` 对拍**：加 `-o <文件>` + `stdio: 'ignore'`（不用管道），再轮询那个文件——它逐行 flush，够做逐拍配对（`probe-pdh-vs-typeperf.cjs`）。
- **依据**：`.data/tasks/261117_SystemSniffer进程页koffi选型/` 下的 `probe-*.mjs` 与 `test-native-collector-manager.mjs`。

## 9. Electron 子进程的启动方式与成本

- **做法**：`process.execPath` + `ELECTRON_RUN_AS_NODE=1`，不需要另装 Node；`fork` 的第四路 `ipc`。
- **实测**：冷启到首个快照 129 ms；WS 112 MB，其中 private 23.3 MB（其余是与主进程共享的 Electron 映像页）。
- **依据**：`child-idle.cjs` 与两次 `Start-Process` 计量。

## 10. 原生崩溃的现场默认是空的

- **现象**：本机 `%LOCALAPPDATA%\CrashDumps`、WER `LocalDumps` 注册表项、Crashpad 目录都不存在 —— 默认一个 dump 都不留。
- **可用的**：事件日志 `Application` ID 1000 一定有（出错模块 / 异常代码 / 偏移），够判断是不是 `koffi.node`。
- **坑**：Node 的 `--report-on-fatalerror` 抓不到 AV（它管 V8 fatal）；Electron 的 `crashReporter` 只覆盖主进程与渲染进程，**不覆盖 fork 出来的 node 子进程**。
- **做法**：要完整 dump 就配 `HKCU\Software\Microsoft\Windows\Windows Error Reporting\LocalDumps`（`DumpFolder`/`DumpType`/`DumpCount`）或开发期 `procdump -e -ma -w`；子进程与 Host 同名 exe，会连主进程一起收。
- **依据**：本机三处路径检查 + 事件日志现有记录。

## 11. `Idle` 的 CPU 是"全机空闲时间"，必须过滤

- **现象**：进程页第一行 `Idle` 常年 97–100%，任务管理器里根本没有它。
- **原因**：pid 0 的 kernel+user 时间累计的是**所有核的空闲时间**，按进程 CPU 差分算出来就是"机器有多闲"。
- **做法**：过滤 pid 0；顺带过滤 `Registry` / `Secure System` 这类内核伪进程（无映像、无窗口，任务管理器也不列）。`System`（pid 4）保留。
- **依据**：`native/collect.cjs` 的 `HIDDEN_PIDS` / `HIDDEN_NAMES`；改前实测 `Idle` 0.97。

## 12. `NtQuerySystemInformation` 的记录遍历：跳过一条也要推进 `offset`

- **现象**：加进程过滤后采集直接卡死（单核 100%，没有任何输出）。
- **原因**：跳过条目时用了 `continue`，把 `if (next === 0) break; offset += next` 一起跳过了，链表原地打转。
- **做法**：用 `if (!hidden) list.push(...)` 包住入表，遍历推进永远在最后无条件执行。
- **依据**：本次加 Idle 过滤时踩到；`probe-idle-filter.cjs` 复现（卡死 60 s 无输出）。

## 13. 段寿命结束后 store 里还留着旧值

- **现象**：工具调用拿到 55 秒前的进程快照（`sampledAt` 和当前时间差很大），模型会当成"现在"。
- **原因**：`processes` 30 s 退休后 `store` 仍保留 last value；`readForTool` 只要 `seq > 0` 就认为 settled，直接返回旧值。
- **做法**：settled 判据加"样本在 3 个 interval 之内"，否则等新样本（最多 `TOOL_WAIT_MS`）。
- **依据**：`system_sniff` 2026-11-17 21:05 实测：`cpu` 是当前时刻、`processes` 是 55 s 前。

## 14. `VerQueryValue` 的字符串长度是「字符数」，不是字节

- **现象**：读出来的 FileDescription 被截断成 `Windows`、`记事`、`Google`。
- **原因**：`VerQueryValue` 对字符串返回的长度单位是**字符**（含结尾 NUL），但对 `\VarFileInfo\Translation` 这类二进制块是字节。
- **做法**：字符串按 `len * 2` 字节解码，二进制块按 `len`。
- **依据**：`native/version.cjs`；`probe-version-len.cjs`：len=14 对应 `Windows 服务主进程` + NUL。

## 15. 受保护进程拿不到映像路径 → 按系统目录兜底

- **现象**：进程页大量行没有图标、没有中文名，任务管理器却有。
- **原因**：`OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` 对 SYSTEM / 受保护进程被拒，`QueryFullProcessImageName` 拿不到路径。
- **做法**：按映像名依次试 `%SystemRoot%\System32\<name>.exe`、`%SystemRoot%\<name>.exe`、`%SystemRoot%\SysWOW64\<name>.exe`；命中后图标与 FileDescription 都有了。Task Manager 对拿不到句柄的进程也是这么兜底的。
- **依据**：`native/collect.cjs` 的 `exePath()`；沙箱实测 `chrome → Google Chrome`、`conhost → 控制台窗口主机`。

## 16. `PdhGetFormattedCounterArrayW` 的缓冲区：koffi 传不了 NULL，size 里含实例名

- **现象**：`koffi` 调 `PdhGetFormattedCounterArrayW(..., null)` 抛 `Cannot pass ambiguous value to void *, use koffi.as()`；改成预分配后仍然恒返 `PDH_MORE_DATA`（`0x800007D2`），`count` 恒 334、`size` 恒 52294，而 `334 × 24 = 8016` 明明够。
- **原因**：① koffi 不给 `void *` 参数推断 `null` 的类型，`_Inout_ DWORD *` 这类必须声明成具体指针类型再传 `[n]` 数组；② PDH 报的 `size` 是**字节数且包含实例名字符串**（`szName` 指向同一块缓冲区），按 item 数算永远差一截。
- **做法**：size/count 声明 `_Inout_ uint32 *`、传 `[n]`；buffer 用 `koffi.alloc(ITEM, n)` 预分配（起步 64 项，永远不传 NULL），收到 `PDH_MORE_DATA` 就按 `max(count, ceil(size/stride)) × 2` 扩容重试，最多 3 次。
- **依据**：`native/pdh.cjs` 的 `readArray`；`probe-pdh-array.cjs` 里 4096 项一次成功、2179 项永远 `MORE_DATA`。

## 17. 通配计数器的实例表每拍刷新；typeperf 的冻结是它自己展开出来的

- **现象**：数组 API 读 `\Process(*)`，起一个进程后实例数 23 → 24 → 23，即拍与拍之间会变；typeperf 的 `\Process(*)` 却 80 秒列宽不变（§1）。
- **原因**：PDH 的 wildcard counter 在每次 `PdhCollectQueryData` 之后按当前实例枚举；`typeperf` 是**启动时把 `(*)` 展开成具体计数器路径**再加进查询，之后不会再枚举。
- **做法**：走原生就用 wildcard + 数组 API，每拍拿到的就是当前实例，不要照 typeperf 那样先展开。`\GPU Engine(*)` 的实例是「进程 × 引擎」（`pid_…_engtype_3D`），所以它尤其受益。
- **依据**：`probe-pdh-live-instances.cjs`（本次：notepad 起停前后 23/24/23）；冻结侧见 §1。

## 18. 速率计数器的首拍，PDH 自己会标成 `PDH_CSTATUS_INVALID_DATA`

- **现象**：`open` 之后第一次 `PdhCollectQueryData`，`PdhGetFormattedCounterValue` 返回 fnStatus `0xC0000BC6`、CStatus `0xC0000BBA`；数组 API 直接 `0xC0000BBA` 且 `count = 0`。
- **原因**：速率类计数器是两次 collect 的差分，第一拍没有基线。仪表类（已提交字节、专用显存）第一拍就是有效值。
- **做法**：任何不是 `PDH_CSTATUS_VALID_DATA` / `NEW_DATA` 的 CStatus 一律当 null；`0xC0000BBA` 是「这一拍没有数据」而不是故障，别塞进 problems。CSV 层那张 `RATE_COUNTERS` 名字表因此在原生路径上不需要了。同理，**两次 collect 挨得太近也返 `0xC0000BBA`**（实测连着调、间隔 ~0 ms），子进程按 1 s 采不会碰到，但写测试时别连着采两次。
- **依据**：`native/pdh.cjs` 的 `readValue` / `readArray`；`test-native-pdh.mjs` 断言首拍速率计数器全为 null、`problems` 为空（这一条最初把测试写成"连着采两次"，连跑了四次才偶发一次空 perCore）。

## 19. 首拍里「纯速率组」整组缺席，不是坏了

- **现象**：`native/pdh.cjs` 的 `sample()` 第一拍只返回 `core`（内存撑着）和 `gpu`（显存撑着），`disk` 组根本没有；`diskio` 段于是比 `cpu` 晚 1 s 才有第一个值。
- **原因**：`disk` 的 3 个计数器全是速率，首拍全是 `PDH_CSTATUS_INVALID_DATA` → 0 行 → `sample()` 不返回空组（空组容易被当成"这组坏了"，可用性由 `status()` 说）。
- **做法**：消费方按"组可能出现得晚一拍"处理；要测窗口点数就采三拍，别假设第一拍一定有五段。
- **依据**：`test-pdh-wiring.mjs` 里 `cpu 窗口 3 个点 / diskio 窗口 2 个点` 两条断言。

## 20. 渲染冒烟只覆盖"刚改的那个页签"，默认页签挂了没人发现

- **现象**：点进「系统」整页空白（连标题栏都没有）。控制台里是 `ReferenceError: diskPeak is not defined`；`diskPeak` 从来不存在，本该是 `diskStats.peak`。
- **原因**：上一次改磁盘卡时把 `diskStats.peak` 写成了 `diskPeak`，而当时的渲染冒烟只把页签切到「进程」再渲染 —— **性能页是默认页签，却一次都没被渲染过**。React 渲染抛错就整棵树不 commit，于是看起来"插件没加载"。
- **做法**：① 渲染冒烟必须把**每个页签**都渲染一遍（现在有 `render-smoke-native.mjs` 进程页 + `render-performance-smoke.mjs` 性能页）；② 喂给冒烟的载荷要用**真机抓下来的形状**（缺字段、null 段都要有），不要只喂"理想载荷"。
- **依据**：`261117_SystemSnifferPDH搬原生/render-performance-smoke.mjs`；修前 `RENDER THREW: ReferenceError: diskPeak is not defined`，修后 137 个节点正常渲染。

## 21. `wake()` 会把 `failed` 覆盖成 `starting`，降级原因被抹掉

- **现象**：某段一直没数据，`degraded` 却是空的 —— 因为读取前那次 `wake()` 把它从 `failed` 改回了 `starting`，而 `degraded` 只报 `failed`。
- **原因**：`wake()` 里"没有样本就标 `starting`"这条规则没有排除"已经失败"的状态。
- **做法**：只有 `seq === 0` 且状态不是 `failed` 时才标 `starting`；诊断状态优先级高于启动状态。
- **依据**：`index.js` 的 `wake()`；同一条也解释了为什么"计数器加上但不出行"这类沉默故障在面板上完全看不出来（已加 `sources[].rows` 与看门狗）。

## 22. 段寿命写了 `lifeMs` 却没生效：子进程不知道"没人看了"

- **现象**：进程段写的是"离开页面 30 s 后退休"，但离开后 CPU 照涨；隔半小时回来，表格里是"刚从旧值跳到新值"而不是冷启。子进程从头到尾没停过，`store` 里 `processes` 的 `seq` 也一直在涨。
- **原因**：寿命只落在 Host 的 `store` 上（`detach → 计时 → running.delete`），而**真正在枚举的是另一个进程**。那个子进程同时喂进程表和三个 `lifeMs: Infinity` 的 PDH 组，PDH 组永远有租约，所以子进程永远在跑；它的进程循环更是无条件的——`running` 集合、段状态、`lifeMs` 它一概看不到。于是"退出页面"退掉的是 Host 的一张表项，不是机器上的一次枚举。
- **做法**：加一条 Host→child 的订阅消息（`MESSAGE.WATCH`，`{ processes: bool }`），由 `sync()` 在算完 `running` 后下发；子进程据它开关 1 s 循环（关时连排队中的 tick 一起取消，开时立刻补一拍）。冷启动形态用 `--no-processes` 参数，重放同一状态。同时心跳要换判据：进程循环关掉时 `hello` 就是存活证明、`pdh` 消息就是心跳，否则"安静"会被当成"卡死"被杀。
- **验证**：`test-process-life.mjs`（13 项）—— 真 `apply()` + 真子进程 + 真路由；释放后 10 s 仍在宽限期内采（证明不是立刻停）、最后一拍落在释放后 25–36 s（证明 30 s 寿命真的到点）、之后两份 `lastAt` 完全不动、重新打开第一帧就恢复。`test-native-watch.mjs`（11 项）直接对子进程发 `watch` 验证同一件事，`test-native-collector-manager.mjs` 用假子进程覆盖 `--no-processes`、`hello` 即流式、以及两种心跳。
- **顺带**：`sources[].lastAt` 在"停采但子进程还在"时是**冻结**的，别把它当成健康信号；`state` 仍是 `streaming`（子进程活着、PDH 在跑）。判断进程段是否在采，要看 `states` + 是否有人持有租约，而不是 `lastAt` 的年龄。

## 23. 进程页「内存」列用了总工作集，比任务管理器大 2–4 倍

- **现象**：同一个进程，面板上是任务管理器的 2–4 倍（本机同时刻：explorer 592 MB vs 137 MB、DingTalk 410 vs 125、chrome 181 vs 54、Code 219 vs 136）；组行把成员求和后更夸张，看起来像"这机器内存被吃光了"。
- **原因**：读的是 `SYSTEM_PROCESS_INFORMATION.WorkingSetSize`（偏移 `0x90`），那是**工作集总量**，含与其他进程共享的映像页 —— 一个 DLL 被 100 个进程映射，就在 100 个进程里各算一遍。任务管理器「内存」列用的是**专用工作集**（`WorkingSetPrivateSize`，同一结构偏移 **`0x08`**，Vista 起就有），只算自己私有的那部分。
- **做法**：读 `0x08`，`workingSetBytes` 的语义固定为专用工作集（字段名沿用，注释与 `ARCHITECTURE.md` §5.1 都写明）。`privateWorkingSet` 为 0 的活进程用总量兜底（246 个里出现过 1 个）。**谁把这行改回 `0x90` 就是退回这个 bug。**
- **依据**：`probe-memory-offset.cjs` 对 246 个进程逐一比：缓冲区 `0x08` 与句柄侧 `NtQueryInformationProcess(ProcessVmCounters).PrivateWorkingSetSize` 在可开句柄的 123 个里 122 个完全相等（唯一差异是自己进程正在分配内存），所以不需要每拍开 250 个句柄；`probe-memory-private.cjs` 量过另一条路（`OpenProcess` + 句柄查询，全表 1.3 ms/拍）与差值倍数，作为备选口径留档。

## 24. CSS 写在模板字符串里：注释里出现反引号，整个 client.js 语法错误

- **现象**：渲染冒烟直接 `SyntaxError: Unexpected identifier`，报的位置在一行 CSS 注释中间，看起来完全莫名其妙；页面上则是"插件没加载"。
- **原因**：`CSS` 是 `client.js` 里的一个模板字符串，CSS 注释里写 `` `:not(:last-child)` ``、`` `max-width` `` 这类标识符，反引号提前闭合字符串。`node --check` 能抓到，但报错信息指向注释文字，不像字符串问题。
- **做法**：CSS 注释里**不写反引号**（用普通引号或直接写名字）；改完 `client.js` 先跑 `node --check` 再跑渲染冒烟。这条踩过两次（`max-width`、`:not(:last-child)`），第三次写"主题令牌名"时又中了一次。

## 25. 主题令牌：`--dsw-alias-label-on-color` 只被引用、从未定义

- **现象**：追踪页「开始录制」按钮在暗色主题下**看不见字**（白底白字），浅色主题正常；旁边的「清空」是 ghost 样式，跟着主题走，所以只有实心按钮坏。
- **原因**：`background: var(--dsw-alias-button-primary-fill)` 是真实令牌，暗色下等于 `--dsw-alias-brand-primary` → `neutral-bluish-50`（**接近白**）；而 `color: var(--dsw-alias-label-on-color, #fff)` 那个令牌在主题里**只有被引用的地方、没有赋值**，于是永远用 `#fff` 兜底 → 白字压白底。
- **做法**：实心按钮成对用 `--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-foreground`（这个**有定义**，浅色→近白、暗色→近黑，正好跟着填充色翻转）；hover 用 `--dsw-alias-button-primary-hover`。判定"令牌存不存在"的可靠方法是去 asar 里 grep `--xxx:`（带冒号）找定义，只 grep 名字会搜到一堆引用。
- **验证**：`probe-token-values.cjs "--dsw-alias-label-primary-foreground:"` 能打出两套主题的赋值。

## 26. 环形数据的时间基准：空缓冲的 `t0 = 0` 会顺着 append 传染

- **现象**：追踪页顶部数字每秒在跳、成员表也有，但**三条曲线一直是空的**；换个目标重建缓冲后又能画出来。
- **原因**：Host 的 `read()` 在环为空时回一个"只有状态、没有点"的包，`t0` 是占位的 `0`；客户端 `mergeTrace` 把它当上一包，下一包的真点 append 上去时沿用了 `t0 = previous.t0 = 0`，于是每个点的 x 坐标大约是 `-(1.79e12)/60s`，整条线画在屏幕外几千个屏宽处。
- **做法**：并列缓冲的 `t0` 属于**缓冲区里的第一个点**——上一包点数为 0 时取本包的 `t0`，点数 > 0 时才延续上一包的。`probe-trace-loop.mjs` 里"young record"那条断言会抓到回归。
- **附带**：窗口比数据还宽时，跟随态要**钉左**（`from = 第一个点`），否则一条 3 秒的线会挤在 60 秒窗口最右边 5% 里，看起来还是"没数据"。

## 27. 「干完活再等 1 秒」把采集耗时吃进周期

- **现象**：面板上看不出来。子进程的真实周期是 1.003–1.005 s 而不是 1 s，长时间追踪的横轴比真实时间短一截（8 h 差几十秒），而且没有任何一处在说这件事。
- **原因**：`native/child.cjs` 原来是 `tick()` 末尾 `setTimeout(tick, interval)`，于是周期 = `interval + 采集 + IPC 序列化`，纯线性累积：3 ms/拍 = 1 小时 10.8 s、8 小时 86 s。工作越重（进程表变大、以后 50 ms 的音频段）漂得越狠。
  **`setInterval` 不受此害**：libuv 先 `uv_timer_again()`（deadline = `loop->time + repeat`）**再**跑回调，回调耗时被吸收。所以「Host 侧 1 s 很准、子进程 1 s 不准」不是玄学，是两种写法。
- **做法**：`native/beat.cjs`。deadline = `anchor + n × interval`，`onBeat` 跑完再按"离目标还有多久"重算等待；落后超过一个整周期按整数**跳过并记账**（不补发：卡顿后连发 N 拍正是最吃不消的时候）；`performance.now()` 算等待、`Date.now()` 只给样本打时间戳；等待用 `ceil` —— 计时器 API 截断到整毫秒，截断 249.4 ms 会让这一拍早到 0.6 ms，宁可晚（晚是可测的）。
- **验证**：`node test/test-beat.mjs`（假时钟）——3 ms 工作量跑 10 拍仍落在 1000…10000 的整数栅格上、一次 1.6 s 卡顿只让一拍晚 600 ms 且下一拍回栅格、一次 3.6 s 卡顿记 `skipped: 2` 而不连发。真机：`native/child.cjs --verbose --beats=45 --interval=250`，看 `lateMax` 是否随 `beats` 增长（持平＝网格在守）。
- **顺手**：`SNAPSHOT.diagnostics.beat` / `PDH.beat` 上报 `{ intervalMs, periodMs, lateMs, lateMaxMs, skipped, beats }`，纯增量字段。以后要解释"这条 8 h 曲线为什么时间标签偏了几秒"，先看 `lateMaxMs` 和 `skipped`。

## 28. 两套 1 Hz 时钟的缝，不能靠「复制上一点」来糊

- **现象**：追踪曲线偶尔有一拍是平的（值不变），拖到很久以前时横轴时间又比真实早/晚几秒。两处都不显眼，所以拖了很久才发现。
- **原因**：追踪页有一条自己的 `setInterval(1000)`，子进程的采样是另一条（周期 1003 ms 左右，见 §27）。两条不同相的 1 Hz 时钟，平均每几分钟就有一次"这一拍没有新快照"，旧代码把上一点原样再 push 一次（`{...this.lastPoint}`）—— **等于把上一秒的数字写到这一秒的时间轴上，这是编数据**。而且环的起点按 `lastAt - (count-1) * interval` 反推，假设了等间隔：少一拍就把之前所有标签一起拉偏。
- **做法**（2026-11-20，四处一起改）：
  1. **点由写入驱动**：`Store.onWrite` → `trace.tick()`，挂在 `processes` 段的写入上。两条时钟变一条，不存在"有拍没数"的 tick。追踪页只留一条 20 s 的租约 keepalive。
  2. **没有新样本就不产点**：不复制上一点，也不塞 `null`。缺失就是缺失（用户 2026-11-20 明确要求）。
  3. **每点存真实时间**：`times[]` 与序列并列，`coverage` 取首尾真实值，`range` 二分定位下标、桶归属用 `times[i]`；`read` 回 `times[]`（`t0`/`dt` 留作旧客户端的兜底）。
  4. **客户端按 `times[i]` 算 x**，没有才退回 `t0 + i*dt`；跟随态的右边缘跟**时钟**走（`max(最新点, now)`），于是缺的那一秒是"窗口继续走、洞里空着"，而不是画面卡住。
- **验证**：`test/test-trace.mjs`（同一快照 tick 两次不产点、缺一秒后 `coverage`/`times` 仍对、range 按真实时间落桶、写事件驱动产点与退订）；`test/test-client-boot.mjs`（+0/+15/+45 s 三点必须画在 0/25/75%，均匀网格会画到 0/1.7/3.3% —— 这条断言在旧实现上必失败）。
- **缺口怎么画**（2026-11-20 用户定）：**不画空缺**。不产点＝相邻两点之间就是一条直线，所以那一段自然"平滑过渡"，既没有断线也没有硬塞一个值；用户看到的是"线稍微直了一点"，不是"程序缺了一块"。
- **连续 30 s 没有新点就停止**（`TraceStore.sweepStall`，`endedReason: 'stalled'`，同时释放租约 → 进程段 30 s 后退休）。录着一个已经死掉的采集器、页头还在计时，才是最容易让人以为面板坏了的形态；短缺口平滑画过去，长故障直接结束。

## 29. 子进程重启后那一两拍 `null`，被画成了"页面坏了"

- **现象**（2026-11-20 真机）：强杀采集子进程后性能页的折线**缺了一段**，看着像面板崩了。
- **原因**：子进程被杀 → 重启 → PDH 第一次 `PdhCollectQueryData` 没有基线，速率类计数器全返回 `PDH_CSTATUS_INVALID_DATA`（§18），`extract*` 得到 `null`；`Store` 把 `null` 也写进窗口；客户端 `plotSeries` 遇到 `null` 就断线，于是图表上出现一个 1–2 拍的空洞。数据上它是诚实的（那一拍确实没有有效速率），但视觉上和"渲染坏了"没法区分。
- **做法**：`GAP_BREAK = 5`。连续 `null` 少于 5 拍就连直线跨过去（一个无效采样不是"缺一块"，是"少一个数"）；连续 5 拍以上（子进程真的离开几秒）仍然断开。
- **同源问题（2026-11-20 同日修掉）**：性能页窗口原来也是名义网格（`t0 = at - (n-1) * 1000`），杀掉子进程几秒会让 60 点窗口**悄悄压缩**。现在 `Store` 每段并列 `times[]`，`t0` 取首点真实时间；**只有当窗口间距不均匀时才把 `times` 下发**（正常情况载荷一分钱不多），客户端 `plotSeries` 有 `times` 就按真实时间摆点（60 s 窗宽不变，缺口处就是一段更长的直线）。`test/test-store.mjs` 锁住这五条语义。

## 30. 停止之后，被自己的兜底 kill 复活

- **现象**：`test/test-native-manager.mjs` 跑完全部断言后进程不退出（`getActiveResourcesInfo()` 显示 9 个 `Timeout` 常驻，`_getActiveHandles()` 一个也看不到 —— 定时器不属于 handle）。真机上的对应形态是"点了停止，过一会儿采集器自己又回来了"，只在 `stop()` 的握手超过 500 ms 时发生。
- **原因**：`stop()` 先把 `#child` 置空、等 `exit`（最多 500 ms），然后 `child.kill()` 兜底，最后把 `#stopping` 置回 `false`。kill 触发的**第二个** `exit` 到达时 `#stopping` 已经是 false，`#onExit` 就当成崩溃 → `#fail` → 重启 → 新的 heartbeat 与启动超时定时器挂在那里，而调用方早就走了，没人再停它。测试里之所以必现，是因为假子进程的 `kill()` 一定会回一个 `exit`。
- **做法**：`#onExit` 第一行 `if (this.#child === null) return`。没有挂着的子进程就没有"崩溃"可言；该做的清理（`#hello`、图标等待者）`stop()` 自己已经做了。
- **验证**：`test-native-manager.mjs` 新增"stop 之后再发一次 exit"用例（状态仍是 `stopped`、不新增子进程、不计数 restart），并且这个文件现在**能自己退出**（1.5 s，此前挂到超时）；`run.mjs` 与 `test-client-boot.mjs` 里兜底的 `process.exit(0)` 也随之改成"仅在直接运行时才 exit"。

## 31. 已退出的成员行，把在跑的成员挤出了名单

- **现象**（2026-11-20 真机，长期录制）：追踪页页头显示「成员 39」，可这个组当时只有 7 个进程（进程页看得到 7 个）。成员树里一个子行都打不开，只剩一行「其他 7 个进程」，点它没反应。
- **原因**：`#membersView` 把活的和冻住的行放进**同一个数组**，按「当前专用字节」排序后切前 32。冻住的行保留退出那一刻的内存值（通常很大），于是几十个幽灵占满 32 个名额，真正在跑的 7 个落进 `others` —— 而 `others` 只是合计行，页面只能把它画成一行不可点的「其他 N 个」。「成员 39」也是同一个数组的长度，把历史 pid 当成了当前成员。
- **做法**（2026-11-20）：活的和冻的**分两段各排各的**——在跑成员按专用字节排在前面、独占 `liveLimit`（128，整份预算归它们），冻住的行跟在后面、按退出时间倒序最多 `exitedLimit`（20）个；两个数分别下发（`live` / `exited`），页头只数在跑的，已退出块报总数。运行期再对冻住的行做上限清扫（`exitedKeep` 200），否则 8 h 录制里反复起落的子进程会攒出几千行、每次读取都要全排序。
- **验证**：`test/test-trace.mjs` 的「frozen rows never crowd live members out of the payload」与「frozen rows are capped」两例（旧实现在第一条上必失败：live 全被挤进 `others`）；`test/test-client-boot.mjs` 断言组头的计数是 live 数。

## 32. 桶宽等于采样间隔时，密数据会被读路径切成一段一段

- **现象**（2026-11-21 真机，追踪页）：一段每秒都有点的录制（页头「0:26 · 26 点」），范围条的窗口**只要不在最右端**——拖到左边、或者拉满成「全部」——三条曲线就被切成 4–5 段，每段 5–6 s、缺口 2–3 s；窗口贴在右端（映射成"跟随"，走 `read()` 的尾读）时是一条完整的线。断口位置三条曲线一致，说明是同一批点。
- **原因**：`range()` 把窗口按 `bucketMs = ceil(span/600/interval)*interval` 切桶，短窗口下这个值就是 `intervalMs`（1 s），而**桶的相位挂在窗口起点上**，采样相位挂在子进程的 beat 上（beat 锚在子进程自己的 `performance.now()` 起点，再叠上每次枚举耗时的抖动；实测相邻快照 984–1016 ms）。两者一错开，就有两个采样落进同一个桶、它后面那个桶空着；空桶下发成 `null`，`TraceChart` 只在非有限值处断笔 → 一份正常数据被画成碎裂曲线。这不是"缺采样点"，是**读路径造出来的洞**；`read()` 从来没有这个毛病，因为它下发真实 `times`。
- **做法**（2026-11-21）：`range()` 按「这个窗口里的点数装不装得下」分两种形态：
  - 装得下（`(to-from)/interval + 1 <= MAX_POINTS`，1 Hz 下即 20 分钟以内）→ **直接给原始采样 + 真实 `times`**，和 `read()` 一样，根本没有网格；
  - 装不下 → 仍然 min/max 分桶，但桶宽**下限提到 2×interval**。桶宽大于任何一次真实采样间隔时，相邻采样的桶号只能前进 0 或 1，**不可能跳过某个桶**，所以空桶只可能是"这一桶确实没采到"（真缺口）。
- **验证**：`test/test-trace.mjs` 新增「a window that fits is answered with the samples, not with a grid」（抖动时间戳的 600 点环：`times` 逐点相等、无 `null`、尖峰仍在）与「a real hole is a time jump, and a wide window still buckets」（缺一秒在 `times` 上表现为 2 s 跳变；8 h 窗口仍分桶且 `bucketMs >= 2000`）。同会话目录的 `sim-buckets.mjs`（旧规则在 26 点环上平均切 2–3 段）与 `verify-fix.mjs`（20 个窗口：旧规则 0–2 个空桶，新规则 0 空桶、全 1 段）。
- **顺带定下的口径**：原始采样形态里，真实缺口是 `times` 上的跳变，`TraceChart` 会**连一条斜线跨过去**（它只断在 `null` 上），页头的「缺口 x.x s」标签负责把这件事讲出来；分桶形态里才是空槽。这样同一个环不会再出现"一种窗口断、另一种窗口不断"。

## 33. 视口比环活得久：换了环还按「全部」画，折线就"翻过来"了

- **现象**（2026-11-21 真机）：追踪页预览 60 秒以上 → 切回会话待 5 秒以上（预览被 TTL 清掉、环被丢）→ 再回追踪页，页面自己重开预览，折线变成**从左往右长**（从最左边起、满宽），而不是像每次新预览那样贴着右边缘往里走。
- **原因**：`traceView`（`spanMs` / `endAt`）故意活在运行期里而不是 React state 里——切页签、开会话不能让用户设的缩放悄悄丢掉。但它**也没挂在环上**：预览被 TTL 清掉后环没了、视口还在，新环就继承了旧环的视口。「全部」（`spanMs: null`）的含义是"整个环"，对一条刚开 3 个点的新环就是满宽：第一个点落在 x=0，之后新点一路往右长——正是"翻过来"。跟随模式（`spanMs: 60000, endAt: null`）才会让新环贴着右边缘长大。
- **做法**（2026-11-21）：`publishTrace` 记 `ringStartedAt`（环的 `startedAt`），一旦变化就 `resetTraceView()`：`endAt` 清空，`spanMs` 若是 `null`（全部）回到 `TRACE_DEFAULT_SPAN`、否则保留（缩放是偏好，环没换就不清）。`startedAt` 是"这还算不算同一个环"的诚实判据——预览转录制时 `TraceStore.start` 的 keepRing 不重置它，所以那种情况视口不动。
- **验证**：`test/test-trace-reentry.mjs`（真运行期 + 假 Host 的预览/录制/停止/清空状态机）：换环后视口回到跟随、新环贴右边缘（x > 90%），同一条新环按「全部」才是满宽；预览转录制则原样保留用户设的缩放。把那行 `resetTraceView()` 注释掉，第一条断言必失败（已实测）。


- **顺带定下的口径**：只有「在跑成员超过 128」才会出现「其他 N 个进程」。它是合计行、不可展开，所以行上带一句说明——一行看着能点却没反应，比多一行文字更糟。
