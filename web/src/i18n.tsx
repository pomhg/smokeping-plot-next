import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export type Lang = 'en' | 'zh';

const dict = {
  en: {
    appName: 'smokeping-plot-next',
    overview: 'Overview',
    addTarget: 'Add target',
    editTarget: 'Edit target',
    deleteTarget: 'Delete target',
    deleteConfirm: 'Delete "{name}" and all of its history? This cannot be undone.',
    cancel: 'Cancel',
    save: 'Save',
    create: 'Create',
    delete: 'Delete',
    test: 'Test',
    testing: 'Testing…',
    name: 'Name',
    host: 'Host',
    hostHint: 'Hostname or IP. Add several at once by separating with commas or new lines.',
    group: 'Group',
    groupHint: 'Free-form label used to group targets on the overview.',
    probe: 'Probe',
    icmp: 'ICMP ping',
    tcp: 'TCP connect',
    port: 'Port',
    step: 'Interval (s)',
    stepHint: 'Seconds between rounds.',
    pings: 'Pings per round',
    enabled: 'Enabled',
    disabled: 'Disabled',
    paused: 'Paused',
    search: 'Search targets…',
    allGroups: 'All',
    ungrouped: 'Ungrouped',
    noTargets: 'No targets yet',
    noTargetsHint: 'Add a router, a server or a public DNS resolver to start collecting latency data.',
    noMatch: 'No targets match your filter.',
    noData: 'No data yet',
    waiting: 'Waiting for first probe…',
    unreachable: 'Unreachable',
    loss: 'Loss',
    median: 'Median',
    min: 'Min',
    max: 'Max',
    avg: 'Avg',
    availability: 'Availability',
    lastUpdate: 'Last update',
    range: 'Range',
    live: 'Live',
    reset: 'Reset',
    logScale: 'Log scale',
    zoomHint: 'Drag on the chart to zoom in',
    theme: 'Theme',
    language: 'Language',
    connected: 'Live',
    disconnected: 'Reconnecting…',
    back: 'Back',
    notFound: 'Target not found',
    lossLegend: 'Median colour by packet loss',
    smokeLegend: 'Smoke: min–max (light) and 25–75 % (dark) of each round',
    every: 'every {step}s, {pings} pings',
    resultOk: '{recv}/{sent} replies, median {median}',
    resultFail: 'No reply ({sent} sent)',
    ago: '{t} ago',
    justNow: 'just now',
    error: 'Error',
    about: 'About',
    retention: 'Raw samples kept {raw} days, hourly rollups {rollup} days.',
    samples: 'samples',
    targetsCount: '{n} targets',
    settings: 'Settings',
    system: 'System',
    light: 'Light',
    dark: 'Dark',
    bulkCreated: 'Created {n} targets',
    createdOne: 'Created {name}',
    saved: 'Saved',
    deleted: 'Deleted',
    dropHere: 'Drop here',
    orderSaved: 'Order saved',
  },
  zh: {
    appName: 'smokeping-plot-next',
    overview: '总览',
    addTarget: '添加节点',
    editTarget: '编辑节点',
    deleteTarget: '删除节点',
    deleteConfirm: '删除“{name}”及其全部历史数据？此操作不可撤销。',
    cancel: '取消',
    save: '保存',
    create: '创建',
    delete: '删除',
    test: '测试',
    testing: '测试中…',
    name: '名称',
    host: '主机',
    hostHint: '主机名或 IP。用逗号或换行分隔可一次添加多个。',
    group: '分组',
    groupHint: '任意文本，用于在总览页分组显示。',
    probe: '探测方式',
    icmp: 'ICMP ping',
    tcp: 'TCP 连接',
    port: '端口',
    step: '间隔 (秒)',
    stepHint: '每轮探测之间的秒数。',
    pings: '每轮次数',
    enabled: '启用',
    disabled: '停用',
    paused: '已暂停',
    search: '搜索节点…',
    allGroups: '全部',
    ungrouped: '未分组',
    noTargets: '还没有监控节点',
    noTargetsHint: '添加路由器、服务器或公共 DNS，开始收集延迟数据。',
    noMatch: '没有符合筛选条件的节点。',
    noData: '暂无数据',
    waiting: '等待首次探测…',
    unreachable: '不可达',
    loss: '丢包',
    median: '中位数',
    min: '最小',
    max: '最大',
    avg: '平均',
    availability: '可用率',
    lastUpdate: '最近更新',
    range: '时间范围',
    live: '实时',
    reset: '重置',
    logScale: '对数坐标',
    zoomHint: '在图上拖动可放大',
    theme: '主题',
    language: '语言',
    connected: '实时',
    disconnected: '重连中…',
    back: '返回',
    notFound: '未找到该节点',
    lossLegend: '中位数线颜色表示丢包率',
    smokeLegend: '烟雾：每轮的最小–最大（浅）和 25–75%（深）区间',
    every: '每 {step} 秒，{pings} 次',
    resultOk: '{recv}/{sent} 应答，中位数 {median}',
    resultFail: '无应答（已发送 {sent}）',
    ago: '{t}前',
    justNow: '刚刚',
    error: '错误',
    about: '关于',
    retention: '原始样本保留 {raw} 天，小时汇总保留 {rollup} 天。',
    samples: '样本',
    targetsCount: '{n} 个节点',
    settings: '设置',
    system: '跟随系统',
    light: '浅色',
    dark: '深色',
    bulkCreated: '已创建 {n} 个节点',
    createdOne: '已创建 {name}',
    saved: '已保存',
    deleted: '已删除',
    dropHere: '拖到这里',
    orderSaved: '排序已保存',
  },
} as const;

export type Key = keyof typeof dict.en;

const KEY = 'spn.lang';

function detect(): Lang {
  try {
    const s = localStorage.getItem(KEY);
    if (s === 'en' || s === 'zh') return s;
  } catch {
    /* ignore */
  }
  return /^zh/i.test(navigator.language) ? 'zh' : 'en';
}

interface I18n {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (k: Key, vars?: Record<string, string | number>) => string;
}

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detect);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(KEY, l);
    } catch {
      /* ignore */
    }
    document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en';
  }, []);
  const t = useCallback(
    (k: Key, vars?: Record<string, string | number>) => {
      let s: string = dict[lang][k] ?? dict.en[k] ?? k;
      if (vars) for (const [name, v] of Object.entries(vars)) s = s.replace(`{${name}}`, String(v));
      return s;
    },
    [lang],
  );
  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error('I18nProvider missing');
  return v;
}
