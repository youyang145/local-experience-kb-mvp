# dsh-plugin-local-kb（MVP）

给 DSH 模型三个工具，库逻辑打包在 `lib/kb/`，不依赖外部路径。

| 工具 | 干什么 | 写不写库 |
|---|---|---|
| `kb_consult` | 先判要不要查（闲聊跳过），返回索引摘要 + 命中简介 + 反例警示 | 不写 |
| `kb_index` | 只看分区目录：分区 + 条数 + 每区两条标题 | 不写 |
| `kb_stage` | 把材料分块放进「待分区」收件箱，附候选分区；一次最多 5 块 | 只写收件箱，不写主库 |

## 安装

```powershell
dsh plugin --profile <你的 profile> add "F:\大项目开发\dsh插件本地知识库\plugin-mvp" `
  --ignore-workspace-root-check `
  --store-dir "F:\大项目开发\_归档\pnpm-store"
```

- `--store-dir` 必须指到可写目录，否则 pnpm 会去写默认 store 然后报错；
- 装完 `dsh --profile <你的 profile> --dump-config` 里能看到 `id: local-kb`。

`cordis.patch.yml` 只需要一个 `home`（知识库根目录，含 `index.db`）。

## 本地验证

```bash
node harness.mjs
```

不装 DSH，用假 ctx 跑三个工具：查库、目录、放进待分区（临时库）。

## 打包

```bash
npm pack
```

`files` 里已包含 `lib/**/*.mjs`；如果 npm 缓存不可写，加 `--cache <可写目录>`。

## 设计约束

- **不依赖 `@deepseek-ai/dsh-tools`**：工具描述直接用注册表认的 JSON Schema 形状；
- **写只写收件箱**：AI 不能直接进主库，人再把块挪到正式分区；
- **库逻辑随插件打包**：`lib/kb` 是 `dsh-kb/src` 的拷贝，发布时同步一次（当前 v0.3.0）。

## 限制

- 没有 client 半端，面板仍是独立的 7788 服务；
- 还没做到"每轮自动注入索引"，现在是模型主动调 `kb_consult` / `kb_index`；
- `kb_add`（直接写正式分区）故意没做。
