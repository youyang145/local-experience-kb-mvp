# 本地经验库 · 参考实现（MVP）

> **先读骨架**：设计与规范在 [youyang145/local-experience-kb](https://github.com/youyang145/local-experience-kb)。
> 那个仓库回答"应该怎么设计"，这个仓库回答"跑起来长什么样"。

这是一个本地优先经验库的**可运行参考实现**：知识可查、经验会记账、反例会警示、写入要人审。
零运行时依赖，只要 Node 22+。

## 30 秒跑起来

```bash
git clone https://github.com/youyang145/local-experience-kb-mvp.git
cd local-experience-kb-mvp
node bin/kb.mjs init
node bin/kb.mjs add --title "示例：长路径要开长路径支持" --domain 工具/Windows --body "超过 260 字符会失败。"
node bin/kb.mjs search 长路径
node bin/kb.mjs serve          # 打开 http://127.0.0.1:7788
```

## 它能做什么

| 能力 | 说明 |
|---|---|
| 存 | 一条知识/经验 = 一个 Markdown 文件，SQLite 只做索引 |
| 查 | 索引摘要 → 按需检索 → 读正文，三层 |
| 记 | 经验有账：用过、成了、复现、补充、人票 |
| 判 | AI 提案必须带理由，人一票决定；推翻保留为反例 |
| 接 | MCP：`POST /mcp`，四个工具，带连接编号与留痕 |
| 备 | 整库 zip 备份；恢复分增量/覆盖，二次确认 |

## 命令

```bash
kb init / add / search / read / list
kb exp add / apply / hit / refine / refute / promote
kb exp propose / proposals / decide
kb backup / backups / restore <zip> [--merge]
kb serve [--port 7788]
```

## 面板

`kb serve` 后打开 `http://127.0.0.1:7788`：

- 知识库：分区树、折叠、详情；
- 经验块：账本与提案入口；
- 索引：矩形树图 + 可拖拽血缘图谱；
- MCP：开关、连接编号、调用留痕；
- 设置：模式、频率、备份与恢复。

## DSH 插件（可选）

DSH 适配器已经独立成库：[dsh-plugin-local-kb](https://github.com/youyang145/dsh-plugin-local-kb)。
五个工具 + 右下角挂件 + 每轮索引注入 + MCP。

```powershell
dsh plugin --profile <profile> add github:youyang145/dsh-plugin-local-kb --ignore-workspace-root-check
```

## 测试

```bash
node --test test/          # 40 项库测试
node 测试/run-checks.mjs   # 12 项端到端检查（在骨架仓库里）
```

## 与骨架的关系

- 行为是否对齐，看骨架仓库的 [一致性清单](https://github.com/youyang145/local-experience-kb/blob/main/docs/一致性清单.md)；
- 接口契约看 [MCP 工具契约](https://github.com/youyang145/local-experience-kb/blob/main/docs/规范/MCP工具契约.md)；
- 用法看 [给 AI 的用法](https://github.com/youyang145/local-experience-kb/blob/main/docs/给AI的用法.md)。

## 状态与参与

作者高三，平时上课，**周末才有空**，回得慢但都会看。

- 可以提 Issue：bug、想法都行，周末集中看；
- PR 暂时不接：协作流程还没走顺，等我摸熟再开；
- 这是 MVP：接口和字段还会变，升级前先备份。

## 许可

Apache-2.0。设计文档与手稿在骨架仓库，CC BY 4.0。

