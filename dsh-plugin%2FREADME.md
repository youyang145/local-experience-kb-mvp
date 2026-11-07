# DSH 适配器 · dsh-plugin-local-kb

> **骨架（设计与规范）**：[youyang145/local-experience-kb](https://github.com/youyang145/local-experience-kb)
> **参考实现（核心库 + 面板）**：[youyang145/local-experience-kb-mvp](https://github.com/youyang145/local-experience-kb-mvp)
> 本目录是它的 **DeepSeek Harness 宿主适配器**：把库接进 DSH 的工具、系统提示和右下角挂件。

## 它做了什么

| 能力 | 说明 |
|---|---|
| 5 个工具 | `kb_consult` / `kb_index` / `kb_stage` / `kb_record` / `kb_recommend` |
| 每轮索引 | `systemPrompt.section` 注入分区目录与召回规则，压缩不会盖掉 |
| 右下角挂件 | K 按钮 → 可拖动/缩放的面板小窗；待拍板入口 |
| 面板服务 | 懒启动 7788，不随 DSH 启动占端口 |
| MCP | 面板里的开关，`POST /mcp`，四个工具 + 连接编号 + 留痕 |

## 工具边界

| 工具 | 干什么 | 写不写库 |
|---|---|---|
| `kb_consult` | 先判要不要查（闲聊跳过），返回索引摘要 + 命中简介 + 反例警示 | 不写 |
| `kb_index` | 只看分区目录 | 不写 |
| `kb_stage` | 材料分块放进「待分区」收件箱，最多 5 块 | 只写收件箱 |
| `kb_record` | 套用/复现记账（used / succeeded / occurrences） | 只改计数 |
| `kb_recommend` | 建议转正/推翻，必须带理由 | 只进「待拍板」，人决定 |

## 安装

从 MVP 仓库安装：

```powershell
dsh plugin --profile <你的 profile> add "https://github.com/youyang145/local-experience-kb-mvp.git" --ignore-workspace-root-check
```

或者本地目录：

```powershell
dsh plugin --profile <你的 profile> add "<仓库>\dsh-plugin" `
  --ignore-workspace-root-check `
  --store-dir "<可写目录>"
```

- `--store-dir` 指向可写目录，否则 pnpm 写默认 store 会报错；
- 装完 `dsh --profile <你的 profile> --dump-config` 里能看到 `id: local-kb`；
- 重启 DSH 生效。

## 配置

`cordis.patch.yml` 只需要一个 `home`（库根目录，含 `index.db`）：

```yaml
- insert:
    - id: local-kb
      name: 'dsh-plugin-local-kb'
      config:
        home: 'F:\path\to\kb-data'
```

## 本地验证

```bash
node harness.mjs     # 假 ctx，跑五个工具
```

## 打包

```bash
npm pack             # files 已包含 lib/**、lib/web/**、widget.js
```

`lib/kb` 是核心库的打包副本，随插件发布同步一次；不是第二套维护。

## 限制

- 面板仍是独立进程（7788），懒启动；
- 自动索引只到"目录 + 召回规则"，正文仍要 `kb_consult`；
- 主库写入只由人在面板操作，工具没有直接写主库的权限。
