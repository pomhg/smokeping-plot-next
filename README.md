# smokeping-plot-next

一个面向局域网的延迟/丢包监测工具，复刻 [SmokePing](https://oss.oetiker.ch/smokeping/) 的核心思路：
每轮对目标发送 N 个探测包，用"烟雾图"展示延迟分布（中位数 + 分位区间），并用颜色表示丢包率。

单个二进制文件内嵌前端，SQLite 存储，`docker compose up` 即可部署；Web UI 同时适配桌面与手机，
可直接在页面上增删监控节点。

*A self-contained SmokePing-style latency monitor: Go backend (ICMP/TCP multi-ping probes, SQLite,
REST + SSE), React web UI with smoke graphs, responsive for desktop and mobile.*

## 功能

- **探测**：ICMP ping（纯 Go 实现，无需 fping）与 TCP connect；每轮 N 次（默认 20），间隔可配
- **烟雾图**：min–max 与 25–75% 分位烟雾带、按丢包率着色的中位数线、底部丢包条；对数坐标、拖拽缩放、hover/触摸提示
- **多分辨率归档**：原始样本保留 30 天，小时级汇总保留 2 年（类似 RRD 的多级 RRA），长时间范围自动切换
- **实时更新**：SSE 推送，新样本秒级出现在页面上
- **节点管理**：Web UI 添加 / 编辑 / 删除 / 暂停节点，支持分组、批量添加、添加前测试连通性
- **响应式 UI**：桌面卡片网格，手机单列 + 底部抽屉表单；深色 / 浅色主题跟随系统；中英文界面
- **部署简单**：单二进制 + SQLite；Docker 镜像约 20 MB；可选 HTTP Basic Auth

## 快速开始

### Docker Compose（推荐）

```bash
git clone https://github.com/pomhg/smokeping-plot-next.git
cd smokeping-plot-next
docker compose up -d --build
```

浏览器打开 `http://<监测机IP>:8080`，点击右上角「添加节点」。数据保存在 `./data/`。

### 直接运行二进制

需要 Go ≥ 1.23 与 Node ≥ 20：

```bash
make build            # 构建前端并编译到 bin/smokeping-plot-next
./bin/smokeping-plot-next
```

ICMP 需要原始套接字权限。Linux 下三选一：

```bash
sudo ./bin/smokeping-plot-next                                    # root
sudo setcap cap_net_raw+ep bin/smokeping-plot-next                # 或授予 capability
sudo sysctl -w net.ipv4.ping_group_range="0 2147483647"           # 或允许非特权 ICMP
```

macOS 上非特权 ICMP 开箱即用。程序启动时会自动检测可用的套接字模式（`PROBE_PRIVILEGED=auto`）。

## 配置

全部通过环境变量（或 `-listen` / `-data` 参数）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `LISTEN` | `:8080` | 监听地址 |
| `DATA_DIR` | `./data` | SQLite 数据目录 |
| `DEFAULT_STEP` | `60` | 新节点默认探测间隔（秒） |
| `DEFAULT_PINGS` | `20` | 新节点每轮默认探测次数 |
| `PING_INTERVAL` | `500ms` | 同一轮内两次探测之间的间隔 |
| `PING_TIMEOUT` | `2s` | 单次探测超时 |
| `PROBE_PRIVILEGED` | `auto` | ICMP 套接字模式：`auto` / `true`（raw）/ `false`（UDP） |
| `RAW_RETENTION_DAYS` | `30` | 原始样本保留天数 |
| `ROLLUP_RETENTION_DAYS` | `730` | 小时级汇总保留天数 |
| `AUTH_USER` / `AUTH_PASS` | 空 | 同时设置则开启 HTTP Basic Auth |
| `LOG_LEVEL` | `info` | `debug` 打印每个 API 请求 |
| `TZ` | 系统 | 时区（仅影响日志；图表使用浏览器本地时区） |

每个节点可单独设置探测方式、端口、间隔与每轮次数。

## 界面

- **总览**：按分组显示所有节点，每张卡片有当前中位数 / 丢包率与最近 1h–7d 的迷你烟雾图；支持搜索与分组筛选
- **节点详情**：1h ～ 1y 时间范围、拖拽缩放、对数坐标、区间统计（平均中位数、min/max、丢包、可用率）
- **添加节点**：主机栏可粘贴多行 / 逗号分隔的地址一次批量添加；「测试」按钮即时探测 5 次

## API

前端使用的 REST 接口，也可以直接调用：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/targets` | 节点列表（含最新一轮结果） |
| `POST` | `/api/targets` | 新建 `{name, host, group, probe, port, step, pings, enabled}` |
| `PUT` | `/api/targets/{id}` | 更新 |
| `DELETE` | `/api/targets/{id}` | 删除（含历史数据） |
| `GET` | `/api/targets/{id}/series?from=&to=&points=` | 聚合时间序列（unix 秒；自动选择原始/汇总表） |
| `GET` | `/api/series?ids=1,2&from=&to=&points=` | 多节点批量序列 |
| `POST` | `/api/probe` | 一次性探测 `{host, probe, port, count}` |
| `GET` | `/api/events` | SSE：`sample`（新样本）、`targets`（节点变更） |
| `GET` | `/api/config`, `/api/stats` | 运行配置与计数 |

序列中的每个点：`{ts, sent, recv, loss, min, p25, median, p75, max, avg}`（毫秒；无应答时为 `null`）。

## 开发

```bash
make dev-api     # 终端 1：go run，监听 :8080
make dev-web     # 终端 2：Vite 开发服务器 :5173，/api 代理到 :8080
```

目录结构：

```
cmd/smokeping-plot-next/   入口
internal/config/           环境变量配置
internal/probe/            ICMP / TCP 探测（pro-bing）
internal/scheduler/        按 step 对齐的探测循环
internal/store/            SQLite：targets / samples / rollups
internal/api/              REST、SSE、静态文件
web/                       React + TypeScript + Vite 前端（构建后嵌入二进制）
```

## 与 SmokePing 的对应关系

| SmokePing | smokeping-plot-next |
|---|---|
| `step` / `pings` | 每节点 `step` / `pings` |
| FPing / TCPPing 探针 | `icmp` / `tcp` |
| RRD 多级 RRA | `samples`（原始）+ `rollups`（小时） |
| 烟雾图（median 线 + smoke） | Canvas 绘制的 min–max / p25–p75 烟雾 + 按丢包着色的中位数 |
| 配置文件 Targets 段 | Web UI 增删改，存于 SQLite |

## License

MIT
