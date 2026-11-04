# 算力卡调度台（AI Compute Scheduling Platform）

面向多人共用的推理节点算力卡（GPU/NPU）自助预约与占用看板。纯 Node.js 原生 `http` 服务 + 原生 HTML/CSS/JS 前端，零依赖，一条命令启动。

## 功能特性

- **按卡预约**：每个推理节点 8 张卡，可申请 1 / 2 / 4 / 8 张，或直接点某张空闲卡单独申请
- **预约制，不排队**：预约开始前不占用资源，到点自动生效；没有预约的空档支持直接占用
- **最多提前 48 小时**、单次最长 48 小时；跨过 24:00 自动刷新当天预约
- **当天时间轴**：每个节点右侧一条 0:00–24:00 时间轴，一张卡一行（卡 0 → 卡 7），条形长度即占用时段
  - 已过期的时段整条置灰，进行中的按人上色，每人固定色相，避免撞色
  - 点击条形可查看整组预约详情并释放
- **释放凭证**：占用时下发 `ownerToken`，只回传申请人浏览器；别人即使知道姓名也无法释放
- **实时同步**：前端 2.5 秒轮询 `/api/state`，数据未变化时不做任何 DOM 重绘，界面不闪
- **持久化**：状态写入 `data/state.json`（临时文件 + rename 原子替换），重启不丢数据

## 快速开始

需要 Node.js 16+（无第三方依赖，无需 `npm install`）。

```bash
node server.js
# 或
npm start
```

浏览器打开 <http://localhost:8787>。

自定义端口：

```bash
PORT=9000 node server.js          # macOS / Linux
$env:PORT=9000; node server.js     # Windows PowerShell
```

## 使用流程

1. 首次打开先输入使用人姓名（保存在浏览器 `localStorage`，可随时切换）
2. 点击「+ 新增节点」，填写节点 IP、密码、机型，节点编号从 0 开始自动生成
3. 点击空闲卡 → 选择时长（30 分钟 ~ 48 小时）与用途 → 提交；也可用节点底部的「预约 / 占用」批量选卡
4. 预约开始时间可选「立即」或未来 48 小时内任意时刻
5. 在右侧时间轴点击自己那条 → 「释放这组预约」

## 目录结构

```
.
├── server.js            # HTTP 服务：静态资源、调度逻辑、JSON 持久化
├── public/
│   ├── index.html       # 页面骨架
│   ├── styles.css       # 全部样式（含时间轴、弹层、滑轮时间选择器）
│   └── app.js           # 全部前端逻辑（状态轮询、渲染、申请/释放交互）
├── data/state.json      # 运行时状态（已 gitignore，首次启动自动创建）
└── package.json
```

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 返回服务器时间、卡位、预约上限与全部节点/预约（自动清理过期记录） |
| POST | `/api/occupy` | 申请/占用算力卡 |
| POST | `/api/release` | 释放一组预约（需 `groupId` + `ownerToken`）或某张卡 |
| POST | `/api/machines` | 新增推理节点 |

### `POST /api/occupy`

```json
{
  "user": "张三",
  "machineId": "node-0",
  "count": 2,
  "durationMs": 7200000,
  "startAt": 1730880000000,
  "note": "推理压测"
}
```

- `machineId` 可为 `"any"`（自动挑节点）；也可传 `gpuIndexes: [2, 3]` 精确指定卡号
- `count` 仅支持 `1 / 2 / 4 / 8`；`durationMs` 需在 5 分钟 ~ 48 小时之间
- `startAt` 省略即立即开始，最多提前 48 小时
- 成功返回 `groupId` 与 `ownerToken`（仅此一次下发，前端存 `localStorage`）

### `POST /api/release`

```json
{ "user": "张三", "machineId": "node-0", "groupId": "…", "token": "…" }
```

凭证不匹配返回 `403`；预约不存在或已结束返回 `404`。

## 数据模型

```jsonc
{
  "machines": [
    {
      "id": "node-0",
      "index": 0,
      "name": "推理节点 0",
      "ip": "10.0.0.11",
      "model": "Ascend 910B",
      "gpus": [
        {
          "id": 0,
          "bookings": [
            {
              "id": "…",            // 单卡记录 id
              "groupId": "…",       // 一次多卡申请共享
              "ownerToken": "…",    // 不下发给其他客户端
              "user": "张三",
              "note": "推理压测",
              "count": 2,
              "startAt": 1730880000000,
              "endAt": 1730887200000
            }
          ]
        }
      ]
    }
  ]
}
```

## 说明

- 当前为单机内存态 + 单文件持久化，适合小团队内网使用；多实例部署需换成共享存储/数据库
- 节点密码仅用于记录接入信息，服务不会主动连接节点；对外接口不会回传密码
- 清理策略：只删除「今天 0:00 之前」结束的记录，当天已结束的预约保留到次日 0:00，用于展示完整时间轴

## License

Private project. All rights reserved.
