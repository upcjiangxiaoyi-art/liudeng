# 留灯 Liudeng

SillyTavern 生成中继 + 捞回扩展。手机切到后台、页面被冻结时，回复照样在服务器上收完，回来后一键捞回。

## 安装

**前端扩展**：酒馆 → 扩展 → 安装扩展，粘贴本仓库地址。

**服务端插件**（需要能登录运行酒馆的机器）：

```bash
cd SillyTavern/plugins
git clone <本仓库地址> liudeng
cp liudeng/config.example.json liudeng/config.json   # 需要推送就改这里
```

`config.yaml` 里设 `enableServerPlugins: true`，重启酒馆，日志出现「[留灯] 中继就绪」即可。

**API 设置**：一句话——在酒馆里原来填地址的地方，前面加上 `http://127.0.0.1:5010/`，key 照旧填。不用改 config.json，也不用重启。

| 你用的是 | 酒馆里的来源 | 地址那一栏填 | key 填在 |
|---|---|---|---|
| Gemini 官方 | Google AI Studio | 反向代理：`http://127.0.0.1:5010` | 代理密码 |
| OpenAI 格式的中转站 | 自定义（兼容 OpenAI） | 自定义端点：`http://127.0.0.1:5010/https://中转站地址/v1` | API 密钥 |
| Claude 格式的中转站 | Claude | 反向代理：`http://127.0.0.1:5010/https://中转站地址/v1` | 代理密码 |
| Gemini 格式的中转站 | Google AI Studio | 反向代理：`http://127.0.0.1:5010/https://中转站地址` | 代理密码 |

「中转站地址」就是中转站给你的那个，原样贴在 `http://127.0.0.1:5010/` 后面。多个中转站互不影响，每个预设各填各的。生成一次后看酒馆日志，出现 `[留灯] #xxxx 中转站域名 done` 就说明走通了。

## 更新

前端在扩展管理里点更新；服务端 `cd plugins/liudeng && git pull`，然后重启酒馆。

## 配置（config.json）

| 字段 | 说明 |
|---|---|
| port | 中继端口，只监听 127.0.0.1 |
| upstream | 地址里没带中转站时走的上游，默认 Gemini 官方 |
| keep | 内存里保留最近几条 |
| notify.mode | `off` / `bark` / `webhook` |
| notify.barkUrl | 形如 `https://api.day.app/你的Key` |
| notify.webhookUrl | 收到 POST JSON `{title, body, jobId}` |

config.json 已在 .gitignore 里，key 不会被推上去。
