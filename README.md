# Genesis EDD

在现有 coding agent 中表达需求，把业务规则变成可执行验证，再根据运行证据迭代实现。

Genesis EDD 是开源的评测驱动开发框架。首版交付 **Genesis Spec**：复用
OpenSpec 的规格和变更管理，以少量业务场景整理需求，只对影响验收的歧义询问用户。
用户明确说过的要求可以直接记录，无需再次逐条确认。

当前版本提供 Spec 创建、校验和导出；不包含 Eval 生成、运行或自动实现。
业务地图使用独立的 Genesis Map skill。

## 安装与使用

需要 Node.js **22.20.0 或更新版本**。OpenSpec 固定为 **2.1.0**，安装在本仓库，
无需另装全局 CLI、启动服务或向 Genesis 配置模型密钥。推理由用户自己的 agent 完成。

```sh
git clone https://github.com/GenesisAgentInfra/genesis-edd.git
cd genesis-edd
npm ci --ignore-scripts
node bin/genesis-edd.js --help
```

在应用仓库接入。将路径替换为自己的实际路径；目标目录需要已存在：

```sh
node /path/to/genesis-edd/bin/genesis-edd.js init \
  --repo /path/to/application --mode new --agent both
```

存量项目使用 `--mode existing`。支持 `--agent codex|claude|both|none`；默认 both。
Codex 的 skill 安装到应用的 `.agents/skills/genesis-spec/`，Claude Code 使用
`.claude/skills/genesis-spec/`。重新加载 agent 的项目技能后使用：

```text
$genesis-spec 报告提交失败时，不要发送成功通知。
```

Claude Code 使用 `/genesis-spec`。Skill 会读取需求和已有上下文，写规格、运行校验，
并在需求明确时导出交接文件。它不会调用尚未实现的 Eval 或编码循环。
安装的 skill 通过一个 Git 忽略的 runtime.json 定位本机 CLI；换机器后重新运行 init。

### 直接使用 CLI

```sh
node /path/to/genesis-edd/bin/genesis-edd.js spec new report-notifications \
  --repo /path/to/application --mode new

# Agent 按返回的模板撰写 specs/<capability>/spec.md 后：
node /path/to/genesis-edd/bin/genesis-edd.js spec validate report-notifications \
  --repo /path/to/application
node /path/to/genesis-edd/bin/genesis-edd.js spec export report-notifications \
  --repo /path/to/application
```

存量项目在 `spec new` 时添加 `--mode existing --map <business-map.json>`。
初始化时的 mode 是默认值；新项目写出第一版代码后，后续需求可以显式使用 existing。
Map 缺失不阻塞写 Spec，但会返回缺口提示；已提供的 Map 如果内容变化，导出会拒绝沿用旧引用。

`spec instructions` 返回 OpenSpec 的当前模板和项目规则；`spec status` 返回产物状态。
所有功能命令输出 JSON；`--help` 输出文本。格式错误返回非零退出码。
合法但仍有待确认项的草案返回 `valid: true, ready_for_eval_design: false`，不能导出。

### 检查输入并继续

```sh
node /path/to/genesis-edd/bin/genesis-edd.js workflow check spec-export report-notifications \
  --repo /path/to/application
```

检查只读，不生成产物或修改状态。返回的 `gaps` 区分 `artifact`（缺产物）、
`technical`（格式或快照问题）、`business`（待定业务规则）和 `capability`（模块未实现）。
Agent 按 `next` 回到负责补齐的步骤：先复用已有信息、修复文件，只有业务仍未确定或
技术缺口无法自行解决时才询问用户。补齐后重跑 `resume.command`，从原请求继续。
每次都读取实际产物，不能靠手填“已完成”放行；导出入口本身也会重新校验，
失败时返回分类缺口与恢复命令。

`workflow check write-eval NAME` 会检查当前 Spec 及对应固定版本交接文件。
即使 `inputs_ready: true`，仍返回 `implemented: false, status: unavailable`，
因为本版尚未实现 Eval 生成。`run-eval` 和 `loop-and-implement` 的检查返回
`inputs_ready: null`，表示其输入检查也未实现。直接调用这些阶段并提供 NAME 时，
只返回上述诊断，不执行阶段。阻塞或不可用的检查返回退出码 1；可导出时返回 0。
这套检查约束 Genesis 的交接入口，不拦截 Agent 在框架外直接修改代码。

## 写入应用仓库的内容

```text
openspec/
  config.yaml                       # 新项目默认 genesis-spec；保留已有配置
  genesis.json                      # 接入模式
  schemas/genesis-spec/              # 最小 Spec 工作流，可继续讨论和演进
  changes/<change>/
    .openspec.yaml                   # OpenSpec 变更元数据
    genesis.json                     # base、Map 引用、尚未运行的 baseline
    specs/<capability>/spec.md       # 业务规格及来源；小需求通常一份
    handoffs/<sha256>.json           # 导出的固定版本，供未来 write-eval 消费
```

默认 schema 只有 `specs` 阶段，不生成 proposal、design 或 tasks。安装冲突会在写入前报错，
不会覆盖已有配置或自定义文件；同一版本重复安装可安全重入。

每条要求有稳定 ID、原始来源，以及 explicit / confirmed / proposed 状态。
模型建议与待解决的业务歧义阻止导出；缺少技术执行连接由后续 write-eval 处理。
导出保留完整文档及内容摘要，不将产物存在误判为已获业务确认或已通过验收。

参见 [可运行示例](examples/report-notifications/spec.md) 和
[Spec 格式](skills/genesis-spec/references/spec-format.md)。

## 当前限制

- CLI 校验格式和来源字段，不能独立证明原话真实、授权有效或语义整理正确。
- OpenSpec 2.1.0 会警告标准归档丢弃 YAML 头部。Genesis 只将这一精确且已解释的
  归档警告作为提示，其余严格校验问题仍阻止导出。原始诊断保留在 JSON 中。
  当前不要使用 OpenSpec 自动 archive/sync：来源元数据的同步尚未实现。
- 首版支持 ADDED/MODIFIED 规格；删除、重命名和正式主规格晋升留待后续实现。
- Map 引用固定快照标识与文件摘要，尚不自动验证它与当前代码是否一致。
  Genesis Map 目前面向 Python；跨流程和动态路径等分析缺口必须保留。
- `ready_for_eval_design` 仅表示可以设计 Eval；不表示任务可执行或 baseline 存在。
- 项目本地 OpenSpec 目录受支持，外置 store 暂不支持。没有安装完整上游技能集。
- 尚未进行真实用户对话的端到端模型评测；当前测试覆盖 CLI、产物和关键状态约束。

## 开发

```sh
npm ci --ignore-scripts
npm run check
npm test
```

测试使用真实的固定版本 OpenSpec CLI，覆盖空仓库、存量上下文、需求状态、
严格场景校验、固定版本导出、安装重入及配置保护，不调用模型或付费服务。

Apache-2.0。OpenSpec 是 MIT 许可的外部依赖，见 [第三方说明](THIRD_PARTY_NOTICES.md)。
