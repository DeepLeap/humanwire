# 在 Octo 中使用 HumanWire

HumanWire 通过本地 MCP 服务为 Octo 提供兴趣匹配和真人聊天。对方可以使用其他兼容宿主或独立小窗。配置依据 [Octo MCP 接入文档](https://octo-agent.dev/docs/guides/connect-mcp-servers/)，实际宿主验收状态见[开发进度](ROADMAP.md)。

## 本地接入

需要 Node.js 22 或更新版本，以及当前 HumanWire 源码。把下面的服务条目合并到 Octo 用户配置 `~/.octo/mcp.json` 的 `mcpServers` 中，保留已有条目。将示例路径替换为自己的项目绝对路径。Windows 路径也可以使用正斜线。

```json
{
  "mcpServers": {
    "humanwire": {
      "command": "node",
      "args": ["D:/Project/humanwire/src/index.js", "--chat-window"]
    }
  }
}
```

如果 Octo 无法找到 Node.js，把 `command` 改为本机 `node` 可执行文件的绝对路径。按 Octo 的配置加载方式新建会话，并检查 `humanwire` 的工具已经连接。

对 Octo 说「帮我找个也在做个人网站的人聊聊」。Agent 可以调用 `start_matching`，传入用户愿意公开的关键词和可选的 `purpose`。小窗会打开当前会话，在匹配成功后显示共同话题和公开介绍，真人直接在小窗聊天。

寻找默认等待 60 秒，超时可以点击继续等待，断线后可以沿用原关键词再匹配。小窗关闭后，可以让 Agent 调用 `open_chat_window` 重新打开。小窗正文由本地界面接收，Octo 只需要读取连接与匹配状态。

## 协作验收

1. 记录 Octo 版本和 HumanWire 提交。确认工具列表含 `start_matching`、`retry_matching`、`get_status`、`open_chat_window`。
2. 另一台机器打开 HumanWire 小窗，双方填写至少一个相同的公开关键词，例如 `个人网站`。
3. 从 Octo 发起匹配，检查自动打开的小窗属于本次会话，双方能看到共同话题和各自选择公开的介绍。
4. 让 Octo 完成当前一轮，在另一端发消息。确认小窗立即显示，模型上下文没有收到正文。刷新小窗后检查收发记录恢复且没有重复显示。
5. 关闭对端，检查断线提示和再次匹配。单独测试找不到人时的超时、继续等待和取消。

后台代聊、自动破冰、手机接管通知的工作与验收条件记录在[开发进度](ROADMAP.md)。常驻运行与通知需要验证 Octo 的进程生命周期和对应设备入口。
