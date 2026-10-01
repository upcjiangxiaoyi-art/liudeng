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

**API 设置**：Google AI Studio 源，反向代理填 `http://127.0.0.1:5010`，代理密码填 Gemini key。

## 更新

前端在扩展管理里点更新；服务端 `cd plugins/liudeng && git pull`，然后重启酒馆。

## 配置（config.json）

| 字段 | 说明 |
|---|---|
| port | 中继端口，只监听 127.0.0.1 |
| upstream | 上游地址，默认 Gemini 官方 |
| keep | 内存里保留最近几条 |
| notify.mode | `off` / `bark` / `webhook` |
| notify.barkUrl | 形如 `https://api.day.app/你的Key` |
| notify.webhookUrl | 收到 POST JSON `{title, body, jobId}` |

config.json 已在 .gitignore 里，key 不会被推上去。
