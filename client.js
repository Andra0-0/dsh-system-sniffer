/**
 * System sniffer — Client half.
 *
 * One page in the main column, shaped like the SSH operations panel: a header
 * with a back-to-conversation control and the product title, a tab bar, and one
 * tab body. The tabs split the same snapshot three ways — processes,
 * performance, disks — instead of stacking every section on one screen.
 *
 * Sampling is owned by the Host now: this half only asks for the sections the
 * current tab shows, with a per-section cursor, and renders what comes back.
 * The loop lives in the runtime rather than the page, because the layout
 * unmounts a deselected page and a page that took its timer with it came back
 * to a broken chart. The Host keeps the window, so returning re-reads the last
 * minute instead of living with a hole.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-system-sniffer',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    /** Main-slot key and sidebar row id: one string drives both seats. */
    const PANEL_ID = 'system-sniffer'
    /** Client locale namespace owned by this plugin. */
    const NS = 'system-sniffer'
    /** Sparkline depth: one minute at the poll cadence. */
    const HISTORY = 60
    /**
     * How many consecutive invalid samples break a line.
     *
     * A killed collector comes back with one or two `null` rate samples (PDH's
     * first collect after `PdhCollectQueryData` has no baseline, see
     * `PITFALLS.md` §18), and punching a hole for those reads as a broken chart.
     * A real outage — the child away for seconds — still breaks.
     */
    const GAP_BREAK = 5
    /** Poll cadence; each Host group keeps its own sampling interval. */
    const POLL_MS = 1000
    /**
     * How long a request may hang before it is aborted.
     *
     * `poll()` holds `inFlight` until its request settles, so a Host that stops
     * answering mid-connection (a half-open socket) used to pin the loop
     * forever: no error, no retry, no way out but a page reload. The timeout
     * turns that into an ordinary failed poll, which the banner and 重试 handle.
     */
    const REQUEST_TIMEOUT_MS = 8000
    /** `AbortSignal.timeout` is newer than some runtimes DSH may run on. */
    const timeoutSignal = (ms = REQUEST_TIMEOUT_MS) => (
      typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(ms)
        : undefined
    )
    /**
     * Sections each tab shows. The loop asks the Host for nothing else, so the
     * disk tab stops paying for a process table and the process tab stops
     * paying for four charts.
     *
     * The process tab also asks for the four machine-wide sections: its header
     * band shows CPU / memory / disk / network totals like Task Manager's, and
     * they are `lifeMs: Infinity` sections that run anyway, so the only cost is
     * a few hundred bytes per poll.
     */
    const TAB_SECTIONS = {
      performance: ['cpu', 'memory', 'network', 'gpu', 'diskio', 'volumes'],
      processes: ['processes', 'cpu', 'memory', 'network', 'diskio'],
      disks: ['volumes'],
      // `trace` is not a section: the Host keeps it separately and answers with
      // its own cursor. Asking for it alone releases this client's other leases,
      // which is right — the trace tab draws no machine-wide chart.
      trace: ['trace'],
    }

    /** Section id -> the sparkline buffer it feeds. */
    const CHART_SECTIONS = { cpu: 'cpu', memory: 'memory', gpu: 'gpu', network: 'net', diskio: 'disk' }

    /** Tab order in the bar. */
    const TABS = [
      { id: 'processes', label: 'tab.processes' },
      { id: 'performance', label: 'tab.performance' },
      { id: 'disks', label: 'tab.disks' },
      // Last, and not the default: a trace is something you start from a process
      // row, not the first thing a visitor needs.
      { id: 'trace', label: 'tab.trace' },
    ]

    /**
     * The tab the page opens on.
     *
     * This used to be `performance`, because the old `typeperf` process group
     * needed two 2 s samples before its CPU column had anything in it, and a
     * table with one column empty read as broken. The native collector fills the
     * table in ~130 ms (and the CPU column on the second 1 s tick), so the
     * process list is the useful first screen again — it is what a visitor
     * opens this panel for.
     */
    const DEFAULT_TAB = 'processes'

    /**
     * Pin mark: drawn, not an emoji, so it inherits the row's color. A filled
     * pushpin (Material's `push_pin` silhouette), 12 px and tilted via CSS: at
     * 14 px upright it read as a solid logo rather than an affordance, and a
     * straight pin looks like a lollipop — the tilt is what makes it a 图钉.
     * It sits at the end of the name, so the button never steals a column in
     * front of the icon.
     */
    const PIN_GLYPH = h('svg', {
      viewBox: '0 0 24 24',
      width: 12,
      height: 12,
      'aria-hidden': true,
      focusable: 'false',
    }, h('path', {
      d: 'M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z',
      fill: 'currentColor',
    }))

    /**
     * Group disclosure, drawn as a chevron like Task Manager's: a right-pointing
     * `>` that turns down when the group opens. Drawn rather than a text glyph
     * so the stroke weight and the rotation are ours.
     */
    const CHEVRON_GLYPH = h('svg', {
      viewBox: '0 0 10 10',
      width: 14,
      height: 14,
      'aria-hidden': true,
      focusable: 'false',
    }, h('path', {
      d: 'M3.6 1.6 7 5l-3.4 3.4',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.7,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }))

    /**
     * Rail order on the performance page, the same five entries Task Manager
     * shows on its performance tab. The page opens on CPU, like Task Manager.
     */
    const FOCUS_IDS = ['cpu', 'memory', 'disk', 'network', 'gpu']
    const DEFAULT_FOCUS = 'cpu'

    /**
     * Per-category line colors, carried from Task Manager: blue CPU, cyan
     * memory, green disk, magenta network, violet GPU. They are data colors,
     * not chrome — mid-tone so a line stays legible on both themes.
     */
    const ACCENT = {
      cpu: '#3b82f6',
      memory: '#06b6d4',
      disk: '#22c55e',
      network: '#d946ef',
      gpu: '#8b5cf6',
    }

    /** Copy for this plugin's surface; the locale service is preferred, this is the floor. */
    const STRINGS = {
      zh: {
        'entry.label': '系统',
        'panel.title': 'SystemSniffer',
        'panel.back': '返回会话',
        'action.retry': '重试',
        'error.failed': '采样失败：{message}',
        'tab.processes': '进程',
        'tab.performance': '性能',
        'tab.disks': '磁盘',
        'perf.rail': '系统资源',
        'perf.cpu': 'CPU',
        'perf.memory': '内存',
        'perf.disk': '磁盘',
        'perf.network': '网络',
        'perf.gpu': 'GPU',
        'perf.metricCpu': '使用率',
        'perf.metricMemory': '已提交内存',
        'perf.metricThroughput': '吞吐量',
        'perf.metricThroughputMulti': '吞吐量（{count} 个接口合计）',
        'perf.metricGpu': '利用率',
        'perf.metricDisk': '磁盘吞吐量',
        'perf.read': '读取',
        'perf.write': '写入',
        'perf.factActive': '活动时间',
        'perf.factDisks': '磁盘数',
        'perf.send': '发送',
        'perf.receive': '接收',
        'perf.peak': '60 秒峰值',
        'perf.average': '60 秒平均',
        'perf.committed': '已提交',
        'perf.physicalAvailable': '物理可用',
        'perf.share': '已提交占比',
        'perf.limit': '提交上限',
        'perf.used': '已用',
        'perf.free': '可用',
        'perf.dedicated': '专用显存',
        'perf.window': '60 秒',
        'perf.waiting': '等待首个样本',
        'perf.gpuUnavailable': '本机没有 GPU 计数器',
        'perf.cores': '{count} 个逻辑处理器',
        'perf.pair': '{used} / {limit}',
        'perf.seconds': '{seconds} 秒',
        'perf.factAdapter': '适配器名称',
        'perf.factIpv4': 'IPv4 地址',
        'perf.factIpv6': 'IPv6 地址',
        'perf.factCores': '逻辑处理器',
        'perf.factVolumes': '卷',
        'perf.factCapacity': '容量合计',
        'perf.factEngines': '引擎',
        'perf.factInterval': '采样间隔',
        'perf.factSource': '数据来源',
        'perf.sourcePdh': 'PDH 计数器',
        'perf.sourceStatfs': 'fs.statfs',
        'section.degraded': '采集降级',
        'process.toolbar': '{names} 个分组 · {pids} 个进程',
        'process.hint': '双击行固定',
        'process.pin': '固定',
        'process.unpin': '取消固定',
        'process.pinLimit': '最多固定 {limit} 个',
        'process.lost': '已退出',
        'process.leadPid': '代表进程 PID {pid}',
        'process.expand': '展开',
        'process.collapse': '折叠',
        'process.sortBy': '按 {name} 排序',
        'process.resizeColumn': '拖动调整列宽',
        'process.name': '名称',
        'process.pid': 'PID',
        'process.cpu': 'CPU',
        'process.memory': '内存',
        'process.empty': '暂无进程数据，正在等待首个样本',
        'disk.summary': '{count} 个卷 · 已用 {used} / 共 {total}',
        'disk.used': '{percent}% 已用',
        'disk.free': '剩 {size}',
        'disk.empty': '没有读到任何卷',
        'disk.scan': '扫描',
        'disk.scanStop': '停止',
        'disk.scanRunning': '统计中',
        'disk.scanDone': '已扫描',
        'disk.scanIdle': '点「扫描」统计这个卷的目录占用',
        'disk.scanOther': '其他 {count} 项',
        'disk.scanSize': '{size} · {share}',
        'disk.scanNoAccess': '无权限',
        'disk.scanPolicy': '模型可见',
        'disk.scanPolicyOff': '关闭',
        'disk.scanPolicyNumbers': '仅数字',
        'disk.scanPolicyNames': '含目录名',
        'disk.scanSessionOnly': '仅本次会话生效（未写入配置）',
        'disk.scanFailed': '扫描失败：{reason}',
        'disk.scanBack': '返回卷列表',
        'disk.scanLast': '上次扫描',
        'disk.scanView': '查看',
        'disk.pathHint': '或输入要扫描的目录，例如 D:\\项目',
        'disk.scanOf': '占 {name} {percent}%',
        // 诚实口径：扫到的目录树永远小于卷"已用"（系统元数据、卷影副本、无权限目录）。
        'disk.scanCovered': '已扫出 {scanned} / 实际已用 {used}',
        'disk.scanGap': '另有 {gap} 不在任何目录里（系统元数据 / 卷影副本 / 无权限目录）',
        'sampling.wait': '正在采样…',
        'tab.trace': '追踪',
        'trace.menuGroup': '追踪此组',
        'trace.menuProcess': '追踪此进程',
        'trace.empty': '还没有追踪',
        'trace.emptyHint': '在进程页右键一个组或进程，就能在这里看它的实时曲线；点「开始录制」才会留下历史。',
        'trace.preview': '预览',
        'trace.recording': '正在记录',
        'trace.stopped': '已结束',
        'trace.pending': '未开始',
        'trace.start': '开始录制',
        'trace.stop': '停止追踪',
        'trace.clear': '清空',
        'trace.clearConfirm': '清空追踪？目标与已有曲线都会丢掉。',
        'trace.replace': '替换并开始',
        'trace.replacePreview': '替换预览',
        'trace.cancel': '取消',
        'trace.previewHint': '离开本页 5 秒后清空；点「开始录制」后关面板也会继续记。',
        'trace.stoppedHint': '已停止，曲线留着。再点「开始录制」会清掉这段旧曲线重新开始。',
        'trace.pendingHint': '点「替换并开始」才会结束当前这段追踪。',
        'trace.pendingReplacing': '当前追踪的是 {label}，替换会结束它。',
        'trace.elapsed': '已记录 {time}',
        'trace.points': '{count} 点',
        'trace.gap': '缺口 {gap} s',
        'trace.target': '目标',
        'trace.cpu': 'CPU',
        'trace.memory': '专用字节',
        'trace.handles': '句柄',
        'trace.threads': '线程',
        'trace.io': '磁盘 I/O',
        'trace.read': '读',
        'trace.write': '写',
        'trace.span': '最近 {span}',
        'trace.spanSeconds': '{count} 秒',
        'trace.spanMinutes': '{count} 分钟',
        'trace.spanHours': '{count} 小时',
        'trace.fit': '全部',
        'trace.zoomHint': '拖动平移 · 双击回到实时',
        'trace.overviewHint': '整环概览：拖两端改范围 · 拖中段平移 · 点空白跳过去 · 双击回到实时',
        'trace.exitedAt': '已退出 {time}',
        'trace.others': '其他 {count} 个进程',
        'trace.othersHint': '这 {count} 个在跑成员超出下发上限，只合计内存与 CPU（不是可展开的行）',
        'trace.noData': '正在等待首个样本',
        'trace.badge': '正在记录 {label}',
        'trace.members': '成员 {count}',
        'trace.noMembers': '还没有成员样本',
        'trace.railCollapse': '收起成员栏',
        'trace.railExpand': '展开成员栏',
        'trace.railResize': '拖动调整宽度 · 双击复位',
        'trace.exited': '已退出 {count}',
        'trace.exitedMore': '还有 {count} 个更早退出的',
        'trace.backToChart': '返回图表',
        'trace.detailIdentity': '标识',
        'trace.detailMemoryGroup': '内存',
        'trace.detailUsage': '句柄 / 线程 / I/O',
        'trace.detailName': '名称',
        'trace.detailImage': '映像名',
        'trace.detailPid': 'PID',
        'trace.detailParent': '父 PID',
        'trace.detailGroup': '所属组',
        'trace.detailCreated': '创建时间',
        'trace.detailRuntime': '运行时长',
        'trace.detailFirst': '首次出现',
        'trace.detailWatched': '已观察',
        'trace.detailPeak': '峰值',
        'trace.detailPeakAt': '峰值 {value}',
        'trace.detailAverage': '平均',
        'trace.readRate': '读速率',
        'trace.writeRate': '写速率',
        'trace.detailExitedHint': '已退出的进程只有退出前最后一份统计。',
      },
      en: {
        'entry.label': 'System',
        'panel.title': 'SystemSniffer',
        'panel.back': 'Back to chat',
        'action.retry': 'Retry',
        'error.failed': 'Sampling failed: {message}',
        'tab.processes': 'Processes',
        'tab.performance': 'Performance',
        'tab.disks': 'Disks',
        'perf.rail': 'System resources',
        'perf.cpu': 'CPU',
        'perf.memory': 'Memory',
        'perf.disk': 'Disk',
        'perf.network': 'Network',
        'perf.gpu': 'GPU',
        'perf.metricCpu': 'Utilization',
        'perf.metricMemory': 'Committed memory',
        'perf.metricThroughput': 'Throughput',
        'perf.metricThroughputMulti': 'Throughput ({count} interfaces)',
        'perf.metricGpu': 'Utilization',
        'perf.metricDisk': 'Disk throughput',
        'perf.read': 'Read',
        'perf.write': 'Write',
        'perf.factActive': 'Active time',
        'perf.factDisks': 'Disks',
        'perf.send': 'Send',
        'perf.receive': 'Receive',
        'perf.peak': 'Peak in 60 s',
        'perf.average': 'Average in 60 s',
        'perf.committed': 'Committed',
        'perf.physicalAvailable': 'Physical available',
        'perf.share': 'Share of limit',
        'perf.limit': 'Commit limit',
        'perf.used': 'Used',
        'perf.free': 'Free',
        'perf.dedicated': 'Dedicated',
        'perf.window': '60 s',
        'perf.waiting': 'Waiting for the first sample',
        'perf.gpuUnavailable': 'No GPU counters on this machine',
        'perf.cores': '{count} logical processors',
        'perf.pair': '{used} / {limit}',
        'perf.seconds': '{seconds}s',
        'perf.factAdapter': 'Adapter',
        'perf.factIpv4': 'IPv4 address',
        'perf.factIpv6': 'IPv6 address',
        'perf.factCores': 'Logical processors',
        'perf.factVolumes': 'Volumes',
        'perf.factCapacity': 'Total capacity',
        'perf.factEngines': 'Engines',
        'perf.factInterval': 'Sample interval',
        'perf.factSource': 'Source',
        'perf.sourcePdh': 'PDH counters',
        'perf.sourceStatfs': 'fs.statfs',
        'section.degraded': 'Collection degraded',
        'process.toolbar': '{names} groups · {pids} processes',
        'process.hint': 'Double-click a row to pin',
        'process.pin': 'Pin',
        'process.unpin': 'Unpin',
        'process.pinLimit': 'At most {limit} pins',
        'process.lost': 'Exited',
        'process.leadPid': 'Lead process PID {pid}',
        'process.expand': 'Expand',
        'process.collapse': 'Collapse',
        'process.sortBy': 'Sort by {name}',
        'process.resizeColumn': 'Drag to resize',
        'process.name': 'Name',
        'process.pid': 'PID',
        'process.cpu': 'CPU',
        'process.memory': 'Memory',
        'process.empty': 'No process data yet — waiting for the first sample',
        'disk.summary': '{count} volumes · used {used} of {total}',
        'disk.used': '{percent}% used',
        'disk.free': '{size} free',
        'disk.empty': 'No volume was readable',
        'disk.scan': 'Scan',
        'disk.scanStop': 'Stop',
        'disk.scanRunning': 'Counting',
        'disk.scanDone': 'Scanned',
        'disk.scanIdle': 'Press Scan to count what uses space on this volume',
        'disk.scanOther': '{count} more',
        'disk.scanSize': '{size} · {share}',
        'disk.scanNoAccess': 'no access',
        'disk.scanPolicy': 'Model can see',
        'disk.scanPolicyOff': 'off',
        'disk.scanPolicyNumbers': 'numbers only',
        'disk.scanPolicyNames': 'with names',
        'disk.scanSessionOnly': 'this session only (not saved to config)',
        'disk.scanFailed': 'Scan failed: {reason}',
        'disk.scanBack': 'Back to volumes',
        'disk.scanLast': 'Last scan',
        'disk.scanView': 'View',
        'disk.pathHint': 'Or scan a folder, e.g. D:\\projects',
        'disk.scanOf': '{percent}% of {name}',
        'disk.scanCovered': '{scanned} of {used} counted',
        'disk.scanGap': '{gap} is not in any folder (system metadata, shadow copies, no-access folders)',
        'sampling.wait': 'Sampling…',
        'tab.trace': 'Trace',
        'trace.menuGroup': 'Trace this group',
        'trace.menuProcess': 'Trace this process',
        'trace.empty': 'Nothing is being traced',
        'trace.emptyHint': 'Right-click a group or a process on the Processes tab to watch its live curve here. Only Start recording keeps a history.',
        'trace.preview': 'Preview',
        'trace.recording': 'Recording',
        'trace.stopped': 'Ended',
        'trace.pending': 'Not started',
        'trace.start': 'Start recording',
        'trace.stop': 'Stop tracing',
        'trace.clear': 'Clear',
        'trace.clearConfirm': 'Clear the trace? The target and every recorded point go with it.',
        'trace.replace': 'Replace and start',
        'trace.replacePreview': 'Preview instead',
        'trace.cancel': 'Cancel',
        'trace.previewHint': 'Leaving this page clears it after 5 s; once you press Start, closing the panel keeps recording.',
        'trace.stoppedHint': 'Stopped, curves kept. Pressing Start again discards this ring and begins a new one.',
        'trace.pendingHint': 'Replacing ends the trace that is running now.',
        'trace.pendingReplacing': 'Currently tracing {label}; replacing ends it.',
        'trace.elapsed': 'Recorded {time}',
        'trace.points': '{count} pts',
        'trace.gap': 'gap {gap}s',
        'trace.target': 'Target',
        'trace.cpu': 'CPU',
        'trace.memory': 'Private bytes',
        'trace.handles': 'Handles',
        'trace.threads': 'Threads',
        'trace.io': 'Disk I/O',
        'trace.read': 'Read',
        'trace.write': 'Write',
        'trace.span': 'Last {span}',
        'trace.spanSeconds': '{count} s',
        'trace.spanMinutes': '{count} min',
        'trace.spanHours': '{count} h',
        'trace.fit': 'All',
        'trace.zoomHint': 'Drag to pan · double-click for live',
        'trace.overviewHint': 'Whole ring: drag the ends to resize, the middle to pan, click to jump, double-click for live',
        'trace.exitedAt': 'Exited {time}',
        'trace.others': '{count} more processes',
        'trace.othersHint': 'These {count} running members are past the send limit, so only their totals are shown (the row does not expand)',
        'trace.noData': 'Waiting for the first sample',
        'trace.badge': 'Recording {label}',
        'trace.members': 'Members {count}',
        'trace.noMembers': 'No member samples yet',
        'trace.railCollapse': 'Collapse the member rail',
        'trace.railExpand': 'Expand the member rail',
        'trace.railResize': 'Drag to resize · double-click to reset',
        'trace.exited': 'Exited {count}',
        'trace.exitedMore': '{count} more that left earlier',
        'trace.backToChart': 'Back to chart',
        'trace.detailIdentity': 'Identity',
        'trace.detailMemoryGroup': 'Memory',
        'trace.detailUsage': 'Handles / threads / I/O',
        'trace.detailName': 'Name',
        'trace.detailImage': 'Image',
        'trace.detailPid': 'PID',
        'trace.detailParent': 'Parent PID',
        'trace.detailGroup': 'Group',
        'trace.detailCreated': 'Created',
        'trace.detailRuntime': 'Running for',
        'trace.detailFirst': 'First seen',
        'trace.detailWatched': 'Watched for',
        'trace.detailPeak': 'Peak',
        'trace.detailPeakAt': 'peak {value}',
        'trace.detailAverage': 'Average',
        'trace.readRate': 'Read rate',
        'trace.writeRate': 'Write rate',
        'trace.detailExitedHint': 'An exited process only has the numbers it left with.',
      },
    }

    /**
     * Styles rendered as one style element inside the page, scoped under
     * `.ss-panel` so nothing leaks into the GUI. Colors ride the `--dsw-*`
     * tokens, so the page follows the active light/dark theme.
     */
    const CSS = `
.ss-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
  padding: 14px 16px 16px;
  gap: 10px;
  /* The context menu is absolutely positioned against this panel: container-type
     already makes it a containing block, and viewport coordinates would land
     the menu somewhere else entirely. */
  position: relative;
  background: var(--dsw-alias-bg-base, transparent);
  color: var(--dsw-alias-label-primary, inherit);
  font-family: var(--dsw-font-family, inherit);
  /* The page is a size container: the performance layout must answer to the
     width of the main column, not to the window (the column is narrower). */
  container-type: inline-size;
}
.ss-panel *, .ss-panel *::before, .ss-panel *::after { box-sizing: border-box; }

.ss-panel .ss-header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
  min-width: 0;
}
.ss-panel .ss-back,
.ss-panel .ss-ghost {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  font-size: 12px;
  font-family: inherit;
  color: var(--dsw-alias-label-primary, inherit);
  background: transparent;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.35));
  border-radius: 8px;
  cursor: pointer;
  white-space: nowrap;
}
.ss-panel .ss-back:hover,
.ss-panel .ss-ghost:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
}
.ss-panel .ss-back-glyph { font-size: 14px; line-height: 1; margin-top: -1px; }
.ss-panel .ss-title {
  margin: 0;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 16px;
  font-weight: 700;
  white-space: nowrap;
  color: var(--dsw-alias-label-primary, inherit);
}
.ss-panel .ss-spacer { flex: 1; }

.ss-panel .ss-tabs {
  display: flex;
  gap: 2px;
  flex: none;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.18));
}
.ss-panel .ss-tab {
  padding: 7px 14px;
  font-size: 13px;
  font-family: inherit;
  color: var(--dsw-alias-label-secondary, rgba(127, 127, 127, 0.9));
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  border-radius: 6px 6px 0 0;
  cursor: pointer;
  white-space: nowrap;
}
.ss-panel .ss-tab:hover {
  color: var(--dsw-alias-label-primary, inherit);
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
}
.ss-panel .ss-tab[data-active] {
  color: var(--dsw-alias-label-primary, inherit);
  font-weight: 600;
  border-bottom-color: var(--dsw-alias-state-business-primary, #3b82f6);
}

.ss-panel .ss-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.ss-panel .ss-fill {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow: hidden;
}
.ss-panel .ss-scroll {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
}
.ss-panel .ss-error {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  flex: none;
  font-size: 12px;
  color: var(--dsw-alias-state-error-primary, #d0553c);
}
.ss-panel .ss-error > span { min-width: 0; overflow-wrap: anywhere; }
.ss-panel .ss-error .ss-ghost { color: inherit; }

.ss-panel .ss-perf {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 14px;
  overflow: hidden;
}
.ss-panel .ss-rail {
  flex: 0 0 224px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
  padding-right: 2px;
}
.ss-panel .ss-rail-title {
  flex: none;
  padding: 0 8px 4px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.75));
}
.ss-panel .ss-rail-card {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
  width: 100%;
  padding: 6px 8px;
  font-family: inherit;
  text-align: left;
  color: inherit;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: pointer;
}
.ss-panel .ss-rail-card:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.1)); }
.ss-panel .ss-rail-card[data-active] {
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.14));
  border-color: var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.18));
}
.ss-panel .ss-rail-thumb {
  display: block;
  flex: none;
  width: 76px;
  height: 46px;
  padding: 3px;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.18));
  border-radius: 3px;
}
.ss-panel .ss-rail-text {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 1px;
}
.ss-panel .ss-rail-name,
.ss-panel .ss-rail-fig,
.ss-panel .ss-rail-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ss-panel .ss-rail-name { font-size: 13px; font-weight: 600; }
.ss-panel .ss-rail-fig {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, rgba(127, 127, 127, 0.9));
  font-variant-numeric: tabular-nums;
}
.ss-panel .ss-rail-sub {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.75));
  font-variant-numeric: tabular-nums;
}

.ss-panel .ss-stage {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  gap: 6px;
}
.ss-panel .ss-stage-head {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  flex: none;
  min-width: 0;
}
.ss-panel .ss-stage-title {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  line-height: 1.2;
  white-space: nowrap;
  color: var(--dsw-alias-label-primary, inherit);
}
.ss-panel .ss-stage-sub {
  flex: 1;
  min-width: 0;
  padding-bottom: 3px;
  overflow: hidden;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, rgba(127, 127, 127, 0.9));
}

.ss-panel .ss-chart {
  display: flex;
  flex: 1;
  min-height: 132px;
  flex-direction: column;
}
.ss-panel .ss-chart-top {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 3px;
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary, rgba(127, 127, 127, 0.9));
}
.ss-panel .ss-chart-max { font-variant-numeric: tabular-nums; }
.ss-panel .ss-chart-body {
  position: relative;
  flex: 1;
  min-height: 0;
  border-left: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.18));
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.18));
}
.ss-panel .ss-chart-body svg {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
}
.ss-panel .ss-chart-note {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 12px;
  text-align: center;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.75));
}
.ss-panel .ss-chart-axis {
  display: flex;
  justify-content: space-between;
  padding-top: 3px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.75));
  font-variant-numeric: tabular-nums;
}

.ss-panel .ss-cores {
  display: flex;
  flex: none;
  gap: 2px;
  height: 26px;
  overflow: hidden;
}
.ss-panel .ss-core {
  position: relative;
  flex: 1;
  min-width: 1px;
  height: 100%;
}
.ss-panel .ss-core::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 1px;
  background: var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.18));
}
.ss-panel .ss-core > i {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  border-radius: 1px;
}

.ss-panel .ss-stage-foot {
  display: flex;
  flex-wrap: wrap;
  gap: 14px 28px;
  flex: none;
  padding-top: 8px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.18));
}
.ss-panel .ss-readouts { display: flex; flex: none; gap: 20px; }
.ss-panel .ss-readout {
  display: flex;
  min-width: 84px;
  flex-direction: column;
  gap: 1px;
}
.ss-panel .ss-readout-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary, rgba(127, 127, 127, 0.9));
}
.ss-panel .ss-readout-dot {
  display: inline-block;
  width: 10px;
  height: 2px;
  border-radius: 1px;
}
.ss-panel .ss-readout-value {
  font-size: 23px;
  font-weight: 600;
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary, inherit);
}
.ss-panel .ss-facts {
  display: grid;
  flex: 1;
  min-width: 0;
  align-content: start;
  gap: 3px 14px;
  /* A bounded label column: an adapter name must not push the values out. */
  grid-template-columns: minmax(0, 40%) minmax(0, 1fr);
  font-size: 12px;
}
.ss-panel .ss-fact-key {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-secondary, rgba(127, 127, 127, 0.9));
}
.ss-panel .ss-fact-val {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-primary, inherit);
  font-variant-numeric: tabular-nums;
}

.ss-panel .ss-volumes {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
}

/* ── disk scan (treemap) ──────────────────────────────────────────────────
   Single level, one map per click. The box is a fixed 1000 × 560 coordinate
   space scaled by percentage, so a resize needs no re-layout and the layout
   math never depends on measured pixels. */
.ss-panel .ss-scan {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
  flex: 1;
}
.ss-panel .ss-scan-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding: 2px 0;
}
.ss-panel .ss-scan-landing {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ss-panel .ss-vol-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 10px;
}
.ss-panel .ss-vol-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.2));
  border-radius: 10px;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.ss-panel .ss-vol-card:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.08));
}
.ss-panel .ss-vol-card-name { font-size: 15px; font-weight: 600; }
.ss-panel .ss-vol-card-num {
  font-size: 12px;
  opacity: 0.75;
  font-variant-numeric: tabular-nums;
}
.ss-panel .ss-vol-card-bar {
  height: 6px;
  border-radius: 3px;
  background: rgba(127, 127, 127, 0.22);
  overflow: hidden;
}
.ss-panel .ss-vol-card-fill {
  display: block;
  height: 100%;
  background: #2f6feb;
}
.ss-panel .ss-vol-card-fill[data-warn='warn'] { background: #c08a1e; }
.ss-panel .ss-vol-card-fill[data-warn='error'] { background: #b3553c; }
.ss-panel .ss-scan-path {
  display: flex;
  gap: 8px;
  align-items: center;
}
.ss-panel .ss-scan-path input {
  flex: 1;
  min-width: 0;
  font: inherit;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.3));
  background: none;
  color: inherit;
}
.ss-panel .ss-scan-resume {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.ss-panel .ss-scan-back {
  padding: 0 8px;
  font-size: 14px;
  line-height: 1;
}
.ss-panel .ss-scan-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
}
.ss-panel .ss-scan-bar select,
.ss-panel .ss-scan-bar button {
  font: inherit;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.3));
  background: var(--dsw-alias-bg-layer-2, transparent);
  color: var(--dsw-alias-label-primary, inherit);
}
.ss-panel .ss-scan-crumbs {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  min-height: 20px;
}
.ss-panel .ss-scan-crumb-list {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  min-width: 0;
}
/* Size and share of the current folder: the one number the map cannot show,
   kept on the breadcrumb row instead of a separate status line. */
.ss-panel .ss-scan-sum {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  white-space: nowrap;
  color: var(--dsw-alias-label-secondary, rgba(127, 127, 127, 0.9));
  font-variant-numeric: tabular-nums;
}
.ss-panel .ss-scan-crumb {
  font: inherit;
  font-size: 12px;
  padding: 1px 4px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--dsw-alias-label-secondary, rgba(127, 127, 127, 0.9));
  cursor: pointer;
}
.ss-panel .ss-scan-crumb:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12)); }
.ss-panel .ss-scan-crumb[data-current='true'] { color: var(--dsw-alias-label-primary, inherit); font-weight: 600; }
.ss-panel .ss-scan-sep { color: var(--dsw-alias-label-secondary, rgba(127, 127, 127, 0.6)); }
.ss-panel .ss-scan-map {
  position: relative;
  flex: 1 1 auto;
  min-height: 240px;
  contain: strict;
  overflow: hidden;
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, 0.08));
  user-select: none;
}
.ss-panel .ss-scan-cell {
  position: absolute;
  padding: 0;
  border: 1px solid rgba(0, 0, 0, 0.42);
  border-radius: 2px;
  overflow: hidden;
  color: #fff;
  text-align: left;
  cursor: pointer;
  font: inherit;
  /* A lit top edge is the cheap half of SpaceSniffer's cushion: with one hue for
     every folder, this is what keeps two neighbours from reading as one field. */
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.16);
  background-clip: padding-box;
  transition: box-shadow 140ms ease;
}
.ss-panel .ss-scan-cell:hover {
  box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.16);
  z-index: 1;
}
.ss-panel .ss-scan-cell[data-selected='true'] {
  outline: 2px solid var(--dsw-alias-label-primary, #fff);
  outline-offset: -2px;
  z-index: 2;
}
.ss-panel .ss-scan-label {
  display: block;
  padding: 2px 4px;
  font-size: 11px;
  line-height: 1.25;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
  pointer-events: none;
  min-width: 0;
}
.ss-panel .ss-scan-name {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ss-panel .ss-scan-size {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ss-panel .ss-scan-size { opacity: 0.85; font-variant-numeric: tabular-nums; }
.ss-panel .ss-scan-info {
  font-size: 12px;
  min-height: 18px;
  color: var(--dsw-alias-label-secondary, rgba(127, 127, 127, 0.9));
  font-variant-numeric: tabular-nums;
}
.ss-panel .ss-scan-muted { opacity: 0.7; }
/* Coverage: how much of the volume's used bytes the scan actually saw. */
.ss-panel .ss-scan-coverage { display: flex; flex-direction: column; gap: 4px; padding: 0 12px 6px; }
.ss-panel .ss-scan-coverage-track {
  height: 4px; border-radius: 2px; overflow: hidden;
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.18));
}
.ss-panel .ss-scan-coverage-fill {
  height: 100%; border-radius: 2px;
  background: var(--dsw-alias-brand-primary, currentColor);
}
.ss-panel .ss-scan-coverage-text { display: flex; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.ss-panel .ss-scan-chip {
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.3));
  font-size: 11px;
  opacity: 0.85;
}
/* The clicked cell expanding over the new level: the "you went in" motion. */
.ss-panel .ss-scan-flip {
  position: absolute;
  border-radius: 3px;
  pointer-events: none;
  animation: ss-scan-flip 240ms cubic-bezier(0.2, 0.7, 0.2, 1) forwards;
}
@keyframes ss-scan-flip {
  from {
    left: var(--flip-x);
    top: var(--flip-y);
    width: var(--flip-w);
    height: var(--flip-h);
    opacity: 0.85;
  }
  to {
    left: 0;
    top: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
  }
}
.ss-panel .ss-scan-map[data-entering='true'] { animation: ss-scan-in 220ms cubic-bezier(0.2, 0.7, 0.2, 1); }
@keyframes ss-scan-in {
  from { opacity: 0.45; transform: scale(1.012); }
  to { opacity: 1; transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .ss-panel .ss-scan-flip { animation: none; display: none; }
  .ss-panel .ss-scan-map[data-entering='true'] { animation: none; }
}

.ss-panel .ss-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.18));
  border-radius: 10px;
}

@container (max-width: 560px) {
  .ss-panel .ss-perf { flex-direction: column; gap: 8px; }
  .ss-panel .ss-rail {
    flex: none;
    flex-direction: row;
    gap: 6px;
    padding: 0 0 2px;
    overflow-x: auto;
    overflow-y: hidden;
  }
  .ss-panel .ss-rail-title { display: none; }
  .ss-panel .ss-rail-card { width: 200px; }
}

.ss-panel .ss-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, rgba(127, 127, 127, 0.9));
  font-variant-numeric: tabular-nums;
}
/* Machine-wide totals above the process table: Task Manager's header band. The
   numbers are the page's one "big" type, because they are what the table is read
   against; the counts on the right drop back to body size. */
.ss-panel .ss-totals {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  flex: none;
  min-width: 0;
}
.ss-panel .ss-totals-grid {
  display: flex;
  align-items: flex-end;
  gap: 26px;
  flex-wrap: wrap;
  min-width: 0;
}
.ss-panel .ss-total {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 64px;
}
.ss-panel .ss-total-label {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.75));
}
.ss-panel .ss-total-value {
  font-size: 17px;
  font-weight: 600;
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary, inherit);
}
.ss-panel .ss-totals-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
  margin-left: auto;
  text-align: right;
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.75));
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.ss-panel .ss-chip {
  padding: 3px 10px;
  font-size: 12px;
  font-family: inherit;
  color: var(--dsw-alias-label-secondary, rgba(127, 127, 127, 0.9));
  background: transparent;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.18));
  border-radius: 999px;
  cursor: pointer;
  white-space: nowrap;
}
.ss-panel .ss-chip:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12)); }
.ss-panel .ss-chip[data-active] {
  color: var(--dsw-alias-state-business-primary, #3b82f6);
  border-color: var(--dsw-alias-state-business-primary, #3b82f6);
  font-weight: 600;
}

.ss-panel .ss-table-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.18));
  border-radius: 10px;
}
.ss-panel .ss-table {
  width: 100%;
  /* Fixed layout is what makes a dragged width stick: the columns are driven by
     the colgroup, not by the widest cell in each column. */
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 12.5px;
}
.ss-panel .ss-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  /* A taller, larger header than the body: Task Manager's column row reads as a
     band, not as another row of data. */
  padding: 11px 12px;
  text-align: left;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  color: var(--dsw-alias-label-secondary, rgba(127, 127, 127, 0.9));
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.06));
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.18));
}
/* Task Manager's list draws the column rules only — a horizontal line under every
   one of 40 rows turns the table into a form. The header keeps its bottom rule and
   the pinned block keeps its own divider. The :not(:last-child) keeps the filler
   column (which absorbs leftover width after a drag) free of a rule. */
.ss-panel .ss-table td {
  padding: 6px 10px;
}
.ss-panel .ss-table td:not(:last-child),
.ss-panel .ss-table th:not(:last-child) {
  border-right: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.3));
}
.ss-panel .ss-filler { padding: 0; border: 0; }
/* Column resize handle: a thin strip on the header's right edge, invisible until
   the pointer is on it. */
.ss-panel .ss-col-resize {
  position: absolute;
  top: 0;
  right: -4px;
  bottom: 0;
  z-index: 2;
  width: 9px;
  cursor: col-resize;
  touch-action: none;
}
.ss-panel .ss-col-resize::after {
  content: '';
  position: absolute;
  top: 22%;
  bottom: 22%;
  left: 4px;
  width: 1px;
  background: var(--dsw-alias-state-business-primary, #3b82f6);
  opacity: 0;
}
.ss-panel .ss-col-resize:hover::after,
.ss-panel .ss-table-wrap[data-resizing] .ss-col-resize::after { opacity: 0.75; }
.ss-panel .ss-table-wrap[data-resizing] { cursor: col-resize; user-select: none; }
.ss-panel .ss-table tbody tr:hover td { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12)); }
.ss-panel .ss-table tbody tr[data-self] td { font-weight: 600; }
.ss-panel .ss-table .num { text-align: right; font-variant-numeric: tabular-nums; }
/* A max-width on a table cell is inert (CSS 2.1 §17.5.2 ignores it), so the name
   cap sits on the text itself — the one shrinkable item in the row. */
.ss-panel .ss-table .ss-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ss-panel .ss-muted { color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.75)); }

.ss-panel .ss-hint {
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.75));
}
/* Rows are the hit target for the pin; text selection would fight the double click. */
.ss-panel .ss-table tbody { user-select: none; }
.ss-panel .ss-table tbody tr { touch-action: manipulation; }
.ss-panel .ss-table th[aria-sort='ascending'],
.ss-panel .ss-table th[aria-sort='descending'] {
  color: var(--dsw-alias-label-primary, inherit);
}
.ss-panel .ss-th-sort {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.ss-panel .ss-th-sort:hover { color: var(--dsw-alias-state-business-primary, #3b82f6); }
.ss-panel .ss-arrow { font-size: 8px; line-height: 1; }
.ss-panel .ss-table th[aria-sort='ascending'] .ss-arrow,
.ss-panel .ss-table th[aria-sort='descending'] .ss-arrow {
  color: var(--dsw-alias-state-business-primary, #3b82f6);
}
.ss-panel .ss-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.ss-panel .ss-name-text {
  min-width: 0;
  /* No max-width: the column has its own width now (fixed layout + drag), so the
     text truncates at the column edge instead of at an arbitrary 320 px. */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 16 px app icon. The fallback is our own "window" glyph rather than a letter:
   Windows hands out its generic application icon for System32 processes (a white
   window), so the placeholder has to read as the same family — and a client SVG
   is the only version that also holds on a platform whose icons we do not have. */
.ss-panel .ss-icon {
  flex: none;
  width: 16px;
  height: 16px;
  border-radius: 3px;
  object-fit: contain;
  image-rendering: auto;
}
.ss-panel .ss-icon-generic {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  user-select: none;
}
.ss-panel .ss-toggle {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.75));
  cursor: pointer;
}
.ss-panel .ss-toggle svg { transition: transform 120ms ease; }
.ss-panel .ss-toggle[aria-expanded='true'] svg { transform: rotate(90deg); }
.ss-panel .ss-toggle:hover { color: var(--dsw-alias-label-primary, inherit); }
.ss-panel .ss-toggle-ghost { cursor: default; }
@media (prefers-reduced-motion: reduce) {
  .ss-panel .ss-toggle svg { transition: none; }
}
/* The pin lives at the end of the name row, not in a column of its own: a
   leading pin column left an empty slot in front of every icon, which read as a
   missing value. The button keeps its width while hidden, so revealing it on
   hover cannot shift the name. 18 px tall on purpose — a 20 px box would be the
   tallest thing in the row and add ~1 px to every row (40 rows) for nothing. */
.ss-panel .ss-pin {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-left: 2px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: none;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.75));
  opacity: 0;
  cursor: pointer;
}
.ss-panel .ss-pin svg {
  display: block;
  /* A pin you stick in at an angle; 12 px rotated by 35° stays inside the 18 px
     button (12 × (cos 35° + sin 35°) ≈ 16.6 px). The sign is the tilt direction:
     the head leans right and the needle points down-left (左倾). */
  transform: rotate(35deg);
}
.ss-panel .ss-pin:focus-visible,
.ss-panel .ss-table tbody tr:hover .ss-pin,
.ss-panel .ss-table tbody tr[data-pinned] .ss-pin { opacity: 1; }
.ss-panel .ss-pin:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12)); }
.ss-panel .ss-pin[aria-pressed='true'] { color: var(--dsw-alias-state-business-primary, #3b82f6); }
.ss-panel .ss-count {
  flex: none;
  font-size: 11px;
  font-weight: 400;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.75));
}
.ss-panel .ss-tag {
  flex: none;
  padding: 0 5px;
  font-size: 10px;
  font-weight: 400;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.75));
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.18));
  border-radius: 4px;
}
.ss-panel .ss-table tbody tr[data-pinned] td:first-child {
  box-shadow: inset 2px 0 0 var(--dsw-alias-state-business-primary, #3b82f6);
}
.ss-panel .ss-table tbody tr[data-pin-last] td {
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.28));
}
.ss-panel .ss-table tbody tr[data-lost] td {
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.75));
}
.ss-panel .ss-table tbody tr[data-group] .ss-name-text { font-weight: 600; }
/* Expanded children, nested like Task Manager's: one caret step in from the
   group's own icon (10 px cell padding + 18 px caret + 6 px gap + 18 px step),
   then the child's icon, then its text. The old 34 px sat *left* of the parent's
   name, so the disclosure arrow pointed at a row that started before it. */
.ss-panel .ss-sub-row .ss-name { padding-left: 52px; }
.ss-panel .ss-sub-row .ss-name-text {
  font-weight: 400;
  color: var(--dsw-alias-label-secondary, rgba(127, 127, 127, 0.9));
}
/* The row-level data-self rule only sets font-weight on the cells and relies on
   inheritance; the explicit 400 below wins, which left DSH's own child rows with
   a thin name and bold numbers. Restore the intent one level down. */
.ss-panel .ss-sub-row[data-self] .ss-name-text {
  font-weight: 600;
  color: var(--dsw-alias-label-primary, inherit);
}
/* The executable name behind the description: only shown when it differs from
   the group's own image, i.e. when it actually distinguishes this child. It is
   allowed to shrink so a narrow column truncates the suffix before the
   description — the description is the primary label. */
.ss-panel .ss-sub-exe {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 40%;
  overflow: hidden;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.75));
}

.ss-panel .ss-empty {
  padding: 12px 0;
  font-size: 13px;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.75));
}
.ss-panel .ss-vol { gap: 5px; }
.ss-panel .ss-vol-head { display: flex; align-items: baseline; gap: 8px; }
.ss-panel .ss-vol-name { flex: 1; font-size: 13px; font-weight: 600; }
.ss-panel .ss-vol-fig {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, rgba(127, 127, 127, 0.9));
  font-variant-numeric: tabular-nums;
}
.ss-panel .ss-vol-foot {
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.75));
  font-variant-numeric: tabular-nums;
}
.ss-panel .ss-bar {
  height: 6px;
  border-radius: 3px;
  overflow: hidden;
  background: var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.18));
}
.ss-panel .ss-bar > span {
  display: block;
  height: 100%;
  background: var(--dsw-alias-state-business-primary, #3b82f6);
}
.ss-panel .ss-bar[data-level='warn'] > span { background: var(--dsw-alias-state-warn-primary, #d97706); }
.ss-panel .ss-bar[data-level='danger'] > span { background: var(--dsw-alias-state-error-primary, #d0553c); }

.ss-panel .ss-degraded {
  flex: none;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.75));
}
.ss-panel .ss-degraded .ss-degraded-field { font-weight: 600; margin-right: 2px; }

/* ── trace ─────────────────────────────────────────────────────────────── */
.ss-panel .ss-trace { display: flex; flex-direction: column; gap: 10px; min-height: 0; flex: 1; }
.ss-panel .ss-trace-empty {
  margin: auto;
  max-width: 420px;
  text-align: center;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.75));
}
.ss-panel .ss-trace-empty-title { font-size: 14px; font-weight: 600; margin-bottom: 6px; }
.ss-panel .ss-trace-empty-hint { font-size: 12px; line-height: 1.6; }
.ss-panel .ss-trace-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex: none; }
.ss-panel .ss-trace-title { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.ss-panel .ss-trace-name {
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ss-panel .ss-trace-state {
  flex: none;
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.22));
  color: var(--dsw-alias-label-secondary, rgba(127, 127, 127, 0.9));
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.1));
}
.ss-panel .ss-trace-state[data-recording] {
  color: var(--dsw-alias-state-error-primary, #d0553c);
  border-color: transparent;
  background: rgba(208, 85, 60, 0.16);
}
.ss-panel .ss-trace-elapsed {
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.75));
  font-variant-numeric: tabular-nums;
}
.ss-panel .ss-trace-actions { flex: none; display: flex; align-items: center; gap: 8px; }
.ss-panel .ss-trace-start {
  padding: 5px 12px;
  border: 0;
  border-radius: 6px;
  /* The theme's own filled-button pair. --dsw-alias-label-on-color is only ever
     *used* by the app, never defined, so its #fff fallback put white text on the
     near-white brand fill in dark mode — an invisible button. The foreground
     token flips with the theme exactly like the fill does. */
  background: var(--dsw-alias-button-primary-fill, #3b82f6);
  color: var(--dsw-alias-label-primary-foreground, #fff);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}
.ss-panel .ss-trace-start:hover { background: var(--dsw-alias-button-primary-hover, #2f6fd0); }
.ss-panel .ss-trace-hint {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.8));
}
.ss-panel .ss-trace-hint > span { min-width: 0; }
/* Rail + divider + stage. The rail column is a custom property so a drag can
   move it without React re-rendering the whole page; the container query below
   still gets to flatten the row on a narrow panel. */
.ss-panel .ss-trace-main {
  display: grid;
  grid-template-columns: var(--ss-rail-w, 240px) 7px minmax(0, 1fr);
  column-gap: 2px;
  min-height: 0;
  flex: 1;
}
/* Folded: the tab keeps its 24 px, the stage takes the rest. */
.ss-panel .ss-trace-main[data-collapsed] { grid-template-columns: 24px minmax(0, 1fr); }
.ss-panel .ss-trace-rail {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding-right: 6px;
}
/* The grab handle between rail and stage: a hairline that lights up, over a
   7 px hit area — the line alone was too thin to catch. */
.ss-panel .ss-trace-divider {
  position: relative;
  align-self: stretch;
  cursor: col-resize;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
.ss-panel .ss-trace-divider::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 1px;
  margin-left: -0.5px;
  border-radius: 1px;
  background: var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.18));
}
.ss-panel .ss-trace-divider:hover::before,
.ss-panel .ss-trace-divider[data-dragging]::before {
  width: 2px;
  margin-left: -1px;
  background: var(--dsw-alias-state-business-primary, #3b82f6);
}
.ss-panel .ss-trace-rail-head {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 2px 6px 4px;
  background: var(--dsw-alias-bg-base, transparent);
}
.ss-panel .ss-trace-rail-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.75));
}
/* One button, one job: fold the rail away. The tab it becomes is the way back. */
.ss-panel .ss-trace-rail-toggle {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: none;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.75));
  font-family: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}
.ss-panel .ss-trace-rail-toggle:hover,
.ss-panel .ss-trace-rail-toggle:focus-visible {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
  color: var(--dsw-alias-label-primary, inherit);
}
.ss-panel .ss-trace-rail-empty {
  padding: 8px 4px;
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.75));
}
/* A row is a lens, not a decision: clicking it only moves what the stage shows.
   The left edge carries the focus mark, so the current one is findable at a
   glance without a second colour system. */
.ss-panel .ss-trace-row {
  flex: none;
  padding: 4px 4px 4px 5px;
  border-left: 2px solid transparent;
  border-radius: 6px;
  cursor: pointer;
  min-width: 0;
}
.ss-panel .ss-trace-row:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.08));
}
.ss-panel .ss-trace-row:focus-visible {
  outline: 1px solid var(--dsw-alias-state-business-primary, #3b82f6);
  outline-offset: -1px;
}
.ss-panel .ss-trace-row[data-focus] {
  border-left-color: var(--dsw-alias-state-business-primary, #3b82f6);
  background: rgba(59, 130, 246, 0.1);
}
.ss-panel .ss-trace-row-line { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.ss-panel .ss-trace-row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
}
.ss-panel .ss-trace-row-group .ss-trace-row-name { font-weight: 600; }
.ss-panel .ss-trace-row-count {
  flex: none;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.8));
  font-variant-numeric: tabular-nums;
}
.ss-panel .ss-trace-row-cpu { flex: none; font-size: 12px; font-variant-numeric: tabular-nums; }
.ss-panel .ss-trace-row-sub {
  margin-top: 2px;
  font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.75));
  font-variant-numeric: tabular-nums;
}
.ss-panel .ss-trace-row-sub > span { white-space: nowrap; }
.ss-panel .ss-trace-row-child { padding-top: 3px; padding-bottom: 3px; }
.ss-panel .ss-trace-row-child .ss-trace-row-name { font-size: 12px; }
.ss-panel .ss-trace-row-others { cursor: default; }
.ss-panel .ss-trace-row-more {
  cursor: default;
  padding: 4px 4px 4px 7px;
  font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.75));
}
/* A group's members: indented under the header, capped at roughly eight rows so
   a group with dozens of members scrolls instead of pushing everything down. */
.ss-panel .ss-trace-children {
  margin-left: 9px;
  padding-left: 3px;
  border-left: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.2));
  max-height: 300px;
  overflow: auto;
}
/* Exited members: their own block, folded by default. */
.ss-panel .ss-trace-exited {
  flex: none;
  margin-top: 6px;
  padding-top: 4px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.18));
}
.ss-panel .ss-trace-exited-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.85));
  font-family: inherit;
  font-size: 11px;
  text-align: left;
  cursor: pointer;
}
.ss-panel .ss-trace-exited-head:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.08));
  color: var(--dsw-alias-label-primary, inherit);
}
.ss-panel .ss-trace-exited-caret { margin-left: auto; font-size: 9px; }
/* Departed is past tense: the row stays readable but stops competing with the
   live ones for attention. */
.ss-panel .ss-trace-row-exited { opacity: 0.6; }
.ss-panel .ss-trace-member-exit { margin-left: auto; white-space: nowrap; }
/* Narrow rail: names only. A 140 px column cannot fit a number without cutting
   the name, and the name is what tells two rows apart. */
.ss-panel .ss-trace-rail[data-narrow] .ss-trace-row-cpu,
.ss-panel .ss-trace-rail[data-narrow] .ss-trace-row-count,
.ss-panel .ss-trace-rail[data-narrow] .ss-trace-row-sub {
  display: none;
}
/* The folded rail: one button, ~24 px, vertical text. It must always be there —
   it is the only way back from the folded state. */
.ss-panel .ss-trace-rail-tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 24px;
  height: 100%;
  min-height: 0;
  padding: 6px 0;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.2));
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.05));
  color: var(--dsw-alias-label-secondary, rgba(127, 127, 127, 0.9));
  font-family: inherit;
  cursor: pointer;
  overflow: hidden;
}
.ss-panel .ss-trace-rail-tab:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
  color: var(--dsw-alias-label-primary, inherit);
}
.ss-panel .ss-trace-tab-arrow { font-size: 11px; line-height: 1; }
.ss-panel .ss-trace-tab-glyph {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  background: rgba(59, 130, 246, 0.18);
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 10.5px;
  font-weight: 600;
}
.ss-panel .ss-trace-tab-label {
  writing-mode: vertical-rl;
  text-orientation: mixed;
  max-height: 100%;
  overflow: hidden;
  font-size: 11px;
  letter-spacing: 0.04em;
}
.ss-panel .ss-trace-tab-count {
  flex: none;
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.8));
}
.ss-panel .ss-trace-stage {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  min-height: 0;
  /* Never sideways: the column is exactly as wide as the plot, and anything
     drawing outside it (a handle overhang, a drag bubble at the end of the
     track) must not turn into a second scrollbar under the range bar. */
  overflow-x: hidden;
  overflow-y: auto;
  /* The charts are dragged with the pointer: without this the browser scrolls
     the stage instead of panning the window. */
  touch-action: none;
  cursor: grab;
}
/* The detail table replaced the charts, so the pan gestures are gone with them. */
.ss-panel .ss-trace-stage[data-detail] {
  cursor: default;
  touch-action: auto;
}
.ss-panel .ss-trace-detail {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.ss-panel .ss-trace-detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.ss-panel .ss-trace-detail-title {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.ss-panel .ss-trace-detail-name {
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ss-panel .ss-trace-detail-image,
.ss-panel .ss-trace-detail-pid {
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.8));
  font-variant-numeric: tabular-nums;
}
.ss-panel .ss-trace-detail-exit {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 9px;
  background: rgba(127, 127, 127, 0.14);
  color: var(--dsw-alias-label-secondary, rgba(127, 127, 127, 0.9));
  font-variant-numeric: tabular-nums;
}
.ss-panel .ss-trace-detail-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.ss-panel .ss-trace-detail-table th,
.ss-panel .ss-trace-detail-table td {
  padding: 4px 8px;
  text-align: left;
  vertical-align: baseline;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.14));
}
.ss-panel .ss-trace-detail-table th[scope='row'] {
  width: 34%;
  max-width: 180px;
  font-weight: 400;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.85));
}
.ss-panel .ss-trace-detail-table tr[data-group] th {
  padding: 12px 8px 4px;
  border-bottom: 0;
  font-size: 10.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.7));
}
.ss-panel .ss-trace-detail-table td.ss-trace-detail-note {
  width: 1%;
  white-space: nowrap;
  text-align: right;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.75));
  font-size: 11px;
}
.ss-panel .ss-trace-detail-hint {
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.8));
}
.ss-panel .ss-trace-charts { display: flex; flex-direction: column; gap: 10px; flex: 1; min-height: 0; }
.ss-panel .ss-trace-chart {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 96px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.18));
  border-radius: 8px;
  padding: 6px 10px 4px;
  min-width: 0;
}
.ss-panel .ss-trace-chart-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.75));
}
.ss-panel .ss-trace-chart-value {
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 13px;
}
.ss-panel .ss-trace-svg {
  display: block;
  width: 100%;
  flex: 1;
  min-height: 64px;
  /* The grid lines are drawn with currentColor; the path keeps its data colour. */
  color: var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.35));
}
/* The charts carry the grid, the range bar under them carries the clock: one
   axis for the block, directly under the plot it labels. */
/* The range bar: the whole ring as a track, the window as its thumb, and four
   clock labels under it. It is a time bar, not a chart — the CPU line that used
   to run under the thumb answered a question nobody asked of a scrubber. It is
   the last row of the chart column, so it is exactly as wide as the plots above
   it: the bar is their clock, not a page-level slider. */
/* The range bar borrows the platform's horizontal scrollbar shape — a thin
   rounded groove with a pill thumb — because that shape already reads as "drag
   me along a range". On top of it sit two grab handles at the thumb's ends: a
   scrollbar alone moves the window, and the window's *length* is the other half
   of the gesture. */
.ss-panel .ss-trace-range {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: none;
  min-width: 0;
  /* It sits inside the stage, which is the pan surface: the bar is a control,
     not part of that gesture. */
  cursor: default;
}
/* No frame and no border: a scrollbar is an object on the surface, not a box
   drawn around data. */
.ss-panel .ss-trace-overview {
  position: relative;
  width: 100%;
  height: 14px;
  border: 0;
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-3, rgba(127, 127, 127, 0.14));
  touch-action: none;
  cursor: pointer;
  /* A drag must not select the labels it passes over. */
  user-select: none;
  -webkit-user-select: none;
  /* Not hidden: the drag bubble sits above it. */
  overflow: visible;
}
/* Nothing to navigate: the thumb fills the track and no gesture applies. */
.ss-panel .ss-trace-overview[data-static] { cursor: default; }
/* "All" is a state worth naming where the span usually sits. */
.ss-panel .ss-trace-chip[data-fit] {
  border-color: var(--dsw-alias-state-business-primary, #3b82f6);
  color: var(--dsw-alias-label-primary, inherit);
}
/* Evenly spaced clock labels under the track, sharing its ends. */
.ss-panel .ss-trace-ticks {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 0 1px;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.75));
}
.ss-panel .ss-trace-ticks > span { white-space: nowrap; }
.ss-panel .ss-trace-ticks > span:first-child { text-align: left; }
.ss-panel .ss-trace-ticks > span:last-child { text-align: right; }
.ss-panel .ss-trace-overview-block {
  position: absolute;
  top: 2px;
  bottom: 2px;
  z-index: 1;
  /* Room for the two handles, and a last-resort guard for a very narrow strip.
     The percent floor lives in the component; this keeps a 3 % thumb wide
     enough to actually grab. */
  min-width: 20px;
  box-sizing: border-box;
  border: 0;
  border-radius: 5px;
  background: rgba(127, 127, 127, 0.42);
  cursor: grab;
  transition: background 110ms ease;
}
.ss-panel .ss-trace-overview-block:hover { background: rgba(127, 127, 127, 0.58); }
/* A full thumb means "not navigable": keep the tint, drop the frame and the
   grab cursor so it does not invite a drag that cannot happen. */
.ss-panel .ss-trace-overview[data-static] .ss-trace-overview-block {
  background: rgba(127, 127, 127, 0.22);
  cursor: default;
}
.ss-panel .ss-trace-overview[data-dragging] .ss-trace-overview-block {
  background: rgba(59, 130, 246, 0.55);
  cursor: grabbing;
}
/* The two ends: 10 px hit areas *inside* the thumb — an overhang would add a
   horizontal scrollbar to the column, which is where we came from — each marked
   by a capsule that is always visible, because a handle you must hover to find
   is the same as no handle. */
.ss-panel .ss-trace-overview-grip {
  position: absolute;
  top: -3px;
  bottom: -3px;
  width: 10px;
  z-index: 2;
  cursor: ew-resize;
  touch-action: none;
}
.ss-panel .ss-trace-overview-grip[data-grip=left] { left: 0; }
.ss-panel .ss-trace-overview-grip[data-grip=right] { right: 0; }
.ss-panel .ss-trace-overview-grip::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: 3px;
  height: 16px;
  margin: -8px 0 0 -1.5px;
  border-radius: 2px;
  background: var(--dsw-alias-label-primary, #1c1f24);
  opacity: 0.7;
  transition: opacity 110ms ease;
}
.ss-panel .ss-trace-overview-grip:hover::after,
.ss-panel .ss-trace-overview[data-dragging] .ss-trace-overview-grip::after { opacity: 1; }
@media (prefers-reduced-motion: reduce) {
  .ss-panel .ss-trace-overview-grip::after,
  .ss-panel .ss-trace-overview-block { transition: none; }
}
.ss-panel .ss-trace-overview-bubble {
  position: absolute;
  top: -21px;
  transform: translateX(-50%);
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.32));
  background: var(--dsw-alias-bg-layer-2, #1c1f24);
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  pointer-events: none;
  z-index: 3;
}
.ss-panel .ss-trace-start:disabled,
.ss-panel .ss-trace .ss-ghost:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.ss-panel .ss-trace-chip-action {
  font-family: inherit;
  cursor: pointer;
  margin-left: auto;
}
.ss-panel .ss-trace-chip-action:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
}
.ss-panel .ss-trace-wait {
  margin: auto;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.75));
}
.ss-panel .ss-trace-info {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  flex: none;
}
.ss-panel .ss-trace-chip {
  font-size: 11.5px;
  padding: 2px 8px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.16));
  color: var(--dsw-alias-label-secondary, rgba(127, 127, 127, 0.9));
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.06));
  font-variant-numeric: tabular-nums;
}
/* A sampler gap is a data fact, not an error: amber, not red. */
.ss-panel .ss-trace-chip[data-gap] {
  color: #c08a1e;
  border-color: color-mix(in srgb, #c08a1e 45%, transparent);
}
/* The "back to live" chip takes the free space in the info row. */

@container (max-width: 720px) {
  /* A narrow panel stacks the rail above the stage; the divider would become a
     full-width row, so the drag is simply not offered there. */
  .ss-panel .ss-trace-main,
  .ss-panel .ss-trace-main[data-collapsed] { grid-template-columns: minmax(0, 1fr); }
  .ss-panel .ss-trace-divider { display: none; }
  .ss-panel .ss-trace-rail {
    max-height: 150px;
    padding-right: 0;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.18));
  }
  /* Stacked, the folded tab turns into a thin bar: vertical text in a 24 px
     wide element would have nowhere to breathe. */
  .ss-panel .ss-trace-rail-tab {
    flex-direction: row;
    width: auto;
    height: 24px;
    padding: 0 8px;
  }
  .ss-panel .ss-trace-tab-label { writing-mode: horizontal-tb; }
}

/* Right-click menu. Absolutely positioned inside the panel — position: fixed
   resolves against the panel's containment box, so viewport coordinates put it
   off-screen. bg-layer-2 is the real token for a raised surface; the previous
   bg-elevated is referenced by the theme but never defined, so its white
   fallback made the menu invisible in dark mode. */
.ss-panel .ss-menu {
  position: absolute;
  z-index: 2147483001;
  min-width: 168px;
  padding: 4px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.32));
  background: var(--dsw-alias-bg-layer-2, #1c1f24);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
}
.ss-panel .ss-menu-item {
  display: block;
  width: 100%;
  padding: 6px 10px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.ss-panel .ss-menu-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12)); }


/* The badge lives outside the .ss-panel scope (shell overlay), so its styles
   are rendered with it rather than in this block. */
`

    /**
     * Badge styles travel with the badge: the shell overlay is mounted even when
     * the panel is closed, so it cannot borrow the panel's `<style>`.
     *
     * Placement is top-right under the title bar. A recording pill has to stay
     * visible while the user works, and it must not cover the composer; if it
     * lands on something in the real window, this is the one place to move it.
     */
    const BADGE_CSS = `
.ss-badge {
  position: fixed;
  top: 62px;
  right: 22px;
  z-index: 2147483000;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.32));
  background: var(--dsw-alias-bg-layer-2, #1c1f24);
  color: var(--dsw-alias-label-primary, inherit);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.24);
  font-size: 12px;
  cursor: pointer;
}
.ss-badge:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.08)); }
.ss-badge-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #d0553c;
  animation: ss-badge-pulse 2s ease-in-out infinite;
}
@keyframes ss-badge-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.ss-badge-text { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ss-badge-time { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.85)); }
`

    /** Replace `{name}` placeholders in one template. */
    function format(template, params) {
      if (!params) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }

    /**
     * Translate through the client locale service, falling back to the bundled
     * Chinese copy when the service is absent or a key is missing.
     *
     * @param ctx - client context (locale service).
     * @returns translate function reading the active language at call time.
     */
    function createTranslate(ctx) {
      let bound = null
      try {
        ctx.effect(() => ctx.locale.register(NS, STRINGS), 'system-sniffer: dictionaries')
        bound = ctx.locale.bind(NS)
      } catch {
        bound = null
      }
      return (key, params) => {
        const fallback = STRINGS.zh[key] ?? key
        if (bound === null) return format(fallback, params)
        let text
        try {
          text = bound(key, params)
        } catch {
          return format(fallback, params)
        }
        return text === key ? format(fallback, params) : text
      }
    }

    /**
     * Fractions are clamped here as well as in the Host: a live page can keep
     * polling an older Host build, and a PDH artifact must never reach the
     * screen as "-0.0%".
     */
    function fmtPct(value) {
      if (value === null || value === undefined || !Number.isFinite(value)) return '—'
      return `${(Math.min(1, Math.max(0, value)) * 100).toFixed(1)}%`
    }

    function fmtBytes(bytes) {
      if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—'
      if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(2)} TB`
      if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
      if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`
      return `${Math.round(bytes / 1024)} KB`
    }

    function fmtRate(bytes) {
      if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—'
      const safe = Math.max(0, bytes)
      if (safe >= 1024 ** 2) return `${(safe / 1024 ** 2).toFixed(1)} MB/s`
      if (safe >= 1024) return `${(safe / 1024).toFixed(0)} KB/s`
      return `${Math.round(safe)} B/s`
    }

    /** `1:23:45` for a trace badge; minutes are enough below an hour. */
    function fmtDuration(ms) {
      const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const seconds = total % 60
      const pad = (value) => String(value).padStart(2, '0')
      return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
    }

    /** Wall-clock `HH:MM:SS` for a member's exit time. */
    function fmtClock(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '—'
      const date = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /** Series a trace carries, in the order the Host sends them. */
    const TRACE_SERIES = ['cpu', 'memory', 'handleCount', 'threadCount', 'ioReadPerSec', 'ioWritePerSec']
    /** Client-side cap on a tail buffer: 1200 points is 20 minutes at 1 Hz. */
    const TRACE_POINTS = 1200
    /** Wider than the tail buffer can hold, so the page asks for buckets instead. */
    const TRACE_TAIL_SPAN = TRACE_POINTS * 1000
    /** How many buckets a range read asks for; min/max doubles the points. */
    const TRACE_BUCKETS = 600
    const TRACE_MIN_SPAN = 60_000
    const TRACE_MAX_SPAN = 8 * 3600_000
    /** Opens on the same window the performance page uses. */
    const TRACE_DEFAULT_SPAN = TRACE_MIN_SPAN
    /** Within a second of the newest point still counts as "following". */
    const TRACE_EDGE_MS = 1000
    /** The strip never shrinks below this on screen; the thumb has to stay grabbable. */
    const TRACE_THUMB_MIN_PCT = 3
    /** The strip is navigable from the first few seconds on; below this it is a flat track. */
    const TRACE_OVERVIEW_MIN = 5000
    /** The member rail: narrowest usable, widest share of the row, and its default. */
    const TRACE_RAIL_MIN = 140
    const TRACE_RAIL_MAX_PCT = 0.45
    const TRACE_RAIL_DEFAULT = 240
    /** Below this width the rows keep only their names (the numbers would be cut off). */
    const TRACE_RAIL_NARROW = 180
    /** Exited members kept on the rail; anything older is only counted. */
    const TRACE_EXITED_LIMIT = 20
    const TRACE_RAIL_STORAGE = 'system-sniffer:trace-rail'

    /** Same target means same pid (process) or same appId (group). */
    function sameTraceTarget(left, right) {
      if (!left || !right) return false
      const leftPid = Number.isInteger(left.pid) ? left.pid : null
      const rightPid = Number.isInteger(right.pid) ? right.pid : null
      return leftPid === rightPid && (left.appId ?? '') === (right.appId ?? '')
    }

    /**
     * Fold a trace delta into the buffer.
     *
     * A trace read is cursor-based — after the first response each poll carries
     * one point per series. Replacing the buffer with it would leave the chart
     * showing a single second, so an exact continuation is appended; a gap (the
     * tab was closed, or the Host capped a long absence) or a different trace
     * replaces the buffer, because that payload already covers everything the
     * chart can draw.
     *
     * The buffer slides: dropping the oldest point is right here, because a
     * window wider than 20 minutes is a range query, not a longer tail.
     */
    function mergeTrace(previous, incoming) {
      if (!incoming) return previous ?? null
      if (!previous
        || previous.startedAt !== incoming.startedAt
        || previous.target?.appId !== incoming.target?.appId
        || previous.target?.pid !== incoming.target?.pid) {
        return incoming
      }
      const count = incoming.series?.cpu?.length ?? 0
      if (count === 0) {
        // A status-only answer (a preview that just opened, or a ring that was
        // cleared): the points stay as they were, everything else is newer.
        return { ...previous, ...incoming, series: previous.series, t0: previous.t0, dt: previous.dt, times: previous.times }
      }
      if (incoming.seq !== (previous.seq ?? 0) + count) return incoming
      const series = {}
      for (const key of TRACE_SERIES) {
        series[key] = (previous.series?.[key] ?? []).concat(incoming.series?.[key] ?? [])
      }
      // `t0` belongs to the first point actually held. A buffer that is still
      // empty carries a placeholder `0`, and appending the first real points to
      // it must take *their* time — otherwise every x lands off-screen and the
      // chart stays blank while the numbers tick.
      const buffered = previous.series?.cpu?.length ?? 0
      const dt = incoming.dt ?? previous.dt ?? 1000
      let t0 = buffered > 0 ? previous.t0 : incoming.t0
      // `times` is the real time base and has to slide with the series, or every
      // x drifts against the point it belongs to. Only a host that sends it can
      // be merged this way; otherwise the uniform grid stays the fallback.
      let times = null
      if (Array.isArray(previous.times) && previous.times.length === buffered
        && Array.isArray(incoming.times) && incoming.times.length === count) {
        times = previous.times.concat(incoming.times)
      } else if (Array.isArray(incoming.times)) {
        times = incoming.times.slice()
      }
      while (series.cpu.length > TRACE_POINTS) {
        for (const key of TRACE_SERIES) series[key].shift()
        if (times) times.shift()
        t0 += dt
      }
      return { ...incoming, series, t0, dt, times }
    }

    /**
     * What a chart draws: CPU, private bytes and read+write combined, all on one
     * time base (`t0 + i * dt`). Tail and range payloads have different series
     * sets, so both go through here.
     */
    function toTraceChart(trace) {
      if (!trace) return null
      const series = trace.series ?? {}
      const cpu = Array.isArray(series.cpu) ? series.cpu : []
      const memory = Array.isArray(series.memory) ? series.memory : []
      const read = Array.isArray(series.ioReadPerSec) ? series.ioReadPerSec : []
      const write = Array.isArray(series.ioWritePerSec) ? series.ioWritePerSec : []
      const count = Math.max(cpu.length, memory.length, read.length, write.length)
      const io = new Array(count)
      for (let index = 0; index < count; index += 1) {
        const readValue = read[index]
        const writeValue = write[index]
        const hasRead = Number.isFinite(readValue)
        const hasWrite = Number.isFinite(writeValue)
        io[index] = hasRead || hasWrite ? (hasRead ? readValue : 0) + (hasWrite ? writeValue : 0) : null
      }
      return {
        t0: Number.isFinite(trace.t0) ? trace.t0 : 0,
        dt: Number.isFinite(trace.dt) && trace.dt > 0 ? trace.dt : 1000,
        // Real time of each point when the host sends it; the chart prefers it
        // over the uniform grid so a missing second stays a hole in place.
        times: Array.isArray(trace.times) ? trace.times : null,
        cpu,
        memory,
        io,
        coverage: trace.coverage ?? null,
        members: trace.members ?? null,
      }
    }

    /** A span in words: "45 秒" / "1 分钟" / "3 小时". */
    function fmtSpan(ms, t) {
      const seconds = Math.max(1, Math.round(ms / 1000))
      if (seconds < 60) return t('trace.spanSeconds', { count: seconds })
      const minutes = Math.round(seconds / 60)
      if (minutes < 90) return t('trace.spanMinutes', { count: minutes })
      return t('trace.spanHours', { count: Math.round(minutes / 60) })
    }

    /**
     * The window a chart draws, in absolute time.
     *
     * Following means "newest point at the right edge", exactly like the
     * performance page: until the record is as long as the window, the left side
     * is simply empty and the line walks leftwards out of the right edge. Pinning
     * replaces the right edge with a chosen moment, and `spanMs === null` means
     * "all": the window is the ring, whatever the ring currently is.
     */
    function traceBounds(view, coverage, live = false) {
      if (view.spanMs === null) {
        const from = Number.isFinite(coverage?.from) ? coverage.from : 0
        const to = Number.isFinite(coverage?.to) ? coverage.to : 0
        if (to > from) return { from, to }
        // Nothing recorded yet: a minimum window ending now keeps the axis sane.
        const now = to || Date.now()
        return { from: now - TRACE_MIN_SPAN, to: now }
      }
      const span = view.spanMs
      if (view.endAt !== null) return { from: view.endAt - span, to: view.endAt }
      const latest = Number.isFinite(coverage?.to) ? coverage.to : 0
      // A live trace follows the clock, not the newest point: when a second has
      // no sample the window keeps moving and the hole sits where it belongs.
      // A frozen ring has nothing to advance to, so it stops at its last point.
      const to = live ? Math.max(latest, Date.now()) : (latest || Date.now())
      return { from: to - span, to }
    }

    /**
     * The chart viewport. It lives beside the runtime (not in React state) so
     * unmounting the page — switching tabs, opening a session — does not silently
     * reset a zoom the user set. `spanMs: null` is the "all" state.
     */
    function createTraceViewStore() {
      let current = { spanMs: TRACE_DEFAULT_SPAN, endAt: null }
      const listeners = new Set()
      return {
        getSnapshot() { return current },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        set(next) {
          const raw = next?.spanMs === undefined ? current.spanMs : next.spanMs
          const spanMs = raw === null ? null : Math.min(TRACE_MAX_SPAN, Math.max(TRACE_MIN_SPAN, raw))
          // "All" always follows: a pinned right edge would make it not-all.
          const endAt = spanMs === null ? null : (next?.endAt === undefined ? current.endAt : next.endAt)
          if (spanMs === current.spanMs && endAt === current.endAt) return
          current = { spanMs, endAt }
          for (const listener of [...listeners]) listener()
        },
      }
    }

    /** Geometry a previous session left behind; anything invalid falls back. */
    function readStoredRail() {
      const fallback = { width: TRACE_RAIL_DEFAULT, collapsed: false }
      try {
        const parsed = JSON.parse(window.localStorage.getItem(TRACE_RAIL_STORAGE) ?? 'null')
        if (!parsed || typeof parsed !== 'object') return fallback
        const width = Number(parsed.width)
        return {
          width: Number.isFinite(width) && width >= TRACE_RAIL_MIN ? Math.round(width) : fallback.width,
          collapsed: parsed.collapsed === true,
        }
      } catch {
        // No storage (test harness, private mode): the defaults are fine.
        return fallback
      }
    }

    function storeRail(value) {
      try {
        window.localStorage.setItem(TRACE_RAIL_STORAGE, JSON.stringify(value))
      } catch {
        // Private mode / no storage: the rail still moves, it just forgets.
      }
    }

    /**
     * The member rail: how wide it is, whether it is folded into the 24 px tab,
     * and which of its two disclosures are open.
     *
     * Width and the folded state are a preference, so they go to localStorage —
     * a rail the user widened must survive a refresh. The disclosures are
     * deliberately *not* persisted: a fresh look at a trace starts folded, which
     * is what keeps a `svchost (88)` group from eating the whole screen on
     * arrival.
     */
    function createTraceRailStore() {
      let state = { ...readStoredRail(), open: false, exitedOpen: false }
      const listeners = new Set()
      const commit = (next) => {
        if (next.width === state.width && next.collapsed === state.collapsed
          && next.open === state.open && next.exitedOpen === state.exitedOpen) return
        state = next
        for (const listener of [...listeners]) listener()
      }
      /** The two fields worth remembering; a drag writes them on every move. */
      const commitGeometry = (next) => {
        commit(next)
        storeRail({ width: state.width, collapsed: state.collapsed })
      }
      return {
        getSnapshot() { return state },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        /**
         * Clamped at the narrow end here, because that floor is a fact about the
         * row layout; the wide end depends on the panel and is the drag's call.
         */
        setWidth(width) {
          const next = Math.round(Number(width))
          if (!Number.isFinite(next)) return
          commitGeometry({ ...state, width: Math.max(TRACE_RAIL_MIN, next), collapsed: false })
        },
        setCollapsed(collapsed) {
          commitGeometry({ ...state, collapsed: collapsed === true })
        },
        /** Double-click on the divider: back to the default box. */
        reset() {
          commitGeometry({ ...state, width: TRACE_RAIL_DEFAULT, collapsed: false })
        },
        toggleOpen() { commit({ ...state, open: !state.open }) },
        toggleExited() { commit({ ...state, exitedOpen: !state.exitedOpen }) },
        /** Another target is another tree: both disclosures start folded. */
        resetDisclosure() { commit({ ...state, open: false, exitedOpen: false }) },
      }
    }

    /**
     * What the large area is looking at: the whole group, or one member.
     *
     * This is a lens, not a decision — switching it drops nothing and is
     * reversible with one click. Picking a *trace target* stays on the
     * right-click menu in the process page, because that one ends a ring.
     */
    function createTraceFocusStore() {
      let current = { kind: 'group', pid: null }
      const listeners = new Set()
      const commit = (next) => {
        if (next.kind === current.kind && next.pid === current.pid) return
        current = next
        for (const listener of [...listeners]) listener()
      }
      return {
        getSnapshot() { return current },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        group() { commit({ kind: 'group', pid: null }) },
        process(pid) { if (Number.isInteger(pid)) commit({ kind: 'process', pid }) },
        clear() { commit({ kind: 'group', pid: null }) },
      }
    }

    /**
     * One loop, one lease, one window per section.
     *
     * The loop lives here, not in the page component: the layout unmounts a
     * deselected page, and a page that took its own timer with it came back to
     * a broken chart. The runtime outlives every mount, so one loop covers all
     * three tabs and asks only for what the current tab shows.
     */
    function createRuntime(ctx, t) {
      const listeners = new Set()
      const history = { cpu: [], memory: [], gpu: [], net: [], disk: [] }
      /**
       * Real times of the window's points, or `null` when the host says the
       * window is evenly spaced (it only sends them when a gap made it not so).
       */
      const historyTimes = { cpu: null, memory: null, gpu: null, net: null, disk: null }
      // A decaying ceiling for the network sparkline: without it the y axis is
      // recomputed from whatever is currently on screen and the line jumps
      // whenever the busiest sample scrolls out of the window.
      let netCeiling = 0
      let active = true
      let disposed = false
      let timer = null
      let inFlight = false
      let pendingKick = false

      /**
       * App icons: the Host sends an `exeKey` per process and serves PNGs per
       * key. Rows render a blank tile until the key arrives; requests are
       * batched, never blocking the sample loop, and a key that failed once is
       * not retried for the lifetime of the page (an icon is decoration).
       */
      const icons = new Map()
      const iconQueue = new Set()
      const iconFailed = new Set()
      let iconRequest = null

      function base64ToUrl(base64) {
        try {
          const binary = atob(base64)
          const bytes = new Uint8Array(binary.length)
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
          return URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
        } catch {
          return null
        }
      }

      function ensureIcons(items) {
        for (const item of items) {
          const key = item?.exeKey
          if (typeof key !== 'string' || key.length === 0) continue
          if (icons.has(key) || iconFailed.has(key)) continue
          iconQueue.add(key)
        }
        if (iconQueue.size === 0 || iconRequest !== null || disposed) return
        iconRequest = (async () => {
          try {
            while (iconQueue.size > 0 && !disposed) {
              const keys = [...iconQueue].slice(0, 64)
              for (const key of keys) iconQueue.delete(key)
              const response = await fetch('/api/system-sniffer/icons', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ keys }),
                signal: timeoutSignal(15000),
              })
              if (!response.ok) {
                for (const key of keys) iconFailed.add(key)
                return
              }
              const body = await response.json()
              const pngs = body?.pngs ?? {}
              let added = false
              for (const [key, base64] of Object.entries(pngs)) {
                const url = base64ToUrl(base64)
                if (!url) continue
                icons.set(key, url)
                added = true
              }
              for (const key of keys) if (!(key in pngs)) iconFailed.add(key)
              if (added && values && !disposed) publish({ snapshot: values })
            }
          } catch {
            // Icons are decoration: a failed fetch must not surface as an error.
          } finally {
            iconRequest = null
          }
        })()
      }
      // Per-section cursors plus the last values seen. Both live here rather
      // than in the page: a chart rebuilds itself from the Host's window on
      // return, so the page only has to render what it is handed.
      const cursors = {}
      let values = null
      const tabs = createTabStore()
      // Switching tabs changes `include`; without this the table waits for the
      // next 1 s tick — the "blank second" the process page used to show.
      tabs.subscribe(() => kick())
      // Leases are per client id, so two windows can show different tabs.
      const clientId = `sniffer-${Math.random().toString(36).slice(2, 10)}`

      /**
       * Trace status lives beside the sample loop, not in the page: the Host
       * keeps recording while the panel is closed, and two surfaces outside the
       * page — the app-level badge and the rail dot — read it. Two seconds is
       * enough for a clock and a liveness dot.
       */
      const traceListeners = new Set()
      let traceStatus = null
      let traceTimer = null
      /** The window of the trace charts, in the runtime so it survives unmount. */
      const traceView = createTraceViewStore()
      /** Rail geometry and its two disclosures (see `createTraceRailStore`). */
      const traceRail = createTraceRailStore()
      /** The member the large area looks at; the group unless a row was clicked. */
      const traceFocus = createTraceFocusStore()
      /** Key of the last range request, so a frozen trace stops re-fetching. */
      let traceRangeKey = null
      /** The `startedAt` of the ring the viewport was chosen for (see `publishTrace`). */
      let ringStartedAt = 0

      /**
       * A replaced ring has no history inside the old window, so the window is
       * reset instead of inherited.
       *
       * The viewport is deliberately kept across an *unmount* (a zoom must not be
       * silently lost by switching tabs), but a new ring is a different thing: a
       * pinned edge points at a moment the new ring does not contain, and "all"
       * means "the whole ring" — a statement that is now false. Drawn in "all",
       * a brand-new three-point preview fills the entire width and then grows
       * from the left edge rightwards, instead of walking in from the right edge
       * like every fresh trace does: that is the "the chart flipped" report.
       *
       * The span survives (a zoom is a preference); the mode does not.
       */
      function resetTraceView() {
        const view = traceView.getSnapshot()
        traceView.set({
          spanMs: view.spanMs === null ? TRACE_DEFAULT_SPAN : view.spanMs,
          endAt: null,
        })
      }

      function publishTrace(next) {
        traceStatus = next ?? null
        // A ring's start time is the honest test for "this is another ring": a
        // preview that continues into a recording keeps it (no seam, same
        // window), while a swept preview, a replaced target or a cleared trace
        // gets a new one.
        const startedAt = Number.isFinite(traceStatus?.startedAt) ? traceStatus.startedAt : 0
        if (startedAt !== 0 && startedAt !== ringStartedAt) {
          if (ringStartedAt !== 0) resetTraceView()
          ringStartedAt = startedAt
        }
        // A pending pick is only "pending" while the Host still trails behind:
        // the moment it reports the same target, the pick has been applied.
        if (pendingTrace && traceStatus?.target && sameTraceTarget(pendingTrace, traceStatus.target)) {
          pendingTrace = null
        }
        for (const listener of [...traceListeners]) listener()
        // The badge needs a clock even with the panel closed; the page's own
        // poll already carries the status once a second while it is open.
        if (traceStatus?.mode === 'recording') ensureTracePoll()
        else stopTracePoll()
      }

      async function traceCall(payload) {
        const response = await fetch('/api/system-sniffer/trace', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: timeoutSignal(),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body = await response.json()
        if (body?.error) throw new Error(body.error.message)
        return body
      }

      function stopTracePoll() {
        if (traceTimer !== null) clearInterval(traceTimer)
        traceTimer = null
      }

      function ensureTracePoll() {
        if (disposed || traceTimer !== null || traceStatus?.mode !== 'recording') return
        traceTimer = setInterval(() => { void refreshTrace() }, 2000)
      }

      async function refreshTrace() {
        try {
          const body = await traceCall({ action: 'status' })
          publishTrace(body?.trace ?? null)
        } catch {
          // Status is decoration; the page's own banner covers sampling errors.
        }
      }

      /**
       * What the menu picked. Picking a target previews it — no recording, no
       * history — unless something worth keeping is already on screen: a
       * recording, or a frozen ring. Those need the page's confirm buttons.
       */
      let pendingTrace = null

      function selectTraceTarget(target) {
        const chosen = target ?? null
        tabs.set('trace')
        if (!chosen) {
          pendingTrace = null
          kick()
          return
        }
        pendingTrace = chosen
        if (!traceStatus || traceStatus.mode === null || traceStatus.mode === 'preview') {
          void applyTracePreview(chosen).catch(() => {})
          return
        }
        kick()
      }

      function getPendingTrace() { return pendingTrace }

      /**
       * Ask the Host for a preview. A recording outranks a preview there, so a
       * second window cannot steal one; the answer says which it is, and a
       * preview that was not applied keeps the pick pending.
       */
      async function applyTracePreview(target) {
        const chosen = target ?? pendingTrace ?? null
        if (!chosen) return
        const body = await traceCall({ action: 'preview', ...chosen })
        const status = body?.trace ?? null
        const applied = status?.mode === 'preview' && sameTraceTarget(status.target, chosen)
        if (applied) resetTraceData()
        publishTrace(status)
        if (!applied && status?.mode === 'recording') pendingTrace = chosen
        kick()
      }

      /** Drop the buffers a previous target left behind; the next poll refills. */
      function resetTraceData() {
        cursors.trace = 0
        traceRangeKey = null
        // The tree and the focus belong to the old target: another group's shape
        // is news, and its member rows are not this one's rows.
        traceFocus.clear()
        traceRail.resetDisclosure()
        if (!values) return
        values = { ...values, trace: null, traceChart: null }
        publish({ snapshot: values })
      }

      async function startTrace() {
        const chosen = pendingTrace ?? traceStatus?.target ?? null
        if (!chosen) return
        const body = await traceCall({ action: 'start', ...chosen })
        pendingTrace = null
        resetTraceData()
        publishTrace(body?.trace ?? null)
        tabs.set('trace')
        kick()
      }

      async function stopTrace() {
        const body = await traceCall({ action: 'stop' })
        publishTrace(body?.trace ?? null)
        kick()
      }

      /** Clear is global and drops the target too; a recording refuses it. */
      async function clearTrace() {
        const body = await traceCall({ action: 'clear' })
        pendingTrace = null
        resetTraceData()
        publishTrace(body?.trace ?? null)
        kick()
      }

      /** Where the ring actually reaches; the viewport clamps against it. */
      function traceCoverage() {
        const chart = values?.traceChart
        const coverage = chart?.coverage ?? values?.trace?.coverage ?? traceStatus?.coverage
        if (coverage && Number.isFinite(coverage.to) && coverage.to > 0) return coverage
        return { from: 0, to: 0 }
      }

      /**
       * Pin the window. `endAt === null` follows; anything at or past the newest
       * point is the same thing, so it collapses into following. A drag calls
       * this without a refetch and settles once the pointer is up.
       */
      function setTraceWindow(spanMs, endAt, refetch = true) {
        const view = traceView.getSnapshot()
        const requested = spanMs === undefined ? view.spanMs : spanMs
        // `null` is "all": no fixed length, the window is the ring itself. It
        // cannot be pinned — a frozen right edge would stop it being all.
        if (requested === null) {
          traceView.set({ spanMs: null, endAt: null })
          if (refetch) kick()
          return
        }
        const span = Math.min(TRACE_MAX_SPAN, Math.max(TRACE_MIN_SPAN, requested))
        if (endAt === null || !Number.isFinite(endAt)) {
          traceView.set({ spanMs: span, endAt: null })
          if (refetch) kick()
          return
        }
        const coverage = traceCoverage()
        const latest = coverage.to || Date.now()
        const earliest = coverage.from || (latest - TRACE_MAX_SPAN)
        const clamped = Math.min(latest, Math.max(earliest + span - TRACE_EDGE_MS, endAt))
        traceView.set({ spanMs: span, endAt: clamped >= latest - TRACE_EDGE_MS ? null : clamped })
        if (refetch) kick()
      }

      function followTrace() {
        const view = traceView.getSnapshot()
        traceView.set({ spanMs: view.spanMs, endAt: null })
        kick()
      }

      /** From the badge: hand the center column to the panel's last tab. */
      function openTrace() {
        try {
          ctx.layout.selectPanel(PANEL_ID)
        } catch {
          // No layout service: the badge still reports the recording.
        }
        tabs.set('trace')
      }

      // React reads one immutable view; every publish replaces it, so a
      // subscription fires only on a real change.
      let view = { snapshot: null, error: null }
      const viewListeners = new Set()

      try {
        const read = () => ctx.layout.panelInfo.getSnapshot().activePanelId === PANEL_ID
        active = read()
        const dispose = ctx.layout.panelInfo.subscribe(() => {
          const next = read()
          if (next === active) return
          active = next
          if (active) {
            start()
          } else {
            // Leaving the page releases the lease; the Host then applies each
            // section's own life, which is why the chart is still there when
            // the page comes back.
            stop()
            void releaseLease()
          }
          for (const listener of [...listeners]) listener(active)
        })
        ctx.effect(() => () => {
          if (typeof dispose === 'function') dispose()
        }, 'system-sniffer: panel subscription')
      } catch {
        // Without a panel store the loop still runs while the page is visible.
      }

      const publish = (patch) => {
        view = { ...view, ...patch }
        for (const listener of [...viewListeners]) listener()
      }

      /** What the current tab shows; nothing else is asked for. */
      function includeSections() {
        return TAB_SECTIONS[tabs.getSnapshot()] ?? TAB_SECTIONS.performance
      }

      async function request() {
        const response = await fetch('/api/system-sniffer/samples', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ client: clientId, include: includeSections(), since: cursors }),
          signal: timeoutSignal(),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body = await response.json()
        if (body?.error) throw new Error(body.error.message)
        return body
      }

      /** A window instead of a tail: what a zoomed or panned chart asks for. */
      async function rangeRequest(query) {
        const response = await fetch('/api/system-sniffer/trace/range', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(query),
          signal: timeoutSignal(),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body = await response.json()
        if (body?.error) throw new Error(body.error.message)
        return body
      }

      /** Is the trace tab the one asking? Only then is `trace` in `include`. */
      function wantsTrace() {
        return includeSections().includes('trace')
      }

      /**
       * A window wider than the tail buffer, or one that does not end at the
       * newest point, cannot be answered by appending single points. With no
       * trace at all the plain read is cheaper, and it is also how this window
       * learns that another one started a trace.
       */
      function needsRange() {
        if (!traceStatus?.target) return false
        const view = traceView.getSnapshot()
        // "All" always goes through the range read: the ring may be longer than
        // the tail buffer can hold.
        return view.spanMs === null || view.endAt !== null || view.spanMs > TRACE_TAIL_SPAN
      }

      /**
       * The window to ask the Host for. Always explicit `from`/`to`: while the
       * record is still growing into its window the left edge is pinned, so a
       * bare `spanMs` (which the Host anchors at the tail) would put the line
       * back at the right edge.
       */
      function rangeQuery() {
        const view = traceView.getSnapshot()
        const bounds = traceBounds(view, traceCoverage())
        return { from: bounds.from, to: bounds.to, buckets: TRACE_BUCKETS }
      }

      function stop() {
        clearTimeout(timer)
        timer = null
      }

      function schedule(ms = POLL_MS) {
        if (disposed) return
        timer = setTimeout(poll, ms)
      }

      /**
       * Fold one response into what the page renders: values for the cards and
       * the table, windows for the charts. The window is authoritative — it is
       * what the Host actually sampled over the last minute, so the chart never
       * has to guess where a hole was.
       */
      function ingest(body) {
        const merged = { ...(values ?? {}) }
        for (const [id, value] of Object.entries(body.values ?? {})) merged[id] = value
        merged.groups = body.groups ?? merged.groups ?? []
        merged.degraded = Array.isArray(body.degraded) ? body.degraded : []
        merged.intervalMs = 1000
        // A trace read folds in rather than replaces: after the first poll each
        // answer carries only the points after the cursor.
        if (body.trace) {
          merged.trace = mergeTrace(values?.trace, body.trace)
          merged.traceChart = toTraceChart(merged.trace)
          publishTrace(body.trace)
        }
        values = merged
        for (const [id, cursor] of Object.entries(body.seq ?? {})) cursors[id] = cursor
        for (const [id, window] of Object.entries(body.sections ?? {})) {
          const series = CHART_SECTIONS[id]
          if (!series) continue
          history[series] = Array.isArray(window?.v) ? window.v.slice(-HISTORY) : []
          historyTimes[series] = Array.isArray(window?.times) ? window.times.slice(-HISTORY) : null
        }
        const newest = history.net[history.net.length - 1]
        if (typeof newest === 'number') netCeiling = Math.max(newest, netCeiling * 0.97)
        // Fire and forget: the table renders now, icons fill in a moment later.
        ensureIcons(merged.processes?.items ?? [])
        return merged
      }

      /** The range answer carries the status too, so one request covers both. */
      function ingestRange(body) {
        const merged = { ...(values ?? {}) }
        merged.groups = merged.groups ?? []
        merged.degraded = Array.isArray(merged.degraded) ? merged.degraded : []
        merged.intervalMs = 1000
        merged.traceChart = toTraceChart(body)
        values = merged
        publishTrace(body)
        return merged
      }

      /**
       * The range bar needs no payload of its own: it is a map of the ring, and
       * the ring's extent is already in every answer (`coverage`). It used to
       * fetch a bucketed CPU line to draw under the thumb; that line is gone
       * (the bar is a time bar now), so the request went with it.
       */

      /** One turn: schedule the next only after this one settles. */
      async function poll() {
        timer = null
        if (disposed || inFlight) return
        // Nothing to show? Do not ask. The Host's window is what makes the
        // comeback continuous, so an absence costs a cursor, not a chart.
        if (!active || document.visibilityState === 'hidden') return
        inFlight = true
        try {
          // A preview that expired while nobody watched keeps its target, so
          // coming back to this tab is what re-opens it — the page never asks
          // the user to find the group a second time.
          if (wantsTrace() && !pendingTrace && traceStatus?.mode === null && traceStatus?.target) {
            await applyTracePreview(traceStatus.target).catch(() => {})
          }
          const rangeMode = wantsTrace() && needsRange()
          const query = rangeMode ? rangeQuery() : null
          const key = rangeMode
            ? `${query.from ?? ''}:${query.to ?? ''}:${query.spanMs ?? ''}:${query.buckets}`
            : null
          // A stopped trace never grows: re-asking for the same window only burns
          // a request, so a frozen view keeps the answer it has.
          if (rangeMode && key === traceRangeKey && traceStatus?.mode === 'stopped') {
            schedule()
            return
          }
          if (rangeMode) {
            const body = await rangeRequest(query)
            if (disposed) return
            traceRangeKey = key
            publish({ snapshot: ingestRange(body), error: null })
          } else {
            const body = await request()
            if (disposed) return
            traceRangeKey = null
            publish({ snapshot: ingest(body), error: null })
          }
        } catch (failure) {
          if (disposed) return
          publish({ error: String(failure?.message ?? failure) })
        } finally {
          inFlight = false
        }
        if (pendingKick) {
          pendingKick = false
          schedule(0)
        } else {
          schedule()
        }
      }

      /**
       * Pausing is a release, not just a silent tab: one empty request drops
       * this client's lease so finite-lived sections can actually retire.
       */
      async function releaseLease() {
        try {
          await fetch('/api/system-sniffer/samples', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ client: clientId, include: [] }),
            signal: timeoutSignal(3000),
          })
        } catch {
          // The lease TTL will retire it anyway.
        }
      }

      function start() {
        if (disposed || timer !== null || inFlight) return
        void poll()
      }

      /**
       * Ask for the current tab's data now instead of on the next tick. A kick
       * during an in-flight request is remembered and turns into a 0 ms poll,
       * because that response was built for the previous `include`.
       */
      function kick() {
        if (disposed) return
        if (inFlight) {
          pendingKick = true
          return
        }
        stop()
        void poll()
      }

      function dispose() {
        disposed = true
        stop()
        stopTracePoll()
        for (const url of icons.values()) URL.revokeObjectURL(url)
        icons.clear()
      }

      try {
        const onVisibility = () => {
          if (document.visibilityState === 'visible') start()
          else {
            stop()
            void releaseLease()
          }
        }
        document.addEventListener('visibilitychange', onVisibility)
        ctx.effect(() => () => document.removeEventListener('visibilitychange', onVisibility), 'system-sniffer: visibility')
      } catch {
        // No document: the loop then only follows the panel selection.
      }
      ctx.effect(() => () => dispose(), 'system-sniffer: poll loop')

      if (active) start()
      // A page refresh must rediscover a trace the Host is still recording:
      // the status poll only runs while something is actually recording.
      void refreshTrace()

      return {
        t,
        tabs,
        icons,
        focus: createFocusStore(),
        processView: createProcessView(),
        history,
        historyTimes,
        get active() { return active },
        get last() { return view.snapshot },
        get netCeiling() { return netCeiling },
        getView() { return view },
        getTrace() { return traceStatus },
        subscribeTrace(listener) {
          traceListeners.add(listener)
          return () => traceListeners.delete(listener)
        },
        traceView,
        traceRail,
        traceFocus,
        startTrace,
        stopTrace,
        clearTrace,
        applyTracePreview,
        selectTraceTarget,
        getPendingTrace,
        setTraceWindow,
        followTrace,
        openTrace,
        subscribe(listener) {
          viewListeners.add(listener)
          return () => viewListeners.delete(listener)
        },
        onActive(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        /** Hand the center column back to the conversation. */
        close() {
          try {
            ctx.layout.selectPanel(null)
          } catch {
            // Layout service absent: the header control is inert, the page stays.
          }
        },
        /** Resume plus one immediate attempt. */
        retry() {
          publish({ error: null })
          stop()
          start()
        },
      }
    }

    /**
     * Active-tab owner. The layout unmounts a deselected page, so the tab lives
     * here rather than in component state: switching panels and coming back
     * must not reset the page to its first tab.
     */
    function createTabStore() {
      let current = DEFAULT_TAB
      const listeners = new Set()
      return {
        getSnapshot() { return current },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        set(next) {
          if (next === current || !TABS.some((tab) => tab.id === next)) return
          current = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    /**
     * Selected resource in the performance rail. Like the tab store it lives
     * outside React, so leaving the page and coming back keeps the same card
     * open instead of snapping back to CPU.
     */
    function createFocusStore() {
      let current = DEFAULT_FOCUS
      const listeners = new Set()
      return {
        getSnapshot() { return current },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        set(next) {
          if (next === current || !FOCUS_IDS.includes(next)) return
          current = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    /** Peak and mean over the finite samples of one buffer; null when it has none. */
    function seriesStats(values) {
      let peak = null
      let sum = 0
      let count = 0
      for (const value of Array.isArray(values) ? values : []) {
        if (value === null || !Number.isFinite(value)) continue
        if (peak === null || value > peak) peak = value
        sum += value
        count += 1
      }
      return { peak, average: count === 0 ? null : sum / count }
    }

    function hasSeries(values) {
      return Array.isArray(values) && values.some((value) => value !== null && Number.isFinite(value))
    }

    function unique(values) {
      return [...new Set(values)]
    }

    /**
     * Points for one buffer in a 0–100 box.
     *
     * A short run of `null` is connected across: an invalid rate sample is one
     * missing number, not a reason to draw a hole that looks like a broken page.
     * `GAP_BREAK` consecutive nulls (a real outage — the collector was restarted)
     * still split the line, because then there is nothing to draw through.
     *
     * `times`, when the host sends it, puts each point where it happened: the
     * window stays 60 seconds wide and a stall leaves a longer segment instead of
     * squeezing everything after it to the left.
     */
    function plotSeries(values, max, times) {
      const list = Array.isArray(values) ? values : []
      const ceiling = Number.isFinite(max) && max > 0 ? max : 1
      const step = 100 / (HISTORY - 1)
      const offset = Math.max(0, HISTORY - list.length)
      const pad = 2
      const real = Array.isArray(times) && times.length === list.length && list.length > 1
      // The box is always the same window (60 points at 1 s); what changes is
      // where inside it each point sits.
      const span = real ? (HISTORY - 1) * 1000 : 0
      const from = real ? times[times.length - 1] - span : 0
      const segments = []
      let run = []
      let gap = 0
      list.forEach((value, index) => {
        if (value === null || !Number.isFinite(value)) {
          gap += 1
          if (gap >= GAP_BREAK && run.length > 0) {
            segments.push(run)
            run = []
          }
          return
        }
        gap = 0
        const x = real
          ? ((times[index] - from) / span) * 100
          : (offset + index) * step
        run.push({
          x,
          y: 100 - pad - Math.min(1, Math.max(0, value / ceiling)) * (100 - pad * 2),
        })
      })
      if (run.length > 0) segments.push(run)
      return segments
    }

    function linePath(segment) {
      return segment
        .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
        .join(' ')
    }

    function areaPath(segment) {
      const last = segment[segment.length - 1]
      return `${linePath(segment)} L${last.x.toFixed(2)},100 L${segment[0].x.toFixed(2)},100 Z`
    }

    /**
     * The line itself, drawn in a 0–100 box. The parent stretches that box to
     * its own shape (`preserveAspectRatio="none"`), and `non-scaling-stroke`
     * keeps the line 1.5 px wide however far the stretch goes. A lone sample
     * becomes a round-capped dot rather than an invisible path.
     */
    function Shape(props) {
      const accent = props.accent ?? ACCENT.cpu
      const segments = plotSeries(props.values, props.max, props.times)
      const children = []
      if (segments.length === 0) {
        // No sample yet: a hairline floor reads as "empty", a blank box reads
        // as "failed to render".
        children.push(h('path', {
          key: 'baseline',
          d: 'M0,99.5 L100,99.5',
          fill: 'none',
          stroke: accent,
          strokeOpacity: 0.35,
          strokeWidth: 1,
          vectorEffect: 'non-scaling-stroke',
        }))
      }
      if (props.fill === true) {
        segments.forEach((segment, index) => {
          if (segment.length < 2) return
          children.push(h('path', {
            key: `area-${index}`,
            d: areaPath(segment),
            fill: accent,
            fillOpacity: 0.16,
            stroke: 'none',
          }))
        })
      }
      segments.forEach((segment, index) => {
        children.push(h('path', {
          key: `line-${index}`,
          d: linePath(segment),
          fill: 'none',
          stroke: accent,
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          vectorEffect: 'non-scaling-stroke',
        }))
      })
      return h(React.Fragment, null, children)
    }

    /** Rail thumbnail: the same series as the big plot, without the grid. */
    function Sparkline(props) {
      return h('svg', {
        viewBox: '0 0 100 100',
        preserveAspectRatio: 'none',
        width: '100%',
        height: '100%',
        role: 'img',
        'aria-label': props.label,
        style: { display: 'block' },
      }, h(Shape, { values: props.values, max: props.max, accent: props.accent, fill: props.fill, times: props.times }))
    }

    /**
     * A filled level instead of a time series: volume usage has no history to
     * plot, so the disk card shows how full the machine is, not a line.
     */
    function LevelThumb(props) {
      const ratio = Number.isFinite(props.ratio) ? Math.max(0, Math.min(1, props.ratio)) : 0
      return h('svg', {
        viewBox: '0 0 100 100',
        preserveAspectRatio: 'none',
        width: '100%',
        height: '100%',
        role: 'img',
        'aria-label': props.label,
        style: { display: 'block' },
      }, h('rect', {
        x: 0,
        y: 98,
        width: 100,
        height: 2,
        fill: props.accent ?? ACCENT.disk,
        fillOpacity: 0.35,
      }), h('rect', {
        x: 0,
        y: 100 - ratio * 100,
        width: 100,
        height: ratio * 100,
        fill: props.accent ?? ACCENT.disk,
        fillOpacity: 0.55,
      }))
    }

    /** The big plot: Task Manager's fine grid, then the series on top. */
    function TrendChart(props) {
      const grid = []
      for (let index = 1; index < 10; index += 1) {
        grid.push(h('line', {
          key: `v-${index}`,
          x1: index * 10,
          y1: 0,
          x2: index * 10,
          y2: 100,
          stroke: 'var(--dsw-alias-separator-primary, rgba(127, 127, 127, 0.14))',
          strokeWidth: 1,
          vectorEffect: 'non-scaling-stroke',
        }))
      }
      for (let index = 1; index < 4; index += 1) {
        grid.push(h('line', {
          key: `h-${index}`,
          x1: 0,
          y1: index * 25,
          x2: 100,
          y2: index * 25,
          stroke: 'var(--dsw-alias-separator-primary, rgba(127, 127, 127, 0.14))',
          strokeWidth: 1,
          vectorEffect: 'non-scaling-stroke',
        }))
      }
      return h('svg', {
        viewBox: '0 0 100 100',
        preserveAspectRatio: 'none',
        width: '100%',
        height: '100%',
        role: 'img',
        'aria-label': props.label,
      },
      grid,
      h(Shape, { values: props.values, max: props.max, accent: props.accent, fill: props.fill, times: props.times }))
    }

    /** One big number under the plot, with the line's color as a legend tick. */
    function Readout(props) {
      return h('div', { className: 'ss-readout' },
        h('span', { className: 'ss-readout-label' },
          props.accent
            ? h('span', { className: 'ss-readout-dot', style: { background: props.accent } })
            : null,
          props.label),
        h('span', { className: 'ss-readout-value' }, props.value))
    }

    /** Key/value block beside the readouts, like Task Manager's adapter details. */
    function Facts(props) {
      return h('div', { className: 'ss-facts' },
        props.rows.map(([key, value], index) => h(React.Fragment, { key: `${key}-${index}` },
          h('span', { className: 'ss-fact-key', title: key }, key),
          h('span', { className: 'ss-fact-val', title: value }, value))))
    }

    /** One row in the left rail: thumbnail, name, headline figure, sub-line. */
    function RailCard(props) {
      const { item } = props
      return h('button', {
        type: 'button',
        className: 'ss-rail-card',
        'data-active': props.active ? '' : undefined,
        'aria-current': props.active ? 'true' : undefined,
        // The tooltip carries the lines the card has to truncate, and the left
        // accent bar is what actually says "this one is selected".
        title: [item.label, item.railValue, item.railSub].filter(Boolean).join(' · '),
        style: props.active ? { boxShadow: `inset 2px 0 0 ${item.accent}` } : undefined,
        onClick: props.onSelect,
      },
      h('span', { className: 'ss-rail-thumb' },
        item.kind === 'volumes'
          ? h(LevelThumb, { ratio: item.ratio, accent: item.accent, label: item.label })
          : h(Sparkline, {
            values: item.values,
            max: item.max,
            times: item.times,
            accent: item.accent,
            fill: item.fill,
            label: item.label,
          })),
      h('span', { className: 'ss-rail-text' },
        h('span', { className: 'ss-rail-name' }, item.label),
        h('span', { className: 'ss-rail-fig' }, item.railValue),
        h('span', { className: 'ss-rail-sub' }, item.railSub)))
    }

    /**
     * 性能：与 Windows 任务管理器同构——左列五张卡（CPU / 内存 / 磁盘 / 网络 /
     * GPU），右侧是被选中那张的大图、读数与明细。
     *
     * The rail thumbnails and the big plot read the same buffers, so a gap or a
     * scale change looks the same in both. Everything is derived from the
     * snapshot plus those buffers; the two optional Host fields (`cpu.model`,
     * adapter addresses) only enrich the text when an updated Host sends them.
     */
    function buildSections(props) {
      const { snapshot, runtime, t } = props
      const history = runtime.history
      const historyTimes = runtime.historyTimes ?? {}
      const cpu = snapshot?.cpu ?? null
      const memory = snapshot?.memory ?? null
      const gpu = snapshot?.gpu ?? null
      const groups = Array.isArray(snapshot?.groups) ? snapshot.groups : []
      const gpuGroup = groups.find((entry) => entry.id === 'gpu') ?? null
      const coreGroup = groups.find((entry) => entry.id === 'core') ?? null
      const interval = t('perf.seconds', {
        seconds: Math.max(1, Math.round((coreGroup?.intervalMs ?? 1000) / 1000)),
      })
      const interfaces = Array.isArray(snapshot?.network?.items) ? snapshot.network.items : []
      const diskio = snapshot?.diskio ?? null
      const disks = Array.isArray(diskio?.items) ? diskio.items : []

      const cpuStats = seriesStats(history.cpu)
      const memStats = seriesStats(history.memory)
      const netStats = seriesStats(history.net)
      const gpuStats = seriesStats(history.gpu)
      const diskStats = seriesStats(history.disk)
      // A floor keeps an idle disk's axis from being "0 B/s → 0 B/s".
      const diskMax = Math.max(1024, diskStats.peak ?? 0)

      const memLimit = Number.isFinite(memory?.commitLimitBytes) && memory.commitLimitBytes > 0
        ? memory.commitLimitBytes
        : null
      const memUsed = Number.isFinite(memory?.committedBytes) ? memory.committedBytes : null
      const memRatio = memLimit !== null && memUsed !== null
        ? Math.max(0, Math.min(1, memUsed / memLimit))
        : null
      const memMax = memLimit ?? (memStats.peak !== null ? memStats.peak * 1.15 : 1)
      const memAxis = memLimit !== null ? fmtBytes(memLimit) : memStats.peak !== null ? fmtBytes(memMax) : '—'

      const netRx = interfaces.reduce(
        (sum, item) => sum + (Number.isFinite(item.rxBytesPerSec) ? item.rxBytesPerSec : 0),
        0,
      )
      const netTx = interfaces.reduce(
        (sum, item) => sum + (Number.isFinite(item.txBytesPerSec) ? item.txBytesPerSec : 0),
        0,
      )
      // Never below anything still on screen: the ceiling decays, and a label
      // smaller than a visible point would make the axis read wrong.
      const netMax = Math.max(runtime.netCeiling, netStats.peak ?? 0, 1024)
      const netAxis = runtime.netCeiling > 0 || netStats.peak !== null ? fmtRate(netMax) : '—'
      const ipv4 = unique(interfaces.flatMap((item) => item.ipv4 ?? []))
      const ipv6 = unique(interfaces.flatMap((item) => item.ipv6 ?? []))
      const engines = gpu?.engines ? Object.keys(gpu.engines) : []

      const gpuWaiting = gpuGroup?.state === 'unavailable'
        ? t('perf.gpuUnavailable')
        : t('perf.waiting')
      const memoryPair = t('perf.pair', { used: fmtBytes(memUsed), limit: fmtBytes(memLimit) })
      // The percentage is committed-of-limit, not physical memory: say which
      // fraction it is, or the card reads as "RAM in use".
      const memoryCaption = `${t('perf.committed')} ${memoryPair}`

      // Adapter names double as per-interface rate rows when there is more than
      // one: an aggregate readout would otherwise hide which link is busy.
      const netFacts = []
      if (interfaces.length === 1) netFacts.push([t('perf.factAdapter'), interfaces[0].iface])
      if (interfaces.length > 1) {
        for (const item of interfaces) {
          netFacts.push([item.iface, `↓ ${fmtRate(item.rxBytesPerSec)} · ↑ ${fmtRate(item.txBytesPerSec)}`])
        }
      }
      if (ipv4.length > 0) netFacts.push([t('perf.factIpv4'), ipv4.slice(0, 2).join(', ')])
      if (ipv6.length > 0) netFacts.push([t('perf.factIpv6'), ipv6[0]])
      netFacts.push([t('perf.factInterval'), interval])

      return [
        {
          id: 'cpu',
          label: t('perf.cpu'),
          accent: ACCENT.cpu,
          title: t('perf.cpu'),
          subtitle: [cpu?.model, cpu ? t('perf.cores', { count: cpu.logicalCores }) : null]
            .filter(Boolean)
            .join(' · '),
          metric: t('perf.metricCpu'),
          values: history.cpu,
          times: historyTimes.cpu,
          max: 1,
          axisMax: '100%',
          railValue: fmtPct(cpu?.usage),
          railSub: cpu ? t('perf.cores', { count: cpu.logicalCores }) : t('perf.waiting'),
          readouts: [
            { label: t('perf.metricCpu'), value: fmtPct(cpu?.usage), accent: ACCENT.cpu },
            { label: t('perf.peak'), value: fmtPct(cpuStats.peak) },
          ],
          facts: [
            [t('perf.factCores'), cpu ? String(cpu.logicalCores) : '—'],
            [t('perf.average'), fmtPct(cpuStats.average)],
            [t('perf.factInterval'), interval],
            [t('perf.factSource'), t('perf.sourcePdh')],
          ],
          cores: Array.isArray(cpu?.perCore) && cpu.perCore.length > 0 ? cpu.perCore : null,
          empty: !hasSeries(history.cpu),
          emptyText: t('perf.waiting'),
        },
        {
          id: 'memory',
          label: t('perf.memory'),
          accent: ACCENT.memory,
          title: t('perf.memory'),
          subtitle: memLimit !== null ? memoryCaption : null,
          metric: t('perf.metricMemory'),
          values: history.memory,
          times: historyTimes.memory,
          max: memMax,
          fill: true,
          axisMax: memAxis,
          railValue: fmtPct(memRatio),
          railSub: memLimit !== null ? memoryCaption : t('perf.waiting'),
          readouts: [
            { label: t('perf.committed'), value: fmtBytes(memUsed) },
            { label: t('perf.limit'), value: fmtBytes(memLimit) },
          ],
          facts: [
            [t('perf.physicalAvailable'), fmtBytes(memory?.availableBytes)],
            [t('perf.share'), fmtPct(memRatio)],
            [t('perf.factSource'), t('perf.sourcePdh')],
          ],
          empty: !hasSeries(history.memory),
          emptyText: t('perf.waiting'),
        },
        {
          id: 'disk',
          label: t('perf.disk'),
          accent: ACCENT.disk,
          title: t('perf.disk'),
          subtitle: disks.length > 0 ? disks.map((disk) => disk.disk).join('  ') : null,
          metric: t('perf.metricDisk'),
          values: history.disk,
          times: historyTimes.disk,
          max: diskMax,
          // Same guard as the network axis: only claim an axis once there is data,
          // otherwise the label reads "—" beside an empty chart.
          axisMax: diskStats.peak !== null ? fmtRate(diskMax) : '—',
          railValue: fmtRate(diskio?.totalBytesPerSec),
          railSub: diskio
            ? `${t('perf.read')} ${fmtRate(diskio.readBytesPerSec)} · ${t('perf.write')} ${fmtRate(diskio.writeBytesPerSec)}`
            : t('perf.waiting'),
          readouts: [
            { label: t('perf.read'), value: fmtRate(diskio?.readBytesPerSec), accent: ACCENT.disk },
            { label: t('perf.write'), value: fmtRate(diskio?.writeBytesPerSec) },
          ],
          facts: [
            [t('perf.factActive'), fmtPct(diskio?.activeRatio)],
            [t('perf.factDisks'), String(disks.length)],
            [t('perf.factInterval'), interval],
            [t('perf.factSource'), t('perf.sourcePdh')],
          ],
          empty: !hasSeries(history.disk),
          emptyText: t('perf.waiting'),
        },
        {
          id: 'network',
          label: t('perf.network'),
          accent: ACCENT.network,
          title: t('perf.network'),
          subtitle: interfaces.map((item) => item.iface).join(' · '),
          // The rates are summed over every PDH interface instance, so say so
          // when there is more than one: it is not one adapter's page.
          metric: interfaces.length > 1
            ? t('perf.metricThroughputMulti', { count: interfaces.length })
            : t('perf.metricThroughput'),
          values: history.net,
          times: historyTimes.net,
          max: netMax,
          axisMax: netAxis,
          railValue: fmtRate(interfaces.length === 0 ? null : netRx + netTx),
          railSub: interfaces.length === 0
            ? t('perf.waiting')
            : `↓ ${fmtRate(netRx)} · ↑ ${fmtRate(netTx)}`,
          readouts: [
            {
              label: t('perf.send'),
              value: fmtRate(interfaces.length === 0 ? null : netTx),
              accent: ACCENT.network,
            },
            { label: t('perf.receive'), value: fmtRate(interfaces.length === 0 ? null : netRx) },
          ],
          facts: netFacts,
          empty: !hasSeries(history.net),
          emptyText: t('perf.waiting'),
        },
        {
          id: 'gpu',
          label: t('perf.gpu'),
          accent: ACCENT.gpu,
          title: t('perf.gpu'),
          subtitle: gpu !== null
            ? `${t('perf.dedicated')} ${fmtBytes(gpu.dedicatedBytes)}`
            : gpuWaiting,
          metric: t('perf.metricGpu'),
          values: history.gpu,
          times: historyTimes.gpu,
          max: 1,
          axisMax: '100%',
          railValue: gpu ? fmtPct(gpu.utilization) : '—',
          railSub: gpu ? fmtBytes(gpu.dedicatedBytes) : gpuWaiting,
          readouts: [
            { label: t('perf.metricGpu'), value: fmtPct(gpu?.utilization), accent: ACCENT.gpu },
            { label: t('perf.dedicated'), value: fmtBytes(gpu?.dedicatedBytes) },
          ],
          facts: [
            [t('perf.factEngines'), engines.length > 0 ? engines.join(' ') : '—'],
            [t('perf.peak'), fmtPct(gpuStats.peak)],
            [t('perf.factSource'), t('perf.sourcePdh')],
          ],
          empty: !hasSeries(history.gpu),
          emptyText: gpuWaiting,
        },
      ]
    }

    /** 性能页：左列选卡，右侧大图 + 读数 + 明细。 */
    function PerformanceTab(props) {
      const { snapshot, runtime, t } = props
      const focus = useSyncExternalStore(
        runtime.focus.subscribe,
        runtime.focus.getSnapshot,
        runtime.focus.getSnapshot,
      )
      const sections = buildSections({ snapshot, runtime, t })
      const active = sections.find((section) => section.id === focus) ?? sections[0]
      const volumes = Array.isArray(snapshot?.volumes?.items) ? snapshot.volumes.items : []
      const total = volumes.reduce((sum, volume) => sum + (volume.totalBytes ?? 0), 0)
      const free = volumes.reduce((sum, volume) => sum + (volume.freeBytes ?? 0), 0)

      return h('div', { className: 'ss-perf' },
        h('div', { className: 'ss-rail', role: 'group', 'aria-label': t('perf.rail') },
          h('div', { className: 'ss-rail-title' }, t('perf.rail')),
          sections.map((section) => h(RailCard, {
            key: section.id,
            item: section,
            active: section.id === active.id,
            onSelect: () => runtime.focus.set(section.id),
          }))),
        h('div', { className: 'ss-stage' },
          h('div', { className: 'ss-stage-head' },
            h('h3', { className: 'ss-stage-title' }, active.title),
            active.subtitle
              ? h('span', { className: 'ss-stage-sub', title: active.subtitle }, active.subtitle)
              : null),
          active.kind === 'volumes'
            ? h('div', { className: 'ss-volumes' },
              h('div', { className: 'ss-toolbar' },
                h('span', null, snapshot === null
                  ? t('sampling.wait')
                  : t('disk.summary', {
                    count: volumes.length,
                    used: fmtBytes(Math.max(0, total - free)),
                    total: fmtBytes(total),
                  }))),
              snapshot === null
                ? h('div', { className: 'ss-empty' }, t('sampling.wait'))
                : volumes.length === 0
                  ? h('div', { className: 'ss-empty' }, t('disk.empty'))
                  : volumes.map((volume) => h(VolumeRow, { key: volume.mount, volume, t })))
            : h('div', { className: 'ss-chart' },
              h('div', { className: 'ss-chart-top' },
                h('span', null, active.metric ?? ''),
                h('span', { className: 'ss-chart-max' }, active.axisMax ?? '')),
              h('div', { className: 'ss-chart-body' },
                h(TrendChart, {
                  values: active.values,
                  max: active.max,
                  times: active.times,
                  accent: active.accent,
                  fill: active.fill,
                  label: active.title,
                }),
                active.empty ? h('div', { className: 'ss-chart-note' }, active.emptyText) : null),
              h('div', { className: 'ss-chart-axis' },
                h('span', null, t('perf.window')),
                h('span', null, '0'))),
          active.cores
            ? h('div', { className: 'ss-cores', title: t('perf.cores', { count: active.cores.length }) },
              active.cores.map((value, index) => h('span', { key: index, className: 'ss-core' },
                h('i', {
                  style: {
                    height: `${(Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 100).toFixed(1)}%`,
                    background: active.accent,
                  },
                }))))
            : null,
          h('div', { className: 'ss-stage-foot' },
            h('div', { className: 'ss-readouts' },
              active.readouts.map((readout, index) => h(Readout, {
                key: `${index}-${readout.label}`,
                ...readout,
              }))),
            h(Facts, { rows: active.facts }))))
    }

    // ---8<--- process-view (pure; mirrored by test-process-view.mjs) ---

    /** Rows that can be pinned above the sort at once (R5c). */
    const PIN_LIMIT = 5
    /** Sortable columns, in table order (R5d). */
    const SORT_KEYS = ['name', 'pid', 'cpu', 'memory']
    /** Rows rendered below the pinned area (R5). */
    const TOP_ROWS = 40
    /** CPU sort step: rows only change place when they cross one of these bands. */
    const CPU_BUCKET = 0.02
    /**
     * Column widths. Defaults are percentages (the name column was taking all the
     * leftover width, which left a long empty gap after every short name); once
     * the user drags a handle every column becomes a pixel width. `min` is what a
     * drag cannot go below — the header text and the widest cell still fit.
     */
    const COLUMN_KEYS = ['name', 'pid', 'cpu', 'memory']
    const COLUMN_DEFAULTS = { name: '46%', pid: '12%', cpu: '20%', memory: '22%' }
    const COLUMN_MIN = { name: 120, pid: 56, cpu: 56, memory: 64 }
    const WIDTHS_STORAGE = 'system-sniffer:column-widths'

    /** Widths saved by an earlier session; anything invalid is dropped. */
    function readStoredWidths() {
      try {
        const parsed = JSON.parse(window.localStorage.getItem(WIDTHS_STORAGE) ?? 'null')
        if (!parsed || typeof parsed !== 'object') return {}
        const widths = {}
        for (const key of COLUMN_KEYS) {
          const value = Number(parsed[key])
          if (Number.isFinite(value) && value >= COLUMN_MIN[key]) widths[key] = Math.round(value)
        }
        return widths
      } catch {
        return {}
      }
    }

    function storeWidths(widths) {
      try {
        window.localStorage.setItem(WIDTHS_STORAGE, JSON.stringify(widths))
      } catch {
        // Private mode / no storage: the widths still live in the view store.
      }
    }
    /**
     * Scroll offset of the process table, kept outside the component so a
     * re-render (every tick) or a remount (leave the tab and come back) does not
     * yank the viewport back to the top.
     */
    let processScrollTop = 0

    /**
     * Process-page view state: sort column and direction, pinned names, and
     * which groups are expanded. Like the tab and focus stores it lives outside
     * React, so leaving the page and coming back keeps the table the way the
     * user left it.
     *
     * Pins are keyed by process name, not by PID (R5c): a group is a set of
     * same-named instances, and a lone process and a group of that same name
     * are two shapes of one entry. Keying by name keeps a pin across that
     * shape change and across PID reuse. A stopped process therefore leaves a
     * pin behind, which the table renders as an "exited" row (R5c).
     */
    function createProcessView() {
      // CPU first, like Task Manager's Processes tab: the list is cut to
      // TOP_ROWS, so "busiest first" is what makes the cut meaningful (a name
      // order would show only the alphabetically first 40). The churn that
      // comes with it is damped in `sortGroups`, not by changing the key.
      let state = { sort: 'cpu', dir: 'desc', pins: [], open: [], widths: readStoredWidths() }
      const listeners = new Set()
      const commit = (next) => {
        state = next
        for (const listener of [...listeners]) listener()
      }
      return {
        getSnapshot() { return state },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        /**
         * Same column flips direction; a new column starts with the order that
         * column is read in: names A→Z, PIDs small→large, and CPU / memory
         * busiest-first.
         */
        setSort(key) {
          if (!SORT_KEYS.includes(key)) return
          if (state.sort === key) {
            commit({ ...state, dir: state.dir === 'asc' ? 'desc' : 'asc' })
            return
          }
          commit({ ...state, sort: key, dir: key === 'name' || key === 'pid' ? 'asc' : 'desc' })
        },
        /**
         * `key` is the group identity — `appId` from the Host when the native
         * collector is active, the process name on the PDH fallback. `label`
         * is what an exited pin shows after the app is gone.
         */
        togglePin(key, label) {
          if (state.pins.some((pin) => pin.name === key)) {
            commit({ ...state, pins: state.pins.filter((pin) => pin.name !== key) })
            return
          }
          if (state.pins.length >= PIN_LIMIT) return
          commit({ ...state, pins: [...state.pins, { name: key, label: label ?? key, at: Date.now() }] })
        },
        toggleOpen(name) {
          const open = state.open.includes(name)
          commit({
            ...state,
            open: open ? state.open.filter((entry) => entry !== name) : [...state.open, name],
          })
        },
        /** Merge pixel widths (a drag sends one key per mousemove) and persist. */
        setWidths(next) {
          const widths = { ...state.widths, ...next }
          storeWidths(widths)
          commit({ ...state, widths })
        },
      }
    }

    /** Sum of CPU fractions; null only when no member has a sample yet. */
    function sumCpu(members) {
      let total = null
      for (const member of members) {
        if (member.cpu === null || member.cpu === undefined) continue
        total = (total ?? 0) + member.cpu
      }
      return total
    }

    /**
     * Collapse processes into one entry per app. The Host computes `appId`
     * (window owner + parent tree), so Chrome's 13 processes and a launcher's
     * helpers collapse into one row; PDH-fallback items have no `appId` and
     * fall back to the image name, which is the old behaviour.
     *
     * The key is the group identity and the pin key (R5c): a lone process and a
     * group of the same app are one entry for pinning.
     */
    function groupProcesses(items) {
      const buckets = new Map()
      for (const item of items) {
        const key = item.appId ?? item.name
        const bucket = buckets.get(key)
        if (bucket) bucket.push(item)
        else buckets.set(key, [item])
      }
      const groups = []
      for (const [key, members] of buckets) {
        const ordered = [...members].sort((a, b) =>
          (b.cpu ?? -1) - (a.cpu ?? -1)
          || b.workingSetBytes - a.workingSetBytes
          || a.pid - b.pid)
        // Task Manager's group row is the windowed process with its children
        // below; the native collector tells us which member owns a window, so
        // that one leads. The PDH fallback has neither window nor parent link,
        // so the largest working set stands in for "the main one".
        const lead = ordered.find((member) => member.hasWindow === true)
          ?? ordered.reduce((best, member) =>
            (member.workingSetBytes ?? 0) > (best.workingSetBytes ?? 0) ? member : best, ordered[0])
        groups.push({
          key,
          name: members[0].appName ?? members[0].name,
          count: ordered.length,
          group: ordered.length > 1,
          members: ordered,
          lead,
          cpu: sumCpu(ordered),
          memory: ordered.reduce((total, member) => total + (member.workingSetBytes ?? 0), 0),
          // The PID a row shows is the lead's, so that is also the PID it sorts
          // by. Sorting by the smallest member instead put a group above a row
          // whose visible number was larger — the column looked unsorted.
          pid: lead?.pid ?? null,
        })
      }
      return groups
    }

    /** Order two numbers, missing values last in both directions. */
    function compareNumbers(a, b, factor) {
      const left = a === null || a === undefined || !Number.isFinite(a)
      const right = b === null || b === undefined || !Number.isFinite(b)
      if (left && right) return 0
      if (left) return 1
      if (right) return -1
      return factor * (a - b)
    }

    /** Sort merged groups; the name is a stable tie-breaker so rows do not swap on equal values. */
    function sortGroups(groups, sort, dir) {
      const factor = dir === 'asc' ? 1 : -1
      return [...groups].sort((a, b) => {
        // CPU is bucketed before comparing. Raw values re-order the table on
        // every 1 s tick — a row creeps from 1.2 % to 1.3 % and jumps above a
        // dozen others — which makes the list unreadable while it updates. A
        // 2 % step means only a process that actually gets busy moves; rows in
        // the same bucket fall back to name order and stay put. The cost is that
        // 20.1 % vs 19.9 % is decided by name, which no one can see anyway.
        const cpuOf = (group) => (group.cpu === null || group.cpu === undefined
          ? null
          : Math.round(group.cpu / CPU_BUCKET) * CPU_BUCKET)
        const primary = sort === 'name'
          ? factor * a.name.localeCompare(b.name)
          : compareNumbers(
            sort === 'memory' ? a.memory : sort === 'pid' ? a.pid : cpuOf(a),
            sort === 'memory' ? b.memory : sort === 'pid' ? b.pid : cpuOf(b),
            factor,
          )
        return primary || a.name.localeCompare(b.name)
      })
    }

    /**
     * Rows for one snapshot: the pinned block first, in pin order, then the
     * sorted rest cut to TOP_ROWS. A pinned app with no live process becomes an
     * "exited" row instead of disappearing (R5c).
     */
    function buildProcessRows(items, view, hasData) {
      const groups = groupProcesses(items)
      const byKey = new Map(groups.map((group) => [group.key, group]))
      const pinnedKeys = new Set(view.pins.map((pin) => pin.name))

      const pinned = view.pins.map((pin) => {
        const group = byKey.get(pin.name)
        if (group) return { ...group, pinned: true }
        return {
          key: pin.name,
          name: pin.label ?? pin.name,
          count: 0,
          group: false,
          members: [],
          lead: null,
          cpu: null,
          memory: null,
          pid: null,
          pinned: true,
          lost: hasData,
        }
      })

      const rows = sortGroups(
        groups.filter((group) => !pinnedKeys.has(group.key)),
        view.sort,
        view.dir,
      ).slice(0, TOP_ROWS)

      return { pinned, rows, names: groups.length, pids: items.length }
    }

    // --->8---

    /**
     * One column header: the sort button plus a drag handle on its right edge.
     * Widths live in the view store (and in localStorage) rather than in the
     * table, so a re-render every second cannot undo a drag.
     */
    function SortHeader(props) {
      const { id, label, state, store, t, className, onResize } = props
      const active = state.sort === id
      return h('th', {
        className,
        'aria-sort': active ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none',
      },
      h('button', {
        type: 'button',
        className: 'ss-th-sort',
        title: t('process.sortBy', { name: label }),
        onClick: () => store.setSort(id),
      },
      h('span', null, label),
      active ? h('span', { className: 'ss-arrow', 'aria-hidden': true }, state.dir === 'asc' ? '▲' : '▼') : null),
      h('span', {
        className: 'ss-col-resize',
        title: t('process.resizeColumn'),
        'aria-hidden': true,
        onMouseDown: (event) => onResize(id, event),
      }))
    }

    /**
     * 16 px app icon. The Host sends an `exeKey` per process and the runtime
     * turns keys into blob URLs. Group rows pass the lead's key, child rows their
     * own: Task Manager gives every expanded process its icon, which is how one
     * `chrome` row is told from another.
     *
     * Without a URL — no `exeKey` (a protected process we could not resolve a
     * path for), or the icon request failed — the row gets the same shape as the
     * system's generic application icon: a grey-framed white page with a blue
     * block in it. That is literally what `SHGetFileInfo` returns for an
     * icon-less executable (`svchost`, `lsass`, `services`, …) and what Task
     * Manager shows for those rows, so drawing the same thing means the roster
     * reads as one list instead of two.
     *
     * Geometry is measured off the real icon (32×32: frame 0–31 × 4–27, page
     * inset 1 px, blue block 9–22 × 8–24) and halved for the 16 px slot. The
     * colours are fixed rather than theme-tinted on purpose: icons are not
     * theme-aware, and this one has to sit next to the real ones unchanged. A
     * client SVG (not a bundled bitmap) keeps it crisp and does not depend on any
     * platform's icon pipeline, which is what the letter tile never solved.
     */
    function ProcessIcon(props) {
      const { exeKey, icons } = props
      const url = exeKey ? icons?.get(exeKey) : null
      if (!url) {
        return h('span', { className: 'ss-icon ss-icon-generic', 'aria-hidden': true },
          h('svg', { viewBox: '0 0 16 16', width: 16, height: 16 },
            h('rect', {
              x: 0.5, y: 2.5, width: 15, height: 11,
              fill: '#fafafa', stroke: '#797774', strokeWidth: 1,
            }),
            h('rect', { x: 4.5, y: 4, width: 6.5, height: 8, fill: '#0f81d0' })))
      }
      return h('img', { className: 'ss-icon', src: url, alt: '', loading: 'lazy', draggable: false })
    }

    /**
     * One entry: a group header with its members, or a plain process. The
     * disclosure and the pin are real buttons; the row itself takes the double
     * click (R5c), and the buttons stop it from firing on top of them.
     */
    function ProcessRow(props) {
      const { entry, state, store, t, pinned, last, icons, onMenu } = props
      const open = entry.group === true && state.open.includes(entry.key)
      const full = state.pins.length >= PIN_LIMIT
      const pinTitle = pinned
        ? t('process.unpin')
        : full ? t('process.pinLimit', { limit: PIN_LIMIT }) : t('process.pin')

      const header = h('tr', {
        key: 'entry',
        'data-pinned': pinned ? '' : undefined,
        'data-pin-last': pinned && last && !open ? '' : undefined,
        'data-lost': entry.lost ? '' : undefined,
        'data-group': entry.group ? '' : undefined,
        'data-self': /deepseek|dsh/i.test(entry.name) ? '' : undefined,
        onDoubleClick: (event) => {
          if (event.target.closest('button')) return
          store.togglePin(entry.key, entry.name)
        },
        onContextMenu: (event) => {
          if (entry.lost) return
          onMenu(event, {
            kind: entry.group ? 'group' : 'process',
            appId: entry.key,
            pid: entry.group ? null : entry.pid,
            label: entry.name,
          })
        },
      },
      h('td', { className: 'ss-name' },
        h('div', { className: 'ss-name-row' },
          entry.group
            ? h('button', {
              type: 'button',
              className: 'ss-toggle',
              'aria-expanded': open,
              'aria-label': open ? t('process.collapse') : t('process.expand'),
              onClick: () => store.toggleOpen(entry.key),
            }, CHEVRON_GLYPH)
            : h('span', { className: 'ss-toggle ss-toggle-ghost', 'aria-hidden': true }),
          h(ProcessIcon, { exeKey: entry.lead?.exeKey ?? entry.members[0]?.exeKey ?? null, icons }),
          h('span', { className: 'ss-name-text', title: entry.name }, entry.name),
          entry.lost ? h('span', { className: 'ss-tag' }, t('process.lost')) : null,
          entry.group ? h('span', { className: 'ss-count' }, `(${entry.count})`) : null,
          // At the end of the name, so the icon column starts the row like Task
          // Manager's and no row carries an empty leading slot.
          h('button', {
            type: 'button',
            className: 'ss-pin',
            'aria-pressed': Boolean(pinned),
            // Fixed name: the state is `aria-pressed`'s job, and a label that
            // flips to "取消固定" makes a screen reader read "unpin, pressed".
            'aria-label': t('process.pin'),
            title: pinTitle,
            onClick: (event) => {
              // The row's gesture is a double click; a double click landing on
              // the button must not toggle twice (pin → unpin, i.e. nothing).
              if (event.detail > 1) return
              store.togglePin(entry.key, entry.name)
            },
          }, PIN_GLYPH))),
      h('td', {
        className: 'num ss-muted',
        title: entry.group ? t('process.leadPid', { pid: entry.pid ?? '—' }) : undefined,
      },
      entry.lost ? '—' : String(entry.pid ?? '—')),
      h('td', { className: 'num' }, fmtPct(entry.cpu)),
      h('td', { className: 'num ss-muted' }, entry.lost ? '—' : fmtBytes(entry.memory)),
      h('td', { className: 'ss-filler' }))

      const members = open
        ? entry.members.map((member, index) => {
          // Task Manager's expanded rows carry the executable's description and
          // its icon, not a bare image name: ten rows reading `chrome` say
          // nothing. The image name stays, but only when it is the thing that
          // tells this child apart from the group's own executable.
          const label = member.displayName || member.name
          const otherExe = member.name !== (entry.lead?.name ?? member.name) && member.name !== label
          const title = member.displayName ? `${member.displayName} · ${member.name}` : (member.instance ?? member.name)
          return h('tr', {
            key: `sub:${member.pid}`,
            className: 'ss-sub-row',
            'data-self': /deepseek|dsh/i.test(member.name) ? '' : undefined,
            'data-pin-last': pinned && last && index === entry.members.length - 1 ? '' : undefined,
            onContextMenu: (event) => onMenu(event, {
              kind: 'process',
              appId: entry.key,
              pid: member.pid,
              label: member.displayName || member.name,
            }),
          },
          h('td', { className: 'ss-name ss-sub' },
            h('div', { className: 'ss-name-row' },
              h(ProcessIcon, { exeKey: member.exeKey ?? null, icons }),
              h('span', { className: 'ss-name-text', title }, label),
              otherExe ? h('span', { className: 'ss-sub-exe' }, member.name) : null)),
          h('td', { className: 'num ss-muted' }, String(member.pid)),
          h('td', { className: 'num' }, fmtPct(member.cpu)),
          h('td', { className: 'num ss-muted' }, fmtBytes(member.workingSetBytes)),
          h('td', { className: 'ss-filler' }))
        })
        : []

      return h(React.Fragment, null, header, ...members)
    }

    /** One box of the totals band: a small label over a large number. */
    function TotalBlock(props) {
      const { label, value, title } = props
      return h('div', { className: 'ss-total', title },
        h('span', { className: 'ss-total-label' }, label),
        h('span', { className: 'ss-total-value' }, value))
    }

    /**
     * The machine-wide numbers above the table: Task Manager's header band shows
     * CPU / memory / disk / network totals there, and they are what the list is
     * read against. Memory is "used / total physical", not the committed figure
     * the performance card shows — the box has to answer "how full is RAM".
     */
    function buildTotals(snapshot, t) {
      const cpu = snapshot?.cpu
      const memory = snapshot?.memory
      const disk = snapshot?.diskio
      const net = snapshot?.network
      const totalBytes = Number(memory?.totalBytes)
      const availableBytes = Number(memory?.availableBytes)
      const usedBytes = Number.isFinite(totalBytes) && totalBytes > 0 && Number.isFinite(availableBytes)
        ? Math.max(0, totalBytes - availableBytes)
        : null
      const netBytes = Array.isArray(net?.items)
        ? net.items.reduce((sum, item) => sum + (item.rxBytesPerSec ?? 0) + (item.txBytesPerSec ?? 0), 0)
        : null
      return [
        { id: 'cpu', label: t('perf.cpu'), value: fmtPct(cpu?.usage) },
        {
          id: 'memory',
          label: t('perf.memory'),
          value: usedBytes === null ? '—' : fmtPct(usedBytes / totalBytes),
          title: usedBytes === null ? undefined : `${fmtBytes(usedBytes)} / ${fmtBytes(totalBytes)}`,
        },
        {
          id: 'disk',
          label: t('perf.disk'),
          value: fmtPct(disk?.activeRatio),
          title: typeof disk?.totalBytesPerSec === 'number' ? fmtRate(disk.totalBytesPerSec) : undefined,
        },
        {
          id: 'network',
          label: t('perf.network'),
          value: netBytes === null ? '—' : fmtRate(netBytes),
        },
      ]
    }

    /** 进程：同名进程折成一组；双击固定，固定在排序之上（R5b / R5c / R5d）。 */
    function ProcessTab(props) {      const { snapshot, runtime, t } = props
      const store = runtime.processView
      const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
      const items = snapshot?.processes?.items ?? []
      const hasData = Boolean(snapshot?.processes?.sampledAt)
      const model = useMemo(
        () => buildProcessRows(items, state, hasData),
        [items, state, hasData],
      )
      const full = state.pins.length >= PIN_LIMIT
      const empty = model.pinned.length === 0 && model.rows.length === 0

      // The table re-renders on every tick; put the viewport back where the user
      // left it (and after a remount, where they left it last time).
      const wrap = useRef(null)
      const table = useRef(null)
      const [resizing, setResizing] = useState(null)
      // Right-click target: the row is the only place that knows whether the
      // gesture means "this group" or "this member", so the menu is anchored to
      // the click and carries that answer.
      const [menu, setMenu] = useState(null)
      useEffect(() => {
        if (menu === null) return undefined
        const close = () => setMenu(null)
        const onKey = (event) => { if (event.key === 'Escape') setMenu(null) }
        window.addEventListener('click', close)
        window.addEventListener('keydown', onKey)
        return () => {
          window.removeEventListener('click', close)
          window.removeEventListener('keydown', onKey)
        }
      }, [menu])

      const openMenu = (event, target) => {
        event.preventDefault()
        event.stopPropagation()
        // The menu is absolutely positioned inside `.ss-panel`; viewport
        // coordinates would land it outside the panel (which is a containment
        // container, so fixed positioning is relative to it anyway).
        const bounds = event.currentTarget.closest('.ss-panel')?.getBoundingClientRect() ?? null
        const left = (bounds?.left ?? 0)
        const top = (bounds?.top ?? 0)
        const width = bounds?.width ?? window.innerWidth
        const height = bounds?.height ?? window.innerHeight
        setMenu({
          x: Math.max(8, Math.min(event.clientX - left, width - 208)),
          y: Math.max(8, Math.min(event.clientY - top, height - 64)),
          ...target,
        })
      }
      useEffect(() => {
        const node = wrap.current
        if (node && node.scrollTop !== processScrollTop) node.scrollTop = processScrollTop
      })

      /**
       * Drag a column edge. The first move freezes every column at its rendered
       * width — mixing percentages with a dragged pixel width would let the
       * browser redistribute the other columns on every render.
       */
      const beginResize = (key, event) => {
        event.preventDefault()
        const row = table.current?.querySelector('thead tr')
        const cells = row ? [...row.children] : []
        const frozen = {}
        COLUMN_KEYS.forEach((name, index) => {
          const cell = cells[index]
          if (cell) frozen[name] = Math.round(cell.getBoundingClientRect().width)
        })
        store.setWidths(frozen)
        const startX = event.clientX
        const startWidth = frozen[key] ?? COLUMN_MIN[key]
        setResizing(key)
        const onMove = (move) => {
          const width = Math.max(COLUMN_MIN[key], Math.round(startWidth + move.clientX - startX))
          store.setWidths({ [key]: width })
        }
        const onUp = () => {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
          setResizing(null)
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      }

      const body = h('div', { className: 'ss-fill' },
        h('div', { className: 'ss-totals' },
          h('div', { className: 'ss-totals-grid' },
            buildTotals(snapshot, t).map((total) => h(TotalBlock, { key: total.id, ...total }))),
          h('div', { className: 'ss-totals-meta' },
            h('span', null, t('process.toolbar', { names: model.names, pids: model.pids })),
            h('span', null, full ? t('process.pinLimit', { limit: PIN_LIMIT }) : t('process.hint')))),
        h('div', {
          className: 'ss-table-wrap',
          ref: wrap,
          'data-resizing': resizing ? '' : undefined,
          onScroll: (event) => { processScrollTop = event.currentTarget.scrollTop },
        },
          h('table', { className: 'ss-table', ref: table },
            h('colgroup', null,
              COLUMN_KEYS.map((key) => h('col', {
                key,
                style: { width: state.widths[key] ? `${state.widths[key]}px` : COLUMN_DEFAULTS[key] },
              })),
              // Filler: absorbs the width left over after a drag so the four real
              // columns keep exactly the widths the user chose.
              h('col', { key: 'filler' })),
            h('thead', null, h('tr', null,
              h(SortHeader, { id: 'name', label: t('process.name'), state, store, t, onResize: beginResize }),
              h(SortHeader, { id: 'pid', label: t('process.pid'), state, store, t, className: 'num', onResize: beginResize }),
              h(SortHeader, { id: 'cpu', label: t('process.cpu'), state, store, t, className: 'num', onResize: beginResize }),
              h(SortHeader, { id: 'memory', label: t('process.memory'), state, store, t, className: 'num', onResize: beginResize }),
              h('th', { className: 'ss-filler', 'aria-hidden': true }))),
            h('tbody', null,
              empty
                ? h('tr', null, h('td', { colSpan: 5, className: 'ss-empty' }, t('process.empty')))
                : [
                  ...model.pinned.map((entry, index) => h(ProcessRow, {
                    key: `pin:${entry.key}`,
                    entry,
                    state,
                    store,
                    t,
                    icons: runtime.icons,
                    onMenu: openMenu,
                    pinned: true,
                    last: index === model.pinned.length - 1,
                  })),
                  ...model.rows.map((entry) => h(ProcessRow, {
                    key: `row:${entry.key}`,
                    entry,
                    state,
                    store,
                    t,
                    icons: runtime.icons,
                    onMenu: openMenu,
                  })),
                ]))))

      const menuNode = menu === null
        ? null
        : h('div', {
          className: 'ss-menu',
          style: { left: `${menu.x}px`, top: `${menu.y}px` },
          onClick: (event) => event.stopPropagation(),
        },
        h('button', {
          type: 'button',
          className: 'ss-menu-item',
          onClick: () => {
            const target = { appId: menu.appId, pid: menu.pid, kind: menu.kind, label: menu.label }
            setMenu(null)
            // Open the trace page with this target selected; recording starts
            // only from the page's own button.
            runtime.selectTraceTarget(target)
          },
        }, t(menu.kind === 'group' ? 'trace.menuGroup' : 'trace.menuProcess')))

      return h(React.Fragment, null, body, menuNode)
    }

    function VolumeRow(props) {
      const { volume, t } = props
      const ratio = Math.max(0, Math.min(1, volume.usedRatio ?? 0))
      const used = Math.max(0, (volume.totalBytes ?? 0) - (volume.freeBytes ?? 0))
      const level = ratio >= 0.9 ? 'danger' : ratio >= 0.75 ? 'warn' : undefined
      return h('div', { className: 'ss-section ss-vol' },
        h('div', { className: 'ss-vol-head' },
          h('span', { className: 'ss-vol-name' }, volume.mount),
          h('span', { className: 'ss-vol-fig' }, `${fmtBytes(used)} / ${fmtBytes(volume.totalBytes)}`)),
        h('div', { className: 'ss-bar', 'data-level': level },
          h('span', { style: { width: `${(ratio * 100).toFixed(1)}%` } })),
        h('div', { className: 'ss-vol-foot' },
          `${t('disk.used', { percent: (ratio * 100).toFixed(0) })} · ${t('disk.free', { size: fmtBytes(volume.freeBytes) })}`))
    }

    /* ── disk scan ────────────────────────────────────────────────────────
       One level at a time, path bar above, click to pick, double-click to go
       in — the interaction is the file manager's, and the map is never nested:
       nesting is what makes SpaceSniffer's small rectangles unreadable. */

    /** Layout space; percentages keep the map independent of the real pixels. */
    const SCAN_VIEW = { w: 1000, h: 560 }

    async function diskCall(payload) {
      const response = await fetch('/api/system-sniffer/diskscan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: timeoutSignal(),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      if (body?.error) throw new Error(body.error.message)
      return body
    }

    /**
     * Squarified treemap (Bruls / Huizing / van Wijk). This is the whole
     * "library": ~40 lines, no dependency, and it runs in 0.13 ms for 200 cells.
     */
    function squarify(items, width, height) {
      const total = items.reduce((sum, item) => sum + Math.max(0, item.bytes ?? 0), 0)
      if (total <= 0 || width <= 0 || height <= 0) return []
      const scaled = items.map((item) => ({
        ...item,
        area: (Math.max(0, item.bytes ?? 0) / total) * width * height,
      }))
      const out = []
      let free = { x: 0, y: 0, w: width, h: height }
      const queue = scaled.slice()
      while (queue.length > 0) {
        const row = []
        let rowSum = 0
        let worst = Infinity
        const side = Math.max(1, Math.min(free.w, free.h))
        while (queue.length > 0) {
          const candidate = queue[0]
          const nextSum = rowSum + candidate.area
          const nextWorst = worstRatio([...row, candidate], nextSum, side)
          if (row.length === 0 || nextWorst <= worst) {
            row.push(candidate)
            rowSum = nextSum
            worst = nextWorst
            queue.shift()
          } else {
            break
          }
        }
        const horizontal = free.w >= free.h
        const thickness = rowSum / side
        let offset = horizontal ? free.y : free.x
        for (const item of row) {
          const length = item.area / Math.max(thickness, 0.0001)
          out.push(horizontal
            ? { ...item, x: free.x, y: offset, w: thickness, h: length }
            : { ...item, x: offset, y: free.y, w: length, h: thickness })
          offset += length
        }
        free = horizontal
          ? { x: free.x + thickness, y: free.y, w: free.w - thickness, h: free.h }
          : { x: free.x, y: free.y + thickness, w: free.w, h: free.h - thickness }
      }
      return out
    }

    function worstRatio(row, rowSum, side) {
      if (rowSum <= 0) return Infinity
      let max = 0
      let min = Infinity
      for (const item of row) {
        if (item.area > max) max = item.area
        if (item.area < min) min = item.area
      }
      const side2 = side * side
      const sum2 = rowSum * rowSum
      return Math.max((side2 * max) / sum2, sum2 / (side2 * Math.max(min, 0.0001)))
    }

    function scanHue(name) {
      let hash = 2166136261
      for (let index = 0; index < name.length; index += 1) {
        hash ^= name.charCodeAt(index)
        hash = Math.imul(hash, 16777619) >>> 0
      }
      return hash % 360
    }

    /**
     * 全部黄色系，越深越暗：色相固定，深度决定亮度。层次靠明暗，不靠彩虹。
     * 亮度里掺一点名字哈希的抖动（±3）——同一层里几十块同色同亮会糊成一整片
     * 黄，1 px 的间隙不足以分开；抖动只改明暗、不改色相，整体仍是一片黄。
     * 文件用中性灰蓝，和目录一眼分开（SpaceSniffer 也是目录一色、文件一色）。
     */
    const SCAN_HUE = 38
    const SCAN_LIGHT = 58
    function scanColor(cell, depth) {
      const drop = Math.min(26, depth * 6)
      if (!cell?.dir) return `hsl(212 12% ${Math.max(30, 44 - drop)}%)`
      const jitter = (scanHue(cell.name) % 7) - 3
      return `hsl(${SCAN_HUE} ${Math.max(28, 56 - depth * 4)}% ${Math.max(22, SCAN_LIGHT - drop + jitter)}%)`
    }

    function DiskScanPanel(props) {
      const { t, root, onBack } = props
      const [status, setStatus] = useState(null)
      // The trail is the drill-down stack: root … current. It is what makes the
      // parent's share and the sibling strip possible without re-fetching.
      const [trail, setTrail] = useState([])
      const [policy, setPolicy] = useState('off')
      const [selected, setSelected] = useState(null)
      const [note, setNote] = useState('')
      const [flip, setFlip] = useState(null)
      /** Map width in px: decides whether a rectangle is big enough for a label. */
      const [mapWidth, setMapWidth] = useState(0)
      const mapRef = useRef(null)
      const currentId = useRef('0')
      const alive = useRef(true)

      useEffect(() => {
        const node = mapRef.current
        if (!node || typeof ResizeObserver === 'undefined') return undefined
        const observer = new ResizeObserver((entries) => {
          const width = entries[0]?.contentRect?.width ?? 0
          setMapWidth((prev) => (Math.abs(prev - width) < 4 ? prev : width))
        })
        observer.observe(node)
        return () => observer.disconnect()
      }, [])

      useEffect(() => {
        alive.current = true
        let timer = null
        let stopped = false

        function merge(body, mode) {
          if (!body || body.error) return
          setTrail((prev) => {
            if (mode === 'refresh') {
              if (prev.length === 0) return [body]
              return [...prev.slice(0, -1), body]
            }
            const index = prev.findIndex((entry) => entry.id === body.id)
            if (index >= 0) return [...prev.slice(0, index), body]
            return [...prev, body]
          })
        }

        async function tick() {
          let scanning = false
          try {
            const next = await diskCall({ action: 'status' })
            if (stopped) return
            setStatus(next)
            scanning = next.state === 'scanning'
            if (next.policy) setPolicy(next.policy)
            if (next.state === 'scanning' || next.state === 'ready') {
              const body = await diskCall({ action: 'level', id: currentId.current })
              if (!stopped) merge(body, 'refresh')
            }
          } catch (error) {
            if (!stopped) setNote(String(error?.message ?? error))
          }
          if (!stopped) timer = setTimeout(() => { void tick() }, scanning ? 250 : 2000)
        }

        void tick()
        return () => {
          stopped = true
          alive.current = false
          if (timer !== null) clearTimeout(timer)
        }
      }, [])

      /** Drill into a directory; `origin` is where the click came from, for the zoom. */
      async function open(id, origin) {
        if (origin) setFlip({ ...origin })
        try {
          const body = await diskCall({ action: 'level', id })
          if (!alive.current || body?.error) return
          currentId.current = id
          setTrail((prev) => {
            const index = prev.findIndex((entry) => entry.id === body.id)
            if (index >= 0) return [...prev.slice(0, index), body]
            return [...prev, body]
          })
          setSelected(null)
          setNote('')
        } catch (error) {
          setNote(String(error?.message ?? error))
        }
      }

      async function begin() {
        setNote('')
        try {
          const body = await diskCall({ action: 'start', root })
          if (body.error) {
            setNote(body.error.message)
            return
          }
          currentId.current = '0'
          setTrail([])
          setSelected(null)
          setStatus({ state: 'scanning', root, bytes: 0, files: 0, dirs: 0 })
        } catch (error) {
          setNote(String(error?.message ?? error))
        }
      }

      async function stop() {
        try {
          await diskCall({ action: 'cancel' })
        } catch (error) {
          setNote(String(error?.message ?? error))
        }
      }

      async function changePolicy(next) {
        setPolicy(next)
        try {
          const body = await diskCall({ action: 'policy', level: next })
          if (body.persisted === false) setNote(t('disk.scanSessionOnly'))
        } catch (error) {
          setNote(String(error?.message ?? error))
        }
      }

      const current = trail.length > 0 ? trail[trail.length - 1] : null
      const parent = trail.length > 1 ? trail[trail.length - 2] : null
      const depth = Math.max(0, trail.length - 1)
      const scanning = status?.state === 'scanning'
      const children = current?.children ?? []
      const other = current?.other ?? null
      const cells = other
        ? [...children, { id: null, name: t('disk.scanOther', { count: other.count }), bytes: other.bytes, dir: false, other: true }]
        : children
      const rects = squarify(cells, SCAN_VIEW.w, SCAN_VIEW.h)
      // Label rule, measured not guessed: draw the name whenever the rectangle can
      // hold a few characters, let CSS ellipsis cut the long ones, and fall back to
      // the tooltip only when the cell is genuinely too small.
      const pxPerUnit = mapWidth > 0 ? mapWidth / SCAN_VIEW.w : 0
      const labelFits = (rect) => pxPerUnit > 0 && rect.w * pxPerUnit >= 46 && rect.h * pxPerUnit >= 16
      const sizeFits = (rect) => pxPerUnit > 0 && rect.h * pxPerUnit >= 32 && rect.w * pxPerUnit >= 58
      const crumbs = current?.path ?? []
      const shareOfParent = parent && parent.total > 0 && current ? current.total / parent.total : null
      const share = current && current.total > 0 && selected ? selected.bytes / current.total : null
      /**
       * Honest coverage: the scanned tree is always smaller than the volume's
       * used bytes — system metadata (`$MFT`, `$LogFile`), shadow copies and
       * no-access folders are not in any directory. Saying only "scanned X"
       * makes people believe X is everything.
       */
      const usedBytes = Number.isFinite(props.usedBytes) && props.usedBytes > 0 ? props.usedBytes : null
      const scannedBytes = Number.isFinite(status?.bytes) ? status.bytes : 0
      const coverage = usedBytes !== null && scannedBytes > 0 ? Math.min(1, scannedBytes / usedBytes) : null
      const missingBytes = usedBytes !== null && coverage !== null ? Math.max(0, usedBytes - scannedBytes) : 0

      return h('div', { className: 'ss-scan' },
        h('div', { className: 'ss-scan-bar' },
          h('button', {
            type: 'button',
            className: 'ss-scan-back',
            title: t('disk.scanBack'),
            onClick: () => { if (onBack) onBack() },
          }, '‹'),
          h('button', {
            type: 'button',
            onClick: () => { void (scanning ? stop() : begin()) },
          }, scanning ? t('disk.scanStop') : t('disk.scan')),
          h('span', { className: 'ss-scan-muted' }, t('disk.scanPolicy')),
          h('select', {
            value: policy,
            'aria-label': t('disk.scanPolicy'),
            onChange: (event) => { void changePolicy(event.target.value) },
          }, [
            h('option', { key: 'off', value: 'off' }, t('disk.scanPolicyOff')),
            h('option', { key: 'numbers', value: 'numbers' }, t('disk.scanPolicyNumbers')),
            h('option', { key: 'names', value: 'names' }, t('disk.scanPolicyNames')),
          ])),

        coverage !== null
          ? h('div', { className: 'ss-scan-coverage' },
            h('div', { className: 'ss-scan-coverage-track' },
              h('div', {
                className: 'ss-scan-coverage-fill',
                style: { width: `${(coverage * 100).toFixed(1)}%` },
              })),
            h('div', { className: 'ss-scan-coverage-text' },
              h('span', null, t('disk.scanCovered', {
                scanned: fmtBytes(scannedBytes),
                used: fmtBytes(usedBytes),
              })),
              h('span', { className: 'ss-scan-muted' }, t('disk.scanGap', { gap: fmtBytes(missingBytes) }))))
          : null,

        crumbs.length > 0
          ? h('div', { className: 'ss-scan-crumbs' },
            h('div', { className: 'ss-scan-crumb-list' }, crumbs.flatMap((step, index) => {
            const chain = []
            if (index > 0) chain.push(h('span', { key: `sep-${step.id}`, className: 'ss-scan-sep' }, '›'))
            chain.push(h('button', {
              key: step.id,
              type: 'button',
              className: 'ss-scan-crumb',
              'data-current': index === crumbs.length - 1 ? 'true' : 'false',
              onClick: () => {
                if (index === crumbs.length - 1) return
                void diskCall({ action: 'level', id: step.id }).then((body) => {
                  if (body?.error) return
                  currentId.current = step.id
                  setTrail((prev) => {
                    const at = prev.findIndex((entry) => entry.id === body.id)
                    return at >= 0 ? [...prev.slice(0, at), body] : [...prev, body]
                  })
                  setSelected(null)
                }).catch(() => {})
              },
            }, step.name))
            return chain
          })),
            current
              ? h('span', { className: 'ss-scan-sum' },
                `${fmtBytes(current.total)}${shareOfParent === null ? '' : ` · ${t('disk.scanOf', { name: parent.name, percent: (shareOfParent * 100).toFixed(1) })}`}`,
                current.partial ? h('span', { className: 'ss-scan-chip' }, t('disk.scanRunning')) : null)
              : null)
          : null,

        h('div', {
          className: 'ss-scan-map',
          ref: mapRef,
          'data-entering': flip ? 'true' : 'false',
        },
          rects.map((rect, index) => h('button', {
            key: rect.other ? '__other' : (rect.id ?? rect.name),
            type: 'button',
            className: 'ss-scan-cell',
            title: `${rect.name} · ${fmtBytes(rect.bytes)}`,
            'data-selected': selected && selected.name === rect.name ? 'true' : 'false',
            style: {
              left: `${(rect.x / SCAN_VIEW.w) * 100}%`,
              top: `${(rect.y / SCAN_VIEW.h) * 100}%`,
              width: `${(rect.w / SCAN_VIEW.w) * 100}%`,
              height: `${(rect.h / SCAN_VIEW.h) * 100}%`,
              background: scanColor(rect, depth),
            },
            onClick: () => setSelected(rect),
            onDoubleClick: () => {
              if (rect.dir && rect.id) void open(rect.id, rect)
            },
          }, labelFits(rect)
            ? h('span', { className: 'ss-scan-label' },
              h('span', { className: 'ss-scan-name' }, rect.name),
              sizeFits(rect) ? h('span', { className: 'ss-scan-size' }, fmtBytes(rect.bytes)) : null)
            : null)),
          /* The clicked rectangle expands over the new level and fades: the one
             cue that says "you went in", before any text is read. */
          flip
            ? h('div', {
              className: 'ss-scan-flip',
              style: {
                '--flip-x': `${(flip.x / SCAN_VIEW.w) * 100}%`,
                '--flip-y': `${(flip.y / SCAN_VIEW.h) * 100}%`,
                '--flip-w': `${(flip.w / SCAN_VIEW.w) * 100}%`,
                '--flip-h': `${(flip.h / SCAN_VIEW.h) * 100}%`,
                background: scanColor(flip, depth),
              },
              onAnimationEnd: () => setFlip(null),
            }, null)
            : null),

        h('div', { className: 'ss-scan-info' },
          note
          || (selected && current
            ? `${selected.name} · ${fmtBytes(selected.bytes)}${share === null ? '' : ` · ${(share * 100).toFixed(1)}%`}`
            : current
              ? `${fmtBytes(current.total)}${current.partial ? ` · ${t('disk.scanRunning')}` : ''}`
              : t('disk.scanIdle'))))
    }

    /** 磁盘：各卷容量与占用，容量来自 fs.statfs，不启动子进程。 */
    /** 首页：选一个卷，或输入任意目录。扫描视图里这一块不占版面。 */
    function DiskScanLanding(props) {
      const { t, volumes, onPick } = props
      const [path, setPath] = useState('')
      const [last, setLast] = useState(null)

      useEffect(() => {
        let stopped = false
        void diskCall({ action: 'status' }).then((body) => {
          // Only a finished scan is worth offering to reopen; a running one is
          // resumed by clicking its volume again.
          if (!stopped && body && body.state === 'ready' && /^[A-Za-z]:$/.test(body.root ?? '')) setLast(body)
        }).catch(() => {})
        return () => { stopped = true }
      }, [])

      const submit = () => {
        const next = path.trim()
        if (next.length > 0) onPick(next)
      }

      return h('div', { className: 'ss-scan-landing' },
        last
          ? h('div', { className: 'ss-scan-resume' },
            h('span', { className: 'ss-scan-muted' },
              `${t('disk.scanLast')} · ${last.root} · ${fmtBytes(last.bytes ?? 0)}`),
            h('button', { type: 'button', onClick: () => onPick(last.root) }, t('disk.scanView')))
          : null,
        h('div', { className: 'ss-vol-grid' }, volumes.map((volume) => {
          const used = Math.max(0, (volume.totalBytes ?? 0) - (volume.freeBytes ?? 0))
          const total = volume.totalBytes ?? 0
          const ratio = total > 0 ? used / total : 0
          return h('button', {
            key: volume.mount,
            type: 'button',
            className: 'ss-vol-card',
            onClick: () => onPick(volume.mount),
          },
          h('span', { className: 'ss-vol-card-name' }, volume.mount),
          h('span', { className: 'ss-vol-card-num' }, `${fmtBytes(used)} / ${fmtBytes(total)}`),
          h('span', { className: 'ss-vol-card-bar' }, h('span', {
            className: 'ss-vol-card-fill',
            style: { width: `${Math.min(100, Math.max(0, ratio * 100))}%` },
            'data-warn': ratio >= 0.9 ? 'error' : ratio >= 0.75 ? 'warn' : 'ok',
          })))
        })),
        h('div', { className: 'ss-scan-path' },
          h('input', {
            type: 'text',
            value: path,
            placeholder: t('disk.pathHint'),
            onChange: (event) => setPath(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') submit() },
          }),
          h('button', { type: 'button', onClick: submit }, t('disk.scan'))))
    }

    function DiskTab(props) {
      const { snapshot, t } = props
      const volumes = snapshot?.volumes?.items ?? []
      // null = the volume list; a string = that root's scan view. Lifting it here
      // is what lets the scan page use the full height.
      const [root, setRoot] = useState(null)

      if (!snapshot) {
        return h('div', { className: 'ss-scroll' },
          h('div', { className: 'ss-empty' }, t('sampling.wait')))
      }

      if (root !== null) {
        // The volume behind this scan, so the coverage bar can compare what was
        // counted against what the volume says is used. A folder picked by hand
        // has no volume to compare with, and the bar stays away.
        const key = String(root).toUpperCase()
        const volume = volumes.find((item) => String(item.mount ?? '').toUpperCase().startsWith(key))
        const usedBytes = volume
          ? Math.max(0, (volume.totalBytes ?? 0) - (volume.freeBytes ?? 0))
          : null
        return h('div', { className: 'ss-scan-view' },
          h(DiskScanPanel, { t, root, usedBytes, onBack: () => setRoot(null) }))
      }

      const total = volumes.reduce((sum, volume) => sum + (volume.totalBytes ?? 0), 0)
      const free = volumes.reduce((sum, volume) => sum + (volume.freeBytes ?? 0), 0)

      return h('div', { className: 'ss-scroll' },
        h('div', { className: 'ss-toolbar' },
          h('span', null, t('disk.summary', {
            count: volumes.length,
            used: fmtBytes(Math.max(0, total - free)),
            total: fmtBytes(total),
          }))),
        volumes.length === 0
          ? h('div', { className: 'ss-empty' }, t('disk.empty'))
          : h(DiskScanLanding, { t, volumes, onPick: setRoot }))
    }

    /** Newest finite value in a columnar series, or null. */
    function lastValue(values) {
      const list = Array.isArray(values) ? values : []
      for (let index = list.length - 1; index >= 0; index -= 1) {
        if (Number.isFinite(list[index])) return list[index]
      }
      return null
    }

    /** Largest finite value; null when the series has none. */
    function maxValue(values) {
      let max = null
      for (const value of Array.isArray(values) ? values : []) {
        if (!Number.isFinite(value)) continue
        if (max === null || value > max) max = value
      }
      return max
    }

    /**
     * One line over a real time axis: x comes from `times` when the host sends
     * it (a point sits where it happened, so a missing second is a hole in the
     * right place) and falls back to the uniform `t0 + i * dt` grid otherwise.
     * Nulls break the path instead of being skipped, and points outside the
     * window are still emitted — the svg clips them, so a line that enters from
     * the left connects to the edge instead of starting mid-air.
     */
    function TraceChart(props) {
      const { values, max, color, label, readout, t0, dt, times, from, to } = props
      const list = Array.isArray(values) ? values : []
      const ceiling = Number.isFinite(max) && max > 0 ? max : 1
      const span = Number.isFinite(to - from) && to > from ? to - from : 1
      const hasTimes = Array.isArray(times)
      let path = ''
      let pen = false
      for (let index = 0; index < list.length; index += 1) {
        const value = list[index]
        if (!Number.isFinite(value)) {
          pen = false
          continue
        }
        const at = hasTimes && Number.isFinite(times[index]) ? times[index] : t0 + index * dt
        const x = ((at - from) / span) * 100
        const y = 29 - Math.min(1, Math.max(0, value / ceiling)) * 27
        path += `${pen ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`
        pen = true
      }
      const grid = [0, 25, 50, 75, 100].map((x) => h('line', {
        key: `trace-grid:${x}`,
        x1: x,
        x2: x,
        y1: 0,
        y2: 30,
        stroke: 'currentColor',
        strokeOpacity: 0.5,
        strokeWidth: 1,
        vectorEffect: 'non-scaling-stroke',
      }))
      return h('div', { className: 'ss-trace-chart' },
        h('div', { className: 'ss-trace-chart-head' },
          h('span', null, label),
          h('span', { className: 'ss-trace-chart-value' }, readout)),
        h('svg', {
          viewBox: '0 0 100 30',
          preserveAspectRatio: 'none',
          className: 'ss-trace-svg',
          'aria-hidden': true,
        },
        grid,
        h('path', {
          d: path,
          fill: 'none',
          stroke: color,
          strokeWidth: 1.2,
          vectorEffect: 'non-scaling-stroke',
          strokeLinejoin: 'round',
        })))
    }

    /**
     * The longest stretch of missing samples in a chart's data, in ms.
     *
     * A trace curve breaks wherever the sampler produced nothing, which is
     * correct but looks like a drawing bug from the outside: five segments
     * across a wide window read as "the chart is broken" long before anyone
     * thinks "the collector missed four seconds". Surfacing the number turns a
     * mystery into a measurement — and when it is zero, the chart really is at
     * fault.
     */
    function traceGapMs(chart) {
      const values = Array.isArray(chart?.cpu) ? chart.cpu : []
      if (values.length < 2) return 0
      const dt = Number.isFinite(chart?.dt) && chart.dt > 0 ? chart.dt : 1000
      let worst = 0
      // Real timestamps say how far apart the samples actually were; the grid
      // (a range answer has no `times`) says how many slots were empty.
      if (Array.isArray(chart?.times) && chart.times.length === values.length) {
        for (let index = 1; index < chart.times.length; index += 1) {
          const delta = chart.times[index] - chart.times[index - 1]
          if (Number.isFinite(delta) && delta > worst) worst = delta
        }
        return worst > dt * 1.5 ? worst : 0
      }
      let run = 0
      for (const value of values) {
        if (Number.isFinite(value)) { run = 0; continue }
        run += 1
        if (run * dt > worst) worst = run * dt
      }
      return worst
    }

    /** `HH:MM` for a tick on the range bar; seconds only when the spread is short. */
    function fmtTickTime(ms, minutesOnly) {
      if (!Number.isFinite(ms) || ms <= 0) return '—'
      const date = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return minutesOnly
        ? `${pad(date.getHours())}:${pad(date.getMinutes())}`
        : `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /** First character of a name, for the folded rail's tile. */
    function initialOf(name) {
      const text = String(name ?? '').trim()
      return text.length > 0 ? text.slice(0, 1).toUpperCase() : '·'
    }

    /**
     * What the rail shows: one header (the group, or the traced process), the
     * members still running, and the ones that already left.
     *
     * The header carries the aggregate — the sum the curve is drawn from — while
     * a child row carries that one member's last sample. The two counts come from
     * the Host separately (`live` / `exited`): counting them together made the
     * header grow for eight hours on a recording whose app keeps restarting
     * helpers, which reads as "39 processes" for a group that has seven.
     * Exited members keep the numbers they died with and are capped, newest exit
     * first.
     */
    function buildTraceRail(members, kind, label, aggregate) {
      const items = Array.isArray(members?.items) ? members.items : []
      const live = []
      const exited = []
      for (const item of items) {
        if (!item) continue
        if (Number.isFinite(item.exitedAt) && item.exitedAt > 0) exited.push(item)
        else live.push(item)
      }
      exited.sort((a, b) => b.exitedAt - a.exitedAt || a.pid - b.pid)
      // A single-process trace *is* its only member: the header already shows it,
      // so the same row must not come back a second time under "已退出".
      const own = kind === 'process' ? (items[0] ?? null) : null
      const ownExited = own && Number.isFinite(own.exitedAt) && own.exitedAt > 0 ? 1 : 0
      const keptExited = kind === 'process' ? [] : exited.slice(0, TRACE_EXITED_LIMIT)
      const lead = live[0] ?? own
      // The Host's own counts when it sends them; the payload's shape is the
      // fallback, so an older Host still renders something honest.
      const liveCount = Number.isFinite(members?.live) ? members.live : live.length
      const exitedTotal = Math.max(0,
        (Number.isFinite(members?.exited) ? members.exited : exited.length) - ownExited)
      return {
        label: label || lead?.name || '',
        pid: lead?.pid ?? null,
        cpu: aggregate?.cpu ?? null,
        memory: aggregate?.memory ?? null,
        count: liveCount,
        total: liveCount,
        exitedTotal,
        others: members?.others ?? null,
        exitedAt: own?.exitedAt ?? 0,
        children: live,
        exited: keptExited,
        exitedMore: Math.max(0, exitedTotal - keptExited.length),
        // One live member is the header itself; a disclosure over one row is noise.
        hasChildren: live.length > 1,
      }
    }

    /**
     * The member rail: one header per trace target, its members underneath, and
     * the ones that already left in their own folded block.
     *
     * A click only moves the view: the header looks at the whole group, a child
     * at that process. Switching what is being *recorded* still needs the
     * process page's right-click menu, because that one ends a ring.
     */
    function TraceRail(props) {
      // The two disclosures come in as values: a component cannot read a store's
      // state off the store object, and the runtime owns the subscription.
      const { model, focus, rail, t, narrow, open, exitedOpen, onGroup, onMember } = props
      const activePid = focus.kind === 'process' ? focus.pid : null
      const groupsOpen = model.hasChildren && open === true
      const shownExited = exitedOpen === true

      /** One clickable row: a name line over a line of numbers. */
      const memberRow = (member, className, key) => h('div', {
        key,
        className,
        'data-focus': member.pid === activePid ? '' : undefined,
        role: 'button',
        tabIndex: 0,
        title: `${member.name} · ${member.image || ''} · PID ${member.pid}`,
        onClick: () => onMember(member),
        onKeyDown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          onMember(member)
        },
      },
      h('div', { className: 'ss-trace-row-line' },
        h('span', { className: 'ss-trace-row-name' }, member.name),
        h('span', { className: 'ss-trace-row-cpu' }, fmtPct(member.current?.cpu))),
      h('div', { className: 'ss-trace-row-line ss-trace-row-sub' },
        h('span', null, `PID ${member.pid}`),
        h('span', null, fmtBytes(member.current?.memory)),
        member.exitedAt
          ? h('span', { className: 'ss-trace-member-exit' }, t('trace.exitedAt', { time: fmtClock(member.exitedAt) }))
          : null))

      const header = h('div', {
        key: 'trace-rail-header',
        className: 'ss-trace-row ss-trace-row-group',
        'data-focus': focus.kind === 'group' ? '' : undefined,
        role: 'button',
        tabIndex: 0,
        title: model.pid === null ? model.label : t('process.leadPid', { pid: model.pid }),
        onClick: onGroup,
        onKeyDown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          onGroup()
        },
      },
      h('div', { className: 'ss-trace-row-line' },
        model.hasChildren
          ? h('button', {
            type: 'button',
            className: 'ss-toggle',
            'aria-expanded': groupsOpen,
            'aria-label': groupsOpen ? t('process.collapse') : t('process.expand'),
            onClick: (event) => {
              event.stopPropagation()
              rail.toggleOpen()
            },
          }, CHEVRON_GLYPH)
          : null,
        h('span', { className: 'ss-trace-row-name' }, model.label),
        model.hasChildren ? h('span', { className: 'ss-trace-row-count' }, `(${model.count})`) : null,
        h('span', { className: 'ss-trace-row-cpu' }, fmtPct(model.cpu))),
      h('div', { className: 'ss-trace-row-line ss-trace-row-sub' },
        model.pid === null ? null : h('span', null, `PID ${model.pid}`),
        h('span', null, fmtBytes(model.memory)),
        model.exitedAt
          ? h('span', { className: 'ss-trace-member-exit' }, t('trace.exitedAt', { time: fmtClock(model.exitedAt) }))
          : null))

      const exitedRows = model.exitedTotal

      return h('aside', {
        className: 'ss-trace-rail',
        'data-narrow': narrow ? '' : undefined,
        role: 'group',
        'aria-label': t('trace.members', { count: model.total }),
      },
      h('div', { className: 'ss-trace-rail-head' },
        h('span', { className: 'ss-trace-rail-title' }, t('trace.members', { count: model.total })),
        h('button', {
          type: 'button',
          className: 'ss-trace-rail-toggle',
          title: t('trace.railCollapse'),
          'aria-label': t('trace.railCollapse'),
          onClick: () => rail.setCollapsed(true),
        }, '«')),
      model.total === 0
        ? h('div', { className: 'ss-trace-rail-empty' }, t('trace.noMembers'))
        : null,
      header,
      groupsOpen
        ? h('div', { className: 'ss-trace-children' }, model.children.map((member) =>
          memberRow(member, 'ss-trace-row ss-trace-row-child', `trace-child:${member.pid}`)))
        : null,
      model.others
        // Not a process, so it opens nothing: it is the sum of the live members
        // the Host did not send (only past the send budget). The title says so —
        // a row that looks clickable and does nothing is what a "N more" row
        // without an explanation reads as.
        ? h('div', {
          className: 'ss-trace-row ss-trace-row-others',
          title: t('trace.othersHint', { count: model.others.count }),
        },
        h('div', { className: 'ss-trace-row-line' },
          h('span', { className: 'ss-trace-row-name' }, t('trace.others', { count: model.others.count })),
          h('span', { className: 'ss-trace-row-cpu' }, fmtPct(model.others.cpu))),
        h('div', { className: 'ss-trace-row-line ss-trace-row-sub' },
          h('span', null, fmtBytes(model.others.memory))))
        : null,
      exitedRows === 0
        ? null
        : h('div', { className: 'ss-trace-exited', 'data-open': shownExited ? '' : undefined },
          h('button', {
            type: 'button',
            className: 'ss-trace-exited-head',
            'aria-expanded': shownExited,
            onClick: () => rail.toggleExited(),
          },
          h('span', null, t('trace.exited', { count: exitedRows })),
          h('span', { className: 'ss-trace-exited-caret', 'aria-hidden': true }, shownExited ? '▾' : '▸')),
          shownExited
            ? h('div', { className: 'ss-trace-exited-list' },
              model.exited.map((member) =>
                memberRow(member, 'ss-trace-row ss-trace-row-child ss-trace-row-exited', `trace-exited:${member.pid}`)),
              model.exitedMore > 0
                ? h('div', { className: 'ss-trace-row ss-trace-row-more' },
                  t('trace.exitedMore', { count: model.exitedMore }))
                : null)
            : null))
    }

    /**
     * The folded rail: a 24 px strip that still says what the page is looking at.
     *
     * It exists so that shrinking the rail can never end in "nothing left to
     * grab": the strip is one button, always visible, always clickable.
     */
    function TraceRailTab(props) {
      const { label, total, rail, t } = props
      return h('button', {
        type: 'button',
        className: 'ss-trace-rail-tab',
        title: `${t('trace.railExpand')} · ${label}`,
        'aria-label': t('trace.railExpand'),
        'aria-expanded': false,
        onClick: () => rail.setCollapsed(false),
      },
      h('span', { className: 'ss-trace-tab-arrow', 'aria-hidden': true }, '»'),
      h('span', { className: 'ss-trace-tab-glyph', 'aria-hidden': true }, initialOf(label)),
      h('span', { className: 'ss-trace-tab-label' }, label),
      h('span', { className: 'ss-trace-tab-count' }, String(total)))
    }

    /**
     * The process detail: a table, not a curve.
     *
     * The row set is what the trace actually holds — identity, memory, handles,
     * threads and I/O rates — plus the two fields (`createdAt`, `parentPid`) a
     * per-process detail read adds later; they appear on their own once the Host
     * sends them, and until then there is no row pretending to know.
     */
    function TraceDetail(props) {
      const { member, target, t, onBack } = props
      const current = member.current ?? {}
      const peak = member.peak ?? {}
      const average = member.average ?? {}
      const exited = Number.isFinite(member.exitedAt) && member.exitedAt > 0
      const rows = [{ group: t('trace.detailIdentity') }]
      const row = (label, value, note) => rows.push({ label, value, note })
      row(t('trace.detailName'), member.name || '—')
      row(t('trace.detailImage'), member.image || '—')
      row(t('trace.detailPid'), String(member.pid))
      if (Number.isInteger(member.parentPid)) row(t('trace.detailParent'), String(member.parentPid))
      row(t('trace.detailGroup'), target.label || '—')
      if (Number.isFinite(member.createdAt) && member.createdAt > 0) {
        row(t('trace.detailCreated'), fmtClock(member.createdAt))
        // "Running for" only makes sense against a known start; an exited
        // process has an end, a live one has the clock.
        const until = exited ? member.exitedAt : Date.now()
        row(t('trace.detailRuntime'), fmtDuration(until - member.createdAt))
      } else {
        row(t('trace.detailFirst'), fmtClock(member.firstAt))
        row(t('trace.detailWatched'), fmtDuration((exited ? member.exitedAt : member.lastAt) - member.firstAt))
      }
      rows.push({ group: t('trace.detailMemoryGroup') })
      // A peak the ring never saw is not a value: the note stays away rather
      // than printing "峰值 —" next to a row that does have a number.
      const peakNote = (text) => (text === null ? undefined : t('trace.detailPeakAt', { value: text }))
      row(t('trace.memory'), fmtBytes(current.memory),
        peakNote(Number.isFinite(peak.memory) ? fmtBytes(peak.memory) : null))
      row(t('trace.detailAverage'), fmtBytes(average.memory))
      rows.push({ group: t('trace.detailUsage') })
      row(t('trace.handles'), String(current.handleCount ?? '—'),
        peakNote(Number.isFinite(peak.handleCount) ? String(peak.handleCount) : null))
      row(t('trace.threads'), String(current.threadCount ?? '—'),
        peakNote(Number.isFinite(peak.threadCount) ? String(peak.threadCount) : null))
      row(t('trace.readRate'), fmtRate(current.ioReadPerSec))
      row(t('trace.writeRate'), fmtRate(current.ioWritePerSec))

      return h('div', { className: 'ss-trace-detail' },
        h('div', { className: 'ss-trace-detail-head' },
          h('div', { className: 'ss-trace-detail-title' },
            h('span', { className: 'ss-trace-detail-name' }, member.name || `PID ${member.pid}`),
            member.image ? h('span', { className: 'ss-trace-detail-image' }, member.image) : null,
            h('span', { className: 'ss-trace-detail-pid' }, `PID ${member.pid}`),
            exited
              ? h('span', { className: 'ss-trace-detail-exit' }, t('trace.exitedAt', { time: fmtClock(member.exitedAt) }))
              : null),
          h('button', {
            type: 'button',
            className: 'ss-ghost ss-trace-detail-back',
            onClick: onBack,
          }, t('trace.backToChart'))),
        h('table', { className: 'ss-trace-detail-table' },
          h('tbody', null, rows.map((entry, index) => (entry.group
            ? h('tr', { key: `group:${index}`, 'data-group': '' },
              h('th', { colSpan: 3 }, entry.group))
            : h('tr', { key: `row:${index}` },
              h('th', { scope: 'row' }, entry.label),
              h('td', null, entry.value),
              h('td', { className: 'ss-trace-detail-note' }, entry.note ?? '')))))),
        exited
          ? h('div', { className: 'ss-trace-detail-hint' }, t('trace.detailExitedHint'))
          : null)
    }

    /**
     * 追踪页（R27）：左边是组成员，右边是大图。
     *
     * 进页面不录：右键选目标只开预览，Host 在最后一个窗口离开 5 s 后自己清掉；
     * 点「开始录制」才留下历史，「停止追踪」把它冻住，「清空」连目标一起丢掉。
     * 缩放和平移只改窗口，Host 用全分辨率重新桶化，所以渲染永远是 ≤1200 点。
     * 左栏是「查看焦点」：点组头看整组，点子行看那个进程的详情表（详情顶替右侧大图，
     * 右上角「返回图表」回到该焦点的曲线）；换追踪目标仍然只有进程页的右键一个入口。
     */
    function TraceTab(props) {
      const { snapshot, runtime, t } = props
      const status = useSyncExternalStore(runtime.subscribeTrace, runtime.getTrace, runtime.getTrace)
      const view = useSyncExternalStore(runtime.traceView.subscribe, runtime.traceView.getSnapshot, runtime.traceView.getSnapshot)
      const railState = useSyncExternalStore(
        runtime.traceRail.subscribe,
        runtime.traceRail.getSnapshot,
        runtime.traceRail.getSnapshot,
      )
      const focus = useSyncExternalStore(
        runtime.traceFocus.subscribe,
        runtime.traceFocus.getSnapshot,
        runtime.traceFocus.getSnapshot,
      )
      // A pick the Host has not accepted yet (it would end a recording) lives
      // client-side only, and the page has to show the confirm instead of it.
      const pending = runtime.getPendingTrace()
      const active = status?.target ?? null
      const target = pending ?? active
      const mode = status?.mode ?? null
      const recording = mode === 'recording' && !pending
      const chart = pending ? null : (snapshot?.traceChart ?? null)
      const drag = React.useRef(null)
      // Strip drag state: read during render for the bubble, so it lives here.
      const ovDrag = React.useRef(null)
      // Rail drag state: the divider keeps its own, for the same reason.
      const railDrag = React.useRef(null)

      if (!target) {
        return h('div', { className: 'ss-trace-empty' },
          h('div', { className: 'ss-trace-empty-title' }, t('trace.empty')),
          h('div', { className: 'ss-trace-empty-hint' }, t('trace.emptyHint')))
      }

      const coverage = chart?.coverage ?? status?.coverage ?? null
      const latest = coverage && Number.isFinite(coverage.to) && coverage.to > 0 ? coverage.to : 0
      // Same window the runtime asks the Host for (see `traceBounds`): "all"
      // means the ring itself, following means the newest point on the right.
      const bounds = traceBounds(view, coverage, mode === 'preview' || mode === 'recording')
      const from = bounds.from
      const to = bounds.to
      /** How wide the window is right now; `all` is as wide as what it draws. */
      const spanNow = view.spanMs === null ? Math.max(1, to - from) : view.spanMs
      const members = chart?.members ?? { items: [], others: null, total: 0 }
      const aggregate = status?.aggregate ?? null
      const elapsed = status?.elapsedMs ?? 0
      /**
       * Ring length, straight from the Host. It is the one number that says
       * whether a chart is empty because the sampler stopped or because the page
       * drew it wrong: a 26 s recording at 1 Hz holds ~26 points, and five
       * segments across the width means five points, not five drawing errors.
       */
      const points = status?.points ?? 0
      const gapMs = traceGapMs(chart)
      const memoryMax = maxValue(chart?.memory)
      const ioMax = maxValue(chart?.io)
      const model = buildTraceRail(members, target.kind, target.label, aggregate)
      const focusedMember = focus.kind === 'process'
        ? (members.items ?? []).find((item) => item.pid === focus.pid) ?? null
        : null
      // A focus on a member this answer does not carry (a replaced target, a
      // preview that has not delivered yet) falls back to the charts; the rail
      // simply shows no focus mark until that row exists.
      const detail = focus.kind === 'process' ? focusedMember : null
      const stateKey = recording
        ? 'trace.recording'
        : pending
          ? 'trace.pending'
          : mode === 'stopped'
            ? 'trace.stopped'
            : 'trace.preview'

      const onPointerDown = (event) => {
        // In "all" there is nothing to pan: the window is the ring, and a drag
        // would silently turn it into a fixed span that stops covering it.
        if (!chart || view.spanMs === null) return
        const node = event.currentTarget
        const rect = node && typeof node.getBoundingClientRect === 'function'
          ? node.getBoundingClientRect()
          : null
        drag.current = { x: event.clientX, end: to, span: spanNow, width: rect?.width ?? 0 }
        if (node && typeof node.setPointerCapture === 'function' && Number.isInteger(event.pointerId)) {
          try { node.setPointerCapture(event.pointerId) } catch { /* pointer already gone */ }
        }
      }
      const onPointerMove = (event) => {
        const state = drag.current
        if (!state || !state.width) return
        const shift = ((state.x - event.clientX) / state.width) * state.span
        // No refetch per pointer move: the viewport moves at 60 Hz, the Host
        // answers at 1 Hz and re-reads on release.
        runtime.setTraceWindow(state.span, state.end - shift, false)
      }
      const onPointerUp = (event) => {
        if (!drag.current) return
        drag.current = null
        const node = event?.currentTarget
        if (node && typeof node.releasePointerCapture === 'function' && Number.isInteger(event?.pointerId)) {
          try { node.releasePointerCapture(event.pointerId) } catch { /* already released */ }
        }
        runtime.setTraceWindow(view.spanMs, view.endAt)
      }
      /** Let go of a captured pointer, whoever holds it. */
      function releaseRailCapture(node, pointerId) {
        if (node && typeof node.releasePointerCapture === 'function' && Number.isInteger(pointerId)) {
          try { node.releasePointerCapture(pointerId) } catch { /* already released */ }
        }
      }

      /**
       * Drag the divider. Below the narrowest rail the width stops shrinking and
       * the rail folds into its 24 px tab, which is always there to click: a rail
       * dragged to zero would leave nothing to grab.
       */
      const onRailDown = (event) => {
        const parent = event.currentTarget?.parentElement ?? null
        const room = parent && typeof parent.getBoundingClientRect === 'function'
          ? parent.getBoundingClientRect().width
          : 0
        railDrag.current = { x: event.clientX, width: railState.width, room }
        const node = event.currentTarget
        if (node && typeof node.setPointerCapture === 'function' && Number.isInteger(event.pointerId)) {
          try { node.setPointerCapture(event.pointerId) } catch { /* pointer gone */ }
        }
      }
      const onRailMove = (event) => {
        const state = railDrag.current
        if (!state) return
        const next = state.width + (event.clientX - state.x)
        if (next < TRACE_RAIL_MIN) {
          // The snap: no width below the floor, the folded tab instead.
          railDrag.current = null
          releaseRailCapture(event.currentTarget, event.pointerId)
          runtime.traceRail.setCollapsed(true)
          return
        }
        // The wide end is a share of the row, not a fixed number: on a narrow
        // panel 45 % is all the charts can spare.
        const max = state.room > 0 ? state.room * TRACE_RAIL_MAX_PCT : TRACE_RAIL_DEFAULT * 4
        runtime.traceRail.setWidth(Math.min(next, Math.max(TRACE_RAIL_MIN, max)))
      }
      const onRailUp = (event) => {
        if (!railDrag.current) return
        railDrag.current = null
        releaseRailCapture(event?.currentTarget, event?.pointerId)
      }
      const onClear = () => {
        // Clearing drops the target too, and it is global: ask first.
        const canAsk = typeof window !== 'undefined' && typeof window.confirm === 'function'
        if (canAsk && !window.confirm(t('trace.clearConfirm'))) return
        void runtime.clearTrace().catch(() => {})
      }

      // ── the range bar: the whole ring, with the window as its thumb ────────
      // It is always on screen — a full, immovable thumb is the honest answer to
      // "the ring is shorter than the window", and a missing bar looked broken.
      // It is a time bar, not a chart: no line under the thumb (that line never
      // said "this stretch was busy" in a way anyone read), four clock labels,
      // and the window as the thumb. The ring's extent is already in every
      // answer (`coverage`), so the bar needs no payload of its own.
      const ovFrom = Number.isFinite(coverage?.from) ? coverage.from : 0
      const ovTo = Number.isFinite(coverage?.to) ? coverage.to : 0
      const ovSpan = ovTo - ovFrom
      const ovReady = ovSpan >= TRACE_OVERVIEW_MIN
      const ovPercent = (time) => (ovSpan > 0 ? ((time - ovFrom) / ovSpan) * 100 : 0)
      // Nothing measured yet: draw a full track, then the thumb fills it.
      let blockLeft = 0
      let blockRight = 100
      if (ovReady) {
        blockLeft = Math.max(0, Math.min(100, ovPercent(from)))
        blockRight = Math.max(blockLeft, Math.min(100, ovPercent(to)))
        // A 60 s window on an 8 h ring is 0.2 % — thinner than the grips, and at
        // the tail it would hang off the strip. The floor is in percent because
        // CSS cannot know which edge to pull back.
        if (blockRight - blockLeft < TRACE_THUMB_MIN_PCT) {
          blockLeft = Math.min(blockLeft, 100 - TRACE_THUMB_MIN_PCT)
          blockRight = blockLeft + TRACE_THUMB_MIN_PCT
        }
      }
      const blockWidth = blockRight - blockLeft
      // Nothing to navigate only when the whole ring fits in the narrowest
      // window: then even a grip drag could not shrink anything. A full thumb
      // over a longer ring *is* "all" and keeps its grips, so it can be zoomed
      // back in.
      const ovLocked = !ovReady || (ovSpan > 0 && ovSpan <= TRACE_MIN_SPAN + TRACE_EDGE_MS)

      // Four evenly spaced labels — the bar is clock first, everything else
      // second. Below ten minutes the minutes would all read the same, so a
      // short ring keeps the seconds.
      const tickSpan = ovReady ? ovSpan : Math.max(1, to - from)
      const tickStart = ovReady ? ovFrom : from
      const ticks = [0, 1, 2, 3].map((index) =>
        fmtTickTime(tickStart + (tickSpan * index) / 3, tickSpan >= 600_000))

      /** The strip element under the pointer, for its pixel → time mapping. */
      const overviewRect = (event) => {
        const current = event?.currentTarget
        const node = current && typeof current.closest === 'function'
          ? (current.closest('.ss-trace-overview') ?? current)
          : current
        return node && typeof node.getBoundingClientRect === 'function'
          ? { node, rect: node.getBoundingClientRect() }
          : null
      }

      /**
       * Start a strip drag. `grip` is 'left' / 'right' / 'pan'; anywhere else on
       * the strip is a jump: the window centres on the click and then pans, so a
       * click gets you close and a drag fine-tunes without a second gesture.
       */
      const onOverviewDown = (grip) => (event) => {
        if (ovLocked) return
        // The stage under the strip pans the big charts; a strip gesture is not
        // that gesture.
        event.stopPropagation()
        const found = overviewRect(event)
        if (!found || !found.rect.width) return
        const perPx = (ovTo - ovFrom) / found.rect.width
        let startFrom = from
        let startTo = to
        if (grip === 'jump') {
          const at = ovFrom + (event.clientX - found.rect.left) * perPx
          // Centre on the click, but keep the whole window inside the strip when
          // it fits — otherwise the first drag would start from a clamped place.
          startFrom = Math.max(ovFrom, Math.min(at - spanNow / 2, ovTo - spanNow))
          startTo = startFrom + spanNow
        }
        ovDrag.current = {
          grip: grip === 'jump' ? 'pan' : grip,
          x: event.clientX,
          perPx,
          startFrom,
          startTo,
          width: found.rect.width,
        }
        if (typeof found.node.setPointerCapture === 'function' && Number.isInteger(event.pointerId)) {
          try { found.node.setPointerCapture(event.pointerId) } catch { /* pointer gone */ }
        }
        if (grip === 'jump') setRangeWindow(startFrom, startTo)
      }

      /**
       * Pulling an end past the edge of the ring means "all" — and it has to stay
       * "all" as the ring grows, so it is a mode (`spanMs: null`), not a span of
       * today's ring length.
       */
      const setRangeWindow = (nextFrom, nextTo) => {
        if (ovSpan > 0 && nextTo - nextFrom >= ovSpan - TRACE_EDGE_MS) {
          runtime.setTraceWindow(null, null, false)
          return
        }
        runtime.setTraceWindow(nextTo - nextFrom, nextTo, false)
      }

      const onOverviewMove = (event) => {
        const state = ovDrag.current
        if (!state) return
        const delta = (event.clientX - state.x) * state.perPx
        if (state.grip === 'left') {
          const limit = state.startTo - TRACE_MIN_SPAN
          const nextFrom = Math.min(limit, Math.max(ovFrom, state.startFrom + delta))
          setRangeWindow(nextFrom, state.startTo)
          return
        }
        if (state.grip === 'right') {
          const limit = state.startFrom + TRACE_MIN_SPAN
          const nextTo = Math.max(limit, Math.min(ovTo, state.startTo + delta))
          setRangeWindow(state.startFrom, nextTo)
          return
        }
        let shift = delta
        if (state.startFrom + shift < ovFrom) shift = ovFrom - state.startFrom
        if (state.startTo + shift > ovTo) shift = ovTo - state.startTo
        setRangeWindow(state.startFrom + shift, state.startTo + shift)
      }

      const onOverviewUp = (event) => {
        if (!ovDrag.current) return
        ovDrag.current = null
        const found = overviewRect(event)
        const node = found?.node
        if (node && typeof node.releasePointerCapture === 'function' && Number.isInteger(event?.pointerId)) {
          try { node.releasePointerCapture(event.pointerId) } catch { /* released */ }
        }
        // The viewport moved without a request; now ask for the data it needs.
        const settled = runtime.traceView.getSnapshot()
        runtime.setTraceWindow(settled.spanMs, settled.endAt)
      }

      const windowLabel = view.spanMs === null ? t('trace.fit') : fmtSpan(spanNow, t)
      const ovHint = ovDrag.current
        ? `${fmtClock(from)} ~ ${fmtClock(to)} · ${windowLabel}`
        : null

      // The group-level numbers live above the charts: the bottom of the panel is
      // the range bar, and nothing else.
      const infoRow = h('div', { className: 'ss-trace-info' },
        h('span', { className: 'ss-trace-chip' }, `${t('trace.handles')} ${aggregate?.handleCount ?? '—'}`),
        h('span', { className: 'ss-trace-chip' }, `${t('trace.threads')} ${aggregate?.threadCount ?? '—'}`),
        h('span', { className: 'ss-trace-chip' }, `${t('trace.read')} ${fmtRate(aggregate?.ioReadPerSec)}`),
        h('span', { className: 'ss-trace-chip' }, `${t('trace.write')} ${fmtRate(aggregate?.ioWritePerSec)}`),
        h('span', { className: 'ss-trace-chip', 'data-fit': view.spanMs === null ? '' : undefined },
          t('trace.span', { span: windowLabel })),
        // Only when there is something to say: a chip that always reads "0 s"
        // is noise, and a missing sampler is exactly what a broken-looking
        // curve needs to name.
        gapMs >= 2000
          ? h('span', { className: 'ss-trace-chip', 'data-gap': '' },
            t('trace.gap', { gap: (gapMs / 1000).toFixed(1) }))
          : null)

      /**
       * The range bar: the whole ring as a track, the window as its thumb, and
       * the clock underneath.
       *
       * It sits *inside* the chart column, not across the page: it is the
       * chart's clock, so it has to share the plot's width — a bar spanning the
       * member rail too read as a page-level slider with nothing to do with the
       * curves. For the same reason the plots carry no axis row of their own:
       * that would be the same clock twice.
       */
      const rangeBar = h('div', {
        className: 'ss-trace-range',
        // A drag on the bar is the bar's gesture, not a pan of the plot above.
        onPointerDown: (event) => event.stopPropagation(),
      },
      h('div', {
        className: 'ss-trace-overview',
        'data-static': ovLocked ? '' : undefined,
        'data-dragging': ovDrag.current ? '' : undefined,
        role: 'group',
        title: t('trace.overviewHint'),
        onPointerDown: onOverviewDown('jump'),
        onPointerMove: onOverviewMove,
        onPointerUp: onOverviewUp,
        onPointerCancel: onOverviewUp,
      },
      h('div', {
        className: 'ss-trace-overview-block',
        style: { left: `${blockLeft.toFixed(3)}%`, width: `${blockWidth.toFixed(3)}%` },
        onPointerDown: ovLocked ? undefined : onOverviewDown('pan'),
      },
      ovLocked
        ? null
        : h('span', {
          className: 'ss-trace-overview-grip',
          'data-grip': 'left',
          onPointerDown: onOverviewDown('left'),
        }),
      ovLocked
        ? null
        : h('span', {
          className: 'ss-trace-overview-grip',
          'data-grip': 'right',
          onPointerDown: onOverviewDown('right'),
        })),
      ovHint
        ? h('div', {
          className: 'ss-trace-overview-bubble',
          // Centred on the thumb, but pulled in at the ends so the text
          // never hangs off the panel.
          style: {
            left: `${Math.max(10, Math.min(90, blockLeft + blockWidth / 2)).toFixed(3)}%`,
          },
        }, ovHint)
        : null),
      h('div', { className: 'ss-trace-ticks', 'aria-hidden': true },
        ticks.map((label, index) =>
          h('span', { key: `trace-clock:${index}`, className: 'ss-trace-tick' }, label))))

      return h('div', { className: 'ss-trace' },
        h('div', { className: 'ss-trace-head' },
          h('div', { className: 'ss-trace-title' },
            h('span', { className: 'ss-trace-name' }, target.label || t('trace.target')),
            h('span', { className: 'ss-trace-state', 'data-recording': recording ? '' : undefined },
              t(stateKey)),
            h('span', { className: 'ss-trace-elapsed' },
              mode === null
                ? ''
                : `${t('trace.elapsed', { time: fmtDuration(elapsed) })} · ${t('trace.points', { count: points })}`)),
          h('div', { className: 'ss-trace-actions' },
            recording
              ? h('button', {
                type: 'button',
                className: 'ss-ghost',
                onClick: () => { void runtime.stopTrace().catch(() => {}) },
              }, t('trace.stop'))
              : h('button', {
                type: 'button',
                className: 'ss-trace-start',
                onClick: () => { void runtime.startTrace().catch(() => {}) },
              }, pending ? t('trace.replace') : t('trace.start')),
            h('button', {
              type: 'button',
              className: 'ss-ghost',
              disabled: recording,
              onClick: onClear,
            }, t('trace.clear')))),
        recording
          ? null
          : h('div', { className: 'ss-trace-hint' },
            h('span', null, pending
              ? t('trace.pendingReplacing', { label: active?.label ?? '' })
              : mode === 'stopped'
                ? t('trace.stoppedHint')
                : t('trace.previewHint')),
            pending
              ? h('button', {
                type: 'button',
                className: 'ss-ghost',
                onClick: () => { void runtime.applyTracePreview(pending).catch(() => {}) },
              }, t('trace.replacePreview'))
              : null,
            pending
              ? h('button', {
                type: 'button',
                className: 'ss-ghost',
                onClick: () => { runtime.selectTraceTarget(null) },
              }, t('trace.cancel'))
              : null),
        infoRow,
        h('div', {
          className: 'ss-trace-main',
          style: { '--ss-rail-w': `${railState.width}px` },
          'data-collapsed': railState.collapsed ? '' : undefined,
        },
        // The rail folds into one always-visible tab instead of shrinking to
        // nothing: a rail at 0 px has no handle left to bring it back.
        railState.collapsed
          ? h(TraceRailTab, {
            label: detail?.name ?? model.label,
            total: model.total,
            rail: runtime.traceRail,
            t,
          })
          : h(TraceRail, {
            model,
            focus,
            rail: runtime.traceRail,
            t,
            narrow: railState.width < TRACE_RAIL_NARROW,
            open: railState.open,
            exitedOpen: railState.exitedOpen,
            onGroup: () => runtime.traceFocus.group(),
            onMember: (member) => runtime.traceFocus.process(member.pid),
          }),
        railState.collapsed
          ? null
          : h('div', {
            className: 'ss-trace-divider',
            role: 'separator',
            'aria-orientation': 'vertical',
            title: t('trace.railResize'),
            'data-dragging': railDrag.current ? '' : undefined,
            onPointerDown: onRailDown,
            onPointerMove: onRailMove,
            onPointerUp: onRailUp,
            onPointerCancel: onRailUp,
            // Double-click puts the box back to its default width.
            onDoubleClick: () => runtime.traceRail.reset(),
          }),
        // The detail table takes over the large area; the rail (and the tree)
        // stays put, and "返回图表" goes back to the same focus's curve.
        detail
          ? h('section', { className: 'ss-trace-stage', 'data-detail': '' },
            h(TraceDetail, {
              member: detail,
              target,
              t,
              onBack: () => runtime.traceFocus.group(),
            }))
          : h('section', {
            className: 'ss-trace-stage',
            title: t('trace.zoomHint'),
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onPointerCancel: onPointerUp,
            onDoubleClick: () => runtime.followTrace(),
          },
          !chart || chart.cpu.length === 0
            ? h('div', { className: 'ss-trace-wait' }, t('trace.noData'))
            : h(React.Fragment, null,
              h('div', { className: 'ss-trace-charts' },
                h(TraceChart, {
                  values: chart.cpu,
                  max: 1,
                  color: ACCENT.cpu,
                  label: t('trace.cpu'),
                  readout: fmtPct(lastValue(chart.cpu)),
                  t0: chart.t0,
                  dt: chart.dt,
                  times: chart.times,
                  from,
                  to,
                }),
                h(TraceChart, {
                  values: chart.memory,
                  max: memoryMax === null ? 1 : Math.max(1, memoryMax * 1.08),
                  color: ACCENT.memory,
                  label: t('trace.memory'),
                  readout: fmtBytes(lastValue(chart.memory)),
                  t0: chart.t0,
                  dt: chart.dt,
                  times: chart.times,
                  from,
                  to,
                }),
                h(TraceChart, {
                  values: chart.io,
                  max: ioMax === null ? 1 : Math.max(1, ioMax * 1.08),
                  color: ACCENT.disk,
                  label: `${t('trace.io')}（${t('trace.read')} + ${t('trace.write')}）`,
                  readout: fmtRate(lastValue(chart.io)),
                  t0: chart.t0,
                  dt: chart.dt,
                  times: chart.times,
                  from,
                  to,
                })),
              rangeBar))))
    }

    function SystemPanel(props) {
      const runtime = props.runtime
      const t = runtime.t
      const tab = useSyncExternalStore(runtime.tabs.subscribe, runtime.tabs.getSnapshot, runtime.tabs.getSnapshot)
      // The loop and its buffers live in the runtime, so this component only
      // renders one view: mounting does not start sampling and unmounting (the
      // layout drops a deselected page) does not stop it.
      const view = useSyncExternalStore(runtime.subscribe, runtime.getView, runtime.getView)
      const snapshot = view.snapshot
      const error = view.error
      // A group that has not finished its first sample yet reports `starting`;
      // that is startup, not degradation, so it never reaches the footer.
      const degraded = (snapshot?.degraded ?? [])
        .filter((entry) => entry.reason !== 'starting' && entry.reason !== 'not-started')

      return h('div', {
        className: 'ss-panel',
        'data-dsh-plugin': PANEL_ID,
      },
        h('style', null, CSS),
        h('div', { className: 'ss-header' },
          h('button', {
            type: 'button',
            className: 'ss-back',
            'data-dsh-center-view-back': '',
            'aria-label': t('panel.back'),
            onClick: () => { runtime.close() },
          },
          h('span', { className: 'ss-back-glyph', 'aria-hidden': true }, '‹'),
          h('span', null, t('panel.back'))),
          h('h2', { className: 'ss-title' }, t('panel.title'))),
        h('div', { className: 'ss-tabs', role: 'tablist', 'data-dsh-part': 'tab-bar' },
          TABS.map((entry) => h('button', {
            key: entry.id,
            type: 'button',
            role: 'tab',
            id: `ss-tab-${entry.id}`,
            'aria-controls': `ss-tabpanel-${entry.id}`,
            'aria-selected': tab === entry.id,
            'data-dsh-part': 'tab',
            'data-active': tab === entry.id ? '' : undefined,
            className: 'ss-tab',
            onClick: () => runtime.tabs.set(entry.id),
          }, t(entry.label)))),
        h('div', {
          className: 'ss-body',
          role: 'tabpanel',
          id: `ss-tabpanel-${tab}`,
          'aria-labelledby': `ss-tab-${tab}`,
        },
        error === null
          ? null
          : h('div', { className: 'ss-error', role: 'alert' },
            h('span', null, t('error.failed', { message: error })),
            h('button', {
              type: 'button',
              className: 'ss-ghost',
              onClick: () => {
                // One immediate attempt instead of waiting for the next tick.
                runtime.retry()
              },
            }, t('action.retry'))),
        tab === 'performance'
          ? h(PerformanceTab, { snapshot, runtime, t })
          : tab === 'processes'
            ? h(ProcessTab, { snapshot, runtime, t })
            : tab === 'trace'
              ? h(TraceTab, { snapshot, runtime, t })
              : h(DiskTab, { snapshot, t })),
        degraded.length === 0
          ? null
          : h('div', { className: 'ss-degraded' },
            `${t('section.degraded')}：`,
            degraded.map((entry) => h('span', { key: entry.field, style: { marginRight: 8 } },
              h('span', { className: 'ss-degraded-field' }, entry.field),
              `（${entry.reason}）`))))
    }

    /**
     * Fallback for the two surfaces that can mount before the runtime is handed
     * to them. Hooks must run unconditionally, so the store is swapped instead
     * of the hook being skipped.
     */
    const NO_TRACE_STORE = { subscribeTrace: () => () => {}, getTrace: () => null }

    /**
     * The runtime is created once in `apply`, but only the `main` slot receives
     * it as a prop. The rail icon and the overlay badge read it from here; a
     * per-registration `inject` would be a nicer contract, but a slot that does
     * not understand the option must never be able to take the rail entry down.
     */
    let runtimeRef = null

    /**
     * Application-level recording badge. It must not live in a conversation
     * slot: opening the panel or switching sessions unmounts those, and the
     * recording would continue with nothing on screen saying so (the exact
     * failure the badge exists to prevent). `shell.overlay` is the surface that
     * stays mounted, and the left-rail dot covers the panel-open case.
     */
    function TraceBadge(props) {
      const runtime = props?.runtime ?? runtimeRef
      const source = runtime ?? NO_TRACE_STORE
      const status = useSyncExternalStore(source.subscribeTrace, source.getTrace, source.getTrace)
      if (!runtime || !status?.recording) return null
      return h(React.Fragment, null,
        h('style', null, BADGE_CSS),
        h('button', {
          type: 'button',
          className: 'ss-badge',
          title: runtime.t('trace.badge', { label: status?.target?.label ?? '' }),
          onClick: () => runtime.openTrace(),
        },
        h('span', { className: 'ss-badge-dot', 'aria-hidden': true }),
        h('span', { className: 'ss-badge-text' },
          runtime.t('trace.badge', { label: status?.target?.label ?? '' })),
        h('span', { className: 'ss-badge-time' }, fmtDuration(status.elapsedMs))))
    }

    function SystemIcon(props) {
      // Pure on purpose: the rail entry is the one thing this plugin cannot
      // afford to lose, and the wrapper/hook version of the recording dot made
      // it vanish (the rail identifies an entry by `data-dsh-panel-entry` on the
      // root element). The recording indicator is the app-level badge; the dot
      // comes back only with a subscription mechanism the rail actually re-renders on.
      return h('svg', {
        viewBox: '0 0 16 16',
        width: props?.size ?? 16,
        height: props?.size ?? 16,
        'data-dsh-panel-entry': PANEL_ID,
        'aria-hidden': true,
        style: { display: 'block' },
      },
      h('path', {
        d: 'M2 9h3l1.5-4 2 7L10 9h4',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }))
    }

    /**
     * Test seam.
     *
     * The formatters and the grouping/layout helpers are pure functions with no
     * DOM and no React, but they live inside this module's closure, so a Node
     * test can only reach them through the DOM or not at all. Publishing them
     * when a test asks makes boundary cases (1023 vs 1024 bytes, a missing CPU
     * value, a group whose lead is not its busiest member) checkable directly.
     * Nothing is exported unless the global is set before the module loads.
     */
    if (typeof globalThis !== 'undefined' && globalThis.__DSH_SNIFFER_TEST__) {
      Object.assign(globalThis.__DSH_SNIFFER_TEST__, {
        fmtPct,
        fmtBytes,
        fmtRate,
        fmtDuration,
        fmtClock,
        compareNumbers,
        groupProcesses,
        sortGroups,
        squarify,
        traceBounds,
        mergeTrace,
        toTraceChart,
        traceGapMs,
        TraceChart,
      })
    }

    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        const t = createTranslate(ctx)
        const runtime = createRuntime(ctx, t)
        // The rail icon and the badge read this; only `main` gets props.
        runtimeRef = runtime
        // Each seat is guarded on its own. These names are DSH's, not ours: a
        // slot renamed by a later release must cost one seat (and one warning),
        // not the whole plugin — an exception thrown out of `apply` unmounts
        // both, and the user sees the entry disappear with no explanation.
        try {
          ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
            inject: () => ({ runtime }),
          }, SystemPanel))
        } catch (error) {
          console.warn('[system-sniffer] main panel slot unavailable:', error)
        }
        try {
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 1,
            label: () => t('entry.label'),
          }, SystemIcon))
        } catch (error) {
          console.warn('[system-sniffer] sidebar entry unavailable:', error)
        }
        // The badge lives on the shell overlay: it must stay visible while the
        // user is in a conversation, and a conversation slot unmounts when the
        // panel opens or the session changes. Guarded because an unrecognised
        // slot must never be able to take the rail entry down with it.
        try {
          ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay',
            id: 'system-sniffer.trace',
          }, TraceBadge))
        } catch (error) {
          console.warn('[system-sniffer] overlay badge unavailable:', error)
        }
      },
    }
  },
})
